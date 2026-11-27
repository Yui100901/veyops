import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { SshService, SshTarget } from '../../infrastructure/ssh/ssh.service';
import { TargetResolver } from '../command-center/target-resolver.service';
import { OperationPlansService } from '../operation-plans/operation-plans.service';
import { planTemplates } from '../operation-plans/plan-templates';
import { operationPackageManagers } from '../operation-plans/operation-chain';
import { isTerminalStatus, TasksService } from '../tasks/tasks.service';
import type { AiRepairOrigin } from '../tasks/tasks.types';

export const initializationPlans = {
  docker: '41000000-0000-4000-8000-000000000002',
  node: '41000000-0000-4000-8000-000000000003',
  nginx: '41000000-0000-4000-8000-000000000004',
  compose: '41000000-0000-4000-8000-000000000005',
} as const;

export type InitializationComponent = keyof typeof initializationPlans;

export const deploymentProbe = `export LC_ALL=C NPM_CONFIG_UPDATE_NOTIFIER=false
printf 'uid=%s\\n' "$(id -u)"
printf 'os=%s\\n' "$(awk -F= '$1 == "ID" { gsub(/"/, "", $2); print $2; exit }' /etc/os-release 2>/dev/null)"
printf 'init=%s\\n' "$(cat /proc/1/comm 2>/dev/null)"
for tool in ${operationPackageManagers.join(' ')} systemctl git curl docker node npm corepack nginx java go rustc python3; do
  if command -v "$tool" >/dev/null 2>&1; then printf '%s=available\\n' "$tool"; fi
done
df -Pk / | awk 'NR==2 { sub(/%$/, "", $5); printf "diskTotalKiB=%s\\ndiskUsedKiB=%s\\nfreeKiB=%s\\ndiskUsePercent=%s\\n", $2, $3, $4, $5 }'
if command -v ps >/dev/null 2>&1 && ps -eo comm=,args= | awk '
  $1 ~ /^(apt|apt-get|dpkg)$/ { busy = 1 }
  $1 ~ /^unattended-upgr(ade)?$/ && $0 !~ /unattended-upgrade-shutdown[[:space:]]+--wait-for-signal([[:space:]]|$)/ { busy = 1 }
  END { exit !busy }
'; then
  printf 'packageActivity=busy\\n'
fi
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet nginx; then
  printf 'nginxActive=available\\n'
fi
if command -v timeout >/dev/null 2>&1; then
  if command -v node >/dev/null 2>&1; then printf 'nodeVersion=%s\\n' "$(timeout 3 node --version 2>/dev/null | head -1)"; fi
  if command -v npm >/dev/null 2>&1; then printf 'npmVersion=%s\\n' "$(timeout 3 npm --version 2>/dev/null | head -1)"; fi
  if command -v docker >/dev/null 2>&1; then
    printf 'dockerVersion=%s\\n' "$(timeout 3 docker --version 2>/dev/null | awk 'NR==1 { gsub(/,/, "", $3); print $3 }')"
    if timeout 3 docker --host unix:///var/run/docker.sock version --format '{{.Server.Version}}' >/dev/null 2>&1; then printf 'dockerDaemon=available\\n'; fi
    if timeout 3 docker compose version >/dev/null 2>&1; then printf 'compose=available\\n'; fi
  fi
fi
printf 'probeComplete=1\\n'
exit 0`;

const probeKeys = new Set([
  'probeComplete',
  'uid',
  'os',
  'init',
  ...operationPackageManagers,
  'systemctl',
  'git',
  'curl',
  'docker',
  'node',
  'npm',
  'corepack',
  'nginx',
  'java',
  'go',
  'rustc',
  'python3',
  'freeKiB',
  'diskTotalKiB',
  'diskUsedKiB',
  'diskUsePercent',
  'packageActivity',
  'nodeVersion',
  'npmVersion',
  'dockerVersion',
  'dockerDaemon',
  'compose',
  'nginxActive',
]);

export function parseDeploymentProbe(output: string) {
  return Object.fromEntries(
    output.split(/\r?\n/).flatMap((line) => {
      const match = /^([a-zA-Z0-9-]+)=([a-zA-Z0-9._+-]{1,48})$/.exec(line);
      return match && probeKeys.has(match[1]!) ? [[match[1]!, match[2]!]] : [];
    }),
  );
}

