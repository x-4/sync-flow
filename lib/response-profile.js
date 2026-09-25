// ====================================================================
// 响应外观配置
//
// HTTP 请求层与 upgrade 回退层各自拼装响应，但对外呈现的头部集合
// 必须同源：一旦两边各自手写，很容易在后续维护中漂移成
// "HTTP 404 有某头、socket 404 没有"的可对比差异。
// 因此头部集合统一定义在此，两边都从这里取。
//
// 这里把头部集合**按响应类型**拆成两组，而不是一套头全局下发：
//
//   1) 文档类响应（HTML / JSON / 文本 / 错误页）——完整安全策略头。
//   2) 协议升级响应（101 Switching Protocols）——只保留与协议本身
//      相关的头，不带文档类的安全策略。
//
// 为什么必须分组：
//   Content-Security-Policy / X-Frame-Options / Permissions-Policy /
//   Strict-Transport-Security 都是**面向文档渲染**的指令，对一条已
//   切换为帧协议的连接没有任何语义。真实的 nginx 反代在做 WS 升级时
//   只回 Upgrade / Connection / Sec-WebSocket-Accept / Server / Date
//   这五个头，不会附带 CSP。在 101 上带 CSP，等于把"这些头是中间件
//   无差别套到所有响应上"这件事写在脸上——而真实反代的 add_header
//   是按 location 生效的，数据面升级路径拿不到文档 location 的配置。
//
//   同时要保住的部分：Server 与 Date 仍然要给（一个自称 nginx 的
//   站点其 101 响应没有这两个头才是更大的破绽）。
//
//   X-Content-Type-Options 刻意**不**给：nginx 的 add_header 默认只对
//   200/201/204/206/301/302/303/304/307/308 生效（要无条件下发须显式
//   加 always），101 不在这个集合里，真实反代不会在升级响应上带它。
//   而且 nosniff 约束的是"浏览器不要猜 Content-Type"，对一条已切换为
//   帧协议的连接没有任何作用。加了不会更安全，只会多出一条与真实
//   nginx 不一致的差异。
// ====================================================================

// 文档类响应专用的安全策略头。这些头只在"响应体会被浏览器当作文档
// 渲染"时才有意义。
const DOCUMENT_HEADERS = {
    // 页面不允许被第三方站点内嵌为 iframe
    'X-Frame-Options': 'SAMEORIGIN',
    // 页面资源全部同源加载；样式需允许内联（看板的行内字号微调）
    'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        + "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
        + "base-uri 'self'; form-action 'self'",
    // 浏览器能力裁剪：业务页面用不到摄像头/麦克风/定位
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    // 平台在前端终结 TLS；该头经 HTTPS 响应传递给浏览器后强制后续走加密通道
    'Strict-Transport-Security': 'max-age=31536000'
};

// 升级响应（101）专用的头。只保留与协议升级本身相关、
// 且真实反代确实会在全局层下发的项。
const UPGRADE_HEADERS = {
    // 引用来源只带 origin，避免内部路径经 Referer 泄露
    'Referrer-Policy': 'strict-origin-when-cross-origin'
};

// 兼容旧引用：默认（文档类）头部集合
const SECURITY_HEADERS = DOCUMENT_HEADERS;

module.exports = { DOCUMENT_HEADERS, UPGRADE_HEADERS, SECURITY_HEADERS };
