// ====================================================================
// HTTP 响应构造（单一实现）
//
// 本模块是**所有** HTTP 响应的唯一构造点，同时服务两条代码路径：
//   1) 正常的 Node http 请求处理器（gateway.js）—— 通过 respond()/sendPage()
//      交给 Node 的 res 对象写出；
//   2) upgrade 被拒后的回退层（sync-core.js 的 httpLayerFallback）——
//      此时 socket 没有 http.ServerResponse，必须手工序列化，走
//      serializeResponse() + writeSerialized()。
//
// 两条路径若各自手写头部，就会漂移成
// "HTTP 404 有 Vary、socket 404 没有" 这类可对比的特征。
// 因此这里把头部集合、压缩协商、ETag 三层逻辑收敛到一处，
// 让"走哪条代码路径"在响应外观上不可区分。
//
// 注意：本模块只负责**响应外观**，不参与路由决策。
// 状态码/正文由 gateway.resolveRoute() 决定后传入。
// ====================================================================

const crypto = require('crypto');
const zlib = require('zlib');
const CONFIG = require('./config');
const { DOCUMENT_HEADERS } = require('./response-profile');

// ====================================================================
// 公共头部集合
//
// 注意这里是**文档类响应**的头部集合（HTML / JSON / 文本 / 错误页）。
// 101 升级响应走另一套（见 response-profile 的 UPGRADE_HEADERS）——
// 文档类安全策略头对帧协议连接没有语义。
// ====================================================================

// 真实网关普遍带有的头部，缺失会显得像临时拼凑的服务。
// 返回有序键值对数组而非对象：两条写出路径（res.setHeader / 手工拼接）
// 都按同一顺序应用，避免顺序本身成为区分特征。
function commonHeaderEntries() {
    const entries = [
        ['X-Request-Id', crypto.randomBytes(8).toString('hex')],
        ['X-Content-Type-Options', 'nosniff']
    ];
    for (const [name, value] of Object.entries(DOCUMENT_HEADERS)) {
        entries.push([name, value]);
    }
    // 真实站点要么是反向代理，要么是框架自带 Server 头；
    // "完全没有 Server 头"本身就是一个可识别的特征。
    entries.push(['Server', CONFIG.SERVER_HEADER]);
    return entries;
}

// ====================================================================
// 压缩协商
//
// 真实站点普遍开启。只压缩超过阈值的文本类响应，二进制与短响应不动。
//
// Vary 语义（RFC 9110 §12.5.5）：只要表示形式**可能**随 Accept-Encoding
// 变化，就必须发 Vary——包括"这一次没压"的情况。发不发 Vary 只取决于
// 这个响应是否可能被压缩（可压缩类型 + 够长 + 开关打开），与本次请求头
// 无关。只在"真的压缩了"时补 Vary 是个常见错误：共享缓存会把同一条 URL
// 的压缩版与未压缩版混存，从而把 gzip 字节喂给没声明 gzip 的客户端。
// ====================================================================

const COMPRESSIBLE = /^(application\/(json|xml)|text\/|application\/javascript)/i;

// 该响应是否"可能"被压缩——决定是否必须带 Vary
function isVariantRoute(contentType, bodyLength) {
    return CONFIG.ENABLE_COMPRESSION &&
        bodyLength >= CONFIG.COMPRESSION_MIN_SIZE &&
        COMPRESSIBLE.test(contentType);
}

