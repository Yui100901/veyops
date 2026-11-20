import { ConflictException, HttpException, Injectable, OnModuleInit } from '@nestjs/common';
import type { GraphCheckoutSnapshot } from '../projects/repository-metadata.service';
import { RepositoryMetadataService } from '../projects/repository-metadata.service';
import { TargetResolver } from '../command-center/target-resolver.service';
import { TaskHandlerRegistry } from '../tasks/task-handler.registry';
import type { CreateTaskInput } from '../tasks/tasks.types';
import type { GraphNode } from './execution-graph-definition';

export type GraphNodePlan =
  | { type: 'CHECKOUT'; source: GraphCheckoutSnapshot }
  | { type: 'SHELL'; serverId: string; serverName: string; targetHash: string };

@Injectable()
export class GraphNodeTasks implements OnModuleInit {
  constructor(
    private readonly repositories: RepositoryMetadataService,
    private readonly targets: TargetResolver,
    private readonly registry: TaskHandlerRegistry,
  ) {}

  onModuleInit() {
    this.registry.register({
      type: 'GRAPH_CHECKOUT',
      execute: async ({ payload }, context) => {
        const checkout = payload.sourceCheckout!;
        const { repositoryId, commitSha, branch, fullClone } = checkout.source;
        context.log(`开始检出 ${branch || '固定提交'} · ${commitSha}\n`);
        try {
          await this.repositories.checkoutGraphSource(
            checkout.projectId,
            checkout.source,
            context.signal,
          );
          context.log(
            `${fullClone ? '完整提交历史' : '浅检出'}完成 · ${repositoryId} · ${commitSha}\n`,
          );
        } catch (error) {
          context.log(error instanceof HttpException ? error.message + '\n' : 'Git 检出失败\n');
          throw error;
        }
      },
    });
  }

  async prepare(projectId: string, node: GraphNode): Promise<GraphNodePlan> {
    if (node.type === 'CHECKOUT') {
      const config = node.checkout!;
      return {
        type: 'CHECKOUT',
        source: await this.repositories.planGraphCheckout(projectId, {
          ...config,
          repositoryId: config.repositoryId!,
        }),
      };
    }
    const serverId = node.shell!.serverId!;
    const target = await this.targets.preview({ serverIds: [serverId] });
    if (target.targets.length !== 1) throw new ConflictException('Shell 节点的服务器不可用');
    return {
      type: 'SHELL',
      serverId,
      serverName: target.targets[0]!.name,
      targetHash: target.targetHash,
    };
  }

  async task(
    projectId: string,
    action: GraphNode,
    plan: GraphNodePlan,
    idempotencyKey: string,
  ): Promise<CreateTaskInput> {
    const common = { name: action.name, scope: { projectId }, idempotencyKey };
    const defaults = {
      strategy: 'SEQUENTIAL',
      maxParallel: 1,
      failurePolicy: 'STOP',
      timeout: 180,
    } as const;
    if (plan.type === 'CHECKOUT')
      return {
        ...common,
        type: 'GRAPH_CHECKOUT',
        payload: {
          ...defaults,
          targets: [],
          steps: [],
          sourceCheckout: { projectId, source: plan.source },
        },
      };
    const targets = await this.targets.resolveForExecution({
      ...defaults,
      serverIds: [plan.serverId],
      expectedTargetHash: plan.targetHash,
      confirmed: true,
    });
    return {
      ...common,
      type: 'COMMAND',
      payload: {
        ...defaults,
        targets,
        steps: [{ name: action.name, command: action.shell!.command! }],
      },
    };
  }
}
