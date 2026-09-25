// ====================================================================
// 库存报表生成进程
// 读取缓存进程产出的快照，计算缺货预警与汇总，落盘为最新报表与按日归档。
// ====================================================================

process.title = 'erp-report-engine';

const CONFIG = require('../config');
const store = require('../store');

// 缺货预警阈值由集中配置下发（lib/config.js 统一读取环境变量）
const LOW_STOCK_THRESHOLD = CONFIG.LOW_STOCK_THRESHOLD;

function buildReport() {
    const cache = store.readStockCache();
    if (!cache) return null; // 缓存进程尚未产出

    const items = cache.items;
    const lowStock = items.filter((i) => i.available < LOW_STOCK_THRESHOLD);

    return {
        // 报表生成时间（本报表文件产出的时刻），统一为 ISO 串。
        // 与 sourceSyncedAt（库存快照的"数据时间"）来路不同：前者是
        // "报表何时生成"，后者是"库存数据截至何时"——两者本就允许不一致，
        // 分别标注后反而更像真实系统，而非把两个时间强行捏成同一个值。
        // 原先用 Date.now() 毫秒数，与 sourceSyncedAt 的 ISO 串形态冲突
        // （"一个是数字一个是字符串"），人工翻报表即可见，属轻度露馅。
        // 现统一为 ISO 串，两种时间形态自洽。
        generatedAt: new Date().toISOString(),
        sourceSyncedAt: cache.syncedAt,
        lowStockThreshold: LOW_STOCK_THRESHOLD,
        totals: {
            skuCount: items.length,
            totalAvailable: items.reduce((s, i) => s + i.available, 0),
            totalReserved: items.reduce((s, i) => s + i.reserved, 0),
            lowStockCount: lowStock.length
        },
        lowStock: lowStock.map((i) => ({ sku: i.sku, name: i.name, warehouse: i.warehouse, available: i.available })),
        items
    };
}

function tick() {
    const report = buildReport();
    if (!report) {
        console.log('[report-engine] 缓存未就绪，跳过本轮');
        return;
    }
    store.saveLatestReport(report);
    store.saveDailyReport(report);
    console.log(`[report-engine] 报表已生成 | SKU=${report.totals.skuCount} 缺货=${report.totals.lowStockCount}`);
}

tick();
setInterval(tick, CONFIG.REPORT_INTERVAL);
