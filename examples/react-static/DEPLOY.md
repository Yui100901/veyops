# React 静态站点部署

示例使用 React 19 和 Vite 7，依赖版本由 `package-lock.json` 固定。Vite 生成的站点位于 `dist/public`，其余产物文件用于通过 VeyOps 启动静态服务器和验证发布。验收页面包含「VeyOps React 发布成功」，静态服务器监听回环地址。

在测试仓库中将此示例提交到 `test` 分支，选择该分支的完整 Commit SHA，在 VeyOps 中为 React 服务配置 Testing 环境和隔离的 Linux 部署目标。可另建 `staging` 分支与 Staging 环境，使用独立发布目录和端口。独立建仓时把本目录内容放到仓库根。

在项目执行图为该服务创建构建流与部署流，按配置填写两个开始节点，或采用构建并部署流。

| 交付配置        | Testing 配置                                                          |
| -------------------- | --------------------------------------------------------------------- |
| `repoPath`           | 完整仓库使用 `examples/react-static`，独立仓库使用 `.`                |
| `buildLocation`      | `MANAGER` 或 `TARGET`                                                 |
| `buildImage`         | 管理端使用含 Git、Node.js 22.12+ 和 npm 的镜像，如 `node:22-bookworm` |
| `artifactType`       | `FILE`                                                                |
| `installCommand`     | `npm ci --include=dev --no-audit --no-fund --cache /tmp/npm`          |
| `buildCommand`       | `npm run build`                                                       |
| `outputPath`         | `dist`                                                                |
| `deployPath`         | `/tmp/veyops-react-testing`                                           |
| `startCommand`       | `sh ./start.sh`                                                       |
| `healthCheckCommand` | `sh ./health.sh`                                                      |
| 环境变量             | `PORT=38851`，可用 `VEYOPS_NODE` 指定目标机的 Node.js 可执行文件      |

管理端需要可访问 Git 仓库和 npm Registry 的隔离 Docker 构建环境。目标端构建时，SSH 用户需要能运行 Git、Node.js 22.12+ 和 npm 并访问两个依赖来源。目标机运行产物需要 Linux、Node.js 22.12+、`nohup`、可访问的 `/proc` 和发布目录的写权限。

部署完成后，在目标机访问 `http://127.0.0.1:38851/`。浏览器应显示示例文本，`/healthz` 应返回 `status=ok`、`framework=react` 和当前发布目录的标识。在项目交付记录中核对产物的完整 Git SHA 和 SHA-256。先运行构建流可在部署前下载归档，检查 `public/index.html` 和 `public/assets`。

在目标机使用同一 SSH 用户停止测试实例。

```sh
cd /tmp/veyops-react-testing/current
sh ./stop.sh
```

依赖下载失败时检查构建端的 Registry 连通性和 npm 日志。端口占用时查看发布任务日志与 `/tmp/veyops-react-testing/.react-fixture/server.log`，为该环境选择空闲端口。命令找不到 `node` 时，核对 SSH 非交互会话的 PATH，或配置 `VEYOPS_NODE`。
