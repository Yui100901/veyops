import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { SaveViewDto } from './views.dto';
import { failedDeploymentStatuses, failedHealthStatuses } from '../deployments/deployment-history';
import { type ViewScope, ViewsRepository } from './views.repository';

const presets = [
  { id: 'all', kind: 'ALL', name: '全部项目', description: '' },
  { id: 'production', kind: 'PRODUCTION', name: '生产环境', description: '' },
  { id: 'testing', kind: 'TESTING', name: '测试环境', description: '' },
  { id: 'abnormal', kind: 'ABNORMAL', name: '异常项目', description: '' },
] as const;
type Preset = (typeof presets)[number];

export interface ViewSummary {
  id: string;
  name: string;
  description: string;
  kind: Preset['kind'] | 'CUSTOM';
  isDefault: boolean;
  projectIds: string[];
}

function presetScope(preset: Preset): ViewScope {
  if (preset.kind === 'PRODUCTION' || preset.kind === 'TESTING')
    return { type: 'environment', environmentType: preset.kind };
  return { type: preset.kind === 'ABNORMAL' ? 'abnormal' : 'all' };
}

function deploymentStatus(rows: { status: string; healthStatus: string | null }[]) {
  if (!rows.length) return 'NOT_DEPLOYED';
  if (
    rows.some(
      ({ status, healthStatus }) =>
        failedDeploymentStatuses.includes(status) ||
        failedHealthStatuses.includes(healthStatus ?? ''),
    )
  )
    return 'ABNORMAL';
  if (rows.some(({ status }) => ['PENDING', 'RUNNING', 'CANCEL_REQUESTED'].includes(status)))
    return 'RUNNING';
  return rows.every(
    ({ status, healthStatus }) => status === 'SUCCESS' && healthStatus === 'HEALTHY',
  )
    ? 'HEALTHY'
    : 'UNVERIFIED';
}

function byProject<Row extends { projectId: string }>(rows: Row[]) {
  const grouped = new Map<string, Omit<Row, 'projectId'>[]>();
  for (const { projectId, ...row } of rows) {
    const group = grouped.get(projectId);
    if (group) group.push(row);
    else grouped.set(projectId, [row]);
  }
  return grouped;
}

@Injectable()
export class ViewsService {
  constructor(
    private readonly repository: ViewsRepository,
    private readonly audit: AuditService,
  ) {}

  private async customViews(userId: string, viewId?: string) {
    const rows = await this.repository.customViews(userId, viewId);
    const views = new Map<string, ViewSummary>();
    for (const row of rows) {
      let view = views.get(row.id);
      if (!view) {
        view = {
          id: row.id,
          kind: 'CUSTOM',
          name: row.name,
          description: row.description,
          isDefault: row.isDefault === 1,
          projectIds: [],
        };
        views.set(row.id, view);
      }
      if (row.projectId) view.projectIds.push(row.projectId);
    }
    return [...views.values()];
  }

  async list(userId: string) {
    const [custom, projects] = await Promise.all([
      this.customViews(userId),
      Promise.all(presets.map((preset) => this.repository.presetProjects(presetScope(preset)))),
    ]);
    const defaultViewId = custom.find(({ isDefault }) => isDefault)?.id ?? 'all';
    const views: ViewSummary[] = presets.map((preset, index) => ({
      ...preset,
      isDefault: preset.id === defaultViewId,
      projectIds: projects[index]!.map(({ id }) => id),
    }));
    return {
      views: [
        ...views,
        ...custom.map((view) => ({ ...view, isDefault: view.id === defaultViewId })),
      ],
      defaultViewId,
    };
  }

