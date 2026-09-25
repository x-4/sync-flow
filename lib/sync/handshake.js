// ====================================================================
// 握手协议外观收敛
//
// 背景：厂商库在握手校验失败时，会自己回一段**库英文串**的响应
// （如 "Missing or invalid Sec-WebSocket-Key header"）+ text/html，
// 且不带任何安全头。在一个中文企业站上，这是一处极强的特征：
// 既能被关键词匹配命中，又能直接对应到具体实现的报错文案。
//
// 处理分两层：
//   1) 应用层**前置校验**（主路径）：在调用 handleUpgrade 之前，
//      用与库**逐条一致**的判据自己校验。任一不合法即按普通 HTTP 请求
//      处置（见 index.js 的 httpLayerFallback），库根本不会被调用，
//      因此永远不会吐出它的串。
//   2) wsClientError 钩子（安全网，见 index.js）：库内还有若干 abort
//      分支（如将来的 subprotocol / 扩展协商），一旦触发会 emit 该事件。
//      存在监听时库**不再自行 abort**，因此监听内必须写出响应并关闭，
//      否则客户端会挂住（违反"客户端必须始终可连"）。
//
// ── 为什么本模块不再自带"拒绝怎么写" ──────────────────────────
//
// 曾经这里有一个 refuseHandshake()，回 400 + 业务化 JSON。它解决了
// "不吐库英文串"的问题，却引入一个更隐蔽的分叉：对池内路径发非法
// 握手得 400，对池外路径（如 stock）发同样的请求得 405/200。探测者
// 不必构造合法握手、不必知道令牌，只要发一个畸形 Upgrade 比对状态码
// 就能圈出端点池。
//
// 现在两处都交给 httpLayerFallback：它复用 routes.resolveRoute 的同一
// 份判定，而池内路径刻意未注册进路由表，于是非法握手回 404——与任意
// 不存在路径逐字一致。要区分端点池，就必须构造一个完全合法的握手。
//
// 本模块因此只保留"判据"，不持有通道实例，可被独立测试。
// ====================================================================

// 与 vendor 库逐字一致的关键字校验规则（见 channel-hub.js 顶部 keyRegex）。
// 保持一致是刻意的：判据一旦比库更严格，就会把合法客户端挡在门外。
const HANDSHAKE_KEY_RE = /^[+/0-9A-Za-z]{22}==$/;

// 校验升级请求是否构成一个合法的 WebSocket 握手。
// 返回 null 表示合法；否则返回一个描述拒绝原因的对象。
// 判据与通道库 handleUpgrade 中的四条检查逐条对应（method / Upgrade / Key / Version）。
function inspectHandshake(request) {
    if (request.method !== 'GET') {
        return { status: 405, reason: 'Method Not Allowed' };
    }
    const upgrade = request.headers.upgrade;
    if (upgrade === undefined || upgrade.toLowerCase() !== 'websocket') {
        return { status: 400, reason: 'Bad Request' };
    }
    const key = request.headers['sec-websocket-key'];
    if (key === undefined || !HANDSHAKE_KEY_RE.test(key)) {
        return { status: 400, reason: 'Bad Request' };
    }
    const version = Number(request.headers['sec-websocket-version']);
    // 只有 13 是当前的正式版本。库额外接受 8（历史草案），
    // 这构成一处可精确匹配的实现特征，因此在应用层只放行 13。
    if (version !== 13) {
        return {
            status: 400,
            reason: 'Bad Request',
            extraHeaders: { 'Sec-WebSocket-Version': '13' }
        };
    }
    return null;
}

module.exports = { HANDSHAKE_KEY_RE, inspectHandshake };
