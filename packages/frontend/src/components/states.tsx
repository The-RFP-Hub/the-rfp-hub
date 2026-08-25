"use client";

/**
 * The states every read has, rendered the same way everywhere.
 *
 * AN ERROR KEEPS ITS CODE WITHOUT LEADING WITH IT. The immediate state says what happened and what
 * to do next; the API's message, status, code and detail paths remain available in one closed
 * disclosure for diagnosis and bug reports.
 *
 * 401 AND 403 ARE NOT THE SAME PAGE, and collapsing them was the single most misleading thing this
 * file used to do. A 401 means the session expired while the tab was open — the reader did nothing
 * wrong, and their next step is one button. A 403 means the API knows exactly who they are and has
 * refused: signing in again cannot help, and offering a login button would send somebody round a
 * loop that ends where it started. Both are read off `ApiError`'s own predicates rather than off a
 * status number spelled out at each call site.
 *
 * EVERY STATE NAMES A NEXT STEP. That is a house rule, not a nicety: an empty list that does not
 * say what would fill it is a dead end with a border around it.
 */
import { ApiError } from "@/lib/api";
import { DIRECTORY, HOW_IT_WORKS_ROLES } from "@/lib/links";
import type { Resource } from "@/lib/resource";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * `<output>` rather than a `<p role="status">`: it carries that role natively, and a live region a
 * screen reader announces when the content arrives is the point — the whole page is asynchronous.
 *
 * IT RESERVES ITS HEIGHT. A one-line "Loading…" replaced by twenty lines of table moves everything
 * below it at the exact moment the reader has started to reach for something. `.state.loading` has
 * a minimum height so the swap happens inside a box that was already the right size.
 */
export function Loading({ what }: { what: string }) {
  return <output className="state loading">Loading {what}…</output>;
}

/**
 * Nothing to show, and what would put something there.
 *
 * `action` is the reader's next step as a real control — a link to the submit form, an invitation
 * to widen a filter. It is optional only because a couple of nested panels genuinely have none.
 */
export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state empty">
      <p className="empty-title">{title}</p>
      {detail ? <p className="muted">{detail}</p> : null}
      {action ? <p className="row">{action}</p> : null}
    </div>
  );
}

/**
 * A failed read, told apart by what the API actually refused.
 *
 * `onLogin` is what makes the 401 branch worth having: without a way to sign back in, "your session
 * expired" is a diagnosis with no treatment. Pages that have no login opener pass nothing and get
 * the sentence without the button.
 */
export function ErrorState({
  error,
  what,
  onRetry,
  onLogin,
}: {
  error: ApiError;
  what: string;
  onRetry?: () => void;
  onLogin?: () => void;
}) {
  if (error.isUnauthenticated) {
    return (
      <div className="state error" role="alert">
        <p className="empty-title">Your sign-in has ended.</p>
        <p className="muted">
          Sign in again to continue to {what}. Nothing was lost, and you can pick up where you were.
        </p>
        {onLogin ? (
          <p className="row">
            <button type="button" className="button-primary" onClick={onLogin}>
              Log in again
            </button>
          </p>
        ) : null}
        <TechnicalDetails error={error} />
      </div>
    );
  }

  if (error.isForbidden) {
    return (
      <div className="state error" role="alert">
        <p className="empty-title">You don&rsquo;t have access to {what}.</p>
        <p className="muted">
          Your account is signed in, but its role does not include this access.
        </p>
        <p className="row">
          <Link href="/account">Check your account</Link>
          <Link href={HOW_IT_WORKS_ROLES}>See who can do what</Link>
        </p>
        <TechnicalDetails error={error} />
      </div>
    );
  }

  if (error.isNotFound) {
    return (
      <div className="state error" role="alert">
        <p className="empty-title">We couldn&rsquo;t find {what}.</p>
        <p className="muted">It may have moved, been merged, or no longer be available.</p>
        <p className="row">
          <Link href={DIRECTORY}>Search the directory</Link>
        </p>
        <TechnicalDetails error={error} />
      </div>
    );
  }

  return (
    <div className="state error" role="alert">
      <p className="empty-title">We couldn&rsquo;t load {what}.</p>
      <p className="muted">Try again. If the problem continues, the technical details can help.</p>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
      <TechnicalDetails error={error} />
    </div>
  );
}

