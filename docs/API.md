# VeyOps API

前缀 `/api/v1`。成功：`{"data": ...}`；错误：`{"error":{"code":"HTTP_400","message":"..."}}`。SSE 使用标准事件格式。时间为 UTC 毫秒；ID 为 UUID。所有资源默认需要登录，同团队可读；写接口限定 ADMIN/OPERATOR，凭据管理仅 ADMIN。Cookie `veyops_session` 为 HttpOnly、SameSite=Strict，会话 12 小时；浏览器请求必须同源。生产无匿名 Swagger。

## 认证

| 方法 | 路径                            | 请求 / 说明                                                                                   |
| ---- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| GET  | /health                         | 匿名服务健康状态                                                                              |
| GET  | /auth/status                    | 匿名 `{initialized:boolean}`                                                                  |
| POST | /auth/login                     | `{username,password}`，返回当前用户，设置 Cookie                                              |
| GET  | /auth/me                        | 当前用户 `{id,username,role,mustChangePassword,passwordChangeRecommended}`                    |
| POST | /auth/dismiss-password-reminder | 跳过当前账号的可选改密提醒，保留密码和会话                                                    |
| POST | /auth/change-password           | `{currentPassword,newPassword}`；新密码 12–256 位且不同于原密码。成功后撤销账号会话，重新登录 |
| POST | /auth/logout                    | 撤销当前会话                                                                                  |

角色为 ADMIN、OPERATOR、VIEWER。空库启动时创建 `root`，使用 `ADMIN_PASSWORD` 或控制台中的随机初始密码。`passwordChangeRecommended` 提示空库管理员修改初始密码，可跳过并继续访问业务接口。用管理员发放或重置的临时密码登录时，`mustChangePassword` 为 `true`，会话只可读取 `/auth/me`、改密或退出。登录入口按 IP 限速。

## 用户管理

下列接口要求已完成首次改密的管理员会话。用户信息包含 `id`、`username`、`role`、`status`、`mustChangePassword`、`createdAt` 和 `updatedAt`。

| 方法  | 路径                      | 请求 / 说明                                            |
| ----- | ------------------------- | ------------------------------------------------------ |
| GET   | /users                    | 列出包括停用状态在内的账号                             |
| POST  | /users                    | `{username,role,password}`，创建启用账号并要求首次改密 |
| PATCH | /users/:id                | `{role?,status?}`，更新角色或启停状态                  |
| POST  | /users/:id/reset-password | `{password}`，设置临时密码并要求下次登录改密           |

用户名区分大小写，长度为 2–64，首字符为英文字母或数字，其余字符还可使用点、下划线和短横线。创建后用户名固定。临时密码须为 12–256 个字符，仅通过请求提交。状态为 `ACTIVE` 或 `DISABLED`。

修改角色、启停状态或重置密码时，服务撤销该账号的会话并记录审计，响应和审计均不包含密码或密码哈希。管理员通过 `/auth/change-password` 修改自己的密码。停用账号保留已有操作及资源归属记录。

## 资源

`GET /projects/:projectId/resource-references` 返回 `{servers, references}`。服务器按 ID 合并，列表保留直接选择、分组成员、旧部署目标及执行图等来源。每条引用包含 `resourceType`、`resourceId`、`sourceKind`、`sourceId`、`state`，并按来源附带服务、环境、图版本、节点、触发器、运行、任务或分组 ID。`CONFIGURED` 表示配置中使用，`DRAFT` 表示草稿引用，`RUNNABLE` 表示可运行版本或已启用规则，`PENDING` 表示尚未完成的运行或任务，`HISTORY` 表示冻结的历史来源。`RUN` 来源包含该次确认的计划和候选目标，逐目标结果以任务或部署记录为准。仅在某次运行选中的主机通过运行或任务来源追溯。两项目共享同一主机时，各自返回本项目的来源。

项目仓库、服务和环境移除后归档并退出新选择，历史数据继续使用原 ID。仍有可运行、已配置或待执行引用时返回 409，`error.references` 提供需先调整的来源。草稿保持可编辑，发布时重新校验归属和可用状态。

### 执行配置归属

执行预览按下列规则解析配置并返回生效来源，资源查询以已保存配置和执行快照为准。

| 字段                                   | 所属配置与顺序                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 构建位置、并发、工作区根目录、日志保留 | 系统默认，项目可覆盖。预设的开始节点可设置 `buildLocation` 为 `INHERIT`、`MANAGER` 或 `TARGET`。已声明且允许调整的运行参数可指定并发。     |
| 代码与构建产物                         | Git 节点固定仓库、ref 和实际 SHA。构建节点声明工作目录、命令及具名产物，部署节点绑定已登记产物。                                           |
| 环境文件和变量                         | 简化执行流可在开始节点选择仓库中的文件和项目变量集合。变量由低到高为仓库文件、项目公共变量、所选集合、开始节点变量。平台保留键由系统赋值。 |
| 构建和发布目标                         | 功能节点各自绑定平台服务器或分组。发布目录及启停配置由部署节点声明。                                                                       |

| 方法                 | 路径                                                                   | 请求 / 说明                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| GET / POST           | /credentials                                                           | 列表 / `{name,type,secret,metadata?}`                                                                                                       |
| PATCH                | /credentials/:id                                                       | `{name?,secret?,status?:'ACTIVE'\|'DISABLED'}`                                                                                              |
| DELETE               | /credentials/:id                                                       | 引用检查后删除                                                                                                                              |
| GET / POST           | /servers                                                               | 列表 / 创建时提交 `{name,host,port?:22,username,credentialId,hostKeyAcceptanceToken,tags?,description?}`                                    |
| POST                 | /servers/host-key/probe                                                | 提交 `{host,port?,serverId?}`，握手读取公钥并返回算法、指纹、一次性接受令牌及有效期                                                         |
| POST                 | /servers/:id/host-key/accept                                           | 对已有服务器提交 `{hostKeyAcceptanceToken}`，确认探测到的新指纹                                                                             |
| GET / PATCH          | /servers/:id                                                           | 详情含 `active`、分组、项目引用、探测及执行历史，停用服务器仍可查看历史 / 完整服务器配置                                                    |
| DELETE               | /servers/:id                                                           | 软移除，不删除历史                                                                                                                          |
| POST                 | /servers/:id/test                                                      | 只读连接检查，返回 `{success,server,result:{exitCode,output}}`                                                                              |
| GET / POST           | /server-groups                                                         | 列表 / `{name,description?,serverIds:[]}`                                                                                                   |
| GET / PATCH / DELETE | /server-groups/:id                                                     | 详情含有序的启用成员 `serverIds` 和项目引用 `projects` / 更新分组和成员 / 删除分组                                                          |
| GET                  | /servers/:id/project-references、/server-groups/:id/project-references | 查询该全局目标被项目使用的来源                                                                                                              |
| GET / POST           | /projects                                                              | 列表支持 `?include=addresses`，追加按服务和服务内顺序排列的地址，含 `serviceId`、`serviceName`。创建时提交 `{name,slug,description?,tags?}` |
| GET / PATCH / DELETE | /projects/:id                                                          | 详情 / 完整基本配置 / 软删除                                                                                                                |
| POST                 | /projects/:id/repositories                                             | `{name,cloneUrl,defaultBranch?,credentialId?}`                                                                                              |
| GET / POST           | /projects/:id/services                                                 | 读取项目的可用服务 / 创建服务及有序地址                                                                                                     |
| GET / PATCH / DELETE | /projects/:id/services/:serviceId                                      | 读取服务及地址 / 按共同修订保存 / 归档服务                                                                                                  |
| GET / POST           | /projects/:id/environment-sets                                         | 查询或创建可由开始节点引用的项目变量集合                                                                                                    |
| GET                  | /dashboard                                                             | 服务器、项目、服务和任务统计，最近部署、最近任务及失败任务                                                                                  |
| GET                  | /audit                                                                 | 最近200条非敏感操作审计                                                                                                                     |
| GET / PATCH          | /system                                                                | 查看版本、数据库和当前 API 进程的 Worker / 管理员更新执行默认值和日志保留期                                                                 |

