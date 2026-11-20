import { cp, lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { dataDirectory } from '../../core/config';
import type { GraphCheckoutSnapshot } from '../projects/repository-metadata.service';
import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';

const workspaceId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const root = () => resolve(dataDirectory, 'graph-workspaces');
export const unversionedArtifactCommit = '0'.repeat(40);
export const unversionedArtifactRepository = '00000000-0000-4000-8000-000000000000';

export interface GraphWorkspaceRef {
  runId: string;
  nodeRunId: string;
  repositoryId?: string;
  commitSha?: string;
  branch?: string;
  tag?: string;
}

export interface GraphEnvironmentRef {
  workspace?: GraphWorkspaceRef;
  envFile?: string;
  environmentId?: string;
}

export interface GraphExecutionScope {
  runId: string;
  nodeRunId: string;
  workspace?: GraphWorkspaceRef;
  variables?: GraphEnvironmentRef;
  trigger?: Record<string, unknown>;
}

export function workspaceReference(
  runId: string,
  nodeRunId: string,
  source?: GraphCheckoutSnapshot,
): GraphWorkspaceRef {
  graphWorkspacePath({ runId, nodeRunId });
  const { repositoryId, commitSha, branch, tag } = source ?? {};
  return { runId, nodeRunId, repositoryId, commitSha, branch, tag };
}

function graphWorkspacePath(reference: GraphWorkspaceRef) {
  if (!workspaceId.test(reference.runId) || !workspaceId.test(reference.nodeRunId))
    throw new Error('工作区引用无效');
  return join(root(), reference.runId, reference.nodeRunId);
}

export async function createGraphWorkspace(
  reference: GraphWorkspaceRef,
  populate?: (repository: string) => Promise<unknown>,
) {
  const directory = graphWorkspacePath(reference);
  const next = await mkdtemp(await workspaceTemporaryPrefix(reference.runId));
  try {
    const repository = join(next, 'repo');
    if (populate) await populate(repository);
    else await mkdir(repository, { mode: 0o700 });
    await rename(next, directory);
  } finally {
    await rm(next, { force: true, recursive: true });
  }
  return directory;
}

async function workspaceTemporaryPrefix(runId: string) {
  const run = join(root(), runId);
  await mkdir(run, { recursive: true, mode: 0o700 });
  if ((await lstat(run)).isSymbolicLink() || (await realpath(run)) !== run)
    throw new Error('工作区目录无效');
  return join(run, 'tmp-');
}

export async function openGraphWorkspace(reference: GraphWorkspaceRef) {
  const directory = graphWorkspacePath(reference);
  const repository = join(directory, 'repo');
  if (
    (await realpath(repository).catch(() => undefined)) !== repository ||
    !(await lstat(repository)).isDirectory()
  )
    throw new Error('已绑定的工作区不存在或路径无效');
  return directory;
}

export async function ownedGraphWorkspace(
  db: Kysely<Database>,
  projectId: string,
  reference: GraphWorkspaceRef,
) {
  const row = await db
    .selectFrom('execution_node_runs')
    .innerJoin('execution_flow_runs', 'execution_flow_runs.id', 'execution_node_runs.run_id')
    .select('execution_node_runs.output_json')
    .where('execution_node_runs.id', '=', reference.nodeRunId)
    .where('execution_flow_runs.id', '=', reference.runId)
    .where('execution_flow_runs.project_id', '=', projectId)
    .where('execution_node_runs.status', '=', 'SUCCESS')
    .executeTakeFirst();
  const saved = row?.output_json
    ? (JSON.parse(row.output_json) as { workspace?: GraphWorkspaceRef }).workspace
    : undefined;
  if (
    !saved ||
    saved.runId !== reference.runId ||
    saved.nodeRunId !== reference.nodeRunId ||
    saved.repositoryId !== reference.repositoryId ||
    saved.commitSha !== reference.commitSha
  )
    throw new Error('工作区必须由当前项目的成功节点提供');
  return saved;
}

export function copyGraphRepository(reference: GraphWorkspaceRef, destination: string) {
  return openGraphWorkspace(reference).then((directory) =>
    cp(join(directory, 'repo'), destination, {
      recursive: true,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    }),
  );
}

export async function graphWorkspaceEntry(workspace: GraphWorkspaceRef, path: string) {
  const root = join(await openGraphWorkspace(workspace), 'repo');
  const file = await realpath(resolve(root, path));
  const subpath = relative(root, file);
  if (!subpath || subpath === '..' || subpath.startsWith('..' + sep) || isAbsolute(subpath))
    throw new Error('文件必须位于已绑定工作区内');
  return file;
}

export function graphTriggerVariables(trigger?: Record<string, unknown>) {
  const entries: [string, unknown][] = [
    ['VEYOPS_TRIGGERED_AT', trigger?.triggeredAt],
    ['VEYOPS_TRIGGER_COMMIT_SHA', trigger?.commitSha],
    ['VEYOPS_TRIGGER_REF', trigger?.ref],
    ['VEYOPS_TRIGGER_EVENT_ID', trigger?.eventId],
  ];
  return Object.fromEntries(
    entries.flatMap(([key, value]) =>
      (typeof value === 'string' && value.length <= 500 && !value.includes('\0')) ||
      typeof value === 'number'
        ? [[key, String(value)]]
        : [],
    ),
  );
}
