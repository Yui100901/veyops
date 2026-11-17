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
| GET / POST           | /servers                   | 列表 / 创建时提交 `{name,host,port?:22,username,credentialId,hostKeyAcceptanceToken,tags?,description?}` |
| POST                 | /servers/host-key/probe    | 提交 `{host,port?,serverId?}`，握手读取公钥并返回算法、指纹、一次性接受令牌及有效期 |
| POST                 | /servers/:id/host-key/accept | 对已有服务器提交 `{hostKeyAcceptanceToken}`，确认探测到的新指纹 |
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
| GET                  | /dashboard                 | 服务器、项目、服务和任务统计，最近部署、最近任务及失败任务                                                   |
| GET                  | /audit                     | 最近200条非敏感操作审计                                                                                      |
| GET / PATCH          | /system                    | 查看版本、数据库和当前 API 进程的 Worker / 管理员更新执行默认值和日志保留期                                  |

凭据 `type` 包括 SSH_PASSWORD、SSH_KEY、GIT_TOKEN、GIT_PASSWORD、API_KEY、API_SECRET、DOCKER_REGISTRY、USERNAME_PASSWORD、CUSTOM_SECRET。SSH_PASSWORD 使用 `secret:{password}`；SSH_KEY 使用 `{privateKey,passphrase?}`；GIT_TOKEN 使用 `{token}`；API_KEY 使用 `{apiKey}`。GET 永不返回 secret、ciphertext、nonce、auth_tag。

仓库、服务和环境可通过 `PATCH /projects/:id/{repositories,services,environments}/:resourceId` 更新，或通过同路径的 `DELETE` 删除。更新请求沿用创建字段。仓库凭据传 `null` 可解除关联。资源仍被部署、任务历史或其他资源引用时，删除返回 409。

项目详情返回 `addresses`、`dependencies`、`deploymentTargets` 和 `recentDeployments`。通过 `POST /projects/:id/addresses` 或 `POST /projects/:id/dependencies` 新增记录，带记录 ID 的路径支持 `PATCH` 和 `DELETE`。地址可关联项目内的服务和环境，依赖提交时会检查循环引用。

### 首页汇总

`GET /dashboard` 返回 `servers`、`projects`、`services`、`totalTasks`、`activeTasks`、`recentDeployments`、`recentTasks` 和 `recentFailedTasks`。

- `services` 包含 `total`、`running` 和 `abnormal`。统计未删除项目，每个服务只计一次。按服务、环境和启用服务器分别取最新部署记录。任一记录显示部署失败、部分失败、超时、需要检查或健康失败、未知时，服务计为异常。没有异常且至少一个目标的部署成功并通过健康检查时，服务计为运行中。未部署和未验证的服务只计入总数。
- `recentDeployments` 最多六条逐服务器发布记录，含项目、服务、环境、服务器、对应任务、发布版本、执行和健康状态。按开始时间降序，未记录开始时间时使用 Pipeline 运行创建时间。已停用服务器的历史发布仍可查看。
- `recentTasks` 和 `recentFailedTasks` 分别最多六条。后者独立查询 `FAILED`、`PARTIAL_FAILED`、`TIMED_OUT` 和 `NEEDS_ATTENTION`，较旧的失败任务不会被新的成功任务挤出。

### 备份

以下接口仅管理员可用。返回的备份元数据含 `id`、`createdAt`、`databaseClient` 和 `fileCount`，其中 `fileCount` 包含数据库快照和托管文件。

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET | /backups | 列出本实例备份目录中具有有效认证清单的备份 |
| POST | /backups | 创建在线备份，完成后返回元数据和状态码 201 |
| POST | /backups/:id/verify | 校验清单和文件 SHA-256，成功返回元数据 |
| GET | /backups/:id/download | 返回校验后的 `.tar.gz` 流，禁止缓存，解压目录可用于离线恢复 |

备份目录固定为 `DATA_DIR/backups`。在线备份先生成数据库快照，再复制托管文件。需要数据库和文件位于同一维护窗口时，使用停机备份。恢复步骤见 [数据备份与恢复](BACKUP.md)。

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

