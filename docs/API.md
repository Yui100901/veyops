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

## 资源

| 方法                 | 路径                       | 请求 / 说明                                                                                                  |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GET / POST           | /credentials               | 列表 / `{name,type,secret,metadata?}`                                                                        |
| PATCH                | /credentials/:id           | `{name?,secret?,status?:'ACTIVE'\|'DISABLED'}`                                                               |
| DELETE               | /credentials/:id           | 引用检查后删除                                                                                               |
| GET / POST           | /servers                   | 列表 / `{name,host,port?:22,username,credentialId,hostKeyFingerprint,tags?}`                                 |
| GET / PATCH          | /servers/:id               | 详情 / 完整服务器配置                                                                                        |
| DELETE               | /servers/:id               | 软移除，不删除历史                                                                                           |
| POST                 | /servers/:id/test          | 只读连接检查，返回 `{success,server,result:{exitCode,output}}`                                               |
| GET / POST           | /server-groups             | 列表 / `{name,description?,serverIds:[]}`                                                                    |
| DELETE               | /server-groups/:id         | 删除分组关联                                                                                                 |
| GET / POST           | /projects                  | 列表 / `{name,slug,description?,tags?}`                                                                      |
| GET / PATCH / DELETE | /projects/:id              | 详情 / 完整基本配置 / 软删除                                                                                 |
| POST                 | /projects/:id/repositories | `{name,cloneUrl,defaultBranch?,credentialId?}`                                                               |
| POST                 | /projects/:id/services     | `{name,slug,serviceType:'WEB'\|'API'\|'WORKER'\|'SCHEDULED_JOB'\|'STATIC_SITE'\|'DOCKER_SERVICE'\|'CUSTOM'}` |
| POST                 | /projects/:id/environments | `{name,slug,environmentType:'DEVELOPMENT'\|'TESTING'\|'STAGING'\|'PRODUCTION'\|'CUSTOM'}`                    |
| GET                  | /dashboard                 | 全量服务器/项目/任务计数、活跃任务计数、最近任务                                                             |
| GET                  | /audit                     | 最近200条非敏感操作审计                                                                                      |
| GET                  | /system                    | 当前版本、数据库、Worker与能力开关                                                                           |

凭据 `type` 包括 SSH_PASSWORD、SSH_KEY、GIT_TOKEN、GIT_PASSWORD、API_KEY、API_SECRET、DOCKER_REGISTRY、USERNAME_PASSWORD、CUSTOM_SECRET。SSH_PASSWORD 使用 `secret:{password}`；SSH_KEY 使用 `{privateKey,passphrase?}`；GIT_TOKEN 使用 `{token}`；API_KEY 使用 `{apiKey}`。GET 永不返回 secret、ciphertext、nonce、auth_tag。

## 命令

`POST /commands/preview` 解析目标数量与摘要。

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

返回 Task，默认等待数据库 Worker 执行。未显式确认、空目标、无效目标均拒绝。也支持 `groupIds`、`deploymentTargetIds`、`tags` 目标选择（并集去重），部署目标管理 API 和项目环境选择尚待后续实现。具体 DTO 见源码。`strategy` 为 PARALLEL/SEQUENTIAL；`failurePolicy` 为 STOP/CONTINUE；超时单位秒。`GET /commands/executions` 返回命令历史。

## 任务与日志

| 方法 | 路径                            | 说明                                                                                     |
| ---- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| GET  | /tasks                          | 最近100条任务                                                                            |
| GET  | /tasks/:id                      | `{id,type,name,status,createdBy,createdAt,startedAt,finishedAt,errorSummary,result,...}` |
| GET  | /tasks/:id/targets              | 每目标名称、Host、状态、退出码、错误摘要                                                 |
| GET  | /tasks/:id/steps                | 每目标步骤记录                                                                           |
| GET  | /tasks/:id/logs?offset=0        | `{content,nextOffset}`；偏移单位字节，单次最多256 KiB                                    |
| GET  | /tasks/:id/logs/stream?offset=0 | SSE，事件 `{content,nextOffset,status}`，id为偏移；支持Last-Event-ID                     |
| POST | /tasks/:id/cancel               | PENDING直接取消；RUNNING请求取消；终态拒绝                                               |

终态为 SUCCESS、FAILED、PARTIAL_FAILED、CANCELLED、TIMED_OUT、NEEDS_ATTENTION。Worker 租约过期进入 NEEDS_ATTENTION，不隐式重试。

