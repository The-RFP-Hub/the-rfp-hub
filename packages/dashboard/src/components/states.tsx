"use client";

/**
 * The three states every read has, rendered the same way everywhere.
 *
 * An error is shown WITH ITS CODE. "Something went wrong" is not a state, it is a refusal to say
 * what happened; the API returns a machine-readable code and a human sentence for every failure and
 * a publisher reporting a problem can quote both.
 */
import type { ApiError } from "@/lib/api";
import type { Resource } from "@/lib/resource";

/**
 * `<output>` rather than a `<p role="status">`: it carries that role natively, and a live region a
 * screen reader announces when the content arrives is the point — the whole page is asynchronous.
 */
export function Loading({ what }: { what: string }) {
  return <output className="state">Loading {what}…</output>;
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="state empty">
      <p className="empty-title">{title}</p>
      {detail ? <p className="muted">{detail}</p> : null}
    </div>
  );
}

export function ErrorState({
  error,
  what,
  onRetry,
}: {
  error: ApiError;
  what: string;
  onRetry?: () => void;
}) {
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
 */
export function ResourceView<T>({
  resource,
  what,
  onRetry,
  children,
}: {
  resource: Resource<T>;
  what: string;
  onRetry?: () => void;
  children: (data: T) => React.ReactNode;
}) {
  if (resource.status === "idle" || resource.status === "loading") return <Loading what={what} />;
  if (resource.status === "error") {
    return <ErrorState error={resource.error} what={what} onRetry={onRetry} />;
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
