import { ExecutionStep } from '../tasks/tasks.types';
import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';

export interface PlanTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  osRequirements?: string;
  preChecks?: ExecutionStep[];
  steps: ExecutionStep[];
  postChecks?: ExecutionStep[];
}
/** Installation templates deliberately require an explicit run and a root SSH account. */
export const planTemplates: PlanTemplate[] = [
  {
    id: '41000000-0000-4000-8000-000000000001',
    name: 'Linux 系统巡检',
    description: '只读检查系统信息、负载、磁盘与内存，不修改服务器配置。',
    category: 'INSPECTION',
    osRequirements: 'Linux',
    steps: [
      { name: '系统与运行时间', command: 'uname -a; uptime', timeout: 30 },
      { name: '磁盘与内存', command: 'df -h; free -m', timeout: 30 },
      {
        name: '服务健康概览',
        command:
          'if command -v systemctl >/dev/null 2>&1; then systemctl --failed --no-pager; else ps -eo pid,comm | head -20; fi',
        timeout: 30,
      },
    ],
  },
  {
    id: '41000000-0000-4000-8000-000000000002',
    name: 'Docker 初始化 · Debian / Ubuntu',
    description:
      '适用于具备 apt-get 和 systemd 的 Debian/Ubuntu，安装发行版 docker.io；需 root 权限。执行前请检查步骤。',
    category: 'INITIALIZATION',
    osRequirements: 'Debian / Ubuntu，apt-get、systemd 和 root 权限',
    preChecks: [
      {
        name: '检查 root、APT 和 systemd',
        command: 'test "$(id -u)" -eq 0 && command -v apt-get && command -v systemctl',
        timeout: 30,
      },
    ],
    steps: [
      {
        name: '安装 Docker',
        command:
          'command -v docker >/dev/null 2>&1 || (apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io)',
        timeout: 900,
      },
    ],
    postChecks: [
      {
        name: '启动并验证',
        command: 'systemctl enable --now docker && docker --version && systemctl is-active docker',
        timeout: 120,
      },
    ],
  },
  {
    id: '41000000-0000-4000-8000-000000000003',
    name: 'Node.js 初始化 · Debian / Ubuntu',
    description: '使用发行版 apt 软件源安装 Node.js/npm。版本由服务器软件源决定，需 root 权限。',
    category: 'INITIALIZATION',
    osRequirements: 'Debian / Ubuntu，apt-get 和 root 权限',
    preChecks: [
      {
        name: '检查 root 和 APT',
        command: 'test "$(id -u)" -eq 0 && command -v apt-get',
        timeout: 30,
      },
    ],
    steps: [
      {
        name: '安装 Node.js 与 npm',
        command:
          '(command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1) || (apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm)',
        timeout: 900,
      },
    ],
    postChecks: [{ name: '验证版本', command: 'node --version && npm --version', timeout: 30 }],
  },
  {
    id: '41000000-0000-4000-8000-000000000004',
    name: 'Nginx 初始化 · Debian / Ubuntu',
    description: '使用发行版 apt 软件源安装并启动 Nginx，需 root 权限及 systemd。',
    category: 'INITIALIZATION',
    osRequirements: 'Debian / Ubuntu，apt-get、systemd 和 root 权限',
    preChecks: [
      {
        name: '检查 root、APT 和 systemd',
        command: 'test "$(id -u)" -eq 0 && command -v apt-get && command -v systemctl',
        timeout: 30,
      },
    ],
    steps: [
      {
        name: '安装 Nginx',
        command:
          'command -v nginx >/dev/null 2>&1 || (apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y nginx)',
        timeout: 900,
      },
    ],
    postChecks: [
      {
        name: '配置检查并启动',
        command: 'nginx -t && systemctl enable --now nginx && systemctl is-active nginx',
        timeout: 120,
      },
    ],
  },
  {
    id: '41000000-0000-4000-8000-000000000005',
    name: 'Docker Compose v2 初始化 · Debian / Ubuntu',
    description: '从系统 APT 软件源安装 Compose v2，需要已有的 Docker CLI 和 root 权限。',
    category: 'INITIALIZATION',
    osRequirements: 'Debian / Ubuntu，Docker CLI、APT 和 root 权限',
    preChecks: [
      {
        name: '检查 root、APT 和 Docker CLI',
        command: 'test "$(id -u)" -eq 0 && command -v apt-get && command -v docker',
        timeout: 30,
      },
    ],
    steps: [
      {
        name: '安装支持的 Compose v2 软件包',
        command: `set -eu
export LC_ALL=C
if docker compose version >/dev/null 2>&1; then exit 0; fi
apt-get update
for package in docker-compose-v2 docker-compose; do
  candidate=$(apt-cache policy "$package" | awk '/Candidate:/ { print $2; exit }' | sed 's/^[0-9][0-9]*://')
  if test -n "$candidate" && test "$candidate" != '(none)' && dpkg --compare-versions "$candidate" ge 2.0; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$package"
    exit 0
  fi
done
echo '当前 APT 源没有可用的 Docker Compose v2 软件包' >&2
exit 1`,
        timeout: 900,
      },
    ],
    postChecks: [{ name: '验证 Compose v2', command: 'docker compose version', timeout: 30 }],
  },
  {
    id: '41000000-0000-4000-8000-000000000006',
    name: '文件系统容量与 inode 巡检',
    description: '分别检查本地文件系统的可用空间与 inode，用于定位磁盘未满但无法写入的问题。',
    category: 'INSPECTION',
    osRequirements: 'Linux，GNU df',
    steps: [
      { name: '本地文件系统容量（KiB）', command: 'LC_ALL=C df -lkP', timeout: 30 },
      { name: '本地 inode 使用量', command: 'LC_ALL=C df -liP', timeout: 30 },
    ],
  },
  {
    id: '41000000-0000-4000-8000-000000000007',
    name: '构建工具版本核对',
    description: '列出目标端常见编译器、包管理器与 Git 版本。缺少的工具会标记为不可用。',
    category: 'INSPECTION',
    osRequirements: 'Linux，POSIX shell',
    steps: [
      {
        name: '编译器、运行时与包管理器',
        command: `cd / || exit 1
export COREPACK_ENABLE_NETWORK=0 npm_config_update_notifier=false
for tool in git go java javac rustc cargo python3 node npm pnpm; do
  printf '%s: ' "$tool"
  if ! command -v "$tool" >/dev/null 2>&1; then echo unavailable; continue; fi
  if version=$(case "$tool" in go) go version ;; java|javac) "$tool" -version ;; *) "$tool" --version ;; esac 2>&1); then
    printf '%s\\n' "$version" | head -n 1
  else echo 'version unavailable'; fi
done`,
        timeout: 60,
      },
    ],
  },
  {
    id: '41000000-0000-4000-8000-000000000008',
    name: '时区与时间同步核对',
    description: '核对主机本地时间、UTC 时间，以及 systemd 提供的时区和同步状态。',
    category: 'INSPECTION',
    osRequirements: 'Linux，date；同步状态需要运行 systemd',
    steps: [
      {
        name: '本地时间及 UTC',
        command: "date '+%Y-%m-%d %H:%M:%S %z'; date -u '+%Y-%m-%d %H:%M:%S UTC'",
        timeout: 10,
      },
      {
        name: '同步状态',
        command:
          'if command -v timedatectl >/dev/null 2>&1 && test -d /run/systemd/system; then timedatectl show -p Timezone -p NTP -p NTPSynchronized; else echo "systemd time status unavailable"; fi',
        timeout: 15,
      },
    ],
  },
  {
    id: '41000000-0000-4000-8000-000000000009',
    name: 'Linux 文件句柄与进程限额核对',
    description: '检查当前 SSH 会话的文件句柄限制和内核的文件句柄、进程上限，供构建并发排查。',
    category: 'INSPECTION',
    osRequirements: 'Linux，已挂载 /proc',
    steps: [
      {
        name: '会话文件句柄软硬上限',
        command: 'printf "soft="; ulimit -Sn; printf "hard="; ulimit -Hn',
        timeout: 10,
      },
      {
        name: '内核上限',
        command:
          'set -e; for key in fs/file-max kernel/pid_max; do printf "%s=" "$key"; cat "/proc/sys/$key"; done',
        timeout: 10,
      },
    ],
  },
];

export async function seedPlanTemplates(database: Kysely<Database>, userId: string): Promise<void> {
  const now = Date.now();
  await database.transaction().execute(async (tx) => {
    for (const template of planTemplates) {
      await tx
        .insertInto('operation_plans')
        .values({
          id: template.id,
          name: template.name,
          description: template.description,
          category: template.category,
          created_by: userId,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) => conflict.column('id').doNothing())
        .execute();
      await tx
        .insertInto('operation_plan_versions')
        .values({
          id: template.id.replace('41000000', '42000000'),
          plan_id: template.id,
          version: 1,
          schema_version: 2,
          definition_json: JSON.stringify({
            name: template.name,
            description: template.description,
            category: template.category,
            osRequirements: template.osRequirements,
            preChecks: template.preChecks,
            steps: template.steps,
            postChecks: template.postChecks,
          }),
          created_by: userId,
          created_at: now,
        })
        .onConflict((conflict) => conflict.columns(['plan_id', 'version']).doNothing())
        .execute();
    }
  });
}
