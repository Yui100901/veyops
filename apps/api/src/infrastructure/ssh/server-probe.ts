const probeMarkers = {
  os: 'VEYOPS_OS=',
  load: 'VEYOPS_LOAD=',
  memory: 'VEYOPS_MEM=',
  disk: 'VEYOPS_DISK=',
};

export const serverProbeCommand = `uname -srm
if test -r /etc/os-release; then sed -n 's/^PRETTY_NAME=/${probeMarkers.os}/p' /etc/os-release | head -n 1; fi
if test -r /proc/loadavg; then awk '{printf "${probeMarkers.load}%s %s %s\\n",$1,$2,$3}' /proc/loadavg; fi
if test -r /proc/meminfo; then awk '/^MemTotal:/ {total=$2} /^MemAvailable:/ {available=$2} END {if (total && available != "") printf "${probeMarkers.memory}%s %s\\n",total,available}' /proc/meminfo; fi
LC_ALL=C df -Pk / 2>/dev/null | awk 'NR==2 {printf "${probeMarkers.disk}%s %s\\n",$2,$4}'
uptime 2>/dev/null || true`;

export function summarizeProbe(output: string) {
  const lines = output.split(/\r?\n/);
  const marker = (prefix: string) =>
    lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
  const rawOs = marker(probeMarkers.os)?.replace(/^"|"$/g, '') || lines[0];
  const osType = rawOs?.trim().slice(0, 160) || null;
  const load = marker(probeMarkers.load);
  const memory = marker(probeMarkers.memory);
  const disk = marker(probeMarkers.disk);
  if (
    !load ||
    !/^\d+(?:\.\d+)? \d+(?:\.\d+)? \d+(?:\.\d+)?$/.test(load) ||
    !memory ||
    !/^\d+ \d+$/.test(memory) ||
    !disk ||
    !/^\d+ \d+$/.test(disk)
  )
    return { osType };
  const [memoryTotalKb, memoryAvailableKb] = memory.split(' ').map(Number);
  const [diskTotalKb, diskAvailableKb] = disk.split(' ').map(Number);
  if (![memoryTotalKb, memoryAvailableKb, diskTotalKb, diskAvailableKb].every(Number.isSafeInteger))
    return { osType };
  return {
    osType,
    metrics: { loadAverage: load, memoryTotalKb, memoryAvailableKb, diskTotalKb, diskAvailableKb },
  };
}
