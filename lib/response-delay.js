// ====================================================================
// 服务端处理延迟（HTTP 主链路与 upgrade 出口共用的唯一实现）
//
// ── 为什么把它从 gateway.js 里搬出来 ────────────────────────────
//
// 延迟原本只写在 lib/gateway.js 的 HTTP 请求处理器里。而 upgrade 的几条
// 非 101 出口（容量闸拒绝、回退层、静默拆链）住在 lib/sync/limits.js 与
// lib/sync/index.js，它们要拿到同一套延迟，只有两条路：
//
//   · 复制一份 —— 两边迟早漂移成两档不同的台阶。那比只有一档更像刻意：
//     一档是"后端慢"，两档是"后端慢，但这个口子格外快"，后者恰好把
//     这个口子标了出来；
//   · require gateway —— gateway 在加载期就 require 了 sync-core，
//     sync-core → sync/index → sync/limits → gateway 是一个环。环上
//     拿到的 exports 尚未填充完，属于本项目反复吃过的隐式顺序约定。
//
// 因此抽成独立模块：本文件只依赖 config，谁都可以安全地 require。
//
// 这是**搬动而不是改写**：系数、豁免清单、抖动公式与 gateway 里逐字相同，
// 判定只有一处。改值请改这里，两条链路会一起变——这正是要的效果。
//
// ── 为什么 upgrade 侧也必须延迟 ──────────────────────────────────
//
// 实测（12 次取中位数）：同一个进程里 HTTP 的 404 是 25ms、302 是 62ms，
// 而 upgrade 的三条出口全部是 0~1ms，差 25~60 倍。攻击者不需要任何凭据，
// 一次握手就能测出这道台阶——它是当时最强的**无令牌**指纹。
//
// 101 成功出口刻意**不加**延迟：正常握手必须保持快，给每条连接加 45ms
// 会实打实拖慢连接建立，而 101 本来就是"握手成功"这一件事的固有耗时。
// ====================================================================

const CONFIG = require('./config');

// 按资源类型分档：真实后端查库 + 渲染 + 校验会话要花几十毫秒，而"内存里
// 拼字符串"是亚毫秒级的。这个差异在逐次计时比对下是可测的，因此这里按
// 资源类型注入一段随机延迟，把响应耗时拉进真实区间。
//
// 实际延迟 = 基准 × 类型系数 × (1 + 0~0.9 抖动)。
//
// 带抖动而非定值：固定延迟本身就会成为一条新的可测特征——"每次都恰好
// 慢 50ms"比"有时快有时慢"更像刻意为之。真实后端的耗时本来就随负载波动。
const DELAY_FACTOR = {
    asset: 0.15,   // 静态资源通常命中缓存，最快
    api: 0.35,     // 应用接口要查一次数据
    page: 1.0      // 页面要查数据 + 渲染，最慢
};

// 探针路径不注入延迟：健康探针被拖慢会触发平台重启。
const DELAY_EXEMPT = new Set(['/health', '/api/status', '/healthz']);

function delayFactorFor(pathname) {
    if (pathname.startsWith('/assets/')) return DELAY_FACTOR.asset;
    if (pathname.startsWith('/api/')) return DELAY_FACTOR.api;
    return DELAY_FACTOR.page;
}

// 本次响应应当注入的延迟（毫秒）。返回 0 表示不注入：未配置延迟，
// 或该路径属于探针豁免清单。
function responseDelayMs(pathname) {
    if (CONFIG.RESPONSE_DELAY_MS <= 0) return 0;
    if (DELAY_EXEMPT.has(pathname)) return 0;
    return CONFIG.RESPONSE_DELAY_MS * delayFactorFor(pathname) * (1 + Math.random() * 0.9);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// —— 延迟后执行 fn：HTTP 之外的出口用这个形态 ——
//
// HTTP 主链路是 async 的，直接 await sleep() 即可；upgrade 的出口是同步
// 回调（往裸 socket 写、或直接 destroy），把处理器改成 async 是**不行**
// 的：调用方（如 wsClientError 钩子）用 try/catch 包着它，异步抛出会变成
// 未处理的 rejection，而 catch 里那句"回退层失败就拆链"的兜底永远不执行。
//
// 因此统一走定时器，并做两件必须做的小事：
//
//   · unref：这条定时器不该决定进程能否退出；
//   · 连接先关就取消：socket 已销毁时再写没有意义，而攒着一批定时器、
//     每个都持有 socket 引用，正是历史 P3-c 踩过的那类坑。
//
// 返回定时器句柄（无需延迟时为 null），调用方一般不必保存。
function afterDelay(pathname, socket, fn) {
    const ms = responseDelayMs(pathname);
    if (ms <= 0) { fn(); return null; }

    const timer = setTimeout(() => {
        detach();
        // 连接已经没了：写也写不进去，直接放弃。
        if (socket && socket.destroyed) return;
        fn();
    }, ms);
    if (timer.unref) timer.unref();

    function onClose() { clearTimeout(timer); }
    function detach() {
        if (socket && typeof socket.removeListener === 'function') {
            socket.removeListener('close', onClose);
        }
    }
    if (socket && typeof socket.once === 'function') socket.once('close', onClose);

    return timer;
}

module.exports = {
    DELAY_FACTOR,
    DELAY_EXEMPT,
    delayFactorFor,
    responseDelayMs,
    sleep,
    afterDelay
};
