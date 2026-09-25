// ====================================================================
// 网关进程
// 对外提供 HTTP 业务表面与增量同步通道（WebSocket）；
// 对内启动事件总线，接收缓存进程推送的库存快照。
// ====================================================================

process.title = 'erp-gateway';

const http = require('http');
const CONFIG = require('../config');
const { createRequestHandler } = require('../gateway');
const { attachSync } = require('../sync-core');
const { attachClientErrorHandler } = require('../client-error');
const snapshotCache = require('../snapshot-cache');
const { describeDatagram } = require('../telemetry');
const { startEventBus } = require('../event-bus');

// —— 兜底异常处理 ——
//
// 策略：只记录、不退出。理由：
//   1) fork 模式下 supervisor 会守护本进程，主动 exit 的收益只是
//      "换一个干净的堆"，但代价是把在途的合法连接（透传中的通道）
//      一起掐断——直接损害"客户端始终可连"这条底线；
//   2) exit 策略一旦写错（对可恢复错误也退出）会造成进程反复重启的
//      崩溃风暴，比异常本身更伤。待有真实故障案例再评估退出策略。
// 相比此前，这里改为结构化记录：级别 error、携带错误类型与堆栈摘要，
// 平台日志侧可直接按 level=error 检索。
const logger = require('../logger');

process.on('uncaughtException', (err) => logger.error('Uncaught sync error', {
    errorName: err && err.name,
    errorMessage: err && err.message,
    stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : null
}));
process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection', {
    errorName: reason instanceof Error ? reason.name : null,
    errorMessage: reason instanceof Error ? reason.message : String(reason).slice(0, 200)
}));

// —— 对外服务 ——
// 增量同步通道只挂在这个 server 上；事件总线那个 server 不挂，
// 因此两者在连接处理上完全隔离。
const server = http.createServer(createRequestHandler());
attachSync(server);

// 解析期错误响应。
//
// 不注册这个钩子时，Node 内核会对畸形请求直接写出一段**裸响应**
// （无 Server 头、无 Date、无正文），而本站其余所有响应都自称
// nginx/1.24.0 并带完整头部——这个反差是一条可观测的特征。
// 详见 lib/client-error.js 的模块注释。
//
// 顺序放在 attachSync 之后：upgrade 请求由 server 的 'upgrade' 事件
// 直接接管，不会进入解析期错误路径，两者互不干扰。
attachClientErrorHandler(server, (err, status) => {
    console.error('[SysLog] clientError 响应写出失败:', status, err && err.message);
});

// 预热业务快照缓存：启动后立即异步加载一次磁盘数据，
// 让首个页面请求不必承担冷启动等待（加载本身是异步的，不阻塞监听）。
snapshotCache.warmup();

// 监听失败处理。
//
// 为什么这里要**退出**，而上面的异常兜底却刻意不退出：
//   上面的策略是"保住已在服务的连接"，前提是进程已经能提供 service；
//   而 listen 失败意味着进程**从未成功提供过任何服务**——它继续存活
//   只会得到一个"进程在、端口不在"的僵尸：平台健康检查按进程存活判
//   定通过，于是故障既不报警也不自愈，比挂掉更难发现。
//
//   典型触发是 EADDRINUSE（端口被占 / 上次实例未退干净）。此时退出
//   才是正确动作：supervisor 有指数退避（3s 起步、60s 封顶，见
//   supervisor.js），退出不会造成崩溃风暴，反而让故障出现在日志里。
//
// 非监听类错误（运行期偶发的 server error）不在此分支：那些确实应
// 沿用"只记录、不退出"，因此只对致命码退出，其余留给后续处理。
server.on('error', (err) => {
    const code = err && err.code;
    logger.error('网关监听失败', {
        errorCode: code || null,
        errorMessage: err && err.message,
        port: CONFIG.PORT,
        listenHost: CONFIG.LISTEN_HOST || '(双栈默认)'
    });
    if (code === 'EADDRINUSE' || code === 'EACCES' || code === 'EADDRNOTAVAIL') {
        console.error('[FATAL] 无法监听 '
            + (CONFIG.LISTEN_HOST || '0.0.0.0') + ':' + CONFIG.PORT
            + ' —— ' + (code === 'EADDRINUSE' ? '端口已被占用' : '地址不可用或无权限')
            + '。进程退出，由上层按退避策略重启。');
        process.exit(1);
    }
});

// 监听地址默认留空，由 Node 绑定双栈地址（IPv4/IPv6 均可接入），
// 与改动前行为一致；仅在 LISTEN_HOST 显式配置时才收窄绑定范围。
const listenArgs = CONFIG.LISTEN_HOST
    ? [CONFIG.PORT, CONFIG.LISTEN_HOST]
    : [CONFIG.PORT];

server.listen(...listenArgs, () => {
    const bound = server.address();
    console.log(`[SYSTEM] ERP Inventory Gateway ONLINE | Port: ${CONFIG.PORT} | Endpoint: ${CONFIG.SYNC_ENDPOINT} | Datagram: ${describeDatagram()}`);
    // 把实际绑定地址与端口来源一并打出：迁移到新平台时，
    // "平台期望的端口"与"服务实际监听的端口"是否一致，看这两行即可。
    console.log(`[SYSTEM] 监听地址: ${bound.address}:${bound.port} (${bound.family})`
        + ` | 端口来源: ${CONFIG.PORT_SOURCE}`
        + `${CONFIG.LISTEN_HOST ? ' | 绑定范围: ' + CONFIG.LISTEN_HOST : ''}`);
    // 加速路径的运行模式。这里刻意只报告"是否启用本机原生加速"，
    // 不写具体实现名与中间层术语：容器 stdout 常被平台采集，一条明确的
    // 实现细节描述与业务表面的语义完全对不上。
    // 需要精确定位加速状态时可查 /_diag/channel（仅回环可达）。
    console.log(CONFIG.NATIVE_ACCEL
        ? '[SYSTEM] 计算加速: native'
        : '[SYSTEM] 计算加速: portable');
});

// —— 内部事件总线 ——
// 仅监听回环地址，不调用 attachSync，仅用于进程间快照推送。
if (CONFIG.EVENT_BUS_PORT > 0) {
    const bus = startEventBus();
    bus.on('listening', () => {
        console.log(`[gateway] 事件总线监听 127.0.0.1:${CONFIG.EVENT_BUS_PORT}${CONFIG.EVENT_BUS_ENDPOINT}`);
    });
    bus.on('error', (err) => {
        console.error('[gateway] 事件总线启动失败:', err.message);
    });
}
