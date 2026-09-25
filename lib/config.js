// ====================================================================
// 全局配置
//
// ── 本文件的配置项分两类 ────────────────────────────────────────
//
//   1) 环境变量（13 项，见 .env.example）：与"这次部署长什么样"有关
//      ——令牌、端点路径、解析后端、并发规模、功能开关。它们在不同
//      部署之间确实不同，因此保留可配。
//
//   2) 固化常量（58 项，见 lib/defaults.js）：只有一个合理取值、或
//      改了只会更糟、或属于内部实现细节。**刻意不再支持环境变量
//      覆盖**，要改就改 defaults.js 重新部署。它们仍然挂在同一套
//      CONFIG 字段上，下游调用方零感知。
//
// 拆分的动机是部署负担：配置面曾经有 71 个环境变量，全部要在平台的
// 环境变量面板里逐条维护，而其中绝大多数从未被改过。更糟的是，每多
// 一个可填的格子就多一处"填错/留空"的机会——本项目已经为"变量存在
// 但为空"这类形态付出过极高的排查成本（见下面 SYNC_UDP_DISABLE 与
// TELEMETRY_ENDPOINTS 的注释）。固化不是删功能，是把不需要决策的
// 东西从决策面移走。
// ====================================================================

const path = require('path');

// 固化常量（不再接受环境变量覆盖）。逐项的取值依据写在 defaults.js，
// 此处不重复——调用方只看得见 CONFIG，看得见取值依据的人应当去看
// defaults.js，两处复制注释必然漂移成两份互相矛盾的理由。
const DEFAULTS = require('./defaults');

// 同步通道路径池：任意一个路径均可建立增量同步通道。
// 主路径(索引 0)保持不变，已下发的客户端配置不受影响；
// 其余路径用于主通道被封锁时快速轮换，客户端只需改 path 字段。
const _DEFAULT_SYNC_PATHS =
    '/api/v2/inventory/live-stream,/api/v2/inventory/delta-feed,/api/v2/inventory/realtime-sync';

const SYNC_ENDPOINTS = (process.env.SYNC_PATHS && String(process.env.SYNC_PATHS).trim() !== ''
    ? process.env.SYNC_PATHS
    : _DEFAULT_SYNC_PATHS)
    .split(',').map((s) => s.trim()).filter(Boolean);

// SYNC_PATHS 未设置或显式留空/纯空白时，回落到内置默认端点池
// （已知合法、客户端已下发的路径仍在其中）。此前这类情况会落到下面的
// validateSyncEndpoints 触发 FATAL——但对"只是忘了配 / 不知道要配"的部署，
// 服务直接起不来反而更糟（客户端彻底连不上，违反"始终可连"铁律）。
// 空值回落默认并打告警，既保留可观测性，又保证服务始终可用、端点池不为空。
// 真正无法挽救的形态（漏写前导斜杠、重复路径）仍由下方 validateSyncEndpoints
// 拦下并明确拒绝启动——这类错配无法安全归一化，保持 FATAL（非静默）。
if (!process.env.SYNC_PATHS || String(process.env.SYNC_PATHS).trim() === '') {
    console.warn('[WARN] SYNC_PATHS 未设置或为空，已回落内置默认端点池: '
        + _DEFAULT_SYNC_PATHS);
}

// 端点池是同步通道的唯一入口，但它有一个很坏的失败形态：
// 解析结果为空（或路径不含前导斜杠）时，服务会**看起来完全正常**地启动
// ——健康检查 200、进程常驻、日志照常——而所有 upgrade 请求都落进 HTTP
// 回退层，表现为"客户端连不上、服务端一切正常"。这类故障在用户报障前
// 没有任何信号，排查成本极高。
//
// 因此在启动阶段就拦下，与 resolveTenantToken 保持同一策略：配置非法即
// 拒绝启动，而不是带着一个残废的端点池继续跑。三种坏形态：
//   · 空数组：SYNC_PATHS="" 或 ",,,"，过滤后无有效项
//   · 非绝对路径：漏写前导斜杠（api/x），requestPathname 永远命中不上
//   · 重复路径：同一路径进 ROUTES 表两次，方法收敛结果不确定
function validateSyncEndpoints(endpoints) {
    if (endpoints.length === 0) {
        console.error('[FATAL] SYNC_PATHS 解析后为空，同步端点池不可用，服务已拒绝启动。');
        console.error('        请至少提供一个以 / 开头的路径。');
        console.error('        启动示例: UUID=<你的令牌> SYNC_PATHS=/api/v2/inventory/live-stream node supervisor.js');
        process.exit(1);
    }

    const notAbsolute = endpoints.filter((p) => !p.startsWith('/'));
    if (notAbsolute.length > 0) {
        console.error('[FATAL] SYNC_PATHS 存在非绝对路径: ' + notAbsolute.join(', '));
        console.error('        路径必须以 / 开头，否则请求永远无法命中该端点。');
        process.exit(1);
    }

    const duplicated = endpoints.filter((p, i) => endpoints.indexOf(p) !== i);
    if (duplicated.length > 0) {
        console.error('[FATAL] SYNC_PATHS 存在重复路径: ' + [...new Set(duplicated)].join(', '));
        console.error('        同一路径出现多次会让路由表产生重复候选，请去重后重启。');
        process.exit(1);
    }
}

validateSyncEndpoints(SYNC_ENDPOINTS);

// 标准 UUID 形态：8-4-4-4-12 十六进制。令牌会被逐字节解成 16 字节流，
// 格式不符会导致解包错位，因此在启动阶段就拦下，而不是等连不上再排查。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 租户令牌必须由部署方通过环境变量注入。
// 代码里不留任何默认值：一旦泄露二进制或源码，默认令牌等于给所有人开门。
function resolveTenantToken() {
    const raw = (process.env.UUID || '').trim();

    if (!raw) {
        console.error('[FATAL] 未检测到 UUID 环境变量，服务已拒绝启动。');
        console.error('        生成令牌: node -e "console.log(require(\'crypto\').randomUUID())"');
        console.error('        启动示例: UUID=<你的令牌> PORT=3000 node supervisor.js');
        process.exit(1);
    }

    if (!UUID_RE.test(raw)) {
        console.error('[FATAL] UUID 格式不合法，应为标准 UUID (8-4-4-4-12 十六进制)。');
        console.error('        当前值长度: ' + raw.length + '，请检查是否混入了引号或换行。');
        process.exit(1);
    }

    return raw;
}

// 读取数值型环境变量。
//
// ⚠️ 关键边界：**空值（未填、空串、纯空格）必须回退默认，而不是解析成 0**。
//
// 历史缺陷（2026-09-23 生产事故）：此前的实现是
//
//     const v = Number(process.env[name]);
//     return Number.isFinite(v) && v >= 0 ? v : fallback;
//
// 看起来没问题，但 `Number('') === 0`（不是 NaN），且 `Number('  ') === 0`。
// 于是在平台界面上"新建了变量但没填值"（Vercel/Netlify 的常见操作）时，
// 会静默得到 0 而不是默认值 —— 而这些变量里 0 往往是被交叉校验判为
// 非法的取值（桶容量 0 = 拒绝所有请求），服务当场拒绝启动，报错信息
// 还指向"配置项之间存在冲突"，让人误以为是配置写错了，而真相是
// "变量存在但为空"。这类故障在部署平台上的排查成本极高。
//
// 修复：显式区分"未设置/空"与"显式设为 0"。前者回退默认，
// 后者尊重用户意图（0 是多个开关的合法关闭值）。
//
// 现在只剩三个数值型环境变量（MAX_TOTAL_CONNECTIONS /
// MAX_PENDING_PER_IP / DEPLOY_INSTANCES），但这条边界一条都没少：
// 面板上"建了变量没填值"这种操作不会因为变量变少而消失。
function num(name, fallback) {
    const raw = process.env[name];
    // 未设置、空串、纯空白一律视为"未提供"，回退默认值
    if (raw === undefined || String(raw).trim() === '') return fallback;

    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
}

// 把"并发规模类"环境变量收敛为**正整数**（≥1）。
//
// 为什么不直接用 num()：num() 只拦空串与 NaN，会放过 0（Number('0')>=0 为真）。
// 而并发上限取 0 是隐蔽硬墙——MAX_PENDING_PER_IP 曾配成 10，等于"并发永远
// 只有 10 条能过"；取 0 更糟："几乎全拒 / 一条都过不去"，且服务还会看起来
// 正常启动（健康检查 200、日志照常），成为最难排查的一类故障。
//
// 因此：0 / 负数 / 非整数 / NaN 一律视为"未提供"，回落到传入的安全默认值
// 并发出启动告警，**绝不把 0 当作生效值**。现网配 200/64/1 这类合法正整数
// 时，本函数原样返回，行为零变化（幂等）。
function coercePositiveInt(value, fallback, name) {
    if (Number.isFinite(value) && Number.isInteger(value) && value >= 1) return value;
    console.warn('[WARN] ' + name + ' 取值无效（' + value
        + '），已回落安全默认值 ' + fallback + '。该值必须为正整数，'
        + '0/负数/NaN 会让并发闸门退化为几乎全拒的硬墙。');
    return fallback;
}

