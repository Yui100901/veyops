import {
  ArrowRight,
  Boxes,
  FlaskConical,
  GitBranch,
  Hammer,
  Package,
  Rocket,
  Settings2,
  Terminal,
} from 'lucide-react';
import { Status } from '../components';
import type { PipelineGraphNode, PipelineNodeType } from '../models';
import './pipeline-node-graph.css';

export type { PipelineNodeType } from '../models';

export const pipelineNodeLabels: Record<PipelineNodeType, string> = {
  CHECKOUT: '获取源码',
  ENVIRONMENT: '设置环境',
  INSTALL: '安装依赖',
  BUILD: '构建',
  TEST: '测试',
  SHELL: '运行脚本',
  PACKAGE: '打包归档',
  DEPLOY: '部署',
};

const icons = {
  CHECKOUT: GitBranch,
  ENVIRONMENT: Settings2,
  INSTALL: Boxes,
  BUILD: Hammer,
  TEST: FlaskConical,
  SHELL: Terminal,
  PACKAGE: Package,
  DEPLOY: Rocket,
};

export interface PipelineNodeGraphItem extends PipelineGraphNode {
  status?: string;
  statusLabel?: string;
  logAvailable?: boolean;
  detail?: string;
  href?: string;
  selectable?: boolean;
}

export function PipelineNodeGraph({
  items,
  onSelect,
  selectedId,
}: {
  items: PipelineNodeGraphItem[];
  onSelect?: (id: string) => void;
  selectedId?: string;
}) {
  return (
    <ol className="pipeline-node-graph" aria-label="流水线执行顺序">
      {items.map((item, index) => {
        const Icon = icons[item.type];
        const content = (
          <>
            <span className="pipeline-node-graph-kind">
              <Icon size={16} aria-hidden="true" /> {pipelineNodeLabels[item.type]}
            </span>
            <strong className="pipeline-node-graph-name">{item.name}</strong>
            {(item.status || item.statusLabel || item.logAvailable) && (
              <span className="pipeline-node-graph-status">
                {item.statusLabel ? (
                  <span>{item.statusLabel}</span>
                ) : item.status ? (
                  <Status value={item.status} />
                ) : null}
                {item.logAvailable && <Terminal size={15} role="img" aria-label="日志" />}
              </span>
            )}
            {item.detail && <small className="pipeline-node-graph-detail">{item.detail}</small>}
          </>
        );
        return (
          <li className="pipeline-node-graph-item" key={item.id}>
            {index > 0 && <ArrowRight className="pipeline-node-graph-edge" aria-hidden="true" />}
            {item.href ? (
              <a className="pipeline-node-graph-card" href={item.href}>
                {content}
              </a>
            ) : onSelect && item.selectable !== false ? (
              <button
                type="button"
                className="pipeline-node-graph-card"
                aria-pressed={selectedId === item.id}
                onClick={() => onSelect(item.id)}
              >
                {content}
              </button>
            ) : (
              <div className="pipeline-node-graph-card">{content}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
