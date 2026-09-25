// ====================================================================
// 解析期错误响应（clientError 钩子）
//
// 为什么需要这个模块
// ------------------
// Node 的 HTTP 内核在**解析阶段**就发现请求非法时（畸形请求行、非法头、
// 裸 LF 换行、头部超限……），会抢在应用层之前直接向 socket 写出一段
// 内置响应：
//
//     HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n
//
// 它没有 Server 头、没有 Date、没有正文、没有安全头。而本服务其余所有
// 响应（HTML / JSON / 错误页 / 101 升级）都自称 nginx/1.24.0 并带完整
// 头部集合。这个反差本身就是一条强特征：探测者只要发一个畸形请求，
// 看 400 响应里有没有 Server 头，就能把本服务与真实 nginx 区分开。
//
// 实测（体检报告 §3）三处触发点：
//   - 恶意方法（FLARB /）
//   - 畸形头（Host x，缺冒号）
//   - 裸 LF 换行
//
// 修法
// ----
// 注册 server.on('clientError')，用 lib/http-response 的 serializeResponse()
// 写出与其它路径**完全同源**的响应。选它而不是 respond() 是因为：
// clientError 拿到的是**裸 socket**，没有 http.ServerResponse 对象，
// 无法走 res.setHeader / res.writeHead。
//
// 为什么单独成模块而不是内联在 gateway-worker.js
// -----------------------------------------------
// 本逻辑需要被 (a) HTTP worker 注册、(b) 测试直接调用验证。
// 内联在 worker 入口会让测试不得不启动整个进程。放在这里两者共用一份实现，
// 也避免"测试测的是另一个副本"这类假测试。
// ====================================================================

const { serializeResponse } = require('./http-response');
const { buildBadRequestHtml, buildHeaderTooLargeHtml } = require('./error-pages');

// 是否为"头部超限"类错误。
//
// Node 在 err.code 上给出具体原因，值得区分：
//   - HPE_HEADER_OVERFLOW → 431（RFC 6585 §5）
//   - 其余 HPE_*          → 400
// 统一返回 400 会偏离所声明的 nginx 身份：真实 nginx 对超大头部返回 431。
function statusForClientError(err) {
    return err && err.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
}

// 为该状态码取同源的错误页 HTML
function htmlForStatus(status) {
    return status === 431 ? buildHeaderTooLargeHtml() : buildBadRequestHtml();
}

// 处理一次 clientError。
//
// 返回值语义（便于测试断言，不使用异常控制流）：
//   'handled'  已写出响应
//   'skipped'  socket 已不可写（对端已断开等），无可响应
//
// 关于 req 参数：clientError 的第三参数是解析出的 partial request，
// 可能不完整（连 method 都可能是 undefined）。serializeResponse 会用到
// 它做两件事：HEAD 判定与 Accept-Encoding 协商。两者都对缺失字段有容忍，
// 缺失时退化为"非 HEAD、不压缩"，正是我们要的保守行为。
function handleClientError(err, socket, onLog) {
    // 双重防护：Node 文档明确要求调用方自行确认 socket 可写，
    // 否则 ECONNRESET 会从 write 里抛出并变成未捕获异常。
    if (!socket || socket.destroyed || !socket.writable) {
        return 'skipped';
    }

    const status = statusForClientError(err);

    // 走统一的公共写出。这里不能 try/catch 后静默吞掉：写失败说明
    // 连接已在半途断掉，属于正常现象，但需要一个可观测的记录点，
    // 因此交给调用方注入的 onLog。
    try {
        const serialized = serializeResponse(null, {
            status,
            contentType: 'text/html; charset=utf-8',
            body: htmlForStatus(status),
            extraHeaders: { 'Cache-Control': 'no-store' }
        });
        socket.end(serialized.bytes);
        return 'handled';
    } catch (writeErr) {
        if (onLog) onLog(writeErr, status);
        // 兜底：确保 socket 一定被释放，不留悬挂连接
        try { socket.destroy(); } catch (_) { /* 已断开，忽略 */ }
        return 'skipped';
    }
}

// 把钩子挂到 server 上。抽成函数是为了让 worker 入口保持一行。
function attachClientErrorHandler(server, onLog) {
    server.on('clientError', (err, socket) => {
        handleClientError(err, socket, onLog);
    });
}

module.exports = { attachClientErrorHandler, handleClientError, statusForClientError };
