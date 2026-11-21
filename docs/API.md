# VeyOps API

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

`GET /projects/:projectId/resource-references` 返回 `{servers, references}`。服务器按 ID 合并，列表保留直接选择、分组成员、旧部署目标及执行图等来源。每条引用包含 `resourceType`、`resourceId`、`sourceKind`、`sourceId`、`state`，并按来源附带服务、环境、图版本、节点、触发器、运行、任务或分组 ID。`CONFIGURED` 表示配置中使用，`DRAFT` 表示草稿引用，`RUNNABLE` 表示可运行版本或已启用规则，`PENDING` 表示尚未完成的运行或任务，`HISTORY` 表示冻结的历史来源。`RUN` 来源包含该次确认的计划和候选目标，逐目标结果以任务或部署记录为准。仅在某次运行选中的主机通过运行或任务来源追溯。两项目共享同一主机时，各自返回本项目的来源。

项目仓库、服务和环境移除后归档并退出新选择，历史数据继续使用原 ID。仍有可运行、已配置或待执行引用时返回 409，`error.references` 提供需先调整的来源。草稿保持可编辑，发布时重新校验归属和可用状态。

### 执行配置归属

执行预览按下列规则解析配置并返回生效来源，资源查询以已保存配置和执行快照为准。

| 字段 | 所属配置与顺序 |
| --- | --- |
| 构建位置、并发、工作区根目录、日志保留 | 系统默认，项目可覆盖。构建节点可选择执行位置，已声明且允许调整的运行参数可指定并发。 |
| 代码与构建产物 | Git 节点固定仓库、ref 和实际 SHA。构建节点声明工作目录、命令及具名产物，部署节点绑定已登记产物。 |
| 环境文件和变量 | 执行图通过加载节点选择明确路径或映射。变量由低到高为绑定的仓库文件、项目公共变量、开始节点的变量集合、节点绑定。平台保留键由系统赋值。 |
| 构建和发布目标 | 功能节点各自绑定平台服务器或分组。发布目录及启停配置由部署节点声明。 |

| 方法                 | 路径                       | 请求 / 说明                                                                                                  |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GET / POST           | /credentials               | 列表 / `{name,type,secret,metadata?}`                                                                        |
| PATCH                | /credentials/:id           | `{name?,secret?,status?:'ACTIVE'\|'DISABLED'}`                                                               |
| DELETE               | /credentials/:id           | 引用检查后删除                                                                                               |
| GET / POST           | /servers                   | 列表 / 创建时提交 `{name,host,port?:22,username,credentialId,hostKeyAcceptanceToken,tags?,description?}` |
| POST                 | /servers/host-key/probe    | 提交 `{host,port?,serverId?}`，握手读取公钥并返回算法、指纹、一次性接受令牌及有效期 |
| POST                 | /servers/:id/host-key/accept | 对已有服务器提交 `{hostKeyAcceptanceToken}`，确认探测到的新指纹 |
| GET / PATCH          | /servers/:id               | 详情含 `active`、分组、项目引用、探测及执行历史，停用服务器仍可查看历史 / 完整服务器配置 |
| DELETE               | /servers/:id               | 软移除，不删除历史                                                                                           |
| POST                 | /servers/:id/test          | 只读连接检查，返回 `{success,server,result:{exitCode,output}}`                                               |
| GET / POST           | /server-groups             | 列表 / `{name,description?,serverIds:[]}`                                                                    |
| GET / PATCH / DELETE | /server-groups/:id         | 详情含有序的启用成员 `serverIds` 和项目引用 `projects` / 更新分组和成员 / 删除分组 |
| GET                  | /servers/:id/project-references、/server-groups/:id/project-references | 查询该全局目标被项目使用的来源 |
| GET / POST           | /projects                  | 列表支持 `?include=addresses`，追加按服务和服务内顺序排列的地址，含 `serviceId`、`serviceName`。创建时提交 `{name,slug,description?,tags?}` |
| GET / PATCH / DELETE | /projects/:id              | 详情 / 完整基本配置 / 软删除                                                                                 |
| POST                 | /projects/:id/repositories | `{name,cloneUrl,defaultBranch?,credentialId?}`                                                               |
| GET / POST           | /projects/:id/services     | 读取项目的可用服务 / 创建服务及有序地址 |
| GET / PATCH / DELETE | /projects/:id/services/:serviceId | 读取服务及地址 / 按共同修订保存 / 归档服务 |
| POST                 | /projects/:id/environments | `{name,slug,environmentType:'DEVELOPMENT'\|'TESTING'\|'STAGING'\|'PRODUCTION'\|'CUSTOM'}`                    |
| GET                  | /dashboard                 | 服务器、项目、服务和任务统计，最近部署、最近任务及失败任务                                                   |
| GET                  | /audit                     | 最近200条非敏感操作审计                                                                                      |
| GET / PATCH          | /system                    | 查看版本、数据库和当前 API 进程的 Worker / 管理员更新执行默认值和日志保留期                                  |

