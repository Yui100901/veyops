import { ConflictException } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../core/database/schema';
import { graphRepositoryMatches } from './graph-repository-selectors';
import { graphRepositoryUrl } from './http-clone-url';
import {
  projectResourceReferences,
  type ProjectResourceReference,
  type ProjectResourceType,
} from './project-resource-references';

type Resource = Pick<ProjectResourceReference, 'resourceType' | 'resourceId'>;

const resourceLabels: Record<ProjectResourceType, string> = {
  SERVER: '服务器',
  SERVER_GROUP: '服务器分组',
  REPOSITORY: '仓库',
  SERVICE: '服务',
  ENVIRONMENT: '环境',
  ENVIRONMENT_SET: '环境变量集合',
  CREDENTIAL: '凭据',
  REGISTRY: '镜像仓库',
  LEGACY_TARGET: '部署目标',
  ARTIFACT: '产物',
};

export class ResourceReferenceConflict extends ConflictException {
  constructor(
    resource: Resource,
    references: (ProjectResourceReference & { projectId: string })[],
  ) {
    const sources = [
      ...new Set(
        references.map(
          (reference) =>
            `「${reference.label ?? reference.sourceId}」${reference.version ? `（版本 ${reference.version}）` : ''}`,
        ),
      ),
    ];
    const displayed = sources.slice(0, 3).join('、') + (sources.length > 3 ? '等' : '');
    super({
      message: `${resourceLabels[resource.resourceType]}仍被${displayed}引用。请先替换或停用对应配置、版本或任务计划。`,
      references,
    });
  }
}

/** Caller holds the project graph lock from before the first resource read until commit. */
export async function assertProjectResourceRemovable(
  tx: Transaction<Database>,
  resource: Resource,
  projectId?: string,
) {
  const projects = await tx
    .selectFrom('projects')
    .select(['id', 'deleted_at'])
    .$if(Boolean(projectId), (query) => query.where('id', '=', projectId!))
    .orderBy('id')
    .execute();
  const blocked: (ProjectResourceReference & { projectId: string })[] = [];
  for (const project of projects) {
    const references = await projectResourceReferences(tx, project.id, {
      ...resource,
      states: project.deleted_at === null ? ['CONFIGURED', 'RUNNABLE', 'PENDING'] : ['PENDING'],
    });
    for (const reference of references) {
      // Removing a service/environment removes its own editable settings. A graph, task or
      // other live configuration consuming that owner still prevents removal.
      if (
        reference.sourceKind === 'SERVICE_ENVIRONMENT' &&
        ((resource.resourceType === 'SERVICE' && reference.serviceId === resource.resourceId) ||
          (resource.resourceType === 'ENVIRONMENT' &&
            reference.environmentId === resource.resourceId))
      )
        continue;
      if (
        reference.sourceKind === 'ENVIRONMENT_DEFAULT' &&
        resource.resourceType === 'ENVIRONMENT' &&
        reference.environmentId === resource.resourceId
      )
        continue;
      if (
        reference.sourceKind === 'SERVICE_REPOSITORY' &&
        resource.resourceType === 'SERVICE' &&
        reference.serviceId === resource.resourceId
      )
        continue;
      blocked.push({ ...reference, projectId: project.id });
      if (blocked.length === 20) throw new ResourceReferenceConflict(resource, blocked);
    }
  }
  if (blocked.length) throw new ResourceReferenceConflict(resource, blocked);
}

async function availableIds(
  db: Kysely<Database>,
  projectId: string,
  type: ProjectResourceType,
  ids: string[],
) {
  switch (type) {
    case 'REPOSITORY': {
      const selectors = new Map(ids.map((id) => [id, graphRepositoryUrl(id)]));
      const directIds = ids.filter((id) => !selectors.get(id));
      const [direct, addressed] = await Promise.all([
        directIds.length
          ? db
              .selectFrom('repositories')
              .select('id')
              .where('project_id', '=', projectId)
              .where('archived_at', 'is', null)
              .where('id', 'in', directIds)
              .execute()
          : [],
        graphRepositoryMatches(
          db,
          projectId,
          [...selectors.values()].filter((url): url is string => url !== undefined),
        ),
      ]);
      return [
        ...direct,
        ...[...selectors].flatMap(([id, url]) =>
          url && addressed.get(url)?.length === 1 ? [{ id }] : [],
        ),
      ];
    }
    case 'SERVICE':
    case 'ENVIRONMENT':
    case 'ENVIRONMENT_SET': {
      const table = {
        SERVICE: 'services',
        ENVIRONMENT: 'environments',
        ENVIRONMENT_SET: 'project_environment_sets',
      }[type] as 'services' | 'environments' | 'project_environment_sets';
      return db
        .selectFrom(table)
        .select('id')
        .where('project_id', '=', projectId)
        .where('archived_at', 'is', null)
        .where('id', 'in', ids)
        .execute();
    }
    case 'SERVER':
      return db
        .selectFrom('servers')
        .select('id')
        .where('is_active', '=', 1)
        .where('id', 'in', ids)
        .execute();
    case 'SERVER_GROUP':
      return db.selectFrom('server_groups').select('id').where('id', 'in', ids).execute();
    case 'CREDENTIAL':
      return db
        .selectFrom('credentials')
        .select('id')
        .where('status', '=', 'ACTIVE')
        .where('id', 'in', ids)
        .execute();
    case 'REGISTRY':
      return db.selectFrom('registries').select('id').where('id', 'in', ids).execute();
    case 'LEGACY_TARGET':
      return db.selectFrom('deployment_targets').select('id').where('id', 'in', ids).execute();
    case 'ARTIFACT':
      return db
        .selectFrom('artifacts')
        .select(['id', 'logical_artifact_id as logicalId'])
        .where('project_id', '=', projectId)
        .where('lifecycle_state', '=', 'ACTIVE')
        .where('temporary_root_id', 'is', null)
        .where('pruned_at', 'is', null)
        .where('archive_deleted_at', 'is', null)
        .where((eb) => eb.or([eb('id', 'in', ids), eb('logical_artifact_id', 'in', ids)]))
        .execute()
        .then((rows) =>
          rows.flatMap((row) =>
            row.logicalId ? [{ id: row.id }, { id: row.logicalId }] : [{ id: row.id }],
          ),
        );
  }
}

export async function unavailableReference<T extends Resource>(
  db: Kysely<Database>,
  projectId: string,
  references: T[],
) {
  const layers = new Map<ProjectResourceType, Map<string, T>>();
  for (const reference of references) {
    const layer = layers.get(reference.resourceType) ?? new Map<string, T>();
    layer.set(reference.resourceId, reference);
    layers.set(reference.resourceType, layer);
  }
  for (const [type, layer] of layers) {
    const ids = [...layer.keys()];
    // Keep a single query comfortably below the default SQLite bind limit.
    for (let offset = 0; offset < ids.length; offset += 500) {
      const part = ids.slice(offset, offset + 500);
      const active = new Set((await availableIds(db, projectId, type, part)).map((row) => row.id));
      const missing = part.find((id) => !active.has(id));
      if (missing) return layer.get(missing);
    }
  }
}
