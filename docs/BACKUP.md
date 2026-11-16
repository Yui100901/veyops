# 数据备份与恢复

备份包含数据库和其中的凭据密文、任务日志 `DATA_DIR/logs`、本地托管产物 `DATA_DIR/artifacts`、系统设置以及 `DATA_DIR/config` 中的文件。SQLite 使用 Backup API 保存已提交的 WAL 数据，PostgreSQL 使用 `pg_dump` 保存 VeyOps 当前 schema。备份目录内的清单记录文件 SHA-256，并使用实例的加密主密钥认证。

通过部署环境或密码管理器独立保存原有的 `ENCRYPTION_KEY`，恢复时使用相同的密钥。开发实例自动生成的 `DATA_DIR/config/encryption.key` 也需要单独保管。外部 `.env`、数据库账号、容器 Registry 内的镜像及部署目标端的数据各自保留。备份文件可能包含敏感日志和应用数据，请按生产数据限制目录访问。

## 控制台

管理员可在「系统设置 → 备份管理」创建在线备份、核对备份完整性并下载 `.tar.gz`。备份存放在 `DATA_DIR/backups`。通过 CLI 创建并放在该目录下的备份也可在页面管理，目录名需以字母或数字开头，由最多 96 个字母、数字、下划线或短横线组成。页面下载需要服务端有 `tar`，Compose 发布镜像已包含。

在线备份先取得数据库快照，随后复制日志、产物和配置文件。建议在业务写入较少时执行。需要在同一维护窗口保存数据库和托管文件时，按下文停止源 API 和 Worker，再用维护命令创建备份。

下载后把归档解压到新的专用目录，将该目录传给 `restore` 命令。在空目标实例中使用源实例的主密钥，并在验证恢复结果前保持 Worker 禁用。

```sh
mkdir ./restore-bundle
tar -xzf ./downloaded-veyops-backup.tar.gz -C ./restore-bundle
node apps/api/dist/core/database/backup-cli.js restore ./restore-bundle
```

## 原生安装

在实例目录运行 `npm run build -w apps/api`。命令读取与运行实例相同的环境变量和 `.env`，其中包括 `DATABASE_CLIENT`、`DATABASE_PATH` 或 `DATABASE_URL`、`DATA_DIR` 以及主密钥。PostgreSQL 需要安装兼容的 `pg_dump` 和 `pg_restore`，可通过 `VEYOPS_PG_DUMP` 和 `VEYOPS_PG_RESTORE` 指定可执行文件路径。优先选择与服务端主版本相同的客户端。[PostgreSQL 客户端文档](https://www.postgresql.org/docs/17/app-pgdump.html)

等待正在运行的任务结束，停止源 VeyOps 实例的 API 和 Worker，让数据库与日志、产物处于同一状态。`/srv/backups/veyops-2026-11-13` 是待创建的目录，可替换成可写的绝对路径。成功后重新启动源实例。

```sh
node apps/api/dist/core/database/backup-cli.js create /srv/backups/veyops-2026-11-13
```

恢复时使用目标实例配置和原主密钥。SQLite 指向全新的数据库文件。PostgreSQL 先创建一个空数据库或空 schema，确保连接的 `search_path` 首个可用 schema 与源同名。数据库角色需要能在该 schema 内创建对象。目标 `DATA_DIR` 的日志、产物和配置目录应为空，开发模式可以预置原 `config/encryption.key`。在启动目标实例前执行恢复。

```sh
node apps/api/dist/core/database/backup-cli.js restore /srv/backups/veyops-2026-11-13
```

恢复验证主密钥和文件校验和，再写入目标。对 PostgreSQL 使用单事务恢复。若提示恢复中断或 PostgreSQL 结果无法核实，先检查目标数据库和数据目录，再决定是否使用新的空目标重试。

## Docker Compose 安装

平台镜像默认包含 PostgreSQL 17 客户端。数据库使用其他主版本时，可用 `docker compose build --build-arg POSTGRES_CLIENT_MAJOR=<主版本> veyops` 构建包含同版本客户端的镜像。备份前停止源项目的 VeyOps 容器和同项目中运行的独立 Worker，保持 PostgreSQL 可用。准备宿主机备份目录 `/srv/backups` 并允许镜像的 `node` 用户写入。将其挂载到一次性容器，容器从当前 Compose 项目挂载原数据卷并继承原实例配置。

```sh
docker compose stop veyops
docker compose run --rm --no-deps -v /srv/backups:/backup veyops \
  node apps/api/dist/core/database/backup-cli.js create /backup/veyops-2026-11-13
docker compose up -d veyops
```

恢复使用新 Compose 项目及独立数据卷。准备 `restore.env`，保留原主密钥，设置独立的 `PORT` 和目标数据库连接，并设置 `WORKER_ENABLED=false`。先创建新的 PostgreSQL 目标数据库（SQLite 无需此步）。

```sh
docker compose -p veyops-restore --env-file restore.env run --rm --no-deps \
  -v /srv/backups:/backup:ro veyops \
  node apps/api/dist/core/database/backup-cli.js restore /backup/veyops-2026-11-13
docker compose -p veyops-restore --env-file restore.env up -d veyops
```

登录恢复实例，确认任务记录、日志和产物均可读取，核对产物校验和并使用专用测试凭据验证解密。恢复会保留队列状态。检查并取消无需再次执行的历史任务后，按需启用 Worker。
