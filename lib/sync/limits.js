// ====================================================================
// 并发控制与准入拒绝
//
// 纯粹是资源保护：无上限的并发会让连接表被打满，届时反而是真实客户端
// 连不上。限制只在 HTTP upgrade 阶段生效，数据帧出入仍旧原封不动。
//
// 本模块持有**整条通道生命周期内唯一的可变状态**（lifecycle）。它是
// 模块级单例，被 attachSync 的 upgrade 回调与数据面的连接回调共同读写，
// 因此不能复制、不能按连接实例化——否则计数会各算各的。
//
// 同时负责两类"在 upgrade 之前"的拒绝响应：容量/限流拒绝（refuseUpgrade）
// 与非端点池路径的回退（httpLayerFallback）。两者都与握手校验无关，
// 但都必须复用 http-response 的共享构造，以保证头部集合与站点其它响应同源。
// ====================================================================

const crypto = require('crypto');
const CONFIG = require('../config');
const logger = require('../logger');
const { requestPathname } = require('../request-path');
const { resolveRoute, HANDLER_FALLBACK_RESPONSE } = require('../routes');
const { serializeResponse, writeSerialized } = require('../http-response');
const { noteGateRefusal, noteOccupancy } = require('./stats');
const COMPAT = require('./compat');
// 与 HTTP 主链路同源的响应延迟。upgrade 的出口若不给它，同一进程里就
// 会出现"HTTP 25~62ms、upgrade 0~1ms"的两档台阶（详见该文件的说明）。
const { afterDelay } = require('../response-delay');

// 计数分两档,这是 P1-1 的修复点:
//
//   pending = 已握手、首包未到(未证明自己是合法客户端)
//   active  = 首包已通过令牌校验
//
// 此前只有一档:握手即占用正式名额,于是"连上什么都不发"就能占满
// MAX_TOTAL_CONNECTIONS——等到首包超时(默认 30s)才释放,靠循环重连
// 可以长期把连接表占死,真实客户端连不上而服务端日志一片干净。
//
// 拆成两档后,pending 受一个更严格的独立上限约束,且只有通过了令牌
// 校验的连接才会计入正式并发。
const lifecycle = {
    total: 0,               // 当前活跃连接数(首包已通过)
    perIp: new Map(),       // ip -> 活跃连接数
    // 分形态的活跃连接数。
    //
    // 只存数据报那一格，TCP 中继由 total - datagram 得出：两个数字若各
    // 自增自减，就多出一条"两格之和必须等于 total"的隐式不变量，一旦
    // 某个漏减就会静默漂移成"总数对不上分形态"。留一格、另一格算出来，
    // 这个不变量自动成立。
    //
    // 为什么必须分开：两条路径的僵尸成因完全不同——TCP 中继的僵尸由出站
    // 连接的空闲超时兜底，数据报通道没有出站连接，此前一个定时器都没有
    // （实测 200s 后仍不回落）。混成一个数字时，"channels 一直下不来"
    // 只能靠猜是哪条路径在漏。
    datagram: 0,            // 活跃连接中属于数据报通道的条数
    pending: 0,             // 已握手、首包未到的连接数
    pendingPerIp: new Map(),// ip -> pending 连接数
    invalid: new Map()      // ip -> { count, firstAt, cooldownUntil }
};

function clientIp(request, socket) {
    // 只有在明确信任前置代理时才看 X-Forwarded-For。
    // 否则伪造该头即可绕过限制，或直接把整段 shard 拖进同一计数桶。
    if (CONFIG.SYNC_TRUST_PROXY) {
        const forwarded = request.headers['x-forwarded-for'];
        if (forwarded) {
            const firstHop = forwarded.split(',')[0].trim();
            if (firstHop) return firstHop;
        }
    }
    return socket.remoteAddress || 'unknown';
}

