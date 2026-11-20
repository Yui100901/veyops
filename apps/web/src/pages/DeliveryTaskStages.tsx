import { useState } from 'react';
import { activeTask, useResource } from '../api';
import { ErrorBanner, Section } from '../components';
import type { Task, TaskTarget } from '../models';
import { DeliveryStepTrack, type DeliveryStepTrackItem } from './DeliveryStepTrack';

export interface DeliveryTaskStep {
  id: string;
  serverId: string;
  key: string;
  name: string;
  order: number;
  status: string;
  exitCode: number | null;
}

export interface DeliveryLogSelection {
  step: DeliveryTaskStep;
  targetName: string;
}

export default function DeliveryTaskStages({
  task,
  graph,
  targets,
  steps,
  stepsError,
  retrySteps,
  selectedStepId,
  onLog,
}: {
  task: Task;
  graph: NonNullable<Task['pipelineGraph']>;
  targets: TaskTarget[];
  steps?: DeliveryTaskStep[];
  stepsError: string;
  retrySteps: () => void;
  selectedStepId?: string;
  onLog: (selection: DeliveryLogSelection) => void;
}) {
  const [serverId, setServerId] = useState('');
  const deployStage = task.deliveryStage === 'DEPLOY';
  const manager = !deployStage && graph.buildLocation === 'MANAGER';
  const selectedTarget = targets.find((target) => target.serverId === serverId) ?? targets[0];
  const linkedTaskPath = task.deploymentTaskId ? `/tasks/${task.deploymentTaskId}` : null;
  const release = useResource<Task>(linkedTaskPath, 2000);
  const releaseTargets = useResource<TaskTarget[]>(
    linkedTaskPath && !manager ? `${linkedTaskPath}/targets` : null,
    2000,
  );
  const scopedSteps = new Map(
    (steps ?? [])
      .filter(
        (step) =>
          step.key.startsWith('node:') && (manager || step.serverId === selectedTarget?.serverId),
      )
      .map((step) => [step.key.slice('node:'.length), step]),
  );
  const targetName = manager ? '管理端' : (selectedTarget?.serverName ?? '目标服务器');
  const selectedNode = Array.from(scopedSteps).find(([, step]) => step.id === selectedStepId)?.[0];

  const items = graph.nodes.map<DeliveryStepTrackItem>((node) => {
    const step = scopedSteps.get(node.id);
    if (step) {
      return {
        ...node,
        status: step.status,
        logAvailable: true,
        detail: step.exitCode == null ? undefined : `退出码 ${step.exitCode}`,
      };
    }
    if (deployStage && node.type !== 'DEPLOY') {
      return task.sourceBuildTaskId
        ? { ...node, href: `#/tasks/${task.sourceBuildTaskId}`, statusLabel: '查看来源构建' }
        : { ...node, status: 'SKIPPED', selectable: false };
    }
    if (!deployStage && node.type === 'DEPLOY') {
      if (linkedTaskPath) {
        const deployServer = releaseTargets.data?.find(
          (target) => target.serverId === selectedTarget?.serverId,
        );
        const omitted = selectedTarget && releaseTargets.data && !deployServer;
        return {
          ...node,
          href: `#${linkedTaskPath}`,
          status: omitted ? 'SKIPPED' : (deployServer?.status ?? release.data?.status),
          statusLabel: omitted
            ? '该目标未进入部署'
            : release.data?.approvalStatus === 'PENDING'
              ? '待审批'
              : release.data
                ? undefined
                : '查看部署任务',
        };
      }
      return task.deployAfterBuild && activeTask(task.status)
        ? { ...node, statusLabel: '等待构建与归档', selectable: false }
        : { ...node, status: 'SKIPPED', selectable: false };
    }
    if (task.approvalStatus === 'PENDING')
      return { ...node, statusLabel: '待审批', selectable: false };
    if (!steps)
      return {
        ...node,
        statusLabel: stepsError ? '状态暂不可用' : '读取状态中',
        selectable: false,
      };
    const waiting = activeTask(manager ? task.status : (selectedTarget?.status ?? task.status));
    return { ...node, status: waiting ? 'PENDING' : 'SKIPPED', selectable: false };
  });

  return (
    <Section
      title="构建与部署步骤"
      subtitle={deployStage ? '独立部署阶段' : '构建与归档阶段'}
      className="delivery-task-graph"
      action={
        !manager && targets.length > 1 ? (
          <label className="delivery-task-scope">
            <span>执行位置</span>
            <select
              value={selectedTarget?.serverId}
              onChange={(event) => setServerId(event.target.value)}
            >
              {targets.map((target) => (
                <option key={target.id} value={target.serverId}>
                  {target.serverName}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="tag">{targetName}</span>
        )
      }
    >
      <ErrorBanner error={stepsError} retry={retrySteps} />
      <DeliveryStepTrack
        items={items}
        selectedId={selectedNode}
        onSelect={(id) => {
          const step = scopedSteps.get(id);
          if (step) onLog({ step, targetName });
        }}
      />
    </Section>
  );
}
