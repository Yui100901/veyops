import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import { readArtifactSources } from '../artifacts/artifact-sources';
import type { PipelineSnapshot } from '../pipelines/pipeline.types';
import { unversionedArtifactRepository } from './graph-workspace';

export type GraphReviewSource = { repositoryId: string; commitSha: string };
export type GraphGateScope =
  | {
      kind: 'SOURCE_REVIEW';
      sources: GraphReviewSource[];
      artifactIds: string[];
      buildNodeId?: string;
    }
  | {
      kind: 'RELEASE';
      releaseNodeId: string;
      serviceId: string;
      serverIds: string[];
      artifactIds: string[];
      artifactFingerprints: string[];
      rollbackBaseline?: Record<string, string>;
    };

export interface GraphGateProof {
  nodeId: string;
  actorId: string;
  hash: string;
}

export interface GraphReleaseGate {
  runId: string;
  nodeId: string;
  approval?: GraphGateProof;
  review?: GraphGateProof;
}

export interface GraphGateDecision {
  decision?: 'APPROVE' | 'REJECT';
  actorId?: string;
  expiresAt?: number;
  scopeHash?: string;
  scope?: GraphGateScope;
}

export interface GraphReleaseResult {
  operation: 'DEPLOY' | 'ROLLBACK' | 'CHECK';
  serviceId: string;
  status: string;
  healthStatus?: 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN';
  targets: {
    serverId: string;
    deploymentId?: string;
    artifactInstanceId?: string;
    plannedArtifactInstanceId?: string;
    consumedArtifacts?: { artifactId: string }[];
    errorSummary?: string;
    status: string;
    health?: string;
    healthReason?: string;
    probeExitCode?: number | null;
  }[];
}

export function graphReleaseResult(value: unknown): GraphReleaseResult {
  const result = value as Partial<GraphReleaseResult> | undefined;
  if (
    !result ||
    !result.operation ||
    !['DEPLOY', 'ROLLBACK', 'CHECK'].includes(result.operation) ||
    !result.serviceId ||
    !result.status ||
    !Array.isArray(result.targets) ||
    !result.targets.length ||
    !result.targets.every(
      (target) =>
        target?.serverId && target.status && (target.status !== 'SUCCESS' || target.deploymentId),
    ) ||
    new Set(result.targets.map(({ serverId }) => serverId)).size !== result.targets.length
  )
    throw new ConflictException('缺少有效的发布服务或逐服务器发布记录');
  return result as GraphReleaseResult;
}

export function sameIds(left: readonly string[], right: readonly string[]) {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

export function graphGateHash(
  runId: string,
  nodeId: string,
  configurationHash: string,
  scope: GraphGateScope,
) {
  return createHash('sha256')
    .update(
      JSON.stringify([runId, nodeId, configurationHash, scope], (_key, value: unknown) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      ),
    )
    .digest('hex');
}

export function reviewSources(sources: readonly { repositoryId?: string; commitSha?: string }[]) {
  const unique = new Map<string, GraphReviewSource>();
  for (const source of sources) {
    if (
      !source.repositoryId ||
      source.repositoryId === unversionedArtifactRepository ||
      !source.commitSha ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(source.commitSha)
    )
      throw new ConflictException('源码审核需要可核对的仓库和完整提交 SHA');
    const commitSha = source.commitSha.toLowerCase();
    unique.set(source.repositoryId + ':' + commitSha, {
      repositoryId: source.repositoryId,
      commitSha,
    });
  }
  return [...unique]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, source]) => source);
}

export async function artifactReviewSources(db: Kysely<Database>, artifactIds: string[]) {
  const sourceMap = await readArtifactSources(db, artifactIds);
  if (!artifactIds.length || artifactIds.some((id) => !sourceMap.get(id)?.length))
    throw new ConflictException('并非所有产物都具备可核对的源码记录');
  return reviewSources(artifactIds.flatMap((id) => sourceMap.get(id)!));
}

export function assertReviewedSources(
  scope: GraphGateScope,
  actual: Parameters<typeof reviewSources>[0],
  buildNodeId?: string,
) {
  if (scope.kind !== 'SOURCE_REVIEW' || (scope.buildNodeId && scope.buildNodeId !== buildNodeId))
    throw new ConflictException('审核凭证与本次执行的构建节点不一致');
  const verified = reviewSources(actual);
  if (
    !verified.length ||
    !sameIds(
      scope.sources.map(({ repositoryId, commitSha }) => repositoryId + ':' + commitSha),
      verified.map(({ repositoryId, commitSha }) => repositoryId + ':' + commitSha),
    )
  )
    throw new ConflictException('实际使用的仓库及提交与本次执行流审核范围不一致');
}

