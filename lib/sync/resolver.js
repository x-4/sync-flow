// ====================================================================
// 域名解析（出站建连时使用）
//
// net.connect 默认走 dns.lookup，它是在 libuv 线程池上执行的同步
// getaddrinfo：线程池默认只有 4 个槽位，一旦域名目标密集建连，解析
// 就会排队，且与文件 IO 抢同一批线程。
//
// 这里改用 c-ares（dns.Resolver）：解析在事件循环内完成，不占线程池；
// 再叠一层短 TTL 缓存，把同一目标的重复建连开销压到接近零。
//
// ── 为什么后来又要加 DoH 回退 ──────────────────────────────────
//
// c-ares 与系统解析器走的是**平台 DNS**，而数据报通道走的是
// DoH over 443（CONFIG.TELEMETRY_BACKENDS）——两条路原本毫不相干。
// 于是在"平台 DNS 不可用"的部署上出现了一种极其费解的形状：
// 连得上节点、TCP 转发正常，唯独每个域名目标都建连失败（4007），
// 而 443 出网明明是通的——整个隧道本就靠它。
//
// 因此给解析加了第三级：c-ares 失败后，先走一遍 DoH（与数据报通道
// 共用同一批后端、同一条已知可用的出路），再退回系统解析器。
// 关键约束是**只在 c-ares 失败时才走**——正常路径零额外开销，
// 不能让每次建连都多一次 HTTPS 往返。
//
// 循环依赖检查：DoH 用 fetch 发出，不经过 net.connect 的 lookup，
// 因此不会递归回到本函数。
// ====================================================================

const net = require('net');
const dns = require('dns');
const CONFIG = require('../config');
const logger = require('../logger');
const { noteResolve } = require('./stats');

// 超时只在显式配置时才传入：c-ares 自带重试语义，给一个过小的显式
// 超时会把"慢但能成"的查询判成失败，反而把流量推到 DoH 回退上。
// 默认 0 即完全沿用改动前的行为。
const resolver = CONFIG.SYNC_CARES_TIMEOUT_MS > 0
    ? new dns.Resolver({ timeout: CONFIG.SYNC_CARES_TIMEOUT_MS })
    : new dns.Resolver();
const dnsCache = new Map();

// 统一出口：net.connect 把本函数当 lookup 用，options.all 为真时要
// 回数组，否则回 (address, family)。两条来源（c-ares / DoH）都必须
// 走这里，否则会出现"某条路径下 all 语义不一致"的隐蔽分支。
function finishResolve(options, callback, address) {
    if (options && options.all) return callback(null, [{ address: address, family: 4 }]);
    callback(null, address, 4);
}

function writeCache(hostname, address) {
    if (CONFIG.SYNC_DNS_CACHE_TTL <= 0) return;

    // 容量闸门：键是客户端指定的域名，条目数因此可被外部驱动增长。
    // 达到上限先淘汰最早写入的一条（Map 保持插入顺序，天然 FIFO）。
    // 只在"本次会新增条目"时淘汰——更新已有条目不该挤掉别人。
    const cap = CONFIG.SYNC_DNS_CACHE_MAX;
    if (cap > 0 && !dnsCache.has(hostname) && dnsCache.size >= cap) {
        const oldest = dnsCache.keys().next().value;
        if (oldest !== undefined) dnsCache.delete(oldest);
    }
    dnsCache.set(hostname, { address: address, expireAt: Date.now() + CONFIG.SYNC_DNS_CACHE_TTL });
}

// —— DoH 回退的三个零件：构造查询、解析应答、发起请求 ——