凭据 `type` 包括 SSH_PASSWORD、SSH_KEY、GIT_TOKEN、GIT_PASSWORD、API_KEY、API_SECRET、DOCKER_REGISTRY、USERNAME_PASSWORD、CUSTOM_SECRET。SSH_PASSWORD 使用 `secret:{password}`；SSH_KEY 使用 `{privateKey,passphrase?}`；GIT_TOKEN 使用 `{token}`；API_KEY 使用 `{apiKey}`。GET 永不返回 secret、ciphertext、nonce、auth_tag。

仓库可通过 `PATCH /projects/:id/repositories/:resourceId` 更新，或通过同路径的 `DELETE` 归档。仓库凭据传 `null` 可解除关联。有效配置、可运行版本或在途任务仍引用资源时返回 409。只有已完成历史引用的资源可归档，历史继续使用原 ID 和快照。

项目详情在 `services` 中返回服务及地址，并包含仓库、环境、`deploymentTargets` 和 `recentDeployments`。管理员可以通过 `DELETE /projects/:id` 软删除项目。

### 服务与访问地址

创建服务提交 `{name,slug,serviceType?,description?,addresses?}`。`serviceType` 默认为 `WEB`，也可选 `API`、`WORKER`、`SCHEDULED_JOB`、`STATIC_SITE`、`DOCKER_SERVICE` 或 `CUSTOM`。服务响应包含 `projectId`、`revision` 与有序的 `addresses:[{id,name,url}]`。创建后 `revision` 为 1。所有登录角色可读取，管理员和操作员可保存及归档。

更新时传入 `expectedRevision` 和需要修改的字段。省略 `addresses` 时保留地址，传空列表时清空，传非空列表时按所给顺序完整保存。已有行携带所属服务的地址 ID，新行省略 ID。每次可保存最多 100 条地址，链接使用不含凭据的绝对 HTTP(S) URL。服务、地址和审计在同一事务内更新，每次保存成功递增一次修订。

地址校验失败返回 400，`error.details.fieldErrors` 包含 `{path,code,message}`，例如第二条地址的 URL 路径为 `['addresses',1,'url']`。修订冲突返回 409 及 `error.details.currentRevision`，可重新读取服务后核对草稿。归档前检查仍生效的引用，冲突响应使用 `error.references`。

`GET /projects/:id/services/:serviceId/recent-deployments` 返回该服务最近五条逐目标部署记录。传入 `environmentId` 时先按环境过滤。服务和环境须为该项目的可用资源。

### 全局服务器与分组

服务器和分组列表供各项目选择同一全局资源 ID。服务器详情和分组详情中的 `projects`，以及独立的 `project-references` 接口，使用 `{id,name,slug,references}` 对应引用该目标的项目。每条引用可定位配置、图版本、运行、任务或用于选择该服务器的组。管理员管理服务器登记、连接配置、指纹、停用和分组。管理员和操作员可发起连接检查与配置对比。

### 环境变量集合

以下接口位于 `/projects/:projectId/environment-sets`。

| 方法及路径                           | 请求和结果                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `GET /`、`GET /:setId`               | 列出可用集合或读取包含变量项的详情。集合响应含 `id`、`name`、`description` 和 `revision`。 |
| `POST /`                             | 创建集合，提交 `{name,description?,variables?}`。                                          |
| `PATCH /:setId`                      | 提交 `{expectedRevision,name?,description?,variables?}`。省略变量数组时保留，空数组清空。  |
| `DELETE /:setId`                     | 提交 `{expectedRevision}`，归档集合。                                                      |
| `POST /:setId/variables/:key/reveal` | 管理员临时读取该敏感值，写入查看审计。                                                     |

每个变量提交 `key`、可选 `description` 和普通 `value`。敏感项使用 `isSecret:true`，同时提交一个新 `value`、管理员绑定的 `credentialId` 或 `keepSecret:true`。集合详情与导出默认掩码。写入校验失败返回 `error.details.fieldErrors`，修订冲突返回 `error.details.currentRevision`。归档集合从新计划选择中退出，已确认的运行及历史继续读取其快照。

### 项目内交付

项目交付页使用 `GET /projects/:id/delivery-context` 加载项目、服务、仓库和环境。已删除项目仍可查看历史，返回 `archived: true`。`archivedServices`、`archivedEnvironments` 和 `archivedRepositories` 供历史筛选核对归属。以下列表在数据库内先应用筛选，再返回最近的记录。

