import { SshTarget } from '../../infrastructure/ssh/ssh.service';
import type { PipelineSnapshot } from '../pipelines/pipeline.types';

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
export interface ExecutionStep {
  key?: string;
  name: string;
  command: string;
  timeout?: number;
  failurePolicy?: 'STOP' | 'CONTINUE';
}
export interface TaskPayload {
  targets: SshTarget[];
  steps: ExecutionStep[];
  strategy: 'PARALLEL' | 'SEQUENTIAL';
  maxParallel: number;
  failurePolicy: 'STOP' | 'CONTINUE';
  timeout: number;
  pipeline?: PipelineSnapshot;
}
export interface TaskRecord {
  id: string;
  type: string;
  name: string;
  payload: TaskPayload;
}
export interface TaskExecutionContext {
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
}

export interface CreateTaskInput {
  type: 'COMMAND' | 'OPERATION_PLAN' | 'PIPELINE';
  name: string;
  payload: TaskPayload;
  operationPlanVersionId?: string;
  scope?: { projectId: string; serviceId: string; environmentId: string; targetId: string };
  pipelineRun?: {
    id: string;
    pipelineId: string;
    pipelineVersionId: string;
    gitRef: string;
    commitSha: string;
    buildLocation: string;
    artifactType: string;
  };
}