const logFindings = [
  {
    code: 'IMAGE_PULL',
    match:
      /pull access denied|manifest unknown|no matching manifest|failed to (?:resolve|pull)\b|toomanyrequests|image pull|镜像拉取/i,
    suggestion:
      '核对镜像名称、平台架构、标签或 Digest、Registry 鉴权和目标的 DNS、TLS 与代理，再选择重试。',
  },
  {
    code: 'PACKAGE_BUSY',
    match:
      /could not get lock|unable to acquire.*lock|lock-frontend|another process.*(?:apt|dpkg)/i,
    suggestion: '查看包管理器是否仍在运行，等待事务结束后再检查。不要终止其他包管理器或删除锁。',
  },
  {
    code: 'MISSING_LIBRARY',
    match:
      /cannot open shared object file|error while loading shared libraries|library not found|pkg-config.*not found|fatal error:.*\.h: no such file/i,
    suggestion: '从固定提交中的依赖清单核对缺少的库，并确认构建镜像或目标能提供对应版本。',
  },
  {
    code: 'MISSING_TOOL',
    match:
      /command not found|executable file not found|缺少 (?:Git|Docker|构建工具)|目标主机找不到 Docker CLI|目标主机无法执行 docker compose|\b(?:npm|node|docker|git|nginx): not found/i,
    suggestion: '巡检目标工具和构建位置，按项目需要选择审核过的初始化方案或修正构建镜像。',
  },
  {
    code: 'DOWNLOAD',
    match:
      /ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|network is unreachable|failed to fetch|could not resolve|temporary failure resolving|certificate verify failed|curl: \([56728]+\)/i,
    suggestion:
      '核对目标访问依赖源的 DNS、网络、代理及证书。保持 TLS 校验，验证依赖源可用后再重试。',
  },
  {
    code: 'PORT_OCCUPIED',
    match: /address already in use|EADDRINUSE|port is already allocated/i,
    suggestion: '核对配置使用的端口和现有服务归属，选择该环境的可用端口。',
  },
] as const;

export function diagnoseDeploymentFailure(
  status: string,
  recentLog: string,
  exitCode?: number | null,
) {
  if (status === 'NEEDS_ATTENTION')
    return [
      {
        code: 'STATE_UNCERTAIN',
        suggestion: '先核对实际发布状态、进程和发布锁，等待人工确认后再决定是否重试。',
      },
    ];
  if (!isTerminalStatus(status) || status === 'SUCCESS' || status === 'CANCELLED') return [];
  const findings: { code: string; suggestion: string }[] = logFindings
    .filter(({ match }) => match.test(recentLog))
    .map(({ code, suggestion }) => ({ code, suggestion }));
  if (status === 'TIMED_OUT')
    findings.push({
      code: 'TIMEOUT',
      suggestion: '检查网络和包管理器事务，核对进程已停止后再安排重试。',
    });
  if (exitCode === 127 && !findings.some(({ code }) => code === 'MISSING_TOOL'))
    findings.push({
      code: 'MISSING_TOOL',
      suggestion: '退出码为 127，请核对构建和部署所需工具是否可用。',
    });
  return findings;
}

@Injectable()
export class AiDeploymentToolsService {
  constructor(
    private readonly ssh: SshService,
    private readonly targets: TargetResolver,
    private readonly plans: OperationPlansService,
    private readonly tasks: TasksService,
  ) {}

  async inspect(targets: SshTarget[]): Promise<
    {
      serverId: string;
      name: string;
      status: 'OK' | 'UNAVAILABLE';
      facts: Record<string, string>;
    }[]
  > {
    return Promise.all(
      targets.map(async (target) => {
        let output = '';
        try {
          const result = await this.ssh.execute(target, deploymentProbe, {
            timeout: 12,
            onData: (text, stream) => {
              if (stream === 'stdout' && output.length < 8192)
                output += text.slice(0, 8192 - output.length);
            },
          });
          if (result.exitCode !== 0) throw new Error('无法采集服务器运行环境');
          return {
            serverId: target.id,
            name: target.name,
            status: 'OK' as const,
            facts: parseDeploymentProbe(output),
          };
        } catch {
          return {
            serverId: target.id,
            name: target.name,
            status: 'UNAVAILABLE' as const,
            facts: {},
          };
        }
      }),
    );
  }

