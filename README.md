# veyops

以项目为中心、通过 SSH 管理服务器的轻量运维平台。根据 [需求文档](需求文档.md) 开发，技术栈为 **NestJS + React + TypeScript + Kysely**，默认 SQLite，可配置 PostgreSQL，不依赖 Redis 和 Agent。

当前版本为 **v1.0.0**。支持管理端和目标端构建、文件与镜像交付、批量运维、可选 AI、用户管理和备份。源码、Compose 与离线镜像的安装步骤见 [发布与安装](docs/RELEASES.md)。

## 启动

需要 Node.js **22.12+（推荐 24 LTS）** 和 npm。

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

打开 <http://localhost:5173>。API 运行于 `127.0.0.1:3000`，前端开发代理转发 `/api`。启动时自动迁移数据库。空库会初始化管理员 `root`。可在 `.env` 中用 `ADMIN_PASSWORD` 提供 12–256 位的初始密码，留空则生成随机密码，并在初始化成功后打印到启动控制台。Docker Compose 部署可用 `docker compose logs veyops` 查看首次启动输出。

使用初始密码登录后，先按提示修改密码，再用新密码登录。改密会撤销该账号的全部现有会话。已有数据库继续使用原账号，重启或修改 `ADMIN_PASSWORD` 不会重置密码。

管理员可在「系统设置 → 用户管理」创建账号、调整角色、启用或停用账号，以及重置临时密码。新建或重置的账号登录后必须先修改密码。需要修改自己的密码时，使用账号旁的「修改密码」。

也可以构建后由 NestJS 同时提供前端和 API：

```powershell
npm run build
npm start
```

打开 <http://127.0.0.1:3000>。本地开发 API 文档位于 <http://127.0.0.1:3000/api/docs>，请求示例见 [API 文档](docs/API.md)。

Windows 下若 better-sqlite3 预编译下载失败，检查到 GitHub Releases 的网络或代理；需要本地编译时安装 Visual Studio C++ Build Tools 与 Python。此次环境已安装与 Node 24 匹配的官方预编译绑定。不要用 `--ignore-scripts` 作为最终安装方式，它会跳过 SQLite 原生绑定。

## 当前能力

| 范围     | 已实现                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| 基础     | npm workspaces、严格 TypeScript、ESLint、统一 API/错误/DTO 校验、40 表初始迁移                                       |
| 认证     | 首次管理员初始化、scrypt 密码哈希、数据库会话、HttpOnly Cookie、ADMIN / OPERATOR / VIEWER 角色校验                   |
| 用户管理 | 管理员创建账号、分配角色、启停账号和重置临时密码，账号变更与会话撤销记录在审计中                                     |
| 凭据     | AES-256-GCM 加密、元数据列表、改名、轮换、禁用、引用保护、API 不返回密文或明文                                       |
| 服务器   | 新增、编辑、软移除、标签筛选、分组成员管理、SSH 主机指纹验证、系统状态及执行历史                                     |
| 项目     | 项目、仓库、服务、环境、访问地址、依赖和部署目标管理，以及部署记录聚合                                               |
| 项目视图 | 全部、生产、测试和异常预设，支持账号自定义项目集合、排序、默认视图和部署状态聚合                                     |
| 命令     | 按服务器、分组、标签、项目、环境或部署目标选择，去重预览、确认执行、并行或顺序执行、失败策略、版本化命令模板         |
| 任务     | 数据库队列、原子领取、SQLite 单 Worker 租约、心跳、异常 NEEDS_ATTENTION、每目标/步骤状态、取消                       |
| 日志     | 本地文件、凭据流式脱敏、偏移续读、SSE、页面轮询查看历史和运行日志                                                    |
| 运维方案 | 编辑步骤、参数、前置检查和执行后验证，按版本执行，查看逐目标结果并重试，预置巡检和 Docker、Node.js、Nginx 初始化方案 |
| 控制台   | 首页服务状态、最近部署和失败任务汇总，资源页面、批量命令二次确认、任务结果和日志、审计及配置展示                    |
| 系统设置 | 管理员可设置默认构建位置、目标并发和任务日志保留期，保存后在执行入口生效                                             |
| 交付     | Pipeline 表单/步骤排序/不可变版本、固定 Commit、目标端与管理端构建、文件发布与 Docker Compose、产物/逐服务器部署记录 |
| 环境     | 部署目标 CRUD、服务仓库关联、服务环境配置、普通/敏感变量分层合并与执行快照                                           |
| AI       | 可选 OpenAI 兼容 Provider、加密 API Key、启停/连接测试、私有会话、业务工具、草稿、三种权限模式与提案确认             |

使用方法见 [Pipeline 与构建部署](docs/PIPELINES.md)、[AI 工具与权限](docs/AI工具与权限.md)，本轮结果见 [v0.2 验证报告](docs/v0.2验证报告.md)。

