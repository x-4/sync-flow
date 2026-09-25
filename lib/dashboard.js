// ====================================================================
// 企业级 Web 控制台
//
// 展示内容来自缓存/报表进程真实产出的数据，不是写死的假数字。
// 样式完全内联自包含，不引用任何外部 CDN。
//
// UA 分流：浏览器拿到完整看板；爬虫/脚本/无 UA 的请求拿到精简页。
// 真实站点普遍会做这件事（爬虫不该触发数据查询），而"任何 UA 都返回
// 完全相同的完整页面"本身就是一个可识别的特征。
// ====================================================================

// --------------------------------------------------------------------
// 页面统一出口
//
// 页面资源全部走 /assets/* 外链（由网关路由提供），本模块不再引用
// 内联样式与脚本——那两行 require 是资源外置重构后的遗留死代码。
//
// 之前三个渲染函数各自 res.writeHead + res.end，直接绕过了网关的
// 压缩/Vary 逻辑——结果是首页作为整站门面 4.4 KB 明文发出，而真实
// 站点几乎必然对 HTML 开 gzip。这里把出口收敛到一处，交给网关的
// sendPage 处理，HTML 也走与应用一致的协商路径。
// --------------------------------------------------------------------
let sendPage = null;

// 由网关在加载时注入。保持 dashboard 不反向依赖 gateway 的模块加载顺序，
// 同时避免循环 require。
function bindPageSender(fn) {
    sendPage = fn;
}

function writePage(req, res, html, cacheControl) {
    if (typeof sendPage === 'function') {
        return sendPage(req, res, html, cacheControl);
    }
    // 兜底：未注入时退回原始写法，保证独立调用（如测试）仍然可用
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': cacheControl
    });
    res.end(html);
}

// 会话只读：页面要显示"当前是谁在登录"，但不负责签发/校验，
// 那两件事归 session.js。本模块不因此产生循环依赖——session 只依赖 config。
const session = require('./session');

const fmtTime = (ts) => (ts
    ? new Date(ts).toISOString().replace('T', ' ').slice(11, 19)
    : '--:--:--');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

// 只有明确是浏览器的 UA 才给完整看板；其余一律给精简页
const BROWSER_RE = /(Mozilla\/5\.0.*(Chrome|Safari|Firefox|Edg|OPR))|MSIE|Trident/i;

function isBrowser(req) {
    const ua = (req && req.headers && req.headers['user-agent']) || '';
    return BROWSER_RE.test(ua);
}

// —— 页头用户区 ——
//
// 真实企业系统在登录后，右上角一定会出现"当前用户 + 退出"。缺了这一块，
// 页面会呈现出"要登录、却看不出是谁在登录"的割裂感——门面上有登录，
// 会话里也有用户，唯独界面上没有任何痕迹。
//
// 未登录时返回空串而不是"登录"链接：这些页面本来就只在登录后可达，
// 出现"登录"反而自相矛盾。req 为 undefined 是既有调用形态，必须容忍。
function renderUserBar(req) {
    const user = req ? session.sessionUser(req) : '';
    if (!user) return '';
    return '\n            <div class="hd-right">'
        + '<span class="user-chip">' + esc(user) + '</span>'
        + '<a class="link" href="/logout">退出</a>'
        + '</div>';
}


