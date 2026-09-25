// ====================================================================
// 企业网关（HTTP 业务表面）
//
// 库存数据来自缓存进程，报表来自报表进程——这些是真实运行的业务进程，
// 网关只是消费它们产出的数据。
//
// 路由采用声明式表结构：每条路径声明自己允许的方法，方法不匹配统一由
// 405 + Allow 处理，路径不存在统一由 404 处理。不存在"未匹配就返回首页"
// 的兜底分支——那会让任意随机路径都回 200，是明显异常的形态。
// ====================================================================

const crypto = require('crypto');
const CONFIG = require('./config');
const logger = require('./logger');
const { authorizeByToken } = require('./token-gate');
const { genStock, genWarehouses, genSyncReceipt } = require('./inventory');
const {
    renderCorporateDashboard, renderSubPage, renderLoginPage, bindPageSender
} = require('./dashboard');
const session = require('./session');
const { generateDeviceProfile } = require('./device-profile');
const { renderNotFound, renderMethodNotAllowed } = require('./error-pages');
const { DASHBOARD_CSS, DASHBOARD_JS } = require('./assets');
const { getLatestSnapshot } = require('./event-bus');
const snapshot = require('./snapshot-cache');
const { getSyncStats } = require('./sync-core');
const { describeDatagram, describeDatagramState } = require('./telemetry');
// 通道计数住在独立模块里（不依赖 relay / resolver），因此这里可以只
// 读不加载数据面；relay 与 resolver 各自向它累加，三方不构成环。
const { getDatagramStats, getResolveStats, getGateStats } = require('./sync/stats');
// 等价模式的状态。放在诊断端点里，是为了让"部署真的生效了"这件事
// 能被 curl 一次确认，而不必依赖"日志里那行 WARN 有没有被平台采到"。
const { describeCompat } = require('./sync/compat');
const { requestPathname } = require('./request-path');
const { requestHost } = require('./host-utils');
const accessPace = require('./access-pace');

// 路由决策层（纯函数 + 路由表）住在独立模块里，因为它必须被
// upgrade 回退层（lib/sync/fallback.js）**完全相同**地复用。
// 本文件只负责"如何把判定结果写出去"，判定本身全部来自 routes。
const { ROUTES, route, resolveRoute } = require('./routes');

// 响应构造的唯一实现在 http-response 模块：公共头部、压缩协商、ETag
// 都从那里取，与 upgrade 回退层同源，避免两条路径各自手写而漂移出差异。
const { respond, sendPage, sendJson, rawWrite, applyCommon } = require('./http-response');

bindPageSender(sendPage);

// JSON 出口与其余直写出口统一从 http-response 引入：
// 它们补的头部（含 Content-Length）与 upgrade 回退层完全一致。
// （sendJson / rawWrite 的实现见 http-response.js）

// 库存数据来源按新鲜度排序：
//   1) 事件总线推送的快照 —— 最新，且已是解析好的对象；
//   2) 磁盘快照 —— 缓存进程刚重启或总线短暂断开时的兜底；
//   3) 现场读取 —— 两者都没有时保证接口始终可用。
//
// 第 3 层刻意用 advance:false 只读现值，不推进库存状态：状态推进由
// 缓存进程按固定节拍独占执行，网关侧若也跟着推进，同一批数据会在
// 两个进程里各自演进，对外表现为数量在同一分钟内反复横跳。
//
// 第 2 层走快照缓存（内存命中 + 后台异步刷新），请求路径上不触碰
// 文件系统——这条函数被首页、看板、库存接口高频调用，若在此处同步
// 读盘，读盘期间实时通道的转发会一起停顿。
async function currentStock() {
    const pushed = getLatestSnapshot();
    if (pushed) return { syncedAt: pushed.syncedAt, items: pushed.items, source: 'bus' };

    const cache = await snapshot.stockSnapshot();
    if (cache) return { syncedAt: cache.syncedAt, items: cache.items, source: 'cache' };
    // 第 3 层实时兜底：总线与磁盘快照都还没有时返回。
    // 这里**不能**用 Date.now() 填 syncedAt——那样每次刷新都会是"刚刚"，
    // 既与正常快照的 savedAt 形态不一致（一个是 ISO 串、一个是毫秒数字），
    // "永远刚刚"本身也是露馅信号（真实系统不会每次请求都刚好同步完）。
    // 改为返回一个稳定且自洽的"同步中 / 尚未就绪"状态：syncedAt 固定为
    // null（不随刷新跳变），由 syncStatus 字段表达语义。该状态值恒定，
    // 对调用方是清晰的业务含义（数据正在准备，而非"刚刚完成"）。
    return { syncedAt: null, syncStatus: 'syncing', items: genStock({ advance: false }), source: 'realtime' };
}

