import { Injectable } from '@nestjs/common';
import type { Kysely, SelectQueryBuilder, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { projectAddressLinks } from '../projects/project-card-data';
import {
  deploymentRows,
  failedDeploymentStatuses,
  failedHealthStatuses,
  latestDeploymentTargets,
} from '../deployments/deployment-history';

type EnvironmentType = 'PRODUCTION' | 'TESTING';
type ProjectIds = SelectQueryBuilder<Database, 'projects', { id: string }>;

export type ViewScope =
  | { type: 'all' | 'abnormal' }
  | { type: 'environment'; environmentType: EnvironmentType }
  | { type: 'custom'; viewId: string };

@Injectable()
export class ViewsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  private projectIds(scope: ViewScope): ProjectIds {
    const projects = this.db.selectFrom('projects').select('id').where('deleted_at', 'is', null);
    if (scope.type === 'custom')
      return projects.where(
        'id',
        'in',
        this.db
          .selectFrom('view_projects')
          .select('project_id')
          .where('view_id', '=', scope.viewId),
      );
    if (scope.type === 'environment')
      return projects.where(
        'id',
        'in',
        this.db
          .selectFrom('environments')
          .select('project_id')
          .where('environment_type', '=', scope.environmentType),
      );
    if (scope.type === 'abnormal') {
      const unhealthy = this.db
        .selectFrom(latestDeploymentTargets(this.db, projects).as('latest'))
        .select('projectId')
        .where('targetRank', '=', 1)
        .where((eb) =>
          eb.or([
            eb('status', 'in', failedDeploymentStatuses),
            eb('healthStatus', 'in', failedHealthStatuses),
          ]),
        );
      return projects.where('id', 'in', unhealthy);
    }
    return projects;
  }

  async presetProjects(scope: ViewScope) {
    return this.projectIds(scope).orderBy('name').orderBy('id').execute();
  }

  customViews(userId: string, id?: string) {
    let query = this.db
      .selectFrom('views as view')
      .leftJoin('view_projects as member', 'member.view_id', 'view.id')
      .leftJoin('projects as project', (join) =>
        join.onRef('project.id', '=', 'member.project_id').on('project.deleted_at', 'is', null),
      )
      .select([
        'view.id as id',
        'view.name as name',
        'view.description as description',
        'view.is_default as isDefault',
        'project.id as projectId',
      ])
      .where('view.created_by', '=', userId);
    if (id) query = query.where('view.id', '=', id);
    return query
      .orderBy('view.created_at', 'desc')
      .orderBy('view.id')
      .orderBy('member.sort_order')
      .orderBy('member.project_id')
      .execute();
  }

  async defaultViewId(userId: string) {
    const row = await this.db
      .selectFrom('views')
      .select('id')
      .where('created_by', '=', userId)
      .where('is_default', '=', 1)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .executeTakeFirst();
    return row?.id ?? 'all';
  }

  async projectDetails(scope: ViewScope) {
    const projectIds = this.projectIds(scope);
    const environmentType = scope.type === 'environment' ? scope.environmentType : undefined;
    let environments = this.db
      .selectFrom('environments')
      .select(['id', 'name', 'project_id as projectId', 'environment_type as environmentType'])
      .where('project_id', 'in', projectIds);
    if (environmentType)
      environments = environments.where('environment_type', '=', environmentType);

    let addresses = projectAddressLinks(this.db).where('address.project_id', 'in', projectIds);
    if (environmentType)
      addresses = addresses.where((eb) =>
        eb.or([
          eb('address.environment_id', 'is', null),
          eb('address.environment_id', 'in', environments.clearSelect().select('id')),
        ]),
      );

    const rankedRecent = deploymentRows(this.db, projectIds, environmentType)
      .innerJoin('services as service', 'service.id', 'deployment.service_id')
      .leftJoin('servers as server', 'server.id', 'deployment.server_id')
      .select([
        'run.project_id as projectId',
        'run.task_id as taskId',
        'deployment.id as id',
        'deployment.service_id as serviceId',
        'deployment.environment_id as environmentId',
        'deployment.server_id as serverId',
        'deployment.status as status',
        'deployment.health_status as healthStatus',
        'deployment.release_version as releaseVersion',
        'deployment.started_at as startedAt',
        'deployment.finished_at as finishedAt',
        'service.name as serviceName',
        'environment.name as environmentName',
        'server.name as serverName',
      ])
      .select((eb) =>
        eb.fn
          .agg<number>('row_number', [])
          .over((window) =>
            window
              .partitionBy('run.project_id')
              .orderBy(eb.fn.coalesce('deployment.started_at', 'run.created_at'), 'desc')
              .orderBy('run.created_at', 'desc')
              .orderBy('deployment.id', 'desc'),
          )
          .as('recentRank'),
      );

    const [projects, environmentRows, addressRows, latest, recent] = await Promise.all([
      projectIds
        .select(['name', 'slug', 'description', 'status', 'tags_json'])
        .orderBy('name')
        .orderBy('id')
        .execute(),
      environments.orderBy('name').orderBy('id').execute(),
      addresses.orderBy('address.name').orderBy('address.id').execute(),
      this.db
        .selectFrom(latestDeploymentTargets(this.db, projectIds, { environmentType }).as('latest'))
        .select(['projectId', 'status', 'healthStatus'])
        .where('targetRank', '=', 1)
        .execute(),
      this.db
        .selectFrom(rankedRecent.as('recent'))
        .select([
          'projectId',
          'taskId',
          'id',
          'serviceId',
          'environmentId',
          'serverId',
          'status',
          'healthStatus',
          'releaseVersion',
          'startedAt',
          'finishedAt',
          'serviceName',
          'environmentName',
          'serverName',
        ])
        .where('recentRank', '<=', 3)
        .orderBy('recentRank')
        .execute(),
    ]);
    return { projects, environments: environmentRows, addresses: addressRows, latest, recent };
  }

  transaction() {
    return this.db.transaction();
  }

  async lockOwner(tx: Transaction<Database>, userId: string) {
    // Taking a write lock on the same owner serializes default changes across both adapters.
    await tx
      .updateTable('users')
      .set((eb) => ({ updated_at: eb.ref('updated_at') }))
      .where('id', '=', userId)
      .execute();
  }

  async validateProjectIds(db: Kysely<Database>, projectIds: string[]) {
    if (!projectIds.length) return true;
    const projects = await db
      .selectFrom('projects')
      .select('id')
      .where('id', 'in', projectIds)
      .where('deleted_at', 'is', null)
      .execute();
    return projects.length === projectIds.length;
  }
}
