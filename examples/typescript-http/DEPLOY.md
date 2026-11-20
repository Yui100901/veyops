# TypeScript 服务部署

这个示例将 TypeScript 编译成 Node.js 服务。运行时使用 `node:http`，产物不依赖 `node_modules`。同一份源代码可放到 `test` 与 `staging` 两个分支，分别通过 npm 和 pnpm 构建，并在同一台目标机运行。

## 准备仓库和环境

在测试 Git 仓库中准备 `test` 和 `staging` 分支，每个分支提交本目录全部文件。两份锁文件可以同时存在。若将示例单独建仓，仓库根目录应直接包含 `package.json`、`tsconfig.json`、`src/`、`scripts/`、`copy-scripts.cjs` 及锁文件。若两个分支保留完整 veyops 仓库结构，则使用 `repoPath=examples/typescript-http`。

在 veyops 项目下关联该仓库和同一个 TypeScript 服务，建立 Testing 和 Staging 环境。两个环境可以使用同一个部署目标，发布目录和环境变量须按下表分别设置。为两个分支分别创建开始节点和对应执行流，将它们关联到同一服务，分别保留 npm 与 pnpm 的构建配置。

| 配置                 | 测试                                                         | 预发布                                                                |
| -------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| Git 分支             | `test`                                                       | `staging`                                                             |
| veyops 环境          | `Testing`                                                    | `Staging`                                                             |
| 环境变量             | `VEYOPS_DEMO_ENV=test`                                       | `VEYOPS_DEMO_ENV=staging`                                             |
| 构建位置             | `MANAGER`                                                    | `MANAGER`                                                             |
| 产物类型             | `FILE`                                                       | `FILE`                                                                |
| 构建镜像             | `node:22`                                                    | `node:22`（含 Corepack）                                              |
| `repoPath`           | `.`（独立仓库）或 `examples/typescript-http`                 | 同左                                                                  |
| `installCommand`     | `npm ci --include=dev --no-audit --no-fund --cache /tmp/npm` | `corepack pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store` |
| `buildCommand`       | `npm run build`                                              | `corepack pnpm run build`                                             |
| `outputPath`         | `dist`                                                       | `dist`                                                                |
| `deployPath`         | `/tmp/veyops-typescript-test-demo`                           | `/tmp/veyops-typescript-staging-demo`                                 |
| `startCommand`       | `sh ./start.sh`                                              | `sh ./start.sh`                                                       |
| `healthCheckCommand` | `sh ./health.sh`                                             | `sh ./health.sh`                                                      |
| 健康接口             | `http://127.0.0.1:38781/healthz`                             | `http://127.0.0.1:38782/healthz`                                      |

管理端需配置本机可用的隔离 Docker 构建环境。构建容器需要访问 Git HTTP(S) 仓库和 npm Registry。仓库私有时通过凭据中心关联 Git 凭据。pnpm 由 `package.json` 固定为 `10.20.0`，Corepack 首次运行会下载它。在平台的只读构建容器内，Corepack 默认使用 `HOME=/tmp` 下的缓存，pnpm 的存储目录也设置在 `/tmp`。不需要在容器里执行 `corepack enable`。

Testing 和 Staging 都支持 `TARGET`。每个目标需要 Git、Node.js 22.12+ 和 npm，Staging 还需要 Corepack 来运行固定版本的 pnpm。将 Node.js 工具目录加入安装和构建命令的 `PATH`，确认每个目标能访问 Git 仓库和依赖源。若目标的用户级 npm 配置指向不可用代理，可以为该任务指定独立的 `NPM_CONFIG_USERCONFIG`、`NPM_CONFIG_GLOBALCONFIG` 和 `NPM_CONFIG_REGISTRY`。两个配置文件路径应不同。

目标机使用 Linux，SSH 用户需要独占的发布目录、`nohup` 和 Node.js 22.12 或更新版本。若非交互 SSH 会话找不到 `node`，在两个环境中设置 `VEYOPS_NODE` 为目标机上 Node 的绝对路径。发布前确认 `38781`、`38782` 未被占用。首次运行的发布目录应为空或尚未创建。

## 运行并核对产物

1. 在仓库详情切换到相应分支，复制该分支上待验证的完整 Git SHA。
2. 在构建流的开始节点设置待验证的 Git SHA，核对构建位置。运行时选择匹配的环境和目标，验证安装和编译。
3. 下载 `dist` 对应的 tar.gz 产物，用 `sha256sum <文件名>` 对照产物页面的 SHA-256。归档包含 `server.js`、`start.sh`、`stop.sh`、`health.sh`。
4. 在同一服务的部署流选择上一步构建，也可把同一 Git SHA 填入构建并部署流。`TARGET` 在各目标检出和构建，`MANAGER` 在管理端构建并通过 SFTP 分发归档。两种方式都记录各目标的启动与健康检查。要预先核对目标端的产物，在 `TARGET` 模式先运行构建流。
5. 在目标机核对两个端口，并确认 `packageManager` 分别为 `npm`、`pnpm`，`instance` 与各自发布任务 ID 一致。

```sh
curl -fsS http://127.0.0.1:38781/healthz
curl -fsS http://127.0.0.1:38782/healthz
```

## 查看日志与停止示例

示例进程仅监听回环地址。启动脚本把标准输出和错误写到 `<deployPath>/.typescript-<环境>/server.log`。脚本会校验 PID、进程用户和该目录下的入口文件，更新或停止时只处理自己记录的进程。健康检查还会匹配当前发布 ID，避免把旧进程误判为本次发布已就绪。

在目标机用部署所用的 SSH 用户执行以下命令。若调整过发布路径，将路径替换为实际值。

```sh
cd /tmp/veyops-typescript-test-demo/current
VEYOPS_DEMO_ENV=test sh ./stop.sh

cd /tmp/veyops-typescript-staging-demo/current
VEYOPS_DEMO_ENV=staging sh ./stop.sh
```

这是部署验证用的进程启动方式。需要开机启动、自动重启和日志轮转时，可将启动与停止交给目标机上的专用进程管理器。
