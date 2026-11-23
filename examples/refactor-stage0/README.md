# 阶段 0 演示定义

[project.yaml](project.yaml) 描述演示项目「星桥商城」。主机、仓库和访问地址使用 `.invalid` 占位域名，凭据只声明用途及引用 ID。初始化器使用实际演示资源替换这些引用，保持节点、字段和固定提交可追溯。也可以在画布通过预设手工搭建。

## 三条主路径

| 主路径 | 起点与操作 | 结果与定位 |
| --- | --- | --- |
| 服务卡片 | 进入「项目资源 → 服务 → 商城网关」。打开「联调前端」、复制「使用说明」，再展开三个完整地址。 | 按 `web-test`、`web-production`、`web-manual` 的定义顺序展示。改名和改地址沿用相同地址 ID。同一次服务保存使用同一服务修订。 |
| 开始节点选变量并执行 | 从商城网关或执行图打开 `target-files`，先选 `test-config`，另一次只换成 `production-config`。两个运行都使用 `web-repo` 的固定 SHA `5038e89acaeb008526d112afc3d68b812e2a10ff` 及 `web-test-group`。 | `load-files` 分别选 `.env.test` 与 `.env.prod`。`FILE_PROFILE` 来自文件，`LOG_LEVEL` 分别取集合的 `debug` 和 `warn`。`POSTGRES_URL` 显示掩码。目标均为 `test-a`、`test-b`。构建节点从实际 `checkout.commitSha` 注入 `GIT_SHA`。 |
| 产物同机复用 | 在 `target-files` 产出的 `build-files.webDirectory` 记录中选择实际 `artifactId`，打开 `deploy-existing`，填入 `{artifactId}`。保留独立的 `releaseTargets` 为联调 Web 组。 | 预览分别固定 `test-a`、`test-b` 上的目录实例及摘要。运行前重新验证实例。部署结束返回商城网关的 `ServiceResult`，可按记录跳到消费目标、原件及生产节点。 |

## 执行入口

| 流 ID | 变量集合 | 实际操作 |
| --- | --- | --- |
| `manager-build` | 固定联调配置 | 管理端构建文件和目录。开始参数只需服务及可选 Git 版本。 |
| `reviewed-build` | 固定联调配置 | 源码审核关联 `build-manager`，管理员在运行详情核对该构建的全部固定仓库及 SHA，并决定是否继续。 |
| `target-files` | 运行时选择 | 按联调组逐目标构建文件和目录。`runReport` 仅供本次运行及子流使用。 |
| `target-image` | 固定生产模拟配置 | 同一次目标端构建登记 `webDirectory` 和 `image`，分别返回目录摘要和实际 Image ID。 |
| `build-and-deploy` | 固定联调配置 | 区分 `buildTargets` 和 `releaseTargets`。构建成功后管理员核对 `webDirectory` 实例、服务和目标，再批准发布。 |
| `deploy-existing` | 无引用 | 选用已登记目录，通过同一部署节点在匹配主机发布。 |
| `deploy-compose` | 固定生产模拟配置 | 选用与主机相符的已登记镜像，Compose 模板读取同一固定提交的 `compose.yaml`。 |
| `build-and-deploy-compose` | 固定生产模拟配置 | 复用 `build-image` 和 `deploy-image`，发布节点取本次构建的镜像。结束节点返回发布结果、目录和镜像。 |
| `reviewed-target-bundle` | 固定生产模拟配置 | 核对实际源码 SHA 后复用 `build-image`，返回本次构建的目录和镜像。 |
| `shell-register` | 固定联调配置 | Shell 读取 `ARTIFACT_DIR` 生成目录，并通过自己的具名产物端口返回 `shellDirectory`。 |
| `deploy-latest-directory` | 无引用 | 省略产物参数后，按生产模拟组目标选择最新兼容目录，复用 `deploy-files`。 |
| `rollback-existing` | 固定联调配置 | 在同一服务、目标和目的地已有两次发布后，选择较早发布使用的目录并执行图内回滚，逐目标返回回滚关系。 |
| `health-rollback` | 固定联调配置 | 遇到演示候选页面时，探针显式返回 `10`，按条件选择历史目录回滚。在健康分支直接返回检查结果。 |

## 从画布预设运行文件交付示例

