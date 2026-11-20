# Go HTTP 示例部署

示例使用 Go 标准库，`GET /healthz` 返回 `{"status":"ok","language":"go"}`。服务监听目标机回环地址，`PORT` 默认为 `8080`。

## 仓库、环境和构建

将示例加入测试 Git 仓库。仓库保留完整项目结构时设置 `repoPath=examples/go-http`，单独建仓时设置 `repoPath=.`。以下是两套可选验收配置。分支需先在测试仓库创建，发布时为每个分支选择完整提交 SHA。

| 配置                        | Testing                       | Staging                          |
| --------------------------- | ----------------------------- | -------------------------------- |
| 建议分支                    | `test`                        | `staging`                        |
| 构建位置                    | `MANAGER`                     | `TARGET`                         |
| `deployPath`                | `/tmp/veyops-demo-go-test`    | `/tmp/veyops-demo-go-staging`    |
| 环境变量 `PORT`             | `38771`                       | `38791`                          |
| 环境变量 `VEYOPS_DEMO_UNIT` | `veyops-demo-go-test.service` | `veyops-demo-go-staging.service` |

两套配置均使用 `artifactType=FILE`、空的 `installCommand` 和 `outputPath=dist/veyops-go`。`Testing` 的管理端构建可使用 `buildImage=golang:1.24.1-alpine`，镜像应在构建宿主机可用。目标端构建需在 SSH 会话的 `PATH` 上提供 Go 1.18 或更新版本。两种方式都使用以下 Linux 构建命令。

```sh
mkdir -p dist && GOMAXPROCS=2 CGO_ENABLED=0 go build -p 2 -trimpath -o dist/veyops-go .
```

Go 产物以 `CGO_ENABLED=0` 构建，按构建环境的操作系统及 CPU 架构生成。管理端 Docker 构建时，选用与目标机架构一致的 Linux 镜像。目标机运行已构建产物只需要 Linux，无需安装 Go。若报告 `Exec format error`，核对构建机和目标机的 CPU 架构。

## 发布与健康检查

在 Linux 测试机为每套配置预留发布目录、端口和 临时 systemd 单元名称。首次发布目录应为空或尚未创建。以下命令要求目标机有 `systemd-run` 和 `curl`，并且部署所用的 SSH 用户有权限启动指定测试单元。在发布前用 `ss -ltn` 检查端口，用 `systemctl status` 核对指定单元名可用于此测试。如有占用，修改环境配置里的端口和单元名。

将以下命令填入部署配置的 `startCommand`。平台在新产物目录内执行它，并传入所选环境的变量。

```sh
systemd-run --quiet --unit="$VEYOPS_DEMO_UNIT" --property=WorkingDirectory="$PWD" --setenv="PORT=$PORT" "$PWD/veyops-go"
```

将以下命令填入 `healthCheckCommand`，同时检查专用单元和本次示例的响应。

```sh
for i in $(seq 1 20); do
  if systemctl is-active --quiet "$VEYOPS_DEMO_UNIT" &&
     curl -fsS --max-time 1 "http://127.0.0.1:$PORT/healthz" 2>/dev/null |
       grep -Fxq '{"status":"ok","language":"go"}'; then
    exit 0
  fi
  sleep 1
done
exit 1
```

1. 运行该服务的构建流，选择相应环境和目标，并核对完整 Git SHA。在项目交付记录中下载 `.tar.gz`，用 `sha256sum` 对照记录中的 SHA-256。运行同一服务的部署流时，选择该次构建并核对目标和发布目录。
2. 用同一 SHA 执行「构建并部署」，在任务详情查看构建、分发及逐目标健康状态。产物是单个文件，发布后可在 `<deployPath>/current/veyops-go` 找到它。可在目标机对 `<deployPath>/.artifacts/<task-id>.tar.gz` 计算 SHA-256，与部署任务的产物记录核对。
3. 在目标机访问所选端口的 `/healthz`，核对语言和状态。部署失败时先看任务失败步骤，再查专用单元日志。若 `curl` 返回 404，核对请求路径是否为 `/healthz`。

## 日志和清理

测试结束后，在目标机核对所用单元的 `WorkingDirectory` 对应本次发布目录，再停止该单元。以下以 Testing 为例。

```sh
systemctl show --property=WorkingDirectory veyops-demo-go-test.service
journalctl --unit=veyops-demo-go-test.service --no-pager -n 50
systemctl stop veyops-demo-go-test.service
```

需要在相同环境重跑时，先完成同一项检查和停止操作。使用其他环境时，替换为该环境配置的测试单元名。可保留发布目录以核对任务记录。
