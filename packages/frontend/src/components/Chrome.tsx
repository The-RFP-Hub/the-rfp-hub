"use client";

import { BrandMark } from "@/components/BrandMark";
import { DecorativeIcon, type HeroIcon, IconLabel } from "@/components/IconLabel";
import { GuardedLink, useNavigationBlocker } from "@/components/NavigationBlocker";
/**
 * The application shell: navigation, session state, and the one place a page's access is gated.
 *
 * THE HEADER IS AN ORIENTATION STRIP, NOT A SITEMAP. Directory discovery, the signed-in dashboard
 * and (when granted) review queues stay one click away because they are the high-frequency jobs.
 * The complete information architecture lives in one disclosure, explicitly grouped as Browse,
 * My work, Administration, Account and Help. That keeps the distinction between ordinary account
 * work and staff power without asking eleven links to wrap into an accidental grid. Duplicates
 * remains a view of listings reached from `/listings`, not another destination competing here.
 *
 * THE SAME ORDER SURVIVES EVERY WIDTH. At the content-driven compact breakpoint, the short primary
 * row moves into the disclosure, Browse becomes a full group and the panel adapts from two columns
 * to one on a phone. Nothing disappears; only the amount shown before the reader asks for it
 * changes. The panel overlays content so opening navigation never moves the page underneath it.
 *
 * THE ACCOUNT GROUP IS RENDERED FROM `GET /v1/me`, not from anything this client decided.
 * `canReview` and `canAdmin` come back with the account, so the staff links appear for the people
 * who hold those capabilities and for nobody else. Hiding a link is presentation, never protection —
 * every one of those routes is enforced on the API, and a hand-typed URL reaches a page that
 * renders the API's own 403.
 */
import { AuthUnavailable, ErrorState, Loading } from "@/components/states";
import {
  GOVERNANCE,
  HOW_IT_WORKS,
  HOW_IT_WORKS_ROLES,
  PUBLISHERS,
  REPOSITORY,
  STANDARD,
  apiDocsUrl,
} from "@/lib/links";
import { NOTIFICATIONS_CHANGED_EVENT } from "@/lib/notification-events";
import type { GateCopy } from "@/lib/presentation";
import { useResource } from "@/lib/resource";
import { useApi, useSession } from "@/lib/session";
import type { Me } from "@/lib/types";
import {
  ArrowLeftOnRectangleIcon,
  ArrowRightOnRectangleIcon,
  ArrowTopRightOnSquareIcon,
  BellIcon,
  BookOpenIcon,
  BuildingOffice2Icon,
  ChartBarSquareIcon,
  CheckBadgeIcon,
  ChevronDownIcon,
  ClipboardDocumentCheckIcon,
  DocumentTextIcon,
  KeyIcon,
  ListBulletIcon,
  UserCircleIcon,
  UsersIcon,
} from "@heroicons/react/20/solid";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

interface NavItem {
  href: string;
  label: string;
  icon: HeroIcon;
  /** Whole-account unread count. Zero/undefined renders no count marker. */
  badge?: number;
  /** Which capability the API reported. `undefined` means "any signed-in account". */
  requires?: (me: Me) => boolean;
}

/** Readable to everybody, session or not. */
const PUBLIC_NAV: NavItem[] = [
  { href: "/", label: "Directory", icon: ListBulletIcon },
  { href: PUBLISHERS, label: "Publishers", icon: CheckBadgeIcon },
  { href: HOW_IT_WORKS, label: "How it works", icon: BookOpenIcon },
];

/**
 * This account's own things. `API keys` sits directly under `Account` because that is what it is —
 * a credential belonging to the account — even though it keeps its own route.
 *
 * A FUNCTION RATHER THAN A CONSTANT, because one of these items is derived from the account: an
 * organization is a place this account can act, and it belongs beside its listings rather than
 * behind two clicks on the account page.
 */
function accountNav(me: Me, unreadCount: number | null): NavItem[] {
  const organization = organizationNav(me);
  return [
    { href: "/dashboard", label: "Dashboard", icon: ChartBarSquareIcon },
    { href: "/listings", label: "Your listings", icon: DocumentTextIcon },
    {
      href: "/notifications",
      label: "Notifications",
      icon: BellIcon,
      badge: unreadCount ?? undefined,
    },
    organization,
    { href: "/account", label: "Account", icon: UserCircleIcon },
    {
      href: "/keys",
      label: "API keys",
      icon: KeyIcon,
      requires: (item) => item.canManageKeys,
    },
  ];
}

