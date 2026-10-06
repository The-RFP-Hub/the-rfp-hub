"use client";

/**
 * Claiming publisher ownership on an organization's behalf.
 *
 * The API answers 200 (granted) or 202 (queued) and returns a `message` saying what the outcome
 * means for FUTURE writes — an approval on an unverified organization transfers ownership without
 * unlocking auto-approval. That sentence is rendered verbatim rather than paraphrased, because the
 * paraphrase is exactly where a dashboard would start promising something the API did not.
 */
import { ActionNote, type ActionNoteValue, actionErrorNote } from "@/components/states";
import { useApi, useSession } from "@/lib/session";
import type { Me } from "@/lib/types";
import { type ReactNode, useState } from "react";

const CLAIM_SUMMARY = "This is my program — claim it";
const OTHER_ORGANIZATION = "\u0000other";

/** An organization the claimant might be speaking for, offered beside the ones they belong to. */
export interface ClaimOrganization {
  slug: string;
  name: string;
}

export function ClaimForm({
  id,
  me,
  organizations = [],
}: {
  id: string;
  me: Me;
  organizations?: ClaimOrganization[];
}) {
  const [open, setOpen] = useState(false);
  const [draftKey, setDraftKey] = useState(0);
  const submission = useClaimSubmission(id);
  const cancel = () => {
    setOpen(false);
    setDraftKey((current) => current + 1);
    submission.reset();
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
      <ClaimFields
        key={draftKey}
        me={me}
        organizations={organizations}
        submission={submission}
        onCancel={cancel}
      />
      <ActionNote note={submission.result} />
    </details>
  );
}

interface ClaimSubmission {
  busy: boolean;
  result: ActionNoteValue | null;
  submit: (body: { organizationSlug: string; note: string | null }) => Promise<void>;
  reset: () => void;
}

function useClaimSubmission(id: string): ClaimSubmission {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionNoteValue | null>(null);

  const submit = async (body: { organizationSlug: string; note: string | null }) => {
    setBusy(true);
    setResult(null);
    try {
      const claim = await api.opportunities.claim(id, body);
      setResult({ kind: "ok", message: `${claim.outcome}: ${claim.message}` });
    } catch (error) {
      setResult(actionErrorNote(error, "The claim could not be filed."));
    } finally {
      setBusy(false);
    }
  };

  return { busy, result, submit, reset: () => setResult(null) };
}

function ClaimFields({
  me,
  organizations,
  submission,
  onCancel,
}: {
  me: Me;
  organizations: ClaimOrganization[];
  submission: ClaimSubmission;
  onCancel: () => void;
}) {
  const memberSlugs = new Set(me.memberships.map((membership) => membership.slug));
  const suggested = organizations.filter(
    (org, index, all) =>
      !memberSlugs.has(org.slug) && all.findIndex((other) => other.slug === org.slug) === index,
  );
  const [choice, setChoice] = useState(
    me.memberships[0]?.slug ?? suggested[0]?.slug ?? OTHER_ORGANIZATION,
  );
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState("");

  const slug = (choice === OTHER_ORGANIZATION ? typed : choice).trim().toLowerCase();
  const member = memberSlugs.has(slug);

  return (
    <>
      <p className="muted footnote">
        {member ? (
          <>
            Granted immediately when the organization is verified <em>and</em> appears among the
            listing&rsquo;s operating organizations. Sponsorship is not operation, so a
            sponsor&rsquo;s claim is queued for a reviewer instead.
          </>
        ) : (
          <>
            Anyone signed in can file a claim for an organization in the directory. A reviewer
            decides it, and approving it adds you as a member of that organization.
          </>
        )}
      </p>
      <div className="field">
        <label htmlFor="claim-org">Organization</label>
        <select id="claim-org" value={choice} onChange={(event) => setChoice(event.target.value)}>
          {me.memberships.map((membership) => (
            <option key={membership.slug} value={membership.slug}>
              {membership.name} — {membership.slug}{" "}
              {membership.verified ? "(verified)" : "(unverified)"}
            </option>
          ))}
          {suggested.map((org) => (
            <option key={org.slug} value={org.slug}>
              {org.name} — {org.slug}
            </option>
          ))}
          <option value={OTHER_ORGANIZATION}>Another organization…</option>
        </select>
      </div>
      {choice === OTHER_ORGANIZATION ? (
        <div className="field">
          <label htmlFor="claim-org-slug">Organization slug</label>
          <input
            id="claim-org-slug"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="The slug shown on the organization's page"
          />
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="claim-note">
          {member ? "Note for the reviewer (optional)" : "Note for the reviewer"}
        </label>
        <input
          id="claim-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Anything that helps a reviewer confirm the connection"
        />
      </div>
      <div className="row">
        <button
          type="button"
          onClick={() => void submission.submit({ organizationSlug: slug, note: note || null })}
          disabled={submission.busy || !slug}
        >
          {submission.busy ? "Filing…" : "File the claim"}
        </button>
        <button type="button" onClick={onCancel} disabled={submission.busy}>
          Cancel
        </button>
      </div>
    </>
  );
}

/**
 * The public page cannot assume an account, but claiming is still discoverable beside the listing.
 * Session and account reads stay inside this small secondary control so restoring either never
 * withholds the public opportunity from an anonymous reader.
 */
export function PublicClaimControl({
  id,
  organizations = [],
}: {
  id: string;
  organizations?: ClaimOrganization[];
}) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [draftKey, setDraftKey] = useState(0);
  const submission = useClaimSubmission(id);
  const cancel = () => {
    setOpen(false);
    setDraftKey((current) => current + 1);
    submission.reset();
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
        <p className="muted footnote">Sign in to file a claim. A reviewer decides every claim.</p>
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
    content = (
      <ClaimFields
        key={draftKey}
        me={session.me.data}
        organizations={organizations}
        submission={submission}
        onCancel={cancel}
      />
    );
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
      <ActionNote note={submission.result} />
    </details>
  );
}
