// ====================================================================
// 数据面（通道建立之后）
//
// 按职责分为五个单元：会话状态、背压控制、首包超时、数据报队列、
// 中继管道。这是纯结构重组——控制流、判断顺序、异常边界与
// 拆分前逐行等价，任何一侧的行为都不因拆分而改变。
//
// 本模块处理的是"帧已经解出来之后"的一切：分流到数据报还是 TCP 中继、
// 双向转发的背压、首包超时、连接收尾。它不参与握手判定，也不持有
// 全局限流状态（后者在 limits.js）。
// ====================================================================

const net = require('net');
const CONFIG = require('../config');
const logger = require('../logger');
const { resolveHost } = require('./resolver');
const { classifyTarget } = require('./target-guard');
const { resolveWarehouse, decodeBinaryDelta } = require('./codec');
const { noteInvalid } = require('./limits');
const { noteDatagram, noteDownstreamCut, noteDownstreamThrottle } = require('./stats');
const COMPAT = require('./compat');

// 背压水位（原先每连接各持一份常量，值不可变，上移至模块层）
//
// 高水位取自 CONFIG：启动期的 SYNC_STREAM_HWM 交叉校验用的是同一个值，
// 两处若各写一份会静默漂移成"按旧阈值校验、按新阈值运行"。
const HIGH_WATER = CONFIG.BACKPRESSURE_HIGH_WATER;  // 默认 1MB：超过即视为下游积压
const LOW_WATER = CONFIG.BACKPRESSURE_HIGH_WATER >> 2;  // 默认 256KB：降到此处恢复

// —— 下行缓冲的硬上界 ——
//
// 它与 HIGH_WATER 是**两件性质不同**的事，必须分开表达：
//
//   HIGH_WATER          节流阈值（策略）。越过它就暂停读目标，让读端速度
//                       反过来约束写端；连接照常存活，缓冲在低水位处恢复。
//   DOWNSTREAM_CEILING  资源上界（上界）。越过它说明客户端已经连续若干个
//                       高水位窗口没有消费过任何字节，缓冲必须停止增长。
//
// 这两件事曾经被打包进 downstreamThrottle 同一个开关里：等价模式关掉节流
// 时连上界一起没了，下行缓冲因此无上界增长。实测（QA 脚本
// p26-backpressure）：251ms 539MB、1003ms 2.17GB、3017ms 6.69GB，3.3s
// 进程被 OOM 杀掉（exit=137，cgroup 上限 8GB）。而生产当时正开着
// SYNC_COMPAT_MODE=1——也就是说这个 8GB 炸弹当时是通电的。
//
// 正确的切分是：**开关取消的是策略（不主动 pause 对端），上界永远生效。**
// 因此下面那条上界判定刻意放在 COMPAT 分支**之外**，两条形态共用。
//
// 取 4 倍高水位的理由：默认形态下缓冲稳定在"高水位 + 一帧"（实测
// 1,048,736B），4 倍给"客户端只是慢了一下"留足余量，正常流量永远碰不到；
// 同时把单条连接的上界钉在 4MB，即便连接表按 MAX_TOTAL_CONNECTIONS
// （默认 200）打满，最坏内存也在 GB 以下，不再是 8GB 那种量级。
//
// ── 撞上界之后做什么：强制节流，不是拆链 ────────────────────────
//
// 上界最初的实现是"越界即 terminate"。它确实把 OOM 挡住了，但同时把
// **缓冲策略问题用拆连接来解决**：客户端比目标慢是再正常不过的事
// （大文件下载、视频流、慢链路），这类连接会被一路涨到 4MB 然后 RST
// ——实测 5MB/s 目标 + 不消费的客户端 5.8s 被拆，用户侧就是"用着用着
// 就断了"，而生产当时正开着 SYNC_COMPAT_MODE=1。
//
// 现在分两步处置（实现见 createBackpressure 的 enforceCeiling）：
//   1. 越界 → 强制启用反向节流（暂停读目标），缓冲立即停止增长；
//   2. 只有节流已生效、这条连接却在一个观察窗口内**毫无进展**（既没有
//      帧真正写到网络上、缓冲也没降）时，才判定客户端彻底停止读取
//      （死连接）并拆链。
// 内存上界因此一点没变：暂停之后不再有新的字节进缓冲，最坏仍是
// 4MB + 内核里那一点；而"慢客户端"从"被拆"变成"被压住"。
//
// 节流一旦因越界启用，就对这条连接**永久启用**（不再退回"收到即发"）：
// 它已经用 4MB 证明了自己需要节流，放开只是让缓冲再涨一遍，白占内存。
const DOWNSTREAM_CEILING = CONFIG.BACKPRESSURE_HIGH_WATER * 4;

// 观察窗口：强制节流生效后，这条连接在这个时长内毫无进展即判定为死连接。
//
// "有进展"的判据见 stallTick ②——写出完成回调或缓冲下降，二者任一。
//
// 取 15s，两端都有约束：
//   · 下界：必须显著长于"客户端一次正常卡顿"。浏览器 / 播放器因 GC、
//     切后台、链路切换而停止读取，典型时长在 1~3s 量级，15s 留出约 5
//     倍余量——这类卡顿不该付出拆链的代价。
//   · 上界：死连接在被拆之前每条最多占 4MB。等价模式下出站空闲超时是
//     停用的，这个窗口因此是那条路径上唯一的僵尸回收者；窗口太长会让
//     并发额度被死连接长期占着。15s 即便按"200 条同时撞上界"的最坏
//     情形（800MB 量级）也仍然安全。
const DOWNSTREAM_STALL_WINDOW = 15000;

// 观察窗口内的采样间隔。1s 对"有没有进展"这个判据足够（写出回调是按
// 帧到达的，1s 的量级下不可能漏掉一整拍），且它同时是"排空后恢复读
// 目标"的第二道路径（见 stallTick ①）。
const DOWNSTREAM_STALL_SAMPLE = 1000;

// 判定"缓冲确实在下降"的最小幅度：下降不足这个数就只认写出回调那一路。
//
// 取 16KB（高水位的 1/64）：换算成速率是 15s 内 1.1KB/s。任何还在正常
// 消费的客户端都远高于它（最慢的可用链路也在几十 KB/s）；而零窗口下
// bufferedAmount 是**逐字节不动**的，与这个阈值差着四个数量级。写
// "下降过 1 字节就算活着"也能工作，但那样一次偶然的分片刷写就能让一
// 条死连接永久留在连接表里——16KB 把这个口子堵上。
const DOWNSTREAM_DRAIN_FLOOR = HIGH_WATER >> 6;

// "节流已被证明有效"的水位：缓冲降到这里以下，就认定客户端确实在消费，
// 拆链判据随即对该连接永久失效。
//
// 取 高水位 + 低水位。缓冲的稳态不是高水位本身而是"高水位 + 一帧"
// （默认形态实测稳定在 1,048,736 B = 1MB + 160B）：越过水位那一帧是整
// 帧写出的，暂停发生在它之后。一帧最大不超过低水位——出站 socket 的水
// 位覆盖在启动期被交叉校验收敛到 ≤ 高水位的 1/4（见 config.js），系统
// 默认则更小。因此"高水位 + 低水位"是"稳态 + 最大一帧"的稳妥上界：
// 它不会把节流稳态误判成"停滞"，却仍远低于硬上界，死连接落不进来。
const DOWNSTREAM_SETTLED_LINE = HIGH_WATER + LOW_WATER;

// —— 会话状态：一条通道生命周期内的全部可变状态 ——
function createSession(ws, sourceIp) {
    return {
        ws,
        sourceIp,
        isFirstBatch: true,
        isDatagram: false,
        datagramBuffer: Buffer.alloc(0),
        datagramOffset: 0,
        awaitingDrain: false,
        // 目标侧写不动时暂存的帧（见 writeToExternal）。
        // 有上限、不无限增长；连接结束时随 teardown 一并丢弃。
        pendingFrames: [],
        // 已发起但尚未返回的解析查询条数（见 answerDatagramQuery）。
        // 令牌桶限的是速率，这个数限的是同时在飞的量。
        dohInflight: 0,
        externalConnection: null,
        firstBatchTimer: null,
        // 拒绝后的延迟关闭定时器（见 rejectWithCode），teardown 时取消
        closeTimer: null,
        // 数据报通道的空闲回收定时器（见 armDatagramIdle），teardown 时取消
        datagramIdleTimer: null,
        // 下行缓冲撞上界之后的死连接观察定时器（见 createBackpressure
        // 的 enforceCeiling），teardown 时取消
        downstreamWatchdog: null
    };
}

