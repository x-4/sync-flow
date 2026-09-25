// ====================================================================
// Serverless 适配层（Vercel / Netlify / 其他 Node Serverless 平台）
//
// 背景：supervisor.js 是**常驻服务**入口——它拉起四个业务子进程。
// Serverless 平台不要这种入口，它要的是一个"收到请求就调用"的 handler：
//
//     module.exports = (req, res) => { ... }
//
// ── 为什么本文件导出的是 http.Server 而不是请求处理器 ───────────────
//
// 这是本项目踩过的第二个坑，且代价是"节点连不上"，记录在此以免回退：
//
// 增量同步通道（WebSocket）不是 HTTP 层的东西。它在 Node 里靠
// `server.on('upgrade', ...)` 接管——请求到达时不走 req/res 处理器，
// 而是由 http.Server 直接把 socket 交给 WS 层完成 101 握手。
//
// 早期本文件导出的是 `createRequestHandler()`，即一个普通
// `(req, res) => ...` 函数。后果是：平台把 upgrade 请求当普通 GET
// 交给这个函数，没有人监听 'upgrade'，握手无从发生，请求只能落到
// HTTP 路由表里的 426 分支。表现为：
//
//   GET /api/v2/inventory/live-stream  ->  426 Upgrade Required
//
// 而业务表现层（页面、API、报表、安全头、错误页）一切正常——因为那些
// 本来就走 req/res。故障因此极其隐蔽：看页面完全正常，只有长连接
// 永远建不起来，日志里除了 426 什么都没有。
//
// 正确做法与平台官方要求一致：把 **http.Server 实例**导出。
// 平台检测到导出对象是 server 时，会用它处理包括 upgrade 在内的
// 全部连接，'upgrade' 事件因此能被 attachSync 注册的监听器接管。
//
// 关键约束：**不要调用 server.listen()**。端口由平台注入并管理，
// server 只负责"拿到请求怎么处理"。这一点与常驻部署（gateway-worker.js
// 里显式 listen）是两回事，不要照搬。
//
// ── 为什么常驻入口叫 supervisor.js 而不是 server.js ───────────────
//
// Vercel 的框架检测器把「根目录存在 server.js / server.cjs / server.mjs
// / server.ts」当作 **Node 框架** 的判据（见 @vercel/frameworks 的
// Node 定义：detectors.some = [{ path: 'server.js' }, ...]）。
//
// 一旦命中 Node 框架，构建器会改用 `@vercel/backends` 处理整个项目，
// 并且该框架定义里写着：
//
//     ignoreRuntimes: ['@vercel/node']
//
// 而 `@vercel/node` 正是负责把 api/ 目录构建成 Serverless Function 的
// runtime。它被忽略之后，api/index.js **不再被当作函数**，项目被整体
// 按"一个 Node 服务"部署——也就是把 supervisor.js 当成服务入口拉起，
// 连带 fork 出四个业务子进程。
//
// 那些子进程的 require('../config') 落在函数打包边界之外，于是平台日志里
// 刷出：
//
//     Error: Cannot find module '../config'
//     Require stack:
//     - /var/task/lib/business/report-worker.js
//
// 换名之后根目录不再有 server.js，Node 框架检测器不命中，api/index.js
// 才会被 @vercel/node 正常处理。改名不是审美选择，是这个平台的硬约束。
// ====================================================================

// Node 内置模块。放在这里是刻意的：http 不读取业务配置，
// 因此它的加载不受下面"环境兜底必须先于 config"的约束，
// 提前引入可以让"本文件要构造一个 http.Server"这件事在开头就可见。
const http = require('http');

// ── 第 0 步：形态标记（必须在 require config 之前）────────────────
//
// lib/config.js 在**模块加载时**就把运行形态与配置一次性固化，
// 之后再改 process.env 不会生效。因此这个标记必须在 require 之前写下。
//
// 为什么还需要它：存储驱动、进程编排、可写目录这三项原本由本文件在
// require config 之前**改写环境变量**来兜底（STORAGE_DRIVER=memory /
// SINGLE_PROCESS=1 / DATA_DIR=$TMPDIR/…）。它们随本轮精简固化成常量
// 之后，那条路走不通了，兜底下沉到 lib/config.js：由平台注入的变量
// 推导形态，再由形态推导这三项取值。
//
// 那为什么这里还要写一个标记：平台标识没有统一标准，Vercel / Lambda /
// Netlify / CF Pages 各用各的变量名，而未知平台一个都不设。本标记是
// "本进程走的是 serverless 适配层"这件事的自证，覆盖那些不设置任何
// 已知平台变量的环境。
//
// 为什么需要兜底而不是"让用户记得配"：
//   serverless 的运行环境有两条与常驻部署不同的硬约束——
//     · 文件系统通常只读（/var/task），除 /tmp 外不可写
//     · 没有长期存活的进程，fork 出的子进程不会在请求之间保留
//   若判断错了，服务会以 fs 驱动 + fork 模式的默认配置启动：读盘失败、
//   后台任务不运行。这类失败是**静默降级**（页面照常、数据陈旧），
//   比启动报错更难排查。因此由代码按形态推导，不交给人的记忆。
process.env.__AETHER_SERVERLESS = '1';

