import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../core/database/database.service';
import { TasksService } from '../tasks/tasks.service';
import { TaskHandlerRegistry } from '../tasks/task-handler.registry';
import { MultiTargetExecutor } from '../../infrastructure/ssh/multi-target.executor';
import { TargetResolver } from '../command-center/target-resolver.service';
import { CreatePlanDto, RunPlanDto } from './operation-plan.dto';
import { ExecutionStep } from '../tasks/tasks.types';
import { seedPlanTemplates } from './plan-templates';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class OperationPlansService implements OnModuleInit {
  constructor(
    private readonly database: DatabaseService,
    private readonly tasks: TasksService,
    private readonly registry: TaskHandlerRegistry,
    private readonly executor: MultiTargetExecutor,
    private readonly targets: TargetResolver,
    private readonly audit: AuditService,
  ) {}
  async onModuleInit() {
    this.registry.register({
      type: 'OPERATION_PLAN',
      execute: (task, context) => this.executor.execute(task, context),
    });
    const admin = await this.database.db
      .selectFrom('users')
      .select('id')
      .where('role', '=', 'ADMIN')
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (admin) await seedPlanTemplates(this.database.db, admin.id);
  }
  async list() {
    const plans = await this.database.db
      .selectFrom('operation_plans')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
    return Promise.all(
      plans.map(async (plan) => {
        const version = await this.database.db
          .selectFrom('operation_plan_versions')
          .selectAll()
          .where('plan_id', '=', plan.id)
          .where('version', '=', plan.current_version)
          .executeTakeFirst();
        return {
          id: plan.id,
          name: plan.name,
          description: plan.description,
          category: plan.category,
          currentVersion: plan.current_version,
          version: plan.current_version,
          enabled: plan.enabled === 1,
          steps: version
            ? (JSON.parse(version.definition_json) as { steps: ExecutionStep[] }).steps
            : [],
          createdAt: plan.created_at,
        };
      }),
    );
  }
  async create(input: CreatePlanDto, userId: string) {
    const id = randomUUID();
    const now = Date.now();
    await this.database.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('operation_plans')
        .values({
          id,
          name: input.name,
          description: input.description,
          category: input.category,
          created_by: userId,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await tx
        .insertInto('operation_plan_versions')
        .values({
          id: randomUUID(),
          plan_id: id,
          version: 1,
          definition_json: JSON.stringify({ steps: input.steps }),
          created_by: userId,
          created_at: now,
        })
        .execute();
    });
    await this.audit.record(userId, 'operation_plan.create', 'operation_plan', id);
    return (await this.list()).find((plan) => plan.id === id)!;
  }
  async update(id: string, input: CreatePlanDto, userId: string) {
    const now = Date.now();
    await this.database.db.transaction().execute(async (tx) => {
      const plan = await tx
        .updateTable('operation_plans')
        .set((eb) => ({
          name: input.name,
          description: input.description,
          category: input.category,
          current_version: eb('current_version', '+', 1),
          updated_at: now,
        }))
        .where('id', '=', id)
        .returning('current_version')
        .executeTakeFirst();
      if (!plan) throw new NotFoundException('运维方案不存在');
      await tx
        .insertInto('operation_plan_versions')
        .values({
          id: randomUUID(),
          plan_id: id,
          version: plan.current_version,
          definition_json: JSON.stringify({ steps: input.steps }),
          created_by: userId,
          created_at: now,
        })
        .execute();
    });
    await this.audit.record(userId, 'operation_plan.update', 'operation_plan', id);
    return (await this.list()).find((plan) => plan.id === id)!;
  }
  async versions(id: string) {
    const plan = await this.database.db
      .selectFrom('operation_plans')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!plan) throw new NotFoundException('运维方案不存在');
    return (
      await this.database.db
        .selectFrom('operation_plan_versions')
        .selectAll()
        .where('plan_id', '=', id)
        .orderBy('version', 'desc')
        .execute()
    ).map((row) => ({
      id: row.id,
      version: row.version,
      createdAt: row.created_at,
      steps: (JSON.parse(row.definition_json) as { steps: ExecutionStep[] }).steps,
    }));
  }
  async run(id: string, input: RunPlanDto, userId: string) {
    const plan = await this.database.db
      .selectFrom('operation_plans')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!plan) throw new NotFoundException('运维方案不存在');
    if (!plan.enabled) throw new BadRequestException('运维方案已禁用');
    const version = await this.database.db
      .selectFrom('operation_plan_versions')
      .selectAll()
      .where('plan_id', '=', id)
      .where('version', '=', input.version ?? plan.current_version)
      .executeTakeFirst();
    if (!version) throw new NotFoundException('方案版本不存在');
    const task = await this.tasks.create(
      {
        type: 'OPERATION_PLAN',
        name: `${plan.name} · v${version.version}`,
        operationPlanVersionId: version.id,
        payload: {
          targets: await this.targets.resolve(input),
          steps: (JSON.parse(version.definition_json) as { steps: ExecutionStep[] }).steps,
          strategy: input.strategy,
          maxParallel: input.maxParallel,
          failurePolicy: input.failurePolicy,
          timeout: input.timeout,
        },
      },
      userId,
    );
    await this.audit.record(userId, 'operation_plan.run', 'task', task.id, {
      planId: id,
      version: version.version,
    });
    return task;
  }
}
