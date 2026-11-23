import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Kysely } from 'kysely';
import { posix } from 'node:path';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { SshService, type SshTarget } from '../../infrastructure/ssh/ssh.service';
import { AuditService } from '../audit/audit.service';
import type { CurrentUser } from '../auth/auth.decorators';
import { deploymentLock } from '../deployments/deployment-lock';
import { normalizeReleasePath as snapshotPath } from '../deployments/deployment-scope';
import { DeploymentsService } from '../deployments/deployments.service';
import type { PipelineSnapshot } from '../pipelines/pipeline.types';
import { shellQuote as q } from '../pipelines/pipeline.validation';
import type { ComposeReleaseEvidence } from '../service-configs/compose-template-reference';
import { terminalTaskStatuses, type TaskPayload } from '../tasks/tasks.types';
import type { GraphReleaseResult } from './graph-release-gates';

const inspectionAction = 'execution-flow.release.inspected';
const inspectionResource = 'execution-release-target';
type InspectionStatus = 'CURRENT' | 'PREVIOUS' | 'NO_ACTIVE_RELEASE' | 'UNKNOWN';

export interface GraphReleaseInspection {
  status: InspectionStatus;
  serverId: string;
  checkedAt: number;
  releaseId?: string;
  previousReleaseId?: string;
  activeReleaseId?: string;
  currentPath?: string;
  locksPresent?: boolean;
  canReplan: boolean;
  reason?: string;
}

interface ReleaseEvidence {
  id: string;
  snapshot: PipelineSnapshot;
  releaseKey: string;
  compose?: ComposeReleaseEvidence;
}

export async function latestReleaseInspections(db: Kysely<Database>, targetIds: string[]) {
  const result = new Map<string, GraphReleaseInspection>();
  if (!targetIds.length) return result;
  const latest = db
    .selectFrom('audit_logs')
    .select(['resource_id', 'details_json'])
    .select(({ fn }) =>
      fn
        .agg<number>('row_number', [])
        .over((window) =>
          window.partitionBy('resource_id').orderBy('created_at', 'desc').orderBy('id', 'desc'),
        )
        .as('rank'),
    )
    .where('action', '=', inspectionAction)
    .where('resource_type', '=', inspectionResource)
    .where('resource_id', 'in', targetIds);
  for (const row of await db
    .selectFrom(latest.as('observation'))
    .select(['resource_id', 'details_json'])
    .where('rank', '=', 1)
    .execute()) {
    if (row.resource_id)
      result.set(
        row.resource_id,
        (JSON.parse(row.details_json) as { inspection: GraphReleaseInspection }).inspection,
      );
  }
  return result;
}

function verifyComposeRelease(scope: PipelineSnapshot, evidence?: ComposeReleaseEvidence) {
  const project = scope.graphDeployment?.composeProject;
  if (
    !project ||
    evidence?.composeProject !== project ||
    !/^sha256:[a-f0-9]{64}$/.test(evidence.imageId) ||
    !evidence.dockerEngineId ||
    !/^[A-Za-z0-9:_-]{1,180}$/.test(evidence.dockerEngineId)
  )
    return 'exit 42';
  const inspect =
    '{{index .Config.Labels "com.docker.compose.oneoff"}} {{index .Config.Labels "com.docker.compose.project.working_dir"}} {{.Image}} {{.State.Status}}:{{.State.ExitCode}}';
  return `test "$(docker info --format '{{.ID}}')" = ${q(evidence.dockerEngineId)}
containers=$(docker ps --all --filter ${q('label=com.docker.compose.project=' + project)} --format '{{.ID}}')
matched=no
for id in $containers; do
  case "$id" in ''|*[!a-fA-F0-9]*) exit 42 ;; esac
  fingerprint=$(docker container inspect --format ${q(inspect)} "$id")
  case "$fingerprint" in
    'True '*|'true '*) continue ;;
    "False $release_dir "*|"false $release_dir "*) ;;
    *) exit 42 ;;
  esac
  case "$fingerprint" in
    *' running:'*|*' exited:0') ;;
    *) exit 42 ;;
  esac
  case "$fingerprint" in
    *${q(' ' + evidence.imageId + ' ')}*) matched=yes ;;
  esac
done
test "$matched" = yes`;
}

