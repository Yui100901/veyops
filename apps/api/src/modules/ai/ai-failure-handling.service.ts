import { ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Selectable, Transaction, Updateable } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import type { CurrentUser } from '../auth/auth.decorators';
import {
  failedTaskStatuses,
  terminalTaskStatuses,
  type AiRepairOrigin,
  type TaskPayload,
} from '../tasks/tasks.types';
import { TasksService } from '../tasks/tasks.service';
import {
  AiDeploymentToolsService,
  diagnoseDeploymentFailure,
  type InitializationComponent,
} from './ai-deployment-tools.service';
import { AiFailureGuard } from './ai-failure-guard.service';
import { AiPipelineAnalyzer } from './ai-pipeline-analyzer.service';
import { AiProposalsService } from './ai-proposals.service';
import { AiToolsService } from './ai-tools.service';

type Incident = Selectable<Database['ai_failure_incidents']>;
type Settings = { enabled: boolean; component?: InitializationComponent | null };
const missingComponent: Record<InitializationComponent, RegExp> = {
  docker:
    /目标主机找不到 Docker CLI|\bdocker:\s*(?:command )?not found\b|command not found:\s*docker\b/i,
  compose: /目标主机无法执行 docker compose|docker: ['‘]compose['’] is not a docker command/i,
  node: /\b(node|npm):\s*(?:command )?not found\b|command not found:\s*(node|npm)\b/i,
  nginx: /\bnginx:\s*(?:command )?not found\b|command not found:\s*nginx\b/i,
};
const disabledMessage = '故障处理设置或执行权限已改变，请人工核查。';

@Injectable()
export class AiFailureHandlingService {
  private approvalCursor = '';
  private nextApprovalCheck = 0;
  constructor(
    private readonly database: DatabaseService,
    private readonly guard: AiFailureGuard,
    private readonly tasks: TasksService,
    private readonly deployment: AiDeploymentToolsService,
    private readonly analyzer: AiPipelineAnalyzer,
    private readonly tools: AiToolsService,
    private readonly proposals: AiProposalsService,
    private readonly audit: AuditService,
  ) {}

  async view(serviceId: string, environmentId: string, user: CurrentUser, taskId?: string) {
    const projectId = await this.guard.project(serviceId, environmentId);
    const readable = await this.guard.readable(projectId);
    const db = this.database.db;
    const setting = await db
      .selectFrom('ai_failure_settings')
      .selectAll()
      .where('service_id', '=', serviceId)
      .where('environment_id', '=', environmentId)
      .executeTakeFirst();
    const rows = await db
      .selectFrom('ai_failure_incidents as i')
      .innerJoin('tasks as t', 't.id', 'i.task_id')
      .leftJoin('ai_action_proposals as p', 'p.id', 'i.proposal_id')
      .selectAll('i')
      .select(['p.created_by', 'p.expires_at', 'p.status as proposalStatus', 't.payload_json'])
      .where('i.service_id', '=', serviceId)
      .where('i.environment_id', '=', environmentId)
      .$if(Boolean(taskId), (q) => q.where('i.task_id', '=', taskId!))
      .orderBy('i.created_at', 'desc')
      .limit(50)
      .execute();
    return {
      enabled: setting?.enabled === 1,
      component: setting?.component ?? null,
      incidents: await Promise.all(
        rows
          .filter((row) => readable(JSON.parse(row.payload_json) as TaskPayload))
          .map(async (row) => {
            const canReject =
              row.status === 'AWAITING_APPROVAL' &&
              row.proposalStatus === 'PENDING' &&
              row.created_by === user.id &&
              (row.expires_at ?? 0) > Date.now();
            return {
              taskId: row.task_id,
              status: row.status,
              summary: row.summary,
              findings: JSON.parse(row.findings_json) as { code: string; suggestion: string }[],
              proposalId: row.proposal_id,
              repairTaskId: row.repair_task_id,
              canReject,
              canApprove:
                canReject &&
                user.role !== 'VIEWER' &&
                Boolean(row.proposal_id && (await this.approvable(row.task_id, row.proposal_id))),
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            };
          }),
      ),
    };
  }