| 请求                                     | 项目内筛选与追溯                                                                                                                                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /projects/:id/execution-graph/runs` | 读取执行流运行记录，通过运行详情获取关联任务和日志。                                                                                                                                                                                          |
| `GET /artifacts`、`GET /deployments`     | 支持 `projectId`、上述三个条件及 `taskId`、`recordId`。有执行图来源时返回 `graphRunId`、`graphVersion`、`graphFlowName` 和 `graphNodeName`。逐服务器发布还返回当次的 `serverName`、`serverHost`、`serverPort` 快照和实际使用的 `artifactId`。 |
| `GET /deployments/approvals`             | 管理员可查询旧交付的待审批记录。新的审核、审批和回滚通过执行图运行接口处理。                                                                                                                                                                  |

产物和部署列表可附加 `repositoryId`。同时传入提交前缀 `commit` 时，两个条件匹配同一项产物来源。产物的 `sources` 列出实际绑定并供构建使用的源码工作区及额外文件来源，包含 `repositoryId`、`commitSha`、可用的 `ref`、提交说明 `subject`、相对路径 `path` 和 `workspace` 节点引用。空列表表示当前产物缺少可核实来源，旧记录可以省略该字段。触发事件另由 `sourceEvent` 返回。镜像档案可返回 `imageOrigin` 及归档内的 `composeTemplate` 路径与摘要。登记现有镜像时，`sourceImageReference` 记录登记来源，Git 来源列表为空。

### 历史服务环境 Compose 模板

- `GET /services/:serviceId/environments/:environmentId/compose-templates` 返回 `revision` 和最近 100 个 `versions` 的元数据。修订号 0 表示默认使用产物归档。
- `GET /services/:serviceId/environments/:environmentId/compose-templates/:id` 供管理员和操作员读取指定历史版本的内容，读取记入审计。新部署在图节点选择归档模板或固定仓库文件。

图内交付预览包含所选 Compose 来源。历史产物显示归档路径、摘要和固定镜像引用。成功激活的交付记录可返回 `composeRelease`，包括校验过的 `template`、实际使用的 `imageReference` 和 `imageId`。

### 首页汇总

`GET /dashboard` 返回 `servers`、`projects`、`services`、`totalTasks`、`activeTasks`、`recentDeployments`、`recentTasks` 和 `recentFailedTasks`。

- `services` 包含 `total`、`running` 和 `abnormal`。统计未删除项目，每个服务只计一次。按服务、环境和启用服务器分别取最新部署记录。任一记录显示部署失败、部分失败、超时、需要检查或健康失败、未知时，服务计为异常。没有异常且至少一个目标的部署成功并通过健康检查时，服务计为运行中。未部署和未验证的服务只计入总数。
- `recentDeployments` 最多六条逐服务器发布记录，含项目、服务、环境、服务器、对应任务、发布版本、执行和健康状态。按开始时间降序，未记录开始时间时使用交付任务的创建时间。已停用服务器的历史发布仍可查看。
- `recentTasks` 和 `recentFailedTasks` 分别最多六条。后者独立查询 `FAILED`、`PARTIAL_FAILED`、`TIMED_OUT` 和 `NEEDS_ATTENTION`，较旧的失败任务不会被新的成功任务挤出。

### 备份

以下接口仅管理员可用。返回的备份元数据含 `id`、`createdAt`、`databaseClient` 和 `fileCount`，其中 `fileCount` 包含数据库快照和托管文件。

| 方法 | 路径                  | 说明                                                        |
| ---- | --------------------- | ----------------------------------------------------------- |
| GET  | /backups              | 列出本实例备份目录中具有有效认证清单的备份                  |
| POST | /backups              | 创建在线备份，完成后返回元数据和状态码 201                  |
| POST | /backups/:id/verify   | 校验清单和文件 SHA-256，成功返回元数据                      |
| GET  | /backups/:id/download | 返回校验后的 `.tar.gz` 流，禁止缓存，解压目录可用于离线恢复 |

备份目录固定为 `DATA_DIR/backups`。在线备份先生成数据库快照，再复制托管文件。需要数据库和文件位于同一维护窗口时，使用停机备份。恢复步骤见 [数据备份与恢复](BACKUP.md)。

## 项目工作台地址

| 入口     | 页面地址                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目资源 | `#/projects/:id` 默认入口。`resource` 选择 `repositories`、`services` 或 `environment-sets`，可用 `repositoryId`、`serviceId`、`environmentSetId` 定位。      |
| 执行图   | `#/projects/:id/execution-graph`。使用 `start`、`run`、`pane`、`version`、`node` 和 `flow` 定位。服务详情打开开始节点时带入 `serviceId`。                     |
| 产物     | `#/projects/:id/artifacts`。`artifactId` 定位产物，可按服务及源码筛选，验证、固定保留、提交清理或跳转到生产节点。部署、回滚和待审批事项从执行图运行详情查看。 |
| 项目配置 | `#/projects/:id/configuration`。同页维护基本信息、执行默认值、项目公共变量和 AI 策略。                                                                        |

`view` 和 `viewSearch` 保留返回的项目视图及筛选。平台服务器通过 `#/servers?serverId=:serverId` 或 `#/servers?groupId=:groupId` 打开详情。项目来的链接可附 `projectId` 和该项目的 `returnPath`。服务链接按照已发布开始节点配置的服务筛选执行流。

## 项目执行图

以下路径使用前缀 `/projects/:projectId/execution-graph`。登录用户可查询。管理员和操作员可保存、发布和运行简化执行图 `FLOW_V2`。

| 方法与相对路径                                                      | 请求与结果                                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                                                             | 查询项目图、草稿修订号和当前发布版本。                                                                                                                                                                                              |
| `GET /catalog`                                                      | 返回 `flowTemplates[]`，各项含 `id`、`name`、`steps` 和 `artifactTypes`。现存版本的模块与端口元数据也通过此接口读取。                                                                                                               |
| `POST /draft/templates/expand`                                      | 接收 `{templateId,artifactType?,model?}`，返回 `{canvas,startId}`。默认使用 `FLOW_V2` 和目录交付模板。管理员和操作员可通过草稿接口按修订号保存。                                                                                    |
| `POST /validate`                                                    | 提交 `{definition}`。响应的 `issues` 用 `flowId`、`nodeId`、`fieldId` 和 `message` 定位发布问题。图结构检查通过后，汇总各流的绑定问题。已知问题分支可附 `branchId` 和 `edge:{from,to,when?}`。                                      |
| `PUT /draft`                                                        | 提交 `{expectedRevision,definition:{canvas:{model:"FLOW_V2",nodes,edges,endpoints,templates:[]}}}`。可保存未配齐的定义。                                                                                                            |
| `POST /publish`                                                     | 提交 `{expectedRevision}`，校验并固定已保存的图版本。                                                                                                                                                                               |
| `GET /versions`、`GET /versions/:version`                           | 查询发布历史和具体发布版本。                                                                                                                                                                                                        |
| `POST /versions/:version/retire`                                    | 管理员或操作员停用旧发布版。先发布替代版本，再停用绑定该旧版的启用触发器。返回 `{version,retiredAt}`。停用版保留定义和运行历史，在途计划继续保护其资源。                                                                            |
| `POST /versions/:version/restore`                                   | 提交 `{expectedRevision}`，将发布版本载入草稿。                                                                                                                                                                                     |
| `POST /flows/:flowId/preview`                                       | 提交 `{version,inputs:{parameters}}`。返回 `configurationHash`、`planSections`、参数和来源、`environmentSet`、`checkouts`、`deliveries`、图内审核及保护节点 `gates` 与节点端口证据。                                                |
| `POST /flows/:flowId/run-defaults`                                  | 提交 `{version,idempotencyKey}`。按最新发布版的默认值生成并确认计划，返回 `{outcome:"STARTED",runId,version}`。审批、回滚或源码审核要求显式确认时返回 `NEEDS_CONFIRMATION`。                                                        |
| `POST /publication-impact`                                          | 提交 `{expectedRevision}`，返回准备发布的版本，以及新增、修改、移除的执行流和相关触发规则。                                                                                                                                         |
| `POST /flows/:flowId/run`                                           | 提交同样的版本和输入，附 `expectedConfigurationHash` 和 `idempotencyKey`。可原样传回 `planSections` 为 `expectedPlanSections`。配置变更返回 409，`error.changes` 给出失效字段或计划段落，重新预览后方可确认。相同确认可取回原运行。 |
| `GET /runs`、`GET /runs/:runId`                                     | 查询运行、任务和结束节点的 `outputs`。节点详情含 `inputs`、`environment`、`output`、逐目标状态和可定位的 `issue`。                                                                                                                  |
| `GET /runs/:runId/nodes/:nodeId/logs?offset=0`                      | 从字节偏移读取该节点日志，返回来源、摘要、状态、时间和下一偏移。                                                                                                                                                                    |
| `POST /runs/:runId/cancel`                                          | 取消运行及尚未完成的节点和子流。                                                                                                                                                                                                    |
| `POST /runs/:runId/nodes/:nodeId/decision`                          | 管理员提交 `{decision:"APPROVE"\|"REJECT",expectedScopeHash?}`。源码审核与绑定发布的审批必须传回等待节点 `output.scopeHash`。响应保留实际范围、决定、操作者及时间。                                                                 |
| `POST /runs/:runId/nodes/:nodeId/targets/:serverId/inspect-release` | 管理员或原发起操作员核查已结束的失败或待核查目标。返回 `CURRENT`、`PREVIOUS`、`NO_ACTIVE_RELEASE` 或 `UNKNOWN`，附时间及可确认的发布和锁信息。仅执行远端读取并写审计；运行详情的逐目标 `inspection` 返回最近一次核查。              |