**后续工作**：SSH Git 仓库可信注入、自动回滚等。

## Pipeline 与 AI

创建项目、HTTP(S) 仓库、服务、环境和部署目标后，在 Pipeline 页面填写构建/部署配置。每次编辑追加版本，运行必须指定完整 Commit 和目标并确认。支持 `TARGET/MANAGER × FILE/DOCKER_IMAGE` 四种组合。文件部署使用专属目录和原子 `current` 切换；Docker 部署使用 Registry 不可变 Digest 和 `${VEYOPS_IMAGE}` Compose 模板。健康检查失败会保留历史结果，但不会自动回滚。

选择「仅构建」可检出固定提交并生成文件产物或镜像。Gitea Webhook 在专用 rootless Docker 环境中自动构建指定分支提交。发布锁按主机、服务环境与部署路径限制并发，远端结果不确定时保留锁供核查。接入与恢复步骤见 [Pipeline 文档](docs/PIPELINES.md)。

从项目的仓库详情测试 HTTP(S) Git 连接并浏览分支与提交。Pipeline 运行时选择完整 SHA，在任务详情下载文件包或镜像归档，下载响应和产物记录都提供 SHA-256。管理员也可在镜像仓库页面编辑地址、凭据并测试连通性。

管理端构建必须能调用 Docker CLI/daemon，仓库脚本只在隔离容器中执行，不会退回平台主进程运行。可信检出/打包镜像默认 `node:22-bookworm`，可在服务端以 `BUILD_HELPER_IMAGE` 指定已审核镜像。平台的默认 Docker Compose 不暴露 Docker Socket；容器化平台若需管理端构建，还需管理员配置可用的构建运行环境和共享工作目录，或直接在具备 Docker 的 Linux 主机运行 API/Worker。

AI 可以完全不配置。管理员在“系统设置 → AI 模型连接（可选）”中填写 Base URL、模型和 Key，亦可随时禁用。默认权限为 `CONFIRM`。AI 可根据固定提交的仓库证据生成部署草稿、只读巡检目标并诊断任务。完全控制模式允许审核过的初始化方案、已授权的固定发布及授权仓库的评审分支和 PR。任意 Shell 仍需审批，PR 由人工合并。模型只能通过注册的业务工具操作资源。

