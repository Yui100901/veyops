# Pipeline、构建与部署

Pipeline是服务级的版本化交付配置。每次修改追加不可变版本；每次执行必须明确环境、部署目标、完整Git Commit和确认。目标、连接信息、有效配置与普通变量在提交时生成快照，敏感变量只保存凭据引用并在执行时解密。所有运行进入现有数据库任务队列，与命令和方案共用Worker、日志、取消和目标状态。

## 配置与运行

1. 创建项目、HTTP(S) Git仓库、服务和环境。
2. 创建部署目标并明确服务器成员及执行顺序、并发和失败策略。
3. 创建Pipeline，选择仓库、构建位置、产物类型、构建命令及专用部署目录。
4. 可选地保存服务环境配置及环境变量。非空环境配置覆盖Pipeline的同名构建/部署字段，服务环境变量覆盖环境变量。
5. 运行时填写40或64位完整Commit SHA，预览版本和目标后确认。
6. 任务中心展示目标/步骤结果与日志，产物和部署历史分别记录每台服务器的结果。

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

提交运行：`POST /api/v1/pipelines/:id/run`，请求`{environmentId,targetId,commitSha,version?,confirmed:true}`。省略version时固定当前版本。AI确认流程还校验目标和配置哈希，资源变化后要求重新确认。

## 构建与部署矩阵

| 构建位置 | 产物         | 行为                                                                                 |
| -------- | ------------ | ------------------------------------------------------------------------------------ |
| TARGET   | FILE         | 每台主机独立检出固定Commit、执行依赖/构建/附加步骤、打包、SHA256校验、发布版本目录   |
| MANAGER  | FILE         | 管理端Docker隔离构建一次，保存本地不可变产物，通过SFTP分发至所有目标并逐台验证SHA256 |
| TARGET   | DOCKER_IMAGE | 每台目标独立构建镜像、推送Registry、读取Digest，使用固定Digest执行Compose            |
| MANAGER  | DOCKER_IMAGE | 隔离生成构建上下文，管理端Docker构建/推送一次，所有服务器部署同一Digest              |

TARGET要求目标预装Git、tar、sha256sum及项目语言工具链；Docker模式另需Docker CLI/daemon、BuildKit和Compose。平台不会隐式安装这些依赖。管理端构建需要平台所在环境可使用Docker CLI/daemon；未配置时任务明确失败，不会退回主进程执行仓库脚本。

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

启动命令可留空；非空命令在新`current`中以SSH用户身份执行。健康检查同样运行在发布目录中。失败保留历史成功记录，并将本次记录标记FAILED；**当前不自动回滚current或Compose服务**，自动回滚属于后续版本。生产部署前应验证自己的启动、健康检查和回退流程。

## Docker与Registry

在Registry页面填写`host[:port]`，不要加HTTP协议或凭据。可引用DOCKER_REGISTRY/USERNAME_PASSWORD凭据。密码通过`docker login --password-stdin`提供，配置文件使用独立临时目录并在任务结束后清理。

Docker Pipeline额外填写`registryId`、`imageRepository`、`dockerfilePath`和`composeFilePath`。镜像Tag使用完整Commit，部署必须使用Registry返回的不可变`sha256` Digest。Compose文件需引用平台设置的`VEYOPS_IMAGE`，例如：

```yaml
services:
  web:
    image: ${VEYOPS_IMAGE}
    ports:
      - '127.0.0.1:8080:8080'
```

平台会校验Compose实际渲染的镜像列表包含该Digest，再执行pull和`up -d --no-build`。Compose项目名由服务和环境ID派生，分别隔离。Registry TLS信任由部署环境管理；平台不会自动关闭TLS校验或修改Docker daemon信任配置。

## 相关接口

- `GET/POST /pipelines`，`GET/PATCH/DELETE /pipelines/:id`（DELETE为禁用，保留历史）。
- `GET /pipelines/:id/versions`，`POST /pipelines/:id/preview`，`POST /pipelines/:id/run`。
- `GET /artifacts`，`GET /deployments`，可使用`projectId`筛选。
- `GET/POST /registries`；Registry创建仅ADMIN。

验证结果以项目验证报告为准。单元测试覆盖四种矩阵、版本和Commit快照、配置漂移拒绝、确定构建错误状态、目录保护及凭据不进入命令参数；单元模拟通过不等于真实环境完整验收。
