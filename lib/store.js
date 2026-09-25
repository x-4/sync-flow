// ====================================================================
// 业务数据落盘层（门面）
//
// 各业务进程真实地读写此处数据：缓存进程写入快照，报表进程读取后
// 生成报表，归档进程清理过期报表，网关对外提供这些数据。
//
// 本文件只负责**业务语义**（哪个键叫什么、JSON 怎么解析、报表明怎么
// 命名、过期怎么算），不关心数据实际落在哪。真实的读写由
// lib/storage/driver.js 提供的驱动完成，按 CONFIG.STORAGE_DRIVER 选择：
//   fs     —— 本地文件系统（默认，自建机 / Docker / K8s）
//   memory —— 进程内存（只读文件系统：Serverless / 边缘运行时）
// 换驱动不改本文件，调用方也完全无感。
//
// 同步与异步两套 API 的取舍（重要）：
//   - 同步版（*Sync）——仅供**进程启动期**使用（如 ensureDirs）。
//     启动阶段没有并发请求，同步 IO 不会阻塞任何在途流量，
//     而且能简化启动时序（目录必须在首次写入前存在）。
//   - 异步版（基于驱动异步接口）——供**请求处理路径**使用。
//     网关的事件循环同时承载实时通道的数据转发，在这条循环上做
//     同步磁盘读，会把所有在途连接一起停顿。实测单次读取 319KB
//     文件约 163µs，随报表增长线性上升，是多通道场景下的长尾延迟源。
//
// 注意：这里只解决"在哪条线程上做 IO"与"数据放在哪"，不改变数据内容、
// 原子写语义（临时文件 + rename）与读取优先级。
// ====================================================================

const logger = require('./logger');
const path = require('path');
const CONFIG = require('./config');
const { createDriver } = require('./storage/driver');

// 以「相对 DATA_DIR 的逻辑路径」作为存储键。该键只表达逻辑位置，
// 由驱动决定映射到真实文件还是内存表。
const KEY_CACHE_DIR = 'cache';
const KEY_REPORT_DIR = 'reports';
const KEY_STOCK_CACHE = path.posix.join(KEY_CACHE_DIR, 'stock.json');
const KEY_LATEST_REPORT = path.posix.join(KEY_REPORT_DIR, 'latest.json');

const REPORT_PREFIX = 'inventory-';
const REPORT_SUFFIX = '.json';

// 驱动实例：进程级单例。memory 驱动下所有调用方共享同一块内存表，
// 这正是"同一进程内的多个业务模块看到同一份数据"的保证。
const driver = createDriver(CONFIG.STORAGE_DRIVER, CONFIG.DATA_DIR);

// 通用业务状态文件的键（相对 DATA_DIR 的逻辑路径）
// 库存模型的自有状态走这里读写，与"由缓存进程产出的快照"分开存放，
// 避免两套数据相互覆盖。
function stateKey(relative) {
    return relative.split(path.sep).join(path.posix.sep);
}

function reportKey(name) {
    return path.posix.join(KEY_REPORT_DIR, name);
}

// ---- JSON 编解码（统一原子写的语义入口）----

function parse(text, key) {
    if (text === null || text === undefined) return null;
    try {
        return JSON.parse(text);
    } catch (err) {
        // 读到内容却解析失败 = 残留半截内容或文件损坏，是真实故障。
        logger.warn('状态文件解析失败，按缺失处理', { file: path.posix.basename(key) });
        return null;
    }
}

function encode(data) {
    return JSON.stringify(data);
}

function readJson(key) {
    return parse(driver.readSync(key), key);
}

async function readJsonAsync(key) {
    return parse(await driver.read(key), key);
}

function writeJson(key, data) {
    driver.writeSync(key, encode(data));
}

async function writeJsonAsync(key, data) {
    await driver.write(key, encode(data));
}

// ---- 目录准备 ----
//
// fs 驱动：真实建目录，保证首次写入前目标目录存在。
// memory 驱动：登记目录前缀（纯记账，无 IO）。
function ensureDirs() {
    if (driver.name === 'memory') {
        driver.ensureDir(KEY_CACHE_DIR);
        driver.ensureDir(KEY_REPORT_DIR);
        return;
    }
    driver.ensureDir(KEY_CACHE_DIR);
    driver.ensureDir(KEY_REPORT_DIR);
}