凭据 `type` 包括 SSH_PASSWORD、SSH_KEY、GIT_TOKEN、GIT_PASSWORD、API_KEY、API_SECRET、DOCKER_REGISTRY、USERNAME_PASSWORD、CUSTOM_SECRET。SSH_PASSWORD 使用 `secret:{password}`；SSH_KEY 使用 `{privateKey,passphrase?}`；GIT_TOKEN 使用 `{token}`；API_KEY 使用 `{apiKey}`。GET 永不返回 secret、ciphertext、nonce、auth_tag。

仓库和环境可通过 `PATCH /projects/:id/{repositories,environments}/:resourceId` 更新，或通过同路径的 `DELETE` 归档。仓库凭据传 `null` 可解除关联。有效配置、可运行版本或在途任务仍引用资源时返回 409。只有已完成历史引用的资源可归档，历史继续使用原 ID 和快照。

项目详情在 `services` 中返回服务及地址，并包含 `dependencies`、`dependents`、`deploymentTargets` 和 `recentDeployments`。`dependents` 中的 `projectId` 指向依赖本项目的项目，修改依赖需从其所属项目发起。通过 `POST /projects/:id/dependencies` 新增依赖，带记录 ID 的路径支持 `PATCH` 和 `DELETE`。提交依赖时会检查循环引用。

### 服务与访问地址

创建服务提交 `{name,slug,serviceType?,description?,addresses?}`。`serviceType` 默认为 `WEB`，也可选 `API`、`WORKER`、`SCHEDULED_JOB`、`STATIC_SITE`、`DOCKER_SERVICE` 或 `CUSTOM`。服务响应包含 `projectId`、`revision` 与有序的 `addresses:[{id,name,url}]`。创建后 `revision` 为 1。所有登录角色可读取，管理员和操作员可保存及归档。

更新时传入 `expectedRevision` 和需要修改的字段。省略 `addresses` 时保留地址，传空列表时清空，传非空列表时按所给顺序完整保存。已有行携带所属服务的地址 ID，新行省略 ID。每次可保存最多 100 条地址，链接使用不含凭据的绝对 HTTP(S) URL。服务、地址和审计在同一事务内更新，每次保存成功递增一次修订。

地址校验失败返回 400，`error.details.fieldErrors` 包含 `{path,code,message}`，例如第二条地址的 URL 路径为 `['addresses',1,'url']`。修订冲突返回 409 及 `error.details.currentRevision`，可重新读取服务后核对草稿。归档前检查仍生效的引用，冲突响应使用 `error.references`。

`GET /projects/:id/services/:serviceId/recent-deployments` 返回该服务最近五条逐目标部署记录。传入 `environmentId` 时先按环境过滤。服务和环境须为该项目的可用资源。

### 全局服务器与分组

服务器和分组列表供各项目选择同一全局资源 ID。服务器详情和分组详情中的 `projects`，以及独立的 `project-references` 接口，使用 `{id,name,slug,references}` 对应引用该目标的项目。每条引用可定位配置、图版本、运行、任务或用于选择该服务器的组。管理员管理服务器登记、连接配置、指纹、停用和分组。管理员和操作员可发起连接检查与配置对比。

### 环境变量集合

以下接口位于 `/projects/:projectId/environment-sets`。

| 方法及路径 | 请求和结果 |
| --- | --- |
| `GET /`、`GET /:setId` | 列出可用集合或读取包含变量项的详情。集合响应含 `id`、`name`、`description` 和 `revision`。 |
| `POST /` | 创建集合，提交 `{name,description?,variables?}`。 |
| `PATCH /:setId` | 提交 `{expectedRevision,name?,description?,variables?}`。省略变量数组时保留，空数组清空。 |
| `DELETE /:setId` | 提交 `{expectedRevision}`，归档集合。 |
| `POST /:setId/variables/:key/reveal` | 管理员临时读取该敏感值，写入查看审计。 |

每个变量提交 `key`、可选 `description` 和普通 `value`。敏感项使用 `isSecret:true`，同时提交一个新 `value`、管理员绑定的 `credentialId` 或 `keepSecret:true`。集合详情与导出默认掩码。写入校验失败返回 `error.details.fieldErrors`，修订冲突返回 `error.details.currentRevision`。归档集合从新计划选择中退出，已确认的运行及历史继续读取其快照。

### 项目内交付

项目交付页使用 `GET /projects/:id/delivery-context` 加载项目、服务、仓库和环境。已删除项目仍可查看历史，返回 `archived: true`。`archivedServices`、`archivedEnvironments` 和 `archivedRepositories` 供历史筛选核对归属。以下列表在数据库内先应用筛选，再返回最近的记录。

| 请求 | 项目内筛选与追溯 |
| --- | --- |
| `GET /projects/:id/execution-graph/runs` | 读取执行流运行记录，通过运行详情获取关联任务和日志。 |
| `GET /artifacts`、`GET /deployments` | 支持 `projectId`、上述三个条件及 `taskId`、`recordId`。有执行图来源时返回 `graphRunId`、`graphVersion`、`graphFlowName` 和 `graphNodeName`。逐服务器发布还返回当次的 `serverName`、`serverHost`、`serverPort` 快照和实际使用的 `artifactId`。 |
| `GET /deployments/approvals` | 管理员可按相同条件查看待审批发布，其中 `recordId` 是待审批任务 ID。审批、重新部署及回滚继续调用原有操作接口。 |

