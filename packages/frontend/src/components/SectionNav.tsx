import Link from "next/link";
import type { ReactNode } from "react";

export interface SectionNavItem {
  current: boolean;
  href: string;
  label: ReactNode;
}

/** Navigation between whole page sections, with the current URL-backed section named explicitly. */
export function SectionNav({
  label,
  items,
  replace = false,
}: {
  label: string;
  items: SectionNavItem[];
  replace?: boolean;
}) {
  return (
    <nav className="section-nav" aria-label={label}>
      <ul>
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              replace={replace}
              aria-current={item.current ? "page" : undefined}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