  async configure(serviceId: string, environmentId: string, input: Settings, user: CurrentUser) {
    if (user.role !== 'ADMIN') throw new ForbiddenException('仅管理员可配置故障处理');
    await this.guard.project(serviceId, environmentId);
    const values = {
      enabled: Number(input.enabled),
      component: input.component ?? null,
      revision: randomUUID(),
    };
    await this.database.db.transaction().execute(async (tx) => {
      const changed = await tx
        .insertInto('ai_failure_settings')
        .values({ service_id: serviceId, environment_id: environmentId, ...values })
        .onConflict((c) =>
          c
            .columns(['service_id', 'environment_id'])
            .doUpdateSet(values)
            .where((eb) =>
              eb.or([
                eb('ai_failure_settings.enabled', '!=', values.enabled),
                eb('ai_failure_settings.component', 'is distinct from', values.component),
              ]),
            ),
        )
        .returning('revision')
        .executeTakeFirst();
      if (!changed) return;
      const stale = await tx
        .updateTable('ai_failure_incidents')
        .set({ status: 'MANUAL', summary: disabledMessage, updated_at: Date.now() })
        .where('service_id', '=', serviceId)
        .where('environment_id', '=', environmentId)
        .where('status', 'in', ['PENDING', 'DIAGNOSING', 'AWAITING_APPROVAL'])
        .returning(['task_id', 'proposal_id'])
        .execute();
      for (const row of stale) {
        if (row.proposal_id)
          await tx
            .updateTable('ai_action_proposals')
            .set({ status: 'EXPIRED' })
            .where('id', '=', row.proposal_id)
            .where('status', '=', 'PENDING')
            .execute();
        await this.audit.record(user.id, 'ai.failure.manual', 'task', row.task_id, {}, tx);
      }
      await this.audit.record(
        user.id,
        'ai.failure.configure',
        'service',
        serviceId,
        { environmentId, enabled: input.enabled, component: values.component },
        tx,
      );
    });
    return this.view(serviceId, environmentId, user);
  }

  async completion(tx: Transaction<Database>, taskId: string, at: number) {
    const task = await tx
      .selectFrom('tasks')
      .select(['task_type', 'status', 'service_id', 'environment_id', 'idempotency_key'])
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow();
    if (task.task_type === 'OPERATION_PLAN' && task.idempotency_key?.startsWith('ai-repair:')) {
      const verification =
        task.status === 'SUCCESS' &&
        (await tx
          .selectFrom('task_steps')
          .select('id')
          .where('task_id', '=', taskId)
          .where('step_key', '=', 'postcheck-1')
          .where('status', '=', 'SUCCESS')
          .where('exit_code', '=', 0)
          .executeTakeFirst());
      const verified = Boolean(verification);
      const row = await tx
        .updateTable('ai_failure_incidents')
        .set({
          status: verified ? 'VERIFIED' : 'MANUAL',
          summary: verified
            ? '内置修复方案及其组件验证步骤均已成功，可重新运行原流水线。'
            : '修复或组件验证未成功，已达到本次故障的一次修复上限，请人工核查。',
          updated_at: at,
        })
        .where('repair_task_id', '=', taskId)
        .where('status', '=', 'REPAIRING')
        .returning('task_id')
        .executeTakeFirst();
      if (row)
        await this.audit.record(
          null,
          'ai.failure.verify',
          'task',
          row.task_id,
          { repairTaskId: taskId, verified },
          tx,
        );
      return;
    }
    if (
      task.task_type !== 'PIPELINE' ||
      !task.service_id ||
      !task.environment_id ||
      !failedTaskStatuses.some((status) => status === task.status)
    )
      return;
    const config = await tx
      .selectFrom('ai_failure_settings')
      .select('revision')
      .where('service_id', '=', task.service_id)
      .where('environment_id', '=', task.environment_id)
      .where('enabled', '=', 1)
      .executeTakeFirst();
    if (!config) return;
    const uncertain = task.status === 'NEEDS_ATTENTION' || task.status === 'TIMED_OUT';
    const row = await tx
      .insertInto('ai_failure_incidents')
      .values({
        task_id: taskId,
        service_id: task.service_id,
        environment_id: task.environment_id,
        revision: config.revision,
        status: uncertain ? 'MANUAL' : 'PENDING',
        summary: uncertain ? '任务超时或执行结果不明，请人工核查远端状态。' : '等待故障诊断。',
        ...(uncertain && {
          findings_json: JSON.stringify(diagnoseDeploymentFailure(task.status, '')),
        }),
        created_at: at,
        updated_at: at,
      })
      .onConflict((c) => c.column('task_id').doNothing())
      .returning('task_id')
      .executeTakeFirst();
    if (row)
      await this.audit.record(
        null,
        'ai.failure.receive',
        'task',
        taskId,
        { manual: uncertain },
        tx,
      );
  }

  async authorizeRepair(origin: AiRepairOrigin, taskId: string) {
    await this.guard.repair(origin.taskId, origin, taskId);
  }