产物和部署列表可附加 `repositoryId`。同时传入提交前缀 `commit` 时，两个条件匹配同一项产物来源。产物的 `sources` 列出实际绑定并供构建使用的源码工作区及额外文件来源，包含 `repositoryId`、`commitSha`、可用的 `ref`、提交说明 `subject`、相对路径 `path` 和 `workspace` 节点引用。空列表表示当前产物缺少可核实来源，旧记录可以省略该字段。触发事件另由 `sourceEvent` 返回。镜像档案可返回 `imageOrigin` 及归档内的 `composeTemplate` 路径与摘要。登记现有镜像时，`sourceImageReference` 记录登记来源，Git 来源列表为空。

### 服务环境 Compose 模板

- `GET /services/:serviceId/environments/:environmentId/compose-templates` 返回 `revision` 和最近 100 个 `versions` 的元数据。修订号 0 表示默认使用产物归档。
- `POST /services/:serviceId/environments/:environmentId/compose-templates` 接收 `expectedVersion`、`source` 和可选的 `content`。来源 `SERVICE_ENVIRONMENT` 使用 YAML 内容，`ARCHIVE` 使用产物归档。同一内容保存复用当前版本。旧修订号提交返回 HTTP 409。
- `GET /services/:serviceId/environments/:environmentId/compose-templates/:id` 获取指定模板版本内容。管理员和操作员可以写入与读取内容，查看者可以查看版本元数据。模板内容的读取与来源变更记入审计。

交付预览包含所选 Compose 来源。管理模板记录固定版本、路径与 SHA-256。历史产物显示归档路径、摘要和固定镜像引用。成功激活的交付记录可返回 `composeRelease`，包括校验过的 `template`、实际使用的 `imageReference` 和 `imageId`。回滚预览中的 `composeTemplate` 与 `previousCompose` 分别记录待复用的模板与历史激活结果。

### 首页汇总

`GET /dashboard` 返回 `servers`、`projects`、`services`、`totalTasks`、`activeTasks`、`recentDeployments`、`recentTasks` 和 `recentFailedTasks`。

- `services` 包含 `total`、`running` 和 `abnormal`。统计未删除项目，每个服务只计一次。按服务、环境和启用服务器分别取最新部署记录。任一记录显示部署失败、部分失败、超时、需要检查或健康失败、未知时，服务计为异常。没有异常且至少一个目标的部署成功并通过健康检查时，服务计为运行中。未部署和未验证的服务只计入总数。
- `recentDeployments` 最多六条逐服务器发布记录，含项目、服务、环境、服务器、对应任务、发布版本、执行和健康状态。按开始时间降序，未记录开始时间时使用交付任务的创建时间。已停用服务器的历史发布仍可查看。
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

## 项目工作台地址

| 入口 | 页面地址 |
| --- | --- |
| 项目资源 | `#/projects/:id` 默认入口。`resource` 选择 `repositories`、`services`、`environment-sets` 或 `relations`，可用 `repositoryId`、`serviceId`、`environmentSetId` 定位。 |
| 执行图 | `#/projects/:id/execution-graph`。使用 `start`、`run`、`pane`、`version`、`node` 和 `flow` 定位。服务详情打开开始节点时带入 `serviceId`。 |
| 产物 | `#/projects/:id/artifacts`。`artifactId` 定位记录，可按服务及源码等条件筛选。部署与回滚或待审批记录可通过 `/delivery?tab=deployments` 或 `/delivery?tab=approvals` 查看。 |
| 项目配置 | `#/projects/:id/configuration`。同页维护基本信息、执行默认值、项目公共变量和 AI 策略。 |

`view` 和 `viewSearch` 保留返回的项目视图及筛选。平台服务器通过 `#/servers?serverId=:serverId` 或 `#/servers?groupId=:groupId` 打开详情。项目来的链接可附 `projectId` 和该项目的 `returnPath`。由服务链接传入的服务按已发布开始节点声明的输入预填，图中固定绑定继续随版本生效。

## 项目执行图

以下路径使用前缀 `/projects/:projectId/execution-graph`。登录用户可查询，管理员和操作员可保存、发布和运行。

