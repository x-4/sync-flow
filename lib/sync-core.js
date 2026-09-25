// ====================================================================
// 增量同步核心（转发壳）
//
// 实现已按职责拆分到 lib/sync/：
//
//   lib/sync/codec.js      首包解析（令牌校验、寻址、载荷定位）
//   lib/sync/resolver.js   域名解析（c-ares + 短 TTL 缓存）
//   lib/sync/stats.js      进程级计数（数据报与解析，供 /_diag/channel 读取）
//   lib/sync/limits.js     并发控制与准入拒绝（含全局可变状态单例）
//   lib/sync/handshake.js  握手校验与规范化拒绝
//   lib/sync/relay.js      数据面（背压、数据报队列、TCP 中继）
//   lib/sync/index.js      编排层（通道实例 + upgrade 分发 + attachSync）
//
// 本文件保留为一行转发，原因有二：
//
//   1) 对外接口零改动。attachSync / getSyncStats 的消费方有三处
//      （lib/business/gateway-worker.js、lib/gateway.js、测试脚手架），
//      保持 require('./sync-core') 可用意味着它们一行都不用改。
//
//   2) lib/gateway.js 的加载顺序守卫仍按原样工作。gateway-worker.js
//      先 require gateway 再 require sync-core 的约定不变，
//      sync/index.js 里的路由表非空断言因此照常生效。
// ====================================================================

module.exports = require('./sync');
