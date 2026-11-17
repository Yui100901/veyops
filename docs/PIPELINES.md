# Pipeline、构建与部署

Pipeline是服务级的版本化交付配置。每次修改追加不可变版本；每次执行必须明确环境、部署目标、完整Git Commit和确认。目标、连接信息、有效配置与普通变量在提交时生成快照，敏感变量只保存凭据引用并在执行时解密。所有运行进入现有数据库任务队列，与命令和方案共用Worker、日志、取消和目标状态。

## 配置与运行

1. 创建项目、HTTP(S) Git 仓库、服务和环境。管理员可为私有仓库关联 Git Token 或用户名密码凭据。打开仓库详情测试连接、浏览分支和最近提交。
2. 创建部署目标并明确服务器成员及执行顺序、并发和失败策略。
3. 创建Pipeline，选择仓库、构建位置、产物类型、构建命令及专用部署目录。
4. 可选地保存服务环境配置及环境变量。非空环境配置覆盖Pipeline的同名构建/部署字段，服务环境变量覆盖环境变量。
5. 在 Pipeline 运行对话框选版本，再从该版本的仓库选择分支和提交，也可直接输入 40 或 64 位完整 SHA。预览确认后，任务始终使用该 SHA。
6. 在构建任务详情查看目标结果、日志和归档，可用响应头 `X-Artifact-SHA256` 核对下载结果。选择「构建并部署」时，构建成功后关联独立的部署任务，任务详情可以在两者之间跳转。

最小文件Pipeline定义：

```json
{
  "name": "Web release",
  "projectId": "<project UUID>",
  "serviceId": "<service UUID>",
  "definition": {
    "repositoryId": "<repository UUID>",
    "buildLocation": "TARGET",
    "artifactType": "FILE",
    "repoPath": ".",
    "installCommand": "npm ci",
    "buildCommand": "npm run build",
    "outputPath": "dist",
    "deployPath": "/opt/veyops/my-web",
    "startCommand": "",
    "healthCheckCommand": "test -s index.html",
    "steps": []
  }
}
```

`steps`为构建后、产物打包前的附加Shell步骤，结构为`{name,type:"SHELL",command,timeout?}`，按数组顺序执行。每步最大超时3600秒，默认900秒。`repoPath`、输出路径、Dockerfile和Compose路径必须位于仓库内部。文件产物支持普通目录和单文件，均打包为tar.gz；拒绝产物中的符号链接。

服务环境配置中的工作目录以仓库根为基准，例如 `apps/web`。填写后覆盖 Pipeline 的 `repoPath`，留空时继承。安装、构建、文件产物、Dockerfile 和 Compose 路径均相对于有效工作目录。

通过 `POST /api/v1/pipelines/:id/run` 提交运行，参数为 `{environmentId,targetId,commitSha,version?,confirmed:true,mode?,allowPartialDeploy?}`。省略 `version` 时固定当前版本。提交可携带预览返回的 `configurationHash` 和 `serverIds` 作为 `expectedConfigurationHash` 和 `expectedServerIds`，资源变化后需要重新预览。AI 确认流程也会校验目标和配置哈希。

## 仅构建

在运行对话框选择「仅构建」，对应 API 的 `mode: "BUILD_ONLY"`。构建使用固定 Commit、版本和环境变量快照，完成检出、安装依赖、构建与产物记录。文件产物和离线镜像归档以 `.tar.gz` 保存到管理端，目标端归档经 SFTP 回传并校验。归档下载须登录，单份归档上限为 1 GiB。只有旧镜像标签或镜像 ID 的历史任务，可重新构建生成归档。

