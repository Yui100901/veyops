import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { TargetResolver } from '../command-center/target-resolver.service';
import { storedDeploymentSelection } from '../deployment-targets/deployment-selection';
import { pipelineSourceRepositories } from '../pipelines/pipeline-node-config';
import type { TaskPayload, AiRepairOrigin } from '../tasks/tasks.types';
import type { CurrentUser } from '../auth/auth.decorators';
import { AiPolicyService, type AiPolicySnapshot } from './ai-policy.service';
import { initializationPlans } from './ai-deployment-tools.service';

@Injectable()
export class AiFailureGuard {
  constructor(
    private readonly database: DatabaseService,
    private readonly policy: AiPolicyService,
    private readonly targets: TargetResolver,
  ) {}

  async project(serviceId: string, environmentId: string) {
    const row = await this.database.db
      .selectFrom('services as s')
      .innerJoin('projects as p', 'p.id', 's.project_id')
      .innerJoin('environments as e', 'e.project_id', 's.project_id')
      .select('p.id')
      .where('s.id', '=', serviceId)
      .where('e.id', '=', environmentId)
      .where('p.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('所选服务和环境必须属于同一个有效项目');
    return row.id;
  }

  async readable(projectId: string) {
    const snapshot = await this.policy.snapshot(projectId);
    return (payload: TaskPayload) => {
      try {
        this.assertScope(payload, projectId, snapshot);
        return true;
      } catch (error) {
        if (error instanceof ForbiddenException) return false;
        throw error;
      }
    };
  }

  private assertScope(payload: TaskPayload, projectId: string, snapshot: AiPolicySnapshot) {
    if (!payload.pipeline || payload.pipeline.projectId !== projectId)
      throw new ForbiddenException('任务未绑定到此项目');
    const serverIds = payload.targets.map((target) => target.id);
    this.policy.assertRead('diagnose_deployment', snapshot, projectId, serverIds);
    const repositoryIds = pipelineSourceRepositories(payload.pipeline.definition);
    for (const id of repositoryIds) this.policy.assertRepository(id, snapshot);
    return { serverIds, repositoryIds };
  }

  async context(taskId: string) {
    const row = await this.database.db
      .selectFrom('ai_failure_incidents as i')
      .innerJoin('tasks as t', 't.id', 'i.task_id')
      .innerJoin('users as u', 'u.id', 't.created_by')
      .innerJoin('ai_failure_settings as s', (join) =>
        join
          .onRef('s.service_id', '=', 'i.service_id')
          .onRef('s.environment_id', '=', 'i.environment_id')
          .onRef('s.revision', '=', 'i.revision'),
      )
      .selectAll('i')
      .select([
        't.payload_json',
        't.status as sourceStatus',
        't.project_id',
        's.component',
        'u.id as userId',
        'u.role',
        'u.username',
        'u.must_change_password',
      ])
      .where('t.task_type', '=', 'PIPELINE')
      .where('u.status', '=', 'ACTIVE')
      .where('s.enabled', '=', 1)
      .where('i.task_id', '=', taskId)
      .executeTakeFirst();
    if (!row || row.must_change_password || !['ADMIN', 'OPERATOR'].includes(row.role))
      throw new ForbiddenException('故障处理设置或任务发起人的权限已改变');
    const projectId = await this.project(row.service_id, row.environment_id);
    const payload = JSON.parse(row.payload_json) as TaskPayload;
    const pipeline = payload.pipeline;
    if (
      !pipeline ||
      pipeline.projectId !== projectId ||
      row.project_id !== projectId ||
      pipeline.serviceId !== row.service_id ||
      pipeline.environmentId !== row.environment_id
    )
      throw new ConflictException('原任务与服务环境的绑定不一致');
    const actor: CurrentUser = {
      id: row.userId,
      username: row.username,
      role: row.role as CurrentUser['role'],
    };
    const snapshot = await this.policy.snapshot(projectId);
    const { serverIds, repositoryIds } = this.assertScope(payload, projectId, snapshot);
    return {
      row,
      projectId,
      actor,
      snapshot,
      pipeline,
      targets: payload.targets,
      serverIds,
      repositoryIds,
    };
  }

  async repair(taskId: string, origin?: AiRepairOrigin, repairTaskId?: string) {
    const context = await this.context(taskId);
    const { row, targets, actor, snapshot, projectId, serverIds, repositoryIds } = context;
    if (
      !row.component ||
      targets.length !== 1 ||
      (origin &&
        (row.proposal_id !== origin.proposalId ||
          (repairTaskId
            ? row.status !== 'REPAIRING' || row.repair_task_id !== repairTaskId
            : row.status !== 'AWAITING_APPROVAL')))
    )
      throw new ConflictException('本次修复绑定已失效');
    const plan = await this.database.db
      .selectFrom('operation_plans')
      .select('id')
      .where('id', '=', initializationPlans[row.component])
      .where('enabled', '=', 1)
      .executeTakeFirst();
    if (!plan) throw new ConflictException('绑定的内置修复方案已停用');
    this.policy.assertRead('inspect_servers', snapshot, projectId, serverIds);
    const decision = this.policy.evaluate(
      actor,
      {
        action: 'initialize_component',
        projectId,
        serverIds,
        sourceRepositoryIds: repositoryIds,
      },
      snapshot,
    );
    if (origin?.automatic && decision !== 'ALLOW')
      throw new ForbiddenException('当前策略要求人工批准');
    const config = await this.database.db
      .selectFrom('service_environment_configs')
      .select(['target_selection_json', 'target_id'])
      .where('service_id', '=', row.service_id)
      .where('environment_id', '=', row.environment_id)
      .executeTakeFirst();
    if (!config) throw new ConflictException('服务环境尚未绑定目标');
    const selection = storedDeploymentSelection(config.target_selection_json);
    const bound = await this.targets.resolve(
      selection ?? { deploymentTargetIds: config.target_id ? [config.target_id] : [] },
    );
    const original = targets[0]!;
    const current = bound.length === 1 && bound[0]?.id === original.id ? bound[0] : undefined;
    if (
      !current ||
      !original.credentialNonce ||
      current.credentialNonce !== original.credentialNonce ||
      current.credentialId !== original.credentialId ||
      current.host !== original.host ||
      current.port !== original.port ||
      current.username !== original.username ||
      current.hostKeyFingerprint !== original.hostKeyFingerprint
    )
      throw new ConflictException('故障目标、SSH 凭据或主机指纹已变化');
    return { ...context, component: row.component, decision, current };
  }
}
