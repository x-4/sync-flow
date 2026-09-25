// ====================================================================
// 请求主机名净化（HTTP 层共用）
//
// Host / X-Forwarded-Host 是**客户端完全可控**的输入。任何把它拼进
// 响应体（链接、URL 列表、邮件地址）的地方，都必须先过这里。
//
// 为什么必须净化——直接使用原始值有三类问题：
//   1. 结构注入：`evil.com</loc><loc>http://attacker/` 拼进 XML 会伪造
//      出额外的 <loc> 条目，可向搜索引擎投毒；拼进 HTML/文本则可能
//      逃逸引号。这类注入**不会**被 nosniff 拦住——它不是 XSS，
//      而是"响应体内容被攻击者改写"。
//   2. 畸形拼装：平台链路里 Host 常带端口（host:3000），拼出
//      "...@h:3000:443" 这种畸形串。
//   3. 代理链污染：逗号分隔的多级代理链只应取第一跳。
//
// 历史教训（务必保留这段说明）：本净化逻辑原先只存在于
// device-profile.js，而 /sitemap.xml 与 /.well-known/security.txt
// 各自手写了一份 `(x-forwarded-host || host).split(',')[0].trim()`，
// 完全没有字符集校验。同一项目里两套标准，正是缺陷的来源。
// 现在收敛到这个模块，三处共用同一份判据。
// ====================================================================

// 主机名字符集白名单。
// 逐标签校验（label）：每段 1-63 字符，只允许字母/数字/连字符，
// 且不得以连字符开头或结尾（RFC 1123 §2.1）。
// 总长上限 253 是 DNS 的公开约束。
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * 净化一个主机名。任何非法输入一律返回空串，由调用方决定回落行为
 * （绝不要把原始值当兜底用回去——那等于净化白做）。
 *
 * @param {unknown} raw 原始 Host / X-Forwarded-Host 头值
 * @returns {string} 合法主机名，或空串表示不可用
 */
function sanitizeHost(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return '';

    // 多级代理链只取第一跳（最靠近客户端的那一跳才是真实来源）
    const first = raw.split(',')[0].trim();

    // 剥端口。IPv6 字面量是 [::1]:443 形式，这里不展开，直接判非法回落——
    // 平台对外暴露的主机名不会是 IPv6 字面量。
    const host = first.replace(/:\d+$/, '');

    if (host.length === 0) return '';
    if (IPV4_RE.test(host) || HOST_RE.test(host)) return host;

    return '';
}

/**
 * 从请求头里取出并净化主机名。等价于 sanitizeHost(host || x-forwarded-host)。
 *
 * @param {{headers?: Record<string, string|string[]|undefined>}} request
 * @returns {string} 合法主机名，或空串
 */
function requestHost(request) {
    const headers = (request && request.headers) || {};
    return sanitizeHost(headers['x-forwarded-host'] || headers.host || '');
}

module.exports = { sanitizeHost, requestHost, HOST_RE, IPV4_RE };