function inspectCommand(
  scope: PipelineSnapshot,
  attempt?: ReleaseEvidence,
  previous?: ReleaseEvidence,
) {
  const root = snapshotPath(scope.definition.deployPath);
  const lockPaths = deploymentLock(scope).paths;
  const lockCheck = lockPaths
    .map((path) => `test ! -e ${q(path)} && test ! -L ${q(path)}`)
    .join(' && ');
  const lockDirectory = q(posix.dirname(lockPaths[0]!));
  const compose = scope.graphDeployment?.method === 'COMPOSE';
  const owner = q(`${scope.projectId}:${scope.serviceId}:${scope.environmentId}`);
  const releaseCase = (entry: ReleaseEvidence | undefined, status: 'CURRENT' | 'PREVIOUS') => {
    if (!entry) return '';
    const path = `${root}/releases/${entry.releaseKey}`;
    return `${q(`releases/${entry.releaseKey}`)})
    result=${status}
    release_dir=${q(path)}
    test ! -L "$release_dir" && test -d "$release_dir" && test "$(realpath -e -- "$release_dir")" = "$release_dir" || exit 42
    ${compose ? verifyComposeRelease(scope, entry.compose) : ':'}
    ;;`;
  };
  const noActive = compose ? 'exit 42' : 'result=NO_ACTIVE_RELEASE';
  return `set -eu
root=${q(root)}
current="$root/current"
test ! -L /var/tmp && test -d /var/tmp && test "$(stat -c '%u:%a' -- /var/tmp)" = 0:1777 || exit 42
if test -e ${lockDirectory} || test -L ${lockDirectory}; then
  test ! -L ${lockDirectory} && test -d ${lockDirectory} && test -x ${lockDirectory} || exit 42
  test "$(stat -c '%u:%a' -- ${lockDirectory})" = "$(id -u):700"
fi
lock_state() { if ${lockCheck}; then printf CLEAR; else printf HELD; fi; }
before=$(lock_state)
test ! -L "$root" && test "$(realpath -m -- "$root")" = "$root" || exit 42
test -d ${q(posix.dirname(root))} && test -x ${q(posix.dirname(root))} || exit 42
if test -e "$root"; then
  test -d "$root" && test -x "$root" || exit 42
  test ! -L "$root/.veyops-managed" && test -f "$root/.veyops-managed" || exit 42
  test "$(cat -- "$root/.veyops-managed")" = ${owner}
fi
if test -L "$current"; then
  link=$(readlink -- "$current")
  case "$link" in
    ${releaseCase(attempt, 'CURRENT')}
    ${releaseCase(previous, 'PREVIOUS')}
    *) exit 42 ;;
  esac
  test -L "$current" && test "$(readlink -- "$current")" = "$link" || exit 42
else
  test ! -e "$current"
  ${noActive}
  test ! -e "$current" && test ! -L "$current" || exit 42
fi
test "$(lock_state)" = "$before"
printf 'VEYOPS_RELEASE_OBSERVATION=%s:%s\n' "$result" "$before"`;
}