1. 在项目中登记一个含 `index.html` 的 Git 仓库、一个服务和一台专用演示服务器。服务器需要可执行 SSH 和写入演示发布目录，项目仓库需要可信的可用提交。
2. 在「仅构建」「审核并构建」或「构建并部署」预设中，将构建命令设为 `mkdir -p dist && cp index.html dist/index.html`，并登记目录 `dist`。有部署步骤时使用 `FILE`，将演示目录设为 `/srv/veyops-stage0/storefront`。目标端构建与部署选择同一演示服务器。
3. 发布图后，从各开始节点预览并运行。使用「仅部署」时选择已登记的产物。仅构建成功时可从产物详情返回生产节点。出现待审核或待审批时，管理员在运行详情核对实际来源与目标后决定。
4. 更改仓库文件并构建、发布第二版。使用「回滚」预设选择第一版的登记产物，并选择同一服务、目标及部署路径。回滚结果中的 `rollbackOfDeploymentId` 指向被替换的发布。

需要多仓构建时，可从「源码审核后构建」预设扩展。增加一个 Git 检出节点，分别绑定依赖仓库和完整 SHA，在构建节点添加依赖别名 `shared`，将 `dependency_shared` 绑定到这个检出的工作区。构建脚本可从 `$VEYOPS_GRAPH_DEPENDENCY_ROOT/shared` 读取依赖。若绑定了另一仓库的变量加载结果，也应先固定该仓库及提交。运行详情的审核范围会列出构建实际计划使用的全部仓库及 SHA。构建专用变量 `GIT_SHA` 仍从主仓检出的 `commitSha` 输出绑定。

## 初始化器映射

- 资源 ID 是演示别名。初始化器将它们解析成 API 返回的实体 ID。图中节点 ID、开始节点 ID 和字段 ID 保留，用于产物生产来源和定位。单个流的 ID 与开始节点 ID 相同。
- `path` 是该流从开始到结束的有序功能节点简写，初始化器将其展开成控制边。`bindings` 按节点 ID 与端口 ID 对应 `inputBindings`，`environment` 对应节点进程注入，结束节点的 `source` 对应该流的最终输出绑定。模块的端口目录按指定版本解析。构建输出声明的 `type` 指实物 `kind`，端口值统一使用 `ARTIFACT` 引用。初始化器将 `copy-static-site`、`docker-image` 和 `copy-static-and-image` 映射为构建模块配置。
- `approve-storefront.configuration` 对应 `APPROVAL.approval`，`review-source.configuration` 对应 `SOURCE_REVIEW.approval`，`SERVICE_RESULT` 对应实际 API 的 `RELEASE` 字段。将 `configuration.deployPath`、`method` 和 `composeSource` 放入发布节点的 `deploy`。
- `load-files.configuration` 对应 `LOAD_ENV.loadEnvironment`。当前图 API 用 `envFile` 表示单一路径，映射直接使用 `pathRule`。
- `copy-static-site` 将仓库中的 `index.html` 复制到工作区的 `dist/index.html`。目标构建另生成声明为临时输出的 `reports/summary.json`，内容只记录实际 Git SHA 和非敏感的 `FILE_PROFILE`。`docker-image` 以工作区中的 `Dockerfile` 构建镜像并记录实际 Image ID。`copy-static-and-image` 同时执行静态文件构建和 Docker 镜像构建，登记两个具名产物。初始化器需映射访问地址，并在专用联调目标上为文件发布目录准备静态站点入口。
- `shell-register` 的开始参数 `artifactDir` 默认为 `dist-shell`。它绑定到 Shell 的 `ARTIFACT_DIR`。该输入同时作为 `shellDirectory` 的路径来源，可在运行前指定工作区内的其他目录。
- `sourceSnapshot.files` 按 UTF-8 与 LF 写入同一个无父提交的 Git 快照，文件模式均为 `100644`。以 Git SHA-1 对象格式生成的固定提交为 `5038e89acaeb008526d112afc3d68b812e2a10ff`，各构建开始参数默认引用此提交。`nextSnapshot` 可重复生成替换版本，用于观察健康失败和回滚前后的真实页面变化。
- `reuseExamples` 指向应从实际运行结果读取的产物 ID。构建完成后使用返回的 `artifactId`，验证具体物理实例，再提交历史部署或回滚参数。产物位置、大小、摘要和镜像 ID 由执行模块记录。