内置模板 ID 为 `MINIMAL_CI_CD`、`COMPLETE_CI_CD`。两套模板各生成三个端点，`startId` 指向「构建并部署」入口。最小模板生成 8 个节点和 7 条线，完整模板生成 11 个节点和 10 条线。新项目以最小目录产物模板保存修订 `1`。预览响应的 `routing` 区分已纳入、待分支决定、本次跳过和流外连线。条件分支 `branch.cases` 使用 `{id,value,label?}`，连线按 `CASE:<id>` 或 `DEFAULT` 识别。

服务卡片通过 `GET /projects/:id/recent-service-graph-runs` 读取最近的相关图运行。可对单个服务请求 `GET /projects/:id/services/:serviceId/recent-graph-runs`。关联来自实际任务或仍在等待的已确认交付节点。

预览或确认时发现明确的运行条件问题，可通过 `error.planIssue` 获取 `code`、`message` 和已知的 `flowId`、`flowName`、`nodeId`、`nodeName`、`fieldId`、`fieldName`。问题类别包括 `INPUT`、`REPOSITORY`、`BUILD_TARGET`、`RELEASE_TARGET`、`ARTIFACT`、`SOURCE_REVIEW` 和 `CONFIGURATION`。绑定到开始参数时可附 `parameterId`，定位目标问题时可附 `serviceId`、`environmentId` 和 `targetSource`。源码审核问题可附 `repositoryId` 与完整的 `commitSha`。成功预览会提供本次运行的产物节点及输出字段，或已固定的历史制品。存在多个候选来源时，各候选可附实际源码快照和对应审核记录。发布审批以 `requireApproval` 单独表示。

### 简化执行流 `FLOW_V2`

`canvas.endpoints` 中每条记录保存 `{startId,endId}`。开始节点在 `start` 中集中选择资源。结束节点在 `finish` 中描述留档和验收。动作按连线共享当前运行的工作目录，运行详情用内置事实记录检出版本、工作目录、审批、发布及健康检查。

模板展开生成三个入口及共享节点。将返回的节点、连线和端点整体追加到现有 `FLOW_V2` 画布，再按草稿修订号保存。

| 位置                                                    | 字段                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `START.start.sources[]`                                 | `{id,repositoryId,ref?}`。`ref` 为 `{kind:"BRANCH"\|"TAG"\|"COMMIT",value}`。留空时使用仓库默认分支。各仓库在工作区下以克隆地址末段去掉 `.git` 命名。预览固定实际 SHA。                                                                                                             |
| `START.start.execution`                                 | `{location:"INHERIT"\|"MANAGER"\|"TARGET",serverId?,groupId?}`。目标端需要一台服务器或可解析为单台服务器的分组。                                                                                                                                                                    |
| `START.start.release`                                   | `{serviceId?,targets?,artifactSource?,artifactId?,useUpstreamArtifact?,allowArtifactOverride?}`。`targets` 包含 `serverIds`、`groupIds` 及可选的 `strategy`、`maxParallel`、`failurePolicy`。发布位置由系统按项目和服务分配。发布目标独立于执行服务器。文件部署交付整个可分发目录。 |
| `START.start.environmentSetId`、`variables[]`、`dotenv` | 变量条目为 `{key,value?,credentialId?,allowOverride?}`，仓库变量文件为 `{sourceId,path}`。敏感值通过凭据引用。                                                                                                                                                                      |
| 功能节点                                                | 代码拉取使用 `checkout.fullClone`。构建使用 `build.repoPath`、`installCommand`、`buildCommand`、`buildImage`。检查和 Shell 使用 `shell.directory`、`command`、`timeout`。文件部署使用 `deploy.method:"FILE"` 和选填的停止、启动命令。                                               |
| 条件节点                                                | 用 `condition.parameterKey`、`branch.parameterKey` 或 `switch.parameterKey` 读取开始节点显式声明的普通变量。默认使用运行条件值。                                                                                                                                                    |
| `END.finish`                                            | `{saveWorkspace?,retention?:"PERSISTENT"\|"RUN",images?,requireRelease?:"ACTIVATED"\|"HEALTHY"}`。发布开始前登记并校验实际执行目录。结束阶段核对要求的发布状态。                                                                                                                    |

运行时 `inputs.parameters` 使用 `var:<key>` 或 `artifactId` 提供开始节点允许的参数。Git 版本由发布版的开始节点固定，匹配的仓库推送和轮询采用事件提交。仓库、执行位置、目标及凭据随发布版固定。开始节点设置了 `useUpstreamArtifact` 时，上游成功事件继承实际登记并符合条件的产物。模板或草稿出现所需资源缺失、旧端口、无效路径或当前版本尚未支持的动作时，发布检查返回定位诊断。

纯构建使用 `inputs.parameters.workspaceArtifactId` 选择同项目的持久目录产物。存在拉取动作且未配置仓库时，该参数必填并限定手动运行。`GET /artifacts?projectId=:id&kind=DIRECTORY` 的 `workspaceReusable` 标记候选目录。预览和运行详情的 `simplified.workspaceSource` 区分 `NEW` 和 `HISTORICAL`，历史模式附带实例、来源运行和固定提交。本次执行使用新工作区，代码拉取记录 `checkoutSkipped: "HISTORICAL_WORKSPACE"`。

目标端按 `<工作根目录>/<项目标识>/<执行 ID>` 创建工作区，默认工作根目录是 `~/.veyops/workspace`。`END.finish.saveWorkspace` 省略时默认直接保留实际使用的整个执行目录。`retention: "RUN"` 只保留本次临时快照。`saveWorkspace: false` 时，本次文件发布仍会固定临时实物。临时实例可在运行详情中识别，历史选择器仅提供持久实例。历史发布使用既有实例，本次另外生成的工作区按结束规则处理。

