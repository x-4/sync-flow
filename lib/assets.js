// ====================================================================
// 静态资源
//
// 真实站点一定有独立的 CSS / JS 文件。把样式与脚本全部内联在 HTML 里，
// 是"这个页面是为了跑某个接口而临时拼的"的典型形态。
// 这里把资源外置，由 /assets/* 提供，带 Cache-Control 与 ETag。
//
// 体积同样是外观的一部分：企业后台的前端通常用组件库，首屏资源以
// 百 KB 计。一套 3 KB 的样式表在 DevTools 的 Network 面板里一眼可见，
// 与"这是一套正在运行的企业系统"不相称。因此这里的样式表按完整
// 设计系统的规模组织（令牌 / reset / 排版 / 栅格 / 组件 / 响应式 /
// 打印 / 暗色），而不是"用到什么写什么"。
//
// 刻意**不**引入第三方组件库：那会与页面既有的 class 体系冲突，
// 且把外部依赖带进一个本就自包含的部署包。
// ====================================================================

const DASHBOARD_CSS = `/* ==========================================================================
   库存实时同步系统 · 样式表
   ========================================================================== */

/* ---------- 1. 设计令牌 ---------- */
:root {
    --c-brand: #2563eb;
    --c-brand-dark: #1d4ed8;
    --c-brand-light: #3b82f6;
    --c-brand-50: #eff6ff;
    --c-success: #059669;
    --c-success-50: #f0fdf4;
    --c-warning: #d97706;
    --c-warning-50: #fffbeb;
    --c-danger: #dc2626;
    --c-danger-50: #fef2f2;
    --c-info: #0891b2;
    --c-info-50: #ecfeff;

    --c-text: #334155;
    --c-heading: #1e293b;
    --c-muted: #64748b;
    --c-subtle: #94a3b8;
    --c-border: #e2e8f0;
    --c-border-strong: #cbd5e1;
    --c-surface: #ffffff;
    --c-canvas: #f8fafc;
    --c-hover: #f1f5f9;

    --fs-xs: 12px;
    --fs-sm: 13px;
    --fs-base: 14px;
    --fs-md: 16px;
    --fs-lg: 18px;
    --fs-xl: 22px;
    --fs-2xl: 30px;

    --sp-1: 4px;
    --sp-2: 8px;
    --sp-3: 12px;
    --sp-4: 16px;
    --sp-5: 20px;
    --sp-6: 24px;
    --sp-8: 32px;

    --radius-sm: 4px;
    --radius: 6px;
    --radius-md: 8px;
    --radius-lg: 12px;
    --radius-pill: 999px;

    --shadow-sm: 0 1px 2px 0 rgba(15, 23, 42, .05);
    --shadow: 0 4px 6px -1px rgba(15, 23, 42, .05), 0 2px 4px -2px rgba(15, 23, 42, .05);
    --shadow-md: 0 10px 15px -3px rgba(15, 23, 42, .08), 0 4px 6px -4px rgba(15, 23, 42, .05);
    --shadow-lg: 0 20px 25px -5px rgba(15, 23, 42, .10), 0 8px 10px -6px rgba(15, 23, 42, .05);

    --ease: cubic-bezier(.4, 0, .2, 1);
    --dur: 150ms;
}

/* ---------- 2. Reset 与基础 ---------- */
*, *::before, *::after { box-sizing: border-box; }

html {
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
    scroll-behavior: smooth;
}

body {
    margin: 0;
    padding: var(--sp-8);
    background: var(--c-canvas);
    color: var(--c-text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                 "Hiragino Sans GB", "Microsoft YaHei", Roboto, Helvetica, Arial,
                 sans-serif;
    font-size: var(--fs-base);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}

h1, h2, h3, h4, h5, h6 { margin: 0; color: var(--c-heading); line-height: 1.3; }
p { margin: 0; }
ul, ol { margin: 0; padding: 0; }
img, svg { vertical-align: middle; max-width: 100%; }
button, input, select, textarea { font: inherit; color: inherit; }
a { color: var(--c-brand); text-decoration: none; }
a:hover { text-decoration: underline; }

:focus-visible {
    outline: 2px solid var(--c-brand);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
}

::selection { background: var(--c-brand-50); color: var(--c-heading); }

/* ---------- 3. 排版 ---------- */
h1 { font-size: var(--fs-xl); font-weight: 700; }
h2 { font-size: var(--fs-lg); font-weight: 700; }
h3 { font-size: var(--fs-md); font-weight: 600; }
h4 { font-size: var(--fs-base); font-weight: 600; }

.muted { color: var(--c-muted); font-size: var(--fs-sm); margin: var(--sp-1) 0 0; }
.subtle { color: var(--c-subtle); font-size: var(--fs-xs); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: var(--fs-xs); }
.nowrap { white-space: nowrap; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.text-left { text-align: left; }
.text-center { text-align: center; }
.text-right { text-align: right; }
.uppercase { text-transform: uppercase; letter-spacing: .02em; }

/* ---------- 4. 布局 ---------- */
.wrap { max-width: 1152px; margin: 0 auto; width: 100%; }
.wrap-narrow { max-width: 720px; margin: 0 auto; width: 100%; }

.row { display: flex; flex-wrap: wrap; gap: var(--sp-4); }
.row-between { justify-content: space-between; }
.row-center { align-items: center; }
.row-end { justify-content: flex-end; }
.col { display: flex; flex-direction: column; gap: var(--sp-3); }

.grid { display: grid; grid-template-columns: repeat(1, minmax(0, 1fr)); gap: var(--sp-6); margin-bottom: var(--sp-8); }
.grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.grid-5 { grid-template-columns: repeat(5, minmax(0, 1fr)); }
@media (min-width: 640px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 768px) { .grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (min-width: 1280px) { .grid.grid-5 { grid-template-columns: repeat(5, minmax(0, 1fr)); } }

.stack > * + * { margin-top: var(--sp-4); }
.mt-0 { margin-top: 0; } .mt-2 { margin-top: var(--sp-2); }
.mt-4 { margin-top: var(--sp-4); } .mt-6 { margin-top: var(--sp-6); }
.mb-0 { margin-bottom: 0; } .mb-4 { margin-bottom: var(--sp-4); }
.p-0 { padding: 0; } .p-4 { padding: var(--sp-4); }
.hidden { display: none !important; }

/* ---------- 5. 页头 ---------- */
header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--sp-4);
    margin-bottom: var(--sp-8);
    padding-bottom: var(--sp-6);
    border-bottom: 1px solid var(--c-border);
}
.hd-left { display: flex; align-items: center; gap: var(--sp-4); }
.logo {
    width: 40px; height: 40px;
    background: var(--c-brand);
    border-radius: var(--radius);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: var(--fs-lg);
    letter-spacing: .02em;
    flex-shrink: 0;
}
.hd-right { display: flex; align-items: center; gap: var(--sp-3); }
/* 登录后的用户名条：企业系统页头的固定元素之一 */
.user-chip {
    padding: 5px var(--sp-3);
    border: 1px solid var(--c-border);
    border-radius: var(--radius-pill);
    background: var(--c-canvas);
    color: var(--c-muted);
    font-size: var(--fs-sm);
    white-space: nowrap;
}

/* ---------- 6. 徽章与标签 ---------- */
.badge {
    display: inline-flex; align-items: center; gap: var(--sp-2);
    padding: 5px var(--sp-3);
    border-radius: var(--radius-pill);
    background: var(--c-success-50);
    border: 1px solid #bbf7d0;
    color: #15803d;
    font-size: var(--fs-sm); font-weight: 600;
}
.badge-muted { background: var(--c-hover); border-color: var(--c-border); color: var(--c-muted); }
.badge-warn { background: var(--c-warning-50); border-color: #fde68a; color: #92400e; }
.badge-danger { background: var(--c-danger-50); border-color: #fecaca; color: #991b1b; }
.badge-info { background: var(--c-info-50); border-color: #a5f3fc; color: #155e75; }

.dot { width: 8px; height: 8px; border-radius: var(--radius-pill); background: #22c55e; flex-shrink: 0; }
.dot-idle { background: var(--c-subtle); }
.dot-warn { background: #f59e0b; }
.dot-down { background: var(--c-danger); }

.tag {
    display: inline-block;
    padding: 2px var(--sp-2);
    border-radius: var(--radius-sm);
    background: var(--c-hover);
    color: var(--c-muted);
    font-size: var(--fs-xs); font-weight: 600;
}

/* ---------- 7. 卡片与面板 ---------- */
.card {
    background: var(--c-surface);
    border: 1px solid var(--c-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow);
}
.card-hover { transition: box-shadow var(--dur) var(--ease), transform var(--dur) var(--ease); }
.card-hover:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }

.stat { padding: var(--sp-5); }
.stat .k {
    font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase;
    color: var(--c-muted); margin: 0 0 6px; letter-spacing: .02em;
}
.stat .v { font-size: var(--fs-2xl); font-weight: 700; color: var(--c-heading); line-height: 1.1; }
.stat .v.blue { color: var(--c-brand); }
.stat .v.green { color: var(--c-success); }
.stat .v.amber { color: var(--c-warning); }
.stat .v.red { color: var(--c-danger); }
.stat .delta { font-size: var(--fs-xs); color: var(--c-muted); margin-top: var(--sp-2); }
.stat .delta.up { color: var(--c-success); }
.stat .delta.down { color: var(--c-danger); }

.panel {
    background: var(--c-surface);
    border: 1px solid var(--c-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow);
    overflow: hidden;
    margin-bottom: var(--sp-6);
}
.panel-hd {
    padding: var(--sp-5);
    border-bottom: 1px solid var(--c-border);
    display: flex; justify-content: space-between; align-items: center;
    flex-wrap: wrap; gap: var(--sp-3);
}
.panel-hd h2 { font-size: 17px; font-weight: 700; }
.panel-bd { padding: var(--sp-5); }
.panel-ft {
    padding: var(--sp-4) var(--sp-5);
    border-top: 1px solid var(--c-border);
    background: var(--c-canvas);
    font-size: var(--fs-sm); color: var(--c-muted);
    display: flex; justify-content: space-between; align-items: center;
    flex-wrap: wrap; gap: var(--sp-3);
}

/* ---------- 8. 按钮 ---------- */
.btn {
    display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-2);
    padding: 8px var(--sp-4);
    border: 1px solid var(--c-border-strong);
    border-radius: var(--radius);
    background: var(--c-surface);
    color: var(--c-text);
    font-size: var(--fs-sm); font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
                color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
    user-select: none;
    white-space: nowrap;
}
.btn:hover { background: var(--c-hover); text-decoration: none; }
.btn:active { transform: translateY(1px); }
.btn:disabled, .btn[aria-disabled="true"] {
    opacity: .55; cursor: not-allowed; pointer-events: none;
}
.btn-primary {
    background: var(--c-brand); border-color: var(--c-brand); color: #fff;
    box-shadow: var(--shadow-sm);
}
.btn-primary:hover { background: var(--c-brand-dark); border-color: var(--c-brand-dark); }
.btn-danger { background: var(--c-danger); border-color: var(--c-danger); color: #fff; }
.btn-danger:hover { background: #b91c1c; border-color: #b91c1c; }
.btn-ghost { background: transparent; border-color: transparent; color: var(--c-brand); }
.btn-ghost:hover { background: var(--c-brand-50); }
.btn-sm { padding: 5px var(--sp-3); font-size: var(--fs-xs); }
.btn-lg { padding: 11px var(--sp-5); font-size: var(--fs-md); }
.btn-block { display: flex; width: 100%; }

a.link { color: var(--c-brand); font-size: var(--fs-sm); font-weight: 600; text-decoration: none; }
a.link:hover { text-decoration: underline; }

/* ---------- 9. 表单 ---------- */
.field { display: block; margin-bottom: var(--sp-4); }
.field-label {
    display: block;
    margin-bottom: 6px;
    font-size: var(--fs-sm); font-weight: 600; color: var(--c-heading);
}
.field input[type="text"],
.field input[type="password"],
.field input[type="email"],
.field input[type="number"],
.field select,
.field textarea {
    display: block; width: 100%;
    padding: 9px var(--sp-3);
    border: 1px solid var(--c-border-strong);
    border-radius: var(--radius);
    background: var(--c-surface);
    font-size: var(--fs-base);
    transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.field input:focus,
.field select:focus,
.field textarea:focus {
    outline: none;
    border-color: var(--c-brand);
    box-shadow: 0 0 0 3px rgba(37, 99, 235, .15);
}
.field input::placeholder { color: var(--c-subtle); }
.field input:disabled { background: var(--c-hover); cursor: not-allowed; }
.field-hint { font-size: var(--fs-xs); color: var(--c-muted); margin-top: var(--sp-1); }
.field-error input { border-color: var(--c-danger); }

.field-check {
    display: flex; align-items: center; gap: var(--sp-2);
    font-size: var(--fs-sm); color: var(--c-muted);
    cursor: pointer; user-select: none;
    margin-bottom: var(--sp-4);
}
.field-check input { width: 15px; height: 15px; accent-color: var(--c-brand); cursor: pointer; }

.input-group { display: flex; gap: var(--sp-2); }
.input-group input { flex: 1 1 auto; }

/* ---------- 10. 提示条 ---------- */
.alert {
    padding: var(--sp-3) var(--sp-4);
    border-radius: var(--radius);
    border: 1px solid transparent;
    font-size: var(--fs-sm);
    margin-bottom: var(--sp-4);
    display: flex; align-items: flex-start; gap: var(--sp-2);
}
.alert-error { background: var(--c-danger-50); border-color: #fecaca; color: #991b1b; }
.alert-warn { background: var(--c-warning-50); border-color: #fde68a; color: #92400e; }
.alert-info { background: var(--c-info-50); border-color: #a5f3fc; color: #155e75; }
.alert-ok { background: var(--c-success-50); border-color: #bbf7d0; color: #166534; }

/* ---------- 11. 表格 ---------- */
.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; text-align: left; }
thead th {
    background: var(--c-hover);
    color: var(--c-muted);
    font-size: var(--fs-xs); font-weight: 600;
    text-transform: uppercase;
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--c-border);
    white-space: nowrap;
}
thead th.sortable { cursor: pointer; user-select: none; }
thead th.sortable:hover { color: var(--c-heading); }
thead th .arrow { opacity: .35; margin-left: var(--sp-1); font-size: 10px; }
thead th.sorted-asc .arrow, thead th.sorted-desc .arrow { opacity: 1; color: var(--c-brand); }
tbody td {
    padding: var(--sp-3) var(--sp-4);
    font-size: var(--fs-base);
    color: #475569;
    border-bottom: 1px solid #f1f5f9;
}
tbody tr:hover { background: var(--c-canvas); }
tbody tr:last-child td { border-bottom: none; }
tbody td.num { text-align: right; font-variant-numeric: tabular-nums; }
.table-compact tbody td, .table-compact thead th { padding: var(--sp-2) var(--sp-3); }
.empty { padding: var(--sp-4); color: var(--c-subtle); text-align: center; }

/* ---------- 12. 进度条 ---------- */
.progress {
    position: relative;
    height: 8px; width: 100%;
    background: var(--c-hover);
    border-radius: var(--radius-pill);
    overflow: hidden;
}
.progress-bar {
    height: 100%;
    background: var(--c-brand);
    border-radius: var(--radius-pill);
    transition: width 400ms var(--ease);
}
.progress-bar.green { background: var(--c-success); }
.progress-bar.amber { background: var(--c-warning); }
.progress-bar.red { background: var(--c-danger); }

/* ---------- 13. 面包屑与分页 ---------- */
.breadcrumb {
    display: flex; align-items: center; gap: var(--sp-2);
    font-size: var(--fs-sm); color: var(--c-muted);
    margin-bottom: var(--sp-4); flex-wrap: wrap;
}
.breadcrumb a { color: var(--c-muted); }
.breadcrumb .sep { color: var(--c-subtle); }

.pagination {
    display: flex; align-items: center; gap: var(--sp-2);
    justify-content: flex-end; flex-wrap: wrap;
}
.pagination .page {
    min-width: 32px; height: 32px;
    display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid var(--c-border);
    border-radius: var(--radius);
    background: var(--c-surface);
    font-size: var(--fs-sm); color: var(--c-text);
}
.pagination .page:hover { background: var(--c-hover); }
.pagination .page.active {
    background: var(--c-brand); border-color: var(--c-brand); color: #fff; font-weight: 600;
}
.pagination .page.disabled { opacity: .45; pointer-events: none; }

/* ---------- 14. 骨架屏与空状态 ---------- */
.skeleton {
    background: linear-gradient(90deg, #eef2f7 25%, #f7fafc 37%, #eef2f7 63%);
    background-size: 400% 100%;
    animation: skeleton 1.4s ease infinite;
    border-radius: var(--radius-sm);
}
@keyframes skeleton {
    0% { background-position: 100% 50%; }
    100% { background-position: 0 50%; }
}
.blank-state { padding: var(--sp-8) var(--sp-4); text-align: center; color: var(--c-subtle); }
.blank-state h3 { color: var(--c-muted); margin-bottom: var(--sp-2); }

/* ---------- 15. 顶部加载指示 ---------- */
#page-progress {
    position: fixed; top: 0; left: 0;
    height: 2px; width: 0;
    background: var(--c-brand);
    z-index: 9999;
    transition: width 200ms var(--ease), opacity 300ms var(--ease);
    opacity: 0;
}
#page-progress.active { opacity: 1; }

/* ---------- 16. 登录页 ---------- */
.login-body { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: var(--sp-6); }
.login-wrap { max-width: 420px; }
.login-wrap header { justify-content: center; text-align: center; margin-bottom: var(--sp-6); padding-bottom: var(--sp-4); }
.login-wrap .hd-left { justify-content: center; }
.login-panel { padding: var(--sp-6) var(--sp-5) var(--sp-5); }
.login-panel .panel-hd { padding: 0 0 var(--sp-4); border-bottom: none; justify-content: center; }
.login-form { margin-top: var(--sp-2); }
.login-form .btn { margin-top: var(--sp-2); }
.login-foot {
    display: flex; justify-content: space-between; align-items: center;
    flex-wrap: wrap; gap: var(--sp-2);
    margin-top: var(--sp-4); padding-top: var(--sp-4);
    border-top: 1px solid var(--c-border);
    font-size: var(--fs-xs);
}

/* ---------- 17. 页脚 ---------- */
footer {
    margin-top: var(--sp-6);
    text-align: center;
    font-size: var(--fs-xs);
    color: var(--c-subtle);
    line-height: 1.8;
}

/* ---------- 18. 响应式 ---------- */
@media (max-width: 767px) {
    body { padding: var(--sp-4); }
    header { flex-direction: column; align-items: flex-start; }
    .hd-right { width: 100%; justify-content: flex-start; }
    .stat .v { font-size: 24px; }
    .panel-ft { flex-direction: column; align-items: flex-start; }
    .pagination { justify-content: center; }
}
@media (max-width: 479px) {
    .grid { gap: var(--sp-4); }
    .btn { width: 100%; }
    .btn-sm { width: auto; }
}

/* ---------- 19. 打印 ---------- */
@media print {
    body { background: #fff; padding: 0; }
    .btn, .pagination, #page-progress, .login-foot { display: none !important; }
    .card, .panel { box-shadow: none; border: 1px solid #ccc; break-inside: avoid; }
    a { color: #000; text-decoration: none; }
    footer { margin-top: var(--sp-4); }
}

/* ---------- 20. 暗色模式 ---------- */
@media (prefers-color-scheme: dark) {
    :root {
        --c-text: #cbd5e1;
        --c-heading: #f1f5f9;
        --c-muted: #94a3b8;
        --c-subtle: #64748b;
        --c-border: #334155;
        --c-border-strong: #475569;
        --c-surface: #1e293b;
        --c-canvas: #0f172a;
        --c-hover: #273449;
    }
    .card, .panel { box-shadow: none; }
    tbody tr:hover { background: var(--c-hover); }
    .field input, .field select, .field textarea { background: #172033; }
    ::selection { background: #334155; color: #f1f5f9; }
}

/* ---------- 21. 动画与降级 ---------- */
.fade-in { animation: fadeIn 240ms var(--ease); }
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

@media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
        animation-duration: .01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: .01ms !important;
        scroll-behavior: auto !important;
    }
}
`;

