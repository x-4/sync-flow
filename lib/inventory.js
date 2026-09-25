// ====================================================================
// 库存同步业务数据引擎
// 仅用于 HTTP 业务表面，与增量同步传输层完全无关
//
// --------------------------------------------------------------------
// 数据模型说明（重要）
//
// 这里模拟的是「三个物理仓 + 一张 SKU 主数据表」的仓储系统，而不是
// 每次调用现编几个数字。两者在接口形态上看起来一样，但在**统计特征**
// 上差别极大，后者会被轻易识别：
//
//   1) reserved（占用）不是 available 的固定比例。
//      真实占用来自未发货的销售订单，与可售量相互独立，
//      因此占用率在不同 SKU / 不同仓库之间天然分散。
//
//   2) 仓库的 used（已用库容）由该仓库存聚合折算得出，不是写死的常量。
//      库存变动 → 占用率跟着变，两个接口的数据自洽。
//
//   3) 基线库存持久化到磁盘，服务重启后延续上次的水平，
//      而不是"每次重启换一批新数字"。
//
//   4) 变动是带均值回归的随机游走：出库/补货成对发生、有上下界，
//      既不无限漂移，也不永远停在初始值附近。
// ====================================================================

const store = require('./store');
const logger = require('./logger');

// --------------------------------------------------------------------
// SKU 主数据
//
// 每个 SKU 自带物流参数：单位体积（决定库容占用）、日均出库量、
// 补货点与目标水位。这些参数既是"这个 SKU 为什么是现在这个数量"的
// 解释，也让不同 SKU 表现出不同的波动幅度。
// --------------------------------------------------------------------
const SKU_CATALOG = [
    {
        sku: 'SKU-APL-1001', name: 'Industrial Bearing Unit', warehouse: 'WH-SH-01',
        unitVolume: 0.012, dailyOut: 18, reorderPoint: 40, targetLevel: 260
    },
    {
        sku: 'SKU-APL-1002', name: 'Hydraulic Valve Kit', warehouse: 'WH-SH-01',
        unitVolume: 0.035, dailyOut: 26, reorderPoint: 90, targetLevel: 420
    },
    {
        sku: 'SKU-ELE-2043', name: 'Control Board v3', warehouse: 'WH-GZ-02',
        unitVolume: 0.004, dailyOut: 44, reorderPoint: 120, targetLevel: 560
    },
    {
        sku: 'SKU-ELE-2051', name: 'Servo Motor 750W', warehouse: 'WH-GZ-02',
        unitVolume: 0.081, dailyOut: 12, reorderPoint: 60, targetLevel: 300
    },
    {
        sku: 'SKU-RAW-3310', name: 'Alloy Sheet 1.2mm', warehouse: 'WH-BJ-03',
        unitVolume: 0.210, dailyOut: 31, reorderPoint: 150, targetLevel: 720
    },
    {
        sku: 'SKU-RAW-3318', name: 'Copper Coil 5kg', warehouse: 'WH-BJ-03',
        unitVolume: 0.145, dailyOut: 22, reorderPoint: 95, targetLevel: 480
    }
];

// 库容单位：立方米。三个仓按各自存的货类给出仓容——
// 上海/广州存的是精密件与电控件（轻小、单价高），
// 北京存的是金属原料（重、体积大），因此仓容也更大。
const WAREHOUSE_META = {
    'WH-SH-01': { name: '上海中心仓', city: '上海', region: 'East China', capacity: 32 },
    'WH-GZ-02': { name: '广州分拨仓', city: '广州', region: 'South China', capacity: 38 },
    'WH-BJ-03': { name: '北京北方仓', city: '北京', region: 'North China', capacity: 260 }
};

const randInt = (min, max) => (max <= min ? min : min + Math.floor(Math.random() * (max - min + 1)));
// 在 [value*(1-pct), value*(1+pct)] 内取值，让日均量本身也有日间波动
const jitter = (value, pct) => value * (1 + (Math.random() * 2 - 1) * pct);