// —— 数据报通道的空闲回收 ——
//
// 为什么这条路径必须单独补一个定时器：
//
// TCP 中继的僵尸是由**出站连接**的空闲超时顺带回收的——那条 socket 的
// setTimeout 一触发就 destroy，'close' 处理器随即拆掉整条通道（实测
// 120,002ms）。数据报通道没有出站连接：查询是交给解析后端的 fetch，
// 通道建立之后唯一可能发生的 IO 就是"收到查询 / 发出应答"。于是这条
// 路径建立之后**一个定时器都没有**，对端异常消失留下的僵尸永远不会被
// 回收——实测 200s 后 channels 仍为 4，纹丝不动。
//
// 而浏览器流量主力恰恰就是数据报通道，异常断连留下的僵尸会单向累积，
// 吃满 200 条额度后新连接一律 503。这与"网页慢慢打不开、重启后又好了"
// 的症状完全吻合。
//
// ── 空闲判据：通道上没有任何活动，持续 SYNC_OUTBOUND_IDLE_TIMEOUT ──
//
// "活动"取**双向**（收到查询 或 发出应答），而不是只看入站。理由：一个
// WS 帧里可以带着多条查询，应答是随后逐条回来的；只看入站会让"多查询
// 共帧、应答陆续返回"这条形态上的连接被判成空闲。
//
// 为什么这不会误杀正常长连接：一条正在被使用的通道，只要浏览器还在发起
// 解析请求就一定有入站帧，计时器随之重置。反过来，"连续 120s 既没问也
// 没答"只有两种可能——对端已经消失（正是本条要回收的僵尸），或者很久
// 没有解析需求。后一种被回收的代价是客户端下一次有查询时重建一次握手；
// 换回来的是僵尸不再单向累积。
//
// 在途保护：计时到点时若还有查询在等后端（dohInflight > 0），说明这条
// 通道正在工作而不是空闲，重新计时、不拆链。
//
// 为什么不用 WS ping 探活：项目刻意不发 ping 帧——固定节拍与"业务页面
// 周期性轮询、其余时间静默"的形态不符（见 sync/index.js 的保活注释，
// 实测 200s 内服务端发出的 ping 帧数为 0）。因此"对端还在不在"只能靠
// 有没有流量来推断，而这正是必须补一个定时器的原因：没有它，僵尸与
// 静默的活连接在服务端侧完全不可分辨。
//
// 等价模式下同样生效：这是资源回收，不是策略差异。僵尸占额度导致新
// 连接 503 本身就是"网页打不开"的成因之一，把回收也关掉等于一边排查
// 一边让成因继续积累——而且生产当时正开着 SYNC_COMPAT_MODE=1。
function armDatagramIdle(state) {
    if (!state.isDatagram) return;
    if (CONFIG.SYNC_OUTBOUND_IDLE_TIMEOUT <= 0) return;
    clearDatagramIdle(state);
    state.datagramIdleTimer = setTimeout(() => {
        state.datagramIdleTimer = null;

        // 还有查询在等后端：这条通道正在工作，重新计时。
        // 少了这一句，"后端慢"会被误判成"对端死了"。
        if (state.dohInflight > 0) { armDatagramIdle(state); return; }

        // 级别与出站空闲超时那一行保持一致（debug）：这是常态的回收动作，
        // 每条静默的通道每 120s 都会走一次，记 warn 会淹没真正的故障。
        logger.debug('数据报通道空闲超时，主动回收', {
            idleMs: CONFIG.SYNC_OUTBOUND_IDLE_TIMEOUT
        });
        reclaimIdleChannel(state);
    }, CONFIG.SYNC_OUTBOUND_IDLE_TIMEOUT);
    // unref：这条定时器不该决定进程能否退出（历史 P3-c 就是这个坑）。
    if (state.datagramIdleTimer.unref) state.datagramIdleTimer.unref();
}

// 通道上有活动时重置计时。逐帧调用，因此只做 refresh 而不重建定时器。
function touchDatagramIdle(state) {
    if (!state.isDatagram || !state.datagramIdleTimer) return;
    if (typeof state.datagramIdleTimer.refresh === 'function') state.datagramIdleTimer.refresh();
    else armDatagramIdle(state);
}

function clearDatagramIdle(state) {
    if (state.datagramIdleTimer) {
        clearTimeout(state.datagramIdleTimer);
        state.datagramIdleTimer = null;
    }
}

// 回收动作：terminate 而不是 close。
//
// 僵尸的对端多半已经消失，close 帧既送不到、也要等 30s 的 closeTimeout
// 才真正拆链——并发额度要多占 30s，诊断端点上的 channels 迟迟不回落
// （报告 N7 就是这个形状）。terminate 直接拆 socket，'close' 必然到达。
//
// 代价：对"静默但存活"的通道表现为连接被重置而非优雅关闭。客户端会按
// 需重建（一次握手），这是为了不让僵尸占死额度所付的代价。
function reclaimIdleChannel(state) {
    try {
        if (typeof state.ws.terminate === 'function') state.ws.terminate();
        else state.ws.close();
    } catch (err) {
        logger.debug('数据报通道回收时关闭失败，交由收尾清理',
            { error: err && err.message });
    }
}