// 计算响应体与相关头。返回 { status, headers, payload }。
// 不接触 socket，因此可被两条路径共用。
function encodePayload(req, status, contentType, body, extraHeaders = {}) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const headers = {};

    if (isVariantRoute(contentType, payload.length)) {
        // 走到这里说明这个 URL 的表示形式依赖 Accept-Encoding，无论本次压不压都要声明
        headers['Vary'] = 'Accept-Encoding';
    }

    let out = payload;
    let encoding = null;
    if (headers.Vary) {
        // req 可能为 null —— clientError 路径拿不到完整的 request 对象
        // （连 method 都可能是 undefined），因此这里必须容忍缺失，
        // 退化行为是"不压缩"，正是我们要的保守选择。
        // 注意不能写成 `req.headers && ...`：req 为 null 时在读 .headers
        // 的那一刻就抛了，&& 根本没机会短路。
        const accepted = String((req && req.headers && req.headers['accept-encoding']) || '');
        if (/\bgzip\b/.test(accepted)) encoding = 'gzip';
        else if (/\bdeflate\b/.test(accepted)) encoding = 'deflate';
    }
    if (encoding === 'gzip') out = zlib.gzipSync(payload);
    else if (encoding === 'deflate') out = zlib.deflateSync(payload);

    Object.assign(headers, extraHeaders);
    // Content-Type 最后写入：它是本响应的事实陈述，不允许被 extraHeaders 覆盖。
    //
    // 只在有值时写入。无条件写入时，无正文的响应（如 204）会产出
    // `Content-Type: null` 这种字面量头值——真实站点不会这么发，
    // 而它比"干脆不发"显眼得多。目前只有 OPTIONS 分支的 contentType
    // 为空，且回退层不会以 OPTIONS 进入，因此这项是防御性加固，
    // 不改变现有行为。
    if (contentType) headers['Content-Type'] = contentType;
    // 定长响应。两条路径统一走 Content-Length 而非 chunked：
    // 回退层手工写 chunked 编码的风险更高，而定长是真实站点的常见形态。
    headers['Content-Length'] = String(out.length);
    if (encoding) headers['Content-Encoding'] = encoding;

    return { status, headers, payload: out, encoding };
}

// ETag 计算（RFC 9110 §8.8.1 的强校验器取值规则）
function computeETag(payload) {
    return '"' + crypto.createHash('sha1')
        .update(payload).digest('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) + '"';
}

// ====================================================================
// 路径一：交给 Node http.ServerResponse
// ====================================================================

// 写入响应。统一应用公共头部、压缩与 ETag。
function respond(req, res, status, contentType, body, opts = {}) {
    const { headers: extraHeaders = {}, etag = null } = opts;

    for (const [name, value] of commonHeaderEntries()) res.setHeader(name, value);

    const out = encodePayload(req, status, contentType, body, extraHeaders);

    if (etag && CONFIG.ENABLE_ETAG) {
        const tag = computeETag(out.payload);
        if (req.headers['if-none-match'] === tag) {
            res.writeHead(304, { ETag: tag, Server: CONFIG.SERVER_HEADER });
            return res.end();
        }
        out.headers.ETag = tag;
    }

    res.writeHead(out.status, out.headers);
    return res.end(req.method === 'HEAD' ? undefined : out.payload);
}

// HTML 页面出口，供给 dashboard 模块回填。
// 页面与应用接口走完全相同的压缩/协商逻辑，避免"页面明文、接口 gzip"
// 这种人一眼能看出是两套实现拼起来的分裂状态。
function sendPage(req, res, html, cacheControl) {
    const body = Buffer.from(html, 'utf8');
    return respond(req, res, 200, 'text/html; charset=utf-8', body, {
        headers: { 'Cache-Control': cacheControl || 'public, max-age=60' }
    });
}

// ====================================================================
// 路径二：手工序列化（upgrade 回退层用，没有 ServerResponse 可用）
// ====================================================================

// HTTP 状态码 -> 原因短语
const REASON_PHRASES = {
    200: 'OK',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    413: 'Payload Too Large',
    426: 'Upgrade Required',
    429: 'Too Many Requests',
    431: 'Request Header Fields Too Large',
    500: 'Internal Server Error',
    503: 'Service Unavailable'
};

// 纯函数：把一次响应描述转换成可写出的字节。
// 返回 { status, statusText, headers(有序数组), payload(Buffer) }。
// 不接触任何 socket，因此可被单测直接验证。
function serializeResponse(req, { status, contentType, body, extraHeaders = {}, method, cacheControl }) {
    const statusText = REASON_PHRASES[status] || 'Unknown';
    const headerPairs = [];

    // 公共头部：与 respond() 同源、同序
    for (const [name, value] of commonHeaderEntries()) headerPairs.push([name, value]);
    if (cacheControl) headerPairs.push(['Cache-Control', cacheControl]);

    // 与 respond() 共用同一套压缩协商，保证两条路径产出同一头部集合
    const out = encodePayload(req, status, contentType, body, extraHeaders);
    for (const [name, value] of Object.entries(out.headers)) headerPairs.push([name, value]);

    // Date 与 Connection: close —— 手工路径必须显式给出：
    // 没有 ServerResponse，Node 不会替我们补这两个头。
    headerPairs.push(['Date', new Date().toUTCString()]);
    headerPairs.push(['Connection', 'close']);

    // HEAD 只回头部，不回正文（RFC 9110 §9.3.2）。
    // Content-Length 保留为"GET 时会发送的长度"。
    const isHead = (method || (req && req.method)) === 'HEAD';
    const payload = isHead ? Buffer.alloc(0) : out.payload;

    const head = 'HTTP/1.1 ' + status + ' ' + statusText + '\r\n' +
        headerPairs.map(([n, v]) => n + ': ' + v).join('\r\n') + '\r\n\r\n';

    return {
        status,
        statusText,
        headers: headerPairs,
        payload,
        bytes: Buffer.concat([Buffer.from(head, 'latin1'), payload])
    };
}

// 把 serializeResponse() 的产物写给裸 socket 并收尾。
function writeSerialized(socket, serialized) {
    socket.write(serialized.bytes);
    socket.end();
}

// ====================================================================
// 公共写出助手：让"直写路径"（不走 respond 的 JSON / 文本 / 错误页）
// 也带上与 serializeResponse 完全一致的头部（含 Content-Length）。
//
// 这是本次修复的关键一环：HTTP 层若默认走 chunked（transfer-encoding），
// 而 upgrade 回退层只能写 Content-Length，两者会留下
// "有没有 transfer-encoding / 有没有 content-length" 的可对比差异。
// 统一为 Content-Length 后，两条路径的头部集合完全一致。
// ====================================================================

// 给 res 补齐公共头部 + Content-Length（若调用方未显式给）。
// vary: true 时补 `Vary: Accept-Encoding`——与 serializeResponse 的判据一致：
// 只要该响应"可能"被压缩就必须声明，与本次是否真的压缩无关。
// 返回 body 的 Buffer，便于调用方复用。
function applyCommon(res, status, contentType, body, extraHeaders = {}, vary = false) {
    for (const [name, value] of commonHeaderEntries()) {
        if (!res.hasHeader(name)) res.setHeader(name, value);
    }
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || '', 'utf8');
    for (const [name, value] of Object.entries(extraHeaders)) {
        if (!res.hasHeader(name)) res.setHeader(name, value);
    }
    if (vary && !res.hasHeader('Vary')) res.setHeader('Vary', 'Accept-Encoding');
    if (contentType && !res.hasHeader('Content-Type')) res.setHeader('Content-Type', contentType);
    // 显式定长：禁用 Node 的自动 chunked 编码，与回退层保持一致。
    // HEAD 保留"GET 时会发送的长度"（RFC 9110 §9.3.2），因此用 buf.length。
    if (status !== 204 && status !== 304 && !res.hasHeader('Content-Length')) {
        res.setHeader('Content-Length', String(buf.length));
    }
    return buf;
}

