'use strict';

const { EMPTY_BUFFER } = require('./protocol-constants');

const FastBuffer = Buffer[Symbol.species];

/**
 * Merges an array of buffers into a new buffer.
 *
 * @param {Buffer[]} list The array of buffers to concat
 * @param {Number} totalLength The total length of buffers in the list
 * @return {Buffer} The resulting buffer
 * @public
 */
function concat(list, totalLength) {
  if (list.length === 0) return EMPTY_BUFFER;
  if (list.length === 1) return list[0];

  const target = Buffer.allocUnsafe(totalLength);
  let offset = 0;

  for (let i = 0; i < list.length; i++) {
    const buf = list[i];
    target.set(buf, offset);
    offset += buf.length;
  }

  if (offset < totalLength) {
    return new FastBuffer(target.buffer, target.byteOffset, offset);
  }

  return target;
}

/**
 * Masks a buffer using the given mask.
 *
 * @param {Buffer} source The buffer to mask
 * @param {Buffer} mask The mask to use
 * @param {Buffer} output The buffer where to store the result
 * @param {Number} offset The offset at which to start writing
 * @param {Number} length The number of bytes to mask.
 * @public
 */

// 按"从相对偏移 r 开始的键相位"直接组装 32 位键字。
// 小端机器上 u32 的第 j 个字节（低地址起）权重为 8j，因此相位 r 对应的
// 字就是 mask[r], mask[r+1], mask[r+2], mask[r+3] 依次放在字节 0..3。
// 直接按位组装而不做循环移位，免得在"左移/右移"的语义上来回翻车。
function phaseWord(mask, r) {
  return (
    mask[r] |
    (mask[(r + 1) & 3] << 8) |
    (mask[(r + 2) & 3] << 16) |
    (mask[(r + 3) & 3] << 24)
  ) >>> 0;
}

function _mask(source, mask, output, offset, length) {
  //
  // 先批量拷贝，再在目标上做字长化异或。
  //
  // 原来的写法是逐字节"读 source -> 异或 -> 写 output"，每次迭代都要走
  // 两次 Uint8Array 元素访问；改成 memcpy（内核/内建实现，走的是
  // 字长搬运）+ 原地 32 位异或（一次迭代处理 4 字节）后，单位字节的
  // 指令数下降一个量级。两者在数学上完全等价。
  //
  if (length > 0) source.copy(output, offset, 0, length);
  _unmask(output.subarray(offset, offset + length), mask);
}

/**
 * Unmasks a buffer using the given mask.
 *
 * @param {Buffer} buffer The buffer to unmask
 * @param {Buffer} mask The mask to use
 * @public
 */
function _unmask(buffer, mask) {
  const len = buffer.length;

  // 短缓冲不值得为对齐付出代价：逐字节路径在这里反而更快
  if (len < 32) {
    for (let i = 0; i < len; i++) buffer[i] ^= mask[i & 3];
    return;
  }

  const byteOffset = buffer.byteOffset;

  // Uint32Array 视图要求绝对地址 4 字节对齐；键相位则取决于"相对于
  // buffer 起点的偏移"。因此头部先逐字节处理到绝对地址对齐的位置，
  // 再按该相对偏移旋转键字。
  const head = (4 - (byteOffset & 3)) & 3;
  let i = 0;
  for (; i < head; i++) buffer[i] ^= mask[i & 3];

  const word = phaseWord(mask, head);
  const span = (((len - i) >> 2) << 2);

  if (span > 0) {
    const view = new Uint32Array(buffer.buffer, byteOffset + i, span >> 2);
    for (let k = 0; k < view.length; k++) view[k] ^= word;
  }

  i += span;
  // 尾部不足 4 字节的部分逐字节收尾
  for (; i < len; i++) buffer[i] ^= mask[i & 3];
}

/**
 * Converts a buffer to an `ArrayBuffer`.
 *
 * @param {Buffer} buf The buffer to convert
 * @return {ArrayBuffer} Converted buffer
 * @public
 */
function toArrayBuffer(buf) {
  if (buf.length === buf.buffer.byteLength) {
    return buf.buffer;
  }

  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
}

/**
 * Converts `data` to a `Buffer`.
 *
 * @param {*} data The data to convert
 * @return {Buffer} The buffer
 * @throws {TypeError}
 * @public
 */
function toBuffer(data) {
  toBuffer.readOnly = true;

  if (Buffer.isBuffer(data)) return data;

  let buf;

  if (data instanceof ArrayBuffer) {
    buf = new FastBuffer(data);
  } else if (ArrayBuffer.isView(data)) {
    buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
  } else {
    buf = Buffer.from(data);
    toBuffer.readOnly = false;
  }

  return buf;
}

module.exports = {
  concat,
  mask: _mask,
  toArrayBuffer,
  toBuffer,
  unmask: _unmask
};

// —— 本机加速件的加载 ——
//
// 该件是可选的纯加速实现：把中间层的按位运算从 JS 逐字节循环下沉到
// 平台原生实现。缺失时本文件下方的便携实现照常工作，功能完全等价，
// 仅吞吐有别，因此这里的每一次失败都只降级、不抛错。
//
// 加载逻辑单点在 vendor/native-accel/loader.js（lib/config.js 的启动
// 探测同样引用它），保证"日志口径"与"实际装载"永远解析到同一个模块。
const { loadNativeAccel } = require('../../native-accel/loader');

/* istanbul ignore else  */
if (!process.env.WS_NO_NATIVE_ACCEL) {
  try {
    const accel = loadNativeAccel();

    module.exports.mask = function (source, mask, output, offset, length) {
      if (length < 48) _mask(source, mask, output, offset, length);
      else accel.mask(source, mask, output, offset, length);
    };

    module.exports.unmask = function (buffer, mask) {
      if (buffer.length < 32) _unmask(buffer, mask);
      else accel.unmask(buffer, mask);
    };
  } catch (e) {
    // Continue regardless of the error.
  }
}
