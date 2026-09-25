// ====================================================================
// 参考等价模式（SYNC_COMPAT_MODE）
//
// ── 为什么要有这个开关 ──────────────────────────────────────────
//
// 用户症状从头到尾只有一句：v2rayN 真连接测试成功、Telegram 可用，
// 但浏览器打不开网页（Chrome 报"无法找到 DNS 地址"）。
//
// 排查方式是"逐成分对比参考实现与本项目、找出差异、消除差异"。到本
// 开关为止已经走了五轮，每一轮的形态完全一样：
//
//   1. 比对出一处（或几处）差异；
//   2. 它在纸面上确实可能解释症状，于是改掉；
//   3. 重新部署；
//   4. 症状不变 —— 于是这一处被证伪，但**无法知道它是否曾经是必要
//      条件的一部分**：也许它是三个原因之一，修好一个不够。
//
// 五轮下来每一处都是"plausible 但无法在生产端确认"。这个序列不收敛：
// 差异还有十来处，逐个试要十来次部署，而每一次都要用户在生产上重来
// 一遍；更糟的是，即便第十次终于好了，也说不清"是哪一处修好的"，
// 下一次换个环境照样从头猜。
//
// 因此改为一次性正交实验：用一个开关把**全部剩余差异同时移除**，让
// 数据面在行为上逐项等价于参考实现。结果只有两种：
//
//   · 症状消失 —— 原因确实在这批差异里，问题空间被二分掉一半，
//     再逐项回退（每次只开回一项）即可定位到具体那一处；
//   · 症状依旧 —— 这十处差异**整体**被排除，原因在数据面之外
//     （客户端侧、路径侧、平台侧），继续在数据面里改是纯粹的浪费。
//
// 两种结果都比"再猜一次"多出确定的信息量。这是本开关存在的全部理由。
//
// ── 边界：只动数据面 ────────────────────────────────────────────
//
// "数据面"= 通道**已经建立之后**的行为（转发、限流、超时、背压）。
// HTTP 面（登录、session、路由表、伪装响应、access-pace、/_diag/channel
// 的准入与外观）一个字节都不动。参考实现在 HTTP 面上与我们并不可比
// （它没有那一层），因此"等价"这个概念在那一侧没有定义。
//
// ── 硬约束：默认行为零变化 ──────────────────────────────────────
//
// 开关未置 1 时，所有路径必须与未引入本开关前逐字节等价。因此各处的
// 接入方式一律是**显式的 if (COMPAT.enabled) 分支**，而不是"把参数
// 算成某个值再传下去"这类隐式推导——后者看着简洁，但它同时改写了
// 正常路径的取值来源，一旦算错就是静默回归。宁可多写几个分支。
//
// ── 停用项的清单只有一份 ────────────────────────────────────────
//
// COMPAT_ITEMS 是启动日志与 /_diag/channel 的唯一真相源。两处若各维护
// 一份清单，就会出现"日志说停用了 10 项、诊断端点说 9 项"——那正是
// 本项目在别处反复吃过的亏。
//
// 循环依赖检查：本模块只依赖 ../config 与 ../logger，两者都不依赖
// lib/sync/ 下的任何模块，因此不构成环。
// ====================================================================

const CONFIG = require('../config');
const logger = require('../logger');

// 开关的取值。
//
// 判定用 === '1' 而不是"非空即为真"：排查开关的语义必须是**可精确
// 关闭**的。写成"非空即真"时，某个平台上残留一个空串或 '0' 的
// 环境变量会产生与实际意图相反的行为，而这类残留恰恰是排查场景下
// 最容易发生的（上一轮为了别的目的设过一次）。
const ENABLED = CONFIG.SYNC_COMPAT_MODE === true;

// 参考实现硬编码的 DNS 端口。
//
// 参考实现写的是 `if (meta.port !== 53)`，是字面量而不是配置项。等价
// 模式下必须按字面量 53 判定，否则"SYNC_UDP_PORT 被改成别的值"（该值
// 已固化在 lib/defaults.js）会让这一项在等价模式下悄悄变成另一条
// 判据——那就不叫等价了。
const COMPAT_UDP_PORT = 53;