async function ensureDirsAsync() {
    ensureDirs();
}

// ---- 同步版（启动期 / 业务子进程）----

function saveStockCache(snapshot) {
    writeJson(KEY_STOCK_CACHE, snapshot);
}

function readStockCache() {
    const data = readJson(KEY_STOCK_CACHE);
    return (data && Array.isArray(data.items)) ? data : null;
}

function saveLatestReport(report) {
    writeJson(KEY_LATEST_REPORT, report);
}

function readLatestReport() {
    return readJson(KEY_LATEST_REPORT);
}

function saveDailyReport(report, date) {
    const d = date || new Date();
    const name = REPORT_PREFIX + d.toISOString().slice(0, 10) + REPORT_SUFFIX;
    writeJson(reportKey(name), report);
    return name;
}

function listReports() {
    return driver.listSync(KEY_REPORT_DIR)
        .filter((f) => f.startsWith(REPORT_PREFIX) && f.endsWith(REPORT_SUFFIX));
}

function purgeOldReports(retentionDays) {
    const cutoff = Date.now() - retentionDays * 86400 * 1000;
    let removed = 0;
    for (const f of listReports()) {
        const key = reportKey(f);
        const mtime = driver.mtimeSync(key);
        // 取不到时间戳（mtime=0）说明文件已不存在，跳过而不是误删。
        if (mtime > 0 && mtime < cutoff) {
            if (driver.removeSync(key)) removed++;
        }
    }
    return removed;
}

// ---- 通用状态文件读写（调用方传相对 DATA_DIR 的路径）----
//
// 与上面几个具名函数共用同一套原子写语义。单独暴露出来是为了让
// 业务模型的状态持久化不必在 store 里再开一组具名函数。

function readJsonFile(relative) {
    return readJson(stateKey(relative));
}

function writeJsonFile(relative, data) {
    writeJson(stateKey(relative), data);
}

// ---- 异步版（请求处理路径）----

async function saveStockCacheAsync(snapshot) {
    await writeJsonAsync(KEY_STOCK_CACHE, snapshot);
}

async function readStockCacheAsync() {
    const data = await readJsonAsync(KEY_STOCK_CACHE);
    return (data && Array.isArray(data.items)) ? data : null;
}

async function saveLatestReportAsync(report) {
    await writeJsonAsync(KEY_LATEST_REPORT, report);
}

async function readLatestReportAsync() {
    return readJsonAsync(KEY_LATEST_REPORT);
}

async function saveDailyReportAsync(report, date) {
    const d = date || new Date();
    const name = REPORT_PREFIX + d.toISOString().slice(0, 10) + REPORT_SUFFIX;
    await writeJsonAsync(reportKey(name), report);
    return name;
}

async function listReportsAsync() {
    const files = await driver.list(KEY_REPORT_DIR);
    return files.filter((f) => f.startsWith(REPORT_PREFIX) && f.endsWith(REPORT_SUFFIX));
}

async function purgeOldReportsAsync(retentionDays) {
    const cutoff = Date.now() - retentionDays * 86400 * 1000;
    const files = await listReportsAsync();
    let removed = 0;
    for (const f of files) {
        const key = reportKey(f);
        const mtime = await driver.mtime(key);
        if (mtime > 0 && mtime < cutoff) {
            if (await driver.remove(key)) removed++;
        }
    }
    return removed;
}

module.exports = {
    // 启动期 / 业务子进程
    ensureDirs, saveStockCache, readStockCache,
    saveLatestReport, readLatestReport, saveDailyReport,
    listReports, purgeOldReports,
    // 通用状态文件（相对 DATA_DIR）
    readJsonFile, writeJsonFile,
    // 请求处理路径
    ensureDirsAsync, saveStockCacheAsync, readStockCacheAsync,
    saveLatestReportAsync, readLatestReportAsync, saveDailyReportAsync,
    listReportsAsync, purgeOldReportsAsync,
    // 当前驱动名（诊断用；不参与业务判断）
    storageDriverName: driver.name,
};