// —— 背压控制 ——
//
// 之前这里是无条件转发的：目标发多快就往 ws 里塞多快。
// 客户端读得慢时帧会在 ws 的发送缓冲里无界堆积（实测 6 秒积压
// 66MB、RSS 从 62MB 涨到 111MB），持续下去会 OOM，且客户端
// 恢复读取后拿到的是早已过期的数据。
//
// 正确做法是让"读端速度"反过来约束"写端"：
//   ws 缓冲满  -> 暂停目标 TCP 读取（暂停 libuv 拉取，数据留在内核缓冲）
//   ws 缓冲排空 -> 恢复目标 TCP 读取
// 反方向同理：目标写得慢时，暂停 ws 的读取，避免在内存里堆 msg。
function createBackpressure(state) {
    let downstreamPaused = false;

    const pauseDownstream = () => {
        const ext = state.externalConnection;
        if (downstreamPaused || !ext || ext.destroyed) return;
        downstreamPaused = true;
        // 逐帧热路径。pause/resume 对已结束的流是文档化的空操作，
        // 这里的 catch 只兜住"流在调用瞬间被对端拆掉"的竞态。
        // 刻意不记日志：一次长时间传输就可能触发成千上万次，
        // 记录它既无诊断价值，也会把真实故障淹掉。
        try { ext.pause(); } catch (_) { /* 流已结束，pause 无意义 */ }
    };

    const resumeDownstream = () => {
        const ext = state.externalConnection;
        if (!downstreamPaused || !ext || ext.destroyed) return;
        downstreamPaused = false;
        try { ext.resume(); } catch (_) { /* 同上：流已结束 */ }
    };

    // ws 的待发送字节数。vendor 实现提供 bufferedAmount，它同时涵盖
    // 底层 socket 写入队列与分片缓冲；公共 API 优先，取不到时退化为 0
    // （等价于不节流，保证功能优先于优化）。
    const wsBuffered = () => {
        try {
            if (typeof state.ws.bufferedAmount === 'number') return state.ws.bufferedAmount;
        } catch (_) {
            // 取不到就退化为 0 == 不节流。这是"优化项缺失"而非故障，
            // 且本函数在每帧写出后被调用，同样不适合逐次记日志。
            // 若 vendor 实现真的整段失效，表现为吞吐下降而非功能中断，
            // 因此这里不上报对定位问题也无损失。
        }
        return 0;
    };

    // 每帧写出后的回调：缓冲降到低水位就立刻恢复目标读取。
    //
    // 原先这里是一个 20ms 的轮询定时器——唤醒周期本身就带来最多 20ms
    // 的恢复延迟，且在连接数上去后定时器数量随之增长。改用发送完成
    // 回调后，恢复发生在"缓冲真正排空"的那一刻，没有定时器开销。
    // 该函数在会话内只创建一次，逐帧复用，不产生额外分配。
    //
    // 顺带置一次"有进展"标记（见 stallTick ②）：回调到达意味着这一帧
    // 确实被刷到了网络上，也就是客户端确实还在读。
    const afterFlush = () => {
        flushSeen = true;
        if (downstreamPaused && wsBuffered() <= LOW_WATER) resumeDownstream();
    };

    // —— 撞上硬上界之后：强制节流 + 死连接观察 ——
    //
    // 完整理由见 DOWNSTREAM_CEILING 处"撞上界之后做什么"那一节。要点：
    // 上界的处置是**节流**而不是拆链。暂停读目标之后缓冲立即停止增长
    // （字节留在内核缓冲里、TCP 窗口随之关闭），因此内存上界与"越界即
    // 拆"时完全相同；区别只在于慢客户端不再被当成死连接。
    let forced = false;          // 这条连接是否已因越界进入强制节流
    let stallArmed = false;      // 拆链判据是否还生效（见 stallTick ②）
    let stallBaseline = 0;       // 观察到的最低缓冲量（只降不升）
    let stallDeadline = 0;       // 缓冲"必须在此刻之前出现进展"的期限
    let flushSeen = false;       // 自上次观察以来是否有帧真正写到网络上

    const stopStallWatchdog = () => {
        if (state.downstreamWatchdog) {
            clearInterval(state.downstreamWatchdog);
            state.downstreamWatchdog = null;
        }
    };

    // 观察窗口的每一拍。
    //
    // 判据只有一条：**节流已经生效，这条连接还有没有进展**。有进展 =
    // 客户端在读，连接活着；整个窗口都没有任何进展 = 客户端彻底停止
    // 读取，是死连接。"进展"的两个来源见 ②。
    //
    // 定时器一旦起来就随连接活到收尾（teardown 清理），而不是拆链判据
    // 失效就停：它还兼着"排空后恢复读目标"的第二道路径（见 ①）。
    const stallTick = () => {
        // 通道已结束：定时器与 close 同拍到达时要能自检，否则会对一条
        // 已关闭的 ws 做判定。正常收尾由 teardownChannel 负责。
        if (!state.ws || state.ws.readyState !== state.ws.OPEN) {
            stopStallWatchdog();
            return;
        }

        const cur = wsBuffered();
        const now = Date.now();

        // ① 已排空到低水位：恢复读目标，窗口重新计时。
        //
        // 这是 afterFlush 之外的第二道恢复路径，不是冗余：写出回调只在
        // "这一帧确实被刷进内核"时到达，而暂停期间不再有新的写出。若
        // 缓冲恰好停在低水位之上一点点，回调就再也不会来，连接会永久
        // 停在暂停态——那比拆链更隐蔽（连接活着、字节不动、日志干净）。
        if (cur <= LOW_WATER) {
            resumeDownstream();
            stallBaseline = cur;
            stallDeadline = now + DOWNSTREAM_STALL_WINDOW;
            return;
        }

        // ② 有进展：客户端还在读，重新计时。
        //
        // 进展有两个来源，二者**任一**成立即可：
        //
        //   · 窗口内有帧真正写到网络上（flushSeen，由 afterFlush 置位）。
        //     这是主要的那个。bufferedAmount 的粒度是"整次 write 完成"
        //     ——一次 1MB 的 write 在客户端慢慢读的整个过程里都保持着
        //     满值，只有全部写完才一次性归零。只盯这个数的话，"客户端
        //     在慢慢读"与"客户端停了"长得一模一样（实测：慢客户端下
        //     该值连续十几秒纹丝不动，而客户端每秒照收 600KB）。
        //
        //   · 缓冲比上次观察的最低值低了 ≥ 一个下限。这一条覆盖"写出
        //     回调恰好落在采样点之间"那类边角。
        //
        // 另外：缓冲降到常态区间（不高于"暂停点 + 一帧"，见
        // DOWNSTREAM_SETTLED_LINE）之后，拆链判据即对该连接永久失效
        // ——它已经证明自己会消费，此后与任何一条普通的节流连接无异：
        // 客户端要不要继续取数据是它自己的事（播放器缓冲够了停读正是
        // 这种形态）。
        const progressed = flushSeen || cur <= stallBaseline - DOWNSTREAM_DRAIN_FLOOR;
        if (progressed) {
            flushSeen = false;
            if (cur < stallBaseline) stallBaseline = cur;
            stallDeadline = now + DOWNSTREAM_STALL_WINDOW;
            if (cur <= DOWNSTREAM_SETTLED_LINE) stallArmed = false;
            return;
        }

        // ③ 拆链判据仍生效（缓冲从未回落到常态区间）、且整个窗口都没有
        //    任何进展：节流已经生效，字节却一点都送不出去 ——
        //    客户端彻底停止读取。
        if (stallArmed && now >= stallDeadline) {
            stopStallWatchdog();
            cutDownstream(state, cur);
        }
    };

    // 下行缓冲越过硬上界：强制启用反向节流，并起死连接观察窗口。
    const enforceCeiling = () => {
        if (!forced) {
            forced = true;
            // warn 而非 debug：这是"客户端慢于目标"唯一的现场证据，也
            // 是节流被强制启用的起点，排查时要能在默认级别下看见。
            // 只记字节数，不记任何地址或载荷内容。
            logger.warn('下行缓冲越过硬上界，已强制启用反向节流', {
                bufferedBytes: wsBuffered(),
                ceilingBytes: DOWNSTREAM_CEILING,
                stallWindowMs: DOWNSTREAM_STALL_WINDOW,
                compatMode: COMPAT.enabled
            });
            noteDownstreamThrottle();
        }
        pauseDownstream();
        // 首次进入时起观察窗口；之后再撞上界只沿用已有的窗口。
        if (!state.downstreamWatchdog) {
            stallArmed = true;
            stallBaseline = wsBuffered();
            stallDeadline = Date.now() + DOWNSTREAM_STALL_WINDOW;
            // 只从这一刻起算"有没有进展"：此前攒下的写出回调属于
            // 撞上界之前的旧账，不能拿来给死连接续命。
            flushSeen = false;
            const timer = setInterval(stallTick, DOWNSTREAM_STALL_SAMPLE);
            // unref：与其余定时器一致，它不该决定进程能否退出。
            if (timer.unref) timer.unref();
            state.downstreamWatchdog = timer;
        }
    };

    // 强制节流是否已对这条连接生效。数据面用它决定"收到即发"还是
    // "越过水位即暂停"，也决定写出是否要带回调（恢复读目标挂在回调上）。
    const isForced = () => forced;

    return {
        pauseDownstream,
        resumeDownstream,
        wsBuffered,
        afterFlush,
        enforceCeiling,
        isForced
    };
}

// —— 死连接：节流已生效但缓冲不降，走到这里才拆链 ——
//
// 唯一的调用点是 createBackpressure 的观察窗口（stallTick）：缓冲越过
// 硬上界本身**不再**拆链，那里做的是强制节流；只有节流之后缓冲在一个
// 观察窗口内仍然不下降，才说明客户端彻底停止读取，这条连接没有保留价值。
//
// 为什么是 terminate 而不是 close：
//
// close() 会先把关闭帧排进发送队列。缓冲此刻顶在上界上，那个帧必然排在
// 几 MB 积压**后面**。实测（报告 N7）默认形态下出站空闲超时确实触发了
// （readyState 1→2），但关闭帧发不出去，连接一直挂在那里，/_diag/channel
// 的 channels 仍为 1——并发额度根本没释放。"兜底生效了但兜不住"就是
// 这个形状。用 end() 会重蹈同一条覆辙。
//
// terminate() 直接拆 socket：积压随之丢弃，'close' 必然到达，额度必然
// 释放。代价是客户端收到的是连接被重置而非一次优雅关闭——对一条已经
// 几 MB 没有消费过任何字节的连接，这个代价可以接受；反过来，让它继续
// 占着内存与额度没有任何一方受益。
//
// 顺序刻意是"先 ws、后出站"：出站 socket 的 'close' 处理器里有一句
// ws.close()。若先拆出站，那句 close() 会落在仍处于 OPEN 的通道上，
// 把一个关闭帧排进积压；先 terminate 之后它落到 CLOSING 分支，成为
// 空操作。这个顺序不是风格问题，是"兜底到底兜不兜得住"的问题。
function cutDownstream(state, buffered) {
    // 记 warn 而不是 debug：这是"客户端不读"或"目标侧疯写"唯一的现场
    // 证据。此前这类事件在服务端完全没有痕迹，只能靠用户症状反推。
    //
    // 只记字节数，不记任何地址或载荷内容。
    logger.warn('下行缓冲顶在硬上界且节流后仍不下降，判定为死连接并拆链', {
        bufferedBytes: buffered,
        ceilingBytes: DOWNSTREAM_CEILING,
        stallWindowMs: DOWNSTREAM_STALL_WINDOW,
        compatMode: COMPAT.enabled
    });
    noteDownstreamCut();

    try {
        if (typeof state.ws.terminate === 'function') state.ws.terminate();
        else state.ws.close();
    } catch (err) {
        // 拆不掉说明连接已处于异常状态，teardown 会接手清理。
        logger.debug('下行上界拆链时通道关闭失败，交由收尾清理',
            { error: err && err.message });
    }

    if (state.externalConnection) {
        try { state.externalConnection.destroy(); } catch (_) { /* 已关闭 */ }
    }
}

// —— 首包超时 ——
//
// 任何真实 WebSocket 应用都会做这件事。握手成功后一直挂着不发数据的
// 连接，既是资源风险（实测 20 条空连接可以长期占满连接表），
// 也是"这不像真实应用"的行为特征。
// 窗口远大于真实客户端首包延迟（实测同机 <10ms）。
function armFirstBatchTimeout(state) {
    if (CONFIG.SYNC_FIRST_BATCH_TIMEOUT <= 0) return;
    state.firstBatchTimer = setTimeout(() => {
        if (!state.isFirstBatch) return;
        try {
            if (state.ws.readyState === state.ws.OPEN) {
                state.ws.close(1000, 'subscription handshake timeout');
            }
        } catch (err) {
            // 超时关闭失败说明连接已处于异常状态，teardown 会接手清理。
            // 记 debug 而非静默：首包超时本身就是要观测的行为（它意味着
            // 对端握手后不发数据），配套记录失败原因便于定位。
            logger.debug('首包超时关闭失败，交由收尾清理', { error: err && err.message });
        }
    }, CONFIG.SYNC_FIRST_BATCH_TIMEOUT);
    state.firstBatchTimer.unref();
}

function clearFirstBatchTimeout(state) {
    if (state.firstBatchTimer) { clearTimeout(state.firstBatchTimer); state.firstBatchTimer = null; }
}