// ── 停用项清单（顺序与任务表 1..10 一致）────────────────────────
//
// retained 填"这一项里被**保留**下来的部分"。没有它就是全部停用；
// 有它则说明是部分停用，启动日志与诊断端点必须把它写出来，
// 否则"停用了某项"会被读成"这项防护整个没了"。
const COMPAT_ITEMS = [
    {
        key: 'targetGuard',
        label: '出站目标准入判定（域名先解析成 IP 再过闸）：直接用域名或 IP 建连',
        retained: ''
    },
    {
        key: 'outboundLookup',
        label: '出站建连的自定义 lookup（c-ares → DoH → dns.lookup 四级）：改用 Node 默认 dns.lookup',
        retained: ''
    },
    {
        key: 'upstreamBackpressure',
        label: '客户端→目标方向背压（write 返回 false 即暂停 ws 读取 + 暂存积压帧等 drain）：收到即写',
        retained: ''
    },
    {
        key: 'downstreamThrottle',
        label: '目标→客户端方向按 ws.bufferedAmount 反向节流（超 1MB 暂停读目标）：收到即发',
        // 部分停用，且必须写出来。
        //
        // 这一项当初把两件性质不同的事打进了同一个开关：**节流策略**
        // （超水位就 pause 对端，让读端速度约束写端）与**资源上界**
        // （缓冲不能无限涨）。等价模式要移除的只有前者——它是与参考
        // 之间的行为差异；后者是内存护栏，关掉它的实测后果是单条连接
        // 3.3s 把进程打到 6.69GB 并被 OOM 杀掉（exit=137）。
        //
        // 因此这里保留的是"上界仍在，只是不再按水位主动 pause"。保留项
        // 不写出来的话，"停用了节流"会被读成"这条方向完全没有护栏了"，
        // 排查时会得出相反的结论。
        //
        // 越界的处置必须如实写清：它是"强制启用节流"，不是"拆链"。
        // 上一版把它写成"越界即拆链"，实测 5MB/s 目标 + 不消费的客户端
        // 5.8s 就被 RST——客户端慢于目标是真实场景（大文件下载、视频流、
        // 慢链路），用拆连接来解决缓冲策略问题，与这一项"移除与参考的
        // 行为差异"的本意正好相反。现在的顺序是：撞上界 → 暂停读目标
        // （缓冲立即停止增长，内存上界不变）→ 只有在缓冲于一个观察窗口
        // 内仍不下降时才判定为死连接并拆链（见 lib/sync/relay.js 的
        // DOWNSTREAM_CEILING 与 DOWNSTREAM_STALL_WINDOW，后者当前 15s）。
        retained: '缓冲硬上界仍生效：越界即强制启用反向节流（暂停读目标），'
            + '仅当节流后缓冲在观察窗口内仍不下降（死连接）才拆链'
    },
    {
        key: 'streamHighWater',
        label: '出站 socket 水位覆盖（readable/writableHighWaterMark = SYNC_STREAM_HWM）：沿用系统默认',
        retained: ''
    },
    {
        key: 'outboundIdleTimeout',
        label: '出站连接空闲超时（SYNC_OUTBOUND_IDLE_TIMEOUT）：不设超时',
        retained: ''
    },
    {
        key: 'datagramGuards',
        label: '数据报通道的每连接令牌桶（UDP_QUERY_LIMIT）／在途上限（SYNC_DOH_MAX_INFLIGHT）／结构校验（isWellFormedQuery）',
        // 空闲回收不属于这一项的"停用"范围，但必须写出来：
        //
        // 数据报通道没有出站连接，它的僵尸此前**一个定时器都没有**，
        // 实测 200s 后仍不回落（报告 N2）。补上的空闲回收用的是
        // SYNC_OUTBOUND_IDLE_TIMEOUT——名字里虽有"出站"二字，那是给 TCP
        // 中继用的；对这条通道而言它就是"通道空闲多久算废弃"的那把尺子。
        //
        // 它是资源回收而非策略差异，因此等价模式下同样生效：僵尸占额度
        // 导致新连接 503，本身就是"网页打不开"的成因之一。
        retained: 'port=53 判定仍生效（与参考一致，且按字面量 53 而非 SYNC_UDP_PORT）；'
            + '通道空闲回收仍生效（该路径无出站连接可依托，不回收即永久占额）'
    },
    {
        key: 'maxPayload',
        label: '入站单消息上限（SYNC_MAX_PAYLOAD 1MB）：提到 100MB（传输层默认量级）',
        retained: ''
    },
    {
        key: 'invalidCooldown',
        label: '非法批次的来源连坐冷却（INVALID_COOLDOWN 期间全部新建连接被 429）',
        retained: '仍计数、仍记日志，只是不再据此拒绝连接'
    },
    {
        key: 'firstBatchTimeout',
        label: '首包超时（SYNC_FIRST_BATCH_TIMEOUT 30s）',
        retained: '放宽到 300s 而非关闭：保留"回收废弃连接"这条性质，'
            + '同时让它在任何现实的首包延迟下都不可能被触发（见 config.js 的取值理由）'
    }
];

