// ====================================================================
// 同步通道编排层
//
// 本模块是 lib/sync/ 的对外唯一入口，也是 lib/sync-core.js 转发壳的
// 目标。职责只有三件：
//   1) 持有通道实例（ChannelHub）并配置它；
//   2) 把 upgrade 请求交给握手判定，再交给并发控制；
//   3) 把建立后的连接交给数据面。
//
// 具体逻辑一律下沉：首包解析在 codec、域名解析在 resolver、
// 准入限制在 limits、握手判定在 handshake、转发在 relay。
// 本文件只做编排，不含业务判断——这样每一块都能被独立测试。
//
// 对外接口与拆分前完全一致：module.exports = { attachSync, getSyncStats }
// ====================================================================

const { randomFillSync, randomBytes } = require('crypto');
const { ChannelHub } = require('../../vendor/sync-engine');
const CONFIG = require('../config');
const logger = require('../logger');
const { UPGRADE_HEADERS } = require('../response-profile');
const { requestPathname } = require('../request-path');
const { ROUTES } = require('../routes');

const { inspectHandshake } = require('./handshake');
// 与 HTTP 主链路同源的响应延迟：upgrade 的非 101 出口必须与 HTTP 侧同一档，
// 否则"一次握手就能测出的台阶"会一直留在那儿（详见该文件的说明）。
const { afterDelay } = require('../response-delay');
const {
    lifecycle,
    clientIp,
    refuseUpgrade,
    httpLayerFallback,
    bump,
    drop,
    bumpPending,
    dropPending,
    promote,
    cooldownRemaining,
    getSyncStats
} = require('./limits');
const {
    createSession,
    createBackpressure,
    armFirstBatchTimeout,
    clearFirstBatchTimeout,
    handleFirstBatch,
    handleSubsequent,
    teardownChannel
} = require('./relay');
const { announceCompat } = require('./compat');

// ====================================================================
// 通道实例
// ====================================================================

// 入站单消息长度上限由配置显式指定。
// 不传时用的是传输层默认的 100MB——那是上游库的通用值，不是本场景的选择：
// 它决定单条连接可在内存中构造多大的消息，多连接并发时即为内存放大面。
// 通道流量的实际帧长远小于此值（MTU 约 1500，典型帧 < 64KB），
// 收紧上限对正常流量零影响。
//
// 帧键生成器：
//   默认（WS_MASK_CSPRNG=1）每帧取 4 字节 CSPRNG。引擎内置实现走 8KB 随机池
//   顺序消费——熵总量够，但池是模块级全局状态，多条连接共享同一个游标。
//   改为逐帧 CSPRNG 后，帧键在统计上与均匀随机不可区分，也不再跨连接
//   耦合。改动只涉及帧头的 4 个字节，不改变帧的语义。
//
//   注意：服务端默认不带帧键标识（RFC 6455 §5.1 的方向约束），生成器只在
//   该标识确实启用时被调用。这里接线是为了让"一旦要用，用的就是强的"，
//   而不是让服务端无条件开始带标识——后者会破坏与标准客户端的互通。
//
// 为什么生成器与 hubOptions 必须留在同一个文件：
//   generateMask 只在 hubOptions.generateMask 存在时才接线（见下方 if），
//   而 hubOptions 是构造 ChannelHub 的入参。二者一旦分居两个模块，
//   就多出一条"必须先设置生成器再构造实例"的隐式顺序约定——正是本项目
//   在别处已经吃过亏的那类脆弱契约。放在这里，顺序天然正确。
const maskKeyGenerator = CONFIG.WS_MASK_CSPRNG
    ? (buffer) => randomFillSync(buffer, 0, 4)
    : undefined;

const hubOptions = {
    noServer: true,
    // 等价模式下这个值是 100MB（参考实现不设上限，用传输层默认量级）。
    // 覆盖发生在 config.js 的 validateConfig 里——那里是所有取值收敛的
    // 唯一出口，因此这里读到的已经是最终生效值，无需再判一次开关。
    maxPayload: CONFIG.SYNC_MAX_PAYLOAD,
    // ── 子协议：刻意不回显 ──────────────────────────────────────
    //
    // 这里曾经写成 (protocols) => protocols[0] || false，有两个问题。
    //
    // 其一，它是个假实现：protocols 是 Set（subprotocol-picker 的返回
    // 类型），不是数组，protocols[0] 恒为 undefined，整个表达式因此
    // 恒等于 false。也就是说"回显第一个子协议"这个字面意图从未生效，
    // 正确结果是靠一个 bug 达成的——实测三种请求全部不回显。
    //
    // 其二，更要紧：**那个字面意图本身就是错的，不要把它"修好"。**
    //
    // VLESS 客户端（Xray / v2rayN）开启 early data 时会把首包塞进握手
    // 请求的 Sec-WebSocket-Protocol。握手完成后客户端看服务端有没有
    // 回显该字段来决定下一步：
    //   · 回显了   → 认为 early data 已被接受，于是**不再**发送首包；
    //   · 没回显   → 回退到正常发送首包。
    // 本服务不解析 early data。一旦回显，客户端不发首包、服务端永远
    // 等不到，连接必然卡死到首包超时——把上面那行改成真正回显，
    // 会让开启 early data 的客户端 100% 连不上。
    //
    // 不回显同时也符合 RFC 6455 §11.3.4：服务端只应回显它确实支持的
    // 子协议，本服务不声明任何子协议。
    handleProtocols: () => false
};

