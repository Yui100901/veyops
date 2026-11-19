import { ArrowUpRight } from 'lucide-react';
import './project-cards.css';

export interface ProjectAccessLink {
  id: string;
  name: string;
  url: string;
  serviceName?: string | null;
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

export function ProjectAccessLinks({ addresses }: { addresses: ProjectAccessLink[] }) {
  const links = addresses.flatMap((address) => {
    const href = projectAccessUrl(address.url);
    return href ? [{ ...address, href }] : [];
  });
  if (!links.length) return null;
  return (
    <div className="project-access">
      <h4>访问链接</h4>
      <ul>
        {links.map((link) => (
          <li key={link.id}>
            <a href={link.href} target="_blank" rel="noopener noreferrer" title={link.href}>
              <span>
                {link.name}
                {(link.serviceName || link.environmentName) && (
                  <small>
                    {[link.serviceName, link.environmentName].filter(Boolean).join(' · ')}
                  </small>
                )}
              </span>
              <ArrowUpRight size={16} aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
