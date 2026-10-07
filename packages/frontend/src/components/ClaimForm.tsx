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
import { ApiError } from "@/lib/api";
import { useResource } from "@/lib/resource";
import { type SessionState, useApi, useSession } from "@/lib/session";
import type { ClaimResult, Me } from "@/lib/types";
import Link from "next/link";
import { useCallback, useId, useState } from "react";

const CLAIM_SUMMARY = "This is my program — claim it";
const OTHER_ORGANIZATION = "\u0000other";

/** An organization the claimant might be speaking for, offered beside the ones they belong to. */
export interface ClaimOrganization {
  slug: string;
  name: string;
}

type ClaimFormProps = { id: string; me: Me; organizations?: ClaimOrganization[] };

export function ClaimForm(props: ClaimFormProps) {
  return <ClaimControl key={props.id} {...props} />;
}

/** Both entry points share one access check and one request flow. */
function ClaimControl({
  id,
  me: suppliedMe = null,
  organizations = [],
  session,
}: Omit<ClaimFormProps, "me"> & { me?: Me | null; session?: SessionState }) {
  const api = useApi();
  const me = session
    ? session.authenticated && session.me.status === "ready"
      ? session.me.data
      : null
    : suppliedMe;
  const enabled = !session || (session.ready && (!session.authenticated || me !== null));
  const accountId = me?.accountId ?? null;
  const load = useCallback(
    async () => ({
      id,
      accountId,
      ...(accountId !== null
        ? await api.me.opportunityAccess(id)
        : {
            canEdit: false,
            canViewManagement: false,
            ...(await api.opportunities.claimStatus(id)),
          }),
    }),
    [api, id, accountId],
  );
  const { state, reload } = useResource(load, { enabled });
  const [open, setOpen] = useState(false);
  const [draftKey, setDraftKey] = useState(0);
  const submission = useClaimSubmission(id, accountId, reload);
  const cancel = () => {
    setOpen(false);
    setDraftKey((current) => current + 1);
    submission.reset();
  };

  if (session?.error)
    return (
      <ActionNote
        note={{ kind: "error", message: "Sign-in is unavailable right now.", error: session.error }}
      />
    );
  if (session?.authenticated && session.me.status === "error")
    return <AccessError error={session.me.error} retry={session.reloadMe} />;
  if (state.status === "error") return <AccessError error={state.error} retry={reload} />;
  if (
    !enabled ||
    state.status !== "ready" ||
    state.stale ||
    state.data.id !== id ||
    state.data.accountId !== accountId
  )
    return <output className="muted footnote">Checking your program access…</output>;
  if (state.data.canViewManagement || state.data.canEdit)
    return <ManagementActions id={id} canEdit={state.data.canEdit} />;
  if (!state.data.canClaim) return null;
  if (submission.outcome === "granted") return <ManagementActions id={id} canEdit />;
  if (submission.outcome)
    return (
      <div className="card">
        <ClaimNextStep outcome={submission.outcome} />
        <ActionNote note={submission.result} />
      </div>
    );

  return (
    <details className="card claim-form" open={open}>
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
      {me ? (
        <ClaimFields
          key={`${accountId}:${draftKey}`}
          me={me}
          organizations={organizations}
          submission={submission}
          onCancel={cancel}
        />
      ) : (
        <>
          <p className="muted footnote">Sign in to manage your program or request access.</p>
          <button type="button" onClick={session?.login}>
            Sign in to claim
          </button>
        </>
      )}
      <ActionNote note={submission.result} />
    </details>
  );
}

function AccessError({
  error,
  retry,
}: { error: Parameters<typeof actionErrorNote>[0]; retry: () => void }) {
  return (
    <div className="card">
      <ActionNote note={actionErrorNote(error, "Could not check your program access.")} />
      <button type="button" onClick={retry}>
        Check access again
      </button>
    </div>
  );
}

interface ClaimSubmission {
  busy: boolean;
  outcome: ClaimResult["outcome"] | null;
  result: ActionNoteValue | null;
  submit: (body: { organizationSlug: string; note: string | null }) => Promise<void>;
  reset: () => void;
}

function useClaimSubmission(
  id: string,
  accountId: number | null,
  onAccessChanged: () => void,
): ClaimSubmission {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{
    accountId: number | null;
    outcome: ClaimResult["outcome"] | null;
    note: ActionNoteValue;
  } | null>(null);

  const submit = async (body: { organizationSlug: string; note: string | null }) => {
    if (busy) return;
    setBusy(true);
    setAnswer(null);
    try {
      const claim = await api.opportunities.claim(id, body);
      setAnswer({
        accountId,
        outcome: claim.outcome,
        note: { kind: "ok", message: claim.message },
      });
    } catch (error) {
      setAnswer({
        accountId,
        outcome: null,
        note: actionErrorNote(error, "The claim could not be filed."),
      });
      if (error instanceof ApiError && error.code === "already_claimed") onAccessChanged();
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    result: answer?.accountId === accountId ? answer.note : null,
    outcome: answer?.accountId === accountId ? answer.outcome : null,
    submit,
    reset: () => setAnswer(null),
  };
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
  const fieldId = useId();
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
        {member
          ? "Verified operating organization members can claim immediately. Other requests go to review."
          : "A reviewer checks your request. Approval adds you as a publisher in this organization."}
      </p>
      <div className="field">
        <label htmlFor={`${fieldId}-org`}>Organization</label>
        <select
          id={`${fieldId}-org`}
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
        >
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
          <label htmlFor={`${fieldId}-org-slug`}>Organization slug</label>
          <input
            id={`${fieldId}-org-slug`}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="The slug shown on the organization's page"
          />
        </div>
      ) : null}
      <div className="field">
        <label htmlFor={`${fieldId}-note`}>Note for the reviewer (optional)</label>
        <input
          id={`${fieldId}-note`}
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

function ManagementActions({ id, canEdit }: { id: string; canEdit: boolean }) {
  const href = `/listings/${encodeURIComponent(id)}`;
  return (
    <div className="card">
      <p>
        {canEdit
          ? "You can manage this program."
          : "You have access to this program’s management details."}
      </p>
      <div className="row">
        {canEdit ? (
          <Link className="button" href={`${href}/edit`}>
            Edit program
          </Link>
        ) : null}
        <Link href={href}>View management details</Link>
      </div>
    </div>
  );
}

function ClaimNextStep({ outcome }: { outcome: ClaimResult["outcome"] }) {
  return (
    <p className="muted footnote">
      {outcome === "queued"
        ? "Your request is awaiting review. You do not need to submit it again."
        : "No changes were made. Refresh the page to check your current access."}
    </p>
  );
}

/** Keep the control mounted while the session refreshes, so a queued response is not lost. */
export function PublicClaimControl(props: Omit<ClaimFormProps, "me">) {
  const session = useSession();
  return <ClaimControl key={props.id} {...props} session={session} />;
}