/** Raw failure data is available for diagnosis without competing with the human-facing state. */
export function TechnicalDetails({ error, children }: { error: Error; children?: ReactNode }) {
  const apiError = error instanceof ApiError ? error : null;
  return (
    <details>
      <summary>Technical details</summary>
      <dl>
        <dt>Message</dt>
        <dd>{error.message}</dd>
        {apiError ? (
          <>
            <dt>Status</dt>
            <dd>{apiError.status === 0 ? "0 (no response)" : apiError.status}</dd>
            <dt>Code</dt>
            <dd>
              <code>{apiError.code}</code>
            </dd>
          </>
        ) : null}
      </dl>
      {apiError && apiError.details.length > 0 ? (
        <ul>
          {apiError.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      {children}
    </details>
  );
}

/**
 * Render a resource, or the honest state it is actually in.
 *
 * The `children` callback only ever sees loaded data, which is what makes it impossible for a page
 * to render a value it does not have.
 *
 * `stale` IS RENDERED AS DATA, NOT AS A SPINNER. `useResource` keeps the previous answer while a
 * refetch is in flight (see that module), and this is the half of the change a reader notices: a
 * reviewer who reloads a queue after a decision keeps looking at the queue instead of at a blank
 * panel that comes back a moment later with the rows in a slightly different order.
 */
export function ResourceView<T>({
  resource,
  what,
  onRetry,
  onLogin,
  children,
}: {
  resource: Resource<T>;
  what: string;
  onRetry?: () => void;
  onLogin?: () => void;
  children: (data: T) => React.ReactNode;
}) {
  if (resource.status === "idle" || resource.status === "loading") return <Loading what={what} />;
  if (resource.status === "error") {
    return <ErrorState error={resource.error} what={what} onRetry={onRetry} onLogin={onLogin} />;
  }
  return <>{children(resource.data)}</>;
}

/**
 * Sign-in itself is unavailable — the API could not be reached to find out who is signed in.
 * Distinct from "you are logged out", because there is nothing a visitor can do about it and a
 * login button would just fail silently.
 */
export function AuthUnavailable({ error }: { error: Error }) {
  return (
    <div className="state error" role="alert">
      <p className="empty-title">This deployment cannot reach its service.</p>
      <p className="muted">Sign-in is unavailable right now. Nothing is wrong with your account.</p>
      <TechnicalDetails error={error}>
        <p>
          Check whether <code>NEXT_PUBLIC_API_URL</code> names an API origin this browser can reach.
        </p>
      </TechnicalDetails>
    </div>
  );
}

export interface ActionNoteValue {
  kind: "ok" | "error";
  message: string;
  error?: Error;
  technical?: { label: string; value: string | number }[];
}

/** Keep the API's human sentence visible while moving transport-shaped diagnostics out of the way. */
export function actionErrorNote(error: unknown, fallback: string): ActionNoteValue {
  if (error instanceof ApiError) return { kind: "error", message: error.message, error };
  return {
    kind: "error",
    message: fallback,
    ...(error instanceof Error ? { error } : {}),
  };
}

/** A one-line note that an action succeeded or failed, shown next to the control that ran it. */
export function ActionNote({ note }: { note: ActionNoteValue | null }) {
  if (!note) return null;
  return (
    <>
      <output className={note.kind === "ok" ? "note ok" : "note error"}>{note.message}</output>
      {note.error ? <TechnicalDetails error={note.error} /> : null}
      {note.technical ? (
        <details>
          <summary>Technical details</summary>
          <dl>
            {note.technical.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </>
  );
}
