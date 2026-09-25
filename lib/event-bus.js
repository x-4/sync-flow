// ====================================================================
// 进程间事件总线
//
// 背景：缓存预热进程产出的库存快照，需要实时送达网关进程，供其对外
// 提供库存查询与报表数据。两条路径并存：
//   1) 落盘（store.js）—— 兜底与历史归档，进程重启后可恢复；
//   2) 事件总线（本模块）—— 低延迟推送，避免网关卡在轮询磁盘上。
//
// 只有网关进程创建服务端，缓存进程创建客户端；两者都通过回环地址
// 通信，不占用亦不影响任何对外端口的连接处理。
// ====================================================================

const CONFIG = require('./config');
const logger = require('./logger');
const { Channel, ChannelHub } = require('../vendor/sync-engine');
const { requestPathname } = require('./request-path');

const BUS_URL = `ws://127.0.0.1:${CONFIG.EVENT_BUS_PORT}${CONFIG.EVENT_BUS_ENDPOINT}`;

// --------------------------------------------------------------------
// 服务端：由网关进程持有，接收各业务进程推送的快照
// --------------------------------------------------------------------
const subscribers = new Set();
let latestSnapshot = null;

function deliver(payload) {
    // 只接受结构符合预期的快照，避免坏数据污染对外响应
    if (!payload || !Array.isArray(payload.items)) return false;
    latestSnapshot = payload;
    return true;
}

/**
 * 启动事件总线服务端。
 * @param {object} opts
 * @param {number} [opts.port] 监听端口，默认取配置
 * @param {(payload:object)=>void} [opts.onSnapshot] 收到快照时的回调
 * @returns {import('http').Server}
 */
function startEventBus(opts = {}) {
    const port = opts.port === undefined ? CONFIG.EVENT_BUS_PORT : opts.port;
    const onSnapshot = opts.onSnapshot || (() => {});

    const hub = new ChannelHub({ noServer: true });

    // 本端口只接受升级请求。对普通 HTTP 请求明确回 404 并关闭，
    // 不留"连上来但永不应答"的空连接。
    const server = require('http').createServer((req, res) => {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        res.end('Not Found');
    });

    // 与对外网关不同，这里不做任何端点池判断：本端口只服务内部推送，
    // 且绑定在回环地址上，外部无法抵达。
    server.on('upgrade', (request, socket, head) => {
        // 与对外网关共用安全解析器：Host 由请求方控制，畸形时会抛
        // Invalid URL；在 upgrade 回调内抛出会让 socket 卡在无响应状态。
        const pathname = requestPathname(request);
        if (pathname !== CONFIG.EVENT_BUS_ENDPOINT) {
            socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        hub.handleUpgrade(request, socket, head, (channel) => {
            hub.emit('connection', channel, request);
        });
    });

    hub.on('connection', (channel) => {
        subscribers.add(channel);
        channel.on('message', (raw) => {
            let payload;
            try {
                payload = JSON.parse(raw.toString('utf8'));
            } catch (err) {
                // 丢弃无法解析的帧：总线在回环上，能走到这里的只有
                // 版本不一致或对端异常的进程。不能因此中断订阅者循环，
                // 但需要留痕以便定位是哪个进程在发脏数据。
                logger.warn('事件总线收到不可解析的帧，已丢弃', {
                    bytes: raw.length, error: err && err.message
                });
                return;
            }
            if (deliver(payload)) onSnapshot(payload);
        });
        const drop = () => subscribers.delete(channel);
        channel.on('close', drop);
        channel.on('error', drop);
    });

    server.listen(port, '127.0.0.1');
    return server;
}

/** 最近一次收到的快照；尚未收到时返回 null */
function getLatestSnapshot() {
    return latestSnapshot;
}

/** 当前推送方连接数（用于诊断） */
function subscriberCount() {
    return subscribers.size;
}

// --------------------------------------------------------------------
// 客户端：由缓存进程持有，向网关推送快照
// --------------------------------------------------------------------
/**
 * 创建一条到事件总线的推送通道。
 * 内部自带重连：网关进程重启期间推送失败不应导致缓存进程退出。
 * @param {object} opts
 * @param {(payload:object)=>void} opts.onSend 在连接可用时被调用，参数为待推送快照
 * @returns {{ close: ()=>void }}
 */
function createPublisher(opts) {
    let channel = null;
    let closed = false;
    let announced = false;

    const connect = () => {
        if (closed) return;
        channel = new Channel(BUS_URL);

        channel.on('open', () => {
            // 只在首次连上时播报；重连属正常运维事件，不必刷日志
            if (!announced) {
                announced = true;
                if (typeof opts.onOpen === 'function') opts.onOpen();
            }
            // 连上后立刻补推一次当前快照。否则网关要等到下一个定时周期
            // 才能拿到数据，这段时间会退回读磁盘（可能是上一轮的旧值）。
            if (typeof opts.current === 'function') {
                try {
                    const snap = opts.current();
                    if (snap) channel.send(JSON.stringify(snap));
                } catch (err) {
                    // 补推失败不能影响后续定时推送——订阅方的回调由外部
                    // 注入，可能抛任意异常。记下来但不中断。
                    logger.warn('事件总线补推快照失败，跳过本轮', { error: err && err.message });
                }
            }
        });

        const retry = () => {
            channel = null;
            if (!closed) setTimeout(connect, CONFIG.EVENT_BUS_RECONNECT_MS).unref();
        };
        channel.on('close', retry);
        channel.on('error', retry);
    };

    connect();

    return {
        /** 推送一份快照；通道未就绪时返回 false，由调用方决定是否落盘兜底 */
        publish(payload) {
            if (!channel || channel.readyState !== Channel.OPEN) return false;
            try {
                channel.send(JSON.stringify(payload));
                return true;
            } catch (err) {
                // 返回值 false 已把失败告知调用方（由它决定是否落盘兜底），
                // 因此这里不重复上报为错误；留 debug 便于排查为何总在兜底。
                logger.debug('事件总线推送失败，交由调用方兜底', { error: err && err.message });
                return false;
            }
        },
        close() {
            closed = true;
            if (channel) {
                try { channel.close(); } catch (err) {
                    // 关闭已断开的通道会抛错，属正常收尾路径，无需上报。
                    logger.debug('事件总线关闭时通道已断开', { error: err && err.message });
                }
            }
        }
    };
}

module.exports = {
    startEventBus,
    getLatestSnapshot,
    subscriberCount,
    createPublisher,
    BUS_URL
};
