import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './core/database/database.service';
import { ExecutionGraphsModule } from './modules/execution-graphs/execution-graphs.module';
import { AuditModule } from './modules/audit/audit.service';
import { AuthModule } from './modules/auth/auth.module';
import { AuthGuard } from './modules/auth/auth.guard';
import { CredentialsModule } from './modules/credentials/credentials.service';
import { ServersModule } from './modules/servers/servers.service';
import { ServerGroupsModule } from './modules/servers/server-groups';
import { ProjectsModule } from './modules/projects/projects.service';
import { EnvironmentSetsModule } from './modules/projects/environment-sets.service';
import { SshModule } from './infrastructure/ssh/ssh.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { CommandCenterModule } from './modules/command-center/command-center.module';
import { OperationPlansModule } from './modules/operation-plans/operation-plans.module';
import { SystemModule } from './modules/system/system.controller';
import { BackupModule } from './modules/system/backup.controller';
import { ArtifactRetentionModule } from './modules/artifacts/artifact-retention.module';
import { BuildRunnerModule } from './infrastructure/build-runner/process-runner.service';
import { DeploymentTargetsModule } from './modules/deployment-targets/deployment-targets.service';
import { ServiceConfigsModule } from './modules/service-configs/service-configs.service';
import { ComposeTemplatesModule } from './modules/service-configs/compose-templates.service';
import { PipelinesModule } from './modules/pipelines/pipelines.module';
import { AiModule } from './modules/ai/ai.module';
import { InitialConfigurationModule } from './core/initial-configuration';
import { ViewsModule } from './modules/views/views.module';
import { OperationSchedulesModule } from './modules/operation-schedules/operation-schedules.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { SourceReviewModule } from './modules/deployments/source-review.service';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    AuthModule,
    CredentialsModule,
    SshModule,
    ServersModule,
    ServerGroupsModule,
    ProjectsModule,
    EnvironmentSetsModule,
    ViewsModule,
    DeploymentTargetsModule,
    ServiceConfigsModule,
    ComposeTemplatesModule,
    BuildRunnerModule,
    TasksModule,
    CommandCenterModule,
    OperationPlansModule,
    PipelinesModule,
    ExecutionGraphsModule,
    AiModule,
    InitialConfigurationModule,
    SystemModule,
    BackupModule,
    ArtifactRetentionModule,
    OperationSchedulesModule,
    NotificationsModule,
    MonitoringModule,
    SourceReviewModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
