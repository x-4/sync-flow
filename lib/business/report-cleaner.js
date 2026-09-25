// ====================================================================
// 报表归档清理进程
// 定期清理超过保留期的历史报表，避免磁盘无限增长。
// ====================================================================

process.title = 'erp-report-gc';

const CONFIG = require('../config');
const store = require('../store');

function tick() {
    const removed = store.purgeOldReports(CONFIG.REPORT_RETENTION_DAYS);
    if (removed > 0) {
        console.log(`[report-gc] 清理过期报表 ${removed} 份 (保留 ${CONFIG.REPORT_RETENTION_DAYS} 天)`);
    }
}

tick();
setInterval(tick, CONFIG.GC_INTERVAL);