初始化器的接口和安全边界见 [阶段 0 契约](../../docs/阶段0-重构契约与演示.md)。

## 导入专用演示实例

1. 在装有项目依赖的 checkout 运行 `node tools/acceptance/refactor-demo.cjs git <仓库目录>`，生成 `storefront.git` 及两个固定提交。把该裸仓库通过演示实例可访问的 HTTP Git 服务提供。Linux 脚本会自动负责这一步。
2. 准备本地配置 JSON。`apiBase` 指向以 `/api/v1` 结尾的演示 API，`repositoryBaseUrl` 指向 `storefront.git` 所在的 HTTP Git 根路径。`targets` 包含 `test-a`、`test-b`、`production-a`、`production-b`。每个目标填写 `host`、`username`、独立核对的 `hostKeyFingerprint` 和 `privateKey` 或 `password`，可选自定义 `port`。`addresses` 可按地址别名替换服务卡片中的占位 URL。将配置保留在仓库外。
3. 在当前进程设置 `VEYOPS_DEMO_ADMIN_PASSWORD`，使用演示管理员密码。运行 `node tools/acceptance/refactor-demo.cjs init <配置.json>`。它会登记资源、校验并发布演示图，返回项目、目标和固定版本。重复导入复用属于这一演示的匹配项，遇到不匹配资源或已编辑的图时停止。导入流程结束后，可在工作台选择开始节点预览。

## Linux 候选验收

先执行 `npm run build -w apps/api` 和 `node tools/acceptance/check-graph-presets.cjs`，检查七条默认链在文件、目录和镜像三类产物下的编译结果。

[p1-linux.sh](../../tools/acceptance/p1-linux.sh) 从给定提交加载演示定义、初始化器和验收脚本。候选镜像须标注同一提交。下面的命令在候选提交所在的 Linux checkout 执行。

```sh
revision=$(git rev-parse HEAD)
image="veyops:candidate-$revision"
git archive "$revision" | docker build --label "org.opencontainers.image.revision=$revision" -t "$image" -
VEYOPS_ACCEPT_RUNTIME_IMAGE="$image" sh tools/acceptance/p1-linux.sh "$revision" sqlite
VEYOPS_ACCEPT_RUNTIME_IMAGE="$image" sh tools/acceptance/p1-linux.sh "$revision" postgres
```

执行前需在本地 Linux Docker Engine 准备 `node:24-bookworm-slim`、`busybox:1.36`，使用 PostgreSQL 时还需 `postgres:17-bookworm`。宿主机需要 cgroup v2、Docker Compose 和 Buildx 插件，以及与目标基础镜像兼容的 SSH 服务端、`ssh-keygen`、OpenSSL 和 Git。脚本会验证并复制所用的本地工具。

每次执行创建新目录、内部网络、四个 SSH 目标及其私有 Docker 引擎。测试组和生产模拟组使用各自服务器、发布目录和 SSH 指纹。远端发布仅发生在这些临时目标。脚本覆盖多仓及分支与同名 Tag、目录和镜像、多实例与缺失目标、双服务发布、部分失败分路、同根临时产物、清理重试、Worker 租约恢复和备份还原。脚本保留 `candidate.txt`、`manager.log` 和成功运行的 `evidence.json`，清理带本次标签的容器、网络和临时登录密钥。浏览器和其他 A01–A34 结果按实施计划记录。

需要在测试服务器保留供人工操作的实例时，运行 `sh tools/acceptance/p1-linux.sh "$revision" sqlite preview <测试服务器IPv4:端口>` 并设置同一个候选镜像环境变量。试用模式只对指定地址发布管理端端口。演示仓库、SSH 目标和 Docker 引擎保留在测试网络。专用目录中的 `preview-login.txt` 仅供部署者读取。首次登录可跳过改密。试用实例由部署者负责停用和清理，不随验收批次回收。

Docker 默认地址池不足时，可通过 `VEYOPS_ACCEPT_NETWORK_SUBNET` 为本次运行指定未占用的内部网段。试用模式可另用 `VEYOPS_ACCEPT_PREVIEW_SUBNET` 指定发布端口的网段。
