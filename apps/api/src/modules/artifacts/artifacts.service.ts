import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../core/database/database.service';
import type { PipelineSnapshot, PipelineArtifact } from '../pipelines/pipeline.types';

@Injectable()
export class ArtifactsService {
  constructor(private readonly database: DatabaseService) {}
  async create(snapshot: PipelineSnapshot, artifact: Omit<PipelineArtifact, 'id'>) {
    const id = randomUUID(); const d = snapshot.definition;
    await this.database.db.insertInto('artifacts').values({ id, project_id: snapshot.projectId, service_id: snapshot.serviceId, pipeline_run_id: snapshot.runId, artifact_type: d.artifactType,
      storage_type: d.artifactType === 'DOCKER_IMAGE' ? 'REGISTRY_IMAGE' : artifact.serverId ? 'REMOTE_FILE' : 'LOCAL_FILE', storage_key: artifact.storageKey,
      server_id: artifact.serverId ?? null, registry_id: d.registryId ?? null, image_repository: d.imageRepository ?? null,
      image_tag: d.artifactType === 'DOCKER_IMAGE' ? snapshot.commitSha : null, image_digest: artifact.imageDigest ?? null,
      checksum: artifact.checksum ?? null, size_bytes: artifact.sizeBytes ?? null, source_commit: snapshot.commitSha, created_at: Date.now() }).execute();
    return { ...artifact, id };
  }
  async list(projectId?: string) {
    let q = this.database.db.selectFrom('artifacts').selectAll();
    if (projectId) q = q.where('project_id', '=', projectId);
    return (await q.orderBy('created_at', 'desc').limit(200).execute()).map(r => ({ id:r.id,projectId:r.project_id,serviceId:r.service_id,pipelineRunId:r.pipeline_run_id,artifactType:r.artifact_type,storageType:r.storage_type,storageKey:r.storage_key,serverId:r.server_id,imageRepository:r.image_repository,imageTag:r.image_tag,imageDigest:r.image_digest,checksum:r.checksum,sizeBytes:r.size_bytes,sourceCommit:r.source_commit,createdAt:r.created_at }));
  }
}
@Controller('artifacts')
export class ArtifactsController { constructor(private readonly service:ArtifactsService){} @Get() list(@Query('projectId') projectId?:string){return this.service.list(projectId);} }
