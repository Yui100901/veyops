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
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Response } from 'express';
import { dataDirectory } from '../../core/config';
import { DatabaseService } from '../../core/database/database.service';
import type { ArtifactsTable } from '../../core/database/schema';
import type { Selectable } from 'kysely';
import type { PipelineSnapshot, PipelineArtifact } from '../pipelines/pipeline.types';

const isLocalImage = (storageType: string) =>
  storageType === 'LOCAL_IMAGE' || storageType === 'REMOTE_IMAGE';

const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const archiveName = new RegExp(`^${uuid}(?:-${uuid})?\\.(?:tar|tar\\.gz)$`, 'i');

function downloadKey(row: Selectable<ArtifactsTable>) {
  if (row.archive_key && isLocalImage(row.storage_type) && archiveName.test(row.archive_key))
    return row.archive_key;
  if (row.storage_type !== 'LOCAL_FILE') return null;
  // Legacy records saved the absolute local path. Only use the generated filename in this instance's data directory.
  const key = row.storage_key.split(/[\\/]/).at(-1) ?? '';
  return archiveName.test(key) && key.endsWith('.tar.gz') ? key : null;
}

@Injectable()
export class ArtifactsService {
  constructor(private readonly database: DatabaseService) {}
  async create(snapshot: PipelineSnapshot, artifact: Omit<PipelineArtifact, 'id'>) {
    const id = randomUUID();
    const d = snapshot.definition;
    const storageType =
      artifact.storageType ??
      (d.artifactType === 'DOCKER_IMAGE'
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
        artifact_type: d.artifactType,
        storage_type: storageType,
        storage_key: artifact.storageKey,
        archive_key: artifact.archiveKey ?? null,
        server_id: artifact.serverId ?? null,
        registry_id: storageType === 'REGISTRY_IMAGE' ? (d.registryId ?? null) : null,
        image_repository: localImage
          ? artifact.imageReference!.slice(0, imageTagPosition)
          : (d.imageRepository ?? null),
        image_tag: localImage
          ? artifact.imageReference!.slice(imageTagPosition + 1)
          : (artifact.imageTag ?? null),
        image_digest: artifact.imageId ?? artifact.imageDigest ?? null,
        checksum: artifact.checksum ?? null,
        size_bytes: artifact.sizeBytes ?? null,
        source_commit: snapshot.commitSha,
        created_at: Date.now(),
      })
      .execute();
    return { ...artifact, id };
  }
  async list(projectId?: string, pipelineRunId?: string) {
    let q = this.database.db.selectFrom('artifacts').selectAll();
    if (projectId) q = q.where('project_id', '=', projectId);
    if (pipelineRunId) q = q.where('pipeline_run_id', '=', pipelineRunId);
    return (await q.orderBy('created_at', 'desc').limit(200).execute()).map((r) => ({
      id: r.id,
      projectId: r.project_id,
      serviceId: r.service_id,
      pipelineRunId: r.pipeline_run_id,
      artifactType: r.artifact_type,
      storageType: r.storage_type,
      storageKey: r.storage_key,
      downloadAvailable: Boolean(downloadKey(r)),
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

  async download(id: string) {
    const row = await this.database.db
      .selectFrom('artifacts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    const key = row && downloadKey(row);
    if (!key) throw new NotFoundException('该产物没有可下载的归档');
    const dataRoot = await realpath(dataDirectory).catch(() => null);
    const artifactRoot = dataRoot && join(dataRoot, 'artifacts');
    if (!artifactRoot || (await realpath(artifactRoot).catch(() => null)) !== artifactRoot)
      throw new NotFoundException('产物归档不存在');
    const path = join(artifactRoot, key);
    const resolved = await realpath(path).catch(() => null);
    if (!resolved || dirname(resolved) !== artifactRoot || basename(resolved) !== key)
      throw new NotFoundException('产物归档不存在');
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
}
@Controller('artifacts')
export class ArtifactsController {
  constructor(private readonly service: ArtifactsService) {}
  @Get() list(@Query('projectId') projectId?: string, @Query('pipelineRunId') runId?: string) {
    return this.service.list(projectId, runId);
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
