# TLS 鉴权镜像发布示例

这个服务使用 Node.js 24 镜像。运行在 Linux Docker 主机上，仅监听回环地址。Testing 使用端口 38853，Staging 使用端口 38854。将示例放在两个测试分支中，分别配置环境、发布目录和固定 Git 提交。

| 交付配置     | Testing                      | Staging                      |
| ----------------- | ---------------------------- | ---------------------------- |
| 分支              | `docker-testing`             | `docker-staging`             |
| `repoPath`        | `examples/docker-auth`       | `examples/docker-auth`       |
| `buildLocation`   | `TARGET`                     | `MANAGER`                    |
| `artifactType`    | `DOCKER_IMAGE`               | `DOCKER_IMAGE`               |
| `dockerfilePath`  | `Dockerfile`                 | `Dockerfile`                 |
| `composeFilePath` | `compose.yaml`               | `compose.yaml`               |
| `deployPath`      | `/tmp/veyops-docker-testing` | `/tmp/veyops-docker-staging` |
| 环境变量          | `PORT=38853`                 | `PORT=38854`                 |

准备一个可用于测试的 HTTPS Registry。将登录信息保存为 `DOCKER_REGISTRY` 凭据，在系统中关联凭据并测试连接。在构建配置中选择 Registry，填写镜像仓库。使用同一服务的部署流选择对应镜像产物，也可以用构建并部署流直接交付。使用私有 CA 时，在平台和参与构建、拉取的 Docker 环境中配置信任。确认示例端口空闲后执行发布。

在目标机访问 `http://127.0.0.1:38853/healthz` 或 `http://127.0.0.1:38854/healthz`。应返回 `{"status":"ok","framework":"docker"}`。在产物记录中核对镜像标签、Registry 返回的 Digest 和实际运行容器的镜像。

使用任务记录中的 Compose 项目名以及对应发布目录中的 `current/compose.yaml` 和 `current/.env` 清理测试容器。多个环境分别执行清理。