// 精简页：给爬虫/脚本的轻量响应，不含库存明细
// req 可能为 undefined（既有调用方），writePage 已做兜底处理
function renderLite(res, data, req) {
    const t = data && data.report ? data.report.totals : null;
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="企业库存实时同步系统，提供库存快照、仓库列表与历史报表查询。">
    <meta property="og:title" content="库存实时同步系统">
    <meta property="og:type" content="website">
    <meta property="og:description" content="企业库存实时同步系统 · 实时数据集成节点">
    <meta name="theme-color" content="#2563eb">
    <link rel="stylesheet" href="/assets/dashboard.css">
    <link rel="icon" href="/favicon.ico">
    <title>库存实时同步系统</title>
</head>
<body>
    <div class="wrap">
        <header>
            <div class="hd-left">
                <div class="logo">ERP</div>
                <div>
                    <h1>库存实时同步系统</h1>
                    <p class="muted">Real-time Inventory Synchronization</p>
                </div>
            </div>
            <div class="badge"><span class="dot"></span> 服务运行中</div>
${renderUserBar(req)}
        </header>
        <div class="panel">
            <div class="panel-hd"><h2>系统概览</h2></div>
            <div class="stat">
                <p class="k">当前 SKU 数量</p>
                <div class="v">${t ? t.skuCount : '--'}</div>
            </div>
        </div>
        <footer>Inventory Synchronization Platform<br>沪ICP备00000000号-1</footer>
    </div>
</body>
</html>
`;
    writePage(req, res, html, 'public, max-age=60');
}

// req 可能为 undefined（既有调用方），writePage 已做兜底处理
function renderFull(res, data, req) {
    const items = (data && data.items) || [];
    const report = (data && data.report) || null;
    const t = report ? report.totals : null;

    const rows = items.map((i) => `
                        <tr>
                            <td class="mono">${esc(i.sku)}</td>
                            <td>${esc(i.name)}</td>
                            <td>${esc(i.warehouse)}</td>
                            <td>${esc(i.available)}</td>
                            <td>${esc(i.reserved)}</td>
                        </tr>`).join('');

    const emptyRow = items.length ? '' : `
                        <tr><td class="empty" colspan="5">等待缓存进程产出数据…</td></tr>`;

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="企业库存实时同步系统，提供库存快照、仓库列表与历史报表查询。">
    <meta property="og:title" content="库存实时同步系统">
    <meta property="og:type" content="website">
    <meta property="og:description" content="企业库存实时同步系统 · 实时数据集成节点">
    <meta name="theme-color" content="#2563eb">
    <link rel="stylesheet" href="/assets/dashboard.css">
    <link rel="icon" href="/favicon.ico">
    <title>库存实时同步系统</title>
</head>
<body>
    <!-- data-live-refresh：前端脚本据此判断"这页需要轮询刷新"。
         精简页与登录页没有这个标记，脚本在那里不会启动轮询——
         否则未登录的 fetch 会拿到 401，页面随之被 reload 掉。 -->
    <div class="wrap" data-live-refresh>
        <header>
            <div class="hd-left">
                <div class="logo">ERP</div>
                <div>
                    <h1>库存实时同步系统</h1>
                    <p class="muted">实时数据集成节点 · Real-time Data Integration Node</p>
                </div>
            </div>
            <div class="badge"><span class="dot"></span> 服务运行中</div>
${renderUserBar(req)}
        </header>

        <div class="grid">
            <div class="card stat">
                <p class="k">SKU 数量</p>
                <div class="v">${t ? t.skuCount : '--'}</div>
            </div>
            <div class="card stat">
                <p class="k">可用库存合计</p>
                <div class="v blue">${t ? t.totalAvailable : '--'}</div>
            </div>
            <div class="card stat">
                <p class="k">缺货预警</p>
                <div class="v ${t && t.lowStockCount > 0 ? 'green' : ''}">${t ? t.lowStockCount : '--'}</div>
            </div>
            <div class="card stat">
                <p class="k">报表生成时间</p>
                <div class="v" style="font-size:24px">${fmtTime(report && report.generatedAt)}</div>
            </div>
        </div>

        <div class="panel">
            <div class="panel-hd">
                <h2>当前库存快照</h2>
                ${report
                    ? '<a class="link" href="/api/v2/inventory/reports/latest">下载报表</a>'
                    : '<span class="muted">报表生成中（约 1 分钟）</span>'}
            </div>
            <table>
                <thead>
                    <tr>
                        <th>SKU 编码</th>
                        <th>物料名称</th>
                        <th>所属仓库</th>
                        <th>可用库存</th>
                        <th>已预留</th>
                    </tr>
                </thead>
                <tbody>${rows}${emptyRow}
                </tbody>
            </table>
        </div>

        <footer>Inventory Synchronization Platform<br>沪ICP备00000000号-1</footer>
    </div>

    <script src="/assets/dashboard.js"></script>
</body>
</html>
`;
    writePage(req, res, html, 'no-store');
}

