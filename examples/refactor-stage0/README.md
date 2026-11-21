# 阶段 0 演示定义

[project.yaml](project.yaml) 描述新库演示项目「星桥商城」、资源及七个开始节点。主机、仓库和访问地址均使用 `.invalid` 占位域名。凭据只声明用途及引用 ID。阶段 1 至 5 接通初始化器和各执行模块后，使用授权的演示资源映射这些占位项。

## 三条主路径

| 主路径 | 起点与操作 | 结果与定位 |
| --- | --- | --- |
| 服务卡片 | 进入「项目资源 → 服务 → 商城网关」。打开「联调前端」、复制「使用说明」，再展开三个完整地址。 | 按 `web-test`、`web-production`、`web-manual` 的定义顺序展示。改名和改地址沿用相同地址 ID。同一次服务保存使用同一服务修订。 |
| 开始节点选变量并执行 | 从商城网关或执行图打开 `target-files`，先选 `test-config`，另一次只换成 `production-config`。两个运行都使用 `web-repo` 的固定 SHA `5038e89acaeb008526d112afc3d68b812e2a10ff` 及 `web-test-group`。 | `load-files` 分别选 `.env.test` 与 `.env.prod`。`FILE_PROFILE` 来自文件，`LOG_LEVEL` 分别取集合的 `debug` 和 `warn`。`POSTGRES_URL` 显示掩码。目标均为 `test-a`、`test-b`。构建节点从实际 `checkout.commitSha` 注入 `GIT_SHA`。 |
| 产物同机复用 | 在 `target-files` 产出的 `build-files.webDirectory` 记录中选择实际 `artifactId`，打开 `deploy-existing`，填入 `{artifactId}`。保留独立的 `releaseTargets` 为联调 Web 组。 | 预览分别固定 `test-a`、`test-b` 上的目录实例及摘要。运行前重新验证实例。部署结束返回商城网关的 `ServiceResult`，可按记录跳到消费目标、原件及生产节点。 |

## 七个执行入口

| 流 ID | 变量集合 | 实际操作 |
| --- | --- | --- |
| `manager-build` | 固定联调配置 | 管理端构建文件和目录。开始参数只需服务及可选 Git 版本。 |
| `target-files` | 运行时选择 | 按联调组逐目标构建文件和目录。`runReport` 仅供本次运行及子流使用。 |
| `target-image` | 固定生产模拟配置 | 在生产模拟组的 Docker 主机分别构建和登记 Image ID。 |
| `build-and-deploy` | 固定联调配置 | 明确区分 `buildTargets`、`releaseTargets`。复用构建节点与文件部署节点，部署消费 `webDirectory`。 |
| `deploy-existing` | 无引用 | 选用已登记目录，通过同一部署节点在匹配主机发布。 |
| `deploy-compose` | 固定生产模拟配置 | 选用与主机相符的已登记镜像，Compose 模板读取同一固定提交的 `compose.yaml`。 |
| `rollback-existing` | 固定联调配置 | 在同一服务、目标和目的地已有两次发布后，选择较早发布使用的目录并执行图内回滚，逐目标返回回滚关系。 |

## 初始化器映射

- 资源 ID 是演示别名。后续初始化器将它们解析成 API 返回的实体 ID。图中节点 ID、开始节点 ID 和字段 ID 保留，用于产物生产来源和定位。单个流的 ID 与开始节点 ID 相同。
- `path` 是该流从开始到结束的有序功能节点简写，初始化器将其展开成控制边。`bindings` 按节点 ID 与端口 ID 对应 `inputBindings`，`environment` 对应节点进程注入，结束节点的 `source` 对应该流的最终输出绑定。模块的端口目录按指定版本解析。构建输出声明的 `type` 指实物 `kind`，端口值统一使用 `ARTIFACT` 引用。`copy-static-site` 和 `docker-image` 是演示动作名，由初始化器映射为相应的模块执行配置。
- `load-files.configuration` 对应 `LOAD_ENV.loadEnvironment`。当前图 API 用 `envFile` 表示单一路径，映射直接使用 `pathRule`。
- `copy-static-site` 将仓库中的 `index.html` 复制到工作区的 `dist/index.html`。目标构建另生成声明为临时输出的 `reports/summary.json`，内容只记录实际 Git SHA 和非敏感的 `FILE_PROFILE`。`docker-image` 以工作区中的 `Dockerfile` 构建镜像并记录实际 Image ID。初始化器需映射访问地址，并在专用联调目标上为文件发布目录准备静态站点入口。
- `sourceSnapshot.files` 按 UTF-8 与 LF 写入同一个无父提交的 Git 快照，文件模式均为 `100644`。使用 YAML 中的作者、提交者、UTC 偏移、时间戳及提交说明，说明以换行结尾。以 Git SHA-1 对象格式生成提交，固定 SHA 为 `5038e89acaeb008526d112afc3d68b812e2a10ff`。各构建开始参数默认引用此提交。
- `reuseExamples` 指向应从实际运行结果读取的产物 ID。构建完成后使用返回的 `artifactId`，验证具体物理实例，再提交历史部署或回滚参数。产物位置、大小、摘要和镜像 ID 由执行模块记录。

初始化器的接口和安全边界见 [阶段 0 契约](../../docs/阶段0-重构契约与演示.md)。
