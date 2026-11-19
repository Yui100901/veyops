import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Req } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { appVersion } from '../../core/version';
import { Public, Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import {
  serviceDeploymentCounts,
  workspaceRecentDeployments,
} from '../deployments/deployment-history';
import { taskDto } from '../tasks/tasks.service';
import { failedTaskStatuses } from '../tasks/tasks.types';
import {
  SystemSettingsModule,
  SystemSettingsService,
  UpdateSystemSettingsDto,
  UpdateProjectSettingsDto,
} from './system-settings.service';

@Controller()
class SystemController {
  constructor(
    private readonly database: DatabaseService,
    private readonly settings: SystemSettingsService,
  ) {}
  @Public() @Get('health') health() {
    return { status: 'ok', version: appVersion };
  }
  @Get('system') async system() {
    return {
      version: appVersion,
      database: this.database.client,
      workerEnabled: process.env.WORKER_ENABLED !== 'false',
      ...(await this.settings.get()),
      defaultAiPermission: 'CONFIRM',
      stage: 'Pipeline、构建部署与可选 AI',
      features: {
        authentication: true,
        credentials: true,
        ssh: true,
        commands: true,
        operationPlans: true,
        projects: true,
        views: true,
        pipelines: true,
        deployments: true,
        ai: true,
        backups: true,
      },
    };
  }
  @Roles('ADMIN') @Patch('system') update(
    @Body() input: UpdateSystemSettingsDto,
    @Req() req: AuthRequest,
  ) {
    return this.settings.update(input, req.user.id);
  }
  @Get('projects/:id/execution-settings') projectSettings(@Param('id', ParseUUIDPipe) id: string) {
    return this.settings.project(id);
  }
  @Roles('ADMIN') @Patch('projects/:id/execution-settings') updateProjectSettings(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateProjectSettingsDto,
    @Req() req: AuthRequest,
  ) {
    return this.settings.updateProject(id, input, req.user.id);
  }
  @Get('dashboard') async dashboard() {
    const db = this.database.db;
    const limit = 6;
    const liveProjects = db.selectFrom('projects').where('deleted_at', 'is', null).select('id');
    const recentTasks = db
      .selectFrom('tasks')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit);
    const [servers, projects, tasks, services, deployments, recent, failures] = await Promise.all([
      db
        .selectFrom('servers')
        .where('is_active', '=', 1)
        .select(({ fn }) => [
          fn.countAll<number>().as('total'),
          fn.countAll<number>().filterWhere('status', '=', 'ONLINE').as('online'),
          fn.countAll<number>().filterWhere('status', '=', 'OFFLINE').as('offline'),
          fn.countAll<number>().filterWhere('status', '=', 'UNKNOWN').as('unknown'),
        ])
        .executeTakeFirstOrThrow(),
      db
        .selectFrom(liveProjects.as('liveProjects'))
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('tasks')
        .select(({ fn }) => [
          fn.countAll<number>().as('total'),
          fn
            .countAll<number>()
            .filterWhere('status', 'in', ['PENDING', 'RUNNING', 'CANCEL_REQUESTED'])
            .as('active'),
        ])
        .executeTakeFirstOrThrow(),
      serviceDeploymentCounts(db, liveProjects),
      workspaceRecentDeployments(db, liveProjects, limit),
      recentTasks.execute(),
      recentTasks.where('status', 'in', failedTaskStatuses).execute(),
    ]);
    return {
      servers: {
        total: Number(servers.total),
        online: Number(servers.online),
        offline: Number(servers.offline),
        unknown: Number(servers.unknown),
      },
      projects: Number(projects.count),
      services,
      totalTasks: Number(tasks.total),
      activeTasks: Number(tasks.active),
      recentDeployments: deployments,
      recentTasks: recent.map(taskDto),
      recentFailedTasks: failures.map(taskDto),
    };
  }
}
@Module({ imports: [SystemSettingsModule], controllers: [SystemController] })
export class SystemModule {}
