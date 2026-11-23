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

type AccessLink = ProjectAccessLink & { href: string };

async function copyUrl(url: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return true;
    }
  } catch {
    // LAN deployments over HTTP can still copy from a selected field.
  }
  const field = document.createElement('textarea');
  const focused = document.activeElement;
  field.value = url;
  field.readOnly = true;
  field.style.cssText = 'position: fixed; inset: 0 auto auto 0; opacity: 0';
  document.body.append(field);
  try {
    field.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
}

function AccessLinkList({
  links,
  onCopy,
}: {
  links: AccessLink[];
  onCopy: (link: AccessLink) => void;
}) {
  return (
    <ul className="project-access-links">
      {links.map((link) => (
        <li className="project-access-actions" key={link.id}>
          <a
            className="project-access-link"
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`打开「${link.name}」（新标签页）`}
          >
            <span>
              <strong>{link.name}</strong>
              <code className="project-access-url">{link.url}</code>
            </span>
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
          <button
            type="button"
            className="project-access-copy"
            aria-label={`复制「${link.name}」的地址`}
            onClick={() => void onCopy(link)}
          >
            <Copy size={15} aria-hidden="true" />
            复制
          </button>
        </li>
      ))}
    </ul>
  );
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
  const [feedback, setFeedback] = useState('');
  const links = addresses.flatMap((address) => {
    const href = projectAccessUrl(address.url);
    return href ? [{ ...address, href }] : [];
  });
  if (!links.length) return showEmpty ? <p className="project-access-empty">暂无访问地址</p> : null;
  async function copyAddress(link: ProjectAccessLink) {
    const copied = await copyUrl(link.url);
    setFeedback(copied ? `已复制「${link.name}」的地址` : '复制失败，可选中地址手动复制。');
  }
  const services = new Map<string | null, AccessLink[]>();
  if (serviceHref) {
    for (const link of links) {
      const id = link.serviceId || null;
      const group = services.get(id);
      if (group) group.push(link);
      else services.set(id, [link]);
    }
  }
  return (
    <div className="project-access">
      <h4>访问地址</h4>
      {serviceHref ? (
        <ul className="project-access-services">
          {[...services].map(([id, group]) => (
            <li className="project-access-service" key={id ?? ''}>
              <h5>
                {id ? (
                  <a className="text-link" href={serviceHref(id)}>
                    {group[0]?.serviceName || '打开服务'}
                  </a>
                ) : (
                  '其他地址'
                )}
              </h5>
              <AccessLinkList links={group} onCopy={copyAddress} />
            </li>
          ))}
        </ul>
      ) : (
        <AccessLinkList links={links} onCopy={copyAddress} />
      )}
      {feedback && (
        <p className="project-access-feedback" role="status">
          {feedback}
        </p>
      )}
    </div>
  );
}
