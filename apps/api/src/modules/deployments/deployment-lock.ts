import { createHash, randomUUID } from 'node:crypto';
import type { PipelineSnapshot } from '../pipelines/pipeline.types';
import { shellQuote as quote } from '../pipelines/pipeline.validation';
import { normalizeReleasePath } from './deployment-scope';

const lockDirectory = '/var/tmp/.veyops-deployment-locks';
const parentGuard = `test ! -L /var/tmp && test -d /var/tmp && test "$(stat -c '%u:%a' -- /var/tmp)" = 0:1777`;
const namespaceGuard = `${parentGuard} || exit 76
test ! -L ${lockDirectory} && test -d ${lockDirectory} && test "$(stat -c '%u:%a' -- ${lockDirectory})" = "$(id -u):700" || exit 76`;

export function deploymentLock(snapshot: PipelineSnapshot) {
  const root = normalizeReleasePath(snapshot.definition.deployPath);
  // Retain legacy scope locking so a graph release and an earlier release cannot race.
  const scope = [snapshot.projectId, snapshot.serviceId, snapshot.environmentId].join(':');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const locks = [`scope-${hash(scope)}`, `path-${hash(root)}`].map((name) =>
    quote(`${lockDirectory}/${name}`),
  );
  const token = quote(`${snapshot.runId}:${randomUUID()}`);
  const release = (path: string) =>
    `if test ! -L ${path} && test -d ${path} && test "$(stat -c '%u:%a' -- ${path})" = "$(id -u):700" && test ! -L ${path}/owner && test -f ${path}/owner && test "$(cat -- ${path}/owner)" = ${token}; then rm -- ${path}/owner && rmdir -- ${path}; else exit 75; fi`;
  const acquire = (path: string) => `mkdir -m 700 -- ${path} || exit 75
printf '%s' ${token} > ${path}/owner`;
  const rootParts = root.split('/');
  const managedParentChecks = snapshot.graphDeployment
    ? rootParts.slice(2).map((_, index) => {
        const marker = quote(rootParts.slice(0, index + 2).join('/') + '/.veyops-managed');
        return `test ! -e ${marker} && test ! -L ${marker} || exit 76`;
      })
    : [];
  return {
    paths: locks.map((path) => path.slice(1, -1)),
    acquire: `set -eu
umask 077
if ${parentGuard}; then mkdir -m 700 -- ${lockDirectory} 2>/dev/null || :; fi
${namespaceGuard}
# Reject alias paths before acquiring the path lock.
test "$(realpath -m -- ${quote(root)})" = ${quote(root)} || exit 76
${managedParentChecks.join('\n')}
${acquire(locks[0]!)}
if ! mkdir -m 700 -- ${locks[1]!}; then
  ${release(locks[0]!)}
  exit 75
fi
printf '%s' ${token} > ${locks[1]!}/owner`,
    release: `set -eu
${namespaceGuard}
${release(locks[1]!)}
${release(locks[0]!)}`,
    location: locks.map((path) => path.slice(1, -1)).join('、'),
  };
}
