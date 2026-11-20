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
import type { DeliveryStepNode, DeliveryStepType } from '../models';
import './delivery-step-track.css';

export type { DeliveryStepType } from '../models';

export const deliveryActionLabels: Record<DeliveryStepType, string> = {
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

export interface DeliveryStepTrackItem extends DeliveryStepNode {
  status?: string;
  statusLabel?: string;
  logAvailable?: boolean;
  detail?: string;
  href?: string;
  selectable?: boolean;
}

export function DeliveryStepTrack({
  items,
  onSelect,
  selectedId,
}: {
  items: DeliveryStepTrackItem[];
  onSelect?: (id: string) => void;
  selectedId?: string;
}) {
  return (
    <ol className="delivery-step-track" aria-label="任务步骤">
      {items.map((item, index) => {
        const Icon = icons[item.type];
        const content = (
          <>
            <span className="delivery-step-track-kind">
              <Icon size={16} aria-hidden="true" /> {deliveryActionLabels[item.type]}
            </span>
            <strong className="delivery-step-track-name">{item.name}</strong>
            {(item.status || item.statusLabel || item.logAvailable) && (
              <span className="delivery-step-track-status">
                {item.statusLabel ? (
                  <span>{item.statusLabel}</span>
                ) : item.status ? (
                  <Status value={item.status} />
                ) : null}
                {item.logAvailable && <Terminal size={15} role="img" aria-label="日志" />}
              </span>
            )}
            {item.detail && <small className="delivery-step-track-detail">{item.detail}</small>}
          </>
        );
        return (
          <li className="delivery-step-track-item" key={item.id}>
            {index > 0 && <ArrowRight className="delivery-step-track-edge" aria-hidden="true" />}
            {item.href ? (
              <a className="delivery-step-track-card" href={item.href}>
                {content}
              </a>
            ) : onSelect && item.selectable !== false ? (
              <button
                type="button"
                className="delivery-step-track-card"
                aria-pressed={selectedId === item.id}
                onClick={() => onSelect(item.id)}
              >
                {content}
              </button>
            ) : (
              <div className="delivery-step-track-card">{content}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
