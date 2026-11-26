import { createHmac } from 'node:crypto';
import { join, posix } from 'node:path';
import { dataDirectory, encryptionKey } from '../../core/config';
import type { SshTarget } from '../../infrastructure/ssh/ssh.service';

export type FlowWorkspacePlacement =
  | { location: 'MANAGER'; projectSlug: string }
  | { location: 'TARGET'; projectSlug: string; target: SshTarget; root: string };

export type FlowWorkspace = {
  runId: string;
  path: string;
  placement: FlowWorkspacePlacement;
};

export const runControlsDirectory = '.runs';
export const managerWorkspaceDirectory = 'flow-workspaces';
export const managerWorkspaceRoot = join(dataDirectory, managerWorkspaceDirectory);
export const workspaceOwnerFile = 'owner';
export const workspaceIdentityFile = 'identity';
export const workspaceLockFile = 'lock';

export function validWorkspaceNames(runId: string, projectSlug: string) {
  return (
    typeof runId === 'string' &&
    typeof projectSlug === 'string' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(runId) &&
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(projectSlug)
  );
}

export function workspaceOwner(
  runId: string,
  projectSlug: string,
  target?: { id: string; root: string },
) {
  return createHmac('sha256', encryptionKey())
    .update(
      JSON.stringify([
        'project-execution-workspace',
        runId,
        projectSlug,
        target ? [target.id, target.root] : null,
      ]),
    )
    .digest('hex');
}

export function remoteWorkspaceControl(path: string, runId: string) {
  return posix.join(posix.dirname(path), runControlsDirectory, runId);
}

export function localWorkspaceControl(path: string, runId: string) {
  return join(path, '..', runControlsDirectory, runId);
}