if (maskKeyGenerator) hubOptions.generateMask = maskKeyGenerator;

const syncSocketServer = new ChannelHub(hubOptions);

// —— 101 响应头扩展 ——
//
// 库在写 101 之前会 emit('headers', headers, req)，headers 是可变数组，
// 这是库注释明确提供的扩展点（"Allow external modification/inspection"），
// 无需改动 vendor。
//
// 补齐的内容**只有 Server 与 Date**，刻意不套用文档类安全策略头：
//
//   库默认只发 4 个头（Upgrade / Connection / Sec-WebSocket-Accept，可能带
//   Sec-WebSocket-Protocol）。一个自称 nginx/1.24.0 的站点，其 101 响应
//   却没有 Server 与 Date，是自相矛盾的——这两个必须补。
//
//   但 Content-Security-Policy / X-Frame-Options / Permissions-Policy /
//   Strict-Transport-Security 是**面向文档渲染**的指令，对一条已切换为
//   帧协议的连接没有语义。真实 nginx 反代做 WS 升级时只回
//   Upgrade / Connection / Sec-WebSocket-Accept / Server / Date；
//   在 101 上附 CSP 反而是"这些头由中间件无差别套到所有响应"的痕迹
//   ——真实反代的 add_header 按 location 生效，数据面升级路径拿不到
//   文档 location 的配置。
//
// 仅保留 X-Request-Id（贯穿请求链路，语义中立）与 Referrer-Policy
// （真实反代常在全局层下发）。
syncSocketServer.on('headers', (headers) => {
    headers.push('X-Request-Id: ' + randomBytes(8).toString('hex'));
    for (const [name, value] of Object.entries(UPGRADE_HEADERS)) {
        headers.push(name + ': ' + value);
    }
    headers.push('Server: ' + CONFIG.SERVER_HEADER);
    headers.push('Date: ' + new Date().toUTCString());
});

// —— 握手失败兜底 ——
//
// 一旦注册了该监听，库遇到非法握手**不再自行 abort**，改由这里接管。
// 因此这里必须写出响应 + 关闭 socket，否则客户端会一直等待。
// 应用层前置校验已覆盖当前所有**可达**的失败分支；此钩子作为安全网，
// 兜住库内其余（如 subprotocol / 扩展协商）分支，避免它们漏出库英文串。
syncSocketServer.on('wsClientError', (err, socket, req) => {
    // 记录一行内部日志便于排查，但**不**把错误串回给客户端。
    logger.warn('握手被拒（库内分支）', {
        error: (err && err.message) || 'unknown',
        url: requestPathname(req)
    });
    // 与前置校验保持一致：走回退层，给一个与普通 HTTP 请求同源的响应。
    // 判定"还能不能写"的条件与 refuseHandshake 原先的自检一致——
    // 该钩子可能在各种时序下触发，已写出过头部时不能重复写。
    const writable = socket && !socket.destroyed && !socket.headersSent && !socket.writableEnded;
    if (writable) {
        try {
            httpLayerFallback(req, socket);
            return;
        } catch (fallbackErr) {
            logger.debug('回退层写出失败，改为直接拆链', { error: fallbackErr && fallbackErr.message });
        }
    }
    // 走到这里说明响应已写出过、socket 已不可写，或回退层自己失败了。
    // 必须确保连接被关闭，不留悬挂连接。
    //
    // 这条是"什么都回不了、只能拆链"的静默出口。它同样要延迟：与上面
    // 那条能写出响应的分支相比，若它瞬时拆除而那条延迟，两条分支之间就
    // 又多出一档可测的时序差——等于给"这次失败属于哪一类"打了标签。
    afterDelay(requestPathname(req), socket, () => {
        try { if (socket && !socket.destroyed) socket.destroy(); } catch (_) {
            // destroy 是幂等的，失败只可能是"已经被拆过了"。
            // 这里若再记日志会与上面的 warn 重复，且无诊断增量。
        }
    });
});