// —— 数据报（DNS 查询）队列 ——
//
// 帧格式为 2 字节大端长度前缀。长度为 0 是畸形帧：不消费会原地打转，
// 直接丢弃这 2 字节前进。全部后端都失败时不能静默丢弃——客户端会
// 一直等下去，此时回一个长度为 0 的空帧，明确表示"本次查询无应答"。
//
// 消费用游标而不是反复 subarray：subarray 只是视图，前面已消费的部分
// 仍然被整块底层内存持有，边消费边追加会退化成"每次追加都复制一遍
// 历史数据"。游标前进后只在队列末尾做一次压实。
//
// 入站报文的合法性校验：
//   查询内容是不透明载荷，但"不透明"不等于"不校验"。未校验的报文
//   直接发给内网解析后端，等于把本节点变成对内网解析服务的探针——
//   任何人都能借这条路探测内网可达性、投递畸形报文。
//   这里只做结构性检查（长度、方向位、问题段计数），
//   合法报文的转发路径与字节内容逐字节不变。
function isWellFormedQuery(buf) {
    // DNS 头部固定 12 字节：ID(2) FLAGS(2) QDCOUNT(2) AN(2) NS(2) AR(2)
    if (buf.length < 12) return false;
    // 上限由配置决定，默认覆盖 RFC 1035 的 512 与 EDNS0 的 4096
    if (buf.length > CONFIG.UDP_MAX_QUERY_SIZE) return false;

    const flags = (buf[2] << 8) | buf[3];
    // QR 位必须为 0：这一位为 1 表示"应答报文"。
    // 客户端往服务端送应答报文没有任何业务含义，是典型的探测特征。
    if (flags & 0x8000) return false;

    // QDCOUNT 必须恰好为 1：标准查询只带一个问题段，
    // 0 或 2 以上都不是正常客户端行为。
    const qdcount = (buf[4] << 8) | buf[5];
    if (qdcount !== 1) return false;

    return true;
}

// 每连接查询令牌桶：并发连接上限管的是"多少条连接"，
// 管不到"一条连接问了多少次"。已认证的单条连接可以在一秒内提交
// 任意多次查询，全部转发给解析后端——这是连接数限制覆盖不到的放大面。
function allowQuery(state) {
    if (CONFIG.UDP_QUERY_LIMIT <= 0) return true;

    const now = Date.now();
    if (state.datagramTokens === undefined) {
        state.datagramTokens = CONFIG.UDP_QUERY_BURST;
        state.datagramRefilledAt = now;
    }

    // 按经过时间线性回填，上限为桶容量
    const elapsedMs = now - state.datagramRefilledAt;
    if (elapsedMs > 0) {
        const refill = (elapsedMs / 1000) * CONFIG.UDP_QUERY_LIMIT;
        if (refill >= 1) {
            state.datagramTokens = Math.min(
                CONFIG.UDP_QUERY_BURST,
                state.datagramTokens + Math.floor(refill)
            );
            state.datagramRefilledAt = now;
        }
    }

    if (state.datagramTokens < 1) return false;
    state.datagramTokens--;
    return true;
}

// —— 用 DNS 报文本身表达"这条查询没成" ——
//
// 这是本轮修复的核心。之前的做法是往通道里回一段 JSON：
//   {"code":4030,"msg":"too many pending datagram queries","channel":"udp"}
//
// 客户端（Xray-core / v2rayN 的 DNS 客户端）在这条连接上期待的是
// **DNS 报文**，拿到 JSON 后无法解析，只能当作"没有应答"处理——
// 表现到浏览器上就是"找不到 DNS 地址"。实测 50 条并发查询有 18 条
// 撞在途上限、全部拿到 JSON，页面随即报 DNS 失败。
//
// 正确做法是**协议层的问题用协议层的方式表达**：回一条合法的 DNS
// 应答，把 RCODE 设成对应的失败码。客户端拿到的是它能理解的报文，
// 于是知道"这次查询失败"，可以按自己的策略重试或换后端——这正是
// 真实 DNS 服务器的做法。
//
// RCODE 取值（RFC 1035 §4.1.1）：
//   1 FORMERR  服务器无法解析该查询（用于结构非法）
//   2 SERVFAIL 服务器侧失败（限流、后端不可达、在途超限）
function buildDnsErrorReply(queryData, rcode) {
    if (!queryData || queryData.length < 12) return null;

    // 定位问题段结尾：QNAME（以 0 长度标签终止）+ QTYPE(2) + QCLASS(2)
    let i = 12;
    while (i < queryData.length && queryData[i] !== 0) {
        const labelLen = queryData[i];
        i += labelLen + 1;
        if (labelLen > 63) return null;      // 非法标签长度，放弃构造
    }
    if (i >= queryData.length) return null;  // 未正常终止
    const end = Math.min(queryData.length, i + 1 + 4);
    if (end <= 12) return null;

    const reply = Buffer.alloc(end);
    queryData.copy(reply, 0, 0, end);
    // 标志位：QR=1（这是应答）、保留查询的 RD、RA=1、写入 RCODE
    reply[2] = 0x80 | (queryData[2] & 0x01);
    reply[3] = 0x80 | (rcode & 0x0F);
    // 四个计数字段：QDCOUNT 保留 1，其余归零
    reply[4] = 0; reply[5] = 1;
    reply[6] = 0; reply[7] = 0;
    reply[8] = 0; reply[9] = 0;
    reply[10] = 0; reply[11] = 0;

    const frame = Buffer.alloc(2 + reply.length);
    frame[0] = reply.length >> 8;
    frame[1] = reply.length & 0xFF;
    reply.copy(frame, 2);
    return frame;
}

// 首包载荷里取出第一条 DNS 查询（若存在）。
//
// 数据报首包的载荷是"2 字节大端长度 + 查询报文"的流，与队列消费时的
// 解析规则一致。通道级拒绝发生在首包，此时可能只收到了半个报文，
// 因此必须逐项校验再取，取不到就返回 null 让调用方优雅退化——
// 直接把整段载荷丢给 buildDnsErrorReply 会拿长度前缀当 DNS 头用，
// 拼出一条客户端无法识别的畸形应答，比不回更糟。
function firstQueryFromPayload(payloadData) {
    if (!payloadData || payloadData.length < 14) return null;   // 2 字节长度 + 最短 12 字节报文头
    const len = (payloadData[0] << 8) | payloadData[1];
    if (len === 0 || payloadData.length < 2 + len) return null; // 长度异常或未收齐
    return payloadData.subarray(2, 2 + len);
}

// 查询级拒绝：回 DNS 失败应答。构造不出来（查询本身畸形到无法回显
// 问题段）时回退为不响应——那也比塞一段客户端解析不了的 JSON 好。
function refuseQuery(state, code, msg, queryData) {
    const ws = state.ws;
    if (ws.readyState !== ws.OPEN) return;

    if (code === 4029 || code === 4030 || code === 4005) {
        const rcode = (code === 4005) ? 1 : 2;   // FORMERR : SERVFAIL
        const frame = buildDnsErrorReply(queryData, rcode);
        if (frame) {
            try {
                ws.send(frame);
                noteDatagram(rcode === 1 ? 'formerr' : 'servfail');
                return;
            } catch (err) { /* 落到下方记日志 */ }
        }
        // 构造或发送失败：不回。客户端会按超时重试，优于收到垃圾报文。
        logger.debug('数据报拒绝应答未能构造', { code });
        return;
    }

    // 其余错误码不在这条连接上表达：它们不是"某条查询没成"，
    // 而是"这条通道本身不可用"，由 refuseDatagramChannel 处理。
    logger.debug('数据报拒绝未匹配任何 DNS 语义分支', { code });
}

// —— 通道级拒绝：同样回 DNS 语义，再按 rejectWithCode 的节拍关闭 ——
//
// 4003（通道未启用）与 4004（端口不支持）此前回的是 JSON。这是那轮
// 修复中最关键的一处：通道未启用恰恰是**默认配置踩坑后的常态**
// （当时 .env.example 里那行生效的 TELEMETRY_ENDPOINTS= 就会走到这里），
// 而客户端在这条连接上期待的是 DNS 报文，拿到 JSON 只能当"无应答"
// 处理——表现到浏览器上就是"找不到 DNS 地址"，且服务端日志无任何
// 痕迹。REFUSED 是标准语义：客户端立刻知道这条路不通。
//
// 现在 4003 只剩一个来源：SYNC_UDP_DISABLE=1。TELEMETRY_ENDPOINTS 填错
// 或留空不再关闭通道（一律回落到内置默认值），因此下面这条分支在默认
// 部署下不应再被走到；保留它是因为"关掉的时候也得说得清"。
//
// 与查询级拒绝的差别只有一处：这两类之后连接要关，因此回完要按
// rejectWithCode 的随机延迟节拍关闭，而不是留着连接。
function refuseDatagramChannel(state, code, msg, queryData) {
    const ws = state.ws;
    // 连接已不可用：没有可回应的对象，只按节拍收尾。这里不记 warn——
    // 那不是"退化"，连接本来就要关了，记下来只会淹没真正的退化事件。
    if (ws.readyState !== ws.OPEN) {
        scheduleRejectClose(state);
        return;
    }

    const frame = queryData ? buildDnsErrorReply(queryData, 5) : null;
    if (frame) {
        try {
            ws.send(frame);
            noteDatagram('refused');
            scheduleRejectClose(state);
            return;
        } catch (err) {
            // 落到下方回退：写出失败通常是连接正在关闭。
            logger.debug('数据报拒绝应答写出失败', { code, error: err && err.message });
        }
    }

    // 走到这里说明首包里没有可回显的完整查询报文（畸形首包、或连接
    // 已不可用），构造不出 DNS 应答。此时只能回结构化响应——它无法被
    // 客户端解析，因此记 warn 而不是 debug：这正是"为什么浏览器还是
    // 打不开"的唯一线索，默认日志级别下不能吞掉。
    logger.warn('数据报通道级拒绝未能以 DNS 语义应答', {
        code: code, hasQuery: !!(queryData && queryData.length)
    });
    rejectWithCode(state, {
        code: code, msg: msg, hint: 'contact your network administrator', channel: 'udp'
    });
}