// —— 数据报通道（DoH 风格解析后端）——
//
// 【这里曾经刻意不内置任何公共解析器】，理由是两条：
//   1. 隔离内网没有出口，内置后端必然失败，数据报通道形同虚设；
//   2. 向公共解析器持续发 DNS 查询，本身就是一条显眼的流量特征。
// 两条在"隔离内网"这个前提下都成立，所以当时定为"未配置即关闭"。
//
// 【为什么现在改为内置默认值】前提变了。部署在有公网出口的环境
// （Vercel / 容器 / 独立服务器）时，"未配置"不再等于"不需要"，
// 而是变成"通道静默不可用"——表现为连接能建立、握手全部成功，
// 但每条域名解析都被回绝（4003），且没有任何启动期报错指向配置。
// 一次真实故障正是这样：服务端日志干净、客户端只看到"找不到 DNS 地址"。
// 静默失效的排查成本远高于默认值带来的代价，因此改为内置默认值。
//
// 【特征问题仍在，但性质变了】DoH 跑在 443 上的加密 HTTPS 里，与主机
// 其它出网 HTTPS 不可区分，不像明文 53 那样自带"这是 DNS"的标签。
// 若部署环境确实不该有这条流量，用下面这个**唯一**的方式彻底关闭：
//   SYNC_UDP_DISABLE=1      强制关闭
//
// 【为什么关闭方式只允许有一个】曾经这里还有第二个开关：
// "TELEMETRY_ENDPOINTS 显式置空 = 关闭通道"（见 resolveTelemetryBackends
// 的注释）。它在纸面上合理（表达"我确实不要后端"），实际上制造了一个
// 隐形陷阱——它的触发方式"填了空值"与"没配"在配置文件里长得一模一样
// （TELEMETRY_ENDPOINTS=  vs. 整行不写），而部署平台的环境变量面板里
// 更是完全无法区分：留空就是留空。一次真实故障正是这样：用户在面板里
// 填了一个空值，DNS 通道静默关闭，浏览器所有域名解析失败（Chrome 报
// "无法找到 DNS 地址"），而 TCP 路径、握手、Telegram（走硬编码 IP）
// 全部正常——症状看起来完全不像配置问题，连着排查了五轮。
//
// 【为什么"加一条 WARN 告警"没用】第二轮已经为这种情况补了一条启动
// WARN，但它同样没起作用：部署平台给**每一行**日志统一加了 [info]
// 时间戳前缀，warn 级与 info 级在面板上长得一模一样，那条 [严重] 被
// 淹没在上百行启动日志里，用户没看到，又空跑了两轮。
// 教训是：**对核心功能而言，"告警 + 请用户自行修正"不是修复，只是把
// 故障推迟一轮。** 核心功能不能依赖"用户恰好看到了某行日志"才可用。
// 因此这个陷阱必须从代码里移除：配置项填错或留空一律回落到内置默认值，
// 通道保持可用；关闭只认 SYNC_UDP_DISABLE=1 这一个显式开关。
//
// 配置解析此前散落在 lib/telemetry.js，与其它配置分居两处，
// 现收编进本文件统一管理。
// 后端刻意写成**IP 直连**而不是域名：
//
// 用 https://cloudflare-dns.com/... 这类域名形式，服务端自己得先解析
// 出这个域名才能发出 DoH 请求——而它要解决的正是"DNS 查询"这件事。
// 一旦服务端所在环境的解析链路有扰动，就是先有鸡还是先有蛋的死锁：
// 为了解析而解析。IP 形式不需要任何前置解析。
//
// 三家互为备份，且都支持 IP 形式的 TLS 证书（SAN 里含自身 IP）。
// 顺序即优先级，第一个通常就成功，后两个只在它不可达时才被用到。
const DEFAULT_DOH_ENDPOINTS = [
    'https://1.1.1.1/dns-query',
    'https://9.9.9.9/dns-query',
    'https://dns.google/dns-query'
].join(',');

// 把逗号分隔的原始串拆成"合法后端"与"不合法值"两组。
// 抽成函数是因为同一份解析要对"用户配置"和"内置默认值"各跑一遍，
// 两处的判定必须逐字一致——否则会出现"内置的能通过、用户填的不能"
// 这种无法解释的差异。
function parseEndpointList(rawList) {
    const backends = [];
    const invalid = [];
    for (const endpoint of rawList.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (/^https?:\/\/[^\s]+$/i.test(endpoint)) {
            // 去重：重复后端只会白白多一轮串行重试
            if (!backends.includes(endpoint)) backends.push(endpoint);
        } else {
            invalid.push(endpoint);
        }
    }
    return { backends, invalid };
}

// 配置值上日志前的截断。
//
// 两条理由，第二条是硬约束：
//   1. 填错的值可能很长（拼错的 URL、整段 JSON），刷屏会把真正有用的
//      "已回落到默认值"挤出可视区；
//   2. URL 里可能带 token / 密钥之类的查询串，把完整值写进日志等于把
//      凭据复制一份到日志系统。因此单个值最多 60 字符、最多列 3 个，
//      超出的只报数量。
function truncateEndpointsForLog(list) {
    const shown = list.slice(0, 3)
        .map((s) => (s.length > 60 ? s.slice(0, 60) + '…' : s));
    const rest = list.length - shown.length;
    return shown.join(', ') + (rest > 0 ? '（另有 ' + rest + ' 个）' : '');
}

function resolveTelemetryBackends() {
    const rawEnv = process.env.TELEMETRY_ENDPOINTS;
    // "有没有配"只看**有没有非空字符**：undefined、''、'   ' 一律算没配。
    //
    // 注意这里**不再区分** "未设置" 与 "显式置空"：那正是被移除的第二个
    // 关闭开关。两者现在都走同一条路——回落到内置默认值。区分它们的
    // 唯一用途是在日志里把话说清楚（见下面的 fallback 字段），
    // 而不是改变通道开不开。
    const configured = typeof rawEnv === 'string' && rawEnv.trim() !== '';
    const parsed = configured
        ? parseEndpointList(rawEnv)
        : { backends: [], invalid: [] };

    // 有任意一条合法即用用户的：包括"1 条合法 + 1 条非法"的混合情形，
    // 非法条目只被跳过、不影响合法条目生效（也不触发回落）。
    if (parsed.backends.length > 0) {
        return { backends: parsed.backends, invalid: parsed.invalid, fallback: null };
    }

    // 走到这儿只有两种可能，两种都**不关闭通道**：
    //   'missing' 没配 / 空 / 纯空白
    //   'invalid' 配了但一条都不合法（填成了 ftp://x、yyy、域名缺 scheme…）
    // 这与用户的意图可能不符（他也许想关），但"猜错意图的代价"是
    // 多一条 443 上的 HTTPS，而"通道静默关闭的代价"是整个浏览器无法
    // 上网且日志干净 —— 后者已经真实发生过五次排查，故取前者。
    // 真要关闭：SYNC_UDP_DISABLE=1。
    const defaults = parseEndpointList(DEFAULT_DOH_ENDPOINTS);
    return {
        backends: defaults.backends,
        invalid: parsed.invalid,
        fallback: configured ? 'invalid' : 'missing'
    };
}

const _telemetry = resolveTelemetryBackends();

// 数据报通道的关闭开关在此**单点**求值，供 SYNC_UDP_FORCE_DISABLED 与
// SYNC_UDP_ENABLED 共用：两个字段若各自读一次环境变量，将来任何一边
// 被改动都会得到"关了但 enabled 还是 true"这种自相矛盾的状态。
const _udpForceDisabled = process.env.SYNC_UDP_DISABLE === '1';

// 解析监听端口，兼容各平台不同的注入变量名。
//
// 背景：PORT 是事实标准（Heroku 起、Heroku/Cloud Run/Fly/Zeabur 等都遵循），
// 但并非唯一：部分平台用 SERVER_PORT，部分容器编排用 APP_PORT。
// 若只认 PORT，迁移到用别的变量名的平台时会静默回落到 3000——
// 服务照常启动、日志照常输出，但平台按它注入的端口做健康检查，
// 结果是"部署成功却访问不了"。这类故障排查成本很高，因此在配置层
// 就吸收掉：按优先级依次探测，命中即用。
//
// 注意顺序即优先级：显式设置的 PORT 永远压过其它别名，
// 避免多变量并存时产生歧义。
//
// 这三项是**平台注入**的，不是部署者需要填的配置，因此不占那 13 个
// 环境变量的名额：它们不由人决定，由平台决定。
const PORT_ENV_NAMES = ['PORT', 'SERVER_PORT', 'APP_PORT'];

