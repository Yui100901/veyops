# veyops

以项目为中心、通过 SSH 管理服务器的轻量运维平台。根据 [需求文档](需求文档.md) 开发，技术栈为 **NestJS + React + TypeScript + Kysely**，默认 SQLite，可配置 PostgreSQL，不依赖 Redis 和 Agent。

当前为 **v0.2.0：Pipeline、构建部署与可选 AI**。已打通四种构建部署组合和 AI 工具调用；完整 V1.0 仍有后续工作，详见 [需求梳理与实施计划](docs/需求梳理与实施计划.md)。

## 启动

需要 Node.js **22.12+（推荐 24 LTS）** 和 npm。

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

打开 <http://localhost:5173>，首次访问创建管理员，密码至少 12 位。无默认账号密码。API 运行于 `127.0.0.1:3000`，前端开发代理转发 `/api`。启动自动执行版本化 Migration。

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
| 凭据     | AES-256-GCM 加密、元数据列表、改名、轮换、禁用、引用保护、API 不返回密文或明文                                       |
| 服务器   | 新增/编辑/软移除、标签、严格 SHA256 主机指纹验证、真实 SSH 连接测试、分组基础 API                                    |
| 项目     | 项目创建/编辑/软删除、仓库/服务/环境基础管理、唯一标识检查，敏感 Git URL 拒绝                                        |
| 命令     | 明确选择目标、确认后执行、分组/标签目标解析、去重、并行/顺序、并发限制、失败策略、超时                               |
| 任务     | 数据库队列、原子领取、SQLite 单 Worker 租约、心跳、异常 NEEDS_ATTENTION、每目标/步骤状态、取消                       |
| 日志     | 本地文件、凭据流式脱敏、偏移续读、SSE、页面轮询查看历史和运行日志                                                    |
| 运维方案 | 多步骤创建/版本化/固定版本执行 API，页面查看与执行，系统巡检及 Docker/Node/Nginx 初始化模板                          |
| 控制台   | 概览、资源页面、批量命令二次确认、任务结果/日志、审计、配置展示                                                      |
| 交付     | Pipeline 表单/步骤排序/不可变版本、固定 Commit、目标端与管理端构建、文件发布与 Docker Compose、产物/逐服务器部署记录 |
| 环境     | 部署目标 CRUD、服务仓库关联、服务环境配置、普通/敏感变量分层合并与执行快照                                           |
| AI       | 可选 OpenAI 兼容 Provider、加密 API Key、启停/连接测试、私有会话、业务工具、草稿、三种权限模式与提案确认             |

使用方法见 [Pipeline 与构建部署](docs/PIPELINES.md)、[AI 工具与权限](docs/AI工具与权限.md)，本轮结果见 [v0.2 验证报告](docs/v0.2验证报告.md)。

**后续工作**：SSH Git 仓库可信注入、仓库源码分析、可视化方案编辑器与参数化、单目标重试、独立 Worker 入口、自动回滚、聚合视图、备份恢复等。本轮不声称已经完成全部 V1.0。

## Pipeline 与 AI

创建项目、HTTP(S) 仓库、服务、环境和部署目标后，在 Pipeline 页面填写构建/部署配置。每次编辑追加版本，运行必须指定完整 Commit 和目标并确认。支持 `TARGET/MANAGER × FILE/DOCKER_IMAGE` 四种组合。文件部署使用专属目录和原子 `current` 切换；Docker 部署使用 Registry 不可变 Digest 和 `${VEYOPS_IMAGE}` Compose 模板。健康检查失败会保留历史结果，但不会自动回滚。

管理端构建必须能调用 Docker CLI/daemon，仓库脚本只在隔离容器中执行，不会退回平台主进程运行。可信检出/打包镜像默认 `node:22-bookworm`，可在服务端以 `BUILD_HELPER_IMAGE` 指定已审核镜像。平台的默认 Docker Compose 不暴露 Docker Socket；容器化平台若需管理端构建，还需管理员配置可用的构建运行环境和共享工作目录，或直接在具备 Docker 的 Linux 主机运行 API/Worker。

AI 可以完全不配置；管理员在“系统设置 → AI 模型连接（可选）”中填写 Base URL、模型和 Key，亦可随时禁用。默认权限为 `CONFIRM`。自由 Shell 和部署即使在 FULL_CONTROL 下也仍按未知风险要求确认，固定只读巡检可在明确授权范围内自动提交。模型通过业务工具操作，不能直接读取凭据或数据库。

新安装默认不包含模型密钥。可在系统设置添加 DeepSeek 或其他 OpenAI 兼容服务。DeepSeek 可填写 `https://api.deepseek.com` 和 `deepseek-flash`，模型名称原样发送。

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

Compose 默认监听 `127.0.0.1:3000`，使用命名卷保存数据，不挂载 Docker Socket。若经 HTTPS 反向代理访问，设置 `COOKIE_SECURE=true`，并保留请求 Host；外部访问需由部署者配置 HTTPS 与网络访问控制。本机无 Docker，构建定义尚未实际运行验证。

PostgreSQL 在 `.env` 中设置：

```dotenv
DATABASE_CLIENT=postgres
DATABASE_URL=postgresql://veyops:password@localhost:5432/veyops
```

迁移使用跨数据库字段规范；PostgreSQL DDL 已检查，尚未连接真实实例验收。切换连接不会迁移已有数据，SQLite/PostgreSQL 数据迁移工具待实现。

## 测试与验证

```powershell
npm test
npm run lint
npm run build
```

数据库、API、执行引擎和真实 SSH 协议测试使用独立临时数据库或本机临时 SSH Server，不会自动连接生产服务器。覆盖权限限制、凭据不回显、外键保护、事务回滚、重复领取、固定快照、并发/失败/取消/超时和租约异常。

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

本迭代 API 与 Worker 同进程运行，遵守统一处理器注册机制；独立 Worker bootstrap、UI 用户管理、参数化方案、单目标重试、日志轮转与正式备份恢复仍需继续开发。手工离线备份建议：先停止平台进程，再整体备份 `data/` 和配置中的外部主密钥；恢复到独立环境检查。不要在数据库运行时仅复制 SQLite 主文件。