// —— 单次 DoH 查询 ——
//
// 从 processDatagramQueue 内联的匿名 async 中抽出（体检报告 P2-4）：
// 原写法把"队列消费 → 限流 → 校验 → 异步查询 → 组装回帧"全塞在一个
// 函数里，最深处嵌套 7 层，while/if/for/try 相互交错，任何一层改动
// 都要重新数缩进。抽出后职责变成两块：本函数只负责"把一条查询变成
// 一帧应答"，队列消费逻辑留在调用方，两边都能单独读懂。
//
// 返回值为组装好的帧；全部后端都没给出可用应答时返回 null，
// 由调用方决定如何对外表达（当前是回长度 0 的空帧）。

// 单个解析后端的等待上限（毫秒）。resolveViaBackends 是串行逐个尝试，
// 若不加超时，一个挂起的后端会让整条查询无限期等待、后续查询排队堆积。
// 取自 CONFIG（默认 5s）：覆盖内网解析服务的正常 p99 延迟并留有余量；
// 超时的后端视为不可用，立即轮换到下一个。

async function queryDohEndpoint(endpoint, queryData) {
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Accept': 'application/dns-message', 'Content-Type': 'application/dns-message' },
            body: queryData,
            // 超时由 AbortSignal 强制执行：fetch 与随后的 body 读取
            // 都会被中断并抛 TimeoutError，落入下方 catch 记 debug。
            signal: AbortSignal.timeout(CONFIG.SYNC_DOH_TIMEOUT_MS)
        });
        if (!response.ok) return null;

        const respArray = new Uint8Array(await response.arrayBuffer());
        // 帧格式：2 字节大端长度前缀 + 应答载荷。
        // 长度上限由 DNS 报文本身保证（≤ 65535），不会溢出 2 字节。
        const frame = Buffer.alloc(2 + respArray.length);
        frame[0] = respArray.length >> 8;
        frame[1] = respArray.length & 0xFF;
        frame.set(respArray, 2);
        return frame;
    } catch (err) {
        // 该后端不可达（网络失败、超时等）。记 debug 并带上是哪个后端，
        // 便于"全部后端都失败、只回空帧"时回溯是谁先坏的。
        // 刻意不记查询内容——那是用户载荷。
        logger.debug('解析后端起效失败', {
            endpoint: String(endpoint).slice(0, 120),
            error: err && err.message
        });
        return null;
    }
}

// 依次尝试各解析后端，返回第一个成功的应答帧；全部失败返回 null。
// TELEMETRY_BACKENDS 为空时直接返回 null——现在只有 SYNC_UDP_DISABLE=1
// 会让列表为空（配置缺失/非法已改为回落，见 lib/config.js）。
//
// 刻意保持**串行**而非并发竞速：并发会把同一条查询同时送给三家，
// 既放大三倍出网流量，也让三家公司都看到用户的解析请求。后端顺序
// 即优先级，正常情况下第一个就返回；串行只有在一个后端"半死不活"
// （连得上但极慢）时才付出等超时的代价，而这种情况本身罕见。
async function resolveViaBackends(queryData) {
    for (const endpoint of CONFIG.TELEMETRY_BACKENDS) {
        const frame = await queryDohEndpoint(endpoint, queryData);
        if (frame) return frame;
    }
    // 全部后端都没给出应答。
    //
    // 这条日志级别是 warn 而不是 debug：这正是"服务端一切正常、
    // 客户端只看到找不到 DNS 地址"那种静默故障的唯一现场证据。
    // 之前记 debug，在默认 LOG_LEVEL=warn 下完全不落盘，出故障时
    // 服务端日志干净得看不出任何异常，只能靠猜。
    logger.warn('全部解析后端均未给出应答', {
        backends: CONFIG.TELEMETRY_BACKENDS.length
    });
    // 与上面那条日志配套：日志会被平台限流或只看尾部，计数则是
    // "这条路上到底失败了多少次"的可核对证据（/_diag/channel 可读）。
    noteDatagram('backendFail');
    return null;
}

// 消费一条已通过限流与结构校验的查询：
// 解析成功则回应答帧，否则回长度 0 的空帧（明确表示"本次无应答"）。
// 与队列消费解耦，调用方无需关心 await 与 socket 状态判断。
async function answerDatagramQuery(state, queryData) {
    state.dohInflight++;
    try {
        const frame = await resolveViaBackends(queryData);
        if (state.ws.readyState !== state.ws.OPEN) return;
        try {
            // 后端全部失败时的处置从"长度 0 的空帧"改为 SERVFAIL：
            // 空帧对客户端等于"应答长度为 0"，同样无法解析，表现为
            // 解析超时。SERVFAIL 是标准语义，客户端能立刻判定失败并
            // 走自己的重试/换后端策略。
            const out = frame || buildDnsErrorReply(queryData, 2);
            if (out) {
                state.ws.send(out);
                // 发出应答同样是"通道有活动"，一并重置空闲计时。
                touchDatagramIdle(state);
                if (frame) noteDatagram('answered');
                else noteDatagram('servfail');
            }
        } catch (err) {
            // 写不出去基本可判定连接已断，teardown 会接手清理。
            logger.debug('数据报应答写出失败', { error: err && err.message });
        }
    } finally {
        // 必须放在 finally：超时、网络失败、后端返回异常都要归还额度，
        // 否则一次失败就永久占掉一个在途名额，连接很快被判为"永远满载"。
        state.dohInflight--;
    }
}

async function processDatagramQueue(state) {
    while (state.datagramBuffer.length - state.datagramOffset >= 2) {
        const base = state.datagramOffset;
        const len = (state.datagramBuffer[base] << 8) | state.datagramBuffer[base + 1];

        if (len === 0) { state.datagramOffset = base + 2; continue; }

        // 载荷未收齐就退出，等后续帧补足（不前进游标）
        if (state.datagramBuffer.length - base < 2 + len) break;

        const queryData = state.datagramBuffer.subarray(base + 2, base + 2 + len);
        state.datagramOffset = base + 2 + len;
        // 计数放在限流之前：被限流/被拒的查询也是"客户端发来的查询"，
        // queries 与四个结果计数之差能直接读出"有多少条没被应答"。
        noteDatagram('queries');

        // 等价模式：令牌桶、结构校验、在途上限三道闸全部跳过。
        //
        // 这三道里的任何一道都会让查询拿到 SERVFAIL / FORMERR 而不是
        // 真实应答，而客户端在 DNS 通道上收到失败应答的表现恰好就是
        // "浏览器找不到 DNS 地址"。它们因此是本次排查的首要嫌疑，
        // 也是这个开关必须能一次性把它们全部拿掉的原因。
        if (!COMPAT.enabled) {
            // 先限流再校验：超限的连接不应再让服务端做任何后续工作
            if (!allowQuery(state)) {
                refuseQuery(state, 4029, 'datagram query rate exceeded, resync later', queryData);
                continue;
            }

            if (!isWellFormedQuery(queryData)) {
                refuseQuery(state, 4005, 'malformed datagram query', queryData);
                continue;
            }

            // 在途上限：限的是"同时有多少条查询在等后端"，与上面的速率桶
            // 互补。后端变慢时（超时值越大越明显），只靠速率桶仍能让单条
            // 连接攒出几百个在途 fetch。超限即拒，不再放大到解析后端。
            if (CONFIG.SYNC_DOH_MAX_INFLIGHT > 0
                && state.dohInflight >= CONFIG.SYNC_DOH_MAX_INFLIGHT) {
                refuseQuery(state, 4030, 'too many pending datagram queries, retry later', queryData);
                continue;
            }
        }

        // 查询本身是异步的（等后端应答），但不阻塞队列消费：
        // 后续报文继续入队，各自独立应答。用 catch 兜住意外，
        // 避免未处理的 rejection 拖垮进程。
        answerDatagramQuery(state, queryData).catch((err) => {
            logger.debug('数据报查询处理异常', { error: err && err.message });
        });
    }

    // 队列末尾压实：丢弃游标之前的已消费字节。
    //
    // 惰性压实（此前是无条件压实）：连续小报文的场景下——DNS 查询通常
    // 每帧几十字节——每收到一帧就做一次全量 memcpy，而这些拷贝里
    // 绝大部分搬的是"下次立刻又要丢掉"的已消费字节。
    // 折中：已消费量达到阈值、或已占到缓冲一半时才压实。
    // 一直不压实也不行：缓冲会带着已消费字节持续变长。
    const consumed = state.datagramOffset;
    if (consumed > 0
        && (consumed >= CONFIG.SYNC_DATAGRAM_COMPACT_MIN
            || consumed * 2 >= state.datagramBuffer.length)) {
        state.datagramBuffer = Buffer.from(
            state.datagramBuffer.subarray(consumed)
        );
        state.datagramOffset = 0;
    }
}