// ====================================================================
// upgrade 请求处理
// ====================================================================

function handleUpgradeRequest(request, socket, head) {
    const pathname = requestPathname(request);

    // 仅放行同步端点池内的路径。
    //
    // 这里曾经直接回 404，留下了一个可被反向利用的差异：
    // 对同一批路径分别发普通 GET 和带 Upgrade 的请求，会得到
    //   stock       -> GET 200 / WS 404   （普通接口）
    //   live-stream -> GET 426 / WS 101   （升级路径）
    // 两者一一对应，观察方不需要知道令牌就能判断哪些路径支持升级。
    //
    // 现在的处理：对不接受的升级一律走与 HTTP 层完全相同的正常响应，
    // 使"路径存在性"与"是否支持升级"两件事解耦，无法互相印证。
    if (!CONFIG.SYNC_ENDPOINTS.includes(pathname)) {
        return httpLayerFallback(request, socket);
    }

    // —— 握手协议外观前置校验（在库之前）——
    //
    // 用与库逐条一致的判据先验一遍，库因此永远不会被调用、也不可能
    // 吐出它的英文报错串。这一步同时收紧了版本判据：只放行 13，不再
    // 接受库额外允许的 8（接受它是可精确匹配的实现指纹）。
    //
    // 注意位置：必须在"是否属于同步端点池"判断之后。对非同步路径，
    // 升级请求应当与普通 GET 完全同源（走 httpLayerFallback），
    // 不能因为握手格式问题而分叉出不同结果。
    //
    // ── 拒绝方式：走回退层，而不是自己拼一个 400 ──────────────
    //
    // 这里曾经回 400 + 一段 JSON。问题在于它与池外路径不同源：
    // 对池内路径发一个**非法**握手得 400，对池外路径（如 stock）
    // 发同样的请求得 405/200。于是探测者不必构造合法握手、不必知道
    // 令牌，只要发一个畸形 Upgrade 比对状态码，就能把端点池圈出来
    // ——「一次 curl 定位」只是换了个请求形态，并没有真正堵住。
    //
    // 改为走 httpLayerFallback 后，非法握手与"路径不在池内"走的是
    // 同一段代码、同一套判定：池内路径未注册进路由表，因此回 404，
    // 与任意不存在路径逐字一致。想要区分端点池，就必须构造一个
    // 完全合法的握手——而这正是我们唯一无法拒绝的事情（拒绝它就
    // 等于拒绝真实客户端）。
    //
    // 代价：真实客户端握手异常时会拿到 404 而非明确的 400，排障时
    // 少一条提示。客户端握手恒为合法，这条路径不会走；为便于定位，
    // 下面留了一行日志。
    const rejection = inspectHandshake(request);
    if (rejection) {
        logger.debug('升级请求未通过握手校验，按普通 HTTP 请求处置', {
            path: pathname,
            status: rejection.status,
            reason: rejection.reason
        });
        return httpLayerFallback(request, socket);
    }

    // —— 以下为并发/冷却判断，均在 upgrade 之前完成 ——
    const sourceIp = clientIp(request, socket);

    // 每处拒绝都必须带上"哪一道闸"与来源：前者决定 /_diag/channel 的
    // gates.refused 记在哪一格，后者决定日志里的来源标签。两者缺失时，
    // "浏览器打不开网页"就只能靠客户端症状反推——2026-09-24 那次三轮
    // 排查扑空，正是因为这两样都没有。
    const cooling = cooldownRemaining(sourceIp);
    if (cooling > 0) {
        refuseUpgrade(request, socket, 429, 'Too Many Requests',
            { retryAfter: Math.ceil(cooling / 1000) }, 'cooldown', sourceIp);
        return;
    }

    // 总量闸：正式连接与"借名额"的连接加总不得越过全局上限。
    // 只算正式连接会让 pending 成为绕过总量限制的旁门。
    if (CONFIG.MAX_TOTAL_CONNECTIONS > 0
        && (lifecycle.total + lifecycle.pending) >= CONFIG.MAX_TOTAL_CONNECTIONS) {
        refuseUpgrade(request, socket, 503, 'Service Unavailable',
            { detail: 'sync capacity saturated', retryAfter: 15 }, 'total', sourceIp);
        return;
    }

    if (CONFIG.MAX_CONNECTIONS_PER_IP > 0 &&
        (lifecycle.perIp.get(sourceIp) || 0) >= CONFIG.MAX_CONNECTIONS_PER_IP) {
        refuseUpgrade(request, socket, 429, 'Too Many Requests',
            { detail: 'too many concurrent channels from this source', retryAfter: 10 },
            'perIp', sourceIp);
        return;
    }

    // pending 档的两个上限：此刻这条连接还没证明自己是合法客户端，
    // 先按更严格的额度借一个名额（借出与兑现见 limits.js）。
    if (CONFIG.MAX_PENDING_TOTAL > 0 && lifecycle.pending >= CONFIG.MAX_PENDING_TOTAL) {
        refuseUpgrade(request, socket, 503, 'Service Unavailable',
            { detail: 'sync capacity saturated', retryAfter: 5 }, 'pendingTotal', sourceIp);
        return;
    }

    if (CONFIG.MAX_PENDING_PER_IP > 0 &&
        (lifecycle.pendingPerIp.get(sourceIp) || 0) >= CONFIG.MAX_PENDING_PER_IP) {
        refuseUpgrade(request, socket, 429, 'Too Many Requests',
            { detail: 'too many pending channels from this source', retryAfter: 5 },
            'pendingPerIp', sourceIp);
        return;
    }

    bumpPending(sourceIp);

    // 两档生命周期：pending(借) → active(兑现) → null(已释放)。
    // 释放必须能分辨当前处在哪一档，否则会退错计数——pending 连接
    // 走 drop 会让 pending 计数只增不减，反之亦然。
    let phase = 'pending';
    // 通道形态（'datagram' / 'relay'），由数据面在首包通过令牌校验时告知。
    //
    // 记在闭包里而不是 release 时再问一次：连接走到释放时 socket 已经关了，
    // 数据面那边的状态也可能已经清掉，那时再判断形态拿不到可靠答案。
    // 初值取 'relay' —— 拿不到形态时记在有兜底的那一侧（见 limits.js）。
    let kind = 'relay';
    const release = () => {
        if (phase === 'pending') { dropPending(sourceIp); phase = null; }
        else if (phase === 'active') { drop(sourceIp, kind); phase = null; }
    };
    // 首包通过令牌校验时兑现名额。幂等：phase 一旦离开 pending 就不再动作。
    const onAccepted = (channelKind) => {
        if (phase !== 'pending') return;
        phase = 'active';
        if (channelKind === 'datagram') kind = 'datagram';
        promote(sourceIp, kind);
    };

    // handleUpgrade 若因握手非法自行拒绝，则不会回调，靠 socket 关闭兜底释放计数
    socket.once('close', release);

    // —— TCP 层保活 ——
    //
    // 在 upgrade 之前设置，使保活在连接的业务生命周期开始前就生效
    // （握手完成后到首包之间也可能出现较长的空闲）。
    //
    // 这里刻意**只用 OS 层 keepalive，不发 WebSocket ping 帧**：
    //   · TCP keepalive 在 WS 帧层不可见，对业务表现零代价；
    //   · WS ping 帧会形成一条固定节拍，与"ERP 页面周期性轮询、
    //     其余时间静默"的真实形态不符，反而增加可识别性。
    // 保活的目的只是防止中间设备（NAT 表项 / PaaS 空闲回收）误判
    // 连接已死——这个目的用 OS 层探测即可达成。
    //
    // setKeepAlive 不可用时静默跳过：部分 Duplex 实现没有该方法，
    // 而保活属于优化项，不应因为它导致连接建立失败。
    if (CONFIG.TCP_KEEPALIVE_DELAY > 0 && typeof socket.setKeepAlive === 'function') {
        try { socket.setKeepAlive(true, CONFIG.TCP_KEEPALIVE_DELAY); } catch (err) {
            // 保活是优化项，失败不应阻断连接建立。但确实值得留一行：
            // 若某类 socket 实现始终不支持，会表现为"长连接偶发被中间
            // 设备回收"，那时需要这行日志才能定位。
            logger.debug('TCP keepalive 设置失败，连接继续', { error: err && err.message });
        }
    }

    try {
        syncSocketServer.handleUpgrade(request, socket, head, ws => {
            ws.once('close', release);
            syncSocketServer.emit('connection', ws, sourceIp, onAccepted);
        });
    } catch (err) {
        // handleUpgrade 抛异常意味着一条已经通过全部前置校验的连接
        // 没能建立。这是异常事件，必须记 error——否则表现为"客户端
        // 偶发连不上、服务端日志一片干净"。
        logger.error('handleUpgrade 异常，拒绝该连接', { error: err && err.message });
        release();
        socket.destroy();
    }
}

