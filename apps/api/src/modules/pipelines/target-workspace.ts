import { validateWorkspaceRoot } from '../system/system-settings.service';
import { shellQuote } from './pipeline.validation';

export function createTargetWorkspace(root: string, name: string) {
  validateWorkspaceRoot(root);
  if (!/^veyops-[a-zA-Z0-9_-]+$/.test(name)) throw new Error('任务工作目录名称无效');
  const path = root.startsWith('~/')
    ? '"${HOME:?}"' + '/' + shellQuote(root.slice(2))
    : shellQuote(root);
  return [
    'set -eu',
    'umask 077',
    `root=${path}`,
    'mkdir -p -- "$root"',
    'cd -P -- "$root"',
    'base=$(pwd -P)',
    'test "$base" != /',
    `mkdir -- ${shellQuote(name)}`,
    `printf 'VEYOPS_WORKSPACE=%s/%s\\n' "$base" ${shellQuote(name)}`,
  ].join('\n');
}

export function targetWorkspacePath(stdout: string, name: string) {
  const marker = 'VEYOPS_WORKSPACE=';
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(marker));
  const path = lines.length === 1 ? lines[0]!.slice(marker.length) : '';
  if (!path.startsWith('/') || !path.endsWith('/' + name))
    throw new Error('目标服务器未返回有效的任务工作目录');
  // The resolved SSH home and the per-task directory are additional to the configured root.
  return validateWorkspaceRoot(path, 4096);
}