  private async transition(
    taskId: string,
    from: Incident['status'],
    to: Incident['status'],
    summary: string,
    fields: Pick<
      Updateable<Database['ai_failure_incidents']>,
      'findings_json' | 'proposal_id'
    > = {},
  ) {
    return this.database.db.transaction().execute(async (tx) => {
      const row = await tx
        .updateTable('ai_failure_incidents')
        .set({ ...fields, status: to, summary, updated_at: Date.now() })
        .where('task_id', '=', taskId)
        .where('status', '=', from)
        .returning(['task_id', 'proposal_id'])
        .executeTakeFirst();
      if (row) {
        if (from === 'AWAITING_APPROVAL' && to === 'MANUAL' && row.proposal_id) {
          await tx
            .updateTable('ai_action_proposals')
            .set({ status: 'EXPIRED' })
            .where('id', '=', row.proposal_id)
            .where('status', '=', 'PENDING')
            .execute();
        }
        await this.audit.record(
          null,
          'ai.failure.' + to.toLowerCase(),
          'task',
          taskId,
          fields.findings_json
            ? {
                summary,
                findings: JSON.parse(fields.findings_json),
                proposalId: fields.proposal_id,
              }
            : {},
          tx,
        );
      }
      return Boolean(row);
    });
  }

  private async approvable(taskId: string, proposalId: string) {
    try {
      await this.guard.repair(taskId, { taskId, proposalId, automatic: false });
      return true;
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500) return false;
      throw error;
    }
  }

  private async reconcileApprovals() {
    if (Date.now() < this.nextApprovalCheck) return;
    this.nextApprovalCheck = Date.now() + 10_000;
    const rows = await this.database.db
      .selectFrom('ai_failure_incidents')
      .select(['task_id', 'proposal_id'])
      .where('status', '=', 'AWAITING_APPROVAL')
      .where('task_id', '>', this.approvalCursor)
      .orderBy('task_id')
      .limit(10)
      .execute();
    this.approvalCursor = rows.length === 10 ? rows.at(-1)!.task_id : '';
    for (const row of rows) {
      if (row.proposal_id && !(await this.approvable(row.task_id, row.proposal_id)))
        await this.transition(row.task_id, 'AWAITING_APPROVAL', 'MANUAL', disabledMessage);
    }
  }

  async tick(signal?: AbortSignal) {
    const db = this.database.db;
    await this.reconcileApprovals();
    // Queued repair tasks can also be cancelled directly from the task API.
    const settled = await db
      .selectFrom('ai_failure_incidents as i')
      .innerJoin('tasks as t', 't.id', 'i.repair_task_id')
      .select('t.id')
      .where('i.status', '=', 'REPAIRING')
      .where('t.status', 'in', terminalTaskStatuses)
      .limit(20)
      .execute();
    for (const task of settled)
      await db.transaction().execute((tx) => this.completion(tx, task.id, Date.now()));
    const stale = await db
      .selectFrom('ai_failure_incidents as i')
      .leftJoin('ai_action_proposals as p', 'p.id', 'i.proposal_id')
      .select(['i.task_id', 'i.status'])
      .where((eb) =>
        eb.or([
          eb.and([
            eb('i.status', '=', 'DIAGNOSING'),
            eb('i.updated_at', '<', Date.now() - 120_000),
          ]),
          eb.and([
            eb('i.status', '=', 'AWAITING_APPROVAL'),
            eb.or([
              eb('p.status', 'in', ['REJECTED', 'EXPIRED']),
              eb.and([eb('p.status', '=', 'PENDING'), eb('p.expires_at', '<=', Date.now())]),
              eb.and([
                eb('p.status', '=', 'APPROVED'),
                eb('p.confirmed_at', '<', Date.now() - 120_000),
              ]),
            ]),
          ]),
        ]),
      )
      .limit(20)
      .execute();
    for (const row of stale)
      await this.transition(
        row.task_id,
        row.status,
        'MANUAL',
        '审批已结束或处理过程被中断，请人工核查。',
      );
    if (signal?.aborted) return;
    const next = await db
      .selectFrom('ai_failure_incidents')
      .select('task_id')
      .where('status', '=', 'PENDING')
      .orderBy('created_at')
      .limit(1)
      .executeTakeFirst();
    if (
      !next ||
      !(await this.transition(next.task_id, 'PENDING', 'DIAGNOSING', '正在分析失败阶段。'))
    )
      return;
    try {
      await this.diagnose(next.task_id, signal);
    } catch {
      await this.transition(
        next.task_id,
        'DIAGNOSING',
        'MANUAL',
        '无法核实执行权限、目标环境或内置方案，请人工核查。',
      );
      await this.transition(
        next.task_id,
        'AWAITING_APPROVAL',
        'MANUAL',
        '修复提案未完成，请人工核查审批和任务记录。',
      );
    }
  }

  private async diagnose(taskId: string, signal?: AbortSignal) {
    const context = await this.guard.context(taskId);
    const { row, serverIds, pipeline } = context;
    const steps = await this.tasks.steps(taskId);
    const targets = await this.tasks.targets(taskId);
    const evidence = [
      await this.tasks.recentLog(taskId),
      ...targets.map((t) => t.errorSummary ?? ''),
    ].join('\n');
    const failed = steps.filter((step) =>
      failedTaskStatuses.some((status) => status === step.status),
    );
    const findings = diagnoseDeploymentFailure(
      row.sourceStatus,
      evidence,
      failed.find((step) => step.exitCode)?.exitCode,
    );
    const fields = { findings_json: JSON.stringify(findings) };
    const analyzed = await this.analyzer.analyzeFailure(
      {
        status: row.sourceStatus,
        mode: pipeline.mode === 'BUILD_ONLY' ? 'BUILD_ONLY' : 'DEPLOY',
        targetCounts: {
          total: targets.length,
          succeeded: targets.filter((t) => t.status === 'SUCCESS').length,
          failed: targets.filter((t) => failedTaskStatuses.some((status) => status === t.status))
            .length,
        },
        steps: failed.map((s) => ({
          phase: pipeline.definition.nodes?.find((n) => 'node:' + n.id === s.key)?.type ?? s.key,
          status: s.status,
          exitCode: s.exitCode,
        })),
      },
      findings.map((f) => f.code),
      signal,
    );
    if (!analyzed || signal?.aborted) {
      await this.transition(
        taskId,
        'DIAGNOSING',
        'MANUAL',
        'AI 模型不可用或诊断被中断，请根据已确认的故障分类人工核查。',
        fields,
      );
      return;
    }
    const fresh = await this.guard.context(taskId);
    if (fresh.row.status !== 'DIAGNOSING') return;
    const component = fresh.row.component;
    const hostExecution =
      pipeline.mode === 'DEPLOY_ARTIFACT' || pipeline.definition.buildLocation === 'TARGET';
    if (
      fresh.snapshot.mode === 'READ_ONLY' ||
      !hostExecution ||
      !component ||
      !failed.length ||
      serverIds.length !== 1 ||
      failed.some((s) => s.serverId !== serverIds[0] || s.status !== 'FAILED') ||
      findings.length !== 1 ||
      findings[0]?.code !== 'MISSING_TOOL' ||
      !missingComponent[component].test(evidence)
    ) {
      await this.transition(taskId, 'DIAGNOSING', 'ADVICE', analyzed.summary, fields);
      return;
    }
    const { actor, current, decision } = await this.guard.repair(taskId);
    const [report] = await this.deployment.inspect([current]);
    // A fixed probe must confirm the same missing executable before any proposal is created.
    const match = missingComponent[component].exec(evidence);
    const missingExecutable =
      component === 'node' ? (match?.[1] ?? match?.[2])?.toLowerCase() : component;
    if (
      report?.status !== 'OK' ||
      !report.facts.os ||
      report.facts.probeComplete !== '1' ||
      !missingExecutable ||
      report.facts[missingExecutable] === 'available'
    ) {
      await this.transition(
        taskId,
        'DIAGNOSING',
        'MANUAL',
        '只读巡检未能复现日志中的工具缺失，请人工核查。',
        fields,
      );
      return;
    }
    const prepared = await this.tools.prepare(
      'initialize_component',
      { component, serverIds },
      actor,
    );
    prepared.projectId = context.projectId;
    prepared.sourceRepositoryIds = fresh.repositoryIds;
    prepared.failureTaskId = taskId;
    prepared.preview = {
      ...prepared.preview,
      sourceTaskId: taskId,
      serviceId: row.service_id,
      environmentId: row.environment_id,
    };
    const proposal = await this.proposals.create(prepared, fresh.snapshot, actor);
    if (
      !(await this.transition(taskId, 'DIAGNOSING', 'AWAITING_APPROVAL', analyzed.summary, {
        ...fields,
        proposal_id: proposal.id,
      }))
    ) {
      await this.proposals.reject(proposal.id, actor);
      return;
    }
    if (decision === 'ALLOW') await this.proposals.confirm(proposal.id, actor, true);
  }
}
