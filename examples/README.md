# 执行流交付示例

Go、Java、Rust、Python 示例使用各自语言的标准库，可在无需下载应用依赖的情况下生成可独立部署的文件产物。示例监听 `127.0.0.1`，默认端口为 `8080`，可通过 `PORT` 更改。`GET /healthz` 返回包含 `status` 和 `language` 的 JSON。

在项目执行图中为示例服务创建构建流，将示例目录设为构建配置的 `repoPath`，并选择分支或固定提交。下表的构建命令适用于 Linux，`outputPath` 相对于示例目录。然后为同一服务创建部署流，使用当前环境下最新可用产物或选择某次构建。平台在产物解包后的发布目录内执行启动命令。[执行流交付指南](../docs/执行流交付.md)

| 目录 | 构建环境 | `buildCommand` | `outputPath` | 启动命令 |
| --- | --- | --- | --- | --- |
| [`go-http`](go-http) | Go 1.18+ | `mkdir -p dist && GOMAXPROCS=2 CGO_ENABLED=0 go build -p 2 -trimpath -o dist/veyops-go .` | `dist/veyops-go` | `./veyops-go` |
| [`java-http`](java-http) | JDK 17+ | `mkdir -p dist build/classes && javac --release 17 -d build/classes src/main/java/HealthServer.java && jar --create --file dist/veyops-java.jar --main-class HealthServer -C build/classes .` | `dist/veyops-java.jar` | `java -jar veyops-java.jar` |
| [`rust-http`](rust-http) | Rust 1.58+，本机链接器 | `mkdir -p dist && rustc --edition=2021 -O src/main.rs -o dist/veyops-rust` | `dist/veyops-rust` | `./veyops-rust` |
| [`python-http`](python-http) | Python 3.8+ | `mkdir -p dist && python3 -m zipapp app -o dist/veyops-python.pyz` | `dist/veyops-python.pyz` | `python3 veyops-python.pyz` |

Go 和 Rust 产物需要匹配目标主机的操作系统与架构。Rust 还需要兼容目标主机的 C 运行库。Java 目标主机需要 Java 17+，Python 目标主机需要 Python 3.8+。Rust 示例也可以在本地执行 `cargo build --offline --locked --release`。

各语言的分支、环境、构建、启动与健康检查见 [Go](go-http/DEPLOY.md)、[Java](java-http/DEPLOY.md)、[Rust](rust-http/DEPLOY.md) 和 [Python](python-http/DEPLOY.md) 部署指南。

启动命令会以前台进程运行。手工验证时，在另一个终端执行 `curl -fsS http://127.0.0.1:8080/healthz`，完成后停止示例进程。配置部署流时，可把启动交给已有的进程管理器，再将该 `curl` 命令用作健康检查。静态文件与 Docker Compose 示例见 [`static-site`](static-site)。

[`typescript-http`](typescript-http) 使用 npm 与 pnpm 的锁文件验证 Node.js 应用构建。`test` 分支部署到 Testing 环境的回环端口 `38781`，`staging` 分支部署到 Staging 环境的回环端口 `38782`。两个环境分别保存发布目录和进程状态。管理端构建、SFTP 分发、健康检查与清理命令见 [TypeScript 部署指南](typescript-http/DEPLOY.md)。

[React 静态站点](react-static/DEPLOY.md) 使用 Vite 构建静态 HTML、JavaScript 和 CSS，验收脚本检查实际发布的页面和资源。[NestJS 服务](nestjs-http/DEPLOY.md) 使用 TypeScript 编译并打包生产依赖，验收脚本检查 HTTP 路由和当前发布实例。两个项目均可独立建仓，支持管理端或目标端构建。

[TLS 鉴权镜像发布示例](docker-auth/DEPLOY.md) 用于验证管理端和目标端构建镜像、鉴权推拉以及按 Digest 发布到 Compose。
