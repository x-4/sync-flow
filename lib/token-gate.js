// ====================================================================
// 受限端点准入判定（单一实现）
//
// 站内有两个"不该被外人访问、但不能承认自己存在"的端点：
//   · /_diag/channel        传输层内部指标
//   · /api/v1/auth/device   节点链接下发（含令牌与端点路径）
//
// 两者的准入语义完全一致，只是令牌与请求头名不同。此前各自实现一遍
// 的风险与项目里其它"同项目两套标准"的教训一样：改了一处忘了另一处，
// 而差异恰好出现在最需要一致的地方。因此这里收敛成一份。
//
// 两条硬性要求：
//   1) 未通过一律回 **404**，不是 401/403。401 会带 WWW-Authenticate、
//      403 会承认"资源存在但被拒"，两者都在告诉探测者"这条路径是真的"。
//      404 与任意不存在路径逐字一致，端点是否存在无从判断。
//      所以本模块只回答"放不放行"，怎么写响应由调用方决定。
//   2) 令牌比较必须用 timingSafeEqual。`provided !== expected` 时
//      JS 的字符串比较会在第一个不同字节处返回，耗时随"猜对了多少前缀"
//      线性增长——足够让远程探测者逐字节爆破令牌。
// ====================================================================

const crypto = require('crypto');

// 判定请求是否有权访问某个受限端点。
//
// @param {object} req         HTTP 请求对象
// @param {string} expected    配置的期望令牌；空串表示未配置
// @param {string} headerName  承载令牌的请求头名（小写）
// @returns {boolean}
function authorizeByToken(req, expected, headerName) {
    // —— 第一档：配置了令牌 ——
    // 必须携带匹配的令牌，**不再看来源地址**。
    // 来源判据在同机反代 / 云端边车转发下会失效（remoteAddress 恒为
    // 回环），因此只要配了令牌就以令牌为准。
    if (expected) {
        const provided = req.headers[headerName];
        if (typeof provided !== 'string') return false;
        // 长度不等时提前返回是安全的：长度不是秘密，泄露它不减少搜索空间。
        if (provided.length !== expected.length) return false;
        try {
            return crypto.timingSafeEqual(
                Buffer.from(provided, 'utf8'),
                Buffer.from(expected, 'utf8')
            );
        } catch (_) {
            return false;
        }
    }

    // —— 第二档：未配置令牌，退化为来源地址判据 ——
    // 兼容本地运维与验证脚本。托管平台形态下这一档实际上不可用
    // （remoteAddress 不是回环），因此是安全的默认。
    const ip = (req.socket && req.socket.remoteAddress) || '';
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') return false;

    // 来源确实是回环，但请求带了转发头 —— 说明它不是"本机直接发起"，
    // 而是经一层转发进来的，真实客户端在别处。这正是反代同机部署时
    // "仅本机可访问"失效的可见痕迹：remoteAddress 必然是回环，同时
    // 必然带上 X-Forwarded-For / X-Real-IP / Forwarded。
    //
    // 反向误伤可控：只有**自己**给本机请求硬塞转发头才会被拒，
    // 而那种请求本来也不像运维行为。宁可拒、不可放。
    return !(req.headers['x-forwarded-for']
        || req.headers['x-real-ip']
        || req.headers['forwarded']);
}

module.exports = { authorizeByToken };