`END.finish.images` 为 `{id,name,source,reference?,registryId?}[]`。每条流内登记名称规范化为小写且唯一，`id` 用于稳定引用。`BUILT_IN` 采用 `BUILD.build.dockerfilePath` 构建出的实际 Image ID。`WORKSPACE` 读取 `<name>:<VEYOPS_IMAGE_TAG>`，该保留变量由运行 ID 导出。`REGISTRY` 需要 `registryId` 和带固定 Digest 的完整 `reference`。`START.start.release.imageId` 选择本次 Compose 发布项，只有一项时可省略。启用 `useUpstreamArtifact` 后，可用 `upstreamArtifactName` 选定上游持久产物，实际实例 ID 在触发时固定。

`START.start.release.compose` 使用 `{sourceId?,path}`。省略 `sourceId` 时，从工作区归档所选镜像的 Compose YAML。指定源码时从其已确认提交读取。历史镜像允许使用随产物归档的配置。`ROLLBACK_ARTIFACT` 使用开始节点选定的历史产物和预览时各目标的当前版本，要求人工审批。

`START.start.release.artifactSource: "RUN_PARAMETER"` 允许没有预填产物的仅部署入口发布。发起预览和运行时须提供 `inputs.parameters.artifactId`。固定历史实例或上游产物使用各自的来源配置。纯历史发布路径只应用结束节点的发布核对。纯构建镜像登记项可加 `composePath`，相对本次工作区，供历史镜像部署时读取随附配置。

### 历史执行图

已有旧版发布定义、运行记录和日志保留为只读历史。草稿保存、发布、版本恢复、运行预览和启动使用 `FLOW_V2`。旧触发规则可暂停。需要重新编排时，在草稿画布确认清空历史草稿并建立简化执行图。

构建发布工作台通过 `GET /delivery-flows` 读取简化执行图的草稿、发布状态、关联服务、触发类型及最近运行。

### 执行图触发器

路径前缀为 `/projects/:id/execution-graph`。管理员可在草稿的开始节点保存停用的规则。启用时可带可选的 `version` 来确认当前发布版。兼容发布更新启用规则关联的版本，规则 ID 和 Webhook 地址继续有效。

| 方法  | 路径                                 | 作用                                                                                         |
| ----- | ------------------------------------ | -------------------------------------------------------------------------------------------- |
| GET   | `/triggers`                          | 查看规则的启用状态、下次时间、轮询观察以及已解析的仓库和分支                                 |
| POST  | `/triggers`                          | 创建规则，停用草稿可提交 `draftRevision` 检查草稿冲突                                        |
| PATCH | `/triggers/:triggerId`               | 保存并启用、修改或暂停规则                                                                   |
| POST  | `/triggers/preflight`                | 按同样的规则字段预检，编辑时可提交 `triggerId`。返回发版号、可用状态、定位诊断和三次计划时间 |
| GET   | `/triggers/:triggerId/events`        | 查看事件、接受时的版本和规则修订、当前运行结果。重复的源码观察可追到同一运行                 |
| POST  | `/triggers/:triggerId/rotate-secret` | 轮换专用 Webhook 密钥，响应只返回一次新密钥                                                  |
| POST  | `/triggers/:triggerId/invoke`        | 已认证的 API 调用，提交 `{eventId,inputValue?,repositoryId?,ref?,commitSha?}`                |

- `CRON` 接受五段 `cron` 和可选 IANA `timeZone`。默认 `cronMode:"RUN"` 每次到期运行。使用 `cronMode:"POLL"` 检查指定或继承的仓库分支，可设置 `buildOnFirstObservation`。启用轮询与推送时，同一执行流、仓库、分支的同一次观察共用构建。回退到历史 SHA 仍可构成新变化。
- `UPSTREAM` 按稳定 `upstreamFlowId` 关联同项目的执行流，`upstreamStatus` 默认为 `SUCCESS`。上游结束输出从该次运行实际使用的版本读取。成功规则可用 `{source:"UPSTREAM_OUTPUT",fieldId}` 映射兼容结束字段，跨运行产物使用已登记实例。
- `WEBHOOK` 的 `webhookProtocol:"GITEA"` 核验原始 JSON 的 `X-Gitea-Signature`，使用 `X-Gitea-Event: push` 和 `X-Gitea-Delivery`。`"BEARER"` 使用 `Authorization: Bearer <token>` 提交 `{eventId,ref,commitSha}`。创建时响应给出接收路径和一次性密钥。当前分支变化只固定选中的检出节点，仓库及其凭据由维序配置决定。
- `/api/v1/graph-webhooks/:triggerId/test` 使用与接收端相同的认证和事件校验，记录验证结果。正式投递为 `/api/v1/graph-webhooks/:triggerId`。现有签名模式继续使用 `X-Veyops-Timestamp`、`X-Veyops-Delivery`、`X-Veyops-Signature`。

`parameterMappings` 按开始字段 ID 指定固定值、事件字段或上游输出。事件字段按规则类型开放，包括 `repository`、`commit`、`ref`、`eventId`、`scheduledAt`、`upstreamRunId` 和 `upstreamStatus`。自动运行用已发布默认值填充未映射字段。

自动执行有外部影响的节点时，入口类型须在 API 和执行器进程的 `VEYOPS_AUTO_DELIVERY_TRIGGERS` 中放行。通过 `PATCH /servers/:id/automatic-execution` 提交 `{enabled:true}` 为已验证 SSH 身份的目标授权。目标端使用私有工作目录，管理端运行器使用 `WEBHOOK_BUILD_DOCKER_SOCKET`。发布继续执行已配置的审批、资源权限和产物校验。

## 服务门户、项目发布和服务器

`GET /portal` 接受 `q`、`tag`、`projectId`、`serviceId` 和 `abnormal=true`。异常按服务过滤。当前版本和最近一次发布尝试分别返回，例如当前健康与最近发布失败可以同时存在。健康检查失败、待核查和首次发布失败均计入异常。未检测、未发布、执行中或取消独立展示。

`GET /projects?include=addresses` 返回活动项目和有序服务地址。`GET /delivery-flows` 返回按项目分组的草稿及当前已发布执行流，带草稿存在、未发布修改和最近运行信息。项目卡片的快捷运行提交所显示的版本及幂等键。

`GET /servers/:id` 和 `GET /server-groups/:id` 的 `deployedServices` 按项目服务、实际服务器和发布范围提供当前版本及最近尝试。分组查询使用当前启用成员。只有失败尝试的服务可从原发布记录或门户异常入口查看。

## 系统运行设置

`GET /system` 返回系统执行默认值。`PATCH /system` 接受 `{defaultBuildLocation?,targetWorkspaceRoot?,defaultMaxParallelTargets?,logRetentionDays?}`。仅管理员可修改，省略字段保留原值。构建位置为 `TARGET` 或 `MANAGER`，默认 `TARGET`。目标端工作目录默认 `~/.veyops/workspace`，可设为绝对路径或以 `~/` 开头的子目录。目标并发为 1–10，默认 3。

