import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Injectable,
  NotFoundException,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ArrayMaxSize, ArrayUnique, IsArray, IsOptional, IsUUID } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import type { Response } from 'express';
import { dataDirectory } from '../../core/config';
import { DatabaseService } from '../../core/database/database.service';
import type { ArtifactsTable, Database } from '../../core/database/schema';
import type { Kysely, Selectable } from 'kysely';
import type { PipelineSnapshot, PipelineArtifact } from '../pipelines/pipeline.types';
import type { TaskPayload } from '../tasks/tasks.types';
import type { EnvironmentSetSummary } from '../projects/environment-sets.service';
import { storedDeploymentSelection } from '../deployment-targets/deployment-selection';
import { archiveKey, isLocalImage } from './artifact-availability';
import { ArtifactFilters } from '../projects/delivery-filters';
import { lockProjectGraph } from '../projects/project-relations';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import type { SshTarget } from '../../infrastructure/ssh/ssh.service';
import {
  ArtifactPhysicalService,
  physicalKey,
  type ArtifactPhysical,
} from './artifact-physical.service';
import { artifactIdentity } from './artifact-identities';
import { graphUnscopedArtifactService } from '../pipelines/delivery-execution-profile';
import { readArtifactSources } from './artifact-sources';
import {
  maxComposeBytes,
  readManagedCompose,
  type ComposeTemplateReference,
} from '../service-configs/compose-template-reference';

export { maxComposeBytes } from '../service-configs/compose-template-reference';

const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const sha256 = /^[a-f0-9]{64}$/;

function sourceEvent(value: string | null) {
  if (!value) return undefined;
  const trigger = (JSON.parse(value) as { trigger?: Record<string, unknown> }).trigger;
  if (!trigger?.eventId) return undefined;
  return Object.fromEntries(
    ['eventId', 'repositoryId', 'commitSha', 'ref', 'triggeredAt'].flatMap((key) =>
      typeof trigger[key] === 'string' || typeof trigger[key] === 'number'
        ? [[key, trigger[key]]]
        : [],
    ),
  );
}

function artifactEnvironmentSet(value: string | null) {
  if (!value) return null;
  const set = (JSON.parse(value) as { environmentSet?: EnvironmentSetSummary }).environmentSet;
  return set ? { id: set.id, name: set.name, revision: set.revision } : null;
}

function historicalServerSelection(value: string | null) {
  if (!value) return null;
  const payload = JSON.parse(value) as TaskPayload;
  return payload.targets?.length
    ? {
        serverIds: payload.targets.map((target) => target.id),
        groupIds: [],
        strategy: payload.strategy,
        maxParallel: payload.maxParallel,
        failurePolicy: payload.failurePolicy,
      }
    : null;
}

export function archivedComposeTemplate(
  value: string | null,
  name: string | null,
  checksum: string | null,
): Extract<ComposeTemplateReference, { source: 'ARCHIVE' }> | undefined {
  if (!checksum) return undefined;
  const definition = value ? (JSON.parse(value) as TaskPayload).pipeline?.definition : undefined;
  const path =
    definition?.artifacts?.find((declaration) => declaration.name === name)?.composeFilePath ??
    definition?.composeFilePath;
  return {
    source: 'ARCHIVE',
    path: path ? posix.join(definition?.repoPath ?? '.', path) : undefined,
    checksum,
  };
}

function declaredImageReference(value: string | null, name: string | null) {
  if (!value || !name) return undefined;
  const definition = (JSON.parse(value) as TaskPayload).pipeline?.definition;
  return definition?.artifacts?.find((artifact) => artifact.name === name)?.imageReference;
}
const digest = /^sha256:[a-f0-9]{64}$/;
const registryReference = /^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$/;
const registryTag = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/;
const imagePlatform = /^[a-z0-9]+\/[a-z0-9]+$/;
const localImageReference = new RegExp(
  `^veyops-build/${uuid}(?:/${uuid})?:[a-f0-9]{40,64}-${uuid}$`,
);
export interface DeploymentArtifact {
  id: string;
  localArchive?: string;
  checksum?: string;
  imageReference?: string;
  imageId?: string;
  physical?: ArtifactPhysical;
  composeYaml?: string;
  composeTemplate?: ComposeTemplateReference;
  offlineImage?: {
    reference: string;
    imageId: string;
    platform: string;
    readArchive: () => Promise<{ localArchive: string; checksum: string }>;
  };
}

