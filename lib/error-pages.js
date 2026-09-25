// ====================================================================
// 错误页渲染
//
// 真实企业站点的错误页有固定形态：带品牌头尾、带返回入口、404 与 405
// 分开处理、并且**不会把未知路径渲染成首页**。
//
// 之前的兜底逻辑把所有未匹配请求都返回了 200 + 首页，这本身就是一条
// 强特征：任何自动化检查随机试几个路径，看到清一色 200，就能判断这不是
// 真实业务系统。这里改为规范的 404 / 405。
// ====================================================================

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

// 公共头部集合与正常响应同源
const { sendHtmlNoStore } = require('./http-response');

// 与看板共用同一套内联样式，保证错误页和正常页是同一个"站点"
const PAGE_STYLE = `
    * { box-sizing: border-box; }
    body { margin: 0; padding: 32px; background: #f8fafc; color: #334155;
           font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                        "Hiragino Sans GB", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif; }
    .wrap { max-width: 720px; margin: 64px auto; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px;
            box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); overflow: hidden; }
    .bar { display: flex; align-items: center; gap: 16px; padding: 20px 32px;
           border-bottom: 1px solid #e2e8f0; }
    .logo { width: 40px; height: 40px; background: #2563eb; border-radius: 6px;
            display: flex; align-items: center; justify-content: center;
            color: #fff; font-weight: 700; font-size: 18px; }
    .brand { font-weight: 700; color: #1e293b; font-size: 15px; }
    .sub { font-size: 12px; color: #64748b; }
    .body { padding: 40px 32px; }
    .code { font-size: 56px; font-weight: 700; color: #cbd5e1; line-height: 1; margin-bottom: 8px; }
    h1 { margin: 0 0 12px; font-size: 20px; color: #1e293b; }
    p { margin: 0 0 8px; font-size: 14px; color: #64748b; line-height: 1.7; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px;
           font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: #334155; }
    .actions { margin-top: 28px; display: flex; gap: 12px; }
    a.btn { display: inline-block; padding: 9px 18px; border-radius: 6px; font-size: 14px;
            font-weight: 600; text-decoration: none; background: #2563eb; color: #fff; }
    a.btn.ghost { background: #fff; color: #334155; border: 1px solid #e2e8f0; }
    .foot { margin-top: 24px; text-align: center; font-size: 12px; color: #94a3b8; }
`;

// 错误页与看板共用同一个渲染壳，避免出现"两个不同风格的站点"。
// buildErrorHtml 是纯函数（不接触 res），供 gateway 的路由决策复用；
// renderShell 在其之上补公共头部并写出。
function buildErrorHtml(status, { code, heading, lines, actions = [] }) {
    const body = lines.map((l) => '            <p>' + l + '</p>').join('\n');
    const actionsHtml = actions.length
        ? '            <div class="actions">\n' +
          actions.map((a) => '                <a class="btn' + (a.ghost ? ' ghost' : '') +
              '" href="' + esc(a.href) + '">' + esc(a.label) + '</a>').join('\n') +
          '\n            </div>'
        : '';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>${esc(code)} ${esc(heading)} | 库存同步系统</title>
    <style>${PAGE_STYLE}    </style>
</head>
<body>
    <div class="wrap">
        <div class="card">
            <div class="bar">
                <div class="logo">ERP</div>
                <div>
                    <div class="brand">库存实时同步系统</div>
                    <div class="sub">Real-time Inventory Synchronization</div>
                </div>
            </div>
            <div class="body">
                <div class="code">${esc(code)}</div>
                <h1>${esc(heading)}</h1>
${body}
${actionsHtml}
            </div>
        </div>
        <div class="foot">Inventory Synchronization Platform</div>
    </div>
</body>
</html>
`;
}

function renderShell(res, status, opts) {
    const html = buildErrorHtml(status, opts);
    // 走 http-response 的公共写出：补 Server / 安全头 / Content-Length，
    // 与正常响应（含 upgrade 回退层）完全同源，不留下"错误页少几个头"的差异。
    sendHtmlNoStore(res, status, html);
}

// 404：路径不存在。不回显请求路径——回显会让人以为系统在"回应探测"，
// 真实站点的 404 通常也不需要告诉访客他访问了什么。
function renderNotFound(res) {
    renderShell(res, 404, {
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

// 405：路径存在但方法不允许，必须带 Allow 头（RFC 9110 §15.5.6）
function renderMethodNotAllowed(res, allowed) {
    res.setHeader('Allow', allowed.join(', '));
    renderShell(res, 405, {
        code: '405',
        heading: '请求方法不被允许',
        lines: [
            '该地址不支持当前使用的请求方法。',
            '允许的方法：<code>' + esc(allowed.join(', ')) + '</code>'
        ],
        actions: [{ label: '返回首页', href: '/' }]
    });
}

// 400：请求本身无法被解析（畸形请求行、非法头、裸 LF 换行等）。
//
// 这个页面存在的唯一理由是**保持响应外观一致**：Node 内核在解析失败时会
// 抢在应用层之前直接写出一段裸响应——
//
//     HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n
//
// 没有 Server 头、没有 Date、没有正文。而站点其余所有响应都自称
// nginx/1.24.0 并带完整头部集合，于是"畸形请求"成了一个可观测的特征：
// 探测者发一个畸形请求，看 400 有没有 Server 头，就能把本服务与真实
// nginx 区分开。
//
// 修法是注册 server.on('clientError')（见 lib/business/gateway-worker.js），
// 用本函数渲染与其它错误页同源的外观，抢先于内核默认行为写出。
//
// 文案刻意不透露解析细节——回显"哪一行解析失败"等于告诉探测者这里
// 有一个自定义的解析器，真实 nginx 也不会这么做。
function buildBadRequestHtml() {
    return buildErrorHtml(400, {
        code: '400',
        heading: '请求无法处理',
        lines: [
            '服务器无法理解本次请求的格式。',
            '请检查客户端配置后重试。'
        ],
        actions: [{ label: '返回首页', href: '/' }]
    });
}

// 431：请求头过大（Node 内核的 HPE_HEADER_OVERFLOW）。
//
// 与 400 分开处理是必要的：真实 nginx 对超大头部返回 431 而非 400，
// 统一返回 400 反而偏离了所声明的身份。RFC 6585 §5 定义了该状态码。
function buildHeaderTooLargeHtml() {
    return buildErrorHtml(431, {
        code: '431',
        heading: '请求头过大',
        lines: [
            '本次请求携带的头部超过了服务器允许的上限。',
            '请减少请求头大小后重试。'
        ],
        actions: [{ label: '返回首页', href: '/' }]
    });
}

module.exports = {
    renderNotFound,
    renderMethodNotAllowed,
    buildBadRequestHtml,
    buildHeaderTooLargeHtml,
    buildErrorHtml
};