`GET /projects/:id/execution-settings` 返回 `{system,overrides,effective}`，分别为系统默认值、项目显式覆盖值和项目生效值。管理员可用 `PATCH` 修改同一路径，字段与系统设置一致。单项传 `null` 恢复继承，省略则保留原值。构建配置继承位置时，预览会解析项目当前的默认构建位置。目标端构建预览会返回 `targetWorkspaceRoot`，该值随运行快照保存。

日志保留期为 0–3650 天，默认 0 表示长期保留。Worker 周期性清理已结束且超过所属项目保留期的任务日志，保留任务记录、子步骤、审计和产物。未关联项目的任务使用系统保留期。

批量命令、命令模板及运维方案只选一个项目，或只选该项目下的一个环境时，省略 `maxParallel` 会使用该项目的并发设置。混合选择、跨项目选择或直接选择服务器、分组时，省略并发数会使用系统设置。

## 运维中心与命令

网页入口为 `#/operations`。临时命令、命令模板、运维方案和定时运维分别使用 `#/operations/commands`、`#/operations/templates`、`#/operations/plans`、`#/operations/schedules`。原有 `#/commands`、`#/plans`、`#/tasks/schedules` 书签仍可打开对应分区。

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
| GET  | /tasks/:id/command-reuse        | 管理员或原执行者可读取临时命令及上次确认的目标选择，用于重新预览和确认                   |
| GET  | /tasks/:id/steps                | 每目标步骤记录                                                                           |
| GET  | /tasks/:id/logs?offset=0        | `{content,nextOffset}`；偏移单位字节，单次最多256 KiB                                    |
| GET  | /tasks/:id/logs/stream?offset=0 | SSE，事件 `{content,nextOffset,status}`，id为偏移；支持Last-Event-ID                     |
| POST | /tasks/:id/cancel               | PENDING直接取消；RUNNING请求取消；终态拒绝                                               |

终态为 SUCCESS、FAILED、PARTIAL_FAILED、CANCELLED、TIMED_OUT、NEEDS_ATTENTION。Worker 租约过期进入 NEEDS_ATTENTION，不隐式重试。

任务中心使用 `GET /tasks/center`，按创建时间倒序返回 `{items,nextBefore}`。可传 `status=ALL|ACTIVE|SUCCESS|FAILED`、名称搜索 `q`、每页 `limit` 和上一页的 `nextBefore` 作为 `before`。执行流运行在列表中以 `type: "EXECUTION_FLOW"` 返回一条记录，包含 `projectId`、`flowRunId` 和运行状态。执行流详情沿用项目运行和节点日志接口。

`POST /tasks/:id/targets/:targetId/retry` 接收 `{confirmed:true}`。管理员或提交任务的运维人员可重试明确返回失败退出码的目标，以及执行前已跳过的目标。重试使用原任务的命令或方案版本，生成独立任务并返回 `retryOf`。同一来源目标的重复请求返回同一次重试，下一次重试可从该重试任务发起。

## 定时运维

| 方法          | 路径                                                             | 用途                                                                     |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| GET           | `/operation-schedules`                                           | 列出计划和最近一次执行，管理员可查看所有计划                             |
| GET           | `/operation-schedules/time-zone`                                 | 获取系统默认 IANA 时区                                                   |
| POST          | `/operation-schedules/preview`                                   | 预览版本、参数、目标、命令步骤和之后的触发时间，返回 `configurationHash` |
| POST / PATCH  | `/operation-schedules` 或 `/operation-schedules/:id`             | 创建或编辑，携带预览参数、`enabled` 和 `expectedConfigurationHash`       |
| POST          | `/operation-schedules/:id/enable`                                | 重新预览后携带 `expectedConfigurationHash` 启用                          |
| POST / DELETE | `/operation-schedules/:id/disable` 或 `/operation-schedules/:id` | 停止后续触发或删除计划，已有任务和历史可查                               |
| GET           | `/operation-schedules/:id/runs`                                  | 执行历史及关联任务，可查看跳过、待确认和暂停原因                         |
| POST          | `/operation-schedules/:id/runs/:runId/approve`                   | 提交 `{confirmed:true}` 后复核权限、版本和目标，再入队                   |

预览参数包含 `name`、`kind`（`COMMAND_TEMPLATE` 或 `OPERATION_PLAN`）、`sourceId`、`sourceVersion`、`timing`、`target`。`timing` 使用 `ONCE` 与 `runAt`（Unix 毫秒）、`INTERVAL` 与 `intervalSeconds`，或 `CRON` 与五字段 `cron`。可选 `timeZone` 使用 IANA 名称。`target` 至少选一台 `serverIds` 或一个 `groupIds`。可配置 `parameters`、`strategy`、`maxParallel`、`failurePolicy`、`timeoutSeconds` 和 `requireConfirmation`。逐次确认默认开启。

Worker 为正常轮询保留 5 秒容差。到期超过 5 秒的执行按漏跑保存，周期计划继续等待下一个有效时刻。

## 站内与邮件通知

| 方法      | 路径                                                                           | 用途                                                                      |
| --------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| GET       | `/notifications`                                                               | 返回 `items` 和 `unreadCount`，支持 `projectId`、`level` 和 `unread` 过滤 |
| GET       | `/notifications/unread-count`                                                  | 获取个人未读数                                                            |
| PATCH     | `/notifications/:id/read` 或 `/notifications/read-all`                         | 标记单条或全部已读                                                        |
| GET / PUT | `/notifications/preferences`                                                   | 个人收件邮箱、`emailEnabled`、`minimumLevel` 和邮箱验证时间               |
| POST      | `/notifications/email/verify-request` 或 `/notifications/email/verify-confirm` | 申请六位邮箱验证码，确认时提交 `{code}`                                   |
| GET / PUT | `/notifications/subscriptions`                                                 | 读取或保存 `{subscriptions:[{projectId,stage}]}`                          |
| GET / PUT | `/notifications/smtp`                                                          | 管理员设置发件地址、平台访问地址、SMTP 和凭据引用                         |
| POST      | `/notifications/smtp/test`                                                     | 管理员验证 SMTP 连接和认证                                                |

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

从临时命令页引用方案时，先读取 `GET /operation-plans/:id/versions` 并选定版本，再向 `POST /commands/preview` 提交目标选择。核对步骤、参数及服务器后，通过 `POST /operation-plans/:id/run` 提交同一目标选择、固定版本和预览返回的哈希。

```json
{
  "version": 1,
  "parameters": {},
  "groupIds": ["<server group UUID>"],
  "expectedTargetHash": "<targetHash from preview>",
  "confirmed": true
}
```

方案新增版本后，显式选择的旧版本仍可执行。目标成员或 SSH 连接信息与预览不一致时，接口拒绝入队。重新预览并核对目标后可再次提交。管理员和运维人员可执行，只读账号可查看版本。成功入队后从返回的任务 ID 查询 `GET /tasks/:id`、`/tasks/:id/targets` 和 `/tasks/:id/logs?offset=0`。