  async detail(userId: string, id: string) {
    const preset = presets.find((entry) => entry.id === id);
    const scope = preset ? presetScope(preset) : { type: 'custom' as const, viewId: id };
    const custom = preset ? undefined : (await this.customViews(userId, id))[0];
    if (!preset && !custom) throw new NotFoundException('项目视图不存在');
    const [data, defaultViewId] = await Promise.all([
      this.repository.projectDetails(scope),
      this.repository.defaultViewId(userId),
    ]);
    const environments = byProject(data.environments);
    const addresses = byProject(data.addresses);
    const latest = byProject(data.latest);
    const recent = byProject(data.recent);
    const projectsById = new Map(
      data.projects.map(({ id, name, slug, description, status, tags_json }) => [
        id,
        {
          id,
          name,
          slug,
          description,
          status,
          tags: JSON.parse(tags_json) as string[],
          environments: environments.get(id) ?? [],
          addresses: addresses.get(id) ?? [],
          deploymentStatus: deploymentStatus(latest.get(id) ?? []),
          recentDeployments: recent.get(id) ?? [],
        },
      ]),
    );
    const projects = custom
      ? custom.projectIds.flatMap((id) => {
          const project = projectsById.get(id);
          return project ? [project] : [];
        })
      : [...projectsById.values()];
    return {
      ...(preset ?? custom!),
      isDefault: id === defaultViewId,
      projectIds: projects.map((project) => project.id),
      projects,
    };
  }

  async save(userId: string, input: SaveViewDto, viewId?: string) {
    if (viewId && presets.some(({ id }) => id === viewId))
      throw new ForbiddenException('预设视图不可修改');

    const id = viewId ?? randomUUID();
    const result = await this.repository.transaction().execute(async (tx) => {
      await this.repository.lockOwner(tx, userId);
      const previous = viewId
        ? await tx
            .selectFrom('views')
            .select('is_default')
            .where('id', '=', viewId)
            .where('created_by', '=', userId)
            .executeTakeFirst()
        : undefined;
      if (viewId && !previous) throw new NotFoundException('项目视图不存在');
      if (!(await this.repository.validateProjectIds(tx, input.projectIds)))
        throw new BadRequestException('请选择有效且未删除的项目');

      const isDefault = input.isDefault ?? previous?.is_default === 1;
      if (isDefault)
        await tx
          .updateTable('views')
          .set({ is_default: 0 })
          .where('created_by', '=', userId)
          .where('is_default', '=', 1)
          .where('id', '!=', id)
          .execute();
      const values = {
        name: input.name,
        description: input.description ?? '',
        is_default: isDefault ? 1 : 0,
      };
      if (viewId) {
        await tx
          .updateTable('views')
          .set(values)
          .where('id', '=', id)
          .where('created_by', '=', userId)
          .execute();
        await tx.deleteFrom('view_projects').where('view_id', '=', id).execute();
      } else {
        await tx
          .insertInto('views')
          .values({ id, created_by: userId, created_at: Date.now(), ...values })
          .execute();
      }
      if (input.projectIds.length)
        await tx
          .insertInto('view_projects')
          .values(
            input.projectIds.map((projectId, index) => ({
              view_id: id,
              project_id: projectId,
              sort_order: index,
            })),
          )
          .execute();
      return {
        id,
        kind: 'CUSTOM' as const,
        name: values.name,
        description: values.description,
        isDefault,
        projectIds: input.projectIds,
      };
    });
    await this.audit.record(userId, viewId ? 'view.update' : 'view.create', 'view', id, {
      projectCount: result.projectIds.length,
      isDefault: result.isDefault,
    });
    return result;
  }

  async remove(userId: string, viewId: string) {
    if (presets.some(({ id }) => id === viewId)) throw new ForbiddenException('预设视图不可删除');
    await this.repository.transaction().execute(async (tx) => {
      await this.repository.lockOwner(tx, userId);
      const deleted = await tx
        .deleteFrom('views')
        .where('id', '=', viewId)
        .where('created_by', '=', userId)
        .returning('id')
        .executeTakeFirst();
      if (!deleted) throw new NotFoundException('项目视图不存在');
    });
    await this.audit.record(userId, 'view.delete', 'view', viewId);
    return { success: true };
  }
}