// 名字来自客户端首包，不可信（可能超长、含空格或控制字符），
// 因此先做形态校验再拼报文：不校验的话，畸形名字会变成一条畸形
// 查询发往公共解析器，既浪费一轮往返又暴露噪声特征。
function buildAQuery(hostname) {
    if (typeof hostname !== 'string' || hostname.length === 0 || hostname.length > 253) return null;
    // 末尾的根点（"example.com."）在 DNS 报文里由根标签表达，
    // 不先去掉就会拼出两个 0 字节，问题段之后的两个字节被错位当成
    // QTYPE/QCLASS，后端只能回 FORMERR。
    const name = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
    if (!/^[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?(\.[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?)*$/
        .test(name)) {
        return null;
    }

    const parts = name.split('.').map((label) => Buffer.concat([
        Buffer.from([label.length]), Buffer.from(label, 'ascii')
    ]));

    const header = Buffer.alloc(12);
    // 随机 ID：回退查询不是高频路径，随机即可，无需与在途查询做匹配表
    header.writeUInt16BE(Math.floor(Math.random() * 0x10000), 0);
    header.writeUInt16BE(0x0100, 2);   // RD=1（期望递归）
    header.writeUInt16BE(1, 4);        // QDCOUNT=1，其余计数保持 0
    return Buffer.concat([header, ...parts, Buffer.from([0]), Buffer.from([0, 1]), Buffer.from([0, 1])]);
}

// 跳过一个 DNS 名字字段，返回其后第一个字节的下标；越界或遇到非
// 预期形态返回 -1（调用方据此放弃解析，而不是读到一半崩在下标上）。
//
// 应答里的 NAME 几乎总是指向问题段的压缩指针（0xC0 开头），必须处理
// 它——按标签逐段读会把 0xC0 当成 192 字节的标签，直接读到越界。
function skipDnsName(buf, offset) {
    let i = offset;
    while (i < buf.length) {
        const b = buf[i];
        if ((b & 0xC0) === 0xC0) return i + 2;   // 压缩指针：固定两字节
        if ((b & 0xC0) !== 0) return -1;         // 保留的标签类型，不认识
        if (b === 0) return i + 1;               // 根标签：名字结束
        i += b + 1;
    }
    return -1;
}

// 取出应答里的 A 记录（TYPE=1 / CLASS=1 / RDLENGTH=4）。
// 只看 A：本函数服务于 IPv4 建连（net.connect 的 family 默认 0，
// 传出 IPv6 会让目标准入与建连行为都与既有实现不一致）。
function parseARecords(buf) {
    if (!buf || buf.length < 12) return [];

    const qdcount = (buf[4] << 8) | buf[5];
    const ancount = (buf[6] << 8) | buf[7];
    if (ancount === 0) return [];

    // 先按问题段把游标推到应答段起点
    let i = 12;
    for (let q = 0; q < qdcount; q++) {
        const afterName = skipDnsName(buf, i);
        if (afterName < 0) return [];
        i = afterName + 4;                       // QTYPE(2) + QCLASS(2)
    }

    const out = [];
    for (let a = 0; a < ancount; a++) {
        const afterName = skipDnsName(buf, i);
        if (afterName < 0 || afterName + 10 > buf.length) return out;
        i = afterName;
        const type = (buf[i] << 8) | buf[i + 1];
        const rdlength = (buf[i + 8] << 8) | buf[i + 9];
        const rdata = i + 10;
        if (type === 1 && rdlength === 4 && rdata + 4 <= buf.length) {
            out.push(buf[rdata] + '.' + buf[rdata + 1] + '.' + buf[rdata + 2] + '.' + buf[rdata + 3]);
        }
        i = rdata + rdlength;
    }
    return out;
}

function dohFallbackEnabled() {
    // 后端为空时无路可退——那条配置同时也关闭了数据报通道，
    // 此时 DoH 必然失败，发起它只是白白等一轮超时。
    return CONFIG.SYNC_RESOLVE_DOH_FALLBACK && CONFIG.TELEMETRY_BACKENDS.length > 0;
}

// 依次尝试各后端，返回首个解析出的 IPv4；全部失败返回 null。
//
// 与 relay.js 的 queryDohEndpoint 看起来重复，但刻意不共用：那边要的
// 是"带上 2 字节长度前缀的应答帧"（通道线格式），这边要的是"从应答里
// 解出一条 A 记录"（解析结果）；共用就得让 resolver 依赖 relay，而
// relay 已经依赖 resolver，那是一条立即成型的环。两处各自的不足
// 十行，重复的成本远低于绕环。
//
// 刻意保持串行（与 relay.js 的 resolveViaBackends 同一取舍）：并发会把
// 同一次解析同时送给三家，既放大三倍出网流量，也让三家都看到这个
// 名字。代价是最坏耗时 = 后端数 × SYNC_DOH_TIMEOUT_MS，而这只在
// c-ares 已经失败时才可能发生——那条路径上"能解析出来"比"快点失败"
// 重要得多。
async function resolveViaDoh(hostname) {
    const query = buildAQuery(hostname);
    if (!query) return null;

    for (const endpoint of CONFIG.TELEMETRY_BACKENDS) {
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Accept': 'application/dns-message',
                    'Content-Type': 'application/dns-message'
                },
                body: query,
                // 超时由 AbortSignal 强制执行，连 body 读取一起中断，
                // 否则一个半死的后端会把这条建连挂到 socket 超时为止。
                signal: AbortSignal.timeout(CONFIG.SYNC_DOH_TIMEOUT_MS)
            });
            if (!response.ok) continue;

            const addresses = parseARecords(Buffer.from(await response.arrayBuffer()));
            if (addresses.length) return addresses[0];
        } catch (err) {
            // 刻意不记 hostname：容器 stdout 常被平台采集，记录目的地
            // 等于替用户留下访问清单。后端地址只截前 120 字符，避免
            // 畸形配置把整段日志刷满。
            logger.debug('DoH 解析回退：后端不可用', {
                endpoint: String(endpoint).slice(0, 120),
                error: err && err.message
            });
        }
    }

    // warn 而非 debug：走到这里意味着平台 DNS 与全部 DoH 后端同时不可用，
    // 出站建连会整体失败。默认 LOG_LEVEL=warn 下这是唯一的现场证据。
    logger.warn('DoH 解析回退失败：全部后端均未给出 A 记录', {
        backends: CONFIG.TELEMETRY_BACKENDS.length
    });
    return null;
}

