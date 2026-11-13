import 'reflect-metadata';
import './core/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from './app.module';
import { ApiExceptionFilter, ApiResponseInterceptor } from './core/http';
import { workspaceRoot } from './core/config';

export function configureApp(app: NestExpressApplication) {
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new ApiResponseInterceptor());
}
export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: true });
  configureApp(app);
  // Swagger is available only during local development. No production auth bypass.
  if (process.env.NODE_ENV !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('veyops API')
        .setDescription('首个可运行迭代 API；接口用法见 docs/API.md')
        .setVersion('0.1.0')
        .addCookieAuth('veyops_session')
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document);
  }
  const web = resolve(workspaceRoot, 'apps/web/dist');
  if (existsSync(web)) app.useStaticAssets(web);
  app.enableShutdownHooks();
  return app;
}