@Injectable()
export class GraphReleaseInspectionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly deployments: DeploymentsService,
    private readonly ssh: SshService,
    private readonly audit: AuditService,
  ) {}

  private async assertOperator(user: CurrentUser, ownerId: string) {
    const actor = await this.database.db
      .selectFrom('users')
      .select('role')
      .where('id', '=', user.id)
      .where('status', '=', 'ACTIVE')
      .where('must_change_password', '=', 0)
      .executeTakeFirst();
    if (actor?.role !== 'ADMIN' && (actor?.role !== 'OPERATOR' || user.id !== ownerId))
      throw new ForbiddenException('仅管理员或本次执行的操作员可以核查目标');
  }

  private async release(
    projectId: string,
    serverId: string,
    condition: { taskId: string } | { id: string },
  ) {
    let query = this.database.db
      .selectFrom('deployment_records as release')
      .innerJoin('pipeline_runs as build', 'build.id', 'release.pipeline_run_id')
      .select([
        'release.id',
        'release.previous_deployment_id',
        'release.deploy_path',
        'release.release_snapshot_json',
        'release.compose_release_json',
      ])
      .where('build.project_id', '=', projectId)
      .where('release.server_id', '=', serverId);
    query =
      'id' in condition
        ? query.where('release.id', '=', condition.id)
        : query.where('build.task_id', '=', condition.taskId);
    return query
      .orderBy('release.started_at', 'desc')
      .orderBy('release.id', 'desc')
      .executeTakeFirst();
  }

  private evidence(
    row: Awaited<ReturnType<GraphReleaseInspectionService['release']>>,
    scope: PipelineSnapshot,
  ): ReleaseEvidence | undefined {
    if (!row?.release_snapshot_json || !row.deploy_path) return;
    const snapshot = JSON.parse(row.release_snapshot_json) as PipelineSnapshot;
    if (
      !snapshot.releaseKey ||
      !isUUID(snapshot.releaseKey) ||
      snapshot.projectId !== scope.projectId ||
      snapshot.serviceId !== scope.serviceId ||
      snapshot.environmentId !== scope.environmentId ||
      snapshotPath(row.deploy_path) !== snapshotPath(scope.definition.deployPath) ||
      snapshotPath(snapshot.definition.deployPath) !== snapshotPath(row.deploy_path) ||
      snapshot.definition.artifactType !== scope.definition.artifactType
    )
      return;
    return {
      id: row.id,
      snapshot,
      releaseKey: snapshot.releaseKey,
      compose: row.compose_release_json
        ? (JSON.parse(row.compose_release_json) as ComposeReleaseEvidence)
        : undefined,
    };
  }

  private async target(serverId: string, pinned: SshTarget | undefined) {
    const server = await this.database.db
      .selectFrom('servers as server')
      .innerJoin('credentials as credential', 'credential.id', 'server.credential_id')
      .select([
        'server.host',
        'server.port',
        'server.username',
        'server.host_key_fingerprint',
        'server.credential_id',
        'credential.nonce',
      ])
      .where('server.id', '=', serverId)
      .where('server.is_active', '=', 1)
      .where('credential.status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (
      !server ||
      !pinned?.hostKeyFingerprint ||
      !pinned.credentialNonce ||
      server.host !== pinned.host ||
      server.port !== pinned.port ||
      server.username !== pinned.username ||
      server.host_key_fingerprint !== pinned.hostKeyFingerprint ||
      server.credential_id !== pinned.credentialId ||
      server.nonce !== pinned.credentialNonce
    )
      return;
    return pinned;
  }

  private async hasExclusivePath(scope: PipelineSnapshot, serverId: string) {
    try {
      await this.deployments.assertGraphReleasePath(this.database.db, scope, serverId);
      return true;
    } catch (error) {
      if (error instanceof ConflictException) return false;
      throw error;
    }
  }

  async inspect(
    projectId: string,
    runId: string,
    nodeId: string,
    serverId: string,
    user: CurrentUser,
  ) {
    const db = this.database.db;
    const row = await db
      .selectFrom('execution_node_runs as node')
      .innerJoin('execution_flow_runs as run', 'run.id', 'node.run_id')
      .innerJoin('projects as project', 'project.id', 'run.project_id')
      .innerJoin('tasks as task', 'task.id', 'node.task_id')
      .innerJoin('task_targets as target', 'target.task_id', 'task.id')
      .select([
        'node.node_type as type',
        'node.output_json',
        'run.created_by',
        'task.id as taskId',
        'task.status as taskStatus',
        'task.payload_json',
        'target.id as targetId',
        'target.status as targetStatus',
      ])
      .where('run.id', '=', runId)
      .where('run.project_id', '=', projectId)
      .where('project.deleted_at', 'is', null)
      .where('node.node_id', '=', nodeId)
      .where('node.node_type', 'in', ['DEPLOY_ARTIFACT', 'ROLLBACK_ARTIFACT', 'HEALTH_CHECK'])
      .where('target.server_id', '=', serverId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('找不到该执行节点的发布目标');
    await this.assertOperator(user, row.created_by);
    if (!(terminalTaskStatuses as readonly string[]).includes(row.taskStatus))
      throw new ConflictException('请等待原任务结束后再核查发布');
    const output = JSON.parse(row.output_json ?? '{}') as { release?: GraphReleaseResult };
    if (
      !['NEEDS_ATTENTION', 'FAILED', 'TIMED_OUT'].includes(row.targetStatus) &&
      !(
        row.type === 'HEALTH_CHECK' &&
        output.release?.targets.some(
          (target) => target.serverId === serverId && target.health === 'UNKNOWN',
        )
      )
    )
      throw new ConflictException('此目标暂无需要核查的发布或健康检查结果');

    const payload = JSON.parse(row.payload_json) as TaskPayload;
    const healthReleaseId = payload.graphModule?.healthCheck?.release.targets.find(
      (target) => target.serverId === serverId,
    )?.deploymentId;
    const attemptRow = await this.release(
      projectId,
      serverId,
      healthReleaseId ? { id: healthReleaseId } : { taskId: row.taskId },
    );
    const scope = attemptRow?.release_snapshot_json
      ? (JSON.parse(attemptRow.release_snapshot_json) as PipelineSnapshot)
      : payload.pipeline;
    let result: Omit<GraphReleaseInspection, 'serverId' | 'checkedAt'> = {
      status: 'UNKNOWN',
      canReplan: false,
      reason: '缺少可核对的发布快照',
    };
    if (scope?.graphDeployment && scope.projectId === projectId) {
      const currentPath = snapshotPath(scope.definition.deployPath) + '/current';
      const attempt = this.evidence(attemptRow, scope);
      const known = await this.deployments.currentSnapshot(db, scope, serverId);
      const previousId =
        attemptRow?.previous_deployment_id ?? (!attemptRow ? known?.id : undefined);
      const previous =
        previousId && previousId !== attempt?.id
          ? this.evidence(await this.release(projectId, serverId, { id: previousId }), scope)
          : undefined;
      result = { ...result, currentPath, releaseId: attempt?.id, previousReleaseId: previous?.id };
      const target = await this.target(
        serverId,
        payload.targets.find(({ id }) => id === serverId),
      );
      if (!target) result.reason = '服务器连接身份或凭据较原任务已变化';
      else {
        const observation = await this.observe(target, scope, attempt, previous);
        if (observation) {
          const actualId =
            observation.status === 'CURRENT'
              ? attempt?.id
              : observation.status === 'PREVIOUS'
                ? previous?.id
                : undefined;
          const latest = await this.deployments.currentSnapshot(db, scope, serverId);
          const commands = [scope, previous?.snapshot].some((snapshot) =>
            Boolean(
              snapshot?.definition.startCommand ||
              snapshot?.definition.stopCommand ||
              snapshot?.definition.healthCheckCommand,
            ),
          );
          const stableTarget = await this.target(serverId, target);
          const matchesRecorded =
            actualId === known?.id &&
            actualId === latest?.id &&
            (!latest || latest.status === 'SUCCESS');
          const exclusivePath = await this.hasExclusivePath(scope, serverId);
          result = {
            ...result,
            ...observation,
            status: stableTarget ? observation.status : 'UNKNOWN',
            activeReleaseId: stableTarget ? actualId : undefined,
            canReplan: Boolean(
              stableTarget &&
              matchesRecorded &&
              exclusivePath &&
              !observation.locksPresent &&
              !commands,
            ),
            reason: !stableTarget
              ? '核查期间服务器连接身份已变化'
              : observation.locksPresent
                ? '检测到发布锁，本次只记录观测结果'
                : !matchesRecorded
                  ? '远端发布与平台记录尚未一致，需要人工核对'
                  : !exclusivePath
                    ? '此目录还有其他发布记录，需要人工核对归属'
                    : commands
                      ? '当前链接已核对，请同时确认自定义发布命令和应用进程的状态'
                      : undefined,
          };
        } else result.reason = '未能核对发布链接、目录、锁或 Compose 容器身份';
      }
    }
    const inspection: GraphReleaseInspection = { ...result, serverId, checkedAt: Date.now() };
    await this.assertOperator(user, row.created_by);
    await this.audit.record(user.id, inspectionAction, inspectionResource, row.targetId, {
      runId,
      nodeId,
      inspection,
    });
    return inspection;
  }

  private async observe(
    target: SshTarget,
    scope: PipelineSnapshot,
    attempt?: ReleaseEvidence,
    previous?: ReleaseEvidence,
  ) {
    let output = '';
    try {
      const observation = await this.ssh.execute(target, inspectCommand(scope, attempt, previous), {
        timeout: 20,
        onData: (text, stream) => {
          if (stream === 'stdout' && output.length < 1024)
            output += text.slice(0, 1024 - output.length);
        },
      });
      if (observation.signal || observation.exitCode !== 0) return;
    } catch {
      return;
    }
    const value =
      /^VEYOPS_RELEASE_OBSERVATION=(CURRENT|PREVIOUS|NO_ACTIVE_RELEASE):(CLEAR|HELD)$/.exec(
        output.trim(),
      );
    if (value)
      return {
        status: value[1] as Exclude<InspectionStatus, 'UNKNOWN'>,
        locksPresent: value[2] === 'HELD',
      };
  }
}