// 来源 IP 的不可逆标签。
//
// 拒绝日志必须能回答"是同一个来源在反复撞墙，还是很多来源各撞一次"
// ——这两个形态的处置完全相反（前者是单个客户端配置错误，后者是上限
// 标定过低）。但原始 IP 属于用户访问信息，容器 stdout 常被平台采集，
// 落进去等同外泄，因此只留哈希。
//
// 盐是**每进程随机**的：固定盐等于把整个 IPv4/IPv6 空间做成一张可离线
// 索引的表，拿着日志就能反查出来源。代价是重启后同一来源的标签会变，
// 跨重启无法关联——这是刻意的取舍，排查一次撞墙事件不需要跨重启关联。
const IP_TAG_SALT = crypto.randomBytes(32);

function ipTag(ip) {
    if (!ip) return 'unknown';
    return crypto.createHmac('sha256', IP_TAG_SALT)
        .update(String(ip))
        .digest('hex')
        .slice(0, 12);
}

// 五道闸门各自的"当前占用 / 上限"。
//
// 单独抽出来，是因为拒绝日志与 /_diag/channel 必须说同一件事：日志里
// 写"64/64"、诊断端点里写"上限 128"的话，两边对不上就无法判断是哪道
// 闸。occupancy 的口径在这里定死，两边都从这一处取。
const GATES = {
    total: () => ({ current: lifecycle.total + lifecycle.pending, limit: CONFIG.MAX_TOTAL_CONNECTIONS }),
    perIp: (ip) => ({ current: lifecycle.perIp.get(ip) || 0, limit: CONFIG.MAX_CONNECTIONS_PER_IP }),
    pendingTotal: () => ({ current: lifecycle.pending, limit: CONFIG.MAX_PENDING_TOTAL }),
    pendingPerIp: (ip) => ({ current: lifecycle.pendingPerIp.get(ip) || 0, limit: CONFIG.MAX_PENDING_PER_IP }),
    // 冷却闸没有"占用量"语义，用剩余冷却秒数 / 冷却总时长表达。
    cooldown: (ip) => ({
        current: Math.ceil(cooldownRemaining(ip) / 1000),
        limit: Math.ceil(CONFIG.INVALID_COOLDOWN / 1000)
    })
};

// 在 upgrade 被接受之前回一个标准 HTTP 错误。
// 走 HTTP 层拒绝的好处：客户端看到的是一次普通的请求失败，
// 而不是"握手成功然后在 WebSocket 里被踢掉"。
//
// 与 refuseHandshake 一样走 http-response 的共享构造，保证这类
// （容量/限流）拒绝的头部集合与站点其它响应同源——否则会出现
// "429 缺安全头、404 有安全头" 的可对比差异。
// gate 是"哪一道闸"的标识（total / perIp / pendingTotal / pendingPerIp /
// cooldown）。它只进日志与计数，**绝不进响应体**——响应正文里多一个
// "gate":"pendingPerIp" 就等于告诉对方"这里有条通道且被限流了"，
// 与站点其它 404/405 响应形成可对比分叉。
//
// 每次拒绝都记一条 warn，这是 2026-09-24 那次三轮排查的直接产物：
// 当时并发上限卡在 10，浏览器首屏的几十条握手大批被 429 拒掉，而这个
// 函数一行日志都没有——663 次拒绝在服务端毫无痕迹，只能靠用户症状
// （"Chrome 找不到 DNS 地址"）反推。静默拒绝比拒绝本身更贵。
//
// 代价是高并发拒绝时日志会增多。取舍是明确的：被拒的连接本就已经
// 失败了，多写一行 stdout 不会让它更糟；而缺这行日志的代价是整轮
// 排查扑空。真被刷爆时该做的是修上限，不是关日志。
// sourceIp 由调用方传入（它已在 upgrade 处理器里算过一次）：这里若再
// 调 clientIp(request, socket) 重算，两处用到的信任模型可能不一致，
// 而"日志里的来源"与"计数用的来源"不是同一个，正是最难查的那类偏差。
function refuseUpgrade(request, socket, statusCode, reason, payload, gate, sourceIp) {
    noteGateRefusal(gate);

    const probe = GATES[gate] ? GATES[gate](sourceIp) : null;
    if (gate) {
        logger.warn('同步通道拒绝新建连接', {
            gate,
            status: statusCode,
            occupancy: probe ? probe.current : undefined,
            limit: probe ? probe.limit : undefined,
            source: ipTag(sourceIp),
            path: request ? requestPathname(request) : undefined
        });
    }

    if (!socket || socket.destroyed || socket.writableEnded) return;
    const body = JSON.stringify(Object.assign({ code: statusCode, msg: reason }, payload));

    // 计数与日志在上面已经即时完成，这里只把**写出**推迟。
    //
    // 为什么必须延迟：HTTP 侧的 429 / 503 与 404 一样要过一遍 RESPONSE_DELAY_MS
    // （实测 25ms 量级），而 upgrade 侧此前是 0ms。同一进程里两档相差
    // 25~60 倍，且触发它不需要任何凭据——压到上限即可，测出来的台阶
    // 直接指出"这个口子不在 HTTP 主链路上"。
    afterDelay(requestPathname(request), socket, () => {
        writeSerialized(socket, serializeResponse(request, {
            status: statusCode,
            contentType: 'application/json; charset=utf-8',
            body,
            extraHeaders: { Connection: 'close' },
            method: request.method
        }));
    });
}