  async initialization(component: unknown, serverIds: string[]) {
    if (typeof component !== 'string' || !Object.hasOwn(initializationPlans, component))
      throw new BadRequestException(
        '只能选择内置 Docker、Docker Compose v2、Node.js 或 Nginx 初始化方案',
      );
    const planId = initializationPlans[component as InitializationComponent];
    const template = planTemplates.find(({ id }) => id === planId)!;
    const version = (await this.plans.versions(planId)).find((plan) => plan.version === 1);
    if (
      !version ||
      version.parameters.length ||
      !isDeepStrictEqual(version.steps, template.steps) ||
      !isDeepStrictEqual(version.preChecks, template.preChecks ?? []) ||
      !isDeepStrictEqual(version.postChecks, template.postChecks ?? [])
    )
      throw new ConflictException('内置初始化方案与审核过的版本不一致');
    const preview = await this.targets.preview({ serverIds });
    return {
      planId,
      version: version.version,
      planVersionId: version.id,
      targetHash: preview.targetHash,
      summary: template.description,
      steps: [...version.preChecks, ...version.steps, ...version.postChecks].map(
        ({ name, command, timeout }) => ({ name, command, timeout }),
      ),
    };
  }

  async initialize(
    component: InitializationComponent,
    expectedHash: string,
    serverIds: string[],
    userId: string,
    repair?: AiRepairOrigin,
  ) {
    const plan = await this.initialization(component, serverIds);
    if (plan.targetHash !== expectedHash)
      throw new ConflictException('服务器绑定已变化，请重新巡检');
    const targets = await this.targets.resolve({ serverIds });
    const reports = await this.inspect(targets);
    for (const report of reports) {
      const facts = report.facts;
      if (
        report.status !== 'OK' ||
        (repair && facts.probeComplete !== '1') ||
        facts.uid !== '0' ||
        !['debian', 'ubuntu'].includes(facts.os ?? '') ||
        facts['apt-get'] !== 'available' ||
        ((component === 'docker' || component === 'nginx') &&
          (facts.init !== 'systemd' || facts.systemctl !== 'available'))
      )
        throw new BadRequestException(`目标 ${report.name} 未通过初始化前的系统检查`);
      if (facts.packageActivity === 'busy')
        throw new ConflictException(`目标 ${report.name} 有进行中的包管理事务，请稍后重新巡检`);
      if (component === 'compose' && facts.docker !== 'available')
        throw new BadRequestException(`目标 ${report.name} 需要先初始化 Docker`);
      if (
        (component === 'docker' && facts.dockerDaemon === 'available') ||
        (component === 'compose' && facts.compose === 'available') ||
        (component === 'node' && facts.node === 'available' && facts.npm === 'available') ||
        (component === 'nginx' && facts.nginxActive === 'available')
      )
        throw new ConflictException(
          `目标 ${report.name} 已具备所选组件，请重新选择需要初始化的目标`,
        );
    }
    return this.plans.run(
      plan.planId,
      {
        serverIds,
        expectedTargetHash: expectedHash,
        version: plan.version,
        confirmed: true,
        strategy: 'PARALLEL',
        maxParallel: 2,
        failurePolicy: 'CONTINUE',
        timeout: 900,
      },
      userId,
      repair,
    );
  }

  async diagnose(taskId: string, status: string) {
    const steps = await this.tasks.steps(taskId);
    const latest = await this.tasks.recentLog(taskId);
    const exitCode = steps.find(({ exitCode }) => exitCode !== null && exitCode !== 0)?.exitCode;
    return {
      taskId,
      status,
      findings: diagnoseDeploymentFailure(status, latest, exitCode),
      failedSteps: steps
        .filter(({ status: stepStatus }) =>
          ['FAILED', 'TIMED_OUT', 'NEEDS_ATTENTION'].includes(stepStatus),
        )
        .slice(0, 20)
        .map(({ serverId, key, status: stepStatus, exitCode }) => ({
          serverId,
          key,
          status: stepStatus,
          exitCode,
        })),
    };
  }
}