## 运维方案

`GET /operation-plans`；`POST /operation-plans`；`PATCH /operation-plans/:id`；`GET /operation-plans/:id/versions`；`POST /operation-plans/:id/run`。

创建与更新：

```json
{
  "name": "只读检查",
  "description": "检查系统版本",
  "category": "CUSTOM",
  "steps": [{ "name": "系统信息", "command": "uname -srm", "timeout": 30 }]
}
```

每次更新创建新版本。run使用命令同样的目标/执行策略字段，可传 `version` 固定版本；必须 `confirmed:true`。系统预置巡检与三个软件初始化模板，安装模板不会自动执行。参数定义、前后置检查独立模型、删除及单目标重试待完善。

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
| GET              | /artifacts                                         | 产物列表，支持 `projectId` 和 `pipelineRunId` 筛选，返回 `downloadAvailable`                              |
| GET              | /artifacts/:id/download                            | 登录后下载平台归档，响应头 `X-Artifact-SHA256` 提供校验和                                                 |
| GET              | /deployments                                       | 逐服务器交付记录，支持projectId筛选                                                                      |
| GET/POST         | /registries                                        | Registry列表/创建（创建仅ADMIN）                                                                         |
| PATCH            | /registries/:id                                    | 管理员编辑 Registry，`credentialId:null` 可解除凭据关联                                                   |
| POST             | /registries/:id/test                               | 管理员从管理端测试 HTTPS Registry V2 连通与认证，返回 `{success,authenticated,message}`                  |

管理员和操作员可调用 `/projects/:projectId/repositories/:repositoryId/connection`、`/branches` 和 `/commits` 的 GET 接口检查仓库、读取分支和查询最近提交。`/commits` 接受 `branch` 和 `limit`，默认 20 条，最多 50 条。给仓库绑定凭据需要管理员角色。

Pipeline 定义、四种组合、目录保护和环境覆盖规则见 [构建部署说明](PIPELINES.md)。环境配置字段包括 `targetId,buildLocation,artifactType,deployMethod,deployPath,buildCommand,workingDirectory,outputPath,composeFilePath,startCommand,healthCheckCommand`。敏感变量只接收凭据引用；普通值和引用二选一。

`GET /deployments` 返回 `previousDeploymentId`，指向同一目标上一成功的部署记录。发布结果不确定时状态为 `NEEDS_ATTENTION`。启用 AI 分析后，`GET /tasks/:id` 的 `result.aiAnalysis` 异步附加 `{status:"SUCCESS",summary,failedPhase,nextActions}` 或 `{status:"UNAVAILABLE"}`。

## v0.2 AI 接口

| 方法         | 路径                           | 说明                                                                                                      |
| ------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| GET/POST     | /ai/providers                  | 列表/管理员创建：`{name,baseUrl,model,apiKey?或credentialId?,enabled?,timeoutSeconds?}`                   |
| PATCH/DELETE | /ai/providers/:id              | 管理员更新/删除                                                                                           |
| POST         | /ai/providers/:id/test         | 管理员测试模型连接，安全摘要响应                                                                          |
| GET/PATCH    | /ai/policies                   | 查询/管理员保存系统或项目策略                                                                             |
| POST         | /ai/chat                       | `{message,conversationId?,projectId?,providerId?}`；返回`{conversationId,message,proposals,tasks,drafts}` |
| POST         | /ai/repository-analysis        | 管理员或操作员按 `{projectId,repositoryId,serviceId,environmentId,commitSha,docPath?}` 读取部署文档并生成草稿 |
| GET          | /ai/conversations              | 仅当前用户的会话                                                                                          |
| GET          | /ai/conversations/:id/messages | 仅会话发起者可读                                                                                          |
| GET          | /ai/proposals                  | 当前用户的执行提案                                                                                        |
| POST         | /ai/proposals/:id/confirm      | 重新校验权限、目标与配置后最多提交一次                                                                    |
| POST         | /ai/proposals/:id/reject       | 拒绝提案，不执行                                                                                          |

API Key 不回显，更新时省略 Key 表示保留。AI 为空或禁用不会影响手工运维。策略与工具限制见 [AI 说明](AI工具与权限.md)。

仍未开放：备份恢复、聚合视图、用户管理、完整可编辑系统运行参数等接口。