// —— 中继管道：客户端 <-> 目标仓库的 TCP 双向转发 ——
function openTcpRelay(state, bp, deltaMeta, payloadData) {
    const ws = state.ws;
    const targetText = resolveWarehouse(deltaMeta.routingFormat, deltaMeta.targetNode);

    // 水位只在显式配置时传入，置 0 则完全沿用系统默认，不改动既有行为。
    //
    // 等价模式：一律不覆盖。参考实现建连时不传水位，用的是系统默认；
    // 若这里继续传入 256KB，就与参考差着一档调度粒度——而"吞吐差异"
    // 恰恰是那种只在特定负载下才显现、最难归因的差异。
    const streamOptions = (CONFIG.SYNC_STREAM_HWM > 0 && !COMPAT.enabled)
        ? { readableHighWaterMark: CONFIG.SYNC_STREAM_HWM, writableHighWaterMark: CONFIG.SYNC_STREAM_HWM }
        : {};

    // 真正的建连，抽出来是因为准入判定需要先解析域名：
    // 判通过的那个 IP 直接用于建连，不再解析第二次。
    const connect = (host) => {
    // 出站方向的建连参数。
    //
    // lookup 是等价模式下**唯一**被拿掉的一项：正常模式传入 resolveHost
    // （c-ares → DoH → dns.lookup 四级，并带短 TTL 缓存），参考实现不传
    // lookup，用的是 Node 默认的 dns.lookup。两者在"平台 DNS 坏了"的
    // 部署上会给出完全相反的结果，因此这一项可能是症状的直接成因——
    // 也正因为如此，它必须能被单独切回默认，这就是本开关的用途。
    //
    // 用显式分支而不是"传一个可能为空的 lookup"：net.createConnection
    // 对 lookup: undefined 的处理与完全不传并不保证逐版本一致，显式
    // 不传才是"与参考一致"的写法。
    const baseOptions = {
        host: host,
        port: deltaMeta.warehousePort,
        // 出站方向要禁 Nagle：交互式流量（请求头、按键、心跳）都是小包，
        // 开了 Nagle 会被攒到 40ms 或凑满一个 MSS 才发出去。
        // 入站那条连接由 vendor 在握手时设置，这里补出站这一侧。
        noDelay: true
    };
    if (!COMPAT.enabled) baseOptions.lookup = resolveHost;

    state.externalConnection = net.createConnection(Object.assign(baseOptions, streamOptions), () => {
        if (payloadData.length > 0) state.externalConnection.write(payloadData);
    });

    // 出站空闲超时。
    //
    // 没有它时，"目标连上了但既不收发也不关闭"的连接会一直挂着：
    // 它占着并发表里的名额，没有任何一方报错，客户端表现为"部分
    // 连接连不上"而日志干干净净。setTimeout 计的是空闲时间而非
    // 总时长，因此持续有数据的长传输不受影响。
    //
    // 触发后只 destroy：'close' 处理器会统一复位背压状态并关闭通道，
    // 这里再补一次 ws.close() 反而会与它竞争。
    //
    // 等价模式下不设：参考实现没有任何空闲超时。
    if (CONFIG.SYNC_OUTBOUND_IDLE_TIMEOUT > 0 && !COMPAT.enabled) {
        state.externalConnection.setTimeout(CONFIG.SYNC_OUTBOUND_IDLE_TIMEOUT);
        state.externalConnection.on('timeout', () => {
            logger.debug('出站连接空闲超时，主动拆链', {
                idleMs: CONFIG.SYNC_OUTBOUND_IDLE_TIMEOUT
            });
            try { state.externalConnection.destroy(); } catch (_) { /* 已关闭 */ }
        });
    }

    // 目标 -> 客户端：转发，并按 ws 缓冲量反向节流目标读取。
    // 写出回调负责在缓冲排空后恢复目标读取（取代原先的定时器轮询）。
    //
    // 等价模式：不节流，收到就发（与参考一致）。
    //
    // 这一项值得单独说明：节流引入的是"目标读得慢时暂停读目标"这一
    // 行为，而浏览器首屏恰恰是"客户端读得很慢、一次要几十条隧道"的
    // 场景。它是否真的有害无法在纸面上判定——但它是本项目与参考之间
    // 一处**结构性**的差异，属于本开关要一次性移除的那批。
    //
    // ⚠️ 这里关掉的只有"是否按水位主动 pause 对端"这一个策略开关。
    // 缓冲的硬上界不在这个开关的覆盖范围内（见 DOWNSTREAM_CEILING 的
    // 说明）：关闭开关绝不意味着"缓冲可以无限涨"。区别只在于撞上界之后
    // 做什么——默认形态是"按水位节流"（绝大多数连接根本到不了上界），
    // 等价形态是"撞上界才节流"，两种形态下上界都生效。
    state.externalConnection.on('data', chunk => {
        if (ws.readyState !== ws.OPEN) return;
        // 等价模式下平时"收到即发"，且刻意不带写出回调（与参考一致）。
        // 一旦这条连接因越界进入强制节流，就必须带回调——恢复读目标的
        // 时机挂在它上面（见 afterFlush）。
        if (COMPAT.enabled && !bp.isForced()) {
            ws.send(chunk);
        } else {
            ws.send(chunk, bp.afterFlush);
        }

        // 硬上界：与是否节流无关，两条形态都必须生效。
        //
        // 判定放在 send **之后**：刚写出的这一帧也要算进缓冲，否则
        // "单帧就大于上界"的场景会被整个漏过——那正是最需要兜住的一帧。
        //
        // 越界不再立即拆链：先强制启用节流（暂停读目标）。只有节流之后
        // 缓冲仍不下降，才由观察窗口判定为死连接并拆链。
        if (bp.wsBuffered() >= DOWNSTREAM_CEILING) {
            bp.enforceCeiling();
            return;
        }

        // 节流：默认形态按高水位启用；等价模式下平时不启用，但这条连接
        // 撞过上界之后对它就永久启用（不再退回"收到即发"）。
        if (!COMPAT.enabled || bp.isForced()) {
            if (bp.wsBuffered() >= HIGH_WATER) bp.pauseDownstream();
        }
    });

    state.externalConnection.on('error', () => {
        // 不打印目标地址：容器 stdout 常被平台采集，
        // 记录目的地等于替用户留下了一份访问清单。
        console.error('[Sync Error] Warehouse connection refused.');
        ws.close();
    });
    state.externalConnection.on('close', () => {
        // 必须复位背压状态再关闭。
        //
        // 曾经的时序缺口：若目标地址不可达，客户端又恰好在首包内塞了较大
        // 载荷，则第一次 write 会发生在 TCP 仍处于 CONNECTING 时——此时
        // 内核写缓冲直接吸收数据、write 返回 false，于是 writeToExternal
        //置 awaitingDrain=true 并 pause 了 ws。可连接随后失败，'drain'
        // 永远不会到达（实测：ECONNREFUSED 后 drain 不触发），
        // awaitingDrain 就此永久卡在 true——该连接之后收到的每一帧都会在
        // writeToExternal 的第二行被静默丢弃，客户端表现为"连上了但只发得
        // 出第一包"。
        //
        // close 是这条连接唯一的必经出口（成功断开与连接失败都会走到），
        // 因此在这里统一收口。置位与副作用都放在 try 内：本函数运行在
        // 事件回调里，抛出的异常会穿透到进程级 uncaughtException。
        try {
            state.awaitingDrain = false;
            if (ws.readyState === ws.OPEN) ws.resume();
        } catch (err) {
            logger.debug('中继关闭复位失败', { error: err && err.message });
        }
        ws.close();
    });
    };

    // ── 目标准入 ──────────────────────────────────────────────
    //
    // 关闭判定（自建隔离环境当作内网关使用时）直接放行。
    //
    // 等价模式：完全跳过准入。
    //
    // 注意这里跳过的**不只是**"地址是否在私有段"这一步，连带跳过了
    // 域名目标的"先解析成 IP 再判定"——也就是说等价模式下域名不再被
    // 提前解析，而是直接交给 net.createConnection（参考实现正是如此）。
    // 这两件事必须一起跳过：只跳判定而保留预解析，仍然会在解析失败时
    // 走 4007 拒绝分支，实验就做不到正交。
    //
    // 代价要说清楚：等价模式下持令牌者可经由本节点访问服务端所在网络
    // 的任意地址。这是**排查专用形态**，不是推荐配置。
    if (COMPAT.enabled || !CONFIG.SYNC_TARGET_GUARD) { connect(targetText); return; }

    const deny = (code, msg) => rejectWithCode(state, {
        code, msg, hint: 'contact your network administrator', channel: 'tcp'
    });

    // 域名必须先解析成 IP 再判。
    //
    // 顺序不能反过来：解析之前，"指向 127.0.0.1 的域名"看起来与
    // 任何合法域名无异，先判字符串等于没判。而建连用的是判定通过的
    // 那个 IP，不再解析第二次——否则两次解析之间返回不同地址
    // （DNS rebinding）就能绕开判定。
    if (deltaMeta.routingFormat === 3) {
        resolveHost(targetText, {}, (err, addr) => {
            if (err || !addr) {
                // warn 而非 debug：这是"连得上、握手过、但目标就是建不上"
                // 的静默失败点，此前日志里完全没有痕迹，只能靠猜。
                //
                // 刻意不记域名：容器 stdout 常被平台采集，记录目的地
                // 等于替用户留下一份访问清单。需要确认"是不是解析坏了"
                // 时看 /_diag/channel 的 resolveFail 计数即可。
                logger.warn('域名目标解析失败，已拒绝该连接', { code: 4007 });
                deny(4007, 'target host could not be resolved');
                return;
            }
            const verdict = classifyTarget(addr);
            if (!verdict.allowed) {
                // 只记被拒的原因分类，不记具体地址：
                // 容器 stdout 常被平台采集，记录目的地等于替用户留下
                // 一份访问清单。
                logger.info('出站目标被准入策略拒绝', { reason: verdict.reason });
                deny(4006, 'target address is not permitted');
                return;
            }
            connect(addr);
        });
        return;
    }

    const verdict = classifyTarget(targetText);
    if (!verdict.allowed) {
        logger.info('出站目标被准入策略拒绝', { reason: verdict.reason });
        deny(4006, 'target address is not permitted');
        return;
    }
    connect(targetText);
}