type Instance = Selectable<ArtifactsTable>;
type Verification = {
  status: 'AVAILABLE' | 'MISSING' | 'CHANGED' | 'UNVERIFIABLE';
  reason?: string;
};

function physicalOf(row: Pick<Instance, 'physical_json'>) {
  return row.physical_json ? (JSON.parse(row.physical_json) as ArtifactPhysical) : undefined;
}

function applicationServer(row: Pick<Instance, 'physical_json' | 'server_id'>) {
  return physicalOf(row)?.location === 'REGISTRY' ? null : row.server_id;
}
function displayPhysical(row: Pick<Instance, 'physical_json'>) {
  const real = physicalOf(row);
  if (!real) return undefined;
  const display = { ...real };
  delete display.ownerToken;
  delete display.hostKeyFingerprint;
  return display;
}

function hasDeployableMetadata(row: Selectable<ArtifactsTable>, managedCompose: boolean) {
  if (row.lifecycle_state !== 'ACTIVE') return false;
  if (row.pruned_at !== null && row.storage_type !== 'REGISTRY_IMAGE') return false;
  const hasArchive = Boolean(
    archiveKey(row) &&
    row.checksum &&
    sha256.test(row.checksum) &&
    row.size_bytes !== null &&
    Number.isSafeInteger(row.size_bytes) &&
    row.size_bytes > 0,
  );
  const physical = physicalOf(row);
  if (row.artifact_type === 'FILE')
    return (
      physical?.location === 'SERVER_PATH' || (hasArchive && row.storage_type === 'LOCAL_FILE')
    );
  if (
    row.artifact_type !== 'DOCKER_IMAGE' ||
    (!managedCompose &&
      (!row.compose_yaml ||
        Buffer.byteLength(row.compose_yaml) > maxComposeBytes ||
        !row.compose_checksum ||
        !sha256.test(row.compose_checksum))) ||
    !row.image_digest ||
    !digest.test(row.image_digest)
  )
    return false;
  if (row.storage_type === 'REGISTRY_IMAGE')
    return (
      registryReference.test(row.storage_key) && row.storage_key.endsWith(`@${row.image_digest}`)
    );
  return (
    (hasArchive || (physical?.location === 'DOCKER_ENGINE' && !!row.server_id)) &&
    isLocalImage(row.storage_type) &&
    localImageReference.test(row.storage_key)
  );
}

