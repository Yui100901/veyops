import { cp, lstat, readFile, realpath } from 'node:fs/promises';
import { basename, join, posix, relative, sep } from 'node:path';
import type { SshTarget } from '../../infrastructure/ssh/ssh.service';
import {
  localWorkspaceControl,
  managerWorkspaceRoot,
  remoteWorkspaceControl,
  validWorkspaceNames,
  workspaceIdentityFile,
  workspaceLockFile,
  workspaceOwner,
  workspaceOwnerFile,
} from '../execution-graphs/flow-workspace-paths';
import { normalizeRelativePath, shellQuote as q } from '../pipelines/pipeline.validation';
import { validateWorkspaceRoot } from '../system/system-settings.service';
import { artifactPathDigest, InvalidArtifactObject } from './artifact-physical-paths';

export type WorkspaceArtifactLocation = {
  runId: string;
  projectSlug: string;
  targetRoot?: string;
  excludePaths?: string[];
};

export function workspaceArtifactOwner(location: WorkspaceArtifactLocation, target?: SshTarget) {
  if (
    !validWorkspaceNames(location.runId, location.projectSlug) ||
    Boolean(target) !== Boolean(location.targetRoot)
  )
    throw new InvalidArtifactObject();
  return workspaceOwner(
    location.runId,
    location.projectSlug,
    target ? { id: target.id, root: validateWorkspaceRoot(location.targetRoot!) } : undefined,
  );
}

function excludedPaths(location: WorkspaceArtifactLocation) {
  return (location.excludePaths ?? []).map(normalizeRelativePath);
}

function exportableEntry(path: string, name: string, excluded: readonly string[]) {
  return (
    !['.git', '.veyops', '.env'].includes(name) &&
    !name.startsWith('.env.') &&
    !excluded.includes(path)
  );
}

export function checkWorkspaceSelection(path: string, workspace: WorkspaceArtifactLocation) {
  if (path === '.') return;
  const excluded = excludedPaths(workspace);
  let relative = '';
  for (const name of path.split('/')) {
    relative = relative ? relative + '/' + name : name;
    if (!exportableEntry(relative, name, excluded)) throw new InvalidArtifactObject();
  }
}

export async function checkLocalWorkspaceArtifact(
  path: string,
  location: WorkspaceArtifactLocation,
  owner: string,
) {
  if (owner !== workspaceArtifactOwner(location)) throw new InvalidArtifactObject();
  const root = await realpath(managerWorkspaceRoot);
  const workspace = join(root, location.projectSlug, location.runId);
  if (path !== workspace || (await realpath(path)) !== path) throw new InvalidArtifactObject();
  const control = localWorkspaceControl(path, location.runId);
  if ((await realpath(control)) !== control) throw new InvalidArtifactObject();
  const marker = join(control, workspaceOwnerFile);
  const identity = join(control, workspaceIdentityFile);
  const details = await lstat(path, { bigint: true });
  if (
    !details.isDirectory() ||
    !(await lstat(marker)).isFile() ||
    !(await lstat(identity)).isFile() ||
    (await readFile(marker, 'utf8')).trimEnd() !== owner ||
    (await readFile(identity, 'utf8')).trimEnd() !== `${details.dev}:${details.ino}`
  )
    throw new InvalidArtifactObject();
  return control;
}

