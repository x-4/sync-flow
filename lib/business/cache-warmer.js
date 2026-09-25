// ====================================================================
// 库存缓存预热进程
// 定期计算库存快照，落盘并实时推送给网关进程。
//
// 落盘与推送两条路径并存：推送保证网关侧的低延迟，落盘保证网关进程
// 重启后仍能读到最近一份快照，不会出现对外接口短期空窗。
// ====================================================================

process.title = 'erp-cache-warmer';

const CONFIG = require('../config');
const { genStock } = require('../inventory');
const store = require('../store');
const { createPublisher } = require('../event-bus');

// 最近一次生成的快照。publisher 在重连后会主动取它补推，
// 避免网关在两次定时推送之间读到过期的磁盘数据。
let latest = null;

function buildSnapshot() {
    return { syncedAt: Date.now(), items: genStock() };
}

function refresh() {
    const snapshot = buildSnapshot();
    latest = snapshot;

    // 先落盘：即使推送通道尚未就绪，网关也能从磁盘读到数据
    store.saveStockCache(snapshot);

    // 再推送：通道未就绪时静默跳过，下一轮重试，不影响本轮落盘
    if (publisher) publisher.publish(snapshot);
}

const publisher = CONFIG.EVENT_BUS_PORT > 0
    ? createPublisher({
        onOpen: () => console.log('[cache-warmer] 事件总线已连接'),
        current: () => latest
    })
    : null;

store.ensureDirs();
refresh();
setInterval(refresh, CONFIG.CACHE_INTERVAL);

process.on('SIGTERM', () => {
    if (publisher) publisher.close();
    process.exit(0);
});

// 落盘位置取决于存储驱动：fs 下是 DATA_DIR 路径，memory 下是进程内存。
// 日志按实际驱动播报，避免"显示了一个没被使用的目录"误导排查。
console.log(`[cache-warmer] ready | interval=${CONFIG.CACHE_INTERVAL}ms | store=${store.storageDriverName}`
    + (store.storageDriverName === 'fs' ? ` | dir=${CONFIG.DATA_DIR}` : ''));
