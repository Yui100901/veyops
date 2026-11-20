# NestJS HTTP 服务部署

示例使用 NestJS 11 和 TypeScript。构建通过 npm 锁文件编译服务，在 `dist` 安装生产依赖，并禁用 npm 的可执行文件链接以便生成普通文件归档。部署后由 Node.js 直接启动 NestJS 服务，无需在目标机下载 npm 依赖。

在测试仓库中将此示例提交到 `staging` 分支，选择该分支的完整 Commit SHA，在 VeyOps 中为 NestJS 服务配置 Staging 环境和隔离的 Linux 部署目标。可另建 `test` 分支与 Testing 环境，使用独立发布目录和端口。独立建仓时把本目录内容放到仓库根。

在项目执行图为该服务创建构建流与部署流，按配置填写两个开始节点，或采用构建并部署流。

| 交付配置        | Staging 配置                                                          |
| -------------------- | --------------------------------------------------------------------- |
| `repoPath`           | 完整仓库使用 `examples/nestjs-http`，独立仓库使用 `.`                 |
| `buildLocation`      | `TARGET` 或 `MANAGER`                                                 |
| `buildImage`         | 管理端使用含 Git、Node.js 22.12+ 和 npm 的镜像，如 `node:22-bookworm` |
| `artifactType`       | `FILE`                                                                |
| `installCommand`     | `npm ci --include=dev --no-audit --no-fund --cache /tmp/npm`          |
| `buildCommand`       | `npm run build`                                                       |
| `outputPath`         | `dist`                                                                |
| `deployPath`         | `/tmp/veyops-nestjs-staging`                                          |
| `startCommand`       | `sh ./start.sh`                                                       |
| `healthCheckCommand` | `sh ./health.sh`                                                      |
| 环境变量             | `PORT=38852`，可用 `VEYOPS_NODE` 指定目标机的 Node.js 可执行文件      |

目标端构建时，SSH 用户需要能运行 Git、Node.js 22.12+ 和 npm，并访问 Git 仓库和 npm Registry。管理端构建时，隔离 Docker 构建环境需要相同的工具和网络。目标机运行产物需要 Linux、Node.js 22.12+、`nohup`、可访问的 `/proc` 和发布目录的写权限。

部署完成后，在目标机访问 `http://127.0.0.1:38852/`，返回 JSON 中的 `message` 应为「VeyOps NestJS 发布成功」。`/healthz` 应返回 `status=ok`、`framework=nestjs` 和当前发布目录的标识。在项目交付记录中核对产物的完整 Git SHA 和 SHA-256。先运行构建流可在部署前下载归档，检查 `server.cjs` 和 `node_modules/@nestjs/core`。

在目标机使用同一 SSH 用户停止测试实例。

```sh
cd /tmp/veyops-nestjs-staging/current
sh ./stop.sh
```

构建期依赖下载失败时检查 npm Registry 连通性。若运行报缺少 NestJS 模块，核对生产依赖已打入归档。端口占用时查看发布任务日志与 `/tmp/veyops-nestjs-staging/.nestjs-fixture/server.log`，为该环境选择空闲端口。
