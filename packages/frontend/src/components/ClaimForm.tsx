"use client";

/**
 * Claiming publisher ownership on an organization's behalf.
 *
 * The API answers 200 (granted) or 202 (queued) and returns a `message` saying what the outcome
 * means for FUTURE writes — an approval on an unverified organization transfers ownership without
 * unlocking auto-approval. That sentence is rendered verbatim rather than paraphrased, because the
 * paraphrase is exactly where a dashboard would start promising something the API did not.
 */
import { ActionNote, actionErrorNote } from "@/components/states";
import { useApi, useSession } from "@/lib/session";
import type { Me } from "@/lib/types";
import { type ReactNode, useState } from "react";

const CLAIM_SUMMARY = "This is my programme — claim it";

export function ClaimForm({ id, me }: { id: string; me: Me }) {
  const [open, setOpen] = useState(false);
  const [draftKey, setDraftKey] = useState(0);
  const cancel = () => {
    setOpen(false);
    setDraftKey((current) => current + 1);
  };

  return (
    <details className="card" open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        {CLAIM_SUMMARY}
      </summary>
      <ClaimFields key={draftKey} id={id} me={me} onCancel={cancel} />
    </details>
  );
}

function ClaimFields({ id, me, onCancel }: { id: string; me: Me; onCancel: () => void }) {
  const api = useApi();
  const [slug, setSlug] = useState(me.memberships[0]?.slug ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "error"; message: string } | null>(null);

  if (me.memberships.length === 0) {
    return (
      <p className="muted">
        This account is not a member of any organization, so there is nothing to claim on behalf of.
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
      setResult(actionErrorNote(error, "The claim could not be filed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="muted footnote">
        Granted immediately when the organization is verified <em>and</em> appears among the
        listing&rsquo;s operating organizations. Sponsorship is not operation, so a sponsor&rsquo;s
        claim is queued for a reviewer instead.
      </p>
      <div className="field">
        <label htmlFor="claim-org">Organization</label>
        <select id="claim-org" value={slug} onChange={(event) => setSlug(event.target.value)}>
          {me.memberships.map((membership) => (
            <option key={membership.slug} value={membership.slug}>
              {membership.name} — {membership.slug}{" "}
              {membership.verified ? "(verified)" : "(unverified)"}
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
      <div className="row">
        <button type="button" onClick={() => void submit()} disabled={busy || !slug}>
          {busy ? "Filing…" : "File the claim"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
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
  const [draftKey, setDraftKey] = useState(0);
  const cancel = () => {
    setOpen(false);
    setDraftKey((current) => current + 1);
  };
  let content: ReactNode;

  if (session.error) {
    content = (
      <ActionNote
        note={{ kind: "error", message: "Sign-in is unavailable right now.", error: session.error }}
      />
    );
  } else if (!session.ready) {
    content = <p className="muted footnote">Restoring your session…</p>;
  } else if (!session.authenticated) {
    content = (
      <>
        <p className="muted footnote">
          Sign in with the account that belongs to the organization running this programme.
        </p>
        <button type="button" onClick={session.login}>
          Sign in to claim
        </button>
      </>
    );
  } else if (session.me.status === "idle" || session.me.status === "loading") {
    content = <p className="muted footnote">Loading your organizations…</p>;
  } else if (session.me.status === "error") {
    content = (
      <>
        <ActionNote
          note={actionErrorNote(session.me.error, "Could not load your organizations.")}
        />
        <button type="button" onClick={session.reloadMe}>
          Try again
        </button>
      </>
    );
  } else {
    content = <ClaimFields key={draftKey} id={id} me={session.me.data} onCancel={cancel} />;
  }

  return (
    <details className="card" open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        {CLAIM_SUMMARY}
      </summary>
      {content}
    </details>
  );
}
