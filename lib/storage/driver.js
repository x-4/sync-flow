// ====================================================================
// 业务数据落盘的**驱动抽象**
//
// 目的：把"数据放在哪"与"业务怎么用数据"彻底分开。上层的 store.js
// 只认同一套操作原语（读 / 写 / 列举 / 删除），具体落到磁盘还是进程
// 内存，由运行期配置决定。这样同一份代码既能跑在自建机 / Docker /
// K8s（有可写卷），也能跑在只读文件系统的 Serverless / 边缘运行时。
//
// 两个实现共享语义约定（两者必须行为一致，否则会出现"换驱动就变样"
// 的隐蔽故障）：
//   1. 读缺失一律返回 null，不抛异常——"文件还没生成"是常态；
//   2. 写入是原子的：要么看到完整的新值，要么看到完整的旧值，
//      绝不出现半截内容（fs 用 tmp+rename，memory 用整体替换引用）；
//   3. 列举返回按名字**倒序**排列的字符串数组（新→旧）。
//
// 键值域（key 的语义）：
//   store.js 以「相对 DATA_DIR 的逻辑路径」作为 key（如 stock/stock.json、
//   reports/latest.json）。fs 驱动把它映射为真实路径；memory 驱动直接
//   拿它当 Map 的键。因此 key 只表达**逻辑位置**，不携带平台语义。
// ====================================================================

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const logger = require('../logger');

// ====================================================================
// 驱动一：本地文件系统
//
// 保留原有全部行为：临时文件 + rename 的原子写、ENOENT 静默回落、
// 非 ENOENT 错误留痕。这是默认驱动，行为与抽象化之前逐字一致。
// ====================================================================

function createFsDriver(rootDir) {
    // key（相对路径） -> 绝对路径
    const abs = (key) => path.join(rootDir, key);

    function readSync(key) {
        try {
            return fs.readFileSync(abs(key), 'utf8');
        } catch (err) {
            // ENOENT 是常态（尚未生成）；其余（EACCES、EISDIR、EIO）
            // 是真实故障，必须留痕，否则表现为"数据凭空消失"。
            if (err && err.code !== 'ENOENT') {
                logger.warn('状态文件读取失败，按缺失处理', { file: path.basename(key), code: err.code });
            }
            return null;
        }
    }

    async function read(key) {
        try {
            return await fsp.readFile(abs(key), 'utf8');
        } catch (err) {
            if (err && err.code !== 'ENOENT') {
                logger.warn('状态文件读取失败，按缺失处理', { file: path.basename(key), code: err.code });
            }
            return null;
        }
    }

    function writeSync(key, text) {
        const file = abs(key);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // 原子写：先落临时文件再 rename，避免读到半截内容。
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, file);
    }

    async function write(key, text) {
        const file = abs(key);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        await fsp.writeFile(tmp, text);
        await fsp.rename(tmp, file);
    }

    function removeSync(key) {
        try {
            fs.unlinkSync(abs(key));
            return true;
        } catch (err) {
            if (err && err.code !== 'ENOENT') {
                logger.warn('状态文件删除失败', { file: path.basename(key), code: err.code });
            }
            return false;
        }
    }

    async function remove(key) {
        try {
            await fsp.unlink(abs(key));
            return true;
        } catch (err) {
            if (err && err.code !== 'ENOENT') {
                logger.warn('状态文件删除失败', { file: path.basename(key), code: err.code });
            }
            return false;
        }
    }

    // 列举某前缀下的文件名（不含目录层级），按名字倒序（新→旧）。
    function listSync(prefix) {
        try {
            return fs.readdirSync(abs(prefix))
                .sort()
                .reverse();
        } catch (err) {
            if (err && err.code !== 'ENOENT') {
                logger.warn('目录列举失败，按空处理', { dir: prefix, code: err.code });
            }
            return [];
        }
    }

    async function list(prefix) {
        try {
            const files = await fsp.readdir(abs(prefix));
            return files.sort().reverse();
        } catch (err) {
            if (err && err.code !== 'ENOENT') {
                logger.warn('目录列举失败，按空处理', { dir: prefix, code: err.code });
            }
            return [];
        }
    }

    // 单个文件的修改时间（毫秒）。取不到返回 0，供归档清理判定"是否过期"。
    function mtimeSync(key) {
        try {
            return fs.statSync(abs(key)).mtimeMs;
        } catch (_) {
            return 0;
        }
    }

    async function mtime(key) {
        try {
            return (await fsp.stat(abs(key))).mtimeMs;
        } catch (_) {
            return 0;
        }
    }

    // 真实创建目录（幂等）。写入时也会按需建父目录，这里单独暴露是为了
    // 让启动阶段就能确定"目录已就位"，便于排查权限类问题。
    function ensureDir(prefix) {
        fs.mkdirSync(abs(prefix), { recursive: true });
    }

    return {
        name: 'fs',
        readSync, read, writeSync, write,
        removeSync, remove, listSync, list,
        mtimeSync, mtime, ensureDir,
    };
}

