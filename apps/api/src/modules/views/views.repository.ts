import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Kysely, SelectQueryBuilder, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { projectAddressLinks } from '../projects/project-card-data';
import { targetProjectReferences } from '../projects/project-resource-references';
import {
  deploymentRows,
  failedDeploymentStatuses,
  failedHealthStatuses,
  latestDeploymentTargets,
} from '../deployments/deployment-history';

type ProjectIds = SelectQueryBuilder<Database, 'projects', { id: string }>;

export type ViewScope =
  | { type: 'all' | 'abnormal' }
  | { type: 'custom'; viewId: string };

export interface ViewSelection {
  serviceId?: string;
  serverId?: string;
  groupId?: string;
}

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
    if (scope.type === 'abnormal') {
      const unhealthy = this.db
        .selectFrom(latestDeploymentTargets(this.db, projects, { byActualTarget: true }).as('latest'))
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

  private async resolveTargetSelection({ serverId, groupId }: ViewSelection) {
    if (serverId && groupId) throw new BadRequestException('请选择一台服务器或一个分组');
    if (serverId) {
      const server = await this.db.selectFrom('servers').select('id').where('id', '=', serverId).executeTakeFirst();
      if (!server) throw new NotFoundException('服务器不存在');
      const projects = await targetProjectReferences(this.db, 'SERVER', serverId);
      return { serverIds: [serverId], projectIds: projects.map(({ id }) => id) };
    }
    if (!groupId) return undefined;
    const group = await this.db.selectFrom('server_groups').select('id').where('id', '=', groupId).executeTakeFirst();
    if (!group) throw new NotFoundException('服务器分组不存在');
    const [members, projects] = await Promise.all([
      this.db.selectFrom('server_group_members as member')
        .innerJoin('servers as server', 'server.id', 'member.server_id')
        .select('member.server_id as id')
        .where('member.group_id', '=', groupId)
        .where('server.is_active', '=', 1)
        .execute(),
      targetProjectReferences(this.db, 'SERVER_GROUP', groupId),
    ]);
    return { serverIds: members.map(({ id }) => id), projectIds: projects.map(({ id }) => id) };
  }

  async projectDetails(scope: ViewScope, selection: ViewSelection = {}) {
    let projectIds = this.projectIds(scope);
    const { serviceId } = selection;
    const target = await this.resolveTargetSelection(selection);
    if (serviceId) {
      projectIds = projectIds.where('id', 'in', this.db.selectFrom('services')
        .select('project_id').where('id', '=', serviceId).where('archived_at', 'is', null));
    }
    const actualSelection = { serviceId, serverIds: target?.serverIds };
    if (target) {
      const deployed = deploymentRows(this.db, projectIds, undefined, actualSelection)
        .select('run.project_id');
      projectIds = projectIds.where((eb) => eb.or([
        eb('id', 'in', deployed),
        ...(target.projectIds.length ? [eb('id', 'in', target.projectIds)] : []),
      ]));
    }
    let addresses = projectAddressLinks(this.db).where('service.project_id', 'in', projectIds);
    if (serviceId) addresses = addresses.where('service.id', '=', serviceId);
    const services = this.db.selectFrom('services')
      .select(['id', 'name', 'project_id as projectId'])
      .where('archived_at', 'is', null)
      .where('project_id', 'in', projectIds)
      .orderBy('name').orderBy('id');

    const rankedRecent = deploymentRows(this.db, projectIds, undefined, actualSelection)
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

    const [projects, addressRows, serviceRows, latest, recent] = await Promise.all([
      projectIds
        .select(['name', 'slug', 'description', 'status', 'tags_json'])
        .orderBy('name')
        .orderBy('id')
        .execute(),
      addresses.execute(),
      services.execute(),
      this.db
        .selectFrom(latestDeploymentTargets(this.db, projectIds, {
          ...actualSelection,
          byActualTarget: true,
        }).as('latest'))
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
    return { projects, addresses: addressRows, services: serviceRows, latest, recent };
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