/**
 * The organization link.
 *
 * ONE MEMBERSHIP GETS ITS OWN NAME AND ITS OWN ADDRESS. A landing page listing exactly one row is a
 * click that answers nothing, and "Organizations" as a label for a single named thing is vaguer than
 * the thing itself. Several memberships need somewhere to choose between them. An account with no
 * memberships still gets the index: its empty state explains how publishing rights are granted,
 * and keeping that route in the signed-in navigation makes it discoverable before the first grant.
 *
 * The label for the single case is publisher-supplied text. It is rendered as a text child like
 * every other untrusted string in this package, never as markup.
 */
export function organizationNav(me: Me): NavItem {
  const [only] = me.memberships;
  if (!only) {
    return { href: "/organizations", label: "Organizations", icon: BuildingOffice2Icon };
  }
  if (me.memberships.length === 1) {
    return {
      href: `/organizations/${encodeURIComponent(only.slug)}`,
      label: only.name,
      icon: BuildingOffice2Icon,
    };
  }
  return { href: "/organizations", label: "Organizations", icon: BuildingOffice2Icon };
}

/**
 * Hub staff. Both labels say what the destination IS rather than what it is called internally:
 * "Review" was a verb with no object, and "Administration" named a department rather than the two
 * things the page actually does.
 */
const STAFF_NAV: NavItem[] = [
  {
    href: "/review",
    label: "Review queues",
    icon: ClipboardDocumentCheckIcon,
    requires: (me) => me.canReview,
  },
  {
    href: "/admin",
    label: "Accounts & roles",
    icon: UsersIcon,
    requires: (me) => me.canAdmin,
  },
];

/**
 * Whether a nav item is the section the reader is in.
 *
 * BY PREFIX, not by equality. `/listings/acme:round-4/edit` is inside Listings, and an exact match
 * left the whole navigation unmarked on every page except a section's index — so the one moment a
 * reader most needs to know where they are (three levels into a form) was the one moment nothing
 * said. `/` is exact by necessity: it prefixes everything.
 */