export function checkRemoteWorkspaceArtifact(
  path: string,
  location: WorkspaceArtifactLocation,
  owner: string,
  target: SshTarget,
) {
  if (owner !== workspaceArtifactOwner(location, target)) throw new InvalidArtifactObject();
  const root = location.targetRoot!;
  const suffix = '/' + location.projectSlug + '/' + location.runId;
  if (root.startsWith('~/') ? !path.endsWith('/' + root.slice(2) + suffix) : path !== root + suffix)
    throw new InvalidArtifactObject();
  return [
    'workspace=' + q(path),
    'control=' + q(remoteWorkspaceControl(path, location.runId)),
    'root=' + q(posix.dirname(path)),
    `[[ ! -L "$workspace" && ! -L "$control" && ! -L "$control/${workspaceOwnerFile}" && ! -L "$control/${workspaceIdentityFile}" && ! -L "$control/${workspaceLockFile}" ]] || exit 45`,
    '[[ -e "$workspace" ]] || exit 44',
    '[[ -d "$workspace" && "$(realpath -e -- "$workspace")" == "$workspace" ]] || exit 45',
    '[[ -d "$control" && "$(realpath -e -- "$control")" == "$control" ]] || exit 45',
    `[[ -f "$control/${workspaceLockFile}" && -f "$control/${workspaceOwnerFile}" && -f "$control/${workspaceIdentityFile}" ]] || exit 45`,
    `exec 9<"$control/${workspaceLockFile}"`,
    'flock -x 9',
    `[[ "$(cat -- "$control/${workspaceOwnerFile}")" == ${q(owner)} && "$(cat -- "$control/${workspaceIdentityFile}")" == "$(stat -c '%d:%i' -- "$workspace")" ]] || exit 45`,
    'excludes=(' +
      excludedPaths(location)
        .map((path) => q('./' + path.replace(/[\\*?\[\]]/g, '\\$&')))
        .join(' ') +
      ')',
    linuxExportableWorkspace,
  ].join('\n');
}

export async function workspaceArtifactDigest(
  workspace: string,
  location: WorkspaceArtifactLocation,
  signal?: AbortSignal,
) {
  const excluded = excludedPaths(location);
  return artifactPathDigest(workspace, 'DIRECTORY', signal, (path, name) =>
    exportableEntry(path, name, excluded),
  );
}

export async function copyWorkspaceExport(
  workspace: string,
  destination: string,
  location: WorkspaceArtifactLocation,
  signal?: AbortSignal,
) {
  const excluded = excludedPaths(location);
  await cp(workspace, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    async filter(path) {
      signal?.throwIfAborted();
      if (path === workspace) return true;
      if (
        !exportableEntry(relative(workspace, path).split(sep).join('/'), basename(path), excluded)
      )
        return false;
      const details = await lstat(path);
      return details.isDirectory() || details.isFile();
    },
  });
}

const linuxExportableWorkspace = String.raw`
workspace_entries() {
  local -a selector=( -name .git -o -name .veyops -o -name .env -o -name '.env.*' )
  local exclusion
  for exclusion in "${'${excludes[@]}'}"; do selector+=( -o -path "$exclusion" ); done
  find . -mindepth 1 \( "${'${selector[@]}'}" \) -prune -o \( -type f -o -type d \) "$@"
}
workspace_manifest() (
  cd -- "$workspace"
  local name digest bytes
  printf 'veyops-directory-v1\0'
  workspace_entries -print0 | sort -z | while IFS= read -r -d '' name; do
    if [[ -L "$name" ]]; then exit 45; fi
    if [[ -d "$name" ]]; then
      printf 'D\0%s\0' "$name"
    elif [[ -f "$name" ]]; then
      digest=$(checksum "$name") || exit 1
      bytes=$(stat -c '%s' -- "$name") || exit 1
      printf 'F\0%s\0%s\0%s\0' "$name" "$digest" "$bytes"
    else
      exit 45
    fi
  done
)
workspace_digest() (
  local digest bytes
  cd -- "$workspace"
  digest=$(workspace_manifest | sha256sum | cut -d' ' -f1) || exit $?
  bytes=$(workspace_entries -type f -printf '%s\n' | awk '{n += $1} END {printf "%.0f", n}') || exit $?
  printf '%s:%s' "$digest" "$bytes"
)
workspace_copy() (
  cd -- "$workspace"
  workspace_entries -print0 | tar --null --no-recursion --hard-dereference -T - -cf - | tar --no-same-owner -xf - -C "$1"
)
`;
