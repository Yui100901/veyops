import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { map } from 'rxjs/operators';
import { ExecutionPlanIssueError } from './execution-plan-issue';

@Injectable()
export class ApiResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    // Nest SSE observables already carry MessageEvent envelopes.
    if (context.getHandler().name === 'stream') return next.handle();
    return next
      .handle()
      .pipe(
        map((data: unknown) => (data instanceof StreamableFile ? data : { data: data ?? null })),
      );
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
    const details =
      body && typeof body === 'object' && 'details' in body && body.details &&
      typeof body.details === 'object' ? body.details : null;
    const fieldErrors =
      status === 400 && details && 'fieldErrors' in details && Array.isArray(details.fieldErrors)
        ? details.fieldErrors.flatMap((entry: unknown) => {
            if (!entry || typeof entry !== 'object') return [];
            const { path, code, message } = entry as Record<string, unknown>;
            return typeof code === 'string' && typeof message === 'string' &&
              Array.isArray(path) && path.every((part: unknown) =>
                typeof part === 'string' || (typeof part === 'number' && Number.isInteger(part) && part >= 0),
              ) ? [{ path, code, message }] : [];
          })
        : undefined;
    const currentRevision =
      status === 409 && details && 'currentRevision' in details &&
      typeof details.currentRevision === 'number' && Number.isInteger(details.currentRevision)
        ? details.currentRevision
        : undefined;
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
        ...(fieldErrors?.length && { details: { fieldErrors } }),
        ...(currentRevision !== undefined && { details: { currentRevision } }),
        ...(error instanceof ExecutionPlanIssueError && { planIssue: error.issue }),
        ...(status === 409 &&
          body &&
          typeof body === 'object' &&
          'references' in body &&
          Array.isArray(body.references) && { references: body.references }),
        ...(status === 409 &&
          body &&
          typeof body === 'object' &&
          'changes' in body &&
          Array.isArray(body.changes) && { changes: body.changes }),
      },
    });
  }
}
