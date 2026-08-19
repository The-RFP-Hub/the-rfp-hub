"use client";

/**
 * The states every read has, rendered the same way everywhere.
 *
 * AN ERROR IS SHOWN WITH ITS CODE. "Something went wrong" is not a state, it is a refusal to say
 * what happened; the API returns a machine-readable code and a human sentence for every failure and
 * a publisher reporting a problem can quote both.
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
import type { ApiError } from "@/lib/api";
import type { Resource } from "@/lib/resource";
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
        {/*
         * THE HEADING DESCRIBES THE REFUSAL, NOT ITS CAUSE. A 401 reaches this branch from two very
         * different places — a session that quietly aged out under a reader who was mid-task, and a
         * one-shot credential that had already been spent — and a heading that guessed "your session
         * expired" would be telling half of them something untrue. The API's own sentence follows
         * immediately and IS the specific answer; the paragraph after it is the part that is true
         * either way.
         */}
        <p className="empty-title">The API did not accept this session.</p>
        <p>{error.message}</p>
        <p className="muted">
          It would not show {what} without one. Nothing was lost and nothing is wrong with your
          account — sessions end after ninety days, and signing out anywhere else ends them sooner.
          Signing in again picks up where you were.
        </p>
        <p className="row">
          {onLogin ? (
            <button type="button" className="button-primary" onClick={onLogin}>
              Log in again
            </button>
          ) : null}
          {onRetry ? (
            <button type="button" onClick={onRetry}>
              Try again
            </button>
          ) : null}
        </p>
        <p className="muted">
          <code>401 · {error.code}</code>
        </p>
      </div>
    );
  }

  if (error.isForbidden) {
    return (
      <div className="state error" role="alert">
        <p className="empty-title">This account may not read {what}.</p>
        <p>{error.message}</p>
        <p className="muted">
          You are signed in and the API knows who you are — it has refused this particular thing, so
          signing in again would change nothing. An administrator can grant the capability.
        </p>
        <p className="muted">
          <code>403 · {error.code}</code>
        </p>
      </div>
    );
  }

  return (
    <div className="state error" role="alert">
      <p>
        <strong>Could not load {what}.</strong>
      </p>
      <p>{error.message}</p>
      {error.details.length > 0 ? (
        <ul>
          {error.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      <p className="muted">
        <code>
          {error.status === 0 ? "no response" : error.status} · {error.code}
        </code>
      </p>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
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
      <p className="empty-title">Sign-in is unavailable.</p>
      <p>{error.message}</p>
      <p className="muted">
        Sessions are issued by the API itself, so this means the API could not be reached — it is
        down, or <code>NEXT_PUBLIC_API_URL</code> names an origin this browser cannot talk to.
        Nothing here is broken on your side and retrying will not help until it is fixed.
      </p>
    </div>
  );
}

/** A one-line note that an action succeeded or failed, shown next to the control that ran it. */
export function ActionNote({ note }: { note: { kind: "ok" | "error"; message: string } | null }) {
  if (!note) return null;
  return <output className={note.kind === "ok" ? "note ok" : "note error"}>{note.message}</output>;
}