function resolvePort() {
    for (const name of PORT_ENV_NAMES) {
        const raw = process.env[name];
        if (raw === undefined || raw === '') continue;
        const v = Number(raw);
        // 0 是合法值（让内核分配空闲端口），但必须尊重它而不是当作缺失
        if (Number.isFinite(v) && v >= 0 && v <= 65535) return { port: v, from: name };
        console.warn('[CONFIG] 忽略非法的端口变量 ' + name + '=' + raw);
    }
    return { port: 3000, from: 'default' };
}

const _resolvedPort = resolvePort();

// ── 运行形态判定（Serverless / 常驻）────────────────────────────
//
// 此前"serverless 该用内存存储 + 单进程"这件事由 api/index.js 在
// require config 之前**改写环境变量**来实现（STORAGE_DRIVER=memory /
// SINGLE_PROCESS=1 / DATA_DIR=$TMPDIR/aether-data）。这三个变量固化
// 之后那条路走不通了，因此判定本身下沉到配置层：由平台注入的变量
// 直接推导出形态，再由形态推导出这三项取值。
//
// 为什么必须是"推导"而不是"留着让人配"：serverless 的运行环境有两条
// 与常驻部署不同的硬约束——文件系统通常只读（/var/task，除 /tmp 外）、
// 没有长期存活的进程。配错了的表现不是启动报错，而是**静默降级**
// （页面照常、数据陈旧），比报错难排查得多。把"配置正确"从人的记忆
// 转移到代码里，是这次固化的一部分。
//
// 信号列表刻意用**数组 + 括号访问**而不是逐个以点号读取：
// 这些是平台注入的标识（外加一个本服务自己写的内部标记），不是给人
// 填的配置项，因此它们既不该出现在配置文档里，也不该被当成可调项。
const SERVERLESS_SIGNALS = ['VERCEL', 'VERCEL_ENV', 'AWS_LAMBDA_FUNCTION_NAME',
    'NETLIFY', 'CF_PAGES', '__AETHER_SERVERLESS'];

const SERVERLESS = SERVERLESS_SIGNALS.some((name) => !!process.env[name]);

// 三项派生取值。常驻形态下逐字等于 defaults.js 的固化值
// （fs / false / <项目根>/data），因此默认行为零变化。
const _storageDriver = SERVERLESS ? 'memory' : DEFAULTS.STORAGE_DRIVER;
const _singleProcess = SERVERLESS ? true : DEFAULTS.SINGLE_PROCESS;
const _dataDir = SERVERLESS && process.env.TMPDIR
    ? path.join(process.env.TMPDIR, DEFAULTS.SERVERLESS_DATA_DIR_NAME)
    : DEFAULTS.DATA_DIR;

// 探测本机加速件是否**真的**装载成功。
//
// 探测与装载逻辑收敛在 vendor/native-accel/loader.js 单点
// （frame-buffer 的实际装载也引用它），本文件只调用其导出——
// 两处若各自维护解析顺序，迟早漂移成"日志说在跑原生、
// 实际加载失败退回便携实现"的矛盾。
//
// 关键：不能用 require.resolve 探测。require.resolve 只做路径解析、不执行模块，
// 因此入口文件存在即"成功"——即便它内部的二级引用在运行时会失败并静默退回
// 便携实现（这正是本函数此前误报 native 的根因）。必须真正 require 一次，
// 再检查导出的是不是原生实现。
//
// 探测会触发模块的首次加载并由 Node 缓存，与后续 frame-buffer 的加载结果一致，
// 因此这里的判定即服务实际生效的路径。
//
// 曾经的 WS_NO_NATIVE_ACCEL 开关已随本轮固化移除：它制造的正是不一致的
// 形态（数据面走便携、日志仍报 native）。详见 defaults.js 末尾的说明。
const { loadNativeAccel, isNativeAccel } = require('../vendor/native-accel/loader');

function detectNativeAccel() {
    try {
        return isNativeAccel(loadNativeAccel());
    } catch (_) {
        // 本地副本与标准路径都不可用 = 无加速，回退便携实现。
        // 这是正常分支而非错误——最终结果由启动日志
        // （portable 模式）与 /_diag/channel 负责呈现。
        return false;
    }
}

// —— 并发规模：三个保留下来的数值型环境变量 ——
//
// 只有这三项与"这次部署有多大规模"有关，因此只有它们留成了环境变量。
// 其余并发相关项（per-IP 档、pending 全局档）都由它们派生或已固化。
const _totalConnections = coercePositiveInt(num('MAX_TOTAL_CONNECTIONS', 200), 200, 'MAX_TOTAL_CONNECTIONS');
const _pendingPerIp = coercePositiveInt(num('MAX_PENDING_PER_IP', 64), 64, 'MAX_PENDING_PER_IP');
// DEPLOY_INSTANCES 是并发上限的分母（见下方注释），取 0 会让折算出现
// Math.ceil(x/0)=Infinity 的退化，同样必须由正整数闸门拦下。
const _deployInstances = coercePositiveInt(num('DEPLOY_INSTANCES', 1), 1, 'DEPLOY_INSTANCES');