// ====================================================================
// 挂载与数据面入口
// ====================================================================

// 连接建立后的数据面入口：这一层与 upgrade 请求解析分离，
// 使"握手如何被接受"与"接受后如何转发"两件事各自独立、互不影响。
function onChannelEstablished() {
    syncSocketServer.on('connection', (ws, sourceIp, onAccepted) => {
        const state = createSession(ws, sourceIp);
        // 首包通过校验时由数据面回调，兑现握手阶段借出的名额。
        // 用可选属性而非必传参数：vendor 的 connection 事件只保证前两个
        // 参数，缺了也不能让连接失败（计数是保护项，不该决定连通性）。
        state.onFirstBatchAccepted = typeof onAccepted === 'function' ? onAccepted : null;
        const bp = createBackpressure(state);
        armFirstBatchTimeout(state);

        ws.on('message', (msg) => {
            if (state.isFirstBatch) {
                state.isFirstBatch = false;
                clearFirstBatchTimeout(state);
                handleFirstBatch(state, bp, msg);
            } else {
                handleSubsequent(state, bp, msg);
            }
        });

        ws.on('close', () => teardownChannel(state));
        ws.on('error', () => teardownChannel(state));
    });
}

// 将同步通道挂载到 HTTP 服务上
function attachSync(server) {
    // —— 等价模式的启动宣告 ——
    //
    // 必须在挂载之前打出：这是"这次部署到底带着哪个形态起来"的唯一凭据。
    // 用户改完环境变量重启后，第一件事就是在生产日志里找这一行；若它
    // 没出现，说明环境变量没生效（而不是"改了没用"）——这两种情况在
    // 客户端侧的表现完全一样，只有这行日志能把它们分开。
    //
    // 开关关闭时本函数是空操作，不产生任何输出。
    announceCompat();

    // 路由表由 lib/gateway.js 在**模块加载时**通过 route() 填充。
    // 回退层（httpLayerFallback）依赖这张表给出与 HTTP 层同源的判定，
    // 因此"表必须已填充"是挂载通道的前置条件。
    //
    // 正常情况下 gateway-worker 先 require('../gateway') 再 require
    // ('../sync-core')，顺序天然成立。但那是一条**隐式**约定：
    // 任何人调整 require 顺序、或在别的入口里只引 sync-core，都会让
    // 端点池判定退化成"全部落 404"，表现为"客户端连不上而服务端一切
    // 正常"——又是一次静默失效。这里显式断言，把它变成启动期硬失败。
    if (!Array.isArray(ROUTES) || ROUTES.length === 0) {
        console.error('[FATAL] 路由表为空，同步通道拒绝挂载。');
        console.error('        同步端点的响应语义依赖 lib/gateway.js 注册的路由表，');
        console.error('        请确认在 require("./sync-core") 之前已 require("./gateway")。');
        process.exit(1);
    }

    server.on('upgrade', (request, socket, head) => {
        // 整条 upgrade 链路都包在 try 里。
        //
        // 原因：upgrade 事件回调抛出的异常不会被 HTTP 层捕获，也不会触发
        // 'clientError'。一旦抛出，socket 会一直处于"已连接但不响应"的状态，
        // 直到客户端自己超时——既浪费连接表，也留下一个可被用来占满
        // 文件描述符的面。这里做最后一道兜底：确保任何意外都以
        // 明确响应 + 关闭收场。
        try {
            handleUpgradeRequest(request, socket, head);
        } catch (err) {
            logger.error('upgrade 处理器异常，按内部错误收场', { error: err && err.message });
            // 这条兜底出口同样走延迟：它是"服务端出错"这一类出口，
            // 瞬时返回会让它与其余升级出口形成可分辨的时序差。
            // 500 是内部错误，正常情况下走不到；即便走到，多等几十毫秒
            // 也不会比"立刻暴露这是条特殊路径"更糟。
            // 路径在这里重新取一次：本 catch 位于 attachSync 的 upgrade
            // 回调里，拿不到 handleUpgradeRequest 内部的 pathname 局部变量。
            afterDelay(requestPathname(request), socket, () => {
                try {
                    if (!socket.destroyed) {
                        socket.end('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n'
                            + 'Content-Length: 0\r\n\r\n');
                    }
                } catch (endErr) {
                    // 兜底响应也写不出去：socket 已不可写。上面已记 error，
                    // 这里只补一行 debug 说明降级路径，不升级级别。
                    logger.debug('upgrade 兜底响应写出失败', { error: endErr && endErr.message });
                }
                try { socket.destroy(); } catch (_) { /* 已经不可用，destroy 幂等 */ }
            });
        }
    });

    onChannelEstablished();
}

module.exports = { attachSync, getSyncStats };
