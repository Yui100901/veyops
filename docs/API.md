# veyops v0.2 API

前缀 `/api/v1`。成功：`{"data": ...}`；错误：`{"error":{"code":"HTTP_400","message":"..."}}`。SSE 使用标准事件格式。时间为 UTC 毫秒；ID 为 UUID。所有资源默认需要登录，同团队可读；写接口限定 ADMIN/OPERATOR，凭据管理仅 ADMIN。Cookie `veyops_session` 为 HttpOnly、SameSite=Strict，会话 12 小时；浏览器请求必须同源。生产无匿名 Swagger。

## 认证

| 方法 | 路径                  | 请求 / 说明                                                                                   |
| ---- | --------------------- | --------------------------------------------------------------------------------------------- |
| GET  | /health               | 匿名服务健康状态                                                                              |
| GET  | /auth/status          | 匿名 `{initialized:boolean}`                                                                  |
| POST | /auth/login           | `{username,password}`，返回用户信息及 `mustChangePassword`，设置 Cookie                       |
| GET  | /auth/me              | 当前用户 `{id,username,role,mustChangePassword}`                                              |
| POST | /auth/change-password | `{currentPassword,newPassword}`；新密码 12–256 位且不同于原密码。成功后撤销账号会话，重新登录 |
| POST | /auth/logout          | 撤销当前会话                                                                                  |

角色为 ADMIN、OPERATOR、VIEWER。空库启动时创建 `root`，使用 `ADMIN_PASSWORD` 或控制台中的随机初始密码。`mustChangePassword` 为 `true` 时，会话只可读取 `/auth/me`、改密或退出。登录入口按 IP 限速。

## 用户管理

下列接口要求已完成首次改密的管理员会话。用户信息包含 `id`、`username`、`role`、`status`、`mustChangePassword`、`createdAt` 和 `updatedAt`。

| 方法 | 路径 | 请求 / 说明 |
| ---- | ---- | ----------- |
| GET | /users | 列出包括停用状态在内的账号 |
| POST | /users | `{username,role,password}`，创建启用账号并要求首次改密 |
| PATCH | /users/:id | `{role?,status?}`，更新角色或启停状态 |
| POST | /users/:id/reset-password | `{password}`，设置临时密码并要求下次登录改密 |

用户名区分大小写，长度为 2–64，首字符为英文字母或数字，其余字符还可使用点、下划线和短横线。创建后用户名固定。临时密码须为 12–256 个字符，仅通过请求提交。状态为 `ACTIVE` 或 `DISABLED`。

修改角色、启停状态或重置密码时，服务撤销该账号的会话并记录审计，响应和审计均不包含密码或密码哈希。管理员通过 `/auth/change-password` 修改自己的密码。停用账号保留已有操作及资源归属记录。

## 资源

| 方法                 | 路径                       | 请求 / 说明                                                                                                  |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GET / POST           | /credentials               | 列表 / `{name,type,secret,metadata?}`                                                                        |
| PATCH                | /credentials/:id           | `{name?,secret?,status?:'ACTIVE'\|'DISABLED'}`                                                               |
| DELETE               | /credentials/:id           | 引用检查后删除                                                                                               |
| GET / POST           | /servers                   | 列表 / `{name,host,port?:22,username,credentialId,hostKeyFingerprint,tags?,description?}`                    |
| GET / PATCH          | /servers/:id               | 详情含分组、所属项目、探测与执行历史 / 完整服务器配置                                                        |
| DELETE               | /servers/:id               | 软移除，不删除历史                                                                                           |
| POST                 | /servers/:id/test          | 只读连接检查，返回 `{success,server,result:{exitCode,output}}`                                               |
| GET / POST           | /server-groups             | 列表 / `{name,description?,serverIds:[]}`                                                                    |
| PATCH / DELETE       | /server-groups/:id         | 更新分组和成员 / 删除分组关联                                                                                |
| GET / POST           | /projects                  | 列表 / `{name,slug,description?,tags?}`                                                                      |
| GET / PATCH / DELETE | /projects/:id              | 详情 / 完整基本配置 / 软删除                                                                                 |
| POST                 | /projects/:id/repositories | `{name,cloneUrl,defaultBranch?,credentialId?}`                                                               |
| POST                 | /projects/:id/services     | `{name,slug,serviceType:'WEB'\|'API'\|'WORKER'\|'SCHEDULED_JOB'\|'STATIC_SITE'\|'DOCKER_SERVICE'\|'CUSTOM'}` |
| POST                 | /projects/:id/environments | `{name,slug,environmentType:'DEVELOPMENT'\|'TESTING'\|'STAGING'\|'PRODUCTION'\|'CUSTOM'}`                    |
| GET                  | /dashboard                 | 全量服务器/项目/任务计数、活跃任务计数、最近任务                                                             |
| GET                  | /audit                     | 最近200条非敏感操作审计                                                                                      |
| GET / PATCH          | /system                    | 查看版本、数据库和当前 API 进程的 Worker / 管理员更新执行默认值和日志保留期                                  |