// ── 第 1 步：全局异常兜底（必须早于业务模块加载）─────────────────
//
// 为什么放在这里而不是等业务模块加载完：
//   模块加载期本身就可能抛（配置校验失败、vendor 初始化异常）。
//   若兜底晚于 require，这类异常会直接带崩函数实例，表现为
//   "部署成功但每次调用都 500"，且日志里只有一行内部堆栈。
//
// 为什么只记录不退出：
//   serverless 实例是复用的。一次未捕获异常若导致进程退出，
//   平台会冷启动新实例，代价是**同时断开该实例上承载的所有
//   长连接**——直接违反"客户端始终可连"这条底线。
//   这里与常驻部署（gateway-worker.js）保持同一策略：记录、继续服务。
//
// logger 是零依赖模块（只用 node:util），因此可以安全地提前加载。
const logger = require('../lib/logger');

process.on('uncaughtException', (err) => {
    logger.error('Uncaught sync error', {
        errorName: err && err.name,
        errorMessage: err && err.message,
        stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : null
    });
});

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
        errorName: reason instanceof Error ? reason.name : null,
        errorMessage: reason instanceof Error ? reason.message : String(reason).slice(0, 200)
    });
});

// ── 第 2 步：加载配置与业务模块 ────────────────────────────────
//
// 加载顺序是**硬约束**，不是风格问题：
//
//   lib/gateway.js 在模块加载时通过 route() 把路由表填满；
//   lib/sync/index.js 的 attachSync() 启动时会断言路由表非空
//   （为空则拒绝挂载并退出）。
//
// 因此必须先 require gateway，再 require sync-core。顺序颠倒会让
// 端点池判定退化成"全部落 404"——那种故障的表现是"页面正常、
// 但客户端连不上"，排查成本极高。这里用注释把顺序固化下来。
const CONFIG = require('../lib/config');
const { createRequestHandler } = require('../lib/gateway');
const { attachSync } = require('../lib/sync-core');
const { attachClientErrorHandler } = require('../lib/client-error');
const snapshotCache = require('../lib/snapshot-cache');

// 冷启动时预热快照缓存：让首个请求不必等模型加载。
// 失败不影响功能——首个真实请求会自行触发加载。
try {
    snapshotCache.warmup();
} catch (_) { /* 预热是锦上添花，任何失败都不应阻断函数注册 */ }

// ── 第 3 步：构造 HTTP 服务并挂载同步通道 ──────────────────────
//
// HTTP 层与常驻部署**完全同源**：同一个 createRequestHandler()，
// 因此业务表现层（页面、API、报表、安全头、错误页）的行为与自建机
// 部署逐字一致，不存在"两套实现逐渐漂移"的问题。
//
// attachSync 在这里完成两件事：
//   1) 注册 server.on('upgrade', ...)，让 WS 握手有监听者；
//   2) 注册 'connection'，把建立后的通道交给数据面。
//
// 这两步在常驻部署里由 gateway-worker.js 做，本文件做的是同一件事
// 的 serverless 版本——不是另一套实现。
const server = http.createServer(createRequestHandler());
attachSync(server);

// 解析期错误响应。
//
// 常驻部署由 gateway-worker.js 挂同一个钩子（同一个模块、同一份实现），
// 这里补上是为了消除"换形态就换行为"的分叉：Node 内核对畸形请求
// （非法方法 / 缺冒号的头 / 裸 LF）会抢在应用层之前写出一段没有
// Server 头、没有正文的裸 400，而本站其余所有响应都自称 nginx/1.24.0
// 并带完整头部集合——这个反差是一条强特征，且与平台无关。
//
// 之前只在常驻 worker 上挂，等于"serverless 部署少一层一致性"，
// 排查时还会误判成平台差异。详见 lib/client-error.js 的模块注释。
//
// 顺序同样放在 attachSync 之后：upgrade 请求由 'upgrade' 事件直接接管，
// 不会进入解析期错误路径，两者互不干扰。
attachClientErrorHandler(server, (err, status) => {
    logger.error('clientError 响应写出失败', {
        status,
        errorMessage: err && err.message
    });
});

// ── 第 4 步：导出 ────────────────────────────────────────────────
//
// 导出 server 实例本身。平台据此接管全部连接（含 upgrade）。
// 部分平台按 ESM 约定取 default，因此一并挂上——server 是
// EventEmitter 实例，附加属性不影响其作为 http.Server 的语义。
//
// 注意：这里**不要** server.listen()。端口由平台注入，
// 自行 listen 会与平台管理的端口冲突，导致健康检查失败。
module.exports = server;
module.exports.default = server;

// ── 第 5 步：冷启动日志 ──────────────────────────────────────────
//
// 只报关键配置。这些值会出现在平台日志里，便于确认形态推导是否生效：
// store / singleProcess 由 lib/config.js 按形态推导，若 store 显示 fs
// 而部署目标是 serverless，说明形态判定没命中（平台未设置任何已知
// 平台变量、且本模块未被当作入口加载）。
//
// upgrade 一行是新增的关键可观测项：它明确报告"同步通道已挂载"。
// 排查"客户端连不上"时，先看这一行是否存在。
console.log('[serverless] adapter ready'
    + ' | detected=' + (CONFIG.SERVERLESS ? 'yes' : 'no')
    + ' | endpoint=' + CONFIG.SYNC_ENDPOINT
    + ' | store=' + CONFIG.STORAGE_DRIVER
    + ' | singleProcess=' + CONFIG.SINGLE_PROCESS
    + ' | upgrade=attached'
    + ' | port=' + CONFIG.PORT + ' (platform-injected)');
