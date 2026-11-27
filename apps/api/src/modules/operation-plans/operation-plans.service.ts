import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../core/database/database.service';
import { TasksService } from '../tasks/tasks.service';
import { TaskHandlerRegistry } from '../tasks/task-handler.registry';
import { MultiTargetExecutor } from '../../infrastructure/ssh/multi-target.executor';
import { TargetResolver } from '../command-center/target-resolver.service';
import { CreatePlanDto, RunPlanDto } from './operation-plan.dto';
import type { CreateTaskInput, ExecutionStep } from '../tasks/tasks.types';
import {
  CommandParameterDto,
  parameterEnvironment,
  validateParameterDefinitions,
} from '../command-center/command-parameters';
import { seedPlanTemplates } from './plan-templates';
import {
  legacyOperationChain,
  legacyOperationSteps,
  validateOperationChain,
  type OperationChain,
} from './operation-chain';
import { AuditService } from '../audit/audit.service';
import { SystemSettingsService } from '../system/system-settings.service';
import type { Selectable, Transaction } from 'kysely';
import type { Database, OperationPlansTable } from '../../core/database/schema';

interface PlanDefinition {
  steps: ExecutionStep[];
  preChecks?: ExecutionStep[];
  postChecks?: ExecutionStep[];
  parameters?: CommandParameterDto[];
  name?: string;
  description?: string;
  category?: string;
  osRequirements?: string;
  chain?: OperationChain;
}

function planDefinition(input: CreatePlanDto) {
  if (input.chain && (input.steps?.length || input.preChecks?.length || input.postChecks?.length))
    throw new BadRequestException('请选择一种运维方案定义');
  if (!input.chain && !input.steps?.length) throw new BadRequestException('运维方案缺少执行链');
  return {
    name: input.name,
    description: input.description,
    category: input.category,
    osRequirements: input.osRequirements ?? '',
    steps: input.steps ?? [],
    preChecks: input.preChecks ?? [],
    postChecks: input.postChecks ?? [],
    parameters: validateParameterDefinitions(input.parameters ?? []),
    ...(input.chain && { chain: validateOperationChain(input.chain) }),
  };
}

function readPlanDefinition(json: string | null) {
  const definition = (json ? JSON.parse(json) : { steps: [] }) as PlanDefinition;
  return {
    ...definition,
    preChecks: definition.preChecks ?? [],
    postChecks: definition.postChecks ?? [],
    parameters: definition.parameters ?? [],
    osRequirements: definition.osRequirements ?? '',
  };
}

function presentPlan(plan: Selectable<OperationPlansTable>, definition: PlanDefinition) {
  return {
    ...definition,
    chain: definition.chain ?? legacyOperationChain(definition),
    id: plan.id,
    name: plan.name,
    description: plan.description,
    category: plan.category,
    currentVersion: plan.current_version,
    version: plan.current_version,
    enabled: plan.enabled === 1,
    createdAt: plan.created_at,
  };
}