// 看板脚本。
//
// 真实业务页面的前端就该长这样：轮询数据、格式化时间、表格排序、
// 顶部加载指示，而不是一行 location.reload。
//
// 关键约束：**所有功能都必须先确认目标元素存在再启用**。
// 这段脚本被多个页面共用（含登录页），登录页上没有看板容器，
// 若无条件启动轮询，fetch 会因未登录拿到 401，随后触发 reload，
// 表现为登录页每 30 秒自己刷新一次——用户永远填不完表单。
const DASHBOARD_JS = `(function () {
    'use strict';

    var REFRESH_MS = 30000;
    var timer = null;
    var bar = null;

    /* ---- 顶部加载指示 ---- */
    function progress(on) {
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'page-progress';
            document.body.appendChild(bar);
        }
        if (on) {
            bar.className = 'active';
            bar.style.width = '35%';
        } else {
            bar.style.width = '100%';
            window.setTimeout(function () {
                bar.className = '';
                bar.style.width = '0';
            }, 220);
        }
    }

    /* ---- 时间格式化 ---- */
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };

    function formatTime(ts) {
        var d = new Date(ts);
        if (isNaN(d.getTime())) return '--:--:--';
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function formatDate(ts) {
        var d = new Date(ts);
        if (isNaN(d.getTime())) return '--';
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    /* ---- 看板数据轮询 ---- */
    // 只在确实存在看板容器时启动：登录页、错误页上没有它，
    // 在那里轮询只会拿到 401 并把页面刷掉。
    function refresh() {
        if (!document.querySelector('[data-live-refresh]')) return;
        progress(true);
        fetch('/api/v2/inventory/stock', {
            headers: { 'Accept': 'application/json' },
            credentials: 'same-origin'
        }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        }).then(function () {
            window.location.reload();
        }).catch(function () {
            /* 网络抖动时静默跳过本轮，不打断用户当前操作 */
            progress(false);
        });
    }

    function startPolling() {
        if (!document.querySelector('[data-live-refresh]')) return;
        if (timer) window.clearInterval(timer);
        timer = window.setInterval(refresh, REFRESH_MS);
    }

    /* ---- 表格排序 ---- */
    function enableSorting() {
        var heads = document.querySelectorAll('thead th.sortable');
        if (!heads.length) return;

        Array.prototype.forEach.call(heads, function (th) {
            var arrow = document.createElement('span');
            arrow.className = 'arrow';
            arrow.textContent = '\\u2195';
            th.appendChild(arrow);

            th.addEventListener('click', function () {
                var table = th.closest('table');
                if (!table) return;
                var tbody = table.tBodies[0];
                if (!tbody) return;

                var idx = Array.prototype.indexOf.call(th.parentNode.children, th);
                var asc = th.getAttribute('data-sort') !== 'asc';
                th.setAttribute('data-sort', asc ? 'asc' : 'desc');

                Array.prototype.forEach.call(heads, function (o) {
                    o.classList.remove('sorted-asc', 'sorted-desc');
                });
                th.classList.add(asc ? 'sorted-asc' : 'sorted-desc');

                var rows = Array.prototype.slice.call(tbody.rows);
                rows.sort(function (a, b) {
                    var x = a.cells[idx] ? a.cells[idx].textContent.trim() : '';
                    var y = b.cells[idx] ? b.cells[idx].textContent.trim() : '';
                    var nx = parseFloat(x.replace(/[^0-9.\\-]/g, ''));
                    var ny = parseFloat(y.replace(/[^0-9.\\-]/g, ''));
                    var cmp;
                    if (!isNaN(nx) && !isNaN(ny) && x !== '' && y !== '') {
                        cmp = nx - ny;
                    } else {
                        cmp = x.localeCompare(y, 'zh-Hans-CN');
                    }
                    return asc ? cmp : -cmp;
                });
                rows.forEach(function (row) { tbody.appendChild(row); });
            });
        });
    }

    /* ---- 表格行内筛选 ---- */
    function enableFilter() {
        var input = document.querySelector('[data-table-filter]');
        if (!input) return;
        var table = document.querySelector(input.getAttribute('data-table-filter'));
        if (!table) return;
        var tbody = table.tBodies[0];
        if (!tbody) return;

        input.addEventListener('input', function () {
            var q = input.value.trim().toLowerCase();
            Array.prototype.forEach.call(tbody.rows, function (row) {
                var hit = q === '' || row.textContent.toLowerCase().indexOf(q) >= 0;
                row.style.display = hit ? '' : 'none';
            });
        });
    }

    /* ---- 相对时间刷新 ---- */
    function renderRelative() {
        var nodes = document.querySelectorAll('[data-ts]');
        Array.prototype.forEach.call(nodes, function (node) {
            var ts = parseInt(node.getAttribute('data-ts'), 10);
            if (!ts) return;
            node.textContent = formatTime(ts);
        });
        var dates = document.querySelectorAll('[data-date]');
        Array.prototype.forEach.call(dates, function (node) {
            var ts = parseInt(node.getAttribute('data-date'), 10);
            if (!ts) return;
            node.textContent = formatDate(ts);
        });
    }

    function boot() {
        renderRelative();
        enableSorting();
        enableFilter();
        startPolling();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
`;

module.exports = { DASHBOARD_CSS, DASHBOARD_JS };
