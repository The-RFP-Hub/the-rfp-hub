"use client";

/**
 * Claiming publisher ownership on an organisation's behalf.
 *
 * The API answers 200 (granted) or 202 (queued) and returns a `message` saying what the outcome
 * means for FUTURE writes — an approval on an unverified organisation transfers ownership without
 * unlocking auto-approval. That sentence is rendered verbatim rather than paraphrased, because the
 * paraphrase is exactly where a dashboard would start promising something the API did not.
 */
import { ActionNote } from "@/components/states";
import { ApiError } from "@/lib/api";
import { useApi, useSession } from "@/lib/session";
import type { Me } from "@/lib/types";
import { type ReactNode, useState } from "react";

const CLAIM_SUMMARY = "This is my programme — claim it";

export function ClaimForm({ id, me }: { id: string; me: Me }) {
  return (
    <details className="card">
      <summary>{CLAIM_SUMMARY}</summary>
      <ClaimFields id={id} me={me} />
    </details>
  );
}

function ClaimFields({ id, me }: { id: string; me: Me }) {
  const api = useApi();
  const [slug, setSlug] = useState(me.memberships[0]?.slug ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "error"; message: string } | null>(null);

  if (me.memberships.length === 0) {
    return (
      <p className="muted">
        This account is not a member of any organisation, so there is nothing to claim on behalf of.
        A reviewer grants membership.
      </p>
    );
  }

  const submit = async () => {
    setBusy(true);
    setResult(null);
    try {
      const claim = await api.opportunities.claim(id, {
        organizationSlug: slug,
        note: note || null,
      });
      setResult({ kind: "ok", message: `${claim.outcome}: ${claim.message}` });
    } catch (error) {
      setResult({
        kind: "error",
        message: error instanceof ApiError ? error.message : "The claim could not be filed.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="muted footnote">
        Granted immediately when the organisation is verified <em>and</em> appears among the
        listing&rsquo;s operating organisations. Sponsorship is not operation, so a sponsor&rsquo;s
        claim is queued for a reviewer instead.
      </p>
      <div className="field">
        <label htmlFor="claim-org">Organisation</label>
        <select id="claim-org" value={slug} onChange={(event) => setSlug(event.target.value)}>
          {me.memberships.map((membership) => (
            <option key={membership.slug} value={membership.slug}>
              {membership.slug} {membership.verified ? "(verified)" : "(unverified)"}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="claim-note">Note for the reviewer (optional)</label>
        <input
          id="claim-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Anything that helps a reviewer confirm the connection"
        />
      </div>
      <button type="button" onClick={() => void submit()} disabled={busy || !slug}>
        {busy ? "Filing…" : "File the claim"}
      </button>
      <ActionNote note={result} />
    </>
  );
}

/**
 * The public page cannot assume an account, but claiming is still discoverable beside the listing.
 * Session and account reads stay inside this small secondary control so restoring either never
 * withholds the public opportunity from an anonymous reader.
 */
export function PublicClaimControl({ id }: { id: string }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  let content: ReactNode;

  if (session.error) {
    content = (
      <ActionNote
        note={{ kind: "error", message: `Sign-in is unavailable: ${session.error.message}` }}
      />
    );
  } else if (!session.ready) {
    content = <p className="muted footnote">Restoring your session…</p>;
  } else if (!session.authenticated) {
    content = (
      <>
        <p className="muted footnote">
          Sign in with the account that belongs to the organisation running this programme.
        </p>
        <button type="button" onClick={session.login}>
          Sign in to claim
        </button>
      </>
    );
  } else if (session.me.status === "idle" || session.me.status === "loading") {
    content = <p className="muted footnote">Loading your organisations…</p>;
  } else if (session.me.status === "error") {
    content = (
      <>
        <ActionNote note={{ kind: "error", message: session.me.error.message }} />
        <button type="button" onClick={session.reloadMe}>
          Try again
        </button>
      </>
    );
  } else {
    content = <ClaimFields id={id} me={session.me.data} />;
  }

  return (
    <details className="card" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{CLAIM_SUMMARY}</summary>
      {content}
    </details>
  );
}