## 交付记录与保护

执行流的目标参数或节点目标绑定可提交 `serverIds` 或 `groupIds`，可同时使用两者，并配置 `strategy`、`maxParallel` 和 `failurePolicy`。执行预览返回去重后的目标和配置摘要，成员变化后需重新预览。

| 方法与路径                                                                                                                                                                  | 说明                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /services/:serviceId/repositories`、`PUT /services/:serviceId/repositories`                                                                                            | 查询或保存服务与仓库关联，传入 `{repositories:[{repositoryId,repoPath,isPrimary}]}`。                                                                                                       |
| `GET /deployment-targets`、`GET /deployment-targets/:id`                                                                                                                    | 查询历史独立部署目标。新计划直接引用服务器和分组。                                                                                                                                          |
| `GET /services/:serviceId/environments/:envId/config`                                                                                                                       | 读取历史服务环境配置。                                                                                                                                                                      |
| `GET /projects/:projectId/variables`、`PUT /projects/:projectId/variables`                                                                                                  | 查询或保存项目公共变量。                                                                                                                                                                    |
| `GET /environments/:envId/variables`                                                                                                                                        | 查询旧环境的本地变量。                                                                                                                                                                      |
| `GET /environments/:envId/variables/inherited`                                                                                                                              | 查询未被该环境覆盖的项目公共变量。                                                                                                                                                          |
| `GET /services/:serviceId/environments/:envId/variables`                                                                                                                    | 查询旧服务环境变量。                                                                                                                                                                        |
| `POST /projects/:projectId/variables/:key/reveal`、`POST /environments/:envId/variables/:key/reveal`、`POST /services/:serviceId/environments/:envId/variables/:key/reveal` | 管理员临时读取敏感值 `{value}`，读取动作记入审计。                                                                                                                                          |
| `GET /artifacts`                                                                                                                                                            | 按项目、服务、变量集合、服务器、类型、源码或验证状态筛选已登记实例。使用 `limit` 和最后一个实例 ID `cursor` 分页。                                                                          |
| `GET /artifacts/:id`                                                                                                                                                        | 通过逻辑或实例 ID 查看 `{artifactId,instances}`、实物状态和生产运行。                                                                                                                       |
| `POST /artifacts/:id/verify`                                                                                                                                                | 管理员、操作员可提交 `{instanceIds?}`，重新核对实物并记录结果和操作者。                                                                                                                     |
| `GET /artifacts/:id/download`                                                                                                                                               | 登录后下载文件或镜像归档，响应头 `X-Artifact-SHA256` 提供校验值。                                                                                                                           |
| `GET /deployments`                                                                                                                                                          | 查询逐服务器发布记录。                                                                                                                                                                      |
| `GET /projects/:projectId/services/:serviceId/delivery-status`                                                                                                              | 按环境、服务器和发布位置返回 `current` 与 `latestAttempt`。最近尝试可独立于激活记录，包含 `taskTargetId`、`releaseTaskId`、`phase`、开始与结束时间、脱敏错误及可选的 `deploymentRecordId`。 |
| `GET /registries`、`POST /registries`                                                                                                                                       | 查询、登记镜像仓库，创建限管理员。                                                                                                                                                          |
| `PATCH /registries/:id`、`POST /registries/:id/test`                                                                                                                        | 管理员编辑、测试 HTTPS Registry V2 连通和认证，`credentialId:null` 解除凭据绑定。                                                                                                           |
| `DELETE /registries/:id`                                                                                                                                                    | 管理员删除未被有效配置或镜像产物引用的镜像仓库，仍有引用时返回 409。                                                                                                                        |

项目公共变量的查询和保存返回 `{revision, variables}`。保存整份变量时提交 `{expectedRevision, variables:[{key,value?,isSecret?,description?,keepSecret?,credentialId?}]}`，其中 `expectedRevision` 取自本次编辑所用的读取结果。作用域已更新时，接口返回 `409`。继承变量的历史查询仍返回变量列表。新变量集合使用项目变量集合接口。

敏感变量以加密凭据引用存储，查询接口隐藏值。`keepSecret: true` 保留当前敏感值，提供新值可替换。新图的变量按仓库文件、项目公共变量、变量集合及节点绑定逐层覆盖。构建和部署会注入项目及已关联服务的标识。目录、文件和镜像交付详见 [执行流交付说明](执行流交付.md)。

管理员和操作员可调用 `/projects/:projectId/repositories/:repositoryId/connection`、`/branches` 和 `/commits` 的 GET 接口检查仓库、读取分支和查询最近提交。`/commits` 接受 `branch` 和 `limit`，默认 20 条，最多 50 条。给仓库绑定凭据需要管理员角色。

新建仓库、修改克隆地址或凭据时，系统探测远端 HEAD、分支和完整提交 SHA。使用 `GET /projects/:projectId/repositories/:repositoryId/branch-cache` 查询快照，使用该路径的 `POST /refresh` 重新探测。状态有 `PENDING`、`CURRENT`、`STALE` 和 `ERROR`。同一仓库探测失败时保留上次成功分支，切换仓库地址或凭据会清除旧快照。

### 发布保护与回滚

新发布通过执行图节点确定源码审核、审批、健康检查和回滚条件。管理员从对应运行节点提交决定，独立回滚使用已发布的回滚执行流。运行详情保存逐目标结果和核查记录。

`GET /projects/:projectId/services/:serviceId/environments/:environmentId/source-reviews` 保留历史审核，可按 `repositoryId` 和 `commitSha` 筛选。`GET /deployments/approvals` 保留管理员可见的旧审批记录。`GET /deployments` 提供 `isCurrent`、`rollbackOfDeploymentId` 和关联任务及图运行 ID。旧环境发布配置、独立部署目标、审批和回滚的写接口已退出正式应用。

### 产物保留

| 方法与路径                                  | 用途                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /artifact-retention/policy`            | 读取有效保留策略和 `inherited` 状态。                                                  |
| `PUT /artifact-retention/policy`            | 保存 `{maxBuilds,maxDays}`，限制分别为 1–1000 批和 1–3650 天。                         |
| `DELETE /artifact-retention/policy`         | 删除指定项目或服务覆盖，恢复上一级策略。                                               |
| `PUT /artifact-retention/artifacts/:id/pin` | 以 `{pinned:true}` 固定产物，以 `{pinned:false}` 解除固定。                            |
| `GET /artifact-retention/preview`           | 查看保留策略的自动清理候选。                                                           |
| `POST /artifact-retention/preview`          | 接受 `{artifacts:[{artifactId,instanceId?}]}`，返回 `planDigest`、实例位置和保护原因。 |
| `POST /artifact-retention/prune`            | 再提交 `artifacts`、`planDigest` 和 `idempotencyKey`，返回持久化任务及实例状态。       |
| `GET /artifact-retention/jobs/:id`          | 查看清理任务、逐实例结果、失败和保留原因。                                             |
| `POST /artifact-retention/jobs/:id/retry`   | 复核当前保护关系后重试未完成实例。                                                     |

