import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Ellipsis } from 'lucide-react';
import './action-menu.css';

type MenuLink = { label: string; href: string };

export function ActionMenu({ label, links }: { label: string; links: MenuLink[] }) {
  if (!links.length) return null;

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="button secondary small action-menu-trigger"
          aria-label={label}
        >
          <Ellipsis size={17} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="action-menu"
          align="end"
          sideOffset={5}
          collisionPadding={8}
        >
          {links.map((link) => (
            <DropdownMenu.Item key={link.label} asChild>
              <a className="action-menu-link" href={link.href}>
                {link.label}
              </a>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