// 逐项展开成"第 N 项 —— 说明（保留：…）"的形态。
//
// 启动日志与诊断端点共用这一份展开结果，因此两处对同一项的表述
// 不可能漂移。
function itemLines() {
    return COMPAT_ITEMS.map((item, index) => {
        const base = (index + 1) + '. ' + item.key + ' —— ' + item.label;
        return item.retained ? base + '（保留：' + item.retained + '）' : base;
    });
}

/**
 * 当前等价模式的状态（供 /_diag/channel 读取）。
 *
 * @returns {{
 *   enabled: boolean,
 *   bypassedCount: number,
 *   bypassed: string[],
 *   items: Object<string, string>,
 *   effective: {maxPayload: number, firstBatchTimeout: number, udpPort: number}
 * }} 每项的状态为 'bypassed'（等价模式下已绕过）或 'active'（正常生效）
 */
function describeCompat() {
    const items = {};
    for (const item of COMPAT_ITEMS) {
        items[item.key] = ENABLED ? 'bypassed' : 'active';
    }
    return {
        enabled: ENABLED,
        bypassedCount: ENABLED ? COMPAT_ITEMS.length : 0,
        bypassed: ENABLED ? COMPAT_ITEMS.map((item) => item.key) : [],
        items: items,
        effective: {
            maxPayload: CONFIG.SYNC_MAX_PAYLOAD,
            firstBatchTimeout: CONFIG.SYNC_FIRST_BATCH_TIMEOUT,
            udpPort: ENABLED ? COMPAT_UDP_PORT : CONFIG.SYNC_UDP_PORT
        }
    };
}

// 启动宣告是否已打出。
//
// attachSync 在 fork 模式下只被网关进程调用一次，但 serverless 适配层
// 与单进程模式各自也会调用；同一份清单刷两遍只会淹没日志，而它要传的
// 是"当前进程处于什么形态"这一条事实，打一次就够。
let announced = false;

// 启动时以 WARN 级别宣告。
//
// 级别取 warn 而不是 info：默认 LOG_LEVEL=warn 下 info 不落盘，而这条
// 恰恰是"部署到底生效了没有"的唯一现场凭据——用户改完环境变量重启，
// 第一眼要能在生产日志里看到它。逐条列出而不是只报数量，是为了让人
// 能逐项核对"我理解的停用范围"与"实际停用的"是否一致。
//
// 日志不含任何域名 / IP：容器 stdout 常被平台采集，本模块也不持有
// 任何连接级状态，没有可落的用户访问信息。
function announceCompat() {
    if (!ENABLED || announced) return;
    announced = true;

    logger.warn('SYNC_COMPAT_MODE=1：数据面已切换为参考等价形态，以下 '
        + COMPAT_ITEMS.length + ' 项防护已停用', {
        compatMode: true,
        disabledCount: COMPAT_ITEMS.length,
        disabledKeys: COMPAT_ITEMS.map((item) => item.key),
        disabled: itemLines()
    });
}

module.exports = {
    enabled: ENABLED,
    COMPAT_UDP_PORT,
    COMPAT_ITEMS,
    describeCompat,
    announceCompat
};
