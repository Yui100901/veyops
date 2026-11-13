import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  MessageEvent,
  Param,
  Post,
  Query,
  Req,
  Sse,
} from '@nestjs/common';
import { interval, Observable, startWith, concatMap, takeWhile } from 'rxjs';
import { Roles } from '../auth/auth.decorators';
import { TasksService, isTerminalStatus } from './tasks.service';
import { AuditService } from '../audit/audit.service';

@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly audit: AuditService,
  ) {}
  @Get() list() {
    return this.tasks.list();
  }
  @Get(':id') get(@Param('id') id: string) {
    return this.tasks.get(id);
  }
  @Get(':id/targets') targets(@Param('id') id: string) {
    return this.tasks.targets(id);
  }
  @Get(':id/steps') steps(@Param('id') id: string) {
    return this.tasks.steps(id);
  }
  @Get(':id/logs') logs(@Param('id') id: string, @Query('offset') offset?: string) {
    return this.tasks.logs(id, this.offset(offset));
  }
  @Post(':id/cancel') @Roles('ADMIN', 'OPERATOR') async cancel(
    @Param('id') id: string,
    @Req() req: { user: { id: string } },
  ) {
    const task = await this.tasks.cancel(id);
    await this.audit.record(req.user.id, 'task.cancel', 'task', id);
    return task;
  }
  @Sse(':id/logs/stream') stream(
    @Param('id') id: string,
    @Query('offset') offset?: string,
    @Headers('last-event-id') lastEventId?: string,
  ): Observable<MessageEvent> {
    let cursor = this.offset(lastEventId || offset);
    return interval(1000).pipe(
      startWith(0),
      concatMap(async () => {
        const task = await this.tasks.get(id);
        const result = await this.tasks.logs(id, cursor);
        cursor = result.nextOffset;
        return {
          id: String(cursor),
          type: 'log',
          data: {
            ...result,
            status: task.status,
            complete: isTerminalStatus(task.status) && !result.content,
          },
        };
      }),
      takeWhile((event) => !event.data.complete, true),
    );
  }
  private offset(value?: string): number {
    const offset = Number(value ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new BadRequestException('日志offset必须为非负整数');
    return offset;
  }
}
