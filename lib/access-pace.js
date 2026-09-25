// ====================================================================
// 业务接口访问频次调控（令牌桶）
//
// 与同步通道的并发限制（sync-core）分工不同：那边保护的是升级握手，
// 这里保护的是普通 HTTP 面。没有它，一个脚本就能以任意速率刷页面
// 与接口——真实网关在负载层都有这层保护，缺失反而是异常特征。
//
// 算法：每个来源一个桶，以 HTTP_PACE_LIMIT 的速率匀速回填令牌，
// 桶容量 HTTP_PACE_BURST 决定可容忍的瞬时突发。取不到令牌即 429。
//
// 取值原则：阈值必须远高于真实业务的聚合访问量。平台在前端终结 TLS
// 后，所有外部用户可能共享同一个来源 IP，阈值过低会把正常用户
// 一起挡掉——宁可放得宽，也不要误伤。
// ====================================================================

const CONFIG = require('./config');

const buckets = new Map(); // key -> { tokens, last }

// 健康探针不参与频次统计：探针被限流会触发平台误判重启
const EXEMPT_PATHS = new Set(['/health', '/healthz', '/api/status']);

// 桶的回收窗口：5 分钟内没有任何取放动作即可清除，防止长尾膨胀
const IDLE_GC_MS = 5 * 60 * 1000;

function resolveClientKey(req) {
    // 与 sync-core 的 clientIp 同一套信任模型：只有明确信任前置代理时
    // 才看 X-Forwarded-For，否则伪造该头即可不断换桶绕过限制。
    if (CONFIG.HTTP_PACE_TRUST_PROXY) {
        const forwarded = req.headers['x-forwarded-for'];
        if (forwarded) {
            const firstHop = forwarded.split(',')[0].trim();
            if (firstHop) return firstHop;
        }
    }
    return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// 是否放行本次请求。pathname 由调用方解析（两条代码路径共用同一解析器）
function allow(pathname, req) {
    if (!CONFIG.HTTP_PACE_ENABLED) return true;
    if (EXEMPT_PATHS.has(pathname)) return true;

    const key = resolveClientKey(req);
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket) {
        bucket = { tokens: CONFIG.HTTP_PACE_BURST, last: now };
        buckets.set(key, bucket);
    }

    // 按逝去时间匀速回填
    const refillRate = CONFIG.HTTP_PACE_LIMIT / 60; // 令牌/秒
    bucket.tokens = Math.min(
        CONFIG.HTTP_PACE_BURST,
        bucket.tokens + ((now - bucket.last) / 1000) * refillRate
    );
    bucket.last = now;

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
}

// 供测试与诊断读取的当前桶数
function bucketCount() {
    return buckets.size;
}

// 定期回收闲置桶。unref 保证不阻止进程退出
const gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
        if (now - bucket.last > IDLE_GC_MS) buckets.delete(key);
    }
}, 60000);
if (gcTimer.unref) gcTimer.unref();

module.exports = { allow, bucketCount };