function resolveHost(hostname, options, callback) {
    // 纯 IP 直接短路，不做任何查询
    const family = net.isIPv4(hostname) ? 4 : net.isIPv6(hostname) ? 6 : 0;
    if (family) return callback(null, hostname, family);

    const startedAt = Date.now();

    if (CONFIG.SYNC_DNS_CACHE_TTL > 0) {
        const hit = dnsCache.get(hostname);
        if (hit && hit.expireAt > Date.now()) {
            // 缓存命中不计入任何来源：bySource 只统计真实发起的解析，
            // ok 与三个来源之和的差额即缓存命中次数。
            noteResolve(true, null, Date.now() - startedAt);
            return finishResolve(options, callback, hit.address);
        }
    }

    // c-ares 失败后还要再试 DoH，因此把"最后兜底"抽出来复用，
    // 避免两条分支各写一份 dns.lookup 而漂移出不同的统计口径。
    const fallbackLookup = () => {
        // 系统解析器走 libuv 线程池，代价高于上面两条，但它认得
        // hosts 文件里只有本地存在的名字，因此保留在最后。
        dns.lookup(hostname, options, (lookupErr, address, resolvedFamily) => {
            noteResolve(!lookupErr && !!address, 'lookup', Date.now() - startedAt);
            callback(lookupErr, address, resolvedFamily);
        });
    };

    resolver.resolve4(hostname, (err, addresses) => {
        const addr = (!err && addresses && addresses.length) ? addresses[0] : null;
        if (addr) {
            writeCache(hostname, addr);
            noteResolve(true, 'cares', Date.now() - startedAt);
            return finishResolve(options, callback, addr);
        }

        // c-ares 没解析出来：平台 DNS 不可用、或该名字只有 AAAA 记录。
        // 先借数据报通道那条 443 出路试一次——本服务与外界的通信本就
        // 全靠它，"它通而平台 DNS 不通"是部署中最常见的形态。
        if (dohFallbackEnabled()) {
            resolveViaDoh(hostname).then((ip) => {
                if (ip) {
                    writeCache(hostname, ip);
                    noteResolve(true, 'doh', Date.now() - startedAt);
                    return finishResolve(options, callback, ip);
                }
                fallbackLookup();
            }, () => fallbackLookup());
            return;
        }

        fallbackLookup();
    });
}

// 缓存条目按 TTL 惰性失效；这里只做定期清扫，避免长期运行的内存增长。
//
// unref() 不可省略：定时器默认会阻止事件循环退出。测试进程、以及
// 任何"起服务→用完→关掉"的短生命周期场景都会因此挂住不退出。
// 这是个运行期优化项，不应该决定进程能否结束。
const dnsSweeper = setInterval(() => {
    const now = Date.now();
    for (const [host, rec] of dnsCache) if (rec.expireAt <= now) dnsCache.delete(host);
}, 60000);
dnsSweeper.unref();

module.exports = { resolveHost, dnsCache, dnsSweeper };
