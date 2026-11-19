import type { SshService, SshTarget } from '../../infrastructure/ssh/ssh.service';

const fields = {
  distribution: 'Linux 发行版',
  kernel: '内核版本',
  architecture: '处理器架构',
  processors: '在线逻辑 CPU 数',
  memory: '物理内存总量（KiB）',
  swap: '交换空间总量（KiB）',
  cgroup: 'cgroup 文件系统',
  docker: 'Docker CLI 版本',
  compose: 'Docker Compose 版本',
};

// All commands are fixed. Read the OS label as data, without sourcing shell code.
export const configurationProbe = `set -eu
export LC_ALL=C
test "$(uname -s)" = Linux
printf 'kernel=%s\\n' "$(uname -r)"
printf 'architecture=%s\\n' "$(uname -m)"
sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -n1 | sed 's/^"//;s/"$//;s/^/distribution=/'
getconf _NPROCESSORS_ONLN 2>/dev/null | sed 's/^/processors=/'
awk '/^MemTotal:/ {print "memory=" $2} /^SwapTotal:/ {print "swap=" $2}' /proc/meminfo
stat -f -c %T /sys/fs/cgroup 2>/dev/null | sed 's/^/cgroup=/'
if command -v docker >/dev/null 2>&1; then
  docker --version 2>/dev/null | head -n1 | sed 's/^/docker=/'
  docker compose version --short 2>/dev/null | head -n1 | sed 's/^/compose=/'
else
  printf 'docker=CLI unavailable\\ncompose=CLI unavailable\\n'
fi`;

type Facts = Partial<Record<keyof typeof fields, string>>;

async function collect(ssh: SshService, target: SshTarget) {
  let stdout = '';
  const facts: Facts = {};
  try {
    const result = await ssh.execute(target, configurationProbe, {
      timeout: 15,
      onData(text, stream) {
        if (stream === 'stdout') {
          if (stdout.length + text.length > 8192) throw new Error('配置输出超过限制');
          stdout += text;
        }
      },
    });
    if (result.exitCode !== 0) throw new Error('读取 Linux 配置失败');
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^([a-z]+)=([^\p{C}]{1,200})$/u.exec(line);
      if (match && Object.hasOwn(fields, match[1]!)) facts[match[1] as keyof Facts] = match[2];
    }
    if (!facts.kernel || !facts.architecture) throw new Error('Linux 配置信息不完整');
    return {
      host: { id: target.id, name: target.name, status: 'OK' as const, collectedAt: Date.now() },
      facts,
    };
  } catch {
    return {
      host: { id: target.id, name: target.name, status: 'UNAVAILABLE' as const, collectedAt: null },
      facts: {} as Facts,
    };
  }
}

export async function compareServerConfigurations(
  ssh: SshService,
  baselineTarget: SshTarget,
  comparisonTarget: SshTarget,
) {
  const [left, right] = await Promise.all([
    collect(ssh, baselineTarget),
    collect(ssh, comparisonTarget),
  ]);
  const rows = (Object.keys(fields) as (keyof Facts)[]).map((key) => {
    const baseline = left.facts[key] ?? null;
    const comparison = right.facts[key] ?? null;
    const status =
      baseline === null || comparison === null
        ? 'UNKNOWN'
        : baseline === comparison
          ? 'EQUAL'
          : 'DIFFERENT';
    return { key, label: fields[key], baseline, comparison, status };
  });
  return { baseline: left.host, comparison: right.host, rows };
}