export function isCurrent(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({
  items,
  pathname,
  me,
  className,
  showIcons = true,
}: {
  items: NavItem[];
  pathname: string;
  me: Me | null;
  className: string;
  showIcons?: boolean;
}) {
  const visible = items.filter((item) => !item.requires || (me !== null && item.requires(me)));
  if (visible.length === 0) return null;
  return (
    <ul className={className}>
      {visible.map((item) => (
        <li key={item.href}>
          <GuardedLink
            href={item.href}
            aria-current={isCurrent(pathname, item.href) ? "page" : undefined}
          >
            {showIcons ? (
              <IconLabel icon={item.icon}>
                {item.label}
                {item.badge ? (
                  <span
                    className="shell-nav-count"
                    aria-label={`${item.badge} unread notification${item.badge === 1 ? "" : "s"}`}
                  >
                    {item.badge}
                  </span>
                ) : null}
              </IconLabel>
            ) : (
              item.label
            )}
          </GuardedLink>
        </li>
      ))}
    </ul>
  );
}

function NavSection({
  label,
  items,
  pathname,
  me,
  className,
}: {
  label: string;
  items: NavItem[];
  pathname: string;
  me: Me;
  className?: string;
}) {
  const visible = items.some((item) => !item.requires || item.requires(me));
  if (!visible) return null;
  const headingId = `shell-nav-${label.toLowerCase().replaceAll(/[^a-z]+/g, "-")}`;
  return (
    <section
      className={["shell-nav-section", className].filter(Boolean).join(" ")}
      aria-labelledby={headingId}
    >
      <h2 id={headingId} className="shell-nav-heading">
        {label}
      </h2>
      <NavLinks items={items} pathname={pathname} me={me} className="shell-nav-group" />
    </section>
  );
}

export function Chrome({ children }: { children: ReactNode }) {
  const session = useSession();
  const api = useApi();
  const pathname = usePathname() ?? "/";
  const me = session.me.status === "ready" ? session.me.data : null;
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const accountMenuButtonRef = useRef<HTMLButtonElement>(null);
  const { confirmNavigation } = useNavigationBlocker();
  // Mount + route changes only. This package deliberately has no polling layer; a mutation made in
  // this tab dispatches the local event below so the count can settle immediately.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname intentionally invalidates the loader on navigation
  const loadUnread = useCallback(
    () => api.me.notifications({ unread: true, limit: 1 }),
    [api, pathname],
  );
  const unread = useResource(loadUnread, { enabled: me !== null });
  const unreadCount = unread.state.status === "ready" ? unread.state.data.unreadCount : null;

  useEffect(() => {
    const refresh = () => unread.reload();
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
  }, [unread.reload]);

  // A route change is the event: closing the compact menu keeps the destination from inheriting an
  // expanded header. The pathname is deliberately read only as this effect's invalidation key.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname intentionally closes the menu on navigation
  useEffect(() => setAccountMenuOpen(false), [pathname]);

  // This is a disclosure, not a modal: the page remains usable, while Escape and an outside click
  // provide the two conventional ways to dismiss it without choosing a destination. Returning
  // focus on Escape preserves the keyboard reader's place in the header.
  useEffect(() => {
    if (!accountMenuOpen) return;

    const closeFromOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !headerRef.current?.contains(event.target)) {
        setAccountMenuOpen(false);
      }
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAccountMenuOpen(false);
      accountMenuButtonRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [accountMenuOpen]);

  const accountItems = me ? accountNav(me, unreadCount) : [];
  const dashboard = accountItems.find((item) => item.href === "/dashboard");
  const listings = accountItems.find((item) => item.href === "/listings");
  const notifications = accountItems.find((item) => item.href === "/notifications");
  const organization = accountItems.find((item) => item.href.startsWith("/organizations"));
  const account = accountItems.find((item) => item.href === "/account");
  const keys = accountItems.find((item) => item.href === "/keys");

  const primaryItems = session.authenticated
    ? [PUBLIC_NAV[0], PUBLIC_NAV[1], dashboard, STAFF_NAV[0]].filter(
        (item): item is NavItem => item !== undefined,
      )
    : PUBLIC_NAV;
  const identity = me ? (me.handle ?? `account ${me.accountId}`) : "your account";

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header
        ref={headerRef}
        className="shell-header"
        data-authenticated={session.authenticated ? "true" : "false"}
      >
        <GuardedLink href="/" className="brand">
          <BrandMark className="brand-mark" />
          <span className="brand-text">
            RFP Hub
            <span className="brand-tagline">an open index of funding opportunities</span>
          </span>
        </GuardedLink>

        <nav className="shell-nav" aria-label="Sections">
          <NavLinks
            items={primaryItems}
            pathname={pathname}
            me={me}
            className="shell-nav-primary"
            showIcons={false}
          />

          {session.error ? (
            <span className="muted">sign-in unavailable</span>
          ) : !session.ready ? (
            <span className="muted">restoring session…</span>
          ) : session.authenticated ? (
            <>
              {notifications ? (
                <GuardedLink
                  href={notifications.href}
                  className="shell-notifications"
                  aria-current={isCurrent(pathname, notifications.href) ? "page" : undefined}
                  aria-label={`Notifications${
                    notifications.badge
                      ? ` ${notifications.badge} unread notification${notifications.badge === 1 ? "" : "s"}`
                      : ""
                  }`}
                >
                  <IconLabel icon={BellIcon}>
                    <span className="shell-notifications-label">Notifications</span>
                    {notifications.badge ? (
                      <span className="shell-nav-count" aria-hidden="true">
                        {notifications.badge}
                      </span>
                    ) : null}
                  </IconLabel>
                </GuardedLink>
              ) : null}
              <button
                type="button"
                ref={accountMenuButtonRef}
                className="shell-menu-toggle"
                aria-expanded={accountMenuOpen}
                aria-controls="account-navigation"
                aria-label={`${accountMenuOpen ? "Close" : "Open"} navigation menu for ${identity}`}
                onClick={() => setAccountMenuOpen((open) => !open)}
              >
                <DecorativeIcon icon={UserCircleIcon} className="shell-menu-user" />
                <span className="shell-menu-label shell-menu-label-wide">{identity}</span>
                <span className="shell-menu-label shell-menu-label-compact">Menu</span>
                <DecorativeIcon icon={ChevronDownIcon} className="shell-menu-caret" />
              </button>
            </>
          ) : (
            <button type="button" className="shell-login" onClick={session.login}>
              <IconLabel icon={ArrowRightOnRectangleIcon}>Log in</IconLabel>
            </button>
          )}

          {session.authenticated ? (
            <div className="shell-account-panel" id="account-navigation" hidden={!accountMenuOpen}>
              {me ? (
                <>
                  <NavSection
                    label="Browse"
                    items={PUBLIC_NAV}
                    pathname={pathname}
                    me={me}
                    className="shell-nav-section-compact"
                  />
                  <div className="shell-account-columns">
                    <div className="shell-account-column">
                      <NavSection
                        label="My work"
                        items={[dashboard, listings, organization].filter(
                          (item): item is NavItem => item !== undefined,
                        )}
                        pathname={pathname}
                        me={me}
                      />
                      <NavSection
                        label="Administration"
                        items={STAFF_NAV}
                        pathname={pathname}
                        me={me}
                      />
                    </div>
                    <div className="shell-account-column">
                      <NavSection
                        label="Account"
                        items={[notifications, account, keys].filter(
                          (item): item is NavItem => item !== undefined,
                        )}
                        pathname={pathname}
                        me={me}
                      />
                      <NavSection
                        label="Help"
                        items={[PUBLIC_NAV[2]].filter(
                          (item): item is NavItem => item !== undefined,
                        )}
                        pathname={pathname}
                        me={me}
                        className="shell-nav-section-wide"
                      />
                    </div>
                  </div>
                  <div className="shell-account-session">
                    <span className="muted">Signed in as {identity}</span>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirmNavigation()) void session.logout();
                      }}
                    >
                      <IconLabel icon={ArrowLeftOnRectangleIcon}>Log out</IconLabel>
                    </button>
                  </div>
                </>
              ) : (
                <span className="muted">loading account…</span>
              )}
            </div>
          ) : null}
        </nav>
      </header>

      <main id="main-content" className="shell-main" tabIndex={-1}>
        {children}
      </main>

      <footer className="shell-footer">
        <GuardedLink href="/" className="shell-footer-brand" aria-label="RFP Hub home">
          <BrandMark className="footer-mark" />
          RFP Hub
        </GuardedLink>
        <GuardedLink href={HOW_IT_WORKS}>About</GuardedLink>
        <GuardedLink href={PUBLISHERS}>Publishers</GuardedLink>
        <a href={STANDARD} target="_blank" rel="noopener noreferrer">
          <IconLabel icon={ArrowTopRightOnSquareIcon} position="end">
            The Standard
          </IconLabel>
        </a>
        {/*
         * The API this build talks to, not a hard-coded one. A preview deployment linking at
         * production's documentation would be documenting a different API than the one its own
         * pages are reading.
         */}
        <a href={apiDocsUrl(api.baseUrl)} target="_blank" rel="noopener noreferrer">
          <IconLabel icon={ArrowTopRightOnSquareIcon} position="end">
            API &amp; data
          </IconLabel>
        </a>
        <a href={REPOSITORY} target="_blank" rel="noopener noreferrer">
          <IconLabel icon={ArrowTopRightOnSquareIcon} position="end">
            GitHub
          </IconLabel>
        </a>
        <a href={GOVERNANCE} target="_blank" rel="noopener noreferrer">
          Governance
        </a>
        <GuardedLink href="/privacy">Privacy</GuardedLink>
        <GuardedLink href="/terms">Terms</GuardedLink>
        <span className="shell-footer-note">Open data · CC0 exports · MIT code</span>
      </footer>
    </div>
  );
}

