// ====================================================================
// Enterprise Inventory Real-time Synchronization Microservice
// 主进程：按运行期配置选择进程编排方式，并拉起业务模块。
//
// 两种编排模式（由**运行形态**决定，不再是环境变量：Serverless 平台
// 自动取单进程，常驻部署取 fork；业务与协议实现完全一致）：
//
//   fork 模式（默认）—— 主进程 fork 出四个业务子进程并守护它们。
//       多核利用充分；单个业务崩溃可被独立重启，不影响其他业务。
//       适用于自建机、Docker、K8s 等支持 child_process 的平台。
//
//   单进程模式 —— 四个业务模块在主进程内顺序加载。
//       面向 fork 受限或只读文件系统的平台（Serverless / 边缘运行时）。
//       代价：任一业务抛未捕获异常会带走整个进程。
//       注意：单进程 + memory 存储驱动是配套组合——内存存储表是
//       进程内的，fork 模式下各 worker 无法共享（见 config 校验）。
// ====================================================================

process.title = 'erp-node-mgr';

const path = require('path');
const { fork } = require('child_process');

// 启动前先集中校验配置。缺 UUID 时主进程在此直接退出，
// 而不是把四个子进程拉起来再让它们循环崩溃刷日志。
const CONFIG = require('./lib/config');

// Linux 下进程名可写入的长度受启动时命令行长度限制（实测：名字过长会被
// 截断）。主进程为子进程传入填充参数以预留空间，子进程才能设置较长的
// 业务化进程名；主进程自身受 "node supervisor.js" 长度限制，故用短名。
const TITLE_PADDING = ' '.repeat(120);

// 业务模块清单。key 仅用于日志与进程管理标识，file 是实际入口。
// 顺序即加载顺序：cache 先于 report，保证报表首轮就有快照可读。
const WORKERS = [
    { key: 'cache',   file: 'cache-warmer.js' },
    { key: 'report',  file: 'report-worker.js' },
    { key: 'gc',      file: 'report-cleaner.js' },
    { key: 'gateway', file: 'gateway-worker.js' }
];

function workerPath(worker) {
    return path.join(__dirname, 'lib', 'business', worker.file);
}

// ====================================================================
// 单进程模式：顺序 require，不起子进程
// ====================================================================
function startSingleProcess() {
    for (const w of WORKERS) {
        require(workerPath(w));
    }
    console.log(`[supervisor] started | pid=${process.pid} | mode=single | workers=${WORKERS.length}`);
}

// ====================================================================
// fork 模式：拉起子进程并守护
//
// 重启策略：指数退避（3s 起步，每次翻倍，60s 封顶）。
// 此前是固定 3s 无限重启——在"代码崩溃"这类确定性故障下，子进程
// 会以 3s 一次的节拍无限循环重启（崩溃风暴）：日志被刷满、CPU 空转
// 在反复初始化上，还可能挤占真实业务进程的资源。退避后故障进程的
// 重启间隔自动拉长，把"故障可见"与"资源可承受"同时满足；
// 进程稳定运行超过 60s 即视为恢复，退避计数清零，偶发崩溃不受影响。
// ====================================================================
const RESTART_BASE_MS = 3000;
const RESTART_MAX_MS = 60000;
const STABLE_MS = 60000;

const children = new Map();
// 每个 worker 的退避状态：attempts 连续崩溃次数，lastSpawnAt 上次拉起时刻
const restartState = new Map();
// 停机标志：置位后子进程退出不再触发重启（优雅停机期间必须安静）
let shuttingDown = false;

function spawn(worker) {
    const child = fork(workerPath(worker), [TITLE_PADDING], {
        stdio: 'inherit',
        env: process.env
    });
    children.set(worker.key, child);
    // attempts 必须跨重启保留（否则每次重新 spawn 都清零，退避永远停在 3s）。
    // 首次拉起时 Map 里还没有条目，attempts 从 0 起算。
    const state = restartState.get(worker.key) || { attempts: 0, lastSpawnAt: 0 };
    state.lastSpawnAt = Date.now();
    restartState.set(worker.key, state);
    child.on('exit', (code) => {
        children.delete(worker.key);

        if (shuttingDown) {
            // 停机流程在等这一批 exit（见 shutdown 的计数），这里不重启、不刷日志
            return;
        }

        // 存活超过 STABLE_MS 才崩溃 => 上次故障已恢复，重置退避
        const cur = restartState.get(worker.key) || state;
        if (Date.now() - cur.lastSpawnAt > STABLE_MS) cur.attempts = 0;
        cur.attempts++;

        // 退避时长：3s -> 6s -> 12s -> 24s -> 48s -> 60s 封顶
        const delay = Math.min(RESTART_BASE_MS * Math.pow(2, cur.attempts - 1), RESTART_MAX_MS);
        restartState.set(worker.key, cur);

        console.error(`[supervisor] ${worker.key} 退出 (code=${code})，`
            + `${Math.round(delay / 1000)} 秒后重启（连续第 ${cur.attempts} 次）`);
        setTimeout(() => spawn(worker), delay);
    });
    return child;
}

function startForkMode() {
    for (const w of WORKERS) spawn(w);
    console.log(`[supervisor] started | pid=${process.pid} | mode=fork | workers=${WORKERS.length}`);
}

// ====================================================================
// 优雅停机：先通知各子进程退出，等它们收尾后再退出主进程。
//
// 此前是发出 SIGTERM 后立即 process.exit(0)——子进程还来不及关闭
// 监听端口、结束在途连接，主进程就消失了。对容器编排（K8s/Docker
// stop）与平台重新部署，这意味着滚动更新时在途的同步通道被硬切断。
// 现在的流程：
//   1) 向全部子进程发 SIGTERM；
//   2) 等待全部退出（正常情况下子进程毫秒级收尾）；
//   3) 5s 宽限期到仍未退出 => SIGKILL 强杀并退出，保证停机必然收敛。
// ====================================================================
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    const kids = [...children.values()];
    if (kids.length === 0) {
        process.exit(0);
    }

    console.log(`[supervisor] 停止中：正在通知 ${kids.length} 个业务进程退出…`);
    for (const child of kids) {
        try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
        child.once('exit', () => {
            kids.splice(kids.indexOf(child), 1);
            if (kids.length === 0) process.exit(0);
        });
    }

    // 宽限期兜底。unref：若所有子进程提前退出并走到 process.exit(0)，
    // 该定时器不应阻止进程退出。
    setTimeout(() => {
        for (const child of [...children.values()]) {
            try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
        }
        process.exit(0);
    }, 5000).unref();
}

if (CONFIG.SINGLE_PROCESS) {
    startSingleProcess();
} else {
    startForkMode();
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
