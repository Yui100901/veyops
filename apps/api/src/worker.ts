import 'reflect-metadata';
import './core/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { TaskWorkerService } from './modules/tasks/task-worker.service';
import { NotificationsService } from './modules/notifications/notifications.service';
import { MonitoringService } from './modules/monitoring/monitoring.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { abortOnError: false });
  app.enableShutdownHooks();
  app.get(TaskWorkerService).start(true);
  app.get(NotificationsService).start();
  app.get(MonitoringService).start();
  console.log('veyops Worker ready');
}

void main().catch((error: unknown) => {
  console.error(
    `Worker startup failed: ${error instanceof Error ? error.name : 'UnknownError'}. Check configuration and migrations.`,
  );
  process.exitCode = 1;
});
