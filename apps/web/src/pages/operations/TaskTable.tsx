import { ArrowRight, Terminal } from 'lucide-react';
import { formatTime } from '../../api';
import { Status } from '../../components';
import type { Task } from '../../models';

const taskTypeNames: Record<string, string> = {
  COMMAND: '临时命令',
  OPERATION_PLAN: '运维方案',
  PIPELINE: '构建与部署',
  GRAPH_CHECKOUT: '执行图源码拉取',
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
            return (
              <tr key={task.id}>
                <td>
                  <a href={`#/tasks/${task.id}`} className="table-name">
                    {!compact && (
                      <span className="tiny-icon">
                        <Terminal size={15} />
                      </span>
                    )}
                    {task.name}
                  </a>
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
                    <a
                      href={`#/tasks/${task.id}`}
                      className="row-link"
                      aria-label={`查看任务 ${task.name}`}
                    >
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