凭据 `type` 包括 SSH_PASSWORD、SSH_KEY、GIT_TOKEN、GIT_PASSWORD、API_KEY、API_SECRET、DOCKER_REGISTRY、USERNAME_PASSWORD、CUSTOM_SECRET。SSH_PASSWORD 使用 `secret:{password}`；SSH_KEY 使用 `{privateKey,passphrase?}`；GIT_TOKEN 使用 `{token}`；API_KEY 使用 `{apiKey}`。GET 永不返回 secret、ciphertext、nonce、auth_tag。

仓库、服务和环境可通过 `PATCH /projects/:id/{repositories,services,environments}/:resourceId` 更新，或通过同路径的 `DELETE` 删除。更新请求沿用创建字段。仓库凭据传 `null` 可解除关联。资源仍被部署、任务历史或其他资源引用时，删除返回 409。

项目详情返回 `addresses`、`dependencies`、`deploymentTargets` 和 `recentDeployments`。通过 `POST /projects/:id/addresses` 或 `POST /projects/:id/dependencies` 新增记录，带记录 ID 的路径支持 `PATCH` 和 `DELETE`。地址可关联项目内的服务和环境，依赖提交时会检查循环引用。

## 项目视图

| 方法   | 路径       | 请求 / 说明                                                                |
| ------ | ---------- | -------------------------------------------------------------------------- |
| GET    | /views     | 返回 `{views,defaultViewId}`，包含四个预设和当前账号的自定义视图           |
| GET    | /views/:id | 返回视图详情、排序后的项目和各项目的发布状态、近期发布与访问地址           |
| POST   | /views     | `{name,description?,projectIds,isDefault?}`，`projectIds` 的顺序即显示顺序 |
| PATCH  | /views/:id | 使用同一请求结构更新自定义视图与项目列表                                   |
| DELETE | /views/:id | 删除当前账号的自定义视图                                                   |

预设 ID 为 `all`、`production`、`testing` 和 `abnormal`。生产与测试视图按环境类型筛选项目，发布记录只覆盖所选环境。异常状态按每个服务、环境和目标服务器的最新部署判断。没有验证过的成功发布显示为待验证。

所有登录角色均可读取预设。管理员或运维人员可保存和设置自己的自定义视图为默认。无自定义默认时打开「全部项目」。设为默认会替换当前账号的旧默认，删除视图只移除它和项目的关联。

## 系统运行设置

`PATCH /system` 接受 `{defaultBuildLocation?,defaultMaxParallelTargets?,logRetentionDays?}`。仅管理员可修改，省略的设置保留原值。构建位置为 `TARGET` 或 `MANAGER`，默认 `TARGET`。目标并发为 1–10，默认 3。新建配置或提交任务时省略对应字段可使用系统默认值，已经保存的版本和任务快照保留原配置。

日志保留期为 0–3650 天，默认 0 表示长期保留。启用后 Worker 周期性清理已结束且超过保留期的任务日志，保留任务记录、子步骤、审计和产物。

## 命令

`POST /commands/preview` 返回 `{count,targets,targetHash}`。目标可通过 `serverIds`、`groupIds`、`tags`、`projectIds`、`environmentIds` 和 `deploymentTargetIds` 选择。项目和环境通过已配置的服务环境部署目标关联服务器。同一标签选择内要求匹配所有标签，各选择的结果合并去重。

`POST /commands/execute` 示例：

```json
{
  "name": "系统巡检",
  "command": "uname -srm; uptime",
  "serverIds": ["<server UUID>"],
  "confirmed": true,
  "strategy": "PARALLEL",
  "maxParallel": 3,
  "failurePolicy": "CONTINUE",
  "timeout": 300
}
```

提交分组、标签、项目、环境或部署目标时，将预览返回的 `targetHash` 作为 `expectedTargetHash` 一并提交。目标或 SSH 配置发生变化时重新预览。执行返回排队的 Task，支持 `PARALLEL`、`SEQUENTIAL`、`STOP` 和 `CONTINUE`，超时单位为秒。`GET /commands/executions` 返回命令历史。

