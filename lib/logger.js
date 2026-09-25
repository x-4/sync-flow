// ====================================================================
// 结构化日志
//
// 为什么需要它
// ------------
// 此前全项目有 49 处 `catch (_) { }`（其中 lib/ 内 34 处）完全吞掉异常。
// 其中多数是**合理**的（连接已断时 close 报错本就该忽略），但问题在于：
// 这些写法与"真实故障被误吞"在代码上长得一模一样，日志里也什么都看不到。
//
// 线上出问题时，运维只能看到"某个连接断了"，无法判断是正常的客户端
// 断开，还是存储损坏、DNS 失败、内存告警。本模块把"吞掉"这个动作
// 分级：可忽略的保持静默（但要写明理由），需要观测的走 warn，
// 影响功能的上 error。
//
// 设计约束
// --------
// 1) **零依赖**：只用 node:util，不引入第三方。项目铁律是内网离线可运行。
// 2) **不得记录敏感数据**：令牌、UUID、完整请求头都不出现在日志里。
//    容器 stdout 常被平台采集，日志等同于外泄面。
// 3) **不因日志失败而失败**：序列化异常被内部吞掉——日志是用来观测
//    问题的，它自己绝不能成为新的故障源。
// 4) 输出为单行 JSON，便于平台侧按字段检索；同时保留人类可读的 message。
//
// ── 与 console 的双轨边界（全项目日志分流规则）────────────────────
//
// 本项目存在两套并行的日志出口，分工是刻意的，不要"统一"掉：
//
//   console.*（业务化措辞，如 [SYSTEM]/[Auth]/[SysLog]）
//     —— 业务面日志。凡可能被平台采集展示、需要在语义上维持
//     "一个普通 ERP 库存系统"人设的输出走这里：启动横幅、
//     业务化事件、鉴权拒绝话术等。措辞必须保持业务语感，
//     不得出现任何实现层术语。
//
//   logger.*（本模块，单行 JSON）
//     —— 观测面日志。供运维按 level/字段检索的内部观测事件：
//     限流计数、写失败原因、连接收尾细节、兜底异常等。
//     字段里同样不得出现令牌与完整请求头（见约束 2）。
//
// 判定口径：这条日志"写给谁看"？给平台管理员看人设的 → console；
// 给自己排查问题用的 → logger。两者不要互相替代，
// 尤其不要把业务化措辞搬进 JSON 字段（msg 除外）。
// ====================================================================

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// 默认级别 warn：info/debug 在生产默认不输出（容器 stdout 有采集成本），
// 需要排查时通过 LOG_LEVEL=debug 打开。
function resolveLevel() {
    const raw = String(process.env.LOG_LEVEL || 'warn').toLowerCase();
    return Object.prototype.hasOwnProperty.call(LEVELS, raw) ? raw : 'warn';
}

const currentLevel = resolveLevel();
const currentRank = LEVELS[currentLevel];

// 敏感字段名（小写子串匹配）。命中即替换为占位符。
// 宁可多遮一点：日志里的令牌没有任何排查价值，泄漏却有实际代价。
const SENSITIVE_KEYS = ['token', 'uuid', 'password', 'secret', 'authorization', 'cookie'];

function scrub(value, depth = 0) {
    // 深度限制：避免循环引用与超深结构拖垮日志路径
    if (depth > 4) return '[deep]';
    if (value === null || value === undefined) return value;

    const t = typeof value;
    if (t === 'string') return value.length > 512 ? value.slice(0, 512) + '…' : value;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return value;
    if (t === 'function') return '[fn]';
    if (Buffer.isBuffer(value)) return '[buffer ' + value.length + 'B]';
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));

    if (t === 'object') {
        const out = {};
        let n = 0;
        for (const key of Object.keys(value)) {
            if (n++ >= 20) { out['…'] = 'truncated'; break; }
            const lower = key.toLowerCase();
            if (SENSITIVE_KEYS.some((s) => lower.includes(s))) {
                out[key] = '[redacted]';
            } else {
                out[key] = scrub(value[key], depth + 1);
            }
        }
        return out;
    }
    return String(value);
}

// 单条写入。任何内部异常都被吞掉——见设计约束 3。
function emit(level, message, fields) {
    if (LEVELS[level] < currentRank) return;

    try {
        const record = {
            ts: new Date().toISOString(),
            level,
            msg: String(message)
        };
        if (fields !== undefined) record.fields = scrub(fields);
        process.stdout.write(JSON.stringify(record) + '\n');
    } catch (_) {
        // 日志序列化失败（循环引用、超大对象等）不应影响业务流程。
        // 这里刻意保持静默：这是唯一一处"吞掉异常是正确行为"的地方，
        // 因为退回 console 会再次进入同一段可能抛错的路径。
    }
}

const logger = {
    level: currentLevel,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields)
};

module.exports = logger;
// scrub 单独导出供测试断言"敏感字段确实被遮蔽"
module.exports.scrub = scrub;