| 方法与相对路径 | 请求与结果 |
| --- | --- |
| `GET /` | 查询项目图、草稿修订号和当前发布版本。 |
| `GET /catalog` | 返回内置字段、功能模块版本和端口定义。 |
| `POST /catalog?flow=:flowId&node=:nodeId` | 提交 `{definition}`，返回所选草稿节点的端口、候选来源、类型、可用性和分支信息。 |
| `POST /validate` | 提交 `{definition}`。响应的 `issues` 用 `flowId`、`nodeId`、`fieldId` 和 `message` 定位发布问题。 |
| `PUT /draft` | 提交 `{expectedRevision, definition:{flows:[],canvas:{nodes,edges,endpoints,templates}}}`。 |
| `POST /publish` | 提交 `{expectedRevision}`，校验并固定已保存的图版本。 |
| `GET /versions`、`GET /versions/:version` | 查询发布历史和具体发布版本。 |
| `POST /versions/:version/retire` | 管理员或操作员停用旧发布版。先发布替代版本，再停用绑定该旧版的启用触发器。返回 `{version,retiredAt}`。停用版保留定义和运行历史，在途计划继续保护其资源。 |
| `POST /versions/:version/restore` | 提交 `{expectedRevision}`，将发布版本载入草稿。 |
| `POST /flows/:flowId/preview` | 提交 `{version,inputs:{parameters}}`。返回 `configurationHash`、`planSections`、参数和来源、`environmentSet`、`checkouts` 及节点端口证据。 |
| `POST /flows/:flowId/run` | 提交同样的版本和输入，附 `expectedConfigurationHash` 和 `idempotencyKey`。可原样传回 `planSections` 为 `expectedPlanSections`。配置变更返回 409，`error.changes` 给出失效字段或计划段落，重新预览后方可确认。相同确认可取回原运行。 |
| `GET /runs`、`GET /runs/:runId` | 查询运行、任务和结束节点的 `outputs`。节点详情含 `inputs`、`environment`、`output`、逐目标状态和可定位的 `issue`。 |
| `POST /runs/:runId/cancel` | 取消运行及尚未完成的节点和子流。 |
| `POST /runs/:runId/nodes/:nodeId/decision` | 管理员提交 `{decision:"APPROVE"}` 或 `{decision:"REJECT"}`。 |

预览或确认时发现明确的运行条件问题，可通过 `error.planIssue` 获取 `code`、`message` 和已知的 `flowId`、`flowName`、`nodeId`、`nodeName`、`fieldId`、`fieldName`。问题类别包括 `INPUT`、`REPOSITORY`、`BUILD_TARGET`、`RELEASE_TARGET`、`ARTIFACT`、`SOURCE_REVIEW` 和 `CONFIGURATION`。绑定到开始参数时可附 `parameterId`，定位目标问题时可附 `serviceId`、`environmentId` 和 `targetSource`。源码审核问题可附 `repositoryId` 与完整的 `commitSha`。成功预览会提供本次运行的产物节点及输出字段，或已固定的历史制品。存在多个候选来源时，各候选可附实际源码快照和对应审核记录。发布审批以 `requireApproval` 单独表示。

开始节点 `inputs` 和结束节点 `outputs` 使用同一字段结构 `{id,name,type,required?,multiple?,defaultValue?,options?,artifactType?,selection?,source?}`。Git 版本值为 `{kind:"BRANCH"|"TAG"|"COMMIT",value}`。产物参数接受 `{artifactId,instanceId?}`，预览按目标固定实际实例。`LATEST_COMPATIBLE` 在预览中依次定位并验证目标匹配的记录，`CURRENT_RUN` 约束结束产物的来源。

开始节点的 `environmentSet` 支持 `{mode:"NONE"}`、`{mode:"FIXED",environmentSetId}` 和 `{mode:"INPUT",fieldId}`。运行时选择的字段类型为单值 `ENVIRONMENT_SET`，值为集合 ID。响应的集合摘要是 `null` 或 `{id,name,revision}`，确认时复核修订和凭据版本。

`LOAD_ENV.loadEnvironment` 可用 `envFile` 指定相对路径，或用 `pathRule:{key,paths}` 根据开始参数及集合中的普通值映射出相对路径。`required:false` 允许跳过未匹配或不存在的文件。节点从绑定的固定 Git 提交读取文件，消费者通过 `variables` 端口接入。文件的实际路径和覆盖来源随计划记录。

画布的 `endpoints` 保存 `{startId,endId,serviceId?,edgeSelections?,inputBindings?,environmentBindings?,outputBindings?}`。端口可引用 `INPUT.fieldId`、`OUTPUT.nodeId` 和 `fieldId`、`CONTEXT.fieldId`、`VALUE.value`，或按顺序选择 `FIRST_AVAILABLE.sources`。`AS_GIT_REF` 可把普通文本明确转换成分支或 Tag。端口的 `onMissing` 可声明报告缺项、省略、使用字段默认值或 Git 仓库默认版本。分支候选存在尚未完成的前序生产者时等待，已确认无值时继续选择。

Shell 和检查节点的 `environmentBindings[nodeId][key]` 还支持 `NODE_INPUT.fieldId`、`ENVIRONMENT_KEY.key` 和 `CREDENTIAL.credentialId`。先解析输入再做环境注入。脚本每执行单元可返回一条 `VEYOPS_OUTPUT=` JSON 对象，通过声明的输出名转成稳定字段 ID。未知键、重复键、类型错误、超限或敏感输出会阻止节点成功。原始结果行独立解析，节点日志保存普通输出。

普通路径的 `edgeSelections` 按源节点 ID 写入允许的下游节点 ID。`FLOW_CALL` 的端口取子流的开始和结束字段 ID。含外部执行资源或变量集合的子流需要在父流预览时解析其参数。运行证据中的字段状态可区分已解析、默认值、等待上游、省略或错误。来源通过稳定节点与字段 ID 回查。

