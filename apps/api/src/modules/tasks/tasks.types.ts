import { SshTarget } from '../../infrastructure/ssh/ssh.service';
import type { PipelineSnapshot } from '../pipelines/pipeline.types';
import type { Transaction } from 'kysely';
import type { Database } from '../../core/database/schema';
import type { GraphCheckoutSnapshot } from '../projects/repository-metadata.service';

export type TaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'PARTIAL_FAILED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'NEEDS_ATTENTION';

export const failedTaskStatuses = [
  'FAILED',
  'PARTIAL_FAILED',
  'TIMED_OUT',
  'NEEDS_ATTENTION',
] as const;
export const terminalTaskStatuses = [
  'SUCCESS',
  'FAILED',
  'PARTIAL_FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'NEEDS_ATTENTION',
] as const satisfies readonly TaskStatus[];
export interface ExecutionStep {
  key?: string;
  name: string;
  command: string;
  timeout?: number;
  failurePolicy?: 'STOP' | 'CONTINUE';
}
export interface AiRepairOrigin {
  taskId: string;
  proposalId: string;
  automatic: boolean;
}
export interface TaskPayload {
  sourceCheckout?: { projectId: string; source: GraphCheckoutSnapshot };
  aiRepair?: AiRepairOrigin;
  targets: SshTarget[];
  steps: ExecutionStep[];
  strategy: 'PARALLEL' | 'SEQUENTIAL';
  maxParallel: number;
  failurePolicy: 'STOP' | 'CONTINUE';
  timeout: number;
  pipeline?: PipelineSnapshot;
  commandTemplate?: { id: string; version: number };
  retryOf?: { taskId: string; targetId: string };
}
export interface TaskRecord {
  id: string;
  type: string;
  name: string;
  payload: TaskPayload;
}
export interface TaskExecutionContext {
  readonly leaseOwner?: string;
  signal: AbortSignal;
  log(text: string, serverId?: string): void;
  startTarget(serverId: string): Promise<string>;
  finishTarget(
    targetId: string,
    status: TaskStatus,
    exitCode: number | null,
    error?: string,
  ): Promise<void>;
  startStep(
    targetId: string,
    serverId: string,
    step: ExecutionStep,
    index: number,
  ): Promise<string>;
  finishStep(
    stepId: string,
    status: TaskStatus,
    exitCode: number | null,
    error?: string,
  ): Promise<void>;
}
export interface TaskHandler {
  type: string;
  execute(task: TaskRecord, context: TaskExecutionContext): Promise<void>;
  onFinalize?(
    tx: Transaction<Database>,
    task: TaskRecord,
    userId: string,
    status: TaskStatus,
  ): Promise<{ deploymentTaskId?: string; deploymentSkippedReason?: string } | undefined>;
  afterCompletion?(task: TaskRecord, signal: AbortSignal): Promise<void>;
}

export interface CreateTaskInput {
  type: 'COMMAND' | 'OPERATION_PLAN' | 'PIPELINE' | 'GRAPH_CHECKOUT';
  name: string;
  payload: TaskPayload;
  operationPlanVersionId?: string;
  idempotencyKey?: string;
  scope?: { projectId?: string; serviceId?: string; environmentId?: string; targetId?: string };
  pipelineRun?: {
    id: string;
    pipelineId: string;
    pipelineVersionId: string;
    gitRef: string;
    commitSha: string;
    buildLocation: string;
    artifactType: string;
    triggerType?: PipelineSnapshot['triggerType'];
  };
}
