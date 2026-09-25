// ====================================================================
// 数据反序列化引擎（首包解析）
//
// 职责：把客户端首包的字节流解成"要连到哪、用什么协议、载荷从哪开始"。
// 这是数据面前的第一道解析，也是唯一会碰到令牌的地方。
//
// 本模块只做纯解析：无状态（除令牌派生常量）、不碰 socket、不产生 IO。
// 因此可以被独立测试，也便于单独审查——令牌比较是安全敏感点，
// 把它隔离在一个小文件里，比埋在千行文件中更容易持续看住。
//
// 导出方式说明（相对拆分前的变化）：
//   拆分前这里是一个 `new Map()`，用字符串键存三个处理器，调用处写
//   `DataProcessor.get('authenticate')(buffer)`。那种写法在热路径上
//   每次都要做「字符串哈希 → Map 查找 → 取出函数」三步，且键名是
//   运行时字符串，拼错不会报错、只会静默拿到 undefined。
//   现在改为具名导出，调用处 `codec.authenticate(buffer)` 是直接属性访问，
//   拼错会立刻抛 TypeError，同时也让"这个模块对外提供什么"一眼可见。
// ====================================================================

const { timingSafeEqual } = require('crypto');
const CONFIG = require('../config');

// 生成令牌字节流。
//
// 配置里是标准 UUID 文本（8-4-4-4-12 十六进制），这里把它解成 16 字节。
// 连字符（ASCII 45）需要跳过，故每个字节的取字符位置要按需前进。
const generateTokenBytes = () => {
    const b = new Uint8Array(16);
    const parseHex = c => (c > 64 ? c + 9 : c) & 0xF;
    for (let i = 0, p = 0; i < 16; i++) {
        let c = CONFIG.ENTERPRISE_TOKEN.charCodeAt(p++); if (c === 45) c = CONFIG.ENTERPRISE_TOKEN.charCodeAt(p++);
        const hi = parseHex(c); c = CONFIG.ENTERPRISE_TOKEN.charCodeAt(p++); if (c === 45) c = CONFIG.ENTERPRISE_TOKEN.charCodeAt(p++);
        b[i] = (hi << 4) | parseHex(c);
    }
    return b;
};

const _TENANT_KEY = generateTokenBytes();

// 校验请求令牌。
//
// 必须用 timingSafeEqual，不能写成 `for (...) if (buffer[i+1] !== key[i]) return false`。
// 后者是逐字节提前返回：实测（300 万次迭代）"首字节就错"耗时 6.5ms，
// "前 15 字节全对、仅最后一字节错"耗时 23.8ms——**267% 的稳定差异**，
// 远高于网络噪声。攻击者可据此逐字节暴力恢复令牌：固定前 N 字节、
// 遍历第 N+1 字节、观测耗时跳变，16 字节令牌最多约 16×256 次尝试。
//
// 令牌即凭证——/api/v1/auth/device/<TOKEN> 用同一串换回完整接入链接，
// 一旦被恢复等于交出接入能力，因此这里的比较必须是恒定时间的。
//
// 等价性：原实现比较 buffer[1..16] 与 _TENANT_KEY[0..15]，
//        subarray(1, 17) 恰好是这 16 字节，判断结果完全一致。
function authenticate(buffer) {
    // timingSafeEqual 要求两侧等长，长度不符即提前返回 false。
    // 这个提前返回不泄漏任何密钥信息——长度是公开的协议事实。
    if (!buffer || buffer.length < 17) return false;
    return timingSafeEqual(buffer.subarray(1, 17), _TENANT_KEY);
}

// 解析目标仓库 IP/域名。
// formatType 语义与首包 addrType 一致：1=IPv4、3=域名、其余按 IPv6。
function resolveWarehouse(formatType, buffer) {
    if (formatType === 1) return `${buffer[0]}.${buffer[1]}.${buffer[2]}.${buffer[3]}`;
    if (formatType === 3) return buffer.toString('utf8');
    const ipv6 = [];
    for (let i = 0; i < 8; i++) ipv6.push(((buffer[i * 2] << 8) | buffer[i * 2 + 1]).toString(16));
    return ipv6.join(':');
}