`BUILD.build.dependencies` 最多声明八个额外源码工作区别名。每个别名用小写字母开头，可包含小写字母、数字和连字符。流需将 Git 来源工作区绑定到主 `workspace` 和各 `dependency_<别名>` 端口。额外工作区复制到构建任务独立目录，命令可通过 `$VEYOPS_GRAPH_DEPENDENCY_ROOT/<别名>` 访问。镜像构建的 Dockerfile 需要使用依赖时，先在构建命令中将所需文件复制到主仓库的构建上下文。

构建、登记和部署配置分别保存在 `BUILD.build`、`REGISTER_ARTIFACT.registerArtifacts` 和 `DEPLOY_ARTIFACT.deploy`。构建和登记支持 `artifacts` 列表，条目包含 `name`、`type`、`path` 或 `imageReference`，以及可选 `required`、`composeFilePath` 和 `persist`。`persist:false` 输出 `{temporaryArtifactId}`，当前根运行及其子流可以引用。部署节点从 `artifact` 端口取得待部署记录。归档下载使用 `GET /artifacts/:id/download`。

### 执行图存量迁移

以下路径以 `/projects/:projectId/execution-graph/migration` 为前缀。管理员和操作员可盘点和预演，管理员可准备草稿、切换及恢复触发器。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /` | 返回计划摘要 `planHash`、图修订、可用版本、旧 Pipeline 和部署目标、触发绑定及待处理事件、历史产物与旧审核数量。 |
| `POST /preview` | 接受 `environmentId`、`commitSha`、`artifactId`、`targetId`、`serverIds`、`groupIds` 和条件 `value` 样本。按相同输入对照新旧步骤、仓库、环境文件、变量键、目标、产物和发布保护。 |
| `POST /stage` | 接受 `{planHash,acknowledgements,comparison?}`。确认所有可处理差异后幂等补图或保存迁移草稿。返回 `{graphId,revision,changed}`，随后用执行图发布接口发布。 |
| `POST /cutover` | 接受 `{planHash,targetVersion,triggerIds,confirmed:true}`。使用最新盘点摘要及当前发布版，在事务中切换所选规则的固定版本。触发器 ID、配置和历史事件保持原样。 |
| `POST /restore` | 接受 `{cutoverId,confirmed:true}`。恢复最近一次切换的规则，返回 `suspendedTriggerIds` 供管理员核对需要保持停用的旧入口。 |

草稿、资源或规则在确认前变化，或候选规则仍有待处理事件时返回 409。旧 Pipeline Webhook 仍启用时需先单独停用。已确认的在途运行沿用原图版本和快照。预演返回变量键、来源和敏感状态。

### 执行图触发器

通过 `GET /triggers` 查询附加规则，管理员经 `POST /triggers` 创建，用 `PATCH /triggers/:id` 更新。规则绑定发布版本和开始节点。`parameterMappings` 按开始字段 ID 指定 `{source:"VALUE",value}` 或 `{source:"EVENT",field}`。事件字段包括 `repository`、`commit`、`ref`、`eventId`、`scheduledAt`、`upstreamRunId` 和 `upstreamStatus`，由触发类型决定可用项。

- `CRON` 使用 `cron` 和 IANA `timeZone`。
- `API` 经 `POST /triggers/:triggerId/invoke` 提交 `{eventId,inputValue?,repositoryId?,ref?,commitSha?}`。
- `UPSTREAM` 指定同一发布版本的 `upstreamFlowId` 和 `upstreamStatus`。成功规则可用 `{source:"UPSTREAM_OUTPUT",fieldId}` 传递可独立验证的同类型结束字段。
- `WEBHOOK` 使用签名凭据，可设置 `repositoryId` 和 `refPrefix` 过滤。向 `/api/v1/graph-webhooks/:triggerId` 提交 JSON，携带 `X-Veyops-Timestamp`、`X-Veyops-Delivery`、`X-Veyops-Signature`，签名对 `timestamp + "." + eventId + "." + 原始请求体` 计算 HMAC-SHA256，以 `sha256=` 加十六进制值发送。

`GET /triggers/:triggerId/events` 返回事件状态与元数据。同一规则的事件 ID 去重。

执行构建或部署的触发入口默认关闭。对应入口通过验收后，在 API 和执行器进程设置 `VEYOPS_AUTO_DELIVERY_TRIGGERS`，以逗号列出获准的类型，例如 `API,WEBHOOK`。自动构建使用 `WEBHOOK_BUILD_DOCKER_SOCKET` 指定的隔离管理端运行器，镜像仅做归档。自动发布消费已归档产物，遵循已发布图中的审批节点和目标绑定。变量集合参数可在规则中绑定明确的集合 ID，也可用开始字段默认值。事件提交用于保存触发来源、参数映射及提交条件判断。需要按事件提交检出时，将 `commit` 映射为开始字段并绑定到检出或构建节点的 Git 版本端口。

## 项目视图

| 方法   | 路径       | 请求 / 说明                                                                |
| ------ | ---------- | -------------------------------------------------------------------------- |
| GET    | /views     | 返回 `{views,defaultViewId}`，包含全部项目、异常项目及当前账号的自定义视图 |
| GET    | /views/:id | 返回视图详情、排序后的项目、各项目的服务、发布状态、近期发布和访问地址 |
| POST   | /views     | `{name,description?,projectIds,isDefault?}`，`projectIds` 的顺序即显示顺序 |
| PATCH  | /views/:id | 使用同一请求结构更新自定义视图与项目列表                                   |
| DELETE | /views/:id | 删除当前账号的自定义视图                                                   |

预设 ID 为 `all`、`abnormal`。详情可用 `serviceId`、`serverId` 或 `groupId` 筛选。`serverId` 和 `groupId` 二选一，分组按当前启用成员展开。目标筛选考虑项目引用和实际部署，发布记录按所选服务和服务器过滤。发布状态按同一项目、服务和实际服务器的最新部署判断。未经健康验证的成功发布显示为待验证。

所有登录角色均可读取预设。管理员或运维人员可保存和设置自己的自定义视图为默认。无自定义默认时打开「全部项目」。设为默认会替换当前账号的旧默认，删除视图只移除它和项目的关联。

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

服务环境和执行流运行可提交 `serverIds` 或 `groupIds`，可同时使用两者，并配置 `strategy`、`maxParallel` 和 `failurePolicy`。执行预览返回去重后的目标和配置摘要，成员变化后需重新预览。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /services/:serviceId/repositories`、`PUT /services/:serviceId/repositories` | 查询或保存服务与仓库关联，传入 `{repositories:[{repositoryId,repoPath,isPrimary}]}`。 |
| `POST /projects/:projectId/environments`、`PATCH /projects/:projectId/environments/:envId` | 创建或更新环境。`repositoryEnvFile` 指定仓库相对路径。`defaultTargetSelection` 指定默认发布服务器、分组和批次策略，传 `null` 清除默认目标。 |
| `GET /services/:serviceId/environments/:envId/config`、`PUT /services/:serviceId/environments/:envId/config` | 读取或保存服务环境配置。 |
| `GET /projects/:projectId/variables`、`PUT /projects/:projectId/variables` | 查询或保存项目公共变量。 |
| `GET /environments/:envId/variables`、`PUT /environments/:envId/variables` | 查询或保存环境本地变量。 |
| `GET /environments/:envId/variables/inherited` | 查询未被该环境覆盖的项目公共变量。 |
| `GET /services/:serviceId/environments/:envId/variables`、`PUT /services/:serviceId/environments/:envId/variables` | 独立查询或保存服务环境变量，覆盖同名环境变量。 |
| `POST /projects/:projectId/variables/:key/reveal`、`POST /environments/:envId/variables/:key/reveal`、`POST /services/:serviceId/environments/:envId/variables/:key/reveal` | 管理员临时读取敏感值 `{value}`，读取动作记入审计。 |
| `GET /artifacts` | 按项目、服务、变量集合、服务器、类型、源码或验证状态筛选已登记实例。使用 `limit` 和最后一个实例 ID `cursor` 分页。 |
| `GET /artifacts/:id` | 通过逻辑或实例 ID 查看 `{artifactId,instances}`、实物状态和生产运行。 |
| `POST /artifacts/:id/verify` | 管理员、操作员可提交 `{instanceIds?}`，重新核对实物并记录结果和操作者。 |
| `GET /artifacts/:id/download` | 登录后下载文件或镜像归档，响应头 `X-Artifact-SHA256` 提供校验值。 |
| `GET /deployments` | 查询逐服务器发布记录。 |
| `GET /registries`、`POST /registries` | 查询、登记镜像仓库，创建限管理员。 |
| `PATCH /registries/:id`、`POST /registries/:id/test` | 管理员编辑、测试 HTTPS Registry V2 连通和认证，`credentialId:null` 解除凭据绑定。 |
| `DELETE /registries/:id` | 管理员删除未被有效配置或镜像产物引用的镜像仓库，仍有引用时返回 409。 |