// 子页面（仓库、报表）。真实企业站点不会只有一张页面，
// sitemap 里列出的路径必须真的存在，否则 sitemap 本身就是假的。
function renderSubPage(req, res, { title, heading, columns, rows, footer }) {
    const head = columns.map((c) => '                        <th>' + esc(c) + '</th>').join('\n');
    const body = rows.length
        ? rows.map((r) => '                        <tr>' +
            r.map((cell) => '<td>' + esc(cell) + '</td>').join('') + '</tr>').join('\n')
        : '                        <tr><td class="empty" colspan="' + columns.length + '">暂无数据</td></tr>';

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="企业库存实时同步系统，提供库存快照、仓库列表与历史报表查询。">
    <meta name="theme-color" content="#2563eb">
    <link rel="stylesheet" href="/assets/dashboard.css">
    <link rel="icon" href="/favicon.ico">
    <title>${esc(title)} | 库存实时同步系统</title>
</head>
<body>
    <div class="wrap">
        <header>
            <div class="hd-left">
                <div class="logo">ERP</div>
                <div>
                    <h1>${esc(heading)}</h1>
                    <p class="muted">实时数据集成节点 · Real-time Data Integration Node</p>
                </div>
            </div>
            <div class="badge"><span class="dot"></span> 服务运行中</div>
${renderUserBar(req)}
        </header>

        <div class="panel">
            <div class="panel-hd">
                <h2>${esc(heading)}</h2>
                <a class="link" href="/">返回首页</a>
            </div>
            <table>
                <thead>
                    <tr>
${head}
                    </tr>
                </thead>
                <tbody>
${body}
                </tbody>
            </table>
        </div>

        <footer>Inventory Synchronization Platform${footer ? '<br>' + esc(footer) : ''}</footer>
    </div>

    <script src="/assets/dashboard.js"></script>
</body>
</html>
`;
    // HEAD 由网关统一处理（语义上不应有响应体），这里只负责正常 GET
    writePage(req, res, html, 'public, max-age=30');
}

// req 可选：不带 req 时按浏览器处理，兼容既有调用方与测试
const renderCorporateDashboard = (res, data, req) => {
    if (req && !isBrowser(req)) return renderLite(res, data, req);
    return renderFull(res, data, req);
};

// --------------------------------------------------------------------
// 登录页
//
// 这是"这是一个真的企业系统"这条叙事的入口。真实的内网系统不会让
// 未认证访客直接看到库存数据，因此访问受保护资源必须先过这一关。
//
// 表单字段刻意做成真实的样子：用户名 + 密码（type=password）、
// 记住我、忘记密码。缺少密码框的"登录页"等于没有登录页。
//
// @param {string} [opts.error] 上一次登录失败的原因，非空时渲染提示条
// @param {string} [opts.username] 回填用户名，避免用户重输
// --------------------------------------------------------------------
function renderLoginPage(req, res, opts = {}) {
    const error = opts.error ? esc(opts.error) : '';
    const username = esc(opts.username || '');
    const errorBlock = error
        ? `            <div class="alert alert-error" role="alert">${error}</div>\n`
        : '';

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <meta name="description" content="企业库存实时同步系统 · 用户登录">
    <meta name="theme-color" content="#2563eb">
    <link rel="stylesheet" href="/assets/dashboard.css">
    <link rel="icon" href="/favicon.ico">
    <title>登录 · 库存实时同步系统</title>
</head>
<body class="login-body">
    <div class="wrap login-wrap">
        <header>
            <div class="hd-left">
                <div class="logo">ERP</div>
                <div>
                    <h1>库存实时同步系统</h1>
                    <p class="muted">Real-time Inventory Synchronization</p>
                </div>
            </div>
            <div class="badge"><span class="dot"></span> 服务运行中</div>
        </header>

        <div class="panel login-panel">
            <div class="panel-hd"><h2>账户登录</h2></div>
${errorBlock}            <form class="login-form" method="post" action="/login" autocomplete="on">
                <label class="field">
                    <span class="field-label">用户名</span>
                    <input type="text" name="username" value="${username}"
                           autocomplete="username" required maxlength="64"
                           placeholder="请输入域账号">
                </label>
                <label class="field">
                    <span class="field-label">密码</span>
                    <input type="password" name="password"
                           autocomplete="current-password" required maxlength="128"
                           placeholder="请输入登录密码">
                </label>
                <label class="field-check">
                    <input type="checkbox" name="remember" value="1">
                    <span>记住本机</span>
                </label>
                <button type="submit" class="btn btn-primary btn-block">登 录</button>
            </form>
            <p class="login-foot">
                <a class="link" href="/login">忘记密码</a>
                <span class="muted">如需开通账号请联系系统管理员</span>
            </p>
        </div>

        <footer>Inventory Synchronization Platform<br>沪ICP备00000000号-1</footer>
    </div>

    <!-- 公共脚本在所有页面都会加载，与真实系统一致。
         脚本内部按 [data-live-refresh] 决定是否启动轮询，
         因此它在登录页上只是挂载排序/格式化能力，不会刷新页面。 -->
    <script src="/assets/dashboard.js"></script>
</body>
</html>
`;
    // 登录页不可缓存：它带表单，且失败提示是逐次不同的
    return writePage(req, res, html, 'no-store');
}

module.exports = {
    renderCorporateDashboard,
    renderSubPage,
    renderLoginPage,
    isBrowser,
    bindPageSender
};