// JSON 出口（不走压缩）
const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload);
    applyCommon(res, status, 'application/json; charset=utf-8', body);
    res.writeHead(status);
    res.end(body);
};

// 其余直写出口（纯文本 / XML / 204）
const rawWrite = (res, status, headers = {}, body) => {
    const { 'Content-Type': ct, ...rest } = headers;
    const buf = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    applyCommon(res, status, ct, buf === null ? Buffer.alloc(0) : buf, rest);
    res.writeHead(status);
    res.end(body === undefined ? undefined : body);
};

// HTML 错误页/页面写出（不走压缩，带 no-store）。
// Vary 的判据与 serializeResponse 一致：错误页远大于压缩阈值，
// 因此必须声明 Accept-Encoding 变体——否则 HTTP 路径与回退路径会分叉。
const sendHtmlNoStore = (res, status, html) => {
    const len = Buffer.byteLength(html, 'utf8');
    const vary = isVariantRoute('text/html; charset=utf-8', len);
    const buf = applyCommon(res, status, 'text/html; charset=utf-8', html, { 'Cache-Control': 'no-store' }, vary);
    res.writeHead(status);
    res.end(buf);
};

module.exports = {
    commonHeaderEntries,
    isVariantRoute,
    encodePayload,
    computeETag,
    applyCommon,
    respond,
    sendPage,
    sendJson,
    rawWrite,
    sendHtmlNoStore,
    serializeResponse,
    writeSerialized,
    REASON_PHRASES
};