设置 `AI_PIPELINE_ANALYSIS=true` 可启用 Pipeline 完成后的只读结果分析。任务详情显示模型摘要或不可用提示，执行状态由任务系统独立记录。详见 [AI 工具与权限](docs/AI工具与权限.md#pipeline-结果分析)。

新安装默认不包含模型密钥。可在系统设置添加 DeepSeek 或其他 OpenAI 兼容服务。DeepSeek 可填写 `https://api.deepseek.com` 和 `deepseek-flash`，模型名称原样发送。

## 定时运维与通知

在任务中心配置定时运维。选择命令模板或运维方案的版本、参数和目标，预览执行内容及时间后启用。调度支持单次、固定间隔和五字段 Cron，可设置时区及是否逐次确认。计划与执行历史会显示任务、暂停原因、并发跳过和停机漏跑。

顶部通知入口显示个人未读数。构建、部署和回滚按阶段汇总并分为普通、告警、失败。可按项目及阶段订阅，在个人通知设置验证收件邮箱、开启邮件并选择最低接收等级。管理员在系统设置配置发件地址、SMTP 和公开访问地址，测试连接通过后即可供用户验证邮箱。通知的邮件详情链接需登录后打开。

## 接入服务器

1. 凭据中心创建 SSH 密码或 SSH 私钥凭据。
2. 通过已有可信 `known_hosts` 或服务器控制台核对主机公钥指纹，例如在服务器控制台运行 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`。
3. 在服务器页面填写地址、端口、SSH 用户、凭据和 `SHA256:...` 指纹。
4. 点击测试连接。状态仅代表最近一次连接结果。
5. 在命令中心明确选择目标，预览并确认执行，前往任务中心查看每台服务器的退出码与日志。

不会自动信任未知主机。运行任务固定目标地址、用户名、凭据引用与主机指纹，不受后续服务器配置修改影响。凭据在执行时按需解密；轮换同一凭据会影响尚未建立连接的任务。服务器使用软移除保留历史；凭据被服务器、仓库或任务引用时不能删除，可以禁用。

取消或超时会请求终止 SSH channel，但无法保证服务器上的派生进程全部停止，需检查远程状态。Worker 异常后不自动重跑不确定的操作。`STOP` 阻止继续派发待执行目标，已经启动的并行目标仍完成执行。

## 配置与部署

配置项见 [.env.example](.env.example)。开发模式在 `data/config/encryption.key` 自动生成独立主密钥；生产必须提供稳定的 64 位十六进制 `ENCRYPTION_KEY`：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

将结果写入本地 `.env`，不要提交；丢失主密钥将无法解密凭据。数据库和日志保存在 `data/`，均已忽略。当前只支持 `key_version=v1`，多版本密钥轮换待实现。

```powershell
docker compose up -d --build
```

Compose 默认监听 `127.0.0.1:3000`，使用命名卷保存数据。可用 `PORT` 更换宿主机端口。若经 HTTPS 反向代理访问，设置 `COOKIE_SECURE=true` 并保留请求 Host。

PostgreSQL 在 `.env` 中设置：

```dotenv
DATABASE_CLIENT=postgres
DATABASE_URL=postgresql://veyops:password@db.example.internal:5432/veyops
```

数据访问使用 Kysely，SQLite 驱动为 `better-sqlite3`，PostgreSQL 驱动为 `pg`。两种数据库共享业务表和版本化迁移。默认 SQLite 使用单 Worker。Docker Compose 从 `.env` 读取相同的 `DATABASE_CLIENT` 和 `DATABASE_URL`，其中数据库主机名必须能从容器访问。如果数据库在同一个 Compose 网络内，可用数据库服务名作为主机名。

切换数据库只会切换连接，现有数据保留在原库。PostgreSQL 账号需对应用所在 schema 有建表权限。多进程共用 PostgreSQL 时还需共享 `DATA_DIR` 和 `ENCRYPTION_KEY`，并保持主机时钟同步。

管理员可在「系统设置」修改默认构建位置、目标并发和任务日志保留期。日志默认长期保留，启用清理后由 Worker 定期删除超期的已结束任务日志。任务状态、审计和产物仍可查询。

### 单独启动 Worker

默认启动方式在 API 进程内运行 Worker。分开运行时，在共同配置中设置 `WORKER_ENABLED=false`，并分别启动 API 与 Worker。

```text
npm start
npm run start:worker
```

两个进程使用同一数据库、`DATA_DIR` 和 `ENCRYPTION_KEY`。SQLite 只启动一个 Worker。PostgreSQL 的多进程任务领取依赖数据库租约。Worker 需要能够访问部署或构建所需的 SSH 目标及运行环境。

使用 Docker Compose 时同样在 `.env` 中设置 `WORKER_ENABLED=false`，再运行 `docker compose --profile split-worker up -d --build`。独立 Worker 共用数据卷，并在 API 就绪后启动。

管理员可在「系统设置 → 备份管理」创建、校验和下载备份。备份包含数据库、任务日志、托管产物和数据目录中的配置。将主密钥与备份分开保存。恢复使用维护 CLI，先设置 `WORKER_ENABLED=false`，核对历史和待执行任务后再启动 Worker。步骤见 [备份与恢复](docs/BACKUP.md)。

## 测试与验证

```powershell
npm test
npm run lint
npm run build
```

数据库、API、执行引擎和真实 SSH 协议测试使用独立临时数据库或本机临时 SSH Server，不会自动连接生产服务器。覆盖权限限制、凭据不回显、外键保护、事务回滚、重复领取、固定快照、并发/失败/取消/超时和租约异常。

需要复测 PostgreSQL 时，先设置 `VEYOPS_TEST_POSTGRES_URL` 指向可创建临时 schema 的测试数据库，再运行 `npm test`。PostgreSQL 用例为每次运行创建隔离 schema，测试结束后清理。省略此变量时只运行默认的本地测试。

已在 Linux 的隔离 Compose 项目中验证 SQLite 和 PostgreSQL 17 空库安装、首次改密、容器重建和备份恢复。恢复后检查了迁移记录、凭据解密、任务日志和产物 SHA-256。两个环境还用同一提交从不同子目录并发构建到同一 Registry 仓库，验证了各自的镜像标签、Digest 和实际运行内容。

经用户授权，于 2026-11-11 完成了 v0.1 的 [只读 SSH 验证](docs/验证报告.md)，以及 v0.2 在专用 `/tmp` 目录和新建容器中的 [构建部署验证](docs/v0.2验证报告.md)。未停止或重启已有业务服务。临时数据库与默认首次初始化库分离；源码和文档不包含服务器密码或真实 API Key。

## 目录

```text
apps/api/src/
  core/                  配置、数据访问、迁移、HTTP 规范
  infrastructure/ssh/    统一 SSH、流式脱敏、多目标执行
  modules/               认证、凭据、服务器、项目、任务、命令、方案、审计
  tests/                 API、任务与 SSH 协议测试
apps/web/src/            React 管理界面
docs/                   需求梳理、API、验证与后续工作
```

API 与独立 Worker 使用同一套任务处理器。