`GET /command-templates` 查询命令模板，`POST /command-templates` 创建模板，`PATCH /command-templates/:id` 保存新版本，`DELETE /command-templates/:id` 归档。通过 `GET /command-templates/:id/versions` 读取版本，向 `POST /command-templates/:id/run` 提交版本、参数和执行目标。

## 任务与日志

| 方法 | 路径                            | 说明                                                                                     |
| ---- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| GET  | /tasks                          | 最近100条任务                                                                            |
| GET  | /tasks/:id                      | `{id,type,name,status,createdBy,createdAt,startedAt,finishedAt,errorSummary,result,...}` |
| GET  | /tasks/:id/targets              | 每目标名称、Host、状态、退出码、错误摘要及 `canRetry`                                    |
| GET  | /tasks/:id/steps                | 每目标步骤记录                                                                           |
| GET  | /tasks/:id/logs?offset=0        | `{content,nextOffset}`；偏移单位字节，单次最多256 KiB                                    |
| GET  | /tasks/:id/logs/stream?offset=0 | SSE，事件 `{content,nextOffset,status}`，id为偏移；支持Last-Event-ID                     |
| POST | /tasks/:id/cancel               | PENDING直接取消；RUNNING请求取消；终态拒绝                                               |

终态为 SUCCESS、FAILED、PARTIAL_FAILED、CANCELLED、TIMED_OUT、NEEDS_ATTENTION。Worker 租约过期进入 NEEDS_ATTENTION，不隐式重试。

`POST /tasks/:id/targets/:targetId/retry` 接收 `{confirmed:true}`。管理员或提交任务的运维人员可重试明确返回失败退出码的目标，以及执行前已跳过的目标。重试使用原任务的命令或方案版本，生成独立任务并返回 `retryOf`。同一来源目标的重复请求返回同一次重试，下一次重试可从该重试任务发起。

## 运维方案

`GET /operation-plans` 查询方案，`POST /operation-plans` 创建，`PATCH /operation-plans/:id` 保存新版本，`DELETE /operation-plans/:id` 归档。`GET /operation-plans/:id/versions` 查询历史版本，`POST /operation-plans/:id/run` 执行指定版本。

创建与更新：

```json
{
  "name": "只读检查",
  "description": "检查系统版本",
  "category": "CUSTOM",
  "steps": [{ "name": "系统信息", "command": "uname -srm", "timeout": 30 }]
}
```

每次更新创建新版本。定义可包含 `preChecks`、`postChecks` 及 `parameters`。每项参数包含 `name`、`type`，可设置 `required`、`defaultValue` 和 `description`。命令中可用 `"$VEYOPS_PARAM_NODE_VERSION"` 读取参数。运行请求使用与命令相同的目标和执行策略字段，并可传入 `version` 和键值形式的 `parameters`。

## v0.2 交付接口

| 方法             | 路径                                               | 说明                                                                                                     |
| ---------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| GET/POST         | /deployment-targets                                | 目标列表/创建：`{name,serverIds,strategy,maxParallel,failurePolicy,description?}`                        |
| GET/PATCH/DELETE | /deployment-targets/:id                            | 查询/替换配置/无引用时删除                                                                               |
| GET/PUT          | /services/:serviceId/repositories                  | 查询/替换关联，`{repositories:[{repositoryId,repoPath,isPrimary}]}`                                      |
| GET/PUT          | /services/:serviceId/environments/:envId/config    | 读取/保存服务环境配置                                                                                    |
| GET/PUT          | /environments/:envId/variables                     | 环境变量列表/替换：`{variables:[{key,value?或credentialId?}]}`                                           |
| GET/PUT          | /services/:serviceId/environments/:envId/variables | 服务级变量覆盖同名环境变量                                                                               |
| GET/POST         | /pipelines                                         | 列表/创建服务级Pipeline                                                                                  |
| GET/PATCH/DELETE | /pipelines/:id                                     | 查询/新增版本/禁用并保留历史                                                                             |
| GET              | /pipelines/:id/versions                            | 不可变历史版本                                                                                           |
| POST             | /pipelines/:id/preview                             | 固定版本、环境配置与目标的执行预览                                                                       |
| POST             | /pipelines/:id/run                                 | `{environmentId,targetId,commitSha,version?,confirmed:true,mode?}`，`mode` 可选 `DEPLOY` 或 `BUILD_ONLY` |
| GET/PUT          | /pipelines/:id/webhook                             | 管理员查询或保存 Gitea 触发配置 `{environmentId,targetId,branch,secretCredentialId,enabled}`             |
| POST             | /webhooks/gitea/:pipelineId                        | 接收签名的 Gitea Push，按配置触发仅构建                                                                  |
| GET              | /artifacts                                         | 产物列表，支持 `projectId` 和 `pipelineRunId` 筛选，返回 `downloadAvailable`                             |
| GET              | /artifacts/:id/download                            | 登录后下载平台归档，响应头 `X-Artifact-SHA256` 提供校验和                                                |
| GET              | /deployments                                       | 逐服务器交付记录，支持projectId筛选                                                                      |
| GET/POST         | /registries                                        | Registry列表/创建（创建仅ADMIN）                                                                         |
| PATCH            | /registries/:id                                    | 管理员编辑 Registry，`credentialId:null` 可解除凭据关联                                                  |
| POST             | /registries/:id/test                               | 管理员从管理端测试 HTTPS Registry V2 连通与认证，返回 `{success,authenticated,message}`                  |
| DELETE           | /registries/:id                                    | 管理员删除未被 Pipeline 版本或镜像产物引用的 Registry。仍有引用时返回 409                                |