这些接口需要管理员权限。策略支持系统、项目和服务逐级继承，查询可使用 `projectId` 或 `serviceId` 指定范围。

默认保留最近 20 批且在 30 天内的构建产物。保留策略和运行结束后的临时产物共用清理任务。当前发布、回滚基线、在途执行计划和人工固定均受保护。Worker 清理前核对实物身份和所有权，外部引用只解除登记，仍有使用者的实物保留。清理前先将实例置为 `CLEANING`，新运行只能使用 `ACTIVE` 实例。历史详情保留生产来源、验证和清理结果。

## AI 接口

| 方法         | 路径                                                                 | 说明                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET/POST     | /ai/providers                                                        | 列表/管理员创建：`{name,baseUrl,model,apiKey?或credentialId?,enabled?,timeoutSeconds?}`                                                                        |
| PATCH/DELETE | /ai/providers/:id                                                    | 管理员更新/删除                                                                                                                                                |
| POST         | /ai/providers/:id/test                                               | 管理员测试模型连接，安全摘要响应                                                                                                                               |
| GET/PATCH    | /ai/policies                                                         | 查询/管理员保存系统或项目策略                                                                                                                                  |
| DELETE       | /ai/policies/projects/:projectId                                     | 管理员移除该项目的策略覆盖，立即恢复继承系统默认值                                                                                                             |
| POST         | /ai/chat                                                             | `{message,conversationId?,projectId?,providerId?,context?}`。响应包含生效的项目、服务、页面上下文、消息、提案、任务和草稿                                      |
| GET          | /ai/services/:serviceId/environments/:environmentId/failure-handling | 返回该服务环境的配置及最近的故障记录。可用 `taskId` 限定到一次失败                                                                                             |
| PATCH        | /ai/services/:serviceId/environments/:environmentId/failure-handling | 管理员设置 `{enabled,component?}`。组件可选 `docker`、`compose`、`node`、`nginx`，省略或传 null 表示仅诊断                                                     |
| POST         | /ai/repository-analysis                                              | 管理员或操作员按 `{projectId,repositoryId,serviceId?,environmentId?,branch?,commitSha?,docPath?,repoPath?}` 读取仓库证据，响应包含固定提交、证据路径和配置建议 |
| GET          | /ai/conversations                                                    | 仅当前用户的会话                                                                                                                                               |
| GET          | /ai/conversations/:id/messages                                       | 仅会话发起者可读                                                                                                                                               |
| GET          | /ai/proposals                                                        | 当前用户的执行提案                                                                                                                                             |
| POST         | /ai/proposals/:id/confirm                                            | 重新校验权限、目标与配置后最多提交一次                                                                                                                         |
| POST         | /ai/proposals/:id/reject                                             | 拒绝提案，不执行                                                                                                                                               |

登录用户可通过 `GET /ai/routing` 查看模型用途映射。管理员用 `PUT /ai/routing` 整体保存 `{chat?, repository?, diagnosis?}`，每个字段引用一个 Provider ID。省略某个用途可恢复该用途的默认选择。

`PATCH /ai/policies` 支持 `actionRules` 条件写操作规则，每条包含 `action`、`effect`（`DENY` 或 `CONFIRM`），以及可选的 `role`、`serverId`、`minimumTargets`。仓库写操作仅支持角色条件。省略数组保留已有规则，传空数组清除当前策略的条件规则。

API Key 不回显，更新时省略 Key 表示保留。AI 为空或禁用不会影响手工运维。策略与工具限制见 [AI 说明](AI工具与权限.md)。

`context.kind` 支持 `SERVICE`、`REPOSITORY`、`TASK`、`OPERATION_PLAN`。分别使用 `serviceId`、`repositoryId`、`taskId`、`operationPlanId` 绑定页面对象。仓库可附完整 `commitSha` 和同项目的 `serviceId`。运维方案可附正整数 `version`。后续轮次只需传 `conversationId`，更换已绑定对象会返回 400。提案超出当前资源范围或执行权限时，列表中的 `scopeRevoked` 为 true，执行参数和预览均为空，发起人仍可放弃提案。

仓库分析省略 `commitSha` 时固定远端默认分支的完整提交，返回证据路径、技术栈、服务线索、草稿和缺失字段。巡检通过固定 SSH 查询采集目标环境，诊断只返回结构化故障分类与失败步骤。

备份恢复由[维护命令](BACKUP.md)提供。

## V1.2 服务器资源与配置

以下路径使用统一前缀 `/api/v1`。

| 请求                                              | 权限与结果                                                                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /monitoring/settings`                        | 登录后可读全局开关、采样间隔、保留天数和采集并发。                                                                                                                          |
| `PATCH /monitoring/settings`                      | 管理员可部分更新 `enabled`、`intervalSeconds`（15–3600）、`retentionDays`（1–90）、`concurrency`（1–10）。默认值为关闭、60 秒、7 天、3 路。                                 |
| `GET /monitoring/servers?summary=true`            | 返回各活跃服务器最近的采集状态、时间和指标。列表摘要只传根分区和首选网卡。                                                                                                  |
| `GET /monitoring/servers/:id?hours=24&metric=cpu` | 查看 1 或 24 小时趋势。指标可选 `cpu`、`memory`、`disk`、`rx` 或 `tx`，磁盘和网络使用 `mount`、`interfaceName` 选择。速率单位为字节/秒，缺失样本的值为 null。               |
| `PATCH /monitoring/servers/:id`                   | 管理员或运维员可更新单机 `enabled` 和首选 `interfaceName`，传 null 清除首选网卡。                                                                                           |
| `POST /monitoring/servers/:id/refresh`            | 管理员或运维员刷新单机采样，同一台主机复用进行中的采集。关闭监控或采集并发已满时返回 409。                                                                                  |
| `POST /servers/configuration/compare`             | 管理员或运维员传入不同服务器的 `baselineId` 和 `comparisonId`。每行 `EQUAL` 表示一致，`DIFFERENT` 表示有差异，`UNKNOWN` 表示至少一侧缺少事实。单侧 SSH 失败保留另一侧结果。 |

## 服务门户与服务发布状态

| 接口                                                    | 权限与用途                                                                                                                                                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /portal`                                           | 登录用户可查看活动项目、服务、按配置排序的完整访问地址及发布状态摘要。可传 `q` 搜索项目、服务、地址名称和标签，或传 `tag`、`projectId`、`serviceId` 筛选。摘要包含最近尝试与当前版本的健康状态及已知观察时间。 |
| `GET /projects/:id/services/:serviceId/delivery-status` | 登录用户可查看服务的逐目标当前发布和最近尝试。当前记录包括已确认激活的版本和需要核查的激活结果。响应关联发布、构建任务、产物及实际仓库提交。健康观察时间缺失的历史记录返回 `null`。                            |
