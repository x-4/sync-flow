'use strict';

// ====================================================================
// 本机加速件的单点加载器
//
// 此前"加载加速件"的逻辑存在两份独立拷贝：
//   · lib/config.js 的 detectNativeAccel()（启动探测，决定日志口径）
//   · vendor/sync-engine/lib/frame-buffer.js 的 loadNativeAccel()（实际装载）
// 两处必须保持完全一致的解析顺序（本地副本优先 → 标准说明符兜底），
// 否则会出现"启动日志说在跑原生、实际加载失败退回便携实现"的矛盾，
// 且这种矛盾在压测外极难察觉。现在两处都改为引用本模块，
// 解析顺序与判定标准收敛为单点。
//
// 该文件位于 vendor/native-accel/ 内部，仅使用相对路径引用，
// 不引入任何裸说明符（唯一的兜底 require('accel') 仅在本地副本
// 被裁剪时才会走到，正常分发下不可达），保持 vendor 目录自包含。
// ====================================================================

// 按既定解析顺序加载加速件：
//   1) 首选 vendor 本地副本——自包含、随源码分发即可生效，
//      不依赖 node_modules 是否存在、也不依赖 npm install。
//   2) 退回标准裸说明符——纯粹为兼容"有人把该件装进 node_modules"的情形。
// 两路都失败时向上抛出，由调用方决定降级方式（探测方回 false，
// 装载方退回便携实现）。
function loadNativeAccel () {
  try {
    return require('./accel');
  } catch (e) {
    // 本地副本不可用（被裁剪/被移走）时，尝试标准解析路径
    return require('accel');
  }
}

// 判定加载到的是不是"真的原生实现"。
// 原生实现由 C++ 绑定导出，Function.prototype.toString 呈现 [native code]；
// 便携实现则不会。以此区分"真的加速"与"静默降级"。
function isNativeAccel (loaded) {
  return typeof loaded === 'object' && loaded !== null &&
    typeof loaded.mask === 'function' &&
    /\[native code\]/.test(loaded.mask.toString());
}

module.exports = { loadNativeAccel, isNativeAccel };
