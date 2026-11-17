import { setTimeout as delay } from 'node:timers/promises';
import { SshExecutionError } from '../../infrastructure/ssh/ssh.service';
import { BuildCommandError } from '../builds/builds.service';
import { shellQuote as quote } from './pipeline.validation';

export function httpHealthCheck(url: string, timeoutSeconds: number) {
  return `set -eu
status=$(curl --disable --fail --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time ${timeoutSeconds} --proto '=http,https' -- ${quote(url)})
case "$status" in 2[0-9][0-9]) ;; *) echo "非成功 HTTP 状态：$status" >&2; exit 1 ;; esac`;
}

export function composeHealthCheck(compose: string, docker: string) {
  return `set -eu
containers=$(${compose} ps --all --orphans=false --quiet)
running=
for container in $containers; do
  result=$(${docker} container inspect --format '{{.State.Status}}:{{.State.ExitCode}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{index .Config.Labels "com.docker.compose.oneoff"}}' "$container")
  case "$result" in
    *' True'|*' true') continue ;;
    'running:0 healthy '*|'running:0 none '*) running=yes ;;
    'exited:0 none '*) : ;;
    *) echo 'Compose 容器尚未就绪或健康检查失败' >&2; exit 1 ;;
  esac
done
test -n "$running" || { echo '没有找到运行中的 Compose 服务容器' >&2; exit 1; }`;
}

export async function waitForReleaseHealth(
  checks: (() => Promise<unknown>)[],
  policy: { attempts: number; intervalSeconds: number } | undefined,
  signal: AbortSignal,
  log: (message: string) => void,
) {
  const attempts = policy?.attempts ?? 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal.aborted) throw new SshExecutionError('健康检查已取消', 'CANCELLED');
    try {
      for (const check of checks) await check();
      return;
    } catch (error) {
      if (!(error instanceof BuildCommandError) || attempt === attempts) throw error;
      log(`健康检查第 ${attempt}/${attempts} 次未通过，等待下一次检查\n`);
      await delay((policy?.intervalSeconds ?? 0) * 1000, undefined, { signal }).catch((error) => {
        if (signal.aborted) throw new SshExecutionError('健康检查已取消', 'CANCELLED');
        throw error;
      });
    }
  }
}