// 把"不属于同步端点池的升级请求"交回 HTTP 层语义处理。
//
// 判据必须与 lib/gateway.js 的路由表完全一致，否则又会产生新的差异。
// 这里不再自己重写一份判定，而是直接调用 routes 导出的 resolveRoute()，
// 并用 http-response 的 serializeResponse() 序列化——两条路径因此共用
// **同一套**路由决策 + 同一套响应构造，响应外观不可能分叉。
//
// 效果：对任意路径发 GET 与发 Upgrade，得到的响应（状态码 / 头部集合 /
// 正文）完全同源，无法被反向推断"这里是否支持升级"。
function httpLayerFallback(request, socket) {
    const pathname = requestPathname(request);
    const method = request.method;
    const decision = resolveRoute(pathname, method);

    // resolveRoute 判定该请求应执行真实业务处理器时（kind === 'handler'），
    // 回退层不重放它——在裸 socket 上跑业务逻辑（读快照 / 渲染页面）
    // 既无必要也有风险。
    //
    // 但"不重放"不等于"可以另编一个响应"。这里曾经对一个真实存在的
    // 端点（/health、/api/status 等）返回一段**固定的占位 JSON**，
    // 而普通 GET 返回的是真实业务数据——两者状态码同为 200，正文却
    // 完全不同（实测 Content-Length 70 vs 72）。这构成一处比状态码
    // 差异更隐蔽的可对比特征：观察方只需发一次 GET 与一次 Upgrade，
    // 比对正文即可确认该路径"支持某种特殊协议访问"。
    //
    // 现在这类路径的响应体取自 routes.js 的 HANDLER_FALLBACK_RESPONSE
    // ——405 + Allow: GET，与站点对"方法不可用"的既有处置完全同源。
    // 常量放在 routes.js 而非此处，是为了让它与 resolveRoute 的
    // 405 分支共用同一份定义，不会再出现两处各写一份的漂移。
    const spec = decision.kind === 'static'
        ? { status: decision.status, contentType: decision.contentType, body: decision.body, extraHeaders: decision.headers || {} }
        : {
            status: HANDLER_FALLBACK_RESPONSE.status,
            contentType: HANDLER_FALLBACK_RESPONSE.contentType,
            body: HANDLER_FALLBACK_RESPONSE.body,
            extraHeaders: HANDLER_FALLBACK_RESPONSE.headers
        };

    const serialized = serializeResponse(request, {
        status: spec.status,
        contentType: spec.contentType,
        body: spec.body,
        extraHeaders: spec.extraHeaders,
        method
    });

    // 延迟后再写，与 HTTP 主链路同一套判定。
    //
    // 这条出口是"升级请求被当成普通 HTTP 请求处置"的那一支，它回的
    // 404/405 必须与同一 path+method 的普通 GET 在**耗时上也同源**：
    // 状态码与字节已经逐字一致了（共用 resolveRoute + serializeResponse），
    // 只剩耗时还差着一档，而耗时是唯一不需要任何凭据就能测的量。
    //
    // 序列化仍在延迟之前完成：serializeResponse 要读 request 的头做压缩
    // 协商，等到延迟之后再读，request 可能已被回收。
    afterDelay(pathname, socket, () => writeSerialized(socket, serialized));
}