export async function readGraphGate(
  db: Kysely<Database>,
  projectId: string,
  runId: string,
  proof: GraphGateProof,
  type: 'APPROVAL' | 'SOURCE_REVIEW',
) {
  const row = await db
    .selectFrom('execution_node_runs as node')
    .innerJoin('execution_flow_runs as run', 'run.id', 'node.run_id')
    .select(['node.output_json', 'run.configuration_hash'])
    .where('run.id', '=', runId)
    .where('run.project_id', '=', projectId)
    .where('run.status', 'in', ['QUEUED', 'RUNNING', 'WAITING'])
    .where('node.node_id', '=', proof.nodeId)
    .where('node.node_type', '=', type)
    .where('node.status', '=', 'SUCCESS')
    .executeTakeFirst();
  const data: GraphGateDecision = JSON.parse(row?.output_json ?? '{}');
  if (
    !row ||
    data.decision !== 'APPROVE' ||
    data.actorId !== proof.actorId ||
    !data.scope ||
    data.scopeHash !== proof.hash ||
    graphGateHash(runId, proof.nodeId, row.configuration_hash, data.scope) !== proof.hash
  )
    throw new ConflictException('本次运行的审核或审批已失效，请核对节点决定');
  const actor = await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', proof.actorId)
    .where('role', '=', 'ADMIN')
    .where('status', '=', 'ACTIVE')
    .where('must_change_password', '=', 0)
    .executeTakeFirst();
  if (!actor) throw new ConflictException('审核或审批人权限已失效');
  return data.scope;
}

export async function assertGraphReleaseGate(
  db: Kysely<Database>,
  snapshot: PipelineSnapshot,
  taskId: string,
) {
  const gate = snapshot.graphGate;
  if (!gate) return;
  const linked = await db
    .selectFrom('execution_node_runs as node')
    .innerJoin('execution_flow_runs as run', 'run.id', 'node.run_id')
    .innerJoin('users as requester', 'requester.id', 'run.created_by')
    .select('node.id')
    .where('node.task_id', '=', taskId)
    .where('node.node_id', '=', gate.nodeId)
    .where('run.id', '=', gate.runId)
    .where('run.project_id', '=', snapshot.projectId)
    .where('run.status', 'in', ['QUEUED', 'RUNNING', 'WAITING'])
    .where('requester.status', '=', 'ACTIVE')
    .where('requester.must_change_password', '=', 0)
    .where('requester.role', 'in', ['ADMIN', 'OPERATOR'])
    .executeTakeFirst();
  if (!linked) throw new ConflictException('发起人权限或执行图运行已失效');
  const artifactIds = (snapshot.deploymentArtifacts ?? []).map(({ id }) => id);
  if (gate.approval) {
    const approval = await readGraphGate(
      db,
      snapshot.projectId,
      gate.runId,
      gate.approval,
      'APPROVAL',
    );
    if (
      approval.kind !== 'RELEASE' ||
      approval.releaseNodeId !== gate.nodeId ||
      approval.serviceId !== snapshot.serviceId ||
      !sameIds(approval.serverIds, snapshot.targetMemberIds ?? []) ||
      !sameIds(approval.artifactIds, artifactIds) ||
      !sameIds(
        approval.artifactFingerprints,
        (snapshot.deploymentArtifacts ?? []).flatMap(({ fingerprint }) =>
          fingerprint ? [fingerprint] : [],
        ),
      ) ||
      !sameIds(
        Object.entries(approval.rollbackBaseline ?? {}).map(([server, id]) => server + ':' + id),
        Object.entries(snapshot.graphRollback ?? {}).map(([server, id]) => server + ':' + id),
      )
    )
      throw new ConflictException('发布实例、服务或目标超出审批范围');
  }
  if (gate.review) {
    const review = await readGraphGate(
      db,
      snapshot.projectId,
      gate.runId,
      gate.review,
      'SOURCE_REVIEW',
    );
    const actual =
      snapshot.mode === 'DEPLOY_ARTIFACT'
        ? await artifactReviewSources(db, artifactIds)
        : (snapshot.artifactSources ?? []);
    assertReviewedSources(review, actual, snapshot.mode === 'BUILD_ONLY' ? gate.nodeId : undefined);
    if (
      review.kind === 'SOURCE_REVIEW' &&
      review.artifactIds.length &&
      !sameIds(review.artifactIds, artifactIds)
    )
      throw new ConflictException('实际使用的产物实例与审核范围不一致');
  }
}