// --------------------------------------------------------------------
// 单个 SKU 的库存状态机
//
// 状态三项：available（可售）、reserved（占用/待发货）、inbound（在途补货）。
//
// 每轮演进：
//   1. 按日均出库量扣减 available（约 8% 的日子按促销日放大）；
//   2. 出库拆成「立即发货」与「转为占用」两部分——只有后者进 reserved；
//   3. reserved 按发货节拍陆续释放（货离开系统，不回补 available）；
//   4. available 跌破补货点时下采购单，进入 inbound；
//   5. inbound 分批到货，补回 available。
//
// 关键点：reserved 与 available 是**两个独立演进的量**，
// 比值天然发散，不会退化成一个固定系数。
// --------------------------------------------------------------------
function stepItem(state, meta) {
    const busy = Math.random() < 0.08 ? 2.2 : 1.0;

    // 1. 出库（不会把库存卖到补货点以下——那部分由补货机制覆盖）
    const outQty = Math.min(
        Math.max(0, Math.round(jitter(meta.dailyOut, 0.45) * busy)),
        Math.max(0, state.available - meta.reorderPoint)
    );

    // 2. 出库拆分：50%~75% 转为待发货占用，其余即时发货
    const toReserve = Math.round(outQty * (0.5 + Math.random() * 0.25));
    state.available -= outQty;
    state.reserved += toReserve;

    // 3. 占用释放（待发货订单完成出库）
    const shipped = Math.min(
        state.reserved,
        Math.max(0, Math.round(jitter(meta.dailyOut * 0.55, 0.6) * busy))
    );
    state.reserved -= shipped;

    // 4. 补货下单
    if (state.available <= meta.reorderPoint && state.inbound === 0) {
        const gap = Math.max(1, meta.targetLevel - state.available);
        state.inbound = Math.max(1, Math.round(jitter(gap, 0.3)));
    }

    // 5. 在途分批到货
    if (state.inbound > 0 && Math.random() < 0.45) {
        const arrive = Math.min(
            state.inbound,
            Math.max(1, Math.round(state.inbound * (0.3 + Math.random() * 0.45)))
        );
        state.inbound -= arrive;
        state.available += arrive;
    }

    // 6. 边界约束：可售不为负，且不超过目标水位的合理上界
    state.available = Math.max(0, Math.min(state.available, Math.round(meta.targetLevel * 1.6)));
    state.reserved = Math.max(0, state.reserved);
    state.inbound = Math.max(0, state.inbound);

    return state;
}

// --------------------------------------------------------------------
// 状态持久化
//
// 不持久化的话服务每次重启都会得到一批全新随机库存——在"同一套数据
// 被反复观测"的场景里这是显眼的不一致。状态文件与库存快照分开存放，
// 避免与缓存进程的产出相互覆盖。
// --------------------------------------------------------------------
const STATE_FILE = 'state/inventory-state.json';

function buildInitialStates() {
    return SKU_CATALOG.map((meta) => ({
        sku: meta.sku,
        // 初值按目标水位的一定比例给；占用取若干天在途出库量，
        // 因此初始状态下各 SKU 的占用率就已经是分散的
        available: Math.round(meta.targetLevel * (0.45 + Math.random() * 0.35)),
        reserved: Math.round(jitter(meta.dailyOut * randInt(3, 9), 0.35)),
        inbound: 0
    }));
}

let _states = null;
let _savedAt = 0;

function loadStates() {
    if (_states) return _states;

    const persisted = store.readJsonFile(STATE_FILE);
    _savedAt = (persisted && Number.isFinite(persisted.savedAt)) ? persisted.savedAt : Date.now();

    if (persisted && Array.isArray(persisted.items)) {
        // 与当前 SKU 主数据逐个对齐：主数据增删后，旧状态文件不应把
        // 服务带进"字段错位"的状态；对不上的那一项重新初始化。
        const fresh = buildInitialStates();
        _states = SKU_CATALOG.map((meta, i) => {
            const saved = persisted.items.find((s) => s && s.sku === meta.sku);
            if (!saved || !Number.isFinite(saved.available) || !Number.isFinite(saved.reserved)) {
                return fresh[i];
            }
            return {
                sku: meta.sku,
                available: Math.max(0, Math.round(saved.available)),
                reserved: Math.max(0, Math.round(saved.reserved)),
                inbound: Math.max(0, Math.round(saved.inbound || 0))
            };
        });
    } else {
        _states = buildInitialStates();
    }
    return _states;
}

function persistStates() {
    if (!_states) return;
    _savedAt = Date.now();
    try {
        store.writeJsonFile(STATE_FILE, { savedAt: _savedAt, items: _states });
    } catch (err) {
        // 落盘失败不影响对外服务：库存仍在内存中推进，
        // 只是下次重启会回到上一次成功落盘的水平。
        // 但要留痕——磁盘满 / 权限错会**持续**发生，每次都静默
        // 就意味着"重启后基线莫名回退"这类问题永远查不到根因。
        logger.warn('库存基线落盘失败，本次变更仅在内存中生效', {
            file: require('path').basename(STATE_FILE),
            code: err && err.code
        });
    }
}