@Injectable()
export class OperationPlansService implements OnModuleInit {
  constructor(
    private readonly database: DatabaseService,
    private readonly tasks: TasksService,
    private readonly registry: TaskHandlerRegistry,
    private readonly executor: MultiTargetExecutor,
    private readonly targets: TargetResolver,
    private readonly audit: AuditService,
    private readonly settings: SystemSettingsService,
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
      .leftJoin('operation_plan_versions as version', (join) =>
        join
          .onRef('version.plan_id', '=', 'operation_plans.id')
          .onRef('version.version', '=', 'operation_plans.current_version'),
      )
      .selectAll('operation_plans')
      .select('version.definition_json')
      .where('operation_plans.enabled', '=', 1)
      .orderBy('operation_plans.created_at', 'desc')
      .execute();
    return plans.map((plan) => presentPlan(plan, readPlanDefinition(plan.definition_json)));
  }
  async create(input: CreatePlanDto, userId: string) {
    const id = randomUUID();
    const now = Date.now();
    const definition = planDefinition(input);
    const plan = await this.database.db.transaction().execute(async (tx) => {
      const created = await tx
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
        .returningAll()
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('operation_plan_versions')
        .values({
          id: randomUUID(),
          plan_id: id,
          version: 1,
          schema_version: 2,
          definition_json: JSON.stringify(definition),
          created_by: userId,
          created_at: now,
        })
        .execute();
      return created;
    });
    await this.audit.record(userId, 'operation_plan.create', 'operation_plan', id);
    return presentPlan(plan, definition);
  }
  async update(id: string, input: CreatePlanDto, userId: string) {
    const now = Date.now();
    const definition = planDefinition(input);
    const plan = await this.database.db.transaction().execute(async (tx) => {
      const updated = await tx
        .updateTable('operation_plans')
        .set((eb) => ({
          name: input.name,
          description: input.description,
          category: input.category,
          current_version: eb('current_version', '+', 1),
          updated_at: now,
        }))
        .where('id', '=', id)
        .where('enabled', '=', 1)
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new NotFoundException('运维方案不存在');
      await tx
        .insertInto('operation_plan_versions')
        .values({
          id: randomUUID(),
          plan_id: id,
          version: updated.current_version,
          schema_version: 2,
          definition_json: JSON.stringify(definition),
          created_by: userId,
          created_at: now,
        })
        .execute();
      return updated;
    });
    await this.audit.record(userId, 'operation_plan.update', 'operation_plan', id);
    return presentPlan(plan, definition);
  }
  async remove(id: string, userId: string) {
    const plan = await this.database.db
      .updateTable('operation_plans')
      .set({ enabled: 0, updated_at: Date.now() })
      .where('id', '=', id)
      .where('enabled', '=', 1)
      .returning('id')
      .executeTakeFirst();
    if (!plan) throw new NotFoundException('运维方案不存在');
    await this.audit.record(userId, 'operation_plan.archive', 'operation_plan', id);
    return { id };
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
    ).map((row) => {
      const definition = readPlanDefinition(row.definition_json);
      return {
        id: row.id,
        version: row.version,
        createdAt: row.created_at,
        ...definition,
        chain: definition.chain ?? legacyOperationChain(definition),
      };
    });
  }
  async prepareRun(id: string, input: RunPlanDto) {
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
    const definition = readPlanDefinition(version.definition_json);
    const environment = parameterEnvironment(definition.parameters, input.parameters ?? {});
    const steps = legacyOperationSteps(definition).map((step) => ({
      ...step,
      command: environment + step.command,
    }));
    const operationChain = definition.chain && {
      ...definition.chain,
      nodes: definition.chain.nodes.map((node) =>
        node.type === 'COMMAND' ? { ...node, command: environment + node.command } : node,
      ),
    };
    const scope = await this.targets.executionScope(input);
    const defaults = await this.settings.get(scope?.projectId);
    const execution: CreateTaskInput = {
      type: 'OPERATION_PLAN',
      name: `${definition.name ?? plan.name} · v${version.version}`,
      operationPlanVersionId: version.id,
      scope,
      payload: {
        targets: await this.targets.resolveForExecution(input),
        steps,
        ...(operationChain && { operationChain }),
        strategy: input.strategy,
        maxParallel: input.maxParallel ?? defaults.defaultMaxParallelTargets,
        failurePolicy: input.failurePolicy ?? defaults.defaultOperationFailurePolicy,
        timeout: input.timeout ?? defaults.defaultOperationTimeoutSeconds,
      },
    };
    return {
      input: execution,
      version: version.version,
      beforeInsert: async (tx: Transaction<Database>) => {
        const active = await tx
          .updateTable('operation_plans')
          .set((eb) => ({ enabled: eb.ref('enabled') }))
          .where('id', '=', id)
          .where('enabled', '=', 1)
          .returning('id')
          .executeTakeFirst();
        if (!active) throw new BadRequestException('运维方案已禁用');
      },
    };
  }

  async run(
    id: string,
    input: RunPlanDto,
    userId: string,
    repair?: import('../tasks/tasks.types').AiRepairOrigin,
  ) {
    const execution = await this.prepareRun(id, input);
    if (repair) {
      const source = await this.database.db
        .selectFrom('tasks')
        .select(['project_id', 'service_id', 'environment_id'])
        .where('id', '=', repair.taskId)
        .executeTakeFirstOrThrow();
      if (!source.project_id || !source.service_id || !source.environment_id)
        throw new BadRequestException('故障来源缺少服务环境');
      execution.input.scope = {
        projectId: source.project_id,
        serviceId: source.service_id,
        environmentId: source.environment_id,
      };
      execution.input.payload.aiRepair = repair;
      execution.input.idempotencyKey = 'ai-repair:' + repair.taskId;
    }
    const task = await this.tasks.create(
      execution.input,
      userId,
      execution.beforeInsert,
      repair
        ? async (tx, taskId) => {
            const incident = await tx
              .updateTable('ai_failure_incidents')
              .set({ status: 'REPAIRING', repair_task_id: taskId, updated_at: Date.now() })
              .where('task_id', '=', repair.taskId)
              .where('proposal_id', '=', repair.proposalId)
              .where('status', '=', 'AWAITING_APPROVAL')
              .returning('task_id')
              .executeTakeFirst();
            if (!incident) throw new BadRequestException('故障提案已失效');
            await this.audit.record(
              userId,
              'ai.failure.repair',
              'task',
              repair.taskId,
              { repairTaskId: taskId, proposalId: repair.proposalId, automatic: repair.automatic },
              tx,
            );
          }
        : undefined,
    );
    await this.audit.record(userId, 'operation_plan.run', 'task', task.id, {
      planId: id,
      version: execution.version,
    });
    return task;
  }
}
