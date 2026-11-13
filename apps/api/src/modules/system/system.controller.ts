import { Controller, Get, Module } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { ServersService } from '../servers/servers.service';
import { ProjectsService } from '../projects/projects.service';
import { TasksService } from '../tasks/tasks.service';
import { Public } from '../auth/auth.decorators';

@Controller()
class SystemController {
  constructor(
    private readonly database: DatabaseService,
    private readonly servers: ServersService,
    private readonly projects: ProjectsService,
    private readonly tasks: TasksService,
  ) {}
  @Public() @Get('health') health() {
    return { status: 'ok', version: '0.2.0' };
  }
  @Get('system') system() {
    return {
      version: '0.2.0',
      database: this.database.client,
      workerEnabled: process.env.WORKER_ENABLED !== 'false',
      defaultBuildLocation: 'TARGET',
      defaultMaxParallelTargets: 3,
      defaultAiPermission: 'CONFIRM',
      stage: 'Pipeline、构建部署与可选 AI',
      features: {
        authentication: true,
        credentials: true,
        ssh: true,
        commands: true,
        operationPlans: true,
        projects: true,
        pipelines: true,
        deployments: true,
        ai: true,
        backups: false,
      },
    };
  }
  @Get('dashboard') async dashboard() {
    const [servers, projects, tasks, total, active] = await Promise.all([
      this.servers.list(),
      this.projects.list(),
      this.tasks.list(),
      this.database.db
        .selectFrom('tasks')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
      this.database.db
        .selectFrom('tasks')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('status', 'in', ['PENDING', 'RUNNING', 'CANCEL_REQUESTED'])
        .executeTakeFirstOrThrow(),
    ]);
    return {
      servers: {
        total: servers.length,
        online: servers.filter((s) => s.status === 'ONLINE').length,
        offline: servers.filter((s) => s.status === 'OFFLINE').length,
        unknown: servers.filter((s) => s.status === 'UNKNOWN').length,
      },
      projects: projects.length,
      totalTasks: Number(total.count),
      activeTasks: Number(active.count),
      recentTasks: tasks.slice(0, 6),
    };
  }
}
@Module({ controllers: [SystemController] })
export class SystemModule {}
