"use client";

/**
 * The application shell: navigation, session state, and the one place a page's access is gated.
 *
 * TWO NAVIGATIONS, because there are two audiences. The public one names the directory and is
 * rendered for everybody, signed in or not — the reads behind it are unauthenticated, so gating the
 * link would be theatre. The Sections one is the publisher's workbench and appears only once the API
 * has said who this is.
 *
 * THE SECTIONS NAVIGATION IS RENDERED FROM `GET /v1/me`, not from anything this client decided.
 * `canReview` and `canAdmin` come back with the account, so the review and administration links
 * appear for the people who hold those capabilities and for nobody else. Hiding a link is
 * presentation, never protection — every one of those routes is enforced on the API, and a
 * hand-typed URL reaches a page that renders the API's own 403.
 */
import { AuthUnavailable, ErrorState, Loading } from "@/components/states";
import { useSession } from "@/lib/session";
import type { Me } from "@/lib/types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

interface NavItem {
  href: string;
  label: string;
  /** Which capability the API reported. `undefined` means "any signed-in account". */
  requires?: (me: Me) => boolean;
}

const NAV: NavItem[] = [
  // The signed-in overview, which used to be `/` before the public directory took that route.
  { href: "/dashboard", label: "Dashboard" },
  { href: "/listings", label: "Listings" },
  { href: "/duplicates", label: "Duplicates" },
  { href: "/keys", label: "API keys", requires: (me) => me.canManageKeys },
  { href: "/review", label: "Review", requires: (me) => me.canReview },
  { href: "/admin", label: "Administration", requires: (me) => me.canAdmin },
  { href: "/account", label: "Account" },
];

export function Chrome({ children }: { children: ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const me = session.me.status === "ready" ? session.me.data : null;

  return (
    <div className="shell">
      <header className="shell-header">
        <Link href="/" className="brand">
          RFP Hub <span className="muted">the directory and the workbench</span>
        </Link>
        <nav aria-label="Public">
          <Link href="/" aria-current={pathname === "/" ? "page" : undefined}>
            Directory
          </Link>
        </nav>
        <nav aria-label="Sections">
          {me
            ? NAV.filter((item) => !item.requires || item.requires(me)).map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={pathname === item.href ? "page" : undefined}
                >
                  {item.label}
                </Link>
              ))
            : null}
        </nav>
        <div className="shell-session">
          {session.error ? (
            <span className="muted">sign-in unavailable</span>
          ) : !session.ready ? (
            <span className="muted">restoring session…</span>
          ) : session.authenticated ? (
            <>
              <span className="muted">{me ? (me.handle ?? `account ${me.accountId}`) : "…"}</span>
              <button type="button" onClick={() => void session.logout()}>
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
        <p className="muted">
          The directory republishes what publishers and submitters stated, under one open standard.
          Analytics here are best-effort — server-side API reads and link-outs, not page views.
          Nothing on this site is a second authorization system: the API decides.
        </p>
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
}: {
  children: (me: Me) => ReactNode;
  /** An extra gate for the review and administration pages, mirrored from the API's own answer. */
  capability?: { needs: (me: Me) => boolean; label: string };
}) {
  const session = useSession();

  if (session.error) return <AuthUnavailable error={session.error} />;
  if (!session.ready) return <Loading what="your session" />;
  if (!session.authenticated) {
    return (
      <div className="state empty">
        <p className="empty-title">You are not signed in.</p>
        <p className="muted">
          This page shows one account&rsquo;s own entries and traffic, so it needs a session.
        </p>
        <button type="button" onClick={session.login}>
          Log in
        </button>
      </div>
    );
  }
  if (session.me.status === "idle" || session.me.status === "loading") {
    return <Loading what="your account" />;
  }
  if (session.me.status === "error") {
    return <ErrorState error={session.me.error} what="your account" onRetry={session.reloadMe} />;
  }

  const me = session.me.data;
  if (capability && !capability.needs(me)) {
    return (
      <div className="state empty">
        <p className="empty-title">This account does not have {capability.label}.</p>
        <p className="muted">
          The API is the authority on that — this page is only reporting what it answered for your
          account. Ask an administrator if you believe it should.
        </p>
      </div>
    );
  }
  return <>{children(me)}</>;
}
