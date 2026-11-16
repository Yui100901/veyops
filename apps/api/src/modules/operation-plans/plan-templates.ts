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
