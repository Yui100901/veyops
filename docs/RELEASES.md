# VeyOps v1.0.0 发布与安装

## 发布文件

| 文件                                     | 用途                                                          |
| ---------------------------------------- | ------------------------------------------------------------- |
| `veyops-1.0.0-source.zip`                | 发布提交的源代码，包括迁移、测试、示例、Compose 配置和文档。  |
| `veyops-1.0.0-linux-amd64.docker.tar.gz` | Linux amd64 Docker 镜像归档，加载后为 `veyops:1.0.0`。        |
| `veyops-1.0.0-compose.zip`               | 使用预构建镜像时需要的 Compose 配置、环境变量示例和安装文档。 |
| `RELEASE-NOTES.md`、`SHA256SUMS`         | 发布提交、镜像标识和文件校验值。                              |

在下载目录执行 `sha256sum -c SHA256SUMS` 检查文件。Windows PowerShell 可用 `Get-FileHash -Algorithm SHA256 <文件>` 与清单核对。

## 从归档安装

在具备 Docker Engine 和 Compose v2 的 Linux amd64 主机加载镜像，并解压 Compose 包。

```sh
docker load --input veyops-1.0.0-linux-amd64.docker.tar.gz
unzip veyops-1.0.0-compose.zip
cp .env.example .env
```

在 `.env` 中设置持久的 64 位十六进制 `ENCRYPTION_KEY`，并加上 `VEYOPS_IMAGE=veyops:1.0.0`。`ADMIN_PASSWORD` 可设为 12–256 个字符，留空时首次启动会生成初始密码。SQLite 是默认数据库。选用已就绪的 PostgreSQL 时，设置 `DATABASE_CLIENT=postgres` 和 `DATABASE_URL`，并保证 Compose 容器能访问数据库。

```sh
docker compose up -d --no-build --pull never
curl --fail http://127.0.0.1:3000/api/v1/health
```

请用设定的初始密码登录，或从 `docker compose logs veyops` 查看首次启动生成的密码。服务默认绑定宿主机环回地址，浏览器访问 `http://127.0.0.1:3000`。页面提示需修改密码后才能进入工作台。安装后的 `/api/v1/health`、系统设置和侧栏应显示 `1.0.0`。

需要独立 Worker 时，在 `.env` 中将 `WORKER_ENABLED` 设为 `false`，使用 `docker compose --profile split-worker up -d --no-build --pull never`。API 和 Worker 共享同一数据库及数据卷。

发布镜像提供 VeyOps API、前端、Worker 和备份工具。应用项目的构建镜像、目标端软件或外部 PostgreSQL 由各自的环境提供。对于非 amd64 主机，请在目标架构上从源代码构建。备份、恢复及已有实例升级后的检查步骤见 [数据备份与恢复](BACKUP.md)。

## 从指定提交构建发布文件

在 Linux 上将 `release_ref` 指定为已经验收的完整 Git SHA。源代码包和 Compose 包直接读取该提交，避免将工作区的 `.env`、数据和未提交文件带入发布物。

```sh
release_ref=$(git rev-parse 'v1.0.0^{commit}')
output="$PWD/data/releases/v1.0.0"
mkdir -p "$output"
source_dir=$(mktemp -d)
git archive --format=zip --prefix=veyops-1.0.0/ --output="$output/veyops-1.0.0-source.zip" "$release_ref"
git archive --format=zip --output="$output/veyops-1.0.0-compose.zip" "$release_ref" docker-compose.yml .env.example docs/RELEASES.md docs/BACKUP.md
git archive "$release_ref" | tar -x -C "$source_dir"
docker build --platform linux/amd64 --label "org.opencontainers.image.revision=$release_ref" \
  --label org.opencontainers.image.version=1.0.0 -t veyops:1.0.0 "$source_dir"
docker save veyops:1.0.0 | gzip -n > "$output/veyops-1.0.0-linux-amd64.docker.tar.gz"
```

在 `RELEASE-NOTES.md` 中记录完整发布提交、操作系统和架构、构建时采用的基础镜像及最终镜像 ID。发布前用 `docker load` 回读镜像，并对默认 SQLite 与 PostgreSQL 分别执行独立安装检查。

```sh
cd "$output"
sha256sum veyops-1.0.0-source.zip veyops-1.0.0-compose.zip \
  veyops-1.0.0-linux-amd64.docker.tar.gz RELEASE-NOTES.md > SHA256SUMS
sha256sum -c SHA256SUMS
```
