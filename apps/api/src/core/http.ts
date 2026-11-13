import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import type { Response } from 'express';
import { map } from 'rxjs/operators';

@Injectable()
export class ApiResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    // Nest SSE observables already carry MessageEvent envelopes.
    if (context.getHandler().name === 'stream') return next.handle();
    return next.handle().pipe(map((data: unknown) => ({ data: data ?? null })));
  }
}
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const body = error instanceof HttpException ? error.getResponse() : null;
    const validation = body && typeof body === 'object' && 'message' in body ? body.message : null;
    const message =
      typeof body === 'string'
        ? body
        : validation || (status === 500 ? '服务器内部错误，请检查服务日志' : '请求失败');
    if (status >= 500) {
      // Never print request bodies, database statements, or driver errors which may contain secrets.
      console.error(
        `[api] ${new Date().toISOString()} ${error instanceof Error ? error.name : 'UnknownError'}`,
      );
    }
    response.status(status).json({
      error: {
        code: `HTTP_${status}`,
        message: Array.isArray(message) ? message.join('；') : message,
      },
    });
  }
}