// 占用变化后把水位同步给 stats.js。
//
// 每个变更点都调用，而不是只在 bump 上调：峰值只在涨时更新，但诊断
// 端点的"当前占用"必须是实时的，漏掉下降路径会让 /_diag/channel 一直
// 显示历史最高值——那反而会让人误判"一直在顶着上限"。
function syncOccupancy() {
    noteOccupancy(lifecycle.total, lifecycle.pending);
}

// kind 取 'datagram'（数据报通道）或 'relay'（TCP 中继），由数据面在首包
// 通过令牌校验时给出。缺省按 relay 计：拿不到形态时宁可记在"有兜底的那
// 一侧"，也不要让分形态计数出现第三种状态。
function bump(ip, kind) {
    lifecycle.total++;
    if (kind === 'datagram') lifecycle.datagram++;
    lifecycle.perIp.set(ip, (lifecycle.perIp.get(ip) || 0) + 1);
    syncOccupancy();
}

// kind 必须与 bump 时一致，否则 datagram 那一格会单向漂移。
// 调用方（sync/index.js）把形态记在连接的闭包里，释放时回传同一个值。
function drop(ip, kind) {
    if (lifecycle.total > 0) lifecycle.total--;
    if (kind === 'datagram' && lifecycle.datagram > 0) lifecycle.datagram--;
    const n = (lifecycle.perIp.get(ip) || 0) - 1;
    if (n > 0) lifecycle.perIp.set(ip, n); else lifecycle.perIp.delete(ip);
    syncOccupancy();
}

// 握手完成、首包未到:先按 pending 借一个名额。
// 借而不给,是因为此刻还没证明这条连接是合法客户端。
function bumpPending(ip) {
    lifecycle.pending++;
    lifecycle.pendingPerIp.set(ip, (lifecycle.pendingPerIp.get(ip) || 0) + 1);
    syncOccupancy();
}

function dropPending(ip) {
    if (lifecycle.pending > 0) lifecycle.pending--;
    const n = (lifecycle.pendingPerIp.get(ip) || 0) - 1;
    if (n > 0) lifecycle.pendingPerIp.set(ip, n); else lifecycle.pendingPerIp.delete(ip);
    syncOccupancy();
}

// 首包通过令牌校验:把借来的名额兑现为正式占用。
// 幂等——一条连接只兑现一次(首包只处理一次,但回调可能在异常路径
// 上被重入,重复计数会让连接表缓慢泄漏)。
// kind 透传给 bump:分形态计数必须在"兑现"这一刻就记准,不能等到连接
// 结束再补——那时已经无法知道它当初是哪个形态了。
function promote(ip, kind) {
    dropPending(ip);
    bump(ip, kind);
}