// —— 首包处理：令牌校验、通道分流（数据报 / 中继）——
// —— 业务化拒绝：回一条明确的错误响应再延迟关闭 ——
//
// 建立连接后无声断开会让客户端一直等到超时，而正常的业务服务应当
// 明确告知请求非法。因此所有"拒绝类型"的分支共用这一出口：先尽力
// 送出业务错误码，再随机延迟关闭（避开固定节拍）。
//
// 抽出前这段逻辑在 handleFirstBatch 里重复了三遍（4001/4003/4004），
// 每份都自带 try/catch，把函数推到嵌套 6 层。现在只有一处实现。
// 返回 void：调用方拿到控制权后应 return。
function rejectWithCode(state, payload) {
    const ws = state.ws;
    try {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(payload));
        }
    } catch (err) {
        // 拒绝理由已尽力送达；发不出去通常是连接正在关闭。
        // 记 debug 即可——拒绝事件本身由调用方记录（如认证失败会
        // 走 noteInvalid 计入风控），这里只补"客户端可能没收到"。
        logger.debug('业务拒绝响应写出失败', {
            code: payload && payload.code, error: err && err.message
        });
    }
    scheduleRejectClose(state);
}

// 拒绝后的关闭节拍，单独抽出是因为它现在有两个调用方：
// rejectWithCode（回结构化响应）与 refuseDatagramChannel（回 DNS
// 报文）。两者若各写一份延迟关闭，就会出现"某类拒绝瞬时断开、另一类
// 延迟断开"——那是一条可被旁观测量的时序差异，等于给拒绝类型打了标签。
function scheduleRejectClose(state) {
    const ws = state.ws;
    // 随机延迟关闭：固定延迟本身就是可被识别的节拍。
    // 句柄存进 state 以便 teardown 时取消——连接可能在延迟到期前
    // 就因其它原因被拆，那时这条定时器已经没有意义。
    if (state.closeTimer) clearTimeout(state.closeTimer);
    state.closeTimer = setTimeout(() => ws.close(),
        CONFIG.SYNC_CLOSE_DELAY_BASE_MS + Math.random() * CONFIG.SYNC_CLOSE_DELAY_JITTER_MS);
    // unref：这条定时器不该决定进程能否退出。短生命周期场景
    // （测试进程、一次性脚本）会因为它而挂住不结束。
    if (state.closeTimer.unref) state.closeTimer.unref();
}

// —— 静默拒绝：只关闭，不给任何响应 ——
//
// 用在**令牌校验失败**这一条分支上。这条分支的特殊性在于：探测者
// 不需要任何凭证就能走到这里——只要构造一个合法握手、往端点发任意
// ≥24 字节即可。此前这里回
//
//     {"code":4001,"msg":"invalid sync batch signature, resync required",...}
//
// 实测三种非法输入（随机字节 / 全零 / 错误 UUID）**全部**返回这一串，
// 是可精确字符串匹配的特征。配合 4003/4004/4006/4007/4030，构成一套
// 完整的错误码指纹谱系。探测者据此可以在不知道令牌的前提下确认
// "这是一个需要签名的代理通道"——真实企业站的 WebSocket 业务端点
// 收到随机字节不会给出这种结构化答复。
//
// 参照成熟实现的做法：令牌不对就**直接关闭，什么都不回**。探测者拿到
// 的是沉默，无法区分"这是代理"与"这是个不认识我的 WS 业务端点"。
//
// 其余错误码（4003/4004/4006/4007/4030）**保持在原位不动**：它们都在
// 令牌校验通过之后才可能触发，探测者到不了，而对真实客户端来说，
// 明确告知"为什么被拒"远比无声断开有用。
//
// 关闭仍带随机延迟，与 rejectWithCode 共用同一节拍：令牌错误就瞬时
// 断连、正常拒绝却延迟关闭，这本身又是一条可测的时序差异。
function silentReject(state) {
    const ws = state.ws;
    if (state.closeTimer) clearTimeout(state.closeTimer);
    state.closeTimer = setTimeout(() => {
        try {
            if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
                // 不给 close code / reason：默认的 1000 是最中性的形态，
                // 带 code 反而多一个可被分类的字段。
                ws.close();
            }
        } catch (err) {
            logger.debug('静默拒绝时关闭失败', { error: err && err.message });
        }
    }, CONFIG.SYNC_CLOSE_DELAY_BASE_MS + Math.random() * CONFIG.SYNC_CLOSE_DELAY_JITTER_MS);
    // unref：与 rejectWithCode 一致，这条定时器不该决定进程能否退出。
    if (state.closeTimer.unref) state.closeTimer.unref();
}

function handleFirstBatch(state, bp, msg) {
    const ws = state.ws;
    const deltaMeta = decodeBinaryDelta(msg);

    if (!deltaMeta) {
        console.log('[Auth] Invalid Sync Batch Signature. Rejecting.');
        noteInvalid(state.sourceIp);
        // 令牌校验失败：静默关闭，不回任何业务码。见 silentReject 的说明。
        silentReject(state);
        return;
    }

    // 应答头发出即代表令牌校验通过：此刻才把握手时借出的并发名额
    // 兑现为正式占用（见 limits.js 的两档计数）。放在这里而不是等到
    // 目标准入/建连之后，是因为准入失败会关闭连接、走 release 释放，
    // 不会漏计数；而置后才兑现会让"连着不发首包"的连接长期占用正式额度。
    //
    // 顺带把"这条通道是哪种形态"报给计数侧：僵尸来自 TCP 中继还是数据报
    // 通道，是两种完全不同的处置（前者的僵尸有出站空闲超时兜底，后者
    // 此前一个定时器都没有），混在一个数字里就无法知道该往哪儿查。
    if (typeof state.onFirstBatchAccepted === 'function') {
        try {
            state.onFirstBatchAccepted(deltaMeta.streamType === 2 ? 'datagram' : 'relay');
        } catch (err) {
            logger.debug('并发名额兑现失败', { error: err && err.message });
        }
    }

    ws.send(Buffer.from([msg[0], 0]));

    const payloadData = msg.subarray(deltaMeta.payloadOffset);

    if (deltaMeta.streamType === 2) {
        handleDatagramFirstBatch(state, deltaMeta, payloadData);
        return;
    }

    openTcpRelay(state, bp, deltaMeta, payloadData);
}

