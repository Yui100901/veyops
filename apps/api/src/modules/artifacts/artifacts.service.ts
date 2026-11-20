import {
  ConflictException,
  Controller,
  Get,
  Header,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Response } from 'express';
import { dataDirectory } from '../../core/config';
import { DatabaseService } from '../../core/database/database.service';
import type { ArtifactsTable, Database } from '../../core/database/schema';
import type { Kysely, Selectable } from 'kysely';
import type { PipelineSnapshot, PipelineArtifact } from '../pipelines/pipeline.types';
import type { TaskPayload } from '../tasks/tasks.types';
import { storedDeploymentSelection } from '../deployment-targets/deployment-selection';
import { archiveKey, isLocalImage } from './artifact-availability';
import { DeliveryRecordFilters } from '../projects/delivery-filters';

const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const sha256 = /^[a-f0-9]{64}$/;

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
const digest = /^sha256:[a-f0-9]{64}$/;
const registryReference = /^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$/;
const registryTag = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/;
const imagePlatform = /^[a-z0-9]+\/[a-z0-9]+$/;
const localImageReference = new RegExp(
  `^veyops-build/${uuid}(?:/${uuid})?:[a-f0-9]{40,64}-${uuid}$`,
);
export const maxComposeBytes = 256 * 1024;

export interface DeploymentArtifact {
  id: string;
  localArchive?: string;
  checksum?: string;
  imageReference?: string;
  imageId?: string;
  composeYaml?: string;
  offlineImage?: {
    reference: string;
    imageId: string;
    platform: string;
    readArchive: () => Promise<{ localArchive: string; checksum: string }>;
  };
}

function hasDeployableMetadata(row: Selectable<ArtifactsTable>) {
  if (row.pruned_at !== null && row.storage_type !== 'REGISTRY_IMAGE') return false;
  const hasArchive = Boolean(
    archiveKey(row) &&
    row.checksum &&
    sha256.test(row.checksum) &&
    row.size_bytes !== null &&
    Number.isSafeInteger(row.size_bytes) &&
    row.size_bytes > 0,
  );
  if (row.artifact_type === 'FILE') return hasArchive && row.storage_type === 'LOCAL_FILE';
  if (
    row.artifact_type !== 'DOCKER_IMAGE' ||
    !row.compose_yaml ||
    Buffer.byteLength(row.compose_yaml) > maxComposeBytes ||
    !row.compose_checksum ||
    !sha256.test(row.compose_checksum) ||
    !row.image_digest ||
    !digest.test(row.image_digest)
  )
    return false;
  if (row.storage_type === 'REGISTRY_IMAGE')
    return (
      registryReference.test(row.storage_key) && row.storage_key.endsWith(`@${row.image_digest}`)
    );
  return hasArchive && isLocalImage(row.storage_type) && localImageReference.test(row.storage_key);
}

function checksumOf(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

function deploymentFingerprint(row: Selectable<ArtifactsTable>) {
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
    ]),
  );
}

@Injectable()
export class ArtifactsService {
  constructor(private readonly database: DatabaseService) {}
  async create(snapshot: PipelineSnapshot, artifact: Omit<PipelineArtifact, 'id'>) {
    const id = randomUUID();
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
    await this.database.db
      .insertInto('artifacts')
      .values({
        id,
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
        compose_checksum: artifact.composeYaml ? checksumOf(artifact.composeYaml) : null,
        checksum: artifact.checksum ?? null,
        size_bytes: artifact.sizeBytes ?? null,
        source_commit: snapshot.commitSha,
        created_at: Date.now(),
      })
      .execute();
    return { ...artifact, id };
  }
  async list(projectId?: string, pipelineRunId?: string, filters: DeliveryRecordFilters = {}) {
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
        'node.name as graphNodeName',
      ]);
    if (projectId) query = query.where('artifacts.project_id', '=', projectId);
    if (pipelineRunId) query = query.where('artifacts.pipeline_run_id', '=', pipelineRunId);
    if (filters.taskId) query = query.where('pipeline_runs.task_id', '=', filters.taskId);
    if (filters.recordId) query = query.where('artifacts.id', '=', filters.recordId);
    if (filters.serviceId) query = query.where('artifacts.service_id', '=', filters.serviceId);
    if (filters.environmentId)
      query = query.where('pipeline_runs.environment_id', '=', filters.environmentId);
    if (filters.commit)
      query = query.where('artifacts.source_commit', 'like', filters.commit.toLowerCase() + '%');
    return (await query.orderBy('artifacts.created_at', 'desc').limit(200).execute()).map((r) => ({
      id: r.id,
      projectId: r.project_id,
      serviceId: r.service_id,
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
        hasDeployableMetadata(r),
      artifactType: r.artifact_type,
      name: r.artifact_name,
      kind: r.artifact_kind ?? r.artifact_type,
      graphRunId: r.graph_run_id,
      graphNodeRunId: r.graph_node_run_id,
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
      createdAt: r.created_at,
    }));
  }

  async deployableIn(db: Kysely<Database>, runId: string, checkArchive = false) {
    const rows = await db
      .selectFrom('artifacts')
      .selectAll()
      .where('pipeline_run_id', '=', runId)
      .orderBy('id')
      .execute();
    const eligible = rows.filter(hasDeployableMetadata);
    const available = checkArchive
      ? (
          await Promise.all(
            eligible.map(async (row) => ((await this.archiveAvailable(row)) ? row : null)),
          )
        ).filter((row) => row !== null)
      : eligible;
    return available.map((row) => ({
      id: row.id,
      serverId: row.server_id,
      fingerprint: deploymentFingerprint(row),
      name: row.artifact_name,
      kind: row.artifact_kind ?? row.artifact_type,
    }));
  }

  private async archiveAvailable(row: Selectable<ArtifactsTable>) {
    if (row.storage_type === 'REGISTRY_IMAGE') return true;
    const key = archiveKey(row);
    if (!key) return false;
    const archive = await this.resolveArchive(key).catch(() => null);
    const stat = archive ? await lstat(archive).catch(() => null) : null;
    return Boolean(stat?.isFile() && stat.size === row.size_bytes);
  }

  async forDeployment(snapshot: PipelineSnapshot, serverId: string): Promise<DeploymentArtifact> {
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
    if (!row || row.server_id !== candidate.serverId || !hasDeployableMetadata(row))
      throw new ConflictException('构建产物不可发布或与当前任务范围不一致');
    if (candidate.fingerprint && candidate.fingerprint !== deploymentFingerprint(row))
      throw new ConflictException('已确认的构建产物校验信息发生变化');
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
    if (row.compose_yaml && checksumOf(row.compose_yaml) !== row.compose_checksum)
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
      ...archive,
      offlineImage,
      composeYaml: row.compose_yaml ?? undefined,
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
    const key = row && row.pruned_at === null && archiveKey(row);
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
      const extension = key.endsWith('.tar.gz') ? 'tar.gz' : 'tar';
      const commit = /^[a-f0-9]{40,64}$/i.test(row.source_commit ?? '')
        ? row.source_commit!.slice(0, 12) + '-'
        : '';
      const filename = `veyops-${commit}${id}.${extension}`;
      return {
        file: new StreamableFile(file.createReadStream(), {
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
@Controller('artifacts')
export class ArtifactsController {
  constructor(private readonly service: ArtifactsService) {}
  @Get() list(@Query() filters: DeliveryRecordFilters) {
    return this.service.list(filters.projectId, filters.pipelineRunId, filters);
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