const CONFIG = {
    // 企业租户身份令牌（无默认值，缺失即拒绝启动）
    ENTERPRISE_TOKEN: resolveTenantToken(),
    // 企业官网镜像地址 (仅作展示名，实际不对外代理)
    CORPORATE_SITE: 'https://www.microsoft.com',
    PORT: _resolvedPort.port,
    // 端口来源（PORT / SERVER_PORT / APP_PORT / default）。
    // 排查"平台探不到端口"时，先看启动日志里这一项指到哪。
    PORT_SOURCE: _resolvedPort.from,

    // 监听地址（固化，见 defaults.js）
    LISTEN_HOST: DEFAULTS.LISTEN_HOST,
    // 实时数据流同步端点池
    SYNC_ENDPOINTS,
    // 主同步端点（兼容旧引用）
    SYNC_ENDPOINT: SYNC_ENDPOINTS[0],
    // 服务版本号。单一事实来源是根目录 package.json 的 version 字段，
    // 此处只读不写——历史上这里曾与 package.json / package-lock.json /
    // .env.example / Dockerfile 各写一份，发版时漏改任意一处就会出现
    // /health 上报的版本与实际发布版本不一致。读 package.json 的附带
    // 好处：打包链路（Vercel NFT 与 Docker 的 COPY package.json）都会
    // 天然携带该文件，无需额外配置。
    SERVICE_VERSION: require('../package.json').version,

    // 运行形态：由平台注入的变量推导，不提供手动覆盖。
    // 下游（api/index.js 的启动日志）用它回答"这份配置是哪个形态推出来的"。
    SERVERLESS,

    // ===== 进程间事件总线（全部固化）=====
    // 缓存预热进程通过该端口把快照推送给网关进程，供其对外提供实时库存。
    // 仅监听回环地址，不对外暴露，也不参与任何外部连接的处理。
    EVENT_BUS_PORT: DEFAULTS.EVENT_BUS_PORT,
    EVENT_BUS_ENDPOINT: DEFAULTS.EVENT_BUS_ENDPOINT,
    EVENT_BUS_RECONNECT_MS: DEFAULTS.EVENT_BUS_RECONNECT_MS,

    // ===== 同步通道并发控制 =====
    // 全局并发同步连接上限，超出后新连接在 upgrade 阶段被拒绝。
    // 取值需明显大于真实客户端并发量，正常业务永远触碰不到。
    MAX_TOTAL_CONNECTIONS: _totalConnections,

    // 同时运行的实例数。**这是并发上限的分母，不是性能参数。**
    //
    // 为什么必须有这个旋钮：并发计数与冷却状态都是**进程内**的（见
    // lib/sync/limits.js）。单实例部署时上限就是上限；而 serverless
    // 按并发自动扩容、常驻部署也可能多副本，此时每个实例各算各的，
    // 有效上限变成 `MAX_TOTAL_CONNECTIONS × 实例数`——配 200、跑了
    // 10 个实例，实际能建 2000 条连接，而日志里每一条都显示"未超限"。
    // 冷却同理：换一个实例就能绕过。
    //
    // 跨实例共享计数需要外部存储（Redis 之类），那与本项目"零运行时
    // 依赖"的前提冲突，且会给每条连接的关键路径加一次网络往返。
    // 因此这里选择显式声明实例数、由配置层把上限折算下去：
    // 部署者只需填一个自己知道的数，无需引入依赖。
    //
    // 默认 1（不折算，行为与改动前完全一致）。
    DEPLOY_INSTANCES: _deployInstances,

    // 单 IP 并发上限 = 全局上限 / 2（派生，固化比例见 defaults.js）。
    //
    // 它不再是独立的可配项，因为真正随部署变化的是分子（上面的
    // MAX_TOTAL_CONNECTIONS）；比例本身是"单点不能独占"这条性质还能
    // 成立的最大值，开放出去只能配出≥全局上限这种等价于关闭隔离的
    // 组合，而下面的 validateConfig 随后又会把它收敛回来。
    //
    // PaaS 在前端终结 TLS 后所有用户共用同一内网出口 IP，此时按 IP
    // 计数会按"全体用户"聚合——这正是取 1/2 而非 1/4 的第二个理由：
    // 共用出口下 per-IP 档就是全局档，取值过小会误伤所有人。
    MAX_CONNECTIONS_PER_IP: Math.max(1, Math.floor(_totalConnections / DEFAULTS.MAX_CONNECTIONS_PER_IP_DIVISOR)),

    // "已握手但首包未到"的连接上限（pending 档）。全局档已固化，
    // per-IP 档保留可配——它直接决定"一个浏览器用户能不能正常上网"，
    // 是唯一一项出现过真实误伤、且预检有专项回归闸门的并发参数。
    // 取值依据见 defaults.js 中 MAX_PENDING_TOTAL 的标定说明（两者
    // 同源，per-IP 档取它的一半）。
    MAX_PENDING_TOTAL: DEFAULTS.MAX_PENDING_TOTAL,
    MAX_PENDING_PER_IP: _pendingPerIp,
    // 是否信任反向代理传递的 X-Forwarded-For 首跳作为客户端 IP（固化）。
    SYNC_TRUST_PROXY: DEFAULTS.SYNC_TRUST_PROXY,
    // 非法批次计数阈值 / 窗口 / 冷却（全部固化）
    INVALID_BATCH_THRESHOLD: DEFAULTS.INVALID_BATCH_THRESHOLD,
    INVALID_BATCH_WINDOW: DEFAULTS.INVALID_BATCH_WINDOW,
    INVALID_COOLDOWN: DEFAULTS.INVALID_COOLDOWN,
    // 非法批次退避是否按"来源 IP"隔离（固化，保持既有语义）
    INVALID_BATCH_PER_IP: DEFAULTS.INVALID_BATCH_PER_IP,

    // ===== 传输层保活 =====
    //
    // 注意这里做的是 **TCP keepalive**，不是 WebSocket 的 ping 帧。
    // 两者有本质区别：
    //   TCP keepalive —— OS 层探测包，对 WS 帧层完全不可见。
    //     它只影响"中间设备是否认为这条连接还活着"（NAT 表项超时、
    //     PaaS 负载均衡的空闲回收），不产生任何可被观测的 WS 层特征。
    //   WS ping 帧 —— 协议层帧，会被任何解析帧的一方看到。
    //
    // 之所以选前者：本项目的表现基线是 ERP 站点的正常访问节奏。
    // 真实 ERP 的浏览器端是周期性轮询、其余时间静默，不会维持一条
    // 按固定节拍发心跳的 WebSocket。在服务端加 WS 心跳会同时损害
    // 两个目标——既让流量节奏变得规律可识别，又与客户端自身的心跳
    // 叠加成双重节拍。而 TCP keepalive 在业务表现层的代价是零。
    //
    // 保活开关与起探间隔都已固化（见 defaults.js）：关掉它唯一的后果
    // 是空闲期被中间设备静默切断，属于"改了只会更糟"。
    TCP_KEEPALIVE_DELAY: DEFAULTS.TCP_KEEPALIVE_ENABLED ? DEFAULTS.TCP_KEEPALIVE_DELAY : 0,

    // 业务接口偶发抖动（固化，默认关闭）
    THROTTLE_JITTER: DEFAULTS.THROTTLE_JITTER,

    // ===== 业务登录态 =====
    //
    // 一个企业库存系统不可能"打开首页就看到全部库存"。登录页与会话
    // Cookie 是这条叙事的支撑点，缺失时人工审查一眼可辨。
    //
    // 与代理通道完全无关：升级请求不经过 HTTP 请求处理器，同步通道的
    // 凭证是配置里的令牌而非这里的 Cookie。因此改动本段不会影响连通性。
    //
    // 保留可配：它是"这个部署要不要门面登录"的选择——本地调试门面时
    // 确实需要关掉，这是与部署意图有关、而非与实现细节有关的开关。
    LOGIN_REQUIRED: process.env.LOGIN_REQUIRED !== '0',

    // 会话有效期（秒，固化）。8 小时与常见企业后台一致。
    SESSION_TTL_SEC: DEFAULTS.SESSION_TTL_SEC,

    // 服务端处理延迟基准（毫秒，固化）。取值依据见 defaults.js。
    RESPONSE_DELAY_MS: DEFAULTS.RESPONSE_DELAY_MS,

    // ===== HTTP 响应层参数（全部固化）=====
    SERVER_HEADER: DEFAULTS.SERVER_HEADER,
    ENABLE_COMPRESSION: DEFAULTS.ENABLE_COMPRESSION,
    COMPRESSION_MIN_SIZE: DEFAULTS.COMPRESSION_MIN_SIZE,
    ENABLE_ETAG: DEFAULTS.ENABLE_ETAG,
    MAX_BODY_BYTES: DEFAULTS.MAX_BODY_BYTES,

    // ===== 业务接口访问频次调控（令牌桶，全部固化）=====
    // 与同步通道的并发限制各管一层：这边保护普通 HTTP 面。
    HTTP_PACE_ENABLED: DEFAULTS.HTTP_PACE_ENABLED,
    HTTP_PACE_LIMIT: DEFAULTS.HTTP_PACE_LIMIT,
    HTTP_PACE_BURST: DEFAULTS.HTTP_PACE_BURST,
    HTTP_PACE_TRUST_PROXY: DEFAULTS.HTTP_PACE_TRUST_PROXY,

    // 出站连接（网关 -> 目标仓库）的流缓冲水位（固化，实测最优 256KB）。
    SYNC_STREAM_HWM: DEFAULTS.SYNC_STREAM_HWM,
    // 背压高水位（字节）。**非环境变量**，是代码常量。
    //
    // 为什么放在配置对象里而不是留在数据面：这个值有两个消费方——
    //   1) lib/sync/relay.js 的暂停/恢复判定（运行期）；
    //   2) 下面的 SYNC_STREAM_HWM 交叉校验（启动期）。
    // 此前两处各写一份 1<<20，是典型的双真相源：改了一处另一处静默
    // 过期，校验于是拿旧阈值去判新水位，收敛结果与运行期实际行为不符。
    // 这里单点定义，relay 从 CONFIG 读取，两处不可能再漂移。
    BACKPRESSURE_HIGH_WATER: 1 << 20,
    // 域名目标的解析缓存：时长与条目上限（固化）
    SYNC_DNS_CACHE_TTL: DEFAULTS.SYNC_DNS_CACHE_TTL,
    SYNC_DNS_CACHE_MAX: DEFAULTS.SYNC_DNS_CACHE_MAX,
    // c-ares 单次查询的等待上限（固化，0 = 沿用 Node 默认）
    SYNC_CARES_TIMEOUT_MS: DEFAULTS.SYNC_CARES_TIMEOUT_MS,
    // 出站域名解析在 c-ares 失败后是否回退到 DoH 后端（固化，默认开启）。
    // 后端列表为空时自动不生效（无路可退）——现在只有 SYNC_UDP_DISABLE=1
    // 能让列表为空。
    SYNC_RESOLVE_DOH_FALLBACK: DEFAULTS.SYNC_RESOLVE_DOH_FALLBACK,

    // 握手后等待首个数据包的窗口（毫秒，固化）。
    SYNC_FIRST_BATCH_TIMEOUT: DEFAULTS.SYNC_FIRST_BATCH_TIMEOUT,

    // 拒绝后延迟关闭的时长：基数 + 随机抖动（毫秒，固化）。
    SYNC_CLOSE_DELAY_BASE_MS: DEFAULTS.SYNC_CLOSE_DELAY_BASE_MS,
    SYNC_CLOSE_DELAY_JITTER_MS: DEFAULTS.SYNC_CLOSE_DELAY_JITTER_MS,

    // 数据报（DNS 查询）通道的入站校验与频次调控（全部固化）。
    //
    // 这一层解决两个问题，都在响应放大攻击的范畴内：
    //   1. 报文格式未经校验即转发——畸形/超长查询会直接进入内网解析后端，
    //      相当于把本节点变成对内网解析服务的探针；
    //   2. 单条已认证连接内的查询次数没有上限——并发连接限制管的是
    //      "有多少条连接"，管不到"一条连接问了多少次"，
    //      于是解析后端可以被单连接放大。
    SYNC_UDP_PORT: DEFAULTS.SYNC_UDP_PORT,
    UDP_MAX_QUERY_SIZE: DEFAULTS.UDP_MAX_QUERY_SIZE,
    UDP_QUERY_LIMIT: DEFAULTS.UDP_QUERY_LIMIT,
    UDP_QUERY_BURST: DEFAULTS.UDP_QUERY_BURST,
    SYNC_DOH_MAX_INFLIGHT: DEFAULTS.SYNC_DOH_MAX_INFLIGHT,
    SYNC_DOH_TIMEOUT_MS: DEFAULTS.SYNC_DOH_TIMEOUT_MS,
    SYNC_DATAGRAM_BUFFER_MAX: DEFAULTS.SYNC_DATAGRAM_BUFFER_MAX,
    SYNC_DATAGRAM_COMPACT_MIN: DEFAULTS.SYNC_DATAGRAM_COMPACT_MIN,

    // 数据报通道的解析后端（http/https 形式）。
    //
    // 恒为非空：TELEMETRY_ENDPOINTS 缺失 / 为空 / 不合法时，
    // resolveTelemetryBackends 已回落到内置默认值。空数组只可能来自
    // DEFAULT_DOH_ENDPOINTS 被改坏，属代码级矛盾（下面有兜底告警）。
    TELEMETRY_BACKENDS: _telemetry.backends,
    // 被判定为不合法的原始配置值，仅用于启动日志（打印前会截断）。
    TELEMETRY_INVALID_ENDPOINTS: _telemetry.invalid,
    // 是否发生了回落（null / 'missing' / 'invalid'），供启动日志区分措辞。
    TELEMETRY_FALLBACK: _telemetry.fallback,
    // 唯一关闭开关。刻意不设第二个：曾经"TELEMETRY_ENDPOINTS 置空即关闭"
    // 就是第二个开关，它的触发方式与"没配"无法区分，已在真实故障中
    // 造成五轮无效排查。关闭必须是显式的、可一眼看出的动作。
    SYNC_UDP_FORCE_DISABLED: _udpForceDisabled,
    // 通道总开关：有后端（恒真）且未被显式关闭。
    // 写成与 SYNC_UDP_FORCE_DISABLED 同一个取反来源，避免"两处各自
    // 判断环境变量"将来被改得不一致。
    SYNC_UDP_ENABLED: _telemetry.backends.length > 0 && !_udpForceDisabled,

    // ── 参考等价模式（排查用总开关）─────────────────────────────
    //
    // 置 1 时，数据面（通道建立之后的行为）逐项等价于参考实现；HTTP 面
    // 一个字节都不动。
    //
    // 为什么需要它，见 lib/sync/compat.js 的模块头：排查走到第五轮时，
    // "逐个消除差异再重新部署"已经被证明不收敛——每轮都是"plausible
    // 但无法确认"，而每确认一次都要用户在生产上重来一遍。这个开关把
    // 剩余差异**一次性正交移除**，让结果只有"症状消失 / 症状依旧"两种，
    // 无论哪种都比再猜一次多出确定的信息量。
    //
    // 保留可配：它就是"这次排查要不要切到等价形态"这个临时决策本身，
    // 且当前仍在用于定位用户问题，因此不能固化成常量（固化等于每次
    // 切换都要改代码重新部署，那正是它要消灭的成本）。
    //
    // 只接受 '1'：排查开关必须能被精确关闭，'0' / 空串 / 残留值一律视为
    // 未开启（默认为关闭，即现有行为不变）。
    SYNC_COMPAT_MODE: process.env.SYNC_COMPAT_MODE === '1',

    // ── 出站目标准入 ──────────────────────────────────────────
    //
    // 转发目标由客户端首包指定，这是协议语义、无法取消。但"允许使用
    // 通道"不等于"允许访问服务端所在网络的任意地址"：不判定时，持令牌
    // 者可用本服务连 169.254.169.254 读实例元数据、连 10.0.0.0/8 扫内网，
    // 而目标侧看到的源 IP 是服务器自己。
    //
    // 默认开启，拒绝回环 / 链路本地 / 私有段 / 保留段（判定表见
    // lib/sync/target-guard.js）。置 '0' 关闭——把本服务当内网关使用
    // 时确实需要关，但那应当是显式选择而非默认行为。
    SYNC_TARGET_GUARD: process.env.SYNC_TARGET_GUARD !== '0',

    // 出站连接空闲超时（毫秒，固化）。
    SYNC_OUTBOUND_IDLE_TIMEOUT: DEFAULTS.SYNC_OUTBOUND_IDLE_TIMEOUT,

    // 目标侧背压挂起期间，单条连接允许积压的帧数上限（固化）。
    SYNC_PENDING_FRAME_LIMIT: DEFAULTS.SYNC_PENDING_FRAME_LIMIT,

    // 入站单帧/单消息长度上限（字节，固化）。
    SYNC_MAX_PAYLOAD: DEFAULTS.SYNC_MAX_PAYLOAD,

    // ── 内部诊断端点访问令牌 ──────────────────────────────────
    //
    // GET /_diag/channel 返回通道数、解析后端状态、进程运行时长。
    // 这些是传输层内部指标，出现在公开接口里是语义错位（一套库存
    // 系统不该有"通道"这个概念），因此该端点默认只对回环来源开放。
    //
    // 但在**前置反代**部署下，"回环"这个判据会失效：反代与本服务
    // 同机时，所有外部请求的 remoteAddress 都是 127.0.0.1，
    // 于是"仅本机"退化成"任何人"。这正是需要令牌的理由。
    //
    // 取值语义：
    //   未设置（空）→ 退化为回环判据（兼容既有运维脚本与本地验证）；
    //   已设置     → 必须携带匹配的 X-Diag-Token，且不再看来源地址。
    // 反代部署请**务必**显式设置本项，否则等于把内部指标挂到公网。
    DIAG_TOKEN: (process.env.DIAG_TOKEN || '').trim(),

    // 设备配置下发端点的准入令牌。
    //
    // 这个端点会吐出一整条节点链接（含令牌与端点路径），是全站唯一
    // 一处"一次请求即得完整凭证"的地方，因此它的准入必须独立、且
    // 强于"路径保密"。
    //
    // ── 为什么不能用 UUID 本身当 URL 的一部分 ──────────────────
    //
    // 端点路径曾经是 `/api/v1/auth/device/<UUID>`：靠"猜不到 UUID 就
    // 猜不到路径"来保护。问题在于 URL 是**明文**的——它会进入平台
    // 访问日志、任何中间代理日志、浏览器历史、以及 Referer。
    // 而正常情况下令牌只出现在 WS 首包里，处于 TLS 内部，不进任何日志。
    // 把它写进 URL，等于把本不该出加密通道的凭证搬到了明文通道上。
    //
    // 取值语义（与 DIAG_TOKEN 同构，便于理解）：
    //   已设置     → 必须携带匹配的 X-Device-Token，不再看来源地址；
    //   未设置     → 退化为回环判据（本地运维可用，云端托管形态不可用）。
    // 部署在托管平台时若需启用该端点，请显式设置本项。
    DEVICE_TOKEN: (process.env.DEVICE_TOKEN || '').trim(),

    // ===== 帧层流量形状（特征面，全部固化）=====
    //
    // 这一节只影响"帧长什么样"，不影响"帧里装什么"：
    // 帧键、分片粒度、控制帧节奏都是协议允许变动的自由度，
    // 对载荷语义零影响，因此调整它们对透传完全无损。
    WS_MASK_CSPRNG: DEFAULTS.WS_MASK_CSPRNG,
    WS_FORCE_SERVER_MASK: DEFAULTS.WS_FORCE_SERVER_MASK,
    WS_TLS_FINGERPRINT: DEFAULTS.WS_TLS_FINGERPRINT,
    WS_TLS_ALPN: DEFAULTS.WS_TLS_ALPN,

    // 是否要求本进程加载本机加速件（固化，默认不强制）。
    REQUIRE_NATIVE_ACCEL: DEFAULTS.REQUIRE_NATIVE_ACCEL,

    // ===== 存储与进程编排（由运行形态推导）=====
    // 业务数据落盘目录
    DATA_DIR: _dataDir,
    // 数据落盘驱动：fs（默认）/ memory（Serverless 形态自动切换）
    STORAGE_DRIVER: _storageDriver,
    // 进程编排模式（Serverless 形态自动切换为单进程）
    SINGLE_PROCESS: _singleProcess,

    // ===== 业务节奏（全部固化）=====
    SNAPSHOT_TTL: DEFAULTS.SNAPSHOT_TTL,
    CACHE_INTERVAL: DEFAULTS.CACHE_INTERVAL,
    REPORT_INTERVAL: DEFAULTS.REPORT_INTERVAL,
    LOW_STOCK_THRESHOLD: DEFAULTS.LOW_STOCK_THRESHOLD,
    GC_INTERVAL: DEFAULTS.GC_INTERVAL,
    REPORT_RETENTION_DAYS: DEFAULTS.REPORT_RETENTION_DAYS
};

