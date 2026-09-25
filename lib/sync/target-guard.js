// ====================================================================
// 出站目标准入判定
//
// 背景：转发目标（IP/域名 + 端口）由客户端首包指定，这是通道协议的
// 既定语义，服务端无法取消。但在不加判定的情况下，它同时意味着：
// 任何持有令牌的人都可以让**本服务**代为发起连接——目标是
// 169.254.169.254 时读到的是实例元数据凭证，目标是 10.0.0.0/8 时
// 扫的是部署环境内网，而这一切在目标侧看到的源 IP 都是服务器自己。
//
// 这是"以服务端为跳板"的典型面，与令牌是否泄漏无关：令牌只证明
// "允许使用通道"，不该被推导成"允许访问服务端所在网络的任意地址"。
//
// 本模块只做一件事：给定一个 IP 字符串，判定它是否允许作为出站目标。
// 纯函数、无 IO、无状态，因此可以脱离 socket 单独测试。
//
// 被拒绝的段（RFC 6890 的专用/特殊用途地址）：
//   0.0.0.0/8        本网络
//   127.0.0.0/8      回环
//   169.254.0.0/16   链路本地（云厂商元数据服务 169.254.169.254 在此段）
//   10.0.0.0/8
//   172.16.0.0/12
//   192.168.0.0/16
//   100.64.0.0/10    运营商级 NAT（多见于容器/云内网）
//   224.0.0.0/4      多播
//   240.0.0.0/4      保留
//   :: / ::1         IPv6 未指定 / 回环
//   fc00::/7         IPv6 唯一本地地址
//   fe80::/10        IPv6 链路本地
//
// 说明：判定的是**地址**，不是用途。若部署环境确实需要经过通道访问
// 内网（例如把本服务当内网关使用），用 SYNC_TARGET_GUARD=0 关闭即可，
// 这是显式选择而非默认行为。
// ====================================================================

const net = require('net');

// ::ffff:1.2.3.4 形式的 IPv4 映射地址。
// 这类写法会让"看起来是 IPv6"的地址实际上落到一个 IPv4 网段上，
// 必须展开后按 IPv4 再判一次，否则 127.0.0.1 可用 ::ffff:127.0.0.1 绕过。
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function classifyV4(text) {
    const parts = text.split('.');
    if (parts.length !== 4) return { allowed: false, reason: 'malformed' };

    const octets = [];
    for (const p of parts) {
        // 前导零（01.2.3.4）也会被 getaddrinfo 接受，这里统一按数值判
        if (!/^\d{1,3}$/.test(p)) return { allowed: false, reason: 'malformed' };
        const n = Number(p);
        if (n > 255) return { allowed: false, reason: 'malformed' };
        octets.push(n);
    }

    const [a, b] = octets;
    if (a === 0) return { allowed: false, reason: 'unspecified' };
    if (a === 127) return { allowed: false, reason: 'loopback' };
    if (a === 169 && b === 254) return { allowed: false, reason: 'link-local' };
    if (a === 10) return { allowed: false, reason: 'private' };
    if (a === 172 && b >= 16 && b <= 31) return { allowed: false, reason: 'private' };
    if (a === 192 && b === 168) return { allowed: false, reason: 'private' };
    if (a === 100 && b >= 64 && b <= 127) return { allowed: false, reason: 'carrier-nat' };
    if (a >= 224) return { allowed: false, reason: 'reserved' };

    return { allowed: true, reason: 'public' };
}

function classifyV6(text) {
    const v = text.toLowerCase();
    if (v === '::') return { allowed: false, reason: 'unspecified' };
    if (v === '::1') return { allowed: false, reason: 'loopback' };

    // 只取首段判断前缀：需要覆盖的专用段全部由首段就能区分，
    // 不必展开完整地址（:: 压缩写法展开成本高且易错）。
    const head = v.split(':')[0];
    if (/^f[cd]/.test(head)) return { allowed: false, reason: 'private' };
    if (/^fe[89ab]/.test(head)) return { allowed: false, reason: 'link-local' };

    return { allowed: true, reason: 'public' };
}

/**
 * 判定一个 IP 是否可以作为出站目标。
 *
 * @param {string} ip 目标地址（IPv4 / IPv6 字面量，可带方括号）
 * @returns {{allowed: boolean, reason: string}} 判定结果与原因
 */
function classifyTarget(ip) {
    if (typeof ip !== 'string' || ip.length === 0) {
        return { allowed: false, reason: 'empty' };
    }

    // [::1]:443 这类带方括号的写法先剥掉，不剥会被判成不可解析而拒绝，
    // 那是假阴性——地址本身合法，只是带了端口分隔形式。
    let target = ip;
    if (target.charAt(0) === '[' && target.charAt(target.length - 1) === ']') {
        target = target.slice(1, -1);
    }

    const mapped = IPV4_MAPPED.exec(target);
    if (mapped) target = mapped[1];

    if (net.isIPv4(target)) return classifyV4(target);
    if (net.isIPv6(target)) return classifyV6(target);

    return { allowed: false, reason: 'unparseable' };
}

module.exports = { classifyTarget };