项目公共、环境和服务环境的变量查询与保存都返回 `{revision, variables}`。保存整份作用域变量时需提交 `{expectedRevision, variables:[{key,value?,isSecret?,description?,keepSecret?,credentialId?}]}`，其中 `expectedRevision` 取自本次编辑所用的读取结果。作用域已更新时，接口返回 `409` 并保留数据库中的现有变量。重新读取最新版本后再核对并提交改动。继承变量的专用查询仍返回变量列表。

敏感变量以加密凭据引用存储，查询接口隐藏值。`keepSecret: true` 保留当前敏感值，提供新值可替换。运行时项目公共变量先加载，同名环境变量覆盖，服务环境变量再覆盖。Shell 节点可通过 `inputs.environmentId` 指定环境，默认使用项目公共变量。管理端和目标端构建、部署及 SSH 脚本注入 `VEYOPS_PROJECT_ID`、`VEYOPS_PROJECT_SLUG`，关联服务时注入 `VEYOPS_SERVICE_ID`、`VEYOPS_SERVICE_SLUG`。构建和部署还提供 `VEYOPS_PROJECT_NAME` 和 `VEYOPS_SERVICE_NAME`。目录、文件和镜像交付详见 [执行流交付说明](执行流交付.md)。

管理员和操作员可调用 `/projects/:projectId/repositories/:repositoryId/connection`、`/branches` 和 `/commits` 的 GET 接口检查仓库、读取分支和查询最近提交。`/commits` 接受 `branch` 和 `limit`，默认 20 条，最多 50 条。给仓库绑定凭据需要管理员角色。