// ====================================================================
// 参考等价模式下的两个派生取值
//
// 这两项不是"配置项的另一个默认值"，而是等价模式这个**实验**的一部分：
// 参考实现在这两处用的是传输层的出厂值（100MB 的单消息上限、没有首包
// 超时），要让实验具有判别力就必须连它们一起对齐。
//
// 放在这里而不是 compat.js，是因为它们必须在 validateConfig 里被写进
// CONFIG（那里是所有交叉校验与收敛的唯一出口），而 compat.js 只负责
// 描述与宣告——两边若各写一份字面量，就会退回"双真相源"的老问题。
// compat.js 从 CONFIG 读回最终生效值，因此不存在第二份。
// ====================================================================

// 参考实现不设置 maxPayload，用的是传输层默认量级（100MB）。
const COMPAT_MAX_PAYLOAD = 100 * 1024 * 1024;

// 首包超时在等价模式下放宽到 300s，而不是关闭。
//
// 为什么是放宽而不是关闭：这条机制的作用是回收"握手成功但永远不发首
// 包的连接"——那类连接会长期占着并发名额。整个关掉它，等于把"资源
// 回收"和"关闭会不会误伤客户端"两件事一起改掉，实验就多出一个变量。
// 放宽到 300s 只改后者：真实客户端的握手→首包延迟在毫秒级，300s 在
// 任何现实网络下都不可能被正常连接触发，因此它不可能成为"浏览器打不
// 开"的原因；同时连接表仍有一条最终出口，不会因为实验而泄漏。
const COMPAT_FIRST_BATCH_TIMEOUT = 300000;