// ====================================================================
// 驱动二：进程内存
//
// 用于只读文件系统（Serverless / 边缘运行时）。数据存在一个 Map 里，
// 不做任何磁盘 IO。进程重启即丢——这是该模式的**固有语义**，
// 不是缺陷：短生命周期实例本就无需跨重启持久化。
//
// 由于 Map 操作天然同步，异步接口直接复用同步实现（返回已 resolve
// 的 Promise），从而与 fs 驱动的对外行为保持一致。
// ====================================================================

function createMemoryDriver() {
    // key -> { text, mtimeMs }
    const table = new Map();
    // 已"创建"的目录前缀集合。memory 驱动不需要真实目录，但保留
    // 这一层是为了让 ensureDirs 语义可见（便于诊断日志的一致性）。
    const dirs = new Set();

    function ensureDir(prefix) {
        dirs.add(prefix);
    }

    function readSync(key) {
        const cell = table.get(key);
        return cell === undefined ? null : cell.text;
    }

    function writeSync(key, text) {
        // 整体替换引用：写入过程对读取方不可见，等价于 fs 的原子 rename。
        table.set(key, { text, mtimeMs: Date.now() });
        // 补齐父目录记录，让"目录已存在"这一状态可查询。
        let p = path.posix.dirname(key);
        while (p && p !== '.' && p !== '/') {
            dirs.add(p);
            p = path.posix.dirname(p);
        }
    }

    function removeSync(key) {
        return table.delete(key);
    }

    function listSync(prefix) {
        const head = prefix.endsWith('/') ? prefix : prefix + '/';
        const out = [];
        for (const key of table.keys()) {
            if (key.startsWith(head)) {
                const rest = key.slice(head.length);
                // 只返回直接子项（与 fs.readdir 语义一致，不含子目录层级）
                if (rest && !rest.includes('/')) out.push(rest);
            }
        }
        return out.sort().reverse();
    }

    function mtimeSync(key) {
        const cell = table.get(key);
        return cell === undefined ? 0 : cell.mtimeMs;
    }

    // 目录前缀集合（诊断用）：是否已登记该目录
    function hasDir(prefix) {
        return dirs.has(prefix);
    }

    return {
        name: 'memory',
        readSync, writeSync, removeSync, listSync, mtimeSync,
        // Map 操作是同步的，异步门面直接包一层，行为与 fs 驱动对齐
        read: async (key) => readSync(key),
        write: async (key, text) => writeSync(key, text),
        remove: async (key) => removeSync(key),
        list: async (prefix) => listSync(prefix),
        mtime: async (key) => mtimeSync(key),
        ensureDir, hasDir,
    };
}

// ====================================================================
// 驱动选择：按运行期配置实例化
// ====================================================================

function createDriver(driverName, rootDir) {
    if (driverName === 'memory') return createMemoryDriver();
    // 默认与兜底都是 fs；非法取值已在 config 校验阶段拦截，
    // 走到这里说明取值合法或未配置。
    return createFsDriver(rootDir);
}

module.exports = { createDriver, createFsDriver, createMemoryDriver };
