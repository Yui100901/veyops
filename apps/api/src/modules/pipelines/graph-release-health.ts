export const unhealthyGraphProbeExitCode = 10;

export interface GraphProbeResult {
  health: 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN';
  probeExitCode: number | null;
  healthReason?: string;
}

export function unknownGraphHealth(
  healthReason: string,
  probeExitCode: number | null = null,
): GraphProbeResult {
  return { health: 'UNKNOWN', probeExitCode, healthReason };
}

export function graphProbeResult(check: { exitCode: number; signal?: string }): GraphProbeResult {
  if (check.signal || !Number.isInteger(check.exitCode))
    return unknownGraphHealth('健康探针未正常退出');
  switch (check.exitCode) {
    case 0:
      return { health: 'HEALTHY', probeExitCode: 0 };
    case unhealthyGraphProbeExitCode:
      return { health: 'UNHEALTHY', probeExitCode: unhealthyGraphProbeExitCode };
    case 90:
      return unknownGraphHealth('无法进入已确认的发布目录');
    case 126:
      return unknownGraphHealth('探针命令无法执行', check.exitCode);
    case 127:
      return unknownGraphHealth('缺少探针所需命令', check.exitCode);
    default:
      return unknownGraphHealth('探针退出码未明确报告应用健康状态', check.exitCode);
  }
}
