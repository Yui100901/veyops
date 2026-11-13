import { Injectable } from '@nestjs/common';
import { TaskHandler } from './tasks.types';

@Injectable()
export class TaskHandlerRegistry {
  private readonly handlers = new Map<string, TaskHandler>();
  register(handler: TaskHandler): void {
    if (this.handlers.has(handler.type))
      throw new Error(`Task handler already registered: ${handler.type}`);
    this.handlers.set(handler.type, handler);
  }
  get(type: string): TaskHandler {
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`Unsupported task type: ${type}`);
    return handler;
  }
}