新建仓库、修改克隆地址或凭据时，系统探测远端 HEAD、分支和完整提交 SHA。使用 `GET /projects/:projectId/repositories/:repositoryId/branch-cache` 查询快照，使用该路径的 `POST /refresh` 重新探测。状态有 `PENDING`、`CURRENT`、`STALE` 和 `ERROR`。同一仓库探测失败时保留上次成功分支，切换仓库地址或凭据会清除旧快照。

### 发布保护与回滚

启用服务环境的 `releasePolicy.requireCodeReview` 后，发布按产物实际依赖的仓库及完整 SHA 复核。属于同一服务环境的每项来源均需有效审核，审批发布和激活前会重新核对。

`GET /projects/:projectId/services/:serviceId/environments/:environmentId/source-reviews` 返回审核记录，可按 `repositoryId` 和 `commitSha` 筛选。管理员使用同一路径下的 `PUT /:commitSha` 提交 `{repositoryId,decision:"APPROVED"|"REVOKED",reason?}`。只有项目历史中恰有一个当前可用仓库时，省略仓库的请求才可定位。旧记录保留并以 `repositoryId: null` 返回，需经管理员确认仓库后重新审核。预览上游将产出的制品时会标记待登记，登记完成后按实际来源执行检查。

管理员通过服务环境配置的 `releasePolicy` 设置 `requireApproval`、`rollbackMode`（`OFF`、`PREVIOUS_HEALTHY`、`PINNED`）、可选的 `pinnedDeploymentId`、`archivePushedImage` 和 `healthCheck`。健康检查包含可选的 `httpUrl`、`compose`，以及 `attempts`、`intervalSeconds`、`timeoutSeconds`。文件服务环境可另配置 `stopCommand`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/deployments/approvals` | 管理员查看等待批准的发布任务及提交、产物和服务器 ID。 |
| `POST` | `/deployments/approvals/:id/approve` | 管理员批准固定目标和产物。返回任务。 |
| `POST` | `/deployments/:id/rollback/preview` | 预览使用历史发布快照回滚的范围，返回 `confirmationHash`。 |
| `POST` | `/deployments/:id/rollback` | 提交预览的 `confirmationHash` 开始回滚，返回可能仍待审批的任务。 |

执行流发布预览的 `requireApproval` 表示部署是否需要管理员批准。部署任务的 `approvalStatus` 为 `PENDING`、`APPROVED` 或 `null`。`GET /deployments` 提供 `isCurrent`、`rollbackAvailable`、`rollbackOfDeploymentId` 和关联任务 ID。

### 产物保留

| 方法与路径 | 用途 |
| --- | --- |
| `GET /artifact-retention/policy` | 读取有效保留策略和 `inherited` 状态。 |
| `PUT /artifact-retention/policy` | 保存 `{maxBuilds,maxDays}`，限制分别为 1–1000 批和 1–3650 天。 |
| `DELETE /artifact-retention/policy` | 删除指定项目或服务覆盖，恢复上一级策略。 |
| `PUT /artifact-retention/artifacts/:id/pin` | 以 `{pinned:true}` 固定产物，以 `{pinned:false}` 解除固定。 |
| `GET /artifact-retention/preview` | 查看保留策略的自动清理候选。 |
| `POST /artifact-retention/preview` | 接受 `{artifacts:[{artifactId,instanceId?}]}`，返回 `planDigest`、实例位置和保护原因。 |
| `POST /artifact-retention/prune` | 再提交 `artifacts`、`planDigest` 和 `idempotencyKey`，返回持久化任务及实例状态。 |
| `GET /artifact-retention/jobs/:id` | 查看清理任务、逐实例结果、失败和保留原因。 |
| `POST /artifact-retention/jobs/:id/retry` | 复核当前保护关系后重试未完成实例。 |

这些接口需要管理员权限。策略支持系统、项目和服务逐级继承，查询可使用 `projectId` 或 `serviceId` 指定范围。

默认保留最近 20 批且在 30 天内的构建产物。保留策略和运行结束后的临时产物共用清理任务。当前发布、回滚基线、在途执行计划和人工固定均受保护。Worker 清理前核对实物身份和所有权，外部引用只解除登记，仍有使用者的实物保留。清理前先将实例置为 `CLEANING`，新运行只能使用 `ACTIVE` 实例。历史详情保留生产来源、验证和清理结果。

## AI 接口

| 方法         | 路径                           | 说明                                                                                                                       |
| ------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| GET/POST     | /ai/providers                  | 列表/管理员创建：`{name,baseUrl,model,apiKey?或credentialId?,enabled?,timeoutSeconds?}`                                    |
| PATCH/DELETE | /ai/providers/:id              | 管理员更新/删除                                                                                                            |
| POST         | /ai/providers/:id/test         | 管理员测试模型连接，安全摘要响应                                                                                           |
| GET/PATCH    | /ai/policies                   | 查询/管理员保存系统或项目策略                                                                                              |
| DELETE       | /ai/policies/projects/:projectId | 管理员移除该项目的策略覆盖，立即恢复继承系统默认值 |
| POST         | /ai/chat                       | `{message,conversationId?,projectId?,providerId?,context?}`。响应包含生效的项目、服务、页面上下文、消息、提案、任务和草稿 |
| GET          | /ai/services/:serviceId/environments/:environmentId/failure-handling | 返回该服务环境的配置及最近的故障记录。可用 `taskId` 限定到一次失败 |
| PATCH        | /ai/services/:serviceId/environments/:environmentId/failure-handling | 管理员设置 `{enabled,component?}`。组件可选 `docker`、`compose`、`node`、`nginx`，省略或传 null 表示仅诊断 |
| POST         | /ai/repository-analysis        | 管理员或操作员按 `{projectId,repositoryId,serviceId?,environmentId?,branch?,commitSha?,docPath?,repoPath?}` 读取仓库证据，响应包含固定提交、证据路径和配置建议 |
| GET          | /ai/conversations              | 仅当前用户的会话                                                                                                           |
| GET          | /ai/conversations/:id/messages | 仅会话发起者可读                                                                                                           |
| GET          | /ai/proposals                  | 当前用户的执行提案                                                                                                         |
| POST         | /ai/proposals/:id/confirm      | 重新校验权限、目标与配置后最多提交一次                                                                                     |
| POST         | /ai/proposals/:id/reject       | 拒绝提案，不执行                                                                                                           |

登录用户可通过 `GET /ai/routing` 查看模型用途映射。管理员用 `PUT /ai/routing` 整体保存 `{chat?, repository?, diagnosis?}`，每个字段引用一个 Provider ID。省略某个用途可恢复该用途的默认选择。

`PATCH /ai/policies` 支持 `actionRules` 条件写操作规则，每条包含 `action`、`effect`（`DENY` 或 `CONFIRM`），以及可选的 `role`、`serverId`、`minimumTargets`。仓库写操作仅支持角色条件。省略数组保留已有规则，传空数组清除当前策略的条件规则。

API Key 不回显，更新时省略 Key 表示保留。AI 为空或禁用不会影响手工运维。策略与工具限制见 [AI 说明](AI工具与权限.md)。

`context.kind` 支持 `SERVICE`、`REPOSITORY`、`TASK`、`OPERATION_PLAN`。分别使用 `serviceId`、`repositoryId`、`taskId`、`operationPlanId` 绑定页面对象。仓库可附完整 `commitSha` 和同项目的 `serviceId`。运维方案可附正整数 `version`。后续轮次只需传 `conversationId`，更换已绑定对象会返回 400。提案超出当前资源范围或执行权限时，列表中的 `scopeRevoked` 为 true，执行参数和预览均为空，发起人仍可放弃提案。

仓库分析省略 `commitSha` 时固定远端默认分支的完整提交，返回证据路径、技术栈、服务线索、草稿和缺失字段。巡检通过固定 SSH 查询采集目标环境，诊断只返回结构化故障分类与失败步骤。


备份恢复由[维护命令](BACKUP.md)提供。

## V1.2 服务器资源与配置

以下路径使用统一前缀 `/api/v1`。

| 请求 | 权限与结果 |
| --- | --- |
| `GET /monitoring/settings` | 登录后可读全局开关、采样间隔、保留天数和采集并发。 |
| `PATCH /monitoring/settings` | 管理员可部分更新 `enabled`、`intervalSeconds`（15–3600）、`retentionDays`（1–90）、`concurrency`（1–10）。默认值为关闭、60 秒、7 天、3 路。 |
| `GET /monitoring/servers?summary=true` | 返回各活跃服务器最近的采集状态、时间和指标。列表摘要只传根分区和首选网卡。 |
| `GET /monitoring/servers/:id?hours=24&metric=cpu` | 查看 1 或 24 小时趋势。指标可选 `cpu`、`memory`、`disk`、`rx` 或 `tx`，磁盘和网络使用 `mount`、`interfaceName` 选择。速率单位为字节/秒，缺失样本的值为 null。 |
| `PATCH /monitoring/servers/:id` | 管理员或运维员可更新单机 `enabled` 和首选 `interfaceName`，传 null 清除首选网卡。 |
| `POST /monitoring/servers/:id/refresh` | 管理员或运维员刷新单机采样，同一台主机复用进行中的采集。关闭监控或采集并发已满时返回 409。 |
| `POST /servers/configuration/compare` | 管理员或运维员传入不同服务器的 `baselineId` 和 `comparisonId`。每行 `EQUAL` 表示一致，`DIFFERENT` 表示有差异，`UNKNOWN` 表示至少一侧缺少事实。单侧 SSH 失败保留另一侧结果。 |
