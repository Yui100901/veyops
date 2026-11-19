// Sections are read in one SSH session. No host settings or user input enter this script.
export const linuxMonitorCommand = `set -e
export LC_ALL=C
test "$(uname -s)" = Linux
echo @boot
cat /proc/sys/kernel/random/boot_id
echo @uptime
cat /proc/uptime
echo @cpu
head -n 1 /proc/stat
echo @load
cat /proc/loadavg
echo @memory
cat /proc/meminfo
echo @disk
df -Pk
echo @net
cat /proc/net/dev
echo @index
for iface in /sys/class/net/*; do
  idx=$(cat "$iface/ifindex" 2>/dev/null) || continue
  printf '%s %s\\n' "$(basename "$iface")" "$idx"
done`;

function integer(text?: string) {
  if (!text || !/^\d{1,24}$/.test(text)) throw new Error('Invalid Linux counter');
  return BigInt(text);
}

function kibibytes(text?: string) {
  const bytes = Number(integer(text) * 1024n);
  if (!Number.isSafeInteger(bytes)) throw new Error('Invalid Linux capacity');
  return bytes;
}

export function parseLinuxSample(output: string) {
  const sections = new Map<string, string[]>();
  let section: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (/^@(boot|uptime|cpu|load|memory|disk|net|index)$/.test(line)) {
      section = [];
      sections.set(line, section);
    } else if (line.trim()) section.push(line.trim());
  }
  const lines = (key: string) => sections.get('@' + key) ?? [];
  const boot = lines('boot')[0] || '';
  const uptime = Number(lines('uptime')[0]?.split(/\s+/)[0]);
  const cpu = lines('cpu')[0]?.split(/\s+/) || [];
  const load = (lines('load')[0] || '').split(/\s+/).slice(0, 3).map(Number);
  if (
    !/^[a-f0-9-]{36}$/i.test(boot) ||
    !Number.isFinite(uptime) ||
    uptime < 0 ||
    cpu[0] !== 'cpu' ||
    cpu.length < 5 ||
    load.length !== 3 ||
    !load.every((n) => Number.isFinite(n) && n >= 0)
  )
    throw new Error('Incomplete Linux sample');
  const counters = cpu.slice(1, 9).map((value) => integer(value).toString());
  const values = new Map(
    lines('memory').map((line) => {
      const match = /^(\w+):\s+(\d+) kB$/.exec(line);
      return match ? ([match[1], match[2]] as const) : (['', ''] as const);
    }),
  );
  const totalBytes = kibibytes(values.get('MemTotal'));
  const availableBytes = kibibytes(values.get('MemAvailable'));
  const memory = {
    totalBytes,
    availableBytes,
    usedBytes: totalBytes - availableBytes,
    swapTotalBytes: kibibytes(values.get('SwapTotal')),
    swapFreeBytes: kibibytes(values.get('SwapFree')),
  };
  const disks = lines('disk').flatMap((line) => {
    const match = /^.+?\s+(\d+)\s+\d+\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line);
    return match
      ? [
          {
            mount: match[4]!,
            totalBytes: kibibytes(match[1]),
            availableBytes: kibibytes(match[2]),
            usedPercent: Number(match[3]),
          },
        ]
      : [];
  });
  const indices = new Map(
    lines('index')
      .map((line) => line.split(/\s+/))
      .map(([name, index]) => [name, index]),
  );
  const net = lines('net').flatMap((line) => {
    const match = /^([^:]+):\s*(.+)$/.exec(line);
    if (!match) return [];
    const name = match[1]!.trim(),
      fields = match[2]!.split(/\s+/);
    return [
      {
        name,
        index: indices.get(name) ?? null,
        rxBytes: integer(fields[0]).toString(),
        txBytes: integer(fields[8]).toString(),
      },
    ];
  });
  if (availableBytes > totalBytes || !disks.some((disk) => disk.mount === '/') || !net.length)
    throw new Error('Incomplete Linux sample');
  return { boot, uptime, counters, load, memory, disks, net };
}
export type LinuxSample = ReturnType<typeof parseLinuxSample>;
export type LinuxCounters = Pick<LinuxSample, 'boot' | 'uptime' | 'counters' | 'net'>;

export function linuxMetrics(
  current: LinuxSample,
  previous: LinuxCounters | null,
  intervalSeconds: number,
) {
  const elapsed = previous ? current.uptime - previous.uptime : 0;
  if (!previous || previous.boot !== current.boot || elapsed <= 0 || elapsed > 3 * intervalSeconds)
    previous = null;
  let cpuPercent: number | null = null;
  if (previous && current.counters.length === previous.counters.length) {
    const counters = previous.counters;
    const diff = current.counters.map((value, i) => BigInt(value) - BigInt(counters[i]!));
    const total = diff.reduce((a, b) => a + b, 0n);
    if (total > 0n && diff.every((n) => n >= 0n))
      cpuPercent = Number(((total - diff[3]! - (diff[4] ?? 0n)) * 10000n) / total) / 100;
  }
  const network = current.net.map(({ name, index, rxBytes, txBytes }) => {
    const old = previous?.net.find(
      (entry) => entry.name === name && entry.index === index && index !== null,
    );
    const rx = old && BigInt(rxBytes) - BigInt(old.rxBytes),
      tx = old && BigInt(txBytes) - BigInt(old.txBytes);
    const comparable = rx !== undefined && tx !== undefined && rx >= 0n && tx >= 0n;
    return {
      name,
      rxBytes,
      txBytes,
      rxBytesPerSecond: comparable ? Number(rx) / elapsed : null,
      txBytesPerSecond: comparable ? Number(tx) / elapsed : null,
    };
  });
  return { cpuPercent, load: current.load, memory: current.memory, disks: current.disks, network };
}
export type MonitorMetrics = ReturnType<typeof linuxMetrics>;
