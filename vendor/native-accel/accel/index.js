'use strict';

// 相对路径引用随项目分发的定位器，使本目录自包含：不依赖
// node_modules 目录、不依赖 npm 安装、不依赖任何环境变量。
//
// 注意定位器与本包平级（../prebuild-loader），不在本包内部。
// 分发时须连同 ../prebuild-loader 一并保留，否则会静默掉进下面的
// 便携实现——功能照常，仅吞吐下降。
try {
  module.exports = require('../prebuild-loader')(__dirname);
} catch (e) {
  module.exports = require('./fallback');
}
