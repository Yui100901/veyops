import { ArrowRight, Terminal, Workflow } from 'lucide-react';
import { formatTime } from '../../api';
import { Status } from '../../components';
import type { Task } from '../../models';
import { executionFlowTaskPath } from '../execution-graph/graph-workbench-context';

const taskTypeNames: Record<string, string> = {
  COMMAND: '临时命令',
  OPERATION_PLAN: '运维方案',
  PIPELINE: '构建与部署',
  GRAPH_CHECKOUT: '执行图源码拉取',
  EXECUTION_FLOW: '执行流',
};

export function taskTypeLabel(task: Task) {
  if (task.executionMode === 'DEPLOY_ARTIFACT') return '产物部署';
  if (task.type !== 'PIPELINE') return taskTypeNames[task.type] ?? task.type;
  if (task.deliveryStage === 'BUILD' && task.deployAfterBuild) return '构建阶段';
  if (task.executionMode === 'BUILD_ONLY') return '构建';
  return '构建并部署';
}

export function TaskTable({ tasks, compact = false }: { tasks: Task[]; compact?: boolean }) {
  return (
    <div className="table-scroll">
      <table className={compact ? 'dashboard-task-compact' : undefined}>
        <thead>
          <tr>
            <th scope="col">任务名称</th>
            {!compact && <th scope="col">类型</th>}
            <th scope="col">状态</th>
            {!compact && <th scope="col">创建时间</th>}
            {!compact && <th />}
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const type = taskTypeLabel(task);
            const executionFlow = task.type === 'EXECUTION_FLOW';
            const href =
              executionFlow && task.projectId
                ? '#' + executionFlowTaskPath(task.projectId, task.flowRunId ?? task.id)
                : `#/tasks/${task.id}`;
            const Icon = executionFlow ? Workflow : Terminal;
            return (
              <tr key={`${task.type}:${task.id}`}>
                <td>
                  <a href={href} className="table-name">
                    {!compact && (
                      <span className="tiny-icon">
                        <Icon size={15} aria-hidden="true" />
                      </span>
                    )}
                    {task.name}
                  </a>
                  {!compact && executionFlow && task.projectName && (
                    <small className="cell-sub">{task.projectName}</small>
                  )}
                  {compact && (
                    <small className="cell-sub">
                      {type} · {formatTime(task.finishedAt ?? task.createdAt)}
                    </small>
                  )}
                </td>
                {!compact && (
                  <td>
                    <span className="muted">{type}</span>
                  </td>
                )}
                <td>
                  {task.approvalStatus === 'PENDING' ? (
                    <span className="tag">待审批</span>
                  ) : (
                    <Status value={task.status} />
                  )}
                </td>
                {!compact && <td className="muted nowrap">{formatTime(task.createdAt)}</td>}
                {!compact && (
                  <td>
                    <a href={href} className="row-link" aria-label={`查看任务 ${task.name}`}>
                      <ArrowRight size={16} />
                    </a>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