// ====================================================================
// 配置项一致性校验
//
// 逐项校验（上面的 num / UUID 格式）只能保证"每个值本身合法"，
// 保证不了"值之间的关系合理"。而关系不合理时服务照样启动，
// 只是某个机制悄无声息地失效——例如出站水位高于背压阈值时，
// 背压永远不会触发，内存无界增长却看不到任何报错。
// 这类静默降级比启动失败难排查得多，因此在启动期一次性拦下。
//
// 固化之后，下面多数判据**不会**再因为部署者填了什么而触发——它们
// 现在守的是另一件事：有人改动 lib/defaults.js 里的常量时，把被破坏
// 的关系在启动期拦下来。理由不变：静默降级比启动失败难排查。
//
// 分两级：
//   fail  —— 约束被违反会导致机制失效或资源冲突，直接拒绝启动；
//   warn  —— 取值不理想但不致命，自动收敛到安全值并说明原因。
// ====================================================================

function validateConfig(cfg) {
    const fail = [];
    const warn = [];

    // —— 存储驱动 ——
    // 取值现在由运行形态推导（fs / memory），因此这里的判据实际守的是
    // "defaults.js 被改出了一个未知取值"：拼错驱动名会让 store 层静默
    // 走 fs 分支，表现为"以为用了内存驱动，实际在只读盘上报 EROFS"。
    if (cfg.STORAGE_DRIVER !== 'fs' && cfg.STORAGE_DRIVER !== 'memory') {
        fail.push('STORAGE_DRIVER 取值非法：' + cfg.STORAGE_DRIVER
            + '（可选：fs | memory）。该项由运行形态推导，'
            + '出现此错误说明 lib/defaults.js 的取值被改动。');
    }
    // 内存驱动下 DATA_DIR 不参与任何 IO，提前告知以免误以为数据已持久化。
    // 同时它必须与单进程模式配合：memory 的存储表是**进程内**的，
    // 而 fork 出的 worker 各有独立内存空间——cache 进程写入的快照，
    // report 进程根本读不到（表现为报表永远"缓存未就绪"）。
    // 这是一个静默失效的坑，必须在启动期拦下而不是留待运行期排查。
    if (cfg.STORAGE_DRIVER === 'memory') {
        warn.push('存储驱动为 memory（由 Serverless 形态推导）：业务数据仅存于'
            + '进程内存，重启后丢失，DATA_DIR 不再被使用。');
        if (!cfg.SINGLE_PROCESS) {
            fail.push('memory 驱动必须与单进程模式同时使用：'
                + '内存存储表是进程内的，fork 出的各 worker 无法共享，'
                + '业务数据将互不可见（报表会一直显示"缓存未就绪"）。');
        }
    }

    // —— 背压与流缓冲 ——
    // 背压高水位取自上面的 CONFIG.BACKPRESSURE_HIGH_WATER（单点定义），
    // 数据面 lib/sync/relay.js 用的是同一个值。
    // 出站水位若高于它，"缓冲量达到高水位"这个条件永远不会成立，
    // 暂停/恢复上游的逻辑形同虚设。
    if (cfg.SYNC_STREAM_HWM > 0 && cfg.SYNC_STREAM_HWM > cfg.BACKPRESSURE_HIGH_WATER) {
        warn.push('SYNC_STREAM_HWM=' + cfg.SYNC_STREAM_HWM
            + ' 高于背压高水位 ' + cfg.BACKPRESSURE_HIGH_WATER
            + '，出站背压将永不触发；已自动收敛到 ' + (cfg.BACKPRESSURE_HIGH_WATER >> 2));
        cfg.SYNC_STREAM_HWM = cfg.BACKPRESSURE_HIGH_WATER >> 2;
    }

    // —— HTTP 令牌桶 ——
    if (cfg.HTTP_PACE_ENABLED) {
        if (cfg.HTTP_PACE_BURST < 1) {
            fail.push('HTTP_PACE_BURST 必须 ≥ 1（当前 ' + cfg.HTTP_PACE_BURST
                + '）：桶容量为 0 会让所有请求被直接拒绝，包括健康探针。'
                + '该值已固化在 lib/defaults.js，请改回有效取值。');
        }
        if (cfg.HTTP_PACE_LIMIT < 1) {
            fail.push('HTTP_PACE_LIMIT 必须 ≥ 1（当前 ' + cfg.HTTP_PACE_LIMIT
                + '）：回填速率为 0 时突发额度耗尽后将永久拒绝。'
                + '限流不再支持整体关闭，请改回有效取值（lib/defaults.js）。');
        }
    }

    // —— 数据报查询令牌桶 ——
    if (cfg.UDP_QUERY_LIMIT > 0 && cfg.UDP_QUERY_BURST < 1) {
        fail.push('UDP_QUERY_BURST 必须 ≥ 1（当前 ' + cfg.UDP_QUERY_BURST
            + '）：桶容量为 0 会拒绝全部 DNS 查询。'
            + '该值已固化在 lib/defaults.js，请改回有效取值。');
    }
    if (cfg.UDP_MAX_QUERY_SIZE < 12) {
        fail.push('UDP_MAX_QUERY_SIZE 必须 ≥ 12（当前 ' + cfg.UDP_MAX_QUERY_SIZE
            + '）：DNS 报文头本身就有 12 字节，过小的上限会拒绝所有合法查询。');
    }

    // —— 非法批次退避 ——
    // 冷却时长若不超过统计窗口，退避会在窗口结束前失效，语义倒置
    if (cfg.INVALID_COOLDOWN <= cfg.INVALID_BATCH_WINDOW) {
        warn.push('INVALID_COOLDOWN(' + cfg.INVALID_COOLDOWN
            + ') 未大于 INVALID_BATCH_WINDOW(' + cfg.INVALID_BATCH_WINDOW
            + ')：冷却可能在统计窗口结束前失效，已自动调整为窗口的 2 倍');
        cfg.INVALID_COOLDOWN = cfg.INVALID_BATCH_WINDOW * 2;
    }

    // —— 端口冲突 ——
    if (cfg.EVENT_BUS_PORT > 0 && cfg.EVENT_BUS_PORT === cfg.PORT) {
        fail.push('EVENT_BUS_PORT 与 PORT 相同（' + cfg.PORT
            + '）：内部总线与对外服务会争抢同一端口，总线将启动失败。');
    }

    // —— 首包超时 ——
    // 窗口过小会误杀正常客户端（握手后到首包之间的网络往返 + 客户端处理）
    if (cfg.SYNC_FIRST_BATCH_TIMEOUT > 0 && cfg.SYNC_FIRST_BATCH_TIMEOUT < 1000) {
        warn.push('SYNC_FIRST_BATCH_TIMEOUT=' + cfg.SYNC_FIRST_BATCH_TIMEOUT
            + 'ms 过小，可能误杀正常客户端；已提升到 5000ms');
        cfg.SYNC_FIRST_BATCH_TIMEOUT = 5000;
    }

    // —— 快照缓存 TTL ——
    // TTL 大于产出周期时缓存永远等不到新数据，等于持续返回陈旧内容
    if (cfg.SNAPSHOT_TTL > 0) {
        const minProducer = Math.min(cfg.CACHE_INTERVAL, cfg.REPORT_INTERVAL);
        if (cfg.SNAPSHOT_TTL > minProducer) {
            warn.push('SNAPSHOT_TTL=' + cfg.SNAPSHOT_TTL
                + 'ms 大于数据产出周期 ' + minProducer
                + 'ms，缓存可能长期返回陈旧数据；已收敛到该周期的一半');
            cfg.SNAPSHOT_TTL = Math.max(1000, Math.floor(minProducer / 2));
        }
    }

    // —— 同步通道并发关系 ——
    //
    // 单 IP 上限与全局上限的关系，有两类都"看起来配了、实际没保护"的组合：
    //
    //   1) 单 IP 上限 ≥ 全局上限：一个来源即可占满全部额度，等于是关的。
    //      这是曾经默认值（0=关闭）之外的第二条隐蔽失效路径——运维以为
    //      自己配了限额，实际没有任何隔离。降级到全局的 1/2（与默认值
    //      同一条派生关系，见上）并告警。
    //
    //      收敛比例必须跟着默认值一起走：默认从 /4 抬到 /2 之后，这里若
    //      仍按 /4 收敛，就出现"默认值 100、配错时被收敛到 50"的自相
    //      矛盾——同一个语义在两处算出两个数，正是历史上漂移的成因。
    //
    //   2) 单 IP 上限为 0 但同时设了全局上限：完全关闭按来源隔离。
    //      派生关系下这一支已不可达（Math.max(1, …) 保证 ≥ 1），
    //      保留判据是为了 defaults.js 被改动时仍能拦住。
    if (cfg.MAX_TOTAL_CONNECTIONS > 0) {
        if (cfg.MAX_CONNECTIONS_PER_IP >= cfg.MAX_TOTAL_CONNECTIONS) {
            const relaxed = Math.max(1, Math.floor(cfg.MAX_TOTAL_CONNECTIONS / DEFAULTS.MAX_CONNECTIONS_PER_IP_DIVISOR));
            warn.push('MAX_CONNECTIONS_PER_IP(' + cfg.MAX_CONNECTIONS_PER_IP
                + ') 不低于 MAX_TOTAL_CONNECTIONS(' + cfg.MAX_TOTAL_CONNECTIONS
                + ')：单个来源即可独占全部连接额度，已收敛到 ' + relaxed);
            cfg.MAX_CONNECTIONS_PER_IP = relaxed;
        } else if (cfg.MAX_CONNECTIONS_PER_IP === 0) {
            warn.push('MAX_CONNECTIONS_PER_IP=0：未启用按来源隔离，'
                + '任意单个来源可独占全部 ' + cfg.MAX_TOTAL_CONNECTIONS
                + ' 条连接额度，真实客户端可能被挤掉。');
        }
    }

    // —— 帧长度上限 ——
    if (cfg.SYNC_MAX_PAYLOAD > 0 && cfg.SYNC_MAX_PAYLOAD < 1024) {
        fail.push('SYNC_MAX_PAYLOAD 必须 ≥ 1024（当前 ' + cfg.SYNC_MAX_PAYLOAD
            + '）：上限过小会拒绝正常数据帧。');
    }

    // —— 参考等价模式：一次性正交移除数据面差异 ——
    //
    // 放在所有交叉校验**之后**：上面若干条会把取值收敛到合法范围，
    // 这里覆盖的是最终结果，因此不会与任何一条约束打架；反过来若放在
    // 前面，被覆盖的值可能随后又被某条校验改掉，实际生效的就不再是
    // 等价形态——那会让实验失去意义，且日志仍宣告"已切换"。
    //
    // 只有这两项是"取值"而非"分支"，因此必须在这里改；其余八项都是
    // 代码路径上的显式分支，住在 lib/sync/relay.js 与 limits.js 里。
    if (cfg.SYNC_COMPAT_MODE) {
        cfg.SYNC_MAX_PAYLOAD = COMPAT_MAX_PAYLOAD;
        cfg.SYNC_FIRST_BATCH_TIMEOUT = COMPAT_FIRST_BATCH_TIMEOUT;
    }

    // —— 服务端强制帧键标识 ——
    // RFC 6455 §5.1 规定服务端到客户端方向不得带该标识。主流客户端在
    // 解码时会以 WS_ERR_UNEXPECTED_MASK 直接断开。这是"能连上"与
    // "连不上"的差别，不是性能取舍，因此单独提示，
    // 避免被当成一个中性的开关随手打开。
    if (cfg.WS_FORCE_SERVER_MASK) {
        warn.push('WS_FORCE_SERVER_MASK 已开启：服务端将发送带帧键标识的数据帧，'
            + '违反 RFC 6455 §5.1，标准客户端会以 WS_ERR_UNEXPECTED_MASK 断开连接。'
            + '该项已固化在 lib/defaults.js，仅当服务端/客户端同源且双方都明确'
            + '支持时才应保持为 true。');
    }

    // —— TCP 保活 ——
    // 起探间隔过小会让保活包本身成为一条可观测的固定节拍，
    // 反而削减弱化效果；过大则赶不上 NAT 表项超时。
    if (cfg.TCP_KEEPALIVE_DELAY > 0 && cfg.TCP_KEEPALIVE_DELAY < 10000) {
        warn.push('TCP_KEEPALIVE_DELAY=' + cfg.TCP_KEEPALIVE_DELAY
            + 'ms 过小，保活探测会形成可观测的固定节拍；已提升到 30000ms');
        cfg.TCP_KEEPALIVE_DELAY = 30000;
    }

    // —— 数据报通道 ——
    //
    // 【这里的告警只负责"说明已经替用户回落了"，不再负责"请用户改配置"】
    // 上一版在这里打的是「[严重] 数据报通道已关闭，请删除 TELEMETRY_ENDPOINTS
    // 这一行」。那条告警在真实故障里没有起到任何作用：部署平台给所有日志
    // 行统一加了 [info] 前缀，warn 与 info 在面板上无法区分，[严重] 二字
    // 淹没在启动日志里——用户没看到，同一个配置问题又空跑了两轮。
    // 结论是告警不能作为核心功能的可用性前提，所以语义已改为回落：
    // 下面三条都只描述"实际发生了什么"，不再要求用户做任何事。
    if (_telemetry.fallback === 'missing') {
        warn.push('TELEMETRY_ENDPOINTS 未提供（或为空/纯空白）：已回落到内置的 '
            + _telemetry.backends.length + ' 个解析后端，数据报通道保持可用。'
            + '若要关闭通道，唯一方式是显式设置 SYNC_UDP_DISABLE=1。');
    } else if (_telemetry.fallback === 'invalid') {
        warn.push('TELEMETRY_ENDPOINTS 配置值不合法（需为 http(s):// 形式的 URL）：'
            + '已回落到内置的 ' + _telemetry.backends.length + ' 个解析后端，数据报通道保持可用。'
            + '不合法的值：' + truncateEndpointsForLog(_telemetry.invalid)
            + '；若要关闭通道，请使用 SYNC_UDP_DISABLE=1。');
    } else if (_telemetry.invalid.length > 0) {
        // 混合情形：至少有一条合法，用合法的那几条，非法条目仅跳过、不回落。
        warn.push('已忽略 ' + _telemetry.invalid.length + ' 个非法的遥测后端地址'
            + '（需为 http/https 形式）：' + truncateEndpointsForLog(_telemetry.invalid)
            + '；其余合法后端照常生效。');
    }
    if (cfg.SYNC_UDP_FORCE_DISABLED && _telemetry.backends.length > 0) {
        warn.push('SYNC_UDP_DISABLE=1：数据报通道已被强制关闭，'
            + '配置的 ' + _telemetry.backends.length + ' 个解析后端不会生效');
    }
    // 兜底：内置默认值本身被解析成空数组属代码级矛盾（DEFAULT_DOH_ENDPOINTS
    // 是硬编码常量）。正常不可能触发；保留它是为了让"通道真的没后端"
    // 这种情况永远不会静默——宁可多一行没人看的日志，也不要再有一次
    // 干净得看不出问题的启动。
    if (!cfg.SYNC_UDP_FORCE_DISABLED && _telemetry.backends.length === 0) {
        warn.push('[严重] 数据报通道无可用解析后端（内置默认值解析为空，属代码级矛盾）：'
            + '浏览器的域名解析会全部失败，表现为"能连上节点、能发消息，但打不开网页"。'
            + '请检查 DEFAULT_DOH_ENDPOINTS 是否被改动。');
    }

    // —— 原生加速模块 ——
    // 加载状态在此集中探测一次：本机加速件一旦缺失，中间层的按位运算
    // 会静默回退到便携实现，吞吐差异在压测外很难被察觉。把探测结果作为
    // 配置项暴露出去，让启动日志与实际行为有据可查。
    cfg.NATIVE_ACCEL = detectNativeAccel();

    if (cfg.REQUIRE_NATIVE_ACCEL && !cfg.NATIVE_ACCEL) {
        fail.push('REQUIRE_NATIVE_ACCEL 为 true 但本机加速件未能加载：'
            + '请确认 vendor/native-accel/ 完整且平台有对应预编译产物，'
            + '或把 lib/defaults.js 的该项改回 false 以接受便携实现回退。');
    }

    // —— 并发上限按实例数折算 ——
    //
    // 放在校验段末尾：折算依赖所有前置校验都已把取值收敛到合法范围，
    // 否则会对一个非法值做除法再拿去当上限用。
    //
    // 为什么是"折算"而不是"共享计数"：共享需要外部存储，那与零运行时
    // 依赖冲突，还会给每条连接的关键路径加一次网络往返。折算的代价是
    // 精度（各实例不知道彼此的实时占用），但保证**总量**有上界——
    // 真正的风险从来不是"某实例早一点触顶"，而是"总量根本没有上界"。
    const instances = Math.max(1, Math.floor(cfg.DEPLOY_INSTANCES || 1));
    if (instances > 1) {
        const scaled = Math.max(1, Math.ceil(cfg.MAX_TOTAL_CONNECTIONS / instances));
        const scaledPending = Math.max(1, Math.ceil(cfg.MAX_PENDING_TOTAL / instances));
        // per-IP 档同样要折算，否则派生关系会在折算后失效：
        // 全局 200 → 50、而 per-IP 仍是 100，于是"单个来源最多拿一半"
        // 变成"单个来源可以拿走全部 50"——正是上面那条交叉校验要防的
        // 形态，只不过它是被折算顺序悄悄制造出来的。折算后比例不变
        // （100/4 = 25，25 仍是 50 的一半）。
        const scaledPerIp = Math.max(1, Math.ceil(cfg.MAX_CONNECTIONS_PER_IP / instances));
        warn.push('DEPLOY_INSTANCES=' + instances + '：并发计数为进程内单例，'
            + '按实例数折算上限 MAX_TOTAL_CONNECTIONS '
            + cfg.MAX_TOTAL_CONNECTIONS + ' → ' + scaled
            + '，MAX_PENDING_TOTAL ' + cfg.MAX_PENDING_TOTAL + ' → ' + scaledPending
            + '，MAX_CONNECTIONS_PER_IP ' + cfg.MAX_CONNECTIONS_PER_IP + ' → ' + scaledPerIp
            + '（跨实例共享计数需外部存储，当前不提供）');
        cfg.MAX_TOTAL_CONNECTIONS = scaled;
        cfg.MAX_PENDING_TOTAL = scaledPending;
        cfg.MAX_CONNECTIONS_PER_IP = scaledPerIp;

        // 折算后重新断言一次 per-IP < total。
        //
        // 上面那条交叉校验跑在折算**之前**（它要比对的是运维填写的
        // 原始取值），因此挡不住"运维显式配了一个很大的 per-IP、又被
        // 折算压小了 total"这一组合——那会让 per-IP 档在折算后悄悄
        // 失效。这里补一刀，让这条不变量在**最终生效值**上成立。
        if (cfg.MAX_TOTAL_CONNECTIONS > 0
            && cfg.MAX_CONNECTIONS_PER_IP >= cfg.MAX_TOTAL_CONNECTIONS) {
            const relaxed = Math.max(1, Math.floor(cfg.MAX_TOTAL_CONNECTIONS / DEFAULTS.MAX_CONNECTIONS_PER_IP_DIVISOR));
            warn.push('折算后 MAX_CONNECTIONS_PER_IP(' + cfg.MAX_CONNECTIONS_PER_IP
                + ') 不低于 MAX_TOTAL_CONNECTIONS(' + cfg.MAX_TOTAL_CONNECTIONS
                + ')：单个来源即可独占本实例全部连接额度，已收敛到 ' + relaxed);
            cfg.MAX_CONNECTIONS_PER_IP = relaxed;
        }
        // MAX_PENDING_PER_IP 刻意**不折算**：per-IP 档描述的是"单个来源
        // 在一个 RTT 内会开多少条"，这是客户端行为，与部署了几个实例
        // 无关，除以实例数只会让多实例部署下的浏览器首屏重新撞墙。
        // 它不参与总量上界——那一层由折算后的 MAX_PENDING_TOTAL 与
        // MAX_TOTAL_CONNECTIONS 承担，两者取小者先生效。
    }

    if (fail.length > 0) {
        console.error('[FATAL] 配置项之间存在冲突，服务已拒绝启动：');
        for (const m of fail) console.error('        · ' + m);
        process.exit(1);
    }

    // fork 模式下每个子进程都会重新 require 本模块并再次走到这里，
    // 同一条 warn 会被打印 5 次（主进程 + 4 个子进程）。配置是全局一致的，
    // 子进程重复播报只会淹没真正有用的日志，因此只在主进程输出。
    // 判定方式：fork 子进程启动时会带上 NODE_UNIQUE_ID 之外的自定义标记，
    // 但更稳妥的判据是"父进程是否提供了 fork 的 IPC 通道"——子进程
    // 由 fork 创建，process.send 存在；直接 node 启动的进程则没有。
    if (!isForkedChildProcess(cfg)) {
        for (const m of warn) console.warn('[CONFIG] ' + m);
    }

    return cfg;
}