## 定时运维

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/operation-schedules` | 列出计划和最近一次执行，管理员可查看所有计划 |
| GET | `/operation-schedules/time-zone` | 获取系统默认 IANA 时区 |
| POST | `/operation-schedules/preview` | 预览版本、参数、目标、命令步骤和之后的触发时间，返回 `configurationHash` |
| POST / PATCH | `/operation-schedules` 或 `/operation-schedules/:id` | 创建或编辑，携带预览参数、`enabled` 和 `expectedConfigurationHash` |
| POST | `/operation-schedules/:id/enable` | 重新预览后携带 `expectedConfigurationHash` 启用 |
| POST / DELETE | `/operation-schedules/:id/disable` 或 `/operation-schedules/:id` | 停止后续触发或删除计划，已有任务和历史可查 |
| GET | `/operation-schedules/:id/runs` | 执行历史及关联任务，可查看跳过、待确认和暂停原因 |
| POST | `/operation-schedules/:id/runs/:runId/approve` | 提交 `{confirmed:true}` 后复核权限、版本和目标，再入队 |

预览参数包含 `name`、`kind`（`COMMAND_TEMPLATE` 或 `OPERATION_PLAN`）、`sourceId`、`sourceVersion`、`timing`、`target`。`timing` 使用 `ONCE` 与 `runAt`（Unix 毫秒）、`INTERVAL` 与 `intervalSeconds`，或 `CRON` 与五字段 `cron`。可选 `timeZone` 使用 IANA 名称。`target` 至少选一台 `serverIds` 或一个 `groupIds`。可配置 `parameters`、`strategy`、`maxParallel`、`failurePolicy`、`timeoutSeconds` 和 `requireConfirmation`。逐次确认默认开启。

Worker 为正常轮询保留 5 秒容差。到期超过 5 秒的执行按漏跑保存，周期计划继续等待下一个有效时刻。

## 站内与邮件通知

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/notifications` | 返回 `items` 和 `unreadCount`，支持 `projectId`、`level` 和 `unread` 过滤 |
| GET | `/notifications/unread-count` | 获取个人未读数 |
| PATCH | `/notifications/:id/read` 或 `/notifications/read-all` | 标记单条或全部已读 |
| GET / PUT | `/notifications/preferences` | 个人收件邮箱、`emailEnabled`、`minimumLevel` 和邮箱验证时间 |
| POST | `/notifications/email/verify-request` 或 `/notifications/email/verify-confirm` | 申请六位邮箱验证码，确认时提交 `{code}` |
| GET / PUT | `/notifications/subscriptions` | 读取或保存 `{subscriptions:[{projectId,stage}]}` |
| GET / PUT | `/notifications/smtp` | 管理员设置发件地址、平台访问地址、SMTP 和凭据引用 |
| POST | `/notifications/smtp/test` | 管理员验证 SMTP 连接和认证 |

通知阶段为 `BUILD`、`DEPLOY`、`ROLLBACK`，等级依次为 `NORMAL`、`WARNING`、`FAILURE`。邮件阈值包含所选等级，个人站内通知保留全部等级。手动与 AI 提交的任务通知发起人，自动触发的任务通知对应项目与阶段的有效订阅者。SMTP 凭据来自凭据中心，使用用户名及密码的发件配置需选择 TLS 或 STARTTLS。邮件队列对明确的临时失败有限重试，投递结果不明时标记待核查。

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

服务环境、流水线运行、产物部署和 Webhook 可直接提交 `serverIds` 或 `groupIds`，可同时选用两者，并配置 `strategy`、`maxParallel` 和 `failurePolicy`。运行与产物部署可继承服务环境的选择。预览返回已去重的 `serverIds` 与保存的 `targetSelection`。提交时携带 `expectedConfigurationHash`，成员变化后重新预览。旧 `targetId` 及相关接口保留兼容。

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
| POST             | /pipelines/:id/run                                 | 接收环境、目标选择、`commitSha`、`confirmed: true` 和预览的 `expectedConfigurationHash`，返回构建任务 |
| POST             | /pipelines/:id/artifact-deploy/preview             | 接收 `artifactIds`、`environmentId`、目标选择和可选 `version`，返回来源提交、选定版本、目标及 `configurationHash` |
| POST             | /pipelines/:id/artifact-deploy                     | 与产物预览参数相同，另需 `confirmed: true`、`expectedConfigurationHash`，可带 `expectedServerIds`。返回部署任务 |
| GET/PUT          | /pipelines/:id/webhook                             | 管理员查询或保存 Gitea 触发配置，提交环境、目标选择、`branch`、`secretCredentialId` 和 `enabled`             |
| POST             | /webhooks/gitea/:pipelineId                        | 接收签名的 Gitea Push，按配置触发仅构建                                                                  |
| GET              | /artifacts                                         | 产物列表，支持 `projectId` 和 `pipelineRunId` 筛选，返回 `downloadAvailable`、`deployable`、`pipelineId`、`pipelineVersion`、`environmentId` 和归档时的 `targetSelection` |
| GET              | /artifacts/:id/download                            | 登录后下载平台归档，响应头 `X-Artifact-SHA256` 提供校验和                                                |
| GET              | /deployments                                       | 逐服务器交付记录，支持projectId筛选                                                                      |
| GET/POST         | /registries                                        | Registry列表/创建（创建仅ADMIN）                                                                         |
| PATCH            | /registries/:id                                    | 管理员编辑 Registry，`credentialId:null` 可解除凭据关联                                                  |
| POST             | /registries/:id/test                               | 管理员从管理端测试 HTTPS Registry V2 连通与认证，返回 `{success,authenticated,message}`                  |
| DELETE           | /registries/:id                                    | 管理员删除未被 Pipeline 版本或镜像产物引用的 Registry。仍有引用时返回 409                                |