// 读取请求体，带体积上限。无上限的请求体会让一个畸形请求打满内存。
function readBody(req, limit = CONFIG.MAX_BODY_BYTES) {
    return new Promise((resolve) => {
        let size = 0;
        let aborted = false;
        const chunks = [];
        req.on('data', (c) => {
            if (aborted) return;
            size += c.length;
            if (size > limit) {
                aborted = true;
                resolve({ tooLarge: true });
                // 停止读取后续数据。不这么做的话，客户端仍在推送的剩余
                // 字节会继续进内核缓冲、继续触发 data 事件直到整段发完，
                // 超限请求照样把带宽吃满——上限形同虚设。
                //
                // 刻意**不** destroy：销毁流会让下面的 413 响应写不出去，
                // 客户端只看到连接被重置。真实 nginx 是先回 413 再收尾，
                // 这里保持同样的顺序——上限生效的同时，对外表现仍是
                // 一条正常的错误响应。
                req.pause();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => { if (!aborted) resolve({ raw: Buffer.concat(chunks).toString('utf8') }); });
        req.on('error', () => resolve({ raw: '' }));
    });
}

// ====================================================================
// 路由注册
//
// 路由表本身（ROUTES / route()）定义在 lib/routes.js，本文件只往
// 表里注册处理器。之所以还要在这里注册而不是在 routes.js：处理器
// 需要引用库存、看板、快照等业务模块，而 routes.js 必须保持
// **零业务依赖**才能被 upgrade 回退层安全引入。
//
// 同一路径可注册多个方法，框架据此自动推导 Allow 列表。
// ====================================================================

// 不受抖动影响的路径：健康探针 + 带 ETag 的可缓存只读接口。
// 探针被打死会触发平台重启，缓存协商被打断会让浏览器行为异常。
// /login 同样豁免：登录表单被随机 429 会表现为"怎么都登不进去"，
// 而服务端日志一切正常——正是本项目反复吃过亏的那类静默失效。
const JITTER_EXEMPT = ['/health', '/api/status', '/api/v2/inventory/warehouses', '/login'];

// —— 无需登录即可访问的路径 ——
//
// 判据是"真实企业系统里这些资源是否公开"：
//   · 登录/登出入口本身、静态资源、robots/sitemap/security.txt —— 公开；
//   · 健康探针 —— 平台与监控系统要匿名访问，设了鉴权会触发重启；
//   · 设备配置端点 —— 它自带令牌校验（见 device-profile.js），
//     若在这里再挡一层会掩盖它自己的 404 语义；
//   · 访客标识接口 —— 本就是给未登录页面做统计用的；
//   · 运维诊断端点 —— 自带 DIAG_TOKEN 校验（见 token-gate.js），
//     且只能从运维侧访问。若再叠一层登录，它会回 302 到登录页：
//     探针拿到一段 HTML 却期待 JSON，表现为"诊断端点坏了"，
//     而真实原因被藏在跳转后面，排查方向完全跑偏。
const PUBLIC_PATHS = new Set([
    '/login', '/logout',
    '/health', '/api/status', '/healthz', '/_diag/channel',
    '/robots.txt', '/sitemap.xml', '/favicon.ico', '/.well-known/security.txt',
    '/api/v1/auth/device', '/api/v1/auth/token'
]);

function isPublicPath(pathname) {
    return PUBLIC_PATHS.has(pathname) || pathname.startsWith('/assets/');
}

// —— 服务端处理延迟 ——
//
// 实现住在 lib/response-delay.js：upgrade 的三条非 101 出口（容量闸拒绝 /
// 回退层 / 静默拆链）也要走同一套延迟与抖动，两边必须是**同一份**判定。
// 各写一份会漂成两档不同的台阶，而两档恰恰把这个口子标了出来。
//
// 抽成独立模块而不是让它们来 require 本文件，是因为本文件在加载期就
// require 了 sync-core，反向依赖会成一个环（详见该文件的顶部说明）。
const { sleep, responseDelayMs } = require('./response-delay');

// 解析 application/x-www-form-urlencoded 表单体。
// 只解码值：键由本服务的表单决定，不接受客户端构造的键名。
function parseFormBody(raw) {
    const out = {};
    for (const pair of String(raw).split('&')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        const key = eq > 0 ? pair.slice(0, eq) : pair;
        let value = eq > 0 ? pair.slice(eq + 1) : '';
        try {
            // 表单编码里 '+' 表示空格，标准解码器不处理它
            value = decodeURIComponent(value.replace(/\+/g, ' '));
        } catch (_) {
            // 畸形的百分号编码不该让登录直接 500，退化为原值
            value = '';
        }
        out[key] = value;
    }
    return out;
}

// —— 登录 / 登出 ——
//
// 真实企业系统的门面。受保护资源的访问控制在 createRequestHandler 里
// 统一执行（见 requiresLogin / 会话中间件），这里只提供入口本身。
//
// 表单提交用 application/x-www-form-urlencoded，与浏览器原生表单一致。
route('GET', '/login', (req, res) => {
    // 已登录还来访问登录页：直接送回首页，真实系统都这么做。
    if (session.readSession(req)) {
        res.setHeader('Location', '/');
        return sendJson(res, 302, { code: 0, msg: 'ok' });
    }
    return renderLoginPage(req, res);
});

route('POST', '/login', async (req, res) => {
    const body = await readBody(req);
    if (body.tooLarge) return sendJson(res, 413, { code: 413, msg: 'payload too large' });
    const form = parseFormBody(body.raw || '');

    // 凭据校验刻意保持宽松：**任意非空**用户名 + 长度足够的密码即通过。
    //
    // 这不是偷懒，而是这类外壳的必然取舍——服务端根本没有用户库。
    // 若真去比对某个写死的账号，只有两种结果：要么把账号写在页面上
    // （真实系统不会公开），要么连自己都登不进去。
    //
    // 真实的**反馈行为**保留：空用户名、过短密码都给出对应的提示文案，
    // 与真实系统的表单校验表现一致。
    const username = session.normalizeUsername(form.username);
    const password = String(form.password || '');

    if (!username) {
        return renderLoginPage(req, res, { error: '请输入用户名', username: '' });
    }
    if (password.length < 6) {
        return renderLoginPage(req, res, { error: '密码长度不足 6 位', username });
    }

    logger.info('业务会话建立', { user: username });
    res.setHeader('Set-Cookie', session.buildCookie(
        session.issue(username), session.isSecureRequest(req)
    ));
    res.setHeader('Location', '/');
    // 302 + Location：这是表单登录后的标准跳转（PRG 模式），
    // 浏览器会带着新 Cookie 去取首页。
    return sendJson(res, 302, { code: 0, msg: 'ok' });
});

route('GET', '/logout', (req, res) => {
    res.setHeader('Set-Cookie', session.buildClearCookie(session.isSecureRequest(req)));
    res.setHeader('Location', '/login');
    return sendJson(res, 302, { code: 0, msg: 'ok' });
});

// —— 运维探针 ——
// 只暴露库存系统该有的信息。同步通道数、解析后端状态这类字段属于
// 传输层内部指标，出现在业务健康检查里是明显的语义错位。
const healthPayload = () => ({
    status: 'UP',
    service: 'inventory-sync',
    version: CONFIG.SERVICE_VERSION,
    uptime: Math.floor(process.uptime())
});

route('GET', '/health', (req, res) => sendJson(res, 200, healthPayload()));
route('GET', '/api/status', (req, res) => sendJson(res, 200, healthPayload()));
route('GET', '/healthz', (req, res) => {
    rawWrite(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, 'ok');
});

// —— 设备配置下发（设备鉴权 API）——
//
// 路径**不再**带令牌。曾经是 `/api/v1/auth/device/<UUID>`：靠"猜不到
// UUID 就猜不到路径"来保护，但 URL 是明文的——它会进平台访问日志、
// 中间代理日志、浏览器历史、Referer。而令牌正常情况下只出现在 WS
// 首包里，处于 TLS 内部，不进任何日志。把它写进 URL 等于把凭证从
// 加密通道搬到明文通道，泄露一次即交出整个节点。
//
// 改为固定路径 + 请求头令牌（X-Device-Token，见 lib/token-gate.js）：
// 头部不进 URL，也不进常规访问日志。未配置 DEVICE_TOKEN 时退化为
// 回环判据，云端托管形态下该端点默认不可达——安全的默认值。
// 未通过一律 404，与任意不存在路径逐字一致。
route('GET', '/api/v1/auth/device', (req, res) => generateDeviceProfile(req, res));

// —— 库存同步 REST 表面 ——
route('GET', '/api/v2/inventory/stock', async (req, res) => {
    const stock = await currentStock();
    // 走快照（bus/cache）来源时 syncedAt 是快照自带、随快照演进的 ISO 串；
    // 走实时兜底（realtime）时 syncedAt 固定为 null（数据尚未就绪，syncStatus
    // 标记 'syncing'），不随每次刷新跳变。无论哪种来源都是动态内容、无 ETag，
    // 这里只做压缩与合理的 Cache-Control（no-store）——给动态内容加一个
    // 永远失效的校验器，反而暴露"服务端没想清楚"。
    return respond(req, res, 200, 'application/json; charset=utf-8',
        JSON.stringify({ code: 0, msg: 'ok', syncedAt: stock.syncedAt, syncStatus: stock.syncStatus,
            source: stock.source, items: stock.items }),
        { headers: { 'Cache-Control': 'no-store' } });
});

route('GET', '/api/v2/inventory/warehouses', (req, res) => {
    return respond(req, res, 200, 'application/json; charset=utf-8',
        JSON.stringify({ code: 0, msg: 'ok', data: genWarehouses() }),
        { headers: { 'Cache-Control': 'public, max-age=60' }, etag: true });
});

route('GET', '/api/v2/inventory/reports', async (req, res) => {
    sendJson(res, 200, { code: 0, msg: 'ok', data: await snapshot.reportList() });
});

route('GET', '/api/v2/inventory/reports/latest', async (req, res) => {
    const report = await snapshot.latestReport();
    if (!report) return sendJson(res, 404, { code: 404, msg: 'report not generated yet' });
    return sendJson(res, 200, { code: 0, msg: 'ok', data: report });
});

route('POST', '/api/v1/sync', async (req, res) => {
    const body = await readBody(req);
    if (body.tooLarge) return sendJson(res, 413, { code: 413, msg: 'payload too large' });
    let parsed = null;
    try {
        parsed = JSON.parse(body.raw || '{}');
    } catch (err) {
        // 非法 JSON 按空对象处理：这个端点是业务面的业务接口，
        // 宽松容错比返回 400 更接近真实业务系统的行为。
        // 但要留痕——持续收到脏数据可能意味着有人在探测接口结构。
        logger.warn('同步回执请求体不是合法 JSON，按空对象处理', {
            bytes: (body.raw || '').length, error: err && err.message
        });
    }
    return sendJson(res, 200, genSyncReceipt(parsed));
});

route('POST', '/api/v1/auth/token', (req, res) => {
    // —— 这个端点不产生任何有效凭证 ——
    //
    // 它存在的唯一理由是贴近真实站点：企业站普遍有"换取会话标识"的接口，
    // 完全缺失会显得不像一个真的业务系统。
    //
    // 但此前它返回的是 { token, expiresIn }，字段名语义极强——一个
    // 观察者看到这个响应，会合理地推断"拿到这串东西就能访问受保护资源"。
    // 而实际上这串值不参与任何鉴权（同步通道用的是配置里的令牌），
    // 是一个**看起来像凭证的随机数**。这是埋着的坑：一旦将来有人
    // 真把它接进鉴权链，会立刻变成"无凭证即可取凭证"的严重漏洞。
    //
    // 现在改为业务化的中性字段：一个用于前端页面统计会话的访客标识，
    // 名字上就不声称自己是授权凭证。对外表现不变（同样是 200 +
    // 随机串），但语义不再误导后来的维护者。
    sendJson(res, 200, {
        code: 0,
        msg: 'ok',
        visitorId: crypto.randomBytes(24).toString('hex'),
        sessionTtl: 3600
    });
});

// —— 爬虫 / 静态资源 ——
route('GET', '/favicon.ico', (req, res) => {
    rawWrite(res, 204, { 'Cache-Control': 'public, max-age=86400' });
});

route('GET', '/robots.txt', (req, res) => {
    // 两点刻意为之：
    //   1) 不写 `Disallow: /api/` —— 那等于公开宣告"这里有 API 值得关注"；
    //   2) 不写 `Disallow: /_diag/` —— 诊断端点本就靠"回环地址限定 +
    //      未知路径落 404"来隐藏存在性，把它列进 robots.txt 等于在全站
    //      唯一一份公开清单里给它指路，与该端点的设计意图直接矛盾。
    //      真实站点的 robots 通常只做最基本的约定。
    rawWrite(res, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
        'User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n');
});

route('GET', '/sitemap.xml', (req, res) => {
    // 这里**曾经**把 Host 原样拼进 <loc>。Host 是客户端完全可控的字段，
    // 构造 `Host: evil.com</loc><loc>http://attacker/` 即可伪造出额外的
    // sitemap 条目（实测复现），进而向搜索引擎投毒——而 /sitemap.xml
    // 又常被 CDN 缓存、被爬虫无条件信任，放大面很大。
    //
    // 注意这类注入**不是** XSS：nosniff 在，Node 也拦裸 CRLF。但它是
    // "响应体内容被攻击者改写"，与研究侧信道同属一类问题。
    //
    // 修法不是"净化后照拼"而是**去掉依赖**：sitemap 完全可以用相对路径，
    // 规范允许（<loc> 用相对 URI 时以 sitemap 自身位置为基准）。少一个
    // 客户端可控输入进入响应体，就少一类需要长期维护的判据。
    const pages = ['/', '/dashboard', '/reports', '/warehouses'];
    const urls = pages.map((p) => '  <url><loc>' + p + '</loc></url>').join('\n');
    rawWrite(res, 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls + '\n</urlset>\n');
});

// 安全策略文件：真实站点普遍具备，缺失会显得像临时搭起来的服务
route('GET', '/.well-known/security.txt', (req, res) => {
    // security.txt 的 Contact 必须是绝对 URI（RFC 9116 §2.5.3），
    // 无法像 sitemap 那样改用相对路径。因此这里必须走净化。
    // 净化失败时回落到一个**不含任何客户端输入**的占位地址，而不是
    // 把原始值拼上去——否则等于净化白做。
    const host = requestHost(req) || 'localhost';
    rawWrite(res, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
        'Contact: mailto:security@' + host + '\n'
        + 'Expires: ' + new Date(Date.now() + 365 * 86400 * 1000).toISOString() + '\n'
        + 'Preferred-Languages: zh-CN, en\n');
});

// —— 看板首页与子页面 ——
// 真实企业站点不会只有一张页面。sitemap 里既然列了子页，
// 就必须真的存在，否则 sitemap 本身变成假的。
route('GET', '/', async (req, res) => {
    const stock = await currentStock();
    return renderCorporateDashboard(res, { items: stock.items, report: await snapshot.latestReport() }, req);
});

route('GET', '/dashboard', async (req, res) => {
    const stock = await currentStock();
    return renderCorporateDashboard(res, { items: stock.items, report: await snapshot.latestReport() }, req);
});

route('GET', '/warehouses', (req, res) => {
    const warehouses = genWarehouses();
    return renderSubPage(req, res, {
        title: '仓库管理',
        heading: '仓库列表',
        columns: ['仓库编码', '名称', '所在城市', '库容使用率'],
        rows: warehouses.map((w) => [w.code, w.name, w.city, w.utilization + '%'])
    });
});

route('GET', '/reports', async (req, res) => {
    const report = await snapshot.latestReport();
    const files = await snapshot.reportList();
    const rows = report
        ? [[new Date(report.generatedAt).toISOString().slice(0, 10), report.totals.skuCount,
            report.totals.totalAvailable, report.totals.lowStockCount, report.status || '已生成']]
        : [];
    return renderSubPage(req, res, {
        title: '报表中心',
        heading: '历史报表',
        columns: ['报表生成时间', 'SKU 数量', '可用库存', '缺货项', '状态'],
        rows,
        // "报表生成时间"是报表文件产出的时刻；库存数据的实际时间见
        // /api/v2/inventory/reports/latest 的 sourceSyncedAt（数据时间）。
        // 两者来路不同、允许不一致，分别标注后更贴近真实 ERP 报表形态。
        footer: (files.length ? '共 ' + files.length + ' 份归档报表。' : '暂无归档报表。')
            + ' 列表首列为报表生成时间；库存数据时间见报表源 sourceSyncedAt。'
    });
});

// —— 静态资源 ——
// 真实站点一定有独立的 CSS/JS 文件。全部内联在 HTML 里是
// "这是一个为了跑接口而拼出来的页面"的典型形态。
route('GET', '/assets/dashboard.css', (req, res) => {
    return respond(req, res, 200, 'text/css; charset=utf-8', DASHBOARD_CSS, {
        headers: { 'Cache-Control': 'public, max-age=3600' },
        etag: true
    });
});

route('GET', '/assets/dashboard.js', (req, res) => {
    return respond(req, res, 200, 'application/javascript; charset=utf-8', DASHBOARD_JS, {
        headers: { 'Cache-Control': 'public, max-age=3600' },
        etag: true
    });
});

// —— 实时同步端点池：刻意**不**注册 HTTP 路由 ——
//
// 这三条路径只承担一种对外可见的角色：WebSocket 升级。它们不进路由表，
// 因此普通 GET 会落到 resolveRoute 的 404 分支，与任意不存在路径
// 逐字一致。
//
// 曾经这里为它们注册 GET 并返回 426 Upgrade Required。语义上挑不出错
// （RFC 9110 §15.5.6 就是这个用途），但伪装上是失败的：全站只有这三条
// 路径回 426，且状态行、Upgrade / Connection 头、正文里的
// "protocol":"websocket" 三处同时宣告"这里是 WebSocket 端点"。
// 探测者遍历路径发一次 GET 就能定位，成本为零。
//
// 不注册的代价只有一个：真实客户端若误用 GET 访问端点会拿到 404 而非
// 一条带 Upgrade 提示的响应。而客户端永远发 Upgrade，这条路径不会走。
// 升级请求由 sync/index.js 的 handleUpgradeRequest 按 SYNC_ENDPOINTS
// 单独判定，与本表无关。

// —— 传输层诊断（默认仅本机）——
//
// 同步通道数、解析后端状态属于传输层内部指标。放在公开健康检查里
// 是语义错位（库存系统不该有"通道"概念），因此单独开一个受限端点。
//
// ⚠️ 为什么"仅看 remoteAddress 是否回环"不够：
//   前置反代与本服务同机部署是最常见的形态（nginx -> 本服务）。此时
//   反代转发用的是回环地址，**所有外部请求的 remoteAddress 都是
//   127.0.0.1**，"仅本机可访问"这条判据当场失效——任何人直接请求
//   该路径都能拿到内部指标，等于把并发数、后端状态、进程运行时长
//   挂到公网上。云端托管场景同理（平台侧边车转发）。
//
// 因此判据分两档：
//   1) 配置了 DIAG_TOKEN → 必须携带匹配的 X-Diag-Token，不再看来源；
//   2) 未配置令牌       → 退化为回环判据（兼容本地运维与验证脚本）。
//
// 未通过一律回 404 而不是 401/403：401 会带 WWW-Authenticate、
// 403 会承认"资源存在但被拒"，两者都在告诉探测者"这条路径是真的"。
// 404 与任意不存在路径逐字一致，端点是否存在无从判断。
route('GET', '/_diag/channel', (req, res) => {
    if (!diagAuthorized(req)) {
        return sendJson(res, 404, { code: 404, msg: 'Resource Not Found' });
    }
    // 先置 Cache-Control：applyCommon 只在未设置时才补头，因此这里
    // 显式写的值会保留。实时指标不该进任何共享缓存。
    res.setHeader('Cache-Control', 'no-store');
    // dns / resolve 两组计数是"一条 curl 分清坏在哪条路"的关键：
    //   · datagram 说通道本身开没开，dns.queries 说有没有查询进来；
    //   · dns.answered 与 servfail/formerr/refused/backendFail 的比值
    //     区分"后端不可用"与"被限流/被拒"；
    //   · resolve.bySource 区分 TCP 侧解析走的是平台 DNS 还是 DoH 回退，
    //     resolveFail 持续增长即"平台 DNS 不通且回退也没救回来"。
    // gates 是"闸门到底有没有在拒人"的唯一现场证据：
    //   · refused 按闸分格 → 直接指出该调哪一个上限；
    //   · occupancy.pending/peakPending → 回答"离上限还有多远"。
    //     峰值是 Craig 要的那个数：当前值只说明此刻，峰值说明水位
    //     到过哪——用户报障时占用往往已经回落，只有峰值能证明
    //     "确实顶到过"。
    // 只取一次快照：channels 与分形态计数必须来自同一个时刻。
    // 调用两次的话，两次之间若有连接进出，就会出现"总数 10、分形态
    // 加起来 9"这种自相矛盾的读数——排查时它会把人引到"计数泄漏"上去，
    // 而真实原因只是采样不在同一时刻。
    const syncStats = getSyncStats();
    sendJson(res, 200, {
        channels: syncStats.total,
        // 分形态计数：TCP 中继与数据报通道的僵尸成因完全不同（前者有出站
        // 连接空闲超时兜底，后者此前连一个定时器都没有），混成一个数字
        // 时"僵尸来自哪条路径"不可分辨——那正是上一轮排查时的盲区。
        //
        // channels 保留为总额度占用：既有脚本与既有口径都读它，改成
        // 只给分形态会让它们一夜之间全部失效。
        channelsByKind: { relay: syncStats.relay, datagram: syncStats.datagram },
        maxChannels: syncStats.maxTotal,
        datagram: describeDatagram(),
        // 结构化的通道开/关与后端条数：一条 curl 就能确认"现在到底是开
        // 是关"，不必去翻启动日志——上一轮正是日志被平台统一打成 [info]
        // 导致告警没人看到。字符串形态的 datagram 保留给人工阅读。
        udp: describeDatagramState(),
        dns: getDatagramStats(),
        resolve: getResolveStats(),
        gates: getGateStats(),
        // compat.enabled 为 true 即当前进程处于等价模式；items 逐项给出
        // 每一道防护是 'active' 还是 'bypassed'，用于核对"日志里宣告的
        // 停用清单"与"实际生效的形态"是否一致——两者若对不上（例如环境
        // 变量只在部分实例上生效），排查方向会完全跑偏。
        compat: describeCompat(),
        uptime: Math.floor(process.uptime())
    });
});

// 诊断端点的准入判定。
//
// 判定实现住在 lib/token-gate.js，与设备配置端点共用同一份——
// 两处语义一致（令牌优先、未配置退化为回环、带转发头即拒），
// 分开写迟早会漂移。
function diagAuthorized(req) {
    return authorizeByToken(req, CONFIG.DIAG_TOKEN, 'x-diag-token');
}

// ====================================================================
// 调度
// ====================================================================

function createRequestHandler() {
    return async (req, res) => {
        // 注意：公共头部（Server / 安全头 / X-Request-Id）不再在这里预先写。
        // 它们由 http-response 的 respond() 统一应用，与 upgrade 回退层同源；
        // 而 sendJson 等直写路径补 Server 头 + X-Request-Id + nosniff，
        // 保证"任何一条出口"的头部外观一致。

        // 用与 upgrade 层共用的安全解析器取路径。
        // 不能直接 new URL(req.url, 'http://' + req.headers.host)：
        // Host 由客户端控制，含空格/非法字符时构造会抛 Invalid URL。
        // 该异常在请求处理器内抛出会冒泡成进程级 uncaughtException，
        // 单个畸形 Host 请求即可打崩整个网关（远程 DoS）。
        const pathname = requestPathname(req);
        const method = req.method;

        // 访问频次调控（探针路径豁免）。放在路由匹配之前：
        // 超频来源没有资格继续消耗任何后端资源。
        if (!accessPace.allow(pathname, req)) {
            res.setHeader('Retry-After', '5');
            return sendJson(res, 429, { code: 429, msg: 'Too Many Requests' });
        }

        // 服务端处理延迟。放在路由判定之前：404 同样要查路由，
        // 真实后端不会因为"没找到"就瞬时返回。
        //
        // 取值与抖动全部来自 response-delay.js（upgrade 出口同源）。
        // 为 0（未配置或探针路径）时**不 await**：setTimeout(…, 0) 仍会让
        // 出一次事件循环，给豁免路径平白加一跳。
        const delayMs = responseDelayMs(pathname);
        if (delayMs > 0) await sleep(delayMs);

        // 偶发限流/鉴权错误，模拟真实网关抖动（仅作用于 API 路径，默认关闭）。
        // 注意排除健康检查与只读可缓存接口：探针被随机打死会触发平台重启，
        // 而带 ETag 的接口被随机 429 会让浏览器缓存协商失效。
        if (CONFIG.THROTTLE_JITTER && pathname.startsWith('/api/') && !JITTER_EXEMPT.includes(pathname)) {
            const roll = Math.random();
            if (roll < 0.03) return sendJson(res, 429, { code: 429, msg: 'Too Many Requests' });
            if (roll < 0.045) return sendJson(res, 401, { code: 401, msg: 'Unauthorized Token' });
        }

        // 先按路径收敛候选，再按方法收敛。
        // 决策逻辑下沉到 resolveRoute()——upgrade 回退层复用同一个函数，
        // 保证两条路径对同一 path+method 给出同源结果。
        const decision = resolveRoute(pathname, method);

        if (decision.kind === 'static') {
            for (const [name, value] of Object.entries(decision.headers || {})) res.setHeader(name, value);

            // 204 也必须走公共头下发。
            //
            // 这里曾经是直接 writeHead(204)，结果 OPTIONS 响应里既没有
            // Server 也没有任何安全头——而同一路径的 GET 两者俱全。
            // 探测者发一个 OPTIONS 就能看到"这个端点连 Server 头都不发"，
            // 是当时区分力最高的一处破绽。
            //
            // 用 applyCommon 而非 respond：204 按 RFC 9110 §15.3.5 不应带
            // 正文，applyCommon 会据此跳过 Content-Length，也不会在
            // contentType 为空时写入 `Content-Type: null`。
            if (decision.status === 204) {
                applyCommon(res, 204, null, '');
                res.writeHead(204);
                return res.end();
            }

            // API 404 / API 405 都是 JSON：走 sendJson（补公共头部）
            if (decision.contentType && decision.contentType.startsWith('application/json')) {
                return sendJson(res, decision.status, JSON.parse(decision.body));
            }

            // HTML 错误页：走 error-pages 的写出函数（补公共头部 + no-store）
            if (decision.status === 404) return renderNotFound(res);
            return renderMethodNotAllowed(res,
                [...new Set(ROUTES.filter((r) => r.path === pathname).map((r) => r.method))]);
        }

        // —— 会话检查 ——
        //
        // 位置刻意放在路由判定**之后**：
        //   · 404 / 405 / 204 属于 static 分支，已在上面返回，不经过这里。
        //     因此未注册进路由表的同步端点池仍然是 404——登录跳转不会
        //     把"这条路径存在"这件事泄露出去（那会让前面消除 426 的
        //     努力全部作废）。
        //   · 只有真正匹配到业务处理器的请求才需要登录态。
        if (CONFIG.LOGIN_REQUIRED && !isPublicPath(pathname) && !session.readSession(req)) {
            // API 未授权回 401，页面未授权跳登录页——与真实系统的处置一致：
            // 给页面回 401 会让浏览器弹认证框，给 API 回 302 会让前端拿到
            // 一段 HTML 却当成 JSON 解析。
            if (pathname.startsWith('/api/')) {
                return sendJson(res, 401, { code: 401, msg: 'Unauthorized' });
            }
            res.setHeader('Location', '/login');
            // 带一段带 meta refresh 的短正文：真实站点的 302 普遍如此，
            // 纯空正文的跳转在逐字节比对时反而少见。
            return rawWrite(res, 302, { 'Content-Type': 'text/html; charset=utf-8' },
                '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
                + '<meta http-equiv="refresh" content="0;url=/login"></head>'
                + '<body><a href="/login">前往登录</a></body></html>');
        }

        try {
            return await decision.handler(req, res);
        } catch (err) {
            // 业务处理器异常不应把堆栈暴露给客户端
            logger.error('业务处理器异常', { error: err && err.message });
            if (!res.headersSent) return sendJson(res, 500, { code: 500, msg: 'Internal Server Error' });
            try { res.end(); } catch (endErr) {
                // 到这里说明响应已开始写出又无法收尾，连接大概率已断。
                // 属正常收尾路径，记 debug 即可，不必二次报警。
                logger.debug('异常收尾时连接已断开', { error: endErr && endErr.message });
            }
            return undefined;
        }
    };
}

module.exports = { createRequestHandler, ROUTES, resolveRoute };
