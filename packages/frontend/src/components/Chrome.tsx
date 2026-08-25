"use client";

import { GuardedLink, useNavigationBlocker } from "@/components/NavigationBlocker";
/**
 * The application shell: navigation, session state, and the one place a page's access is gated.
 *
 * THE NAVIGATION IS GROUPED, NOT LISTED. There are three kinds of destination here and a flat row
 * of seven links says they are peers: what anybody may read (the directory, and the page explaining
 * who does what), what THIS ACCOUNT owns (its listings, its traffic, its keys), and what a HUB
 * STAFF ROLE may do (the review queues, accounts and roles). The last group grants power — a click
 * in it publishes somebody's listing or changes what an account may do — so it is separated by a
 * rule rather than by a comma. Duplicates left the top level with the same reasoning: it is a view
 * of your own listings, reached from `/listings`, not a seventh destination competing with them.
 *
 * THE ACCOUNT GROUP IS RENDERED FROM `GET /v1/me`, not from anything this client decided.
 * `canReview` and `canAdmin` come back with the account, so the staff links appear for the people
 * who hold those capabilities and for nobody else. Hiding a link is presentation, never protection —
 * every one of those routes is enforced on the API, and a hand-typed URL reaches a page that
 * renders the API's own 403.
 */
import { AuthUnavailable, ErrorState, Loading } from "@/components/states";
import { HOW_IT_WORKS, HOW_IT_WORKS_ROLES, REPOSITORY, STANDARD, apiDocsUrl } from "@/lib/links";
import type { GateCopy } from "@/lib/presentation";
import { useApi, useSession } from "@/lib/session";
import type { Me } from "@/lib/types";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

interface NavItem {
  href: string;
  label: string;
  /** Which capability the API reported. `undefined` means "any signed-in account". */
  requires?: (me: Me) => boolean;
}

/** Readable to everybody, session or not. */
const PUBLIC_NAV: NavItem[] = [
  { href: "/", label: "Directory" },
  { href: HOW_IT_WORKS, label: "How it works" },
];

/**
 * This account's own things. `API keys` sits directly under `Account` because that is what it is —
 * a credential belonging to the account — even though it keeps its own route.
 *
 * A FUNCTION RATHER THAN A CONSTANT, because one of these items is derived from the account: an
 * organisation is a place this account can act, and it belongs beside its listings rather than
 * behind two clicks on the account page.
 */
function accountNav(me: Me): NavItem[] {
  const organisation = organisationNav(me);
  return [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/listings", label: "Your listings" },
    ...(organisation ? [organisation] : []),
    { href: "/account", label: "Account" },
    { href: "/keys", label: "API keys", requires: (item) => item.canManageKeys },
  ];
}

/**
 * The organisation link, or none.
 *
 * ONE MEMBERSHIP GETS ITS OWN NAME AND ITS OWN ADDRESS. A landing page listing exactly one row is a
 * click that answers nothing, and "Organisations" as a label for a single named thing is vaguer than
 * the thing itself. Several memberships need somewhere to choose between them, and none gets no
 * link at all — an empty destination in a header is a promise the account cannot keep.
 *
 * The label for the single case is publisher-supplied text. It is rendered as a text child like
 * every other untrusted string in this package, never as markup.
 */
export function organisationNav(me: Me): NavItem | null {
  const [only] = me.memberships;
  if (!only) return null;
  if (me.memberships.length === 1) {
    return { href: `/organisations/${encodeURIComponent(only.slug)}`, label: only.name };
  }
  return { href: "/organisations", label: "Organisations" };
}

/**
 * Hub staff. Both labels say what the destination IS rather than what it is called internally:
 * "Review" was a verb with no object, and "Administration" named a department rather than the two
 * things the page actually does.
 */
const STAFF_NAV: NavItem[] = [
  { href: "/review", label: "Review queues", requires: (me) => me.canReview },
  { href: "/admin", label: "Accounts & roles", requires: (me) => me.canAdmin },
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

function NavGroup({ items, pathname, me }: { items: NavItem[]; pathname: string; me: Me | null }) {
  const visible = items.filter((item) => !item.requires || (me !== null && item.requires(me)));
  if (visible.length === 0) return null;
  return (
    <span className="shell-nav-group">
      {visible.map((item) => (
        <GuardedLink
          key={item.href}
          href={item.href}
          aria-current={isCurrent(pathname, item.href) ? "page" : undefined}
        >
          {item.label}
        </GuardedLink>
      ))}
    </span>
  );
}

export function Chrome({ children }: { children: ReactNode }) {
  const session = useSession();
  const api = useApi();
  const pathname = usePathname() ?? "/";
  const me = session.me.status === "ready" ? session.me.data : null;
  const { confirmNavigation } = useNavigationBlocker();

  return (
    <div className="shell">
      <header className="shell-header">
        <GuardedLink href="/" className="brand">
          RFP Hub
          <span className="brand-tagline">an open index of funding opportunities</span>
        </GuardedLink>

        <nav className="shell-nav" aria-label="Sections">
          <NavGroup items={PUBLIC_NAV} pathname={pathname} me={me} />
          {me ? <NavGroup items={accountNav(me)} pathname={pathname} me={me} /> : null}
          {me ? <NavGroup items={STAFF_NAV} pathname={pathname} me={me} /> : null}
        </nav>

        <div className="shell-session">
          {session.error ? (
            <span className="muted">sign-in unavailable</span>
          ) : !session.ready ? (
            <span className="muted">restoring session…</span>
          ) : session.authenticated ? (
            <>
              <span className="muted">{me ? (me.handle ?? `account ${me.accountId}`) : "…"}</span>
              <button
                type="button"
                onClick={() => {
                  if (confirmNavigation()) void session.logout();
                }}
              >
                Log out
              </button>
            </>
          ) : (
            <button type="button" onClick={session.login}>
              Log in
            </button>
          )}
        </div>
      </header>

      <main className="shell-main">{children}</main>

      <footer className="shell-footer">
        <GuardedLink href={HOW_IT_WORKS}>About</GuardedLink>
        <a href={STANDARD} target="_blank" rel="noopener noreferrer">
          The Standard
        </a>
        {/*
         * The API this build talks to, not a hard-coded one. A preview deployment linking at
         * production's documentation would be documenting a different API than the one its own
         * pages are reading.
         */}
        <a href={apiDocsUrl(api.baseUrl)} target="_blank" rel="noopener noreferrer">
          API &amp; data
        </a>
        <a href={REPOSITORY} target="_blank" rel="noopener noreferrer">
          GitHub
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
            Log in
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
