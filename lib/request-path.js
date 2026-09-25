// ====================================================================
// 请求路径解析（HTTP 层与 upgrade 层共用）
//
// 背景：`new URL(req.url, 'http://' + req.headers.host)` 是 Node 里
// 解析请求路径的常见写法，但 Host 是**客户端完全可控**的字段。
// 一旦 Host 含空格、空串或方括号等非法字符，构造函数会抛
// `TypeError: Invalid URL`。
//
// 这个异常发生在两种极其不利的位置：
//   - HTTP 请求处理器内：没有被 try/catch 覆盖时，异常冒泡到事件循环，
//     触发 **进程级 uncaughtException，整个网关进程退出**。
//     实测：单个 `Host: bad host` 请求即可打崩服务（远程 DoS）。
//   - upgrade 事件回调内：HTTP 层不会捕获，socket 会停在
//     "已连接但不响应" 状态直到客户端超时，白占一个 fd。
//
// 因此路径解析必须做到"绝不因 Host 畸形而抛异常"：优先用 Host 解析
// 完整 URL；失败则退回只解析 path；再失败则做纯字符串截断。
// ====================================================================

/**
 * 从请求中安全地取出路径名（pathname）。
 * 任何输入都不会抛异常——最坏情况返回 '/'。
 *
 * @param {{url?: string, headers?: Record<string, string|string[]|undefined>}} request
 * @returns {string} 以 '/' 开头的路径名
 */
function requestPathname(request) {
    const raw = (request && request.url) || '/';
    const host = request && request.headers && request.headers.host;

    if (host) {
        try {
            return new URL(raw, 'http://' + host).pathname;
        } catch (_) {
            // Host 畸形（含非法字符、超长等）时退回到固定基址解析。
            // 这里**刻意不记日志**：畸形 Host 是扫描器的常态输入，
            // 逐条记录等于把日志变成攻击者的放大器（一条请求一行日志）。
            // 真正需要观测的是"解析结果"，由下游的路由决策负责。
        }
    }

    try {
        // 相对路径：以固定基址解析，只看 pathname
        return new URL(raw, 'http://placeholder.invalid').pathname;
    } catch (_) {
        // 连 request.url 都畸形：取其第一个 '?' 之前、并确保以 '/' 开头。
        // 同上，不记日志——这是最后一道兜底，结果必然是一个安全的路径。
        const cut = String(raw).split('?')[0].split('#')[0];
        return cut.startsWith('/') ? cut : '/';
    }
}

module.exports = { requestPathname };
