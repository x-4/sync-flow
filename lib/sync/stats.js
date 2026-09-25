// ====================================================================
// 通道计数（进程级累计）
//
// 存在的理由只有一个：把"域名解析到底坏在哪一条路上"变成一次 curl
// 就能回答的问题，而不是两轮排查靠猜。
//
// 一次真实故障的形状是这样的：连接能建立、握手全过、TCP 转发正常，
// 唯独浏览器报"找不到 DNS 地址"，而服务端日志一片干净——因为失败
// 分散在互不相干的三条路径上（数据报通道是否启用、DoH 后端是否可用、
// 出站域名解析是否成功），任何一条坏掉都表现为同一个客户端症状。
// 没有计数就只能逐个改代码试，这已经发生过两轮。
//
// 设计取舍：
//   · 只做累计计数，不做时间窗口。窗口需要定时器或分桶回收，都会给
//     常驻进程引入一条与本服务无关的节拍；累计值足以回答"坏了没坏、
//     坏的是哪条路"，趋势交给平台侧的指标采集。
//   · 本模块**不 require 任何东西**：它是 relay.js 与 resolver.js 的
//     共同下游，被它们 require 时自身零依赖，因此不可能形成环。
//   · 计数在 gateway.js 的 /_diag/channel 里读出。多进程部署下各进程
//     各算各的，这是刻意的（跨进程共享计数需要外部存储，与本项目的
//     零运行时依赖约束冲突）。
// ====================================================================

// 准入闸门侧：升级被拒的次数，按"是哪一道闸"分开记。
//
// 存在的理由是一场三轮才定位的故障：并发上限卡在 10，浏览器在一个
// RTT 内开出的几十条隧道里绝大多数被 429 拒掉，表现为"Chrome 找不到
// DNS 地址、服务端日志一片干净"。当时 refuseUpgrade 一行日志都没有，
// 于是"有人被拒"这件事在服务端根本不存在——只能靠用户症状反推。
//
// 分成五道而不是记一个总数，是因为五道闸的处置完全不同：
//   total / pendingTotal  全局容量 → 扩容或调 MAX_TOTAL_CONNECTIONS
//   perIp / pendingPerIp  单来源   → 单用户浏览器场景，调 per-IP 档
//   cooldown              冷却中   → 有客户端在持续发非法批次
// 只记一个"被拒了多少次"，运维依旧得猜是哪一道。
const gateCounters = {
    refused: { total: 0, perIp: 0, pendingTotal: 0, pendingPerIp: 0, cooldown: 0 }
};

// 资源上界触发次数：下行缓冲顶到硬上界之后的**两种结局**，各记一格。
//
// 与上面的闸门计数是同一类证据，但指向的是**连接建立之后**的那半程：
// 闸门计数回答"有没有人在门口被拦"，这两格回答"有没有连接在被服务的
// 过程中因为吃不到资源而被处置"。
//
//   downstreamThrottle  强制节流启用。每条连接首次撞上界计一次
//                       （此后它一直带着节流，不重复计）。
//   downstreamCut       节流已生效、缓冲却在观察窗口内不下降，连接被拆。
//
// 两格必须分开读：只有 throttle 增长而 cut 不动，是"客户端慢于目标"
// 的常态——缓冲被压住、连接活着，正是上界想要的结果；cut 增长则说明
// 确实有连接死在被服务的过程中。合成一格的话，"缓冲策略在正常工作"
// 与"连接在批量被砍"会长得一模一样。
//
// 它必须与"节流"分开看：节流（暂停读目标）是正常形态，每时每刻都在
// 发生；越过上界意味着客户端已经连续若干个高水位窗口没消费过任何字节
// ——那要么是客户端已经消失，要么是目标侧在疯写。两种情况都需要被看见，
// 否则"进程内存为什么涨"只能靠 OOM 之后的 exit=137 反推。
const resourceCounters = { downstreamThrottle: 0, downstreamCut: 0 };

// 占用峰值。累计计数回答不了"到底有没有接近上限"——它是 Craig 要的
// 那个指标：当前值只说明此刻，峰值说明这一轮生命周期里水位到过哪。
// 有了它，"用户报障但当前占用很低"就能被区分成"从未触顶（不是这道
// 闸的问题）"与"触过顶但已回落（就是它）"。
const occupancyPeaks = { total: 0, pending: 0 };
let occupancyNow = { total: 0, pending: 0 };

// 数据报（DNS）侧：一条查询从入队到应答的完整去路。
//
//   queries     收到的查询总数（含被限流/畸形而被拒的）
//   answered    后端给出应答、成功回给客户端的条数
//   servfail    回了 SERVFAIL（后端失败、限流、在途超限）的条数
//   formerr     回了 FORMERR（报文结构非法）的条数
//   refused     回了 REFUSED（通道关闭、端口不支持）的条数
//   backendFail 全部解析后端都没给出应答的次数
//
// answered + servfail + formerr + refused 小于 queries 时，差额是
// "客户端已断开、应答没能发出去"——那是正常现象，不是故障。
const datagramCounters = {
    queries: 0,
    answered: 0,
    servfail: 0,
    formerr: 0,
    refused: 0,
    backendFail: 0
};