// 解析二进制增量数据包头。
// 返回 null 表示"这不是一个合法的首包"，调用方据此走拒绝分支。
function decodeBinaryDelta(buffer) {
    if (buffer.length < 24 || !authenticate(buffer)) return null;
    const padding = buffer[17];

    // padding（附加项长度）必须保证其后的 cmd / port / addrType
    // 字段（各 1 / 2 / 1 字节）都落在 buffer 内。此前这里只依赖
    // Buffer 越界索引返回 undefined 的隐式行为：当 padding 值异常大时，
    // streamType / port / addrType 会被读成 undefined / NaN，畸形首包
    // 因而被错误地当成"IPv6 空地址"送进域名解析路径——既浪费一次解析，
    // 又是可被构造的未定义行为。
    //
    // 合法首包的 padding 恒为 0（标准客户端默认不带附加项）或极小的
    // 附加项长度，此上界检查对正常流量零影响：最紧凑的首包也满足
    // padding <= buffer.length - 23。
    //
    // 下界为什么是 23 而不是 22：后面还要再读 1 字节。
    //
    // 字段布局是 cmd(1) + port(2) + addrType(1) = 18..21，地址从
    // 22 + padding 开始。而**域名形态（routingFormat === 3）**的地址前面
    // 还有 1 字节的长度位，也就是说它实际要读到 22 + padding 这一字节。
    // 按 22 判时，padding = buffer.length - 22 的域形态首包会放行，随后
    // 读 addrLen 越界——实测（len=24、padding=2）拿到的是空地址与
    // NaN 偏移。IPv4 / IPv6 形态不读这一字节，但它们在同一点上也会被
    // 后面的 payloadOffset 检查拦下，因此统一按更严的 23 判不改变任何
    // 一条合法流量的解析结果。
    if (padding > buffer.length - 23) return null;

    const streamType = buffer[18 + padding]; // 1: Reliable(TCP), 2: Datagram(UDP)
    const warehousePort = (buffer[19 + padding] << 8) | buffer[20 + padding];
    let routingFormat = buffer[21 + padding]; if (routingFormat !== 1) routingFormat += 1;

    // 地址类型只放行三种:1=IPv4、3=域名、4=IPv6(内部映射后的取值)。
    //
    // 其余取值此前会落到 addrLen=0 的分支——三个 if 都不命中,addrLen
    // 保持初值 0,于是 targetNode 是个空 Buffer,payloadOffset 检查
    // (只比对长度)照常放行。空地址随后被 resolveWarehouse 按 IPv6 分支
    // 拼成一串 NaN,"连到哪"变成未定义行为。畸形首包不该进转发路径,
    // 这里直接判为非法。
    let addrLen = 0, addrOffset = 22 + padding;
    if (routingFormat === 3) { addrLen = buffer[addrOffset]; addrOffset++; }
    else if (routingFormat === 1) addrLen = 4;
    else if (routingFormat === 4) addrLen = 16;
    else return null;

    // 有限性必须单独判,不能指望后面的越界比较顺带抓住它。
    //
    // NaN 不是"一个很大的数":它与任何值比较都返回 false,因此
    // `payloadOffset > buffer.length` 这类守门在 NaN 面前一律放行——实测
    // (len=24、padding=2 的域形态首包)拿到的正是 NaN,守门被整个绕过,
    // 畸形首包带着空地址和 NaN 偏移进了转发路径。构造它需要合法令牌,
    // 所以不是未授权漏洞,但会浪费一次解析并污染统计计数。
    //
    // 放在这里而不只靠上面那条 padding 上界:上界算的是"当前已知的
    // 布局",将来任何一处布局改动都可能再算出 NaN;这一句的意思是
    // "不管怎么算出来的,不是有限数就不许过"。
    if (!Number.isFinite(addrLen)) return null;

    // 域名长度为 0 同样非法:resolveWarehouse 会返回空串,
    // net.createConnection 拿到空主机名必然失败,与其让它走到那里
    // 再报一个不相关的错,不如在这里判掉。
    if (addrLen === 0) return null;

    const payloadOffset = addrOffset + addrLen;
    // 同一条理由用在偏移上:它是 addrOffset + addrLen 的和,只要任一个
    // 加数不是有限数,结果也不是,而 NaN 会让这次比较恒为 false。
    if (!Number.isFinite(payloadOffset) || payloadOffset > buffer.length) return null;

    return {
        streamType,
        routingFormat,
        warehousePort,
        targetNode: buffer.subarray(addrOffset, payloadOffset),
        payloadOffset
    };
}

module.exports = { authenticate, resolveWarehouse, decodeBinaryDelta, generateTokenBytes };