镜像归档可用 `docker image load -i <归档路径>` 导入，归档内保留本次构建的独立标签。仅构建无需 Registry 和部署目录。用于发布的离线镜像须有同次构建归档的 Compose 配置。 [Docker 镜像导入说明](https://docs.docker.com/reference/cli/docker/image/load/)

## 构建并部署

选择「构建并部署」或在 API 请求中使用 `mode: "DEPLOY"`。省略 `mode` 时也使用该模式。提交返回构建任务，自动创建的部署任务 ID 可从构建任务详情的 `deploymentTaskId` 获取。部署使用该次构建保存的文件归档或固定镜像，分开记录执行和发布结果。

默认等待本批次所有目标构建并归档成功。目标端构建可显式启用 `allowPartialDeploy`，仅发布有可用产物且构建成功的目标。未发起部署时，构建任务详情的 `deploymentSkippedReason` 说明原因。构建和归档期间当前服务继续运行。

## 部署已有产物

从构建任务的产物区或交付记录的产物列表选择部署，预览来源 SHA、版本、环境和目标，确认后可打开新的部署任务。API 先调用 `POST /pipelines/:id/artifact-deploy/preview`，请求包含 `{artifactIds,environmentId,targetId,version?}`。确认时调用 `POST /pipelines/:id/artifact-deploy`，同时提供 `confirmed: true`、预览的 `expectedConfigurationHash`，以及可选的 `expectedServerIds`。

所选产物来自同一 Pipeline、环境及构建任务。管理端产物可分发到所选环境的目标，目标端产物须和所选服务器逐一匹配。默认使用来源构建的 Pipeline 版本。部署会再次校验文件归档、镜像和 Compose 数据，任务直接进入发布准备。只有可验证归档、来源或 Compose 数据齐备的历史产物可部署，其他历史仍可查询。

## Gitea 推送触发

1. 在专用 Linux 构建主机准备 rootless Docker 和 Docker CLI。API/Worker 以该 daemon 的非 root 用户运行，设置 `WEBHOOK_BUILD_DOCKER_SOCKET=/run/user/<UID>/docker.sock`。daemon 须使用 systemd、cgroup v2，并支持 CPU、内存和 PID 限制。API 进程和 daemon 需要用相同路径访问构建工作目录。默认 Compose 适合启动平台，启用自动构建需要额外接入上述环境。
2. 在凭据中心创建「自定义密钥」凭据，保存至少 32 字节的随机共享密钥。
3. 将 Pipeline 的有效构建位置设为管理端，选择只含普通构建变量的环境。在 Pipeline 卡片打开「Webhook」，选择分支、环境、目标组和共享密钥。自动构建记录保留目标组关联，无需连接其部署主机。原有目标端 Webhook 需要切换到管理端后重新保存。
4. 在 Gitea 添加 `application/json` 的 Push Webhook，填写可访问的接收地址与同一共享密钥。推送到绑定分支后，在任务中心核对提交、产物和日志。

接收端通过原始请求体校验 `X-Gitea-Signature`，按绑定的仓库克隆地址与分支筛选。同一 Pipeline、分支和提交的重复投递返回同一个任务。Webhook 固定以仅构建方式执行。配置接口为 `GET/PUT /pipelines/:id/webhook`，接收接口为 `POST /webhooks/gitea/:pipelineId`。[Gitea Webhook 文档](https://docs.gitea.com/1.22/usage/webhooks/)

Webhook 固定当前 Pipeline 版本及有效配置。环境、目标或仓库配置变化后需要重新保存。禁用绑定、换签名密钥与任务入队采用事务校验，已经入队的任务可在任务中心取消。自动构建始终使用显式指定的 Socket，不回退到系统 Docker。 [Docker rootless 设置](https://docs.docker.com/engine/security/rootless/) · [资源限制](https://docs.docker.com/engine/security/rootless/tips/#limiting-resources)

## 构建与部署矩阵

| 构建位置 | 产物         | 行为                                                                                 |
| -------- | ------------ | ------------------------------------------------------------------------------------ |
| TARGET   | FILE         | 每台主机独立检出固定提交、构建并将经 SHA-256 校验的归档回传，部署时向来源服务器分发对应归档 |
| MANAGER  | FILE         | 管理端隔离构建一次，归档后通过 SFTP 分发到目标并逐台校验 SHA-256 |
| TARGET   | DOCKER_IMAGE | 每台目标独立构建镜像，归档 Compose 文件及对应镜像，部署时使用该服务器对应的镜像 |
| MANAGER  | DOCKER_IMAGE | 管理端构建并归档一次，所选服务器按同一构建产物发布 |

TARGET 要求目标预装 Git、tar、sha256sum 及项目语言工具链。Docker 构建另需 Docker CLI、daemon 和 BuildKit，镜像归档另需 Bash 和 gzip，部署另需 Compose。管理端仓库浏览依赖 Git CLI，管理端构建依赖 Docker CLI 和 daemon。

## 管理端隔离

管理端脚本始终在临时Docker容器中运行。容器限制CPU、内存和PID数量，丢弃Linux capabilities，启用no-new-privileges、只读根文件系统，仅挂载当前任务的工作目录；不会给不可信构建容器挂载宿主机Docker Socket。

检出、构建、打包分开运行。Git凭据只挂载到可信检出容器，随后移除；仓库构建容器看不到该凭据。默认可信检出/打包镜像为`node:22-bookworm`，部署者可以在服务端设置`BUILD_HELPER_IMAGE`为已审核的替代镜像；Pipeline的`buildImage`仅决定仓库脚本使用的镜像。镜像已有缓存时不强制拉取。管理端Docker镜像构建由可信Docker CLI调用BuildKit，不在平台主进程执行Dockerfile脚本。

管理端和Compose环境文件暂只支持单行值。构建容器允许联网下载依赖，依然应使用受控构建主机和可信镜像；当前实现不提供多租户强隔离。

## Git与凭据

当前构建支持HTTP(S)公开仓库和Token/用户名密码私有仓库。私有凭据通过临时0600文件作为Git credential helper响应提供，不拼入URL或命令参数，检出结束后删除。Git操作不读取或修改目标用户的全局配置，不启用仓库Hooks，也不自动处理Submodule。

SSH Git URL暂不支持，因为仓库主机公钥配置和可信注入链路尚未实现；创建Pipeline时会明确拒绝。平台管理服务器的SSH密码/私钥和主机指纹验证不受此限制。

## 文件发布和保护

文件发布使用`deployPath/releases/<task-id>`保存版本，通过原子替换`current`符号链接切换。归档保存在`.artifacts/<task-id>.tar.gz`。默认只允许`/opt`、`/srv`、`/home`、`/tmp`或`/var/www`的专用子目录。

首次发布只允许空目录；后续发布必须匹配平台写入的项目/服务/环境归属标记。拒绝符号链接部署目录、跨归属目录和现有真实`current`目录，避免误覆盖已有服务目录。执行器只自动清理自己创建的唯一临时工作目录，不递归删除用户配置的部署目录。

发布按目标主机、服务环境与部署路径加锁，覆盖候选版本准备、激活和健康检查。锁冲突会结束本次目标执行。文件归档校验及解压在切换 `current` 前完成，Compose 渲染镜像校验及拉取也在启动前完成。为生产 Docker 配置与宿主机路由不重叠的地址池或外部网络。

文件发布可配置停止命令。归档校验和候选版本准备成功后，平台才在当前受管发布目录执行该命令并切换 `current`。启动命令和命令式健康检查在新版本目录运行。管理员可为服务环境增加目标端 HTTP 2xx 检查、Compose 容器健康检查，以及检查次数、间隔和单次超时。

## 发布审批与回滚

服务环境可以要求发布审批。独立构建仍正常完成，部署任务等待管理员在「部署记录」确认固定提交、目标和产物。构建提交时已要求的审批随交付保留。批准后 Worker 复核当前权限和目标再执行。管理员可以在任务中心取消等待中的任务。

部署记录可预览并恢复有完整发布快照和可用产物的历史版本。回滚从原文件归档或镜像及 Compose 配置开始，在同一发布锁内准备、激活和健康检查。回滚生成独立发布记录。文件部署的应用版本及 Compose 镜像可以恢复，数据库和数据卷继续由各自的恢复流程管理。

自动回滚按服务环境配置，默认关闭。可以选择恢复该目标上一次健康版本，或按指定已验收发布恢复各目标。启用时需有发布健康检查。激活已影响服务且出现明确启动或健康检查失败时，系统尝试一次恢复。构建、归档或候选准备失败时，线上实例继续运行。历史快照或产物不可用、回滚失败或远端状态不明时，进入待核查。

激活结果不明或激活后连接中断时，目标进入 `NEEDS_ATTENTION`，发布锁继续保留。恢复前暂停同一服务环境的发布，通过任务日志找到 `/var/tmp/.veyops-deployment-locks` 下的锁路径及 Pipeline 运行 ID。用同一部署账号或主机管理员核查 `current`、实际运行的 Compose 服务或镜像以及残留进程，并对照两个锁目录内 `owner` 中的运行 ID。确认不存在仍在执行的发布后，只删除对应的 `owner` 文件并用 `rmdir` 删除这两个空锁目录。

## Docker与Registry

在Registry页面填写`host[:port]`，不要加HTTP协议或凭据。可引用DOCKER_REGISTRY/USERNAME_PASSWORD凭据。密码通过`docker login --password-stdin`提供，配置文件使用独立临时目录并在任务结束后清理。

Docker Pipeline 的「构建并部署」使用 `registryId`、`imageRepository`、`dockerfilePath` 和 `composeFilePath`。构建阶段生成并推送唯一标签，标签由 Commit 前 12 位和构建任务 ID 组成，目标端构建时追加目标服务器 ID。构建产物保留实际标签、不可变的 `sha256` Digest、完整 Commit 和经校验的 Compose 配置。Compose 文件需引用平台设置的 `VEYOPS_IMAGE`，例如：

```yaml
services:
  web:
    image: ${VEYOPS_IMAGE}
    ports:
      - '127.0.0.1:8080:8080'
```

部署阶段校验 Compose 渲染的镜像列表。Registry 产物使用完整 Digest 引用拉取。离线归档先校验 SHA-256，导入后核对实际镜像 ID，Compose 启动前只补拉尚未缓存的镜像。启动后校验使用该产物的容器镜像 ID 一致，且容器正在运行或已成功退出。Compose 项目名由服务和环境 ID 派生。Registry TLS 信任由部署环境管理。

服务环境可选在推送后额外保留镜像离线归档，正常发布使用 Registry Digest。启用后保存本次唯一标签对应的 `.tar.gz`、SHA-256、镜像 ID 和平台，归档成功才继续发布。Registry 登录或拉取明确失败时，平台校验归档、目标平台及导入的镜像 ID，再使用本次构建标签启动。此时 Compose 的其他镜像须已缓存，任务日志记录实际使用的标签和镜像 ID。托管副本被清理后，仍可使用 Registry 上的 Digest 发布。

## 相关接口

- `GET/POST /pipelines`，`GET/PATCH/DELETE /pipelines/:id`（DELETE为禁用，保留历史）。
- `GET /pipelines/:id/versions`，`POST /pipelines/:id/preview`，`POST /pipelines/:id/run`。
- `POST /pipelines/:id/artifact-deploy/preview`，`POST /pipelines/:id/artifact-deploy`。
- `GET /artifacts`，`GET /deployments`，可使用`projectId`筛选。
- `POST /deployments/:id/rollback/preview`，`POST /deployments/:id/rollback`。
- `GET /deployments/approvals`，`POST /deployments/approvals/:id/approve`（管理员）。
- `GET/POST /registries`；Registry创建仅ADMIN。

项目验证报告记录已执行的集成验收。自动化用例覆盖四种构建部署组合、版本和提交快照、配置漂移、构建失败、目录保护和凭据隔离。
