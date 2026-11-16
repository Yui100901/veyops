import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

@Controller()
class ApplicationController {
  @Get()
  index() {
    return { message: 'VeyOps NestJS 发布成功' };
  }

  @Get('healthz')
  health() {
    return {
      status: 'ok',
      framework: 'nestjs',
      instance: process.env.VEYOPS_DEMO_INSTANCE ?? 'standalone',
    };
  }
}

@Module({ controllers: [ApplicationController] })
class ApplicationModule {}

async function bootstrap() {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const app = await NestFactory.create(ApplicationModule, { logger: ['error', 'warn'] });
  app.enableShutdownHooks();
  await app.listen(port, '127.0.0.1');
}

void bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
