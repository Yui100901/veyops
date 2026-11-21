import { useState } from 'react';
import { ArrowUpRight, Copy } from 'lucide-react';
import './project-cards.css';

export interface ProjectAccessLink {
  id: string;
  name: string;
  url: string;
  serviceName?: string | null;
  serviceId?: string | null;
  environmentName?: string | null;
}

export function projectAccessUrl(value: string) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
      return url.href;
  } catch {
    return undefined;
  }
}

export function ProjectAccessLinks({
  addresses,
  serviceHref,
  showEmpty = false,
}: {
  addresses: ProjectAccessLink[];
  serviceHref?: (serviceId: string) => string;
  showEmpty?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState('');
  const links = addresses.flatMap((address) => {
    const href = projectAccessUrl(address.url);
    return href ? [{ ...address, href }] : [];
  });
  if (!links.length) return showEmpty ? <p className="project-access-empty">暂无访问地址</p> : null;
  async function copyAddress(link: ProjectAccessLink) {
    try {
      await navigator.clipboard.writeText(link.url);
      setFeedback(`已复制「${link.name}」的地址`);
    } catch {
      setExpanded(true);
      setFeedback('复制失败。请选择下方完整地址手动复制。');
    }
  }
  return (
    <div className="project-access">
      <div className="project-access-toolbar">
        <h4>访问地址</h4>
        <button
          type="button"
          className="button secondary small"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起完整地址' : '显示完整地址'}
        </button>
      </div>
      <ul className={expanded ? 'project-access-expanded' : undefined}>
        {links.map((link) => (
          <li key={link.id}>
            <div className="project-access-actions">
              <a
                className="project-access-link"
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                title={link.url}
              >
                <span>{link.name}</span>
                <ArrowUpRight size={16} aria-hidden="true" />
              </a>
              <button
                type="button"
                className="button secondary small"
                aria-label={`复制「${link.name}」的地址`}
                onClick={() => void copyAddress(link)}
              >
                <Copy size={15} aria-hidden="true" /> 复制
              </button>
            </div>
            {link.serviceId && serviceHref && (
              <a className="text-link project-access-service" href={serviceHref(link.serviceId)}>
                {link.serviceName || '打开服务'}
              </a>
            )}
            {expanded && <code className="project-access-url">{link.url}</code>}
          </li>
        ))}
      </ul>
      {feedback && (
        <p className="project-access-feedback" role="status">
          {feedback}
        </p>
      )}
    </div>
  );
}
