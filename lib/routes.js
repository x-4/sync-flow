// ====================================================================
// 路由决策层（纯函数 + 路由表）
//
// 本模块只回答一个问题：「这条路径 + 这个方法，应该得到什么响应」。
// 它**不接触** req / res / socket，也不执行任何业务逻辑。
//
// 之所以独立成模块：这条判定必须被两个消费方**完全相同**地复用——
//   1) HTTP 层（lib/gateway.js 的 createRequestHandler）
//   2) upgrade 回退层（lib/sync/fallback.js 的 httpLayerFallback）
// 只要两处共用同一份判定，"对同一路径发 GET 与发 Upgrade"就不可能
// 在状态码 / Content-Type / 正文三方面分叉，观察方也就无法据此
// 判断哪些路径支持升级。
//
// 在此之前这段代码住在 gateway.js 里，导致 gateway ↔ sync-core 互相
// require（sync-core 为拿 resolveRoute 而在函数内延迟 require('./gateway')）。
// 抽成零反向依赖的独立模块后，循环消失，两个消费方都变成单向引用。
//
// 返回描述对象的形式：
//   { kind: 'static', status, contentType, body, headers }  -> 固定正文
//   { kind: 'handler', handler }                            -> 需执行处理器
//
// 之所以只对"固定正文"分支建模：它们正是回退层能够等价复现的部分。
// 需要执行真实处理器（读快照、渲染页面）的分支在回退层不重放——
// 在裸 socket 上跑业务逻辑既无必要也有风险。
// ====================================================================

const { buildErrorHtml } = require('./error-pages');

// ====================================================================
// 路由表
// 每项: { method, path, handler }
// 同一路径可注册多个方法，框架据此自动推导 Allow 列表。
// ====================================================================

const ROUTES = [];

function route(method, path, handler) {
    ROUTES.push({ method, path, handler });
}

// ====================================================================
// 共享响应常量
//
// 这几段文案被**多处**使用（HTTP 层与回退层、route() 注册的处理器与
// resolveRoute 的判定），因此必须只有一份定义。此前 426 的正文在
// gateway.js 里写了两份、sync-core.js 里还留着一份占位文案，三者
// 各写各的——本次抽取正是为了消除这类漂移。
// ====================================================================

const API_404 = { code: 404, msg: 'Resource Not Found' };
const API_405 = { code: 405, msg: 'Method Not Allowed' };

// 回退层对"真实存在但不在同步端点池内"的路径给出的响应。
//
// 选 405 而非 200 的理由：这些路由只注册了 GET，用升级的方式访问它们
// 对 HTTP 语义而言就是方法不被支持，与真实站点的行为一致。
//
// 历史教训（务必保留这个选择）：这里曾经返回一段固定的**占位 JSON**
// （{"code":0,"msg":"ok","note":"use subscription protocol..."}），
// 而普通 GET 返回真实业务数据。两者状态码同为 200、正文却完全不同
// （实测 Content-Length 70 vs 72）——这比状态码差异更隐蔽，观察方
// 只需发一次 GET 和一次 Upgrade 比对正文即可确认该路径"另有玄机"。
const HANDLER_FALLBACK_RESPONSE = {
    status: 405,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(API_405),
    headers: { Allow: 'GET' }
};

// ====================================================================
// 路由决策
// ====================================================================

function resolveRoute(pathname, method) {
    const pathRoutes = ROUTES.filter((r) => r.path === pathname);

    // 路径不存在：/api/ 下回 JSON，其余回品牌一致的 HTML 404 页
    if (pathRoutes.length === 0) {
        const isApi = pathname.startsWith('/api/');
        return {
            kind: 'static',
            status: 404,
            contentType: isApi ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
            body: isApi ? JSON.stringify(API_404) : notFoundHtml()
        };
    }

    const allowed = [...new Set(pathRoutes.map((r) => r.method))];

    // OPTIONS：回允许的方法，这是真实服务的标准行为
    if (method === 'OPTIONS') {
        return { kind: 'static', status: 204, contentType: null, body: '', headers: { Allow: allowed.join(', ') } };
    }

    // HEAD 复用 GET 的处理逻辑；响应体会由 Node 在传输层自动丢弃
    const effective = method === 'HEAD' ? 'GET' : method;

    if (!allowed.includes(effective)) {
        const isApi = pathname.startsWith('/api/');
        return {
            kind: 'static',
            status: 405,
            contentType: isApi ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
            body: isApi ? JSON.stringify(API_405) : methodNotAllowedHtml(allowed),
            headers: { Allow: allowed.join(', ') }
        };
    }

    const matched = pathRoutes.find((r) => r.method === effective);

    // 同步端点池内的路径**刻意不注册**进路由表，因此会走到上面的
    // 404 分支，与任意不存在路径逐字一致。
    //
    // 这里曾经为它们返回 426 Upgrade Required（RFC 9110 §15.5.6 为此
    // 语义设计的状态码）。语义正确，但伪装上是彻底失败的：
    // 状态行、Upgrade / Connection 响应头、正文里的 "protocol":"websocket"
    // 三处同时宣告"这里有个 WebSocket 端点"，而全站只有这三条路径如此。
    // 探测者遍历路径发一次 GET 即可定位，**不需要构造握手、不需要任何
    // 凭证、不需要知道令牌**。
    //
    // 改为 404 后，"找出端点"的成本从一次 curl 抬高到"必须构造一个
    // 合法 WS 握手并猜中路径"。而到了那一步，即便猜中，拿到的也
    // 只是一个 101——与任意真实的 WebSocket 业务端点无从区分
    // （首包校验失败的处置见 relay.js，那边同样不给确定性证据）。
    //
    // 功能不受影响：升级请求不走 resolveRoute，而是由
    // sync/index.js 的 handleUpgradeRequest 按 SYNC_ENDPOINTS 单独判定。
    // 同源性也不受影响：回退层只对**池外**路径生效。
    return { kind: 'handler', handler: matched.handler, pathname, method };
}

// HTML 片段供 resolveRoute 与错误页共用（保持同一站点外观）。
// 复用 error-pages 的渲染壳，避免出现第二套 404 页面。
function notFoundHtml() {
    return buildErrorHtml(404, {
        code: '404',
        heading: '页面不存在',
        lines: [
            '您访问的地址不存在或已被移除。',
            '请检查链接是否正确，或返回系统首页继续操作。'
        ],
        actions: [
            { label: '返回首页', href: '/' },
            { label: '查看最新报表', href: '/api/v2/inventory/reports/latest', ghost: true }
        ]
    });
}

function methodNotAllowedHtml(allowed) {
    return buildErrorHtml(405, {
        code: '405',
        heading: '请求方法不被允许',
        lines: [
            '该地址不支持当前使用的请求方法。',
            '允许的方法：<code>' + allowed.join(', ') + '</code>'
        ],
        actions: [{ label: '返回首页', href: '/' }]
    });
}

module.exports = {
    ROUTES,
    route,
    resolveRoute,
    // 供 gateway 的处理器与回退层复用，避免各自重写文案
    HANDLER_FALLBACK_RESPONSE,
    API_404,
    API_405
};