// 库存状态最后一次变更的时间戳。仓库汇总接口用它作为 updatedAt，
// 使"数据未变则响应字节不变"，ETag / 304 协商才有意义。
function loadSavedAt() {
    loadStates();
    return _savedAt || Date.now();
}

// --------------------------------------------------------------------
// 对外接口
// --------------------------------------------------------------------

/**
 * 推进一轮库存演化并返回当前库存明细。
 * 缓存进程按 CACHE_INTERVAL 调用（advance=true）；网关的实时兜底路径
 * 在无快照可用时调用（advance=false，只读现值），避免兜底路径额外
 * 放大波动。
 *
 * @param {{ advance?: boolean }} [opts]
 * @returns {Array<object>}
 */
function genStock(opts) {
    const advance = !opts || opts.advance !== false;
    const states = loadStates();

    if (advance) {
        for (let i = 0; i < states.length; i++) stepItem(states[i], SKU_CATALOG[i]);
        persistStates();
    }

    const updatedAt = new Date().toISOString();
    return states.map((s, i) => ({
        sku: SKU_CATALOG[i].sku,
        name: SKU_CATALOG[i].name,
        warehouse: SKU_CATALOG[i].warehouse,
        available: s.available,
        reserved: s.reserved,
        inbound: s.inbound,
        updatedAt
    }));
}

/**
 * 仓库汇总。
 *
 * used 由该仓库存按体积折算得出——不同 SKU 单位体积差 50 倍，
 * 只数件数会让库容占用率失去意义。因此「库存明细」与「仓库占用」
 * 两个接口的数据必然自洽；两套数字若各自硬编码就做不到这一点。
 *
 * 在途量单列 inboundQty，不计入库容占用（货还在路上）。
 *
 * —— 关于 updatedAt 与 ETag ——
 *
 * 这个接口的内容在库存未变动时是**完全确定**的，因此响应的字节
 * 必须稳定，否则 ETag 每次都变、304 协商失效（缓存层形同虚设，
 * 而且"声明可缓存却永不命中"本身就是个矛盾特征）。
 *
 * 所以这里的 updatedAt 取自**库存状态最后一次变更的时间**
 * （savedAt），不是 new Date()。available/reserved 不变 → savedAt
 * 不变 → 序列化字节不变 → ETag 不变 → 二次请求得 304。
 * 这与 /stock 的处理正好相反：那个接口每次请求都带新的 syncedAt，
 * 属天然不可缓存资源，因此刻意不给 ETag。
 */
function genWarehouses() {
    const items = genStock({ advance: false });
    const updatedAt = new Date(loadSavedAt()).toISOString();

    return Object.keys(WAREHOUSE_META).map((code) => {
        const meta = WAREHOUSE_META[code];
        const own = items.filter((i) => i.warehouse === code);

        const storedQty = own.reduce((sum, i) => sum + i.available + i.reserved, 0);
        const inboundQty = own.reduce((sum, i) => sum + i.inbound, 0);
        const storedVolume = own.reduce((sum, i) => {
            const catalog = SKU_CATALOG.find((c) => c.sku === i.sku);
            return sum + (i.available + i.reserved) * catalog.unitVolume;
        }, 0);

        // 库容占用按体积算到两位小数（立方米）。若按件数算，
        // 单位体积差 50 倍的 SKU 会被当成同等占位，占用率失去意义。
        const used = Number(storedVolume.toFixed(2));

        return {
            id: code,
            name: meta.name,
            city: meta.city,
            region: meta.region,
            capacity: meta.capacity,
            used,
            utilization: Number(((used / meta.capacity) * 100).toFixed(1)),
            skuCount: own.length,
            storedQty,
            inboundQty,
            status: 'online',
            updatedAt
        };
    });
}

function genSyncReceipt(body) {
    const batchId = 'B' + Date.now().toString(36).toUpperCase();
    const count = (body && Array.isArray(body.items)) ? body.items.length : 0;
    return {
        code: 0,
        msg: 'sync accepted',
        batchId,
        receivedAt: new Date().toISOString(),
        items: count,
        status: 'queued'
    };
}

module.exports = { genStock, genWarehouses, genSyncReceipt, SKU_CATALOG };
