// ====================================================================
// 数据报通道描述
//
// 配置解析（TELEMETRY_ENDPOINTS / SYNC_UDP_DISABLE）已收编进
// lib/config.js（TELEMETRY_BACKENDS / SYNC_UDP_ENABLED 等字段），
// 本模块只保留面向启动日志与 /_diag 的描述函数，不再持有任何
// 环境变量读取逻辑。
//
// ── 默认值的两次反转（都记在这里，避免第三次改的时候只改一边）──
//
// 【曾经】硬编码三家公共 DoH，理由是方便。
//
// 【然后改为不内置】理由两条：
//   1. 隔离内网没有出口，请求必然失败，通道形同虚设；
//   2. 向公共解析器持续发 DNS 查询，本身就是一条显眼的流量特征。
// 当时因此定为"未配置即彻底关闭（不再有对外连接行为）"。
//
// 【现在又改为内置】"未配置即关闭"在有公网出口的部署上会变成静默
// 失效：连接能建、握手全过，唯独每条域名解析被回绝，而启动日志干净
// 得看不出问题。真实故障正是这样，排查成本很高。
//
// 【第三次反转：去掉"置空即关闭"】
//
// "内置默认值"解决了静默失效，却留下了第二个关闭开关：
// TELEMETRY_ENDPOINTS 显式置空 = 关闭通道。它的触发方式与"没配"在配置
// 文件里长得一模一样（TELEMETRY_ENDPOINTS= vs 整行不写），部署平台的
// 环境变量面板里更是完全无法区分。真实故障正是这样发生的：面板里一个
// 空值让 DNS 通道静默关闭，浏览器所有域名解析失败，而 TCP 路径一切正常
// ——症状完全不像配置问题，连着排查了五轮。
//
// 第二轮补了一条启动 WARN 试图让人自己改配置，也没用：部署平台给所有
// 日志行统一加了 [info] 前缀，warn 级与 info 级在面板上无法区分，那条
// [严重] 被淹没，用户没看到，又空跑两轮。**核心功能不能靠"用户恰好
// 看到某行日志"才可用。**
//
// 因此现在：TELEMETRY_ENDPOINTS 未提供 / 为空 / 纯空白 / 全部条目不合法
// ——一律回落到内置默认值，通道保持可用。唯一关闭方式是 SYNC_UDP_DISABLE=1。
//
// ⚠️ 因此下面这条描述必须与 lib/config.js 的 resolveTelemetryBackends
// 保持同步。当前真实行为是：
//   未设置 / 置空 / 填了但全不合法 → 回落到内置公共 DoH（**会有对外连接**）
//   填了合法值（含"合法+非法"混合）→ 用用户的值
//   SYNC_UDP_DISABLE=1             → 强制关闭，无对外连接
// 只改 config.js 而忘了改这里的注释，就会得到一份与实际行为相反、
// 而偏偏又是讲"有没有对外连接"这种安全相关事实的说明——比没注释更糟。
// ====================================================================

const CONFIG = require('./config');

function describeDatagram() {
    if (CONFIG.SYNC_UDP_FORCE_DISABLED) return 'disabled(by SYNC_UDP_DISABLE)';
    if (CONFIG.TELEMETRY_BACKENDS.length === 0) return 'disabled(no endpoint configured)';
    return 'enabled(' + CONFIG.TELEMETRY_BACKENDS.length + ' endpoint(s))';
}

// /_diag/channel 用的结构化状态。
//
// 为什么在字符串之外还要有它：用户报障时最需要的是一个"现在到底是开
// 是关"的是/否，而 describeDatagram 把答案埋在需要人读的字符串里。
// 且经历过一次"日志被平台统一打成 [info]"之后，可机读的布尔值比可人读
// 的一句话更可靠——curl 出来看 enabled 字段即可，不用在一大片日志里找。
//
// backendCount 在关闭时也照实报配置到的条数：配合 disabledBy 才能区分
// "关掉了（但配了 3 个）"与"一个都没配到"两种情况。
function describeDatagramState() {
    const count = Array.isArray(CONFIG.TELEMETRY_BACKENDS) ? CONFIG.TELEMETRY_BACKENDS.length : 0;
    let disabledBy = null;
    if (CONFIG.SYNC_UDP_FORCE_DISABLED) disabledBy = 'SYNC_UDP_DISABLE';
    else if (count === 0) disabledBy = 'no-backend';
    return {
        enabled: CONFIG.SYNC_UDP_ENABLED === true && count > 0,
        backendCount: count,
        disabledBy: disabledBy,
        // 非 null 表示本次启动发生过回落：'missing'=没配/空，'invalid'=填错
        configFallback: CONFIG.TELEMETRY_FALLBACK || null
    };
}

module.exports = {
    describeDatagram,
    describeDatagramState
};