管理员和操作员可调用 `/projects/:projectId/repositories/:repositoryId/connection`、`/branches` 和 `/commits` 的 GET 接口检查仓库、读取分支和查询最近提交。`/commits` 接受 `branch` 和 `limit`，默认 20 条，最多 50 条。给仓库绑定凭据需要管理员角色。

Pipeline 定义、四种组合、目录保护和环境覆盖规则见 [构建部署说明](PIPELINES.md)。环境配置字段包括 `targetId,buildLocation,artifactType,deployMethod,deployPath,buildCommand,workingDirectory,outputPath,composeFilePath,startCommand,healthCheckCommand`。敏感变量只接收凭据引用；普通值和引用二选一。

`GET /deployments` 返回 `previousDeploymentId`，指向同一目标上一成功的部署记录。发布结果不确定时状态为 `NEEDS_ATTENTION`。启用 AI 分析后，`GET /tasks/:id` 的 `result.aiAnalysis` 异步附加 `{status:"SUCCESS",summary,failedPhase,nextActions}` 或 `{status:"UNAVAILABLE"}`。

## v0.2 AI 接口

| 方法         | 路径                           | 说明                                                                                                                       |
| ------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| GET/POST     | /ai/providers                  | 列表/管理员创建：`{name,baseUrl,model,apiKey?或credentialId?,enabled?,timeoutSeconds?}`                                    |
| PATCH/DELETE | /ai/providers/:id              | 管理员更新/删除                                                                                                            |
| POST         | /ai/providers/:id/test         | 管理员测试模型连接，安全摘要响应                                                                                           |
| GET/PATCH    | /ai/policies                   | 查询/管理员保存系统或项目策略                                                                                              |
| POST         | /ai/chat                       | `{message,conversationId?,projectId?,providerId?}`；返回`{conversationId,message,proposals,tasks,drafts}`                  |
| POST         | /ai/repository-analysis        | 管理员或操作员按 `{projectId,repositoryId,serviceId?,environmentId?,commitSha?,docPath?,repoPath?}` 读取仓库证据并生成草稿 |
| GET          | /ai/conversations              | 仅当前用户的会话                                                                                                           |
| GET          | /ai/conversations/:id/messages | 仅会话发起者可读                                                                                                           |
| GET          | /ai/proposals                  | 当前用户的执行提案                                                                                                         |
| POST         | /ai/proposals/:id/confirm      | 重新校验权限、目标与配置后最多提交一次                                                                                     |
| POST         | /ai/proposals/:id/reject       | 拒绝提案，不执行                                                                                                           |

API Key 不回显，更新时省略 Key 表示保留。AI 为空或禁用不会影响手工运维。策略与工具限制见 [AI 说明](AI工具与权限.md)。

仓库分析省略 `commitSha` 时固定远端默认分支的完整提交，返回证据路径、技术栈、服务线索、草稿和缺失字段。巡检通过固定 SSH 查询采集目标环境，诊断只返回结构化故障分类与失败步骤。

完全控制策略可用 `approvedPipelineHashes` 授权 Pipeline 预览返回的 `aiApprovalHash`，它绑定版本、提交、执行模式、环境、目标和有效配置。源码写入使用 `repositoryIds` 授权仓库。评审分支和 PR 是两个写步骤。确认使用提案接口，源码步骤返回 `sourceChange`，任务步骤返回 `task`。

备份恢复由[维护命令](BACKUP.md)提供。