// 记录一次非法批次，超过阈值即在冷却窗口内拒绝该来源的新建连接。
//
// 作用域由 INVALID_BATCH_PER_IP 决定（默认开启，即按 IP 连坐）：
//
//   开启（默认）：维持既有语义。窗口内同一来源累计到阈值即进入全局冷却，
//     期间该来源的所有新建连接被拒。这是"宁可短暂全拒，也不让扫描者
//     靠换连接规避计数"的取舍。
//
//     需要注意代价：PaaS 在前端终结 TLS 后所有用户共用同一内网出口 IP，
//     因此单个异常客户端可触发全体用户被拒 INVALID_COOLDOWN 毫秒。
//     这是**已知且被接受**的取舍，不是缺陷——如需改变，改
//     lib/defaults.js 的 INVALID_BATCH_PER_IP（该项已固化，
//     不再接受环境变量覆盖）。
//
//   关闭：退避作用域收敛到单条连接，异常连接照常被断，但不牵连他人。
function noteInvalid(ip) {
    if (!CONFIG.INVALID_BATCH_THRESHOLD) return;
    if (!CONFIG.INVALID_BATCH_PER_IP) return;   // 关闭时不进全局冷却
    const now = Date.now();
    const rec = lifecycle.invalid.get(ip) || { count: 0, firstAt: now, cooldownUntil: 0 };
    if (now - rec.firstAt > CONFIG.INVALID_BATCH_WINDOW) { rec.count = 0; rec.firstAt = now; }
    rec.count++;
    if (rec.count >= CONFIG.INVALID_BATCH_THRESHOLD) {
        // 等价模式：仍然计数、仍然记日志，但**不进入冷却**。
        //
        // 冷却是"同一来源 20 次非法批次 → 300s 内该来源全部新建连接被
        // 429"。在 PaaS 于前端终结 TLS 的部署下所有用户共用同一出口 IP，
        // 于是**一个**配置错误的客户端就能让全体用户在 5 分钟内完全连
        // 不上——症状与本次排查的"浏览器打不开"完全重合，且服务端只留
        // 下一串 429 计数。它因此必须能被排除。
        //
        // 计数与日志刻意保留：冷却**有没有被触发过**本身是要观测的事实
        // （它说明确实有客户端在持续发非法批次），只是不再据此拒绝连接。
        // 若连计数一起关掉，实验结束后就无法回答"它曾经是不是原因"。
        if (!COMPAT.enabled) rec.cooldownUntil = now + CONFIG.INVALID_COOLDOWN;
        else logger.debug('非法批次累计已达阈值，等价模式下不进入冷却', {
            threshold: CONFIG.INVALID_BATCH_THRESHOLD
        });
        rec.count = 0;
        rec.firstAt = now;
    }
    lifecycle.invalid.set(ip, rec);
}

function cooldownRemaining(ip) {
    const rec = lifecycle.invalid.get(ip);
    if (!rec || rec.cooldownUntil <= Date.now()) return 0;
    return rec.cooldownUntil - Date.now();
}

// 定期清理过期的计数记录，避免长时间运行后 Map 无限增长。
// unref() 同 resolver：优化项不应阻止进程退出。
const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of lifecycle.invalid) {
        if (rec.cooldownUntil <= now && now - rec.firstAt > CONFIG.INVALID_BATCH_WINDOW) {
            lifecycle.invalid.delete(ip);
        }
    }
    if (lifecycle.total === 0) lifecycle.perIp.clear();
    if (lifecycle.pending === 0) lifecycle.pendingPerIp.clear();
}, 60000);
sweeper.unref();

// 供给测试与健康检查读取的实时指标
function getSyncStats() {
    return {
        total: lifecycle.total,
        // 分形态：datagram 是数据报通道，relay 是 TCP 中继。
        // 两者之和恒等于 total（见 lifecycle.datagram 的说明）。
        datagram: lifecycle.datagram,
        relay: lifecycle.total - lifecycle.datagram,
        maxTotal: CONFIG.MAX_TOTAL_CONNECTIONS,
        perIpEntries: lifecycle.perIp.size,
        pending: lifecycle.pending,
        maxPending: CONFIG.MAX_PENDING_TOTAL,
        coolingDown: [...lifecycle.invalid.values()].filter((r) => r.cooldownUntil > Date.now()).length
    };
}

module.exports = {
    lifecycle,
    clientIp,
    ipTag,
    refuseUpgrade,
    httpLayerFallback,
    bump,
    drop,
    bumpPending,
    dropPending,
    promote,
    noteInvalid,
    cooldownRemaining,
    getSyncStats,
    sweeper
};
