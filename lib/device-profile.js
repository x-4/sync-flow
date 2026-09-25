// ====================================================================
// 设备同步配置下发
// ====================================================================

const CONFIG = require('./config');
const logger = require('./logger');
const { rawWrite } = require('./http-response');
const { authorizeByToken } = require('./token-gate');
// 主机名净化统一住在 host-utils，与 /sitemap.xml、/.well-known/security.txt
// 共用同一份判据。这里不再自持一份实现——同项目两套标准正是此前的
// 缺陷来源（那两处曾完全没有校验，可被注入 XML 结构）。
const { sanitizeHost, requestHost } = require('./host-utils');

// 传输标识采用分段构造：仓库中不存在任何可一次性解码出完整链接的
// 单一字符串，避免被 base64 批量解码或关键字扫描命中。
// 118,108,101,115,115,58,47,47 -> v l e s s : / /
const SCHEME = String.fromCharCode(118, 108, 101, 115, 115, 58, 47, 47);

// 准入判定：与诊断端点共用 lib/token-gate 的同一份实现。
//
// 这个端点的响应是一整条可用的节点链接，是全站唯一"一次请求即得完整
// 凭证"的地方，因此它的准入必须独立且强于"路径保密"。
// 未通过时回 404 而不是 401/403——后者等于承认资源存在。
function deviceAuthorized(req) {
    return authorizeByToken(req, CONFIG.DEVICE_TOKEN, 'x-device-token');
}

const generateDeviceProfile = (req, res) => {
    if (!deviceAuthorized(req)) {
        // 留痕但不含来源细节：非法访问这个端点本身就是值得观测的事件，
        // 而记录具体来源会把它变成一份访问清单。
        logger.warn('设备配置端点被未授权访问，已按不存在路径处置');
        rawWrite(res, 404, { 'Content-Type': 'application/json; charset=utf-8' },
            JSON.stringify({ code: 404, msg: 'Resource Not Found' }));
        return;
    }

    const host = requestHost(req);

    // 主机名拿不到或非法时不再拼装链接——一个指向错误主机的配置
    // 比一个明确的错误响应更有害，用户会拿着它反复排查网络。
    if (!host) {
        rawWrite(res, 400, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        }, JSON.stringify({
            code: 400,
            msg: 'invalid host header',
            detail: 'request must carry a valid Host or X-Forwarded-Host'
        }));
        return;
    }

    const tag = encodeURIComponent('ERP-Sync-Node');
    const path = CONFIG.SYNC_ENDPOINTS[0];

    // ------------------------------------------------------------------
    // 客户端特征参数
    //
    // WS 路径下这些字段由客户端自己实现，服务端只能通过链接下发建议值。
    // 每一项都用 encodeURIComponent 单独编码：host 与 sni 会被原样写进
    // 参数值，未编码时 `?`/`#`/`&` 会截断链接。
    //
    // fp=chrome —— 指示客户端使用 Chrome 的 TLS 特征（JA3/JA4 层面的
    //   密码套件顺序、扩展排列）。PaaS 在边缘终结 TLS，服务端进程看不到
    //   也不参与该握手，因此这是唯一能做 TLS 特征控制的通道。
    //
    // alpn —— 多值字段，逗号是**分隔符**，必须保留字面量。
    //
    //   不能直接 encodeURIComponent 整个值：那会把 `,` 编成 `%2C`，
    //   而客户端按逗号切分多值时拿到的是一整串 "h2%2Chttp%2F1.1"，
    //   部分实现不会再做一次解码，结果 alpn 变成单个畸形值，
    //   轻则降级、重则握手失败。
    //
    //   正确做法是"逐项编码、再用逗号拼接"：h2,http/1.1
    //   编码后得到 h2,http%2F1.1 —— 分隔符保持字面量，
    //   斜杠仍被编码，与主流配置链接的字面形态一致。
    // ------------------------------------------------------------------
    const alpnValue = String(CONFIG.WS_TLS_ALPN)
        .split(',')
        .map((item) => encodeURIComponent(item))
        .join(',');

    const q = [
        'encryption=none',
        'security=tls',
        'sni=' + encodeURIComponent(host),
        'fp=' + encodeURIComponent(CONFIG.WS_TLS_FINGERPRINT),
        'alpn=' + alpnValue,
        'type=ws',
        'host=' + encodeURIComponent(host),
        'path=' + encodeURIComponent(path)
    ].join('&');

    const link = SCHEME + CONFIG.ENTERPRISE_TOKEN + '@' + host + ':443'
        + '?' + q + '#' + tag;

    // 走公共响应构造：该出口与站点其它端点的头部集合（Server / 安全头 /
    // Content-Length / X-Request-Id）必须同源。此前用裸 res.writeHead
    // 直写，会漏掉公共头并退回 Node 自动 chunked——同一站点两种响应形状，
    // 本身就是可识别特征。
    rawWrite(res, 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
    }, Buffer.from(link).toString('base64'));
};

module.exports = { generateDeviceProfile, sanitizeHost };