// fork 子进程判据。抽成函数是因为启动摘要与上面的 warn 播报共用同一
// 个判据——两处各写一份，将来改了一处就会出现"摘要打两遍"或"摘要
// 一次都不打"。
function isForkedChildProcess(cfg) {
    return typeof process.send === 'function' && cfg.SINGLE_PROCESS !== true;
}

// ====================================================================
// 启动摘要：把保留下来的 13 项的生效值打成一行
//
// 为什么必须有这一行：配置面从 71 项压到 13 项之后，"这次部署到底是
// 什么形状"这句话只剩这 13 项能回答了。若它们也不出现在日志里，排障
// 时就只能靠"我记得面板上填了什么"——而面板恰恰是最容易填错、又最
// 难核对的地方。精简配置面不等于让配置不可见。
//
// 令牌一律只报"已设置 / 未设置"，不报取值：容器 stdout 常被平台采集，
// 把令牌复制一份到日志系统没有任何排查价值，泄漏却有实际代价。
// ====================================================================

function describeEffectiveConfig(cfg) {
    const set = (v) => (v ? '已设置' : '未设置');
    return '[CONFIG] 生效配置'
        + ' | UUID=' + set(cfg.ENTERPRISE_TOKEN)
        + ' | SYNC_PATHS=' + cfg.SYNC_ENDPOINTS.length + '条(' + cfg.SYNC_ENDPOINT + ')'
        + ' | DIAG_TOKEN=' + set(cfg.DIAG_TOKEN)
        + ' | DEVICE_TOKEN=' + set(cfg.DEVICE_TOKEN)
        + ' | LOG_LEVEL=' + require('./logger').level
        + ' | TELEMETRY_ENDPOINTS=' + (cfg.TELEMETRY_FALLBACK
            ? '内置(' + cfg.TELEMETRY_BACKENDS.length + ')'
            : '用户配置(' + cfg.TELEMETRY_BACKENDS.length + ')')
        + ' | SYNC_UDP_DISABLE=' + (cfg.SYNC_UDP_FORCE_DISABLED ? '1' : '0')
        + ' | SYNC_TARGET_GUARD=' + (cfg.SYNC_TARGET_GUARD ? '1' : '0')
        + ' | LOGIN_REQUIRED=' + (cfg.LOGIN_REQUIRED ? '1' : '0')
        + ' | MAX_TOTAL_CONNECTIONS=' + cfg.MAX_TOTAL_CONNECTIONS
        + ' | MAX_PENDING_PER_IP=' + cfg.MAX_PENDING_PER_IP
        + ' | DEPLOY_INSTANCES=' + cfg.DEPLOY_INSTANCES
        + ' | SYNC_COMPAT_MODE=' + (cfg.SYNC_COMPAT_MODE ? '1' : '0');
}

validateConfig(CONFIG);

// 摘要必须在校验**之后**打印：上面若干条会把取值收敛（折算、跨校验），
// 先打就会报出一份没生效的数，正好是"日志与实际不符"这种最难排查的
// 形态。与 warn 同一判据，只在主进程输出一次。
if (!isForkedChildProcess(CONFIG)) {
    console.log(describeEffectiveConfig(CONFIG));
}

module.exports = CONFIG;
