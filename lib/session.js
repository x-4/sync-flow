// ====================================================================
// 业务会话（登录态）
//
// 存在的理由只有一个：让站点**看起来像一个真的企业系统**。
// 真实的企业库存系统不可能"打开首页就能看到全部库存数据"——
// 没有登录页、没有会话 Cookie，是人工审查时最先露馅的地方。
//
// 这条链路与代理通道**完全无关**：
//   · 升级请求走 'upgrade' 事件，不经过 HTTP 请求处理器，不受登录影响；
//   · 同步通道的凭证是配置里的令牌，不是这里的 Cookie。
// 因此本模块的任何变更都不会影响客户端连通性。
//
// 会话令牌是自包含的 HMAC 签名串，不依赖任何存储：
// Serverless 实例之间没有共享内存，落地存储反而会引入一致性问题。
// ====================================================================

const crypto = require('crypto');
const CONFIG = require('./config');

const COOKIE_NAME = 'erp_session';
const COOKIE_VERSION = 'v1';

// 签名密钥从配置里的租户令牌派生，不占用新的环境变量。
// 派生时加了域分隔后缀：同一个秘密不应在多个用途间直接复用。
let _key = null;
function signingKey() {
    if (_key) return _key;
    _key = crypto.createHash('sha256')
        .update(CONFIG.ENTERPRISE_TOKEN + '\n' + 'session-signing-v1')
        .digest();
    return _key;
}

const b64url = (buf) => buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fromB64url(s) {
    try {
        return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    } catch (_) {
        return null;
    }
}

function sign(payloadText) {
    return b64url(crypto.createHmac('sha256', signingKey()).update(payloadText).digest());
}

// 用户名只做**收敛**，不做放行判断。
// 它会被写进 Cookie 与日志：不收敛的话，一个换行就能往 Set-Cookie
// 里注入第二个属性，往结构化日志里塞进伪造字段。
function normalizeUsername(raw) {
    const s = String(raw || '').trim();
    // 只保留企业账号常见字符集，并限制长度（防 Cookie 膨胀）
    return s.replace(/[^A-Za-z0-9._@-]/g, '').slice(0, 64);
}

// 签发一个会话令牌。
function issue(username) {
    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
        u: normalizeUsername(username),
        iat: now,
        exp: now + CONFIG.SESSION_TTL_SEC
    });
    return COOKIE_VERSION + '.' + b64url(Buffer.from(payload, 'utf8')) + '.' + sign(payload);
}

// 校验会话令牌。返回载荷对象，任何一项不通过都返回 null。
function verify(token) {
    if (typeof token !== 'string' || token.length === 0) return null;

    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== COOKIE_VERSION) return null;

    const payloadBuf = fromB64url(parts[1]);
    if (!payloadBuf || payloadBuf.length === 0) return null;

    const payloadText = payloadBuf.toString('utf8');
    const expected = sign(payloadText);

    // 长度不等时提前返回是安全的：HMAC 摘要定长（32 字节 → 43 字符），
    // 长度不是秘密，泄露它不减少搜索空间。
    if (expected.length !== parts[2].length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(parts[2], 'utf8'))) {
        return null;
    }

    let payload;
    try {
        payload = JSON.parse(payloadText);
    } catch (_) {
        return null;
    }
    if (!payload || typeof payload.exp !== 'number') return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;

    return payload;
}

// 解析 Cookie 头。重复同名 Cookie 以第一个为准——真实浏览器的行为，
// 也让"塞两个同名 Cookie 试探哪个生效"没有可乘之机。
function parseCookies(req) {
    const raw = (req && req.headers && req.headers.cookie) || '';
    const jar = {};
    for (const part of raw.split(';')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const k = part.slice(0, eq).trim();
        if (k && !(k in jar)) jar[k] = part.slice(eq + 1).trim();
    }
    return jar;
}

// 读取当前请求的会话。未登录返回 null。
function readSession(req) {
    return verify(parseCookies(req)[COOKIE_NAME]);
}

// 过期时间必须写在 Max-Age 与 Expires 两处：
// 只写 Max-Age 时，部分旧客户端（以及某些中间设备）会按会话 Cookie
// 处理，表现为"关掉浏览器就得重新登录"——真实企业系统的会话通常
// 是持久的。
function buildCookie(token, secure) {
    const attrs = [
        COOKIE_NAME + '=' + token,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=' + CONFIG.SESSION_TTL_SEC,
        'Expires=' + new Date(Date.now() + CONFIG.SESSION_TTL_SEC * 1000).toUTCString()
    ];
    // Secure 只在确认处于 HTTPS 后附加。
    // 无条件附加会让本地 http 访问拿不到 Cookie（浏览器直接丢弃），
    // 表现为"登录成功但一跳回首页又回到登录页"，而服务端日志一切正常
    // ——正是本项目反复吃过亏的那类静默失效。
    if (secure) attrs.push('Secure');
    return attrs.join('; ');
}

// 登出：同名 Cookie + 立即过期。Max-Age=0 是标准做法，
// 只靠 Expires 写过去时间对部分客户端无效。
function buildClearCookie(secure) {
    const attrs = [
        COOKIE_NAME + '=',
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=0',
        'Expires=' + new Date(0).toUTCString()
    ];
    if (secure) attrs.push('Secure');
    return attrs.join('; ');
}

// 取当前请求的登录用户名（未登录为空串）。
//
// 载荷里的字段名是模块内部细节：让调用方直接写 s.u，等于把一个
// 内部约定散落到每个调用点——哪天要加字段就再也改不动了。
// 页面只需要"显示谁在登录"这一件事，就只给它这一个入口。
function sessionUser(req) {
    const s = readSession(req);
    return (s && typeof s.u === 'string') ? s.u : '';
}

// 是否处于 HTTPS 之下。平台在边缘终结 TLS，进程内只能看转发头。
function isSecureRequest(req) {
    const proto = (req && req.headers && req.headers['x-forwarded-proto']) || '';
    if (proto) return proto.split(',')[0].trim().toLowerCase() === 'https';
    return !!(req && req.socket && req.socket.encrypted);
}

module.exports = {
    COOKIE_NAME,
    issue,
    verify,
    readSession,
    buildCookie,
    buildClearCookie,
    isSecureRequest,
    normalizeUsername,
    sessionUser
};
