# ============================================================================
# 库存实时同步服务 —— 容器镜像定义
#
# 构建:
#   docker build -t inventory-sync:2.13.1 .
#
# 运行:
#   docker run -d --name inventory-sync \
#     -p 3000:3000 \
#     -e UUID=<租户令牌> \
#     -v /var/lib/inventory-sync:/app/data \
#     inventory-sync:2.13.1
#
# 说明:
#   运行时不依赖任何 npm 包，因此不需要 npm install，也不需要 node_modules。
#   通道引擎内置于 vendor/sync-engine/；本机加速件（源码 + 预编译产物）
#   随项目分发在 vendor/native-accel/，构建期无需编译、无需联网拉取。
#
#   关于基础镜像为什么是 Debian 系（slim）而不是 alpine：
#     预编译产物当前只覆盖 darwin-{arm64,x64}、linux-x64(glibc)、
#     win32-{ia32,x64}。alpine 用 musl，加载 glibc 的 .node 必然失败，
#     会静默回退便携实现——功能等价但性能较低，且与"已启用加速"的
#     预期不符。选 node:22-slim（Debian/glibc）才能在 x86_64 上真正
#     命中 linux-x64 产物。arm64 主机目前没有对应产物，仍会回退。
#     是否加速生效会打在启动日志里（native / portable），可直接核对。
#     想把它变成硬要求，改 lib/defaults.js 的 REQUIRE_NATIVE_ACCEL 为
#     true：加载失败即拒绝启动，避免静默降级。
#
#   本文件只保留部署必需的构建步骤：复制运行文件、设定运行身份与探针。
#   不含任何测试、代码检查或本地调试指令。
#
# 运行期只需要 UUID 一个变量（其余全部有默认值，详见 .env.example）：
#   · 存储驱动与进程编排由**运行形态**推导，不由环境变量决定——容器是
#     常驻形态，因此恒为 fs 驱动 + fork 四子进程；数据目录恒为
#     /app/data（下面的 -v 挂载点即它）。
#   · 其余参数已固化为 lib/defaults.js 里的常量，不再接受 -e 覆盖。
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 阶段 1:准备运行产物
#   本服务无 npm 依赖、无编译步骤，此阶段只做文件归集，供下阶段按需复制。
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json ./
COPY supervisor.js ./
COPY lib/ ./lib/
COPY vendor/ ./vendor/

# ---------------------------------------------------------------------------
# 阶段 2:运行时
#   只保留运行所需文件。不带包管理器、不带测试与工具链，
#   减少镜像体积与攻击面。
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

# 以非 root 用户运行。UID/GID 固定，便于挂载卷时对齐属主。
# 用 groupadd/useradd（Debian/shadow 语义）而非 alpine 的 addgroup/adduser -S。
RUN set -eux; \
    groupadd -g 10001 app; \
    useradd  -u 10001 -g app -M -s /usr/sbin/nologin app

WORKDIR /app

# DATA_DIR 不再写入此处：它恒为 /app/data（由 lib/config.js 按 __dirname
# 推导），与上面的 -v 挂载点一致。STORAGE_DRIVER / SINGLE_PROCESS 同理，
# 已由运行形态推导，写成 ENV 只会让人误以为还能用 -e 覆盖。
ENV NODE_ENV=production \
    PORT=3000
# 说明：不设置 SERVICE_VERSION 环境变量——版本号单一来源是 package.json
# 的 version 字段（lib/config.js 直接读取），容器内已 COPY 该文件。

# 仅复制运行期真正需要的产物
#   无 node_modules：原生加速件（源码 + 预编译产物）已随
#   vendor/native-accel/ 分发，运行期按平台探测加载，缺失则回退便携实现
COPY --from=builder --chown=app:app /app/package.json      ./
COPY --from=builder --chown=app:app /app/supervisor.js      ./
COPY --from=builder --chown=app:app /app/lib/              ./lib/
COPY --from=builder --chown=app:app /app/vendor/           ./vendor/

# 数据目录：报表归档与库存快照落盘位置，供外部挂载持久化
RUN set -eux; \
    mkdir -p /app/data; \
    chown -R app:app /app/data

USER app

# 对外业务端口
EXPOSE 3000
# 内部进程间事件总线端口。仅绑定回环地址，容器外不可达，
# 此处声明仅用于说明端口用途，无需在运行时映射。
EXPOSE 3001

# 存活探针：命中网关的 /health 端点
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# 由主进程拉起并守护各业务子进程
CMD ["node", "supervisor.js"]
