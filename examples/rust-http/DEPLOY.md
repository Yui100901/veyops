# Rust HTTP 示例部署

示例使用 Rust 标准库，`GET /healthz` 返回 `{"status":"ok","language":"rust"}`。服务监听目标机回环地址，`PORT` 默认为 `8080`。

## 仓库、环境和构建

将示例加入测试 Git 仓库。仓库保留完整项目结构时设置 `repoPath=examples/rust-http`，单独建仓时设置 `repoPath=.`。以下是两套可选验收配置。分支需先在测试仓库创建，发布时为每个分支选择完整提交 SHA。

| 配置                        | Testing                         | Staging                            |
| --------------------------- | ------------------------------- | ---------------------------------- |
| 建议分支                    | `test`                          | `staging`                          |
| 构建位置                    | `MANAGER`                       | `TARGET`                           |
| `deployPath`                | `/tmp/veyops-demo-rust-test`    | `/tmp/veyops-demo-rust-staging`    |
| 环境变量 `PORT`             | `38773`                         | `38793`                            |
| 环境变量 `VEYOPS_DEMO_UNIT` | `veyops-demo-rust-test.service` | `veyops-demo-rust-staging.service` |

两套配置均使用 `artifactType=FILE`、空的 `installCommand` 和 `outputPath=dist/veyops-rust`。`Testing` 的管理端构建可使用 `buildImage=rust:1.88-bookworm`，镜像应在构建宿主机可用。目标端构建需在 SSH 会话的 `PATH` 上提供 Rust 1.58 或更新版本和本机 C 链接工具链。两种方式都使用以下 Linux 构建命令。

```sh
mkdir -p dist && rustc --edition=2021 -O src/main.rs -o dist/veyops-rust
```

Rust 产物须与目标机架构及 C 运行库兼容。上表的管理端镜像以 Debian Bookworm 为基础。目标机运行二进制不需要 Rust 工具链。若报告 `GLIBC_* not found`，选用与目标机兼容的构建镜像，或改用目标端构建。

也可用 Cargo 1.58 或更新版本离线构建。将构建命令改为 `cargo build --offline --locked --release`，并将产物路径改为 `target/release/veyops-rust`。两种构建方式的发布入口相同。

## 发布与健康检查

在 Linux 测试机为每套配置预留发布目录、端口和 临时 systemd 单元名称。首次发布目录应为空或尚未创建。以下命令要求目标机有 `systemd-run` 和 `curl`，并且部署所用的 SSH 用户有权限启动指定测试单元。在发布前用 `ss -ltn` 检查端口，用 `systemctl status` 核对指定单元名可用于此测试。如有占用，修改环境配置里的端口和单元名。

将以下命令填入 `startCommand`。Pipeline 会在新产物目录内执行它，变量由所选环境传入。

```sh
systemd-run --quiet --unit="$VEYOPS_DEMO_UNIT" --property=WorkingDirectory="$PWD" --setenv="PORT=$PORT" "$PWD/veyops-rust"
```

将以下命令填入 `healthCheckCommand`，同时检查专用单元和本次示例的响应。

```sh
for i in $(seq 1 20); do
  if systemctl is-active --quiet "$VEYOPS_DEMO_UNIT" &&
     curl -fsS --max-time 1 "http://127.0.0.1:$PORT/healthz" 2>/dev/null |
       grep -Fxq '{"status":"ok","language":"rust"}'; then
    exit 0
  fi
  sleep 1
done
exit 1
```

1. 在 Pipeline 选择对应环境、目标和版本，核对完整 Commit 及发布目录。使用「仅构建」时可在任务详情下载 `.tar.gz`，用 `sha256sum` 对照产物记录的 SHA-256。
2. 用同一 SHA 执行「构建并部署」，在任务详情查看构建、分发及逐目标健康状态。产物是单个文件，发布后可在 `<deployPath>/current/veyops-rust` 找到它。可在目标机对 `<deployPath>/.artifacts/<task-id>.tar.gz` 计算 SHA-256，与部署任务的产物记录核对。
3. 在目标机访问所选端口的 `/healthz`，核对语言和状态。部署失败时先看任务失败步骤，再查专用单元日志。若 `curl` 返回 404，核对请求路径是否为 `/healthz`。

## 日志和清理

测试结束后，在目标机核对所用单元的 `WorkingDirectory` 对应本次发布目录，再停止该单元。以下以 Testing 为例。

```sh
systemctl show --property=WorkingDirectory veyops-demo-rust-test.service
journalctl --unit=veyops-demo-rust-test.service --no-pager -n 50
systemctl stop veyops-demo-rust-test.service
```

需要在相同环境重跑时，先完成同一项检查和停止操作。使用其他环境时，替换为该环境配置的测试单元名。可保留发布目录以核对任务记录。