管理员和操作员可调用 `/projects/:projectId/repositories/:repositoryId/connection`、`/branches` 和 `/commits` 的 GET 接口检查仓库、读取分支和查询最近提交。`/commits` 接受 `branch` 和 `limit`，默认 20 条，最多 50 条。给仓库绑定凭据需要管理员角色。

Pipeline 定义、四种组合、目录保护和环境覆盖规则见 [构建部署说明](PIPELINES.md)。环境配置字段包括 `serverIds`、`groupIds`、`buildLocation`、`artifactType`、`deployMethod`、`deployPath`、`buildCommand`、`workingDirectory`、`outputPath`、`composeFilePath`、`startCommand` 和 `healthCheckCommand`。敏感变量以凭据引用传入。

运行请求的 `mode` 支持 `DEPLOY`（默认）和 `BUILD_ONLY`。`DEPLOY` 在构建成功、产物归档后创建独立部署任务。默认整批成功后部署，`allowPartialDeploy: true` 允许目标端构建只发布成功目标。构建任务详情返回 `deliveryStage: "BUILD"`、`deploymentTaskId` 和 `deploymentSkippedReason`，部署任务详情返回 `deliveryStage: "DEPLOY"` 和 `sourceBuildTaskId`。

已有产物部署要求同一 Pipeline、环境和构建任务，默认使用来源构建版本。管理端产物可供多个目标使用，目标端产物按来源服务器匹配。提交需携带预览返回的 `configurationHash` 作为 `expectedConfigurationHash`。产物、目标或有效配置变化时返回 `409`，重新预览确认后再提交。

`GET /deployments` 返回 `previousDeploymentId`，指向同一目标上一成功的部署记录。发布结果不确定时状态为 `NEEDS_ATTENTION`。启用 AI 分析后，`GET /tasks/:id` 的 `result.aiAnalysis` 异步附加 `{status:"SUCCESS",summary,failedPhase,nextActions}` 或 `{status:"UNAVAILABLE"}`。

### 发布保护与回滚

管理员通过服务环境配置的 `releasePolicy` 设置 `requireApproval`、`rollbackMode`（`OFF`、`PREVIOUS_HEALTHY`、`PINNED`）、可选的 `pinnedDeploymentId`、`archivePushedImage` 和 `healthCheck`。健康检查包含可选的 `httpUrl`、`compose`，以及 `attempts`、`intervalSeconds`、`timeoutSeconds`。文件服务环境可另配置 `stopCommand`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/deployments/approvals` | 管理员查看等待批准的发布任务及提交、产物和服务器 ID。 |
| `POST` | `/deployments/approvals/:id/approve` | 管理员批准固定目标和产物。返回任务。 |
| `POST` | `/deployments/:id/rollback/preview` | 预览使用历史发布快照回滚的范围，返回 `confirmationHash`。 |
| `POST` | `/deployments/:id/rollback` | 提交预览的 `confirmationHash` 开始回滚，返回可能仍待审批的任务。 |

Pipeline 和产物部署预览的 `requireApproval` 表示部署是否需要管理员批准。部署任务的 `approvalStatus` 为 `PENDING`、`APPROVED` 或 `null`。`GET /deployments` 提供 `isCurrent`、`rollbackAvailable`、`rollbackOfDeploymentId` 和关联任务 ID。

### 产物保留

| 方法与路径 | 用途 |
| --- | --- |
| `GET /artifact-retention/policy` | 读取有效保留策略和 `inherited` 状态。 |
| `PUT /artifact-retention/policy` | 保存 `{maxBuilds,maxDays}`，限制分别为 1–1000 批和 1–3650 天。 |
| `DELETE /artifact-retention/policy` | 删除服务环境覆盖，恢复继承系统策略。 |
| `PUT /artifact-retention/artifacts/:id/pin` | 以 `{pinned:true}` 固定产物，以 `{pinned:false}` 解除固定。 |
| `GET /artifact-retention/preview` | 返回候选总组数 `total` 和最多 50 组 `candidates`，相同归档文件的记录归在一组。每组返回 `artifactIds`、`createdAt` 和 `sizeBytes`。 |
| `POST /artifact-retention/prune` | 接受 `{artifactIds,confirmed:true}`，每组选一个 ID。执行时复核保护并返回 `pruned`、`skipped` 和 `failed` 的产物 ID。 |

这些接口需要管理员权限。策略接口同时传入 `serviceId` 和 `environmentId` 查询参数可管理服务环境覆盖，省略时操作全局策略，删除覆盖时必须指定服务环境。

默认保留最近 20 批且在 30 天内的构建产物。Worker 定期清理超限的托管归档，保护当前运行版本、回滚基线、排队或执行中的任务和人工固定的产物。外部 Registry 与旧目标端归档由各自的存储策略保留。`GET /artifacts` 保留已清理记录，`prunedAt` 表示托管归档停止使用，`archiveDeletedAt` 记录本地文件清理完成的时间。Registry Digest 可用时仍能用于发布。物理删除失败的归档会在后续清理时重试。

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