/**
 * Wrap a page that needs a signed-in account.
 *
 * The three states are distinct on purpose: "the SDK has not finished restoring the session" is not
 * "you are logged out", and showing a login prompt during the first is how a dashboard flashes a
 * login screen at somebody who is already signed in.
 */
export function RequireSession({
  children,
  capability,
  gate,
}: {
  children: (me: Me) => ReactNode;
  /** Route-specific signed-out wording. Omitted consumers retain the established generic gate. */
  gate?: GateCopy;
  /** An extra capability gate, mirrored from the API's own answer. */
  capability?: {
    needs: (me: Me) => boolean;
  } & GateCopy;
}) {
  const session = useSession();

  if (session.error) return <AuthUnavailable error={session.error} />;
  if (!session.ready) return <Loading what="your session" />;
  if (!session.authenticated) {
    return (
      <div className="state empty">
        <p className="empty-title">{gate?.title ?? "You are not signed in."}</p>
        <p className="muted">
          {gate?.detail ??
            "This page shows one account’s own listings and traffic, so it needs a session."}
        </p>
        <p className="row">
          <button type="button" className="button-primary" onClick={session.login}>
            <IconLabel icon={ArrowRightOnRectangleIcon}>Log in</IconLabel>
          </button>
          <GuardedLink href={HOW_IT_WORKS}>What an account is for</GuardedLink>
        </p>
      </div>
    );
  }
  if (session.me.status === "idle" || session.me.status === "loading") {
    return <Loading what="your account" />;
  }
  if (session.me.status === "error") {
    return (
      <ErrorState
        error={session.me.error}
        what="your account"
        onRetry={session.reloadMe}
        onLogin={session.login}
      />
    );
  }

  const me = session.me.data;
  if (capability && !capability.needs(me)) {
    return (
      <div className="state empty">
        <p className="empty-title">{capability.title}</p>
        <p className="muted">{capability.detail}</p>
        <p className="row">
          <GuardedLink href="/account">Check your account</GuardedLink>
          <GuardedLink href={HOW_IT_WORKS_ROLES}>See who can do what</GuardedLink>
        </p>
      </div>
    );
  }
  return <>{children(me)}</>;
}
