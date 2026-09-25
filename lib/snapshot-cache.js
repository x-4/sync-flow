// ====================================================================
// 业务快照缓存（网关进程内）
//
// 为什么需要它：
//   网关的事件循环同时承担两件事——对外提供业务页面，以及转发实时
//   通道的数据。而业务数据的来源是一棵三级优先级链：
//
//     ① 事件总线推送（内存，最快）
//     ② 磁盘快照    （IO，慢）
//     ③ 现场计算    （CPU）
//
//   前两层在原实现里是"串行同步"的：总线未命中就立刻同步读盘。
//   问题是②走的是**事件循环**，读盘期间所有在途连接一起停顿。
//   单次小文件读约 5.5µs 可忽略，但 319KB 报表已到 163µs，
//   且随报表增长线性上升——多通道并发下会形成长尾延迟。
//
// 解决方式：
//   把"读盘"从请求路径上摘下来，改为"后台异步加载 + 内存命中"。
//   请求路径上只做内存查表，任何情况下都不触碰文件系统。
//
// 设计要点：
//   - TTL 过期后由第一个请求触发异步刷新，其余请求拿旧值继续服务
//     （stale-while-revalidate）——宁可返回略旧的数据，也不让请求等待；
//   - 刷新期间用 inflight 标记去重，避免并发请求各自发起一次读盘；
//   - 加载失败时保留上一次的有效值，不把缓存清空——
//     文件暂时读不到不应该让整个接口降级；
//   - 首次加载（无旧值可服务）时请求正常等待，这是异步等待不是阻塞。
// ====================================================================

const store = require('./store');
const CONFIG = require('./config');
const logger = require('./logger');

// 缓存项：{ value, loadedAt, inflight, lastError }
const cells = new Map();

const now = () => Date.now();

/**
 * 读一个缓存单元。命中内存直接返回；过期则触发一次后台刷新，
 * 本次仍返回旧值（若无旧值则等待加载完成）。
 *
 * @param {string} key 缓存键
 * @param {() => Promise<any>} loader 异步加载函数
 * @returns {Promise<any>}
 */
async function read(key, loader) {
    let cell = cells.get(key);
    if (!cell) {
        cell = { value: undefined, loadedAt: 0, inflight: null, lastError: null };
        cells.set(key, cell);
    }

    const fresh = cell.loadedAt > 0 && (now() - cell.loadedAt) < CONFIG.SNAPSHOT_TTL;

    if (fresh) return cell.value;

    // 已有旧值：先服务本次请求，同时后台刷新（不让请求等待磁盘）
    if (cell.loadedAt > 0) {
        refresh(cell, loader);
        return cell.value;
    }

    // 首次加载：没有旧值可服务，必须等这一次异步加载完成
    await refresh(cell, loader);
    return cell.value;
}

// 发起一次刷新。已有在途请求时直接复用，不重复读盘。
function refresh(cell, loader) {
    if (cell.inflight) return cell.inflight;

    cell.inflight = Promise.resolve()
        .then(loader)
        .then((value) => {
            // 加载失败（返回 null/undefined）时保留旧值，不清空缓存
            if (value !== null && value !== undefined) {
                cell.value = value;
                cell.loadedAt = now();
                cell.lastError = null;
            }
            return cell.value;
        })
        .catch((err) => {
            cell.lastError = err && err.message;
            // 失败不抛给调用方：读不到磁盘时保留上一次的有效数据，
            // 让接口继续可用，而不是把错误暴露成 500
            return cell.value;
        })
        .finally(() => { cell.inflight = null; });

    return cell.inflight;
}

// —— 对外接口：磁盘快照的两类读取 ——

/**
 * 库存快照（缓存进程产出）。
 * 返回 { syncedAt, items } 或 null。
 */
function stockSnapshot() {
    return read('stock', () => store.readStockCacheAsync());
}

/**
 * 最新报表。
 * 返回报表对象或 null。
 */
function latestReport() {
    return read('report', () => store.readLatestReportAsync());
}

/**
 * 报表文件清单（字符串数组）。
 * 目录列表同样是 IO，放在请求路径上会阻塞事件循环，因此一并缓存。
 */
function reportList() {
    return read('reportList', async () => {
        const files = await store.listReportsAsync();
        return Array.isArray(files) ? files : [];
    });
}

// 主动预热：服务启动后立即加载一次，避免首个请求承担冷启动等待
function warmup() {
    // 预热是"锦上添花"：失败时首个真实请求会自己去读盘并缓存，
    // 功能不受影响。但它**必须**有返回兜底，否则未处理的 rejection
    // 会直接终止进程。这里记 debug 而不是彻底静默——冷启动阶段的
    // 读盘失败（磁盘未挂载、权限错）会被首个请求掩盖，留一行便于回溯。
    const note = (name) => (err) => logger.debug('预热失败，改由首个请求触发加载', {
        target: name, error: err && err.message
    });
    stockSnapshot().catch(note('stock'));
    latestReport().catch(note('report'));
    reportList().catch(note('reportList'));
}

module.exports = { stockSnapshot, latestReport, reportList, warmup };
