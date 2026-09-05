'use client';

/**
 * The primary navigation row.
 *
 * A client component only because the active item depends on the current
 * path. Everything else in the shell stays on the server, so the organization
 * name and the reviewer's email never cross into the browser bundle as props
 * that have to be serialised on every navigation.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/provider';
import { NAV_ITEMS, isActive } from './nav-items';

export function PrimaryNav() {
  const t = useT();
  const pathname = usePathname();

  return (
    <nav aria-label={t('shell.primaryNavLabel')} className="border-b border-zinc-200 bg-white">
      <ul className="mx-auto flex max-w-4xl gap-1 px-4">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                // `aria-current` rather than colour alone. The underline below
                // is the same information for anyone who cannot distinguish
                // zinc-900 from zinc-500, and this is the same information
                // again for anyone not looking at it at all.
                aria-current={active ? 'page' : undefined}
                className={`inline-block border-b-2 px-3 py-3 text-sm font-medium transition ${
                  active
                    ? 'border-zinc-800 text-zinc-900'
                    : 'border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800'
                }`}
              >
                {t(item.labelKey)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