// 数据报首包的分流：未启用 / 端口不支持 各自业务化拒绝，
// 正常情况把载荷交给队列消费。抽出后 handleFirstBatch 只留主链路。
function handleDatagramFirstBatch(state, deltaMeta, payloadData) {
    // 本部署未配置解析后端时，数据报通道是关闭的。
    //
    // 现在这条分支只有 SYNC_UDP_DISABLE=1 能触发（TELEMETRY_ENDPOINTS
    // 留空/填错一律回落到内置默认值，不再关闭通道）。仍然回 DNS REFUSED
    // 而不是 JSON：客户端的 DNS 客户端期待的是 DNS 报文，拿到 JSON 只能
    // 当"无应答"处理，表现为浏览器报"找不到 DNS 地址"而服务端日志毫无
    // 痕迹——这正是"空值关通道"那个陷阱曾经的表现形态。
    if (!CONFIG.SYNC_UDP_ENABLED) {
        refuseDatagramChannel(state, 4003, 'datagram relay is not enabled on this node',
            firstQueryFromPayload(payloadData));
        return;
    }

    state.isDatagram = true;

    // 与上面保持一致：不静默断连，且同样回 DNS 语义。
    // 端口判据可配（SYNC_UDP_PORT），置 0 表示不限制端口。
    //
    // 等价模式下改为**字面量 53**：参考实现写的是 `port !== 53`，
    // 不是"可配的端口"。这是这批差异里唯一被保留下来的一项，因此
    // 必须按参考的判定方式（`!== 53`）而不是按本项目的可配值来判，
    // 否则 SYNC_UDP_PORT 被配成别的值时，等价模式就不等价了。
    const udpPort = COMPAT.enabled ? COMPAT.COMPAT_UDP_PORT : CONFIG.SYNC_UDP_PORT;
    if (udpPort > 0 && deltaMeta.warehousePort !== udpPort) {
        refuseDatagramChannel(state, 4004, 'unsupported datagram destination port',
            firstQueryFromPayload(payloadData));
        return;
    }

    state.datagramBuffer = payloadData;
    state.datagramOffset = 0;
    // 通道确认可用之后才起定时器：走 4003 / 4004 拒绝分支的连接随后
    // 就由 scheduleRejectClose 收尾，不需要再挂一个回收计时。
    armDatagramIdle(state);
    processDatagramQueue(state);
}

// —— 后续帧：数据报续包入队 / 中继管道续写 ——
function handleSubsequent(state, bp, msg) {
    if (state.isDatagram) {
        appendDatagram(state, msg);
    } else {
        writeToExternal(state, msg);
    }
}

// 数据报续包：追加到队列尾部并继续消费。
// 追加前先压实，避免把已消费的字节反复带进下一次拷贝。
function appendDatagram(state, msg) {
    // 收到入站帧 = 通道上有活动，重置空闲计时（判据见 armDatagramIdle）。
    touchDatagramIdle(state);
    // 上一帧已消费干净时直接换引用，省掉一次全量 concat。
    // 这是最常见的情形：查询逐条到达、每条都能立刻被消费完。
    if (state.datagramOffset >= state.datagramBuffer.length) {
        state.datagramBuffer = msg;
        state.datagramOffset = 0;
    } else {
        const tail = state.datagramOffset > 0
            ? state.datagramBuffer.subarray(state.datagramOffset)
            : state.datagramBuffer;
        state.datagramBuffer = Buffer.concat([tail, msg]);
        state.datagramOffset = 0;
    }

    // 上限保护：异常客户端可能不停追加而不消费，无界增长会拖垮进程。
    // 按**未消费**字节数判定：惰性压实会让缓冲里留着已消费字节，
    // 若仍用 buffer.length 判定，正常客户端也会因残留而被误杀。
    if (state.datagramBuffer.length - state.datagramOffset > CONFIG.SYNC_DATAGRAM_BUFFER_MAX) {
        state.ws.close();
        return;
    }
    processDatagramQueue(state);
}

// 客户端 -> 目标：write 返回 false 表示目标侧已积压，
// 此时暂停 ws 读取，等目标 drain 后再恢复，
// 否则 msg 会在内存里越堆越多。
function writeToExternal(state, msg) {
    // 等价模式：收到即写，不 pause / resume、不进积压队列。
    //
    // 参考实现只有 `edgeSocket.write(msg)` 一行。正常模式那套背压逻辑
    // 在"目标侧瞬间写不动"时会把后续帧先暂存、超限则丢弃——它是一个
    // 静默的丢包面：客户端照发、服务端照收、但帧没到目标。这正是
    // "连接好好的、页面打不开"的典型形状，因此必须能被整体拿掉。
    if (COMPAT.enabled) {
        const direct = state.externalConnection;
        if (!direct || direct.destroyed) return;
        direct.write(msg);
        return;
    }

    const ext = state.externalConnection;
    if (!ext || ext.destroyed) return;

    // awaitingDrain 为真表示上一次写入撑满了目标侧缓冲，ws 读取已被
    // 暂停，正等 'drain' 恢复。
    //
    // 此前这里是直接丢弃后续帧：内存确实有界，但代价是连接变成
    // **静默黑洞**——客户端照常发送、服务端照常收下，却一帧不发往目标，
    // 且没有任何错误。短时间的正常突发（目标只是瞬间慢了一下）也会被
    // 整段吞掉。
    //
    // 改为先暂存有限帧数：突发小积压不丢，超限才丢，内存仍有上界。
    // 恢复由下面的 once('drain') 或 openTcpRelay 的 close 处理器负责。
    if (state.awaitingDrain) {
        const limit = CONFIG.SYNC_PENDING_FRAME_LIMIT;
        // limit <= 0 表示沿用旧的"立即丢弃"策略
        if (limit > 0 && state.pendingFrames.length < limit) {
            state.pendingFrames.push(msg);
            return;
        }
        return;
    }

    const flushed = ext.write(msg);
    if (flushed) return;

    // 目标侧缓冲已满。暂停 ws 读取等 drain，避免 msg 在内存里越堆越多。
    //
    // 状态置位与副作用必须在同一个 try 内：本函数运行在 ws 的 'message'
    // 回调里，任何抛出都会穿透到进程级 uncaughtException。若只保护其中的
    // resume/pause 而让置位暴露在外，一旦抛出就会留下
    // awaitingDrain=true 但 drain 监听未注册的中间态——那是比抛异常本身
    // 更难排查的静默卡死。
    try {
        state.awaitingDrain = true;
        state.ws.pause();
        ext.once('drain', () => {
            state.awaitingDrain = false;

            // 先补发积压帧，再恢复读取。顺序反过来会让恢复后新到的帧
            // 插到积压帧之前——对 TCP 字节流而言就是乱序，
            // 目标侧会看到一段错位的载荷。
            const queued = state.pendingFrames;
            state.pendingFrames = [];
            try {
                for (const frame of queued) {
                    if (ext.destroyed) break;
                    ext.write(frame);
                }
            } catch (err) {
                // 补发失败通常意味着连接在恢复瞬间被拆掉，teardown 会接手。
                logger.debug('积压帧补发失败', {
                    frames: queued.length, error: err && err.message
                });
            }

            try { state.ws.resume(); } catch (_) { /* 流已结束 */ }
        });
    } catch (err) {
        // 走到这里说明 pause 或 once 失败，连接已不可用。
        // 复位状态让后续帧走正常路径（它们会在 ext.destroyed 处被拦下），
        // 而不是全部静默丢弃。
        state.awaitingDrain = false;
        logger.debug('目标侧背压挂起失败', { error: err && err.message });
    }
}

// —— 收尾：连接结束时必须清理全部定时器与轮询，否则会随连接数累积 ——
function teardownChannel(state) {
    clearFirstBatchTimeout(state);
    clearDatagramIdle(state);
    // 延迟关闭定时器必须一并取消。
    //
    // rejectWithCode 是"回一个业务码再延迟关闭"：连接若在这段延迟内
    // 因其它原因被拆（对端先关、目标侧异常、进程收尾），定时器仍会在
    // 到点后对一条已结束的连接执行 close。单条无害，但短连接密集的
    // 场景下这些定时器会攒成一批——每个都持有 ws 引用，既延迟 GC，
    // 也让"连接数"的观测值在统计窗口内偏高。
    if (state.closeTimer) {
        clearTimeout(state.closeTimer);
        state.closeTimer = null;
    }
    // 下行缓冲的死连接观察定时器。
    //
    // 它只在"这条连接撞过上界"之后存在，但漏掉的后果与首包超时那类一样：
    // 定时器持有 ws 引用，且每拍都会去读 bufferedAmount。连接结束之后
    // 它还活着的话，就是一批既延迟 GC、又在做无用功的定时器。
    if (state.downstreamWatchdog) {
        clearInterval(state.downstreamWatchdog);
        state.downstreamWatchdog = null;
    }
    // 积压帧随连接一起丢弃：它们只在"目标侧 drain"这一条路径上有意义，
    // 连接结束之后再没有补发的时机，留着只是占内存。
    if (state.pendingFrames && state.pendingFrames.length) state.pendingFrames.length = 0;
    if (state.externalConnection) state.externalConnection.destroy();
}

module.exports = {
    HIGH_WATER,
    LOW_WATER,
    DOWNSTREAM_CEILING,
    DOWNSTREAM_STALL_WINDOW,
    createSession,
    createBackpressure,
    armFirstBatchTimeout,
    clearFirstBatchTimeout,
    isWellFormedQuery,
    allowQuery,
    refuseQuery,
    refuseDatagramChannel,
    rejectWithCode,
    queryDohEndpoint,
    resolveViaBackends,
    answerDatagramQuery,
    processDatagramQueue,
    openTcpRelay,
    handleFirstBatch,
    handleDatagramFirstBatch,
    handleSubsequent,
    appendDatagram,
    writeToExternal,
    teardownChannel
};