function checksumOf(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

export function deploymentFingerprint(row: Selectable<ArtifactsTable>) {
  return checksumOf(
    JSON.stringify([
      row.id,
      row.pipeline_run_id,
      row.server_id,
      row.source_commit,
      row.artifact_name,
      row.artifact_kind,
      row.graph_run_id,
      row.graph_node_run_id,
      row.artifact_type,
      row.storage_type,
      row.storage_key,
      row.archive_key,
      row.checksum,
      row.size_bytes,
      row.image_digest,
      row.archive_image_id,
      row.archive_image_platform,
      row.compose_checksum,
      row.physical_json,
    ]),
  );
}

@Injectable()
export class ArtifactsService {
  constructor(
    private readonly database: DatabaseService,
    @Optional() private readonly physical?: ArtifactPhysicalService,
    @Optional() private readonly audit?: AuditService,
  ) {}
  async create(snapshot: PipelineSnapshot, artifact: Omit<PipelineArtifact, 'id'>) {
    const grouped = snapshot.graph
      ? artifactIdentity(snapshot, artifact.name, artifact.serverId)
      : undefined;
    const id = grouped?.instanceId ?? randomUUID();
    const temporaryRootId =
      artifact.persist === false ? (snapshot.graph?.rootRunId ?? snapshot.graph?.runId) : undefined;
    if (artifact.persist === false && !temporaryRootId)
      throw new BadRequestException('临时产物只能在执行图运行中登记');
    const d = snapshot.definition;
    const artifactType = artifact.kind
      ? artifact.kind === 'DOCKER_IMAGE'
        ? 'DOCKER_IMAGE'
        : 'FILE'
      : d.artifactType;
    const storageType =
      artifact.storageType ??
      (artifactType === 'DOCKER_IMAGE'
        ? 'REGISTRY_IMAGE'
        : artifact.serverId
          ? 'REMOTE_FILE'
          : 'LOCAL_FILE');
    const localImage = isLocalImage(storageType);
    const imageTagPosition = artifact.imageReference?.lastIndexOf(':') ?? -1;
    const declared = d.artifacts?.find((entry) => entry.name === artifact.name);
    const sources =
      artifactType === 'DOCKER_IMAGE' && declared?.imageReference
        ? []
        : (artifact.sources ?? snapshot.artifactSources);
    const physicalJson = artifact.physical ? JSON.stringify(artifact.physical) : null;
    const locationKey = artifact.physical ? physicalKey(artifact.physical) : null;
    const composeChecksum = artifact.composeYaml ? checksumOf(artifact.composeYaml) : null;
    await this.database.db.transaction().execute(async (tx) => {
      if (grouped || locationKey) await lockProjectGraph(tx);
      if (
        temporaryRootId &&
        !(await tx
          .selectFrom('execution_flow_runs')
          .select('id')
          .where('id', '=', temporaryRootId)
          .where('project_id', '=', snapshot.projectId)
          .where('status', 'in', ['QUEUED', 'RUNNING', 'WAITING'])
          .executeTakeFirst())
      )
        throw new ConflictException('临时产物的根运行已结束');
      if (
        locationKey &&
        (await tx
          .selectFrom('artifacts')
          .select('id')
          .where('physical_key', '=', locationKey)
          .where('lifecycle_state', '=', 'CLEANING')
          .executeTakeFirst())
      )
        throw new ConflictException('产物实物正在清理，请稍后恢复登记');
      if (grouped) {
        const previous = await tx
          .selectFrom('artifacts')
          .select([
            'project_id',
            'pipeline_run_id',
            'physical_json',
            'compose_checksum',
            'source_commit',
            'lifecycle_state',
          ])
          .where('id', '=', id)
          .executeTakeFirst();
        if (previous) {
          if (
            previous.project_id !== snapshot.projectId ||
            previous.pipeline_run_id !== snapshot.runId ||
            previous.physical_json !== physicalJson ||
            previous.source_commit !== snapshot.commitSha ||
            previous.lifecycle_state !== 'ACTIVE'
          )
            throw new ConflictException('已登记的产物与本次恢复的实物不一致');
          if (previous.compose_checksum !== composeChecksum)
            throw new ConflictException(
              '已登记的产物「' + artifact.name + '」的 Compose 归档与本次恢复不一致',
            );
          return;
        }
      }
      const origin = snapshot.graph
        ? await tx
            .selectFrom('execution_flow_runs')
            .select('inputs_json')
            .where('id', '=', snapshot.graph.runId)
            .executeTakeFirst()
        : undefined;
      await tx
        .insertInto('artifacts')
        .values({
          id,
          logical_artifact_id: grouped?.artifactId ?? id,
          physical_json: physicalJson,
          physical_key: locationKey,
          temporary_root_id: temporaryRootId ?? null,
          environment_set_id: artifactEnvironmentSet(origin?.inputs_json ?? null)?.id ?? null,
          verification_status: artifact.physical ? 'AVAILABLE' : null,
          verified_at: artifact.physical ? Date.now() : null,
          project_id: snapshot.projectId,
          service_id: snapshot.serviceId,
          pipeline_run_id: snapshot.runId,
          artifact_type: artifactType,
          artifact_name: artifact.name ?? null,
          artifact_kind: artifact.kind ?? null,
          graph_run_id: snapshot.graph?.runId ?? null,
          graph_node_run_id: snapshot.graph?.nodeRunId ?? null,
          storage_type: storageType,
          storage_key: artifact.storageKey,
          archive_key: artifact.archiveKey ?? null,
          archive_image_id: artifact.archiveImageId ?? null,
          archive_image_platform: artifact.archiveImagePlatform ?? null,
          server_id: artifact.serverId ?? null,
          registry_id: storageType === 'REGISTRY_IMAGE' ? (d.registryId ?? null) : null,
          image_repository: localImage
            ? artifact.imageReference!.slice(0, imageTagPosition)
            : (d.imageRepository ?? null),
          image_tag: localImage
            ? artifact.imageReference!.slice(imageTagPosition + 1)
            : (artifact.imageTag ?? null),
          image_digest: artifact.imageId ?? artifact.imageDigest ?? null,
          compose_yaml: artifact.composeYaml ?? null,
          compose_checksum: composeChecksum,
          checksum: artifact.checksum ?? null,
          size_bytes: artifact.sizeBytes ?? null,
          source_commit: snapshot.commitSha,
          source_manifest: sources ? 1 : null,
          created_at: Date.now(),
        })
        .execute();
      if (sources?.length)
        await tx
          .insertInto('artifact_sources')
          .values(
            sources.map((source, position) => ({
              artifact_id: id,
              position,
              repository_id: source.repositoryId,
              commit_sha: source.commitSha,
              git_ref: source.ref ?? null,
              commit_subject: source.subject ?? null,
              workspace_run_id: source.workspace?.runId ?? null,
              workspace_node_run_id: source.workspace?.nodeRunId ?? null,
              path: source.path ?? null,
            })),
          )
          .execute();
      if (grouped && this.audit)
        await this.audit.record(
          null,
          'artifact.register',
          'artifact',
          id,
          {
            projectId: snapshot.projectId,
            artifactId: grouped.artifactId,
            serverId: artifact.serverId,
            temporary: Boolean(temporaryRootId),
          },
          tx,
        );
    });
    return { ...artifact, id };
  }
  async list(
    projectId?: string,
    pipelineRunId?: string,
    filters: ArtifactFilters = {},
    includeTemporary = false,
  ) {
    let query = this.database.db
      .selectFrom('artifacts')
      .leftJoin('pipeline_runs', 'pipeline_runs.id', 'artifacts.pipeline_run_id')
      .leftJoin('pipeline_versions', 'pipeline_versions.id', 'pipeline_runs.pipeline_version_id')
      .leftJoin('tasks', 'tasks.id', 'pipeline_runs.task_id')
      .leftJoin('execution_flow_runs as flow', (join) =>
        join
          .onRef('flow.id', '=', 'artifacts.graph_run_id')
          .onRef('flow.project_id', '=', 'artifacts.project_id'),
      )
      .leftJoin('execution_node_runs as node', (join) =>
        join
          .onRef('node.id', '=', 'artifacts.graph_node_run_id')
          .onRef('node.run_id', '=', 'flow.id'),
      )
      .selectAll('artifacts')
      .select([
        'pipeline_runs.pipeline_id as pipelineId',
        'pipeline_runs.task_id as taskId',
        'pipeline_versions.version as pipelineVersion',
        'pipeline_runs.environment_id as environmentId',
        'pipeline_runs.target_id as targetId',
        'pipeline_runs.target_selection_json as targetSelectionJson',
        'tasks.payload_json as sourceTaskPayload',
        'tasks.status as taskStatus',
        'flow.version as graphVersion',
        'flow.flow_name as graphFlowName',
        'flow.inputs_json as graphInputs',
        'node.name as graphNodeName',
        'node.node_type as graphNodeType',
        'node.node_id as graphNodeId',
      ])
      .select((eb) =>
        eb
          .selectFrom('service_compose_templates as template')
          .select('template.checksum')
          .whereRef('template.service_id', '=', 'artifacts.service_id')
          .whereRef('template.environment_id', '=', 'pipeline_runs.environment_id')
          .orderBy('template.version', 'desc')
          .limit(1)
          .as('managedComposeChecksum'),
      );
    if (projectId) query = query.where('artifacts.project_id', '=', projectId);
    if (!includeTemporary) query = query.where('artifacts.temporary_root_id', 'is', null);
    if (pipelineRunId) query = query.where('artifacts.pipeline_run_id', '=', pipelineRunId);
    if (filters.taskId) query = query.where('pipeline_runs.task_id', '=', filters.taskId);
    if (filters.recordId)
      query = query.where((eb) =>
        eb.or([
          eb('artifacts.id', '=', filters.recordId!),
          eb('artifacts.logical_artifact_id', '=', filters.recordId!),
        ]),
      );
    if (filters.serviceId) query = query.where('artifacts.service_id', '=', filters.serviceId);
    if (filters.environmentId)
      query = query.where('pipeline_runs.environment_id', '=', filters.environmentId);
    if (filters.environmentSetId)
      query = query.where('artifacts.environment_set_id', '=', filters.environmentSetId);
    if (filters.serverId) query = query.where('artifacts.server_id', '=', filters.serverId);
    if (filters.kind)
      query = query.where(
        (eb) => eb.fn.coalesce('artifacts.artifact_kind', 'artifacts.artifact_type'),
        '=',
        filters.kind,
      );
    if (filters.verificationStatus)
      query = query.where(
        (eb) => eb.fn.coalesce('artifacts.verification_status', eb.val('NOT_CHECKED')),
        '=',
        filters.verificationStatus!,
      );
    if (filters.commit || filters.commitSha || filters.repositoryId || filters.ref) {
      const sha = (filters.commitSha ?? filters.commit)?.toLowerCase();
      query = query.where((eb) => {
        const matched = eb.exists(
          eb
            .selectFrom('artifact_sources as source')
            .select('source.artifact_id')
            .whereRef('source.artifact_id', '=', 'artifacts.id')
            .$if(Boolean(filters.repositoryId), (q) =>
              q.where('source.repository_id', '=', filters.repositoryId!),
            )
            .$if(Boolean(filters.ref), (q) => q.where('source.git_ref', '=', filters.ref!))
            .$if(Boolean(sha), (q) => q.where('source.commit_sha', 'like', sha + '%')),
        );
        return !filters.repositoryId && !filters.ref && sha
          ? eb.or([
              matched,
              eb.and([
                eb('artifacts.source_manifest', 'is', null),
                eb('artifacts.source_commit', 'like', sha + '%'),
              ]),
            ])
          : matched;
      });
    }
    if (filters.cursor) {
      const cursor = await this.database.db
        .selectFrom('artifacts')
        .select(['id', 'created_at'])
        .where('id', '=', filters.cursor)
        .executeTakeFirst();
      if (!cursor) throw new BadRequestException('无效的产物分页位置');
      query = query.where((eb) =>
        eb.or([
          eb('artifacts.created_at', '<', cursor.created_at),
          eb.and([
            eb('artifacts.created_at', '=', cursor.created_at),
            eb('artifacts.id', '<', cursor.id),
          ]),
        ]),
      );
    }
    const rows = await query
      .orderBy('artifacts.created_at', 'desc')
      .orderBy('artifacts.id', 'desc')
      .limit(filters.limit ?? 200)
      .execute();
    const sources = await readArtifactSources(
      this.database.db,
      rows.map(({ id }) => id),
    );
    return rows.map((r) => ({
      id: r.id,
      artifactId: r.logical_artifact_id ?? r.id,
      instanceId: r.id,
      physical: displayPhysical(r),
      lifecycleState: r.lifecycle_state,
      verificationStatus: r.verification_status ?? 'NOT_CHECKED',
      verificationReason: r.verification_reason,
      verifiedAt: r.verified_at,
      temporary: Boolean(r.temporary_root_id),
      projectId: r.project_id,
      serviceId:
        r.service_id === graphUnscopedArtifactService(r.project_id).id ? null : r.service_id,
      pipelineRunId: r.pipeline_run_id,
      taskId: r.taskId,
      pipelineId: r.pipelineId,
      pipelineVersion: r.pipelineVersion,
      environmentId: r.environmentId,
      targetId: r.targetId,
      targetSelection:
        historicalServerSelection(r.sourceTaskPayload) ??
        storedDeploymentSelection(r.targetSelectionJson),
      deployable:
        (r.taskStatus === 'SUCCESS' || r.taskStatus === 'PARTIAL_FAILED') &&
        r.service_id !== graphUnscopedArtifactService(r.project_id).id &&
        hasDeployableMetadata(r, Boolean(r.managedComposeChecksum)),
      artifactType: r.artifact_type,
      name: r.artifact_name,
      kind: r.artifact_kind ?? r.artifact_type,
      graphRunId: r.graph_run_id,
      graphNodeRunId: r.graph_node_run_id,
      graphNodeId: r.graphNodeId,
      graphVersion: r.graphVersion,
      graphFlowName: r.graphFlowName,
      graphNodeName: r.graphNodeName,
      storageType: r.storage_type,
      storageKey: r.storage_key,
      downloadAvailable: r.pruned_at === null && Boolean(archiveKey(r)),
      pinnedAt: r.pinned_at,
      prunedAt: r.pruned_at,
      archiveDeletedAt: r.archive_deleted_at,
      archiveImageId: r.archive_image_id,
      archiveImagePlatform: r.archive_image_platform,
      serverId: r.server_id,
      imageRepository: r.image_repository,
      imageTag: r.image_tag,
      imageDigest: isLocalImage(r.storage_type) ? null : r.image_digest,
      imageId: isLocalImage(r.storage_type) ? r.image_digest : null,
      checksum: r.checksum,
      sizeBytes: r.size_bytes,
      sourceCommit: r.source_commit,
      sources: sources.get(r.id),
      sourceEvent: sourceEvent(r.graphInputs),
      environmentSet: artifactEnvironmentSet(r.graphInputs),
      composeTemplate: archivedComposeTemplate(
        r.sourceTaskPayload,
        r.artifact_name,
        r.compose_checksum,
      ),
      imageOrigin:
        r.artifact_type === 'DOCKER_IMAGE'
          ? r.graphNodeType === 'REGISTER_ARTIFACT' ||
            declaredImageReference(r.sourceTaskPayload, r.artifact_name)
            ? 'REGISTERED_IMAGE'
            : sources.get(r.id)?.length
              ? 'BUILD'
              : undefined
          : undefined,
      sourceImageReference:
        r.artifact_type === 'DOCKER_IMAGE'
          ? declaredImageReference(r.sourceTaskPayload, r.artifact_name)
          : undefined,
      createdAt: r.created_at,
    }));
  }

  async detail(id: string) {
    const row = await this.database.db
      .selectFrom('artifacts')
      .select(['project_id', 'logical_artifact_id', 'id'])
      .where((eb) => eb.or([eb('id', '=', id), eb('logical_artifact_id', '=', id)]))
      .executeTakeFirst();
    if (!row) throw new NotFoundException('产物不存在');
    const artifactId = row.logical_artifact_id ?? row.id;
    return {
      artifactId,
      instances: await this.list(row.project_id, undefined, { recordId: artifactId }, true),
    };
  }

  async checkInstances(id: string, instanceIds: string[] | undefined, userId: string) {
    const { artifactId, instances } = await this.detail(id);
    const chosen = instances.filter(
      (entry) => !instanceIds?.length || instanceIds.includes(entry.id),
    );
    if (instanceIds?.length && chosen.length !== instanceIds.length)
      throw new BadRequestException('部分实物实例不属于该产物');
    for (const instance of chosen) {
      const row = await this.database.db
        .selectFrom('artifacts')
        .selectAll()
        .where('id', '=', instance.id)
        .where('lifecycle_state', '=', 'ACTIVE')
        .executeTakeFirst();
      if (!row) continue;
      const check = await this.check(row);
      await this.recordCheck(row, check, userId);
      await this.audit?.record(userId, 'artifact.verify', 'artifact', instance.id, {
        artifactId,
        status: check.status,
      });
    }
    return this.detail(artifactId);
  }

  private async check(row: Instance, target?: SshTarget): Promise<Verification> {
    const physical = physicalOf(row);
    if (physical)
      return this.physical
        ? this.physical.verify(physical, target)
        : {
            status: 'UNVERIFIABLE',
            reason: '产物实物验证服务不可用',
          };
    const key = archiveKey(row);
    if (!key) return { status: 'UNVERIFIABLE', reason: '缺少可验证的实物描述' };
    try {
      await this.verifiedArchive(key, row);
      return { status: 'AVAILABLE' };
    } catch (error) {
      if (error instanceof NotFoundException) return { status: 'MISSING', reason: error.message };
      if (error instanceof ConflictException) return { status: 'CHANGED', reason: error.message };
      return { status: 'UNVERIFIABLE', reason: '产物归档无法读取' };
    }
  }

  private async recordCheck(row: Instance, check: Verification, userId?: string) {
    await this.database.db
      .updateTable('artifacts')
      .set({
        verification_status: check.status,
        verification_reason: check.reason?.slice(0, 500) ?? null,
        verified_at: Date.now(),
        verified_by: userId ?? null,
      })
      .where('id', '=', row.id)
      .where('lifecycle_state', '=', 'ACTIVE')
      .execute();
  }

  async deployableIn(
    db: Kysely<Database>,
    runId: string,
    checkArchive = false,
    managedCompose = false,
    rootRunId?: string,
    instanceIds?: readonly string[],
  ) {
    const rows = await db
      .selectFrom('artifacts')
      .selectAll()
      .where('pipeline_run_id', '=', runId)
      .$if(Boolean(instanceIds), (query) => query.where('id', 'in', [...instanceIds!]))
      .where((eb) =>
        eb.or([
          eb('temporary_root_id', 'is', null),
          ...(rootRunId ? [eb('temporary_root_id', '=', rootRunId)] : []),
        ]),
      )
      .orderBy('id')
      .execute();
    const eligible = rows.filter((row) => hasDeployableMetadata(row, managedCompose));
    const available = checkArchive
      ? (
          await Promise.all(
            eligible.map(async (row) => {
              if (!row.physical_json && row.storage_type === 'REGISTRY_IMAGE') return row;
              const check = await this.check(row);
              if (db === this.database.db) await this.recordCheck(row, check);
              return check.status === 'AVAILABLE' ? row : null;
            }),
          )
        ).filter((row) => row !== null)
      : eligible;
    return available.map((row) => ({
      id: row.id,
      serverId: applicationServer(row),
      fingerprint: deploymentFingerprint(row),
      name: row.artifact_name,
      kind: row.artifact_kind ?? row.artifact_type,
    }));
  }

  async managedCompose(snapshot: PipelineSnapshot) {
    if (!snapshot.managedCompose) return undefined;
    return readManagedCompose(
      this.database.db,
      snapshot.serviceId,
      snapshot.environmentId,
      snapshot.managedCompose,
    );
  }

  async forDeployment(
    snapshot: PipelineSnapshot,
    serverId: string,
    target?: SshTarget,
  ): Promise<DeploymentArtifact> {
    const candidates = snapshot.deploymentArtifacts?.filter(
      (artifact) => artifact.serverId === null || artifact.serverId === serverId,
    );
    if (!snapshot.sourceBuildTaskId || candidates?.length !== 1)
      throw new ConflictException('目标必须对应唯一的已归档构建产物');
    const candidate = candidates[0]!;
    const lookup = this.database.db
      .selectFrom('artifacts')
      .innerJoin('pipeline_runs', 'pipeline_runs.id', 'artifacts.pipeline_run_id')
      .innerJoin('tasks', 'tasks.id', 'pipeline_runs.task_id')
      .selectAll('artifacts')
      .select('tasks.payload_json as build_payload')
      .where('artifacts.id', '=', candidate.id)
      .where('pipeline_runs.task_id', '=', snapshot.sourceBuildTaskId)
      .where('tasks.status', 'in', ['SUCCESS', 'PARTIAL_FAILED'])
      .where('pipeline_runs.environment_id', '=', snapshot.environmentId)
      .where('pipeline_runs.commit_sha', '=', snapshot.commitSha)
      .where('artifacts.project_id', '=', snapshot.projectId)
      .where('artifacts.service_id', '=', snapshot.serviceId)
      .where('artifacts.artifact_type', '=', snapshot.definition.artifactType)
      .where('artifacts.source_commit', '=', snapshot.commitSha);
    const row = await (
      snapshot.artifactServiceScope
        ? lookup
            .where('pipeline_runs.project_id', '=', snapshot.projectId)
            .where('pipeline_runs.service_id', '=', snapshot.serviceId)
        : lookup.where('pipeline_runs.pipeline_id', '=', snapshot.pipelineId)
    ).executeTakeFirst();
    if (
      !row ||
      applicationServer(row) !== candidate.serverId ||
      (row.temporary_root_id && row.temporary_root_id !== snapshot.artifactRootRunId) ||
      !hasDeployableMetadata(
        row,
        Boolean(snapshot.managedCompose || snapshot.graphDeployment?.template),
      )
    )
      throw new ConflictException('构建产物不可发布或与当前任务范围不一致');
    if (candidate.fingerprint && candidate.fingerprint !== deploymentFingerprint(row))
      throw new ConflictException('已确认的构建产物校验信息发生变化');
    const physical = physicalOf(row);
    if (physical) {
      const check = await this.check(row, physical.serverId ? target : undefined);
      await this.recordCheck(row, check);
      if (check.status !== 'AVAILABLE')
        throw new ConflictException(check.reason ?? '已确认的产物实物不可用');
    }
    if (row.server_id) {
      const successful = await this.database.db
        .selectFrom('task_targets')
        .select('id')
        .where('task_id', '=', snapshot.sourceBuildTaskId)
        .where('server_id', '=', row.server_id)
        .where('status', '=', 'SUCCESS')
        .executeTakeFirst();
      if (!successful) throw new ConflictException('产物来源目标构建未成功');
    }
    if (
      !snapshot.managedCompose &&
      !snapshot.graphDeployment?.template &&
      row.compose_yaml &&
      checksumOf(row.compose_yaml) !== row.compose_checksum
    )
      throw new ConflictException('Compose 配置未通过完整性校验');
    const key = row.pruned_at === null ? archiveKey(row) : null;
    const registry = row.storage_type === 'REGISTRY_IMAGE';
    const archive = key && !registry ? await this.verifiedArchive(key, row) : undefined;
    const offlineImage =
      registry &&
      key &&
      row.archive_image_id &&
      digest.test(row.archive_image_id) &&
      row.archive_image_platform &&
      imagePlatform.test(row.archive_image_platform) &&
      row.image_tag &&
      registryTag.test(row.image_tag)
        ? {
            reference: `${row.storage_key.slice(0, row.storage_key.indexOf('@'))}:${row.image_tag}`,
            imageId: row.archive_image_id,
            platform: row.archive_image_platform,
            readArchive: () => this.verifiedArchive(key, row),
          }
        : undefined;
    return {
      id: row.id,
      physical,
      ...archive,
      offlineImage,
      composeYaml: row.compose_yaml ?? undefined,
      composeTemplate: archivedComposeTemplate(
        row.build_payload,
        row.artifact_name,
        row.compose_checksum,
      ),
      imageReference: row.artifact_type === 'DOCKER_IMAGE' ? row.storage_key : undefined,
      imageId: isLocalImage(row.storage_type) ? (row.image_digest ?? undefined) : undefined,
    };
  }

  private async verifiedArchive(key: string, row: Selectable<ArtifactsTable>) {
    if (
      !row.checksum ||
      !sha256.test(row.checksum) ||
      !row.size_bytes ||
      !Number.isSafeInteger(row.size_bytes)
    )
      throw new ConflictException('缺少有效的归档校验信息');
    const localArchive = await this.resolveArchive(key);
    const file = await open(localArchive, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)).catch(
      () => null,
    );
    if (!file) throw new NotFoundException('产物归档不存在或无法读取');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== row.size_bytes)
        throw new ConflictException('产物归档大小与记录不一致');
      const hash = createHash('sha256');
      try {
        for await (const chunk of file.createReadStream({ autoClose: false }))
          hash.update(chunk as Buffer);
      } catch {
        throw new ConflictException('产物归档读取失败');
      }
      if (hash.digest('hex') !== row.checksum)
        throw new ConflictException('产物归档未通过完整性校验');
      return { localArchive, checksum: row.checksum };
    } finally {
      await file.close();
    }
  }

  async download(id: string) {
    const row = await this.database.db
      .selectFrom('artifacts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    const key =
      row &&
      row.pruned_at === null &&
      row.lifecycle_state === 'ACTIVE' &&
      row.temporary_root_id === null &&
      archiveKey(row);
    if (!key) throw new NotFoundException('该产物没有可下载的归档');
    const resolved = await this.resolveArchive(key);
    const file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)).catch(
      () => null,
    );
    if (!file) throw new NotFoundException('产物归档不存在');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new NotFoundException('产物归档不存在');
      if (row.size_bytes !== null && stat.size !== row.size_bytes)
        throw new ConflictException('产物归档大小与记录不一致');
      if (row.checksum && sha256.test(row.checksum)) {
        const hash = createHash('sha256');
        for await (const chunk of file.createReadStream({ start: 0, autoClose: false }))
          hash.update(chunk as Buffer);
        if (hash.digest('hex') !== row.checksum)
          throw new ConflictException('产物归档未通过完整性校验');
      }
      const extension = key.endsWith('.tar.gz') ? 'tar.gz' : 'tar';
      const commit = /^[a-f0-9]{40,64}$/i.test(row.source_commit ?? '')
        ? row.source_commit!.slice(0, 12) + '-'
        : '';
      const filename = `veyops-${commit}${id}.${extension}`;
      return {
        file: new StreamableFile(file.createReadStream({ start: 0 }), {
          type: extension === 'tar.gz' ? 'application/gzip' : 'application/x-tar',
          disposition: `attachment; filename="${filename}"`,
          length: stat.size,
        }).setErrorLogger(() => undefined),
        checksum: row.checksum,
      };
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  private async resolveArchive(key: string) {
    const dataRoot = await realpath(dataDirectory).catch(() => null);
    const artifactRoot = dataRoot && join(dataRoot, 'artifacts');
    if (!artifactRoot || (await realpath(artifactRoot).catch(() => null)) !== artifactRoot)
      throw new NotFoundException('产物归档不存在');
    const resolved = await realpath(join(artifactRoot, key)).catch(() => null);
    if (!resolved || dirname(resolved) !== artifactRoot || basename(resolved) !== key)
      throw new NotFoundException('产物归档不存在');
    return resolved;
  }
}
class VerifyArtifactsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  instanceIds?: string[];
}

@Controller('artifacts')
export class ArtifactsController {
  constructor(private readonly service: ArtifactsService) {}
  @Get() list(@Query() filters: ArtifactFilters) {
    return this.service.list(filters.projectId, filters.pipelineRunId, filters);
  }
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }
  @Post(':id/verify')
  @Roles('ADMIN', 'OPERATOR')
  verify(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VerifyArtifactsDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.checkInstances(id, body.instanceIds, req.user.id);
  }
  @Get(':id/download')
  @Header('Cache-Control', 'private, no-store')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { file, checksum } = await this.service.download(id);
    if (checksum && /^[a-f0-9]{64}$/i.test(checksum)) res.setHeader('X-Artifact-SHA256', checksum);
    return file;
  }
}