// TCP 侧：出站域名解析的成败与耗时。
//
// bySource 只统计**真正发起过**的解析，缓存命中不计入任何来源，
// 因此 resolveOk 与三个来源之和的差额就是缓存命中次数。
const resolveCounters = {
    ok: 0,
    fail: 0,
    msSum: 0,
    msCount: 0,
    bySource: { cares: 0, doh: 0, lookup: 0 }
};

// p50 用固定容量的样本环：既不需要定时器，也不会随运行时间增长。
// 只保留最近若干次耗时——分位数描述的是"当前网络状况"，攒全量历史
// 反而会让一次历史抖动长期污染这个值。
const SAMPLE_CAP = 128;
const resolveSamples = [];

// 计数器的字段名由调用方给出，这里只做越界保护：
// 写错字段名的后果是计数永远为 0，与"压根没埋点"无法区分，
// 因此宁可记一条 warn 也不静默吞掉。
function noteDatagram(field) {
    if (!(field in datagramCounters)) {
        console.warn('[STATS] 未知的数据报计数字段: ' + String(field));
        return;
    }
    datagramCounters[field]++;
}

function noteDownstreamCut() {
    resourceCounters.downstreamCut++;
}

function noteDownstreamThrottle() {
    resourceCounters.downstreamThrottle++;
}

// 记录一次准入拒绝。字段名同样做越界保护：写错名字的后果是这道闸
// 永远显示 0，与"这道闸从没拒过人"无法区分，那正是上一轮排查的形态。
function noteGateRefusal(gate) {
    if (!gate || !(gate in gateCounters.refused)) {
        console.warn('[STATS] 未知的准入闸门名: ' + String(gate));
        return;
    }
    gateCounters.refused[gate]++;
}

// 由 limits.js 在每次占用变化后调用：刷新当前水位与峰值。
//
// 放在这里而不是 limits.js，是为了让"计数"这一件事只有一处实现；
// limits.js 那边只管把数字递过来。峰值只在涨的时候更新，
// 因此不必在下降路径上也付出代价——但当前水位必须每次都刷，
// 否则诊断端点会读到过期值。
function noteOccupancy(total, pending) {
    occupancyNow.total = total;
    occupancyNow.pending = pending;
    if (total > occupancyPeaks.total) occupancyPeaks.total = total;
    if (pending > occupancyPeaks.pending) occupancyPeaks.pending = pending;
}

function noteResolve(ok, source, elapsedMs) {
    if (ok) resolveCounters.ok++;
    else resolveCounters.fail++;

    if (source && (source in resolveCounters.bySource)) {
        resolveCounters.bySource[source]++;
    }

    const ms = Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : 0;
    resolveCounters.msSum += ms;
    resolveCounters.msCount++;
    resolveSamples.push(ms);
    if (resolveSamples.length > SAMPLE_CAP) resolveSamples.shift();
}

// 返回副本：调用方（诊断端点）只做序列化，不该拿到可写引用——
// 一旦拿到，某个"顺手清零"的改动就会让排查时看到的计数不是真实值。
function getDatagramStats() {
    return {
        queries: datagramCounters.queries,
        answered: datagramCounters.answered,
        servfail: datagramCounters.servfail,
        formerr: datagramCounters.formerr,
        refused: datagramCounters.refused,
        backendFail: datagramCounters.backendFail
    };
}

function getResolveStats() {
    const sorted = resolveSamples.slice().sort((a, b) => a - b);
    // 偶数个样本取上中位数：诊断用途下，宁可略微高估也不要低估延迟。
    const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const avg = resolveCounters.msCount
        ? Math.round(resolveCounters.msSum / resolveCounters.msCount)
        : 0;
    return {
        resolveOk: resolveCounters.ok,
        resolveFail: resolveCounters.fail,
        resolveMsP50: p50,
        resolveMsAvg: avg,
        bySource: {
            cares: resolveCounters.bySource.cares,
            doh: resolveCounters.bySource.doh,
            lookup: resolveCounters.bySource.lookup
        }
    };
}

// 同样返回副本（理由同 getDatagramStats）。
//
// refused 是**累计**值、occupancy 是**瞬时/峰值**值，两者不要互相替代：
// 判断"现在是不是在拒人"看 refused 的增量，判断"离上限还有多远"看
// occupancy。峰值配当前值一起看，才能回答"曾经顶到过吗"。
function getGateStats() {
    return {
        refused: {
            total: gateCounters.refused.total,
            perIp: gateCounters.refused.perIp,
            pendingTotal: gateCounters.refused.pendingTotal,
            pendingPerIp: gateCounters.refused.pendingPerIp,
            cooldown: gateCounters.refused.cooldown
        },
        occupancy: {
            total: occupancyNow.total,
            pending: occupancyNow.pending,
            peakTotal: occupancyPeaks.total,
            peakPending: occupancyPeaks.pending
        },
        // 连建立之后那半程的现场证据（见 resourceCounters 的说明）。
        // 放在 gates 里而不是另起一个端点，是为了让"一条 curl 看清
        // 资源侧发生了什么"仍然成立——拆到别处就会有人只看一半。
        resource: {
            downstreamThrottle: resourceCounters.downstreamThrottle,
            downstreamCut: resourceCounters.downstreamCut
        }
    };
}

module.exports = {
    noteDatagram,
    noteResolve,
    noteDownstreamCut,
    noteDownstreamThrottle,
    noteGateRefusal,
    noteOccupancy,
    getDatagramStats,
    getResolveStats,
    getGateStats
};
