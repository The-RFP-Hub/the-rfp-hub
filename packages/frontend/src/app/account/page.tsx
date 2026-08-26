"use client";

/**
 * The account: who the API thinks you are, what it says you may do, and the one identity field you
 * can change.
 *
 * The handle is not cosmetic — it is the attribution carried on everything this account publishes,
 * which is why changing it is session-only on the API and why this page says what it affects.
 *
 * The capability list is rendered from the API's own answer, not from anything computed here. If it
 * disagrees with what a page lets you do, the API is right and this frontend has a bug.
 */
import { RequireSession } from "@/components/Chrome";
import { UntrustedText } from "@/components/UntrustedText";
import { VerifiedBadge } from "@/components/badges";
import { ActionNote, actionErrorNote } from "@/components/states";
import { formatInstant } from "@/lib/format";
import { ROUTE_GATE_COPY, accountRoleLabel, orgRoleLabel } from "@/lib/presentation";
import { useApi, useSession } from "@/lib/session";
import type { Me } from "@/lib/types";
import Link from "next/link";
import { useState } from "react";

export default function AccountPage() {
  return (
    <RequireSession gate={ROUTE_GATE_COPY.account}>{(me) => <Account me={me} />}</RequireSession>
  );
}

function Account({ me }: { me: Me }) {
  const api = useApi();
  const session = useSession();
  const [handle, setHandle] = useState(me.handle ?? "");
  const [displayName, setDisplayName] = useState(me.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; message: string } | null>(null);

  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      await api.me.update({ handle: handle || null, displayName: displayName || null });
      setNote({ kind: "ok", message: "Saved." });
      session.reloadMe();
    } catch (error) {
      setNote(actionErrorNote(error, "Could not save changes."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1>Account</h1>

      <div className="card">
        <h2>Identity</h2>
        <p className="muted footnote">
          Your handle is the byline shown on listings. Changing it changes future attribution;
          listings already published keep the byline they were stored with.
        </p>
        <div className="field">
          <label htmlFor="handle">Handle</label>
          <p className="hint">3–40 lowercase alphanumerics separated by single hyphens.</p>
          <input id="handle" value={handle} onChange={(event) => setHandle(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="display-name">Display name</label>
          <input
            id="display-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="button-primary"
          onClick={() => void save()}
          disabled={busy}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <ActionNote note={note} />
      </div>

      <div className="card">
        <h2>What this account may do</h2>
        <div className="table-scroll">
          <table>
            <tbody>
              <tr>
                <th scope="row">Account id</th>
                <td>
                  <code>{me.accountId}</code>
                </td>
              </tr>
              <tr>
                <th scope="row">Global role</th>
                <td>{accountRoleLabel(me.role)}</td>
              </tr>
              <tr>
                <th scope="row">Credential in use</th>
                <td>{me.credentialKind === "session" ? "browser session" : "API key"}</td>
              </tr>
              <tr>
                <th scope="row">Direct-create</th>
                <td>
                  {me.directCreate
                    ? "Yes — may publish into any namespace without a membership"
                    : "No — this account publishes without review only through a verified organisation membership; other submissions wait for review."}
                </td>
              </tr>
              <tr>
                <th scope="row">Manage keys</th>
                <td>{me.canManageKeys ? "yes" : "no"}</td>
              </tr>
              <tr>
                <th scope="row">Review</th>
                <td>{me.canReview ? "yes" : "no"}</td>
              </tr>
              <tr>
                <th scope="row">Administer</th>
                <td>{me.canAdmin ? "yes" : "no"}</td>
              </tr>
              <tr>
                <th scope="row">Account created</th>
                <td className="muted">{formatInstant(me.createdAt)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="row-between">
          <h2>Organisations</h2>
          <Link href="/organisations">Browse organisations</Link>
        </div>
        {me.memberships.length === 0 ? (
          <>
            <p className="muted">
              No memberships. Submissions from this account land pending, which is the normal path
              for a community submission. Claiming a listing for an organisation you run is how that
              changes.
            </p>
            <p>
              <Link href="/organisations">Browse organisations</Link>
            </p>
          </>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Organisation</th>
                  <th scope="col">Your role</th>
                  <th scope="col">Publishing</th>
                </tr>
              </thead>
              <tbody>
                {me.memberships.map((membership) => (
                  <tr key={membership.slug}>
                    <th scope="row">
                      {/*
                       * The membership is the entry point to the organisation's own page — what it
                       * has published, and what is waiting in its name. Naming it here without
                       * linking made this table a dead end listing places the reader could not go.
                       */}
                      <Link
                        className="row-title"
                        href={`/organisations/${encodeURIComponent(membership.slug)}`}
                      >
                        <UntrustedText value={membership.name} />
                      </Link>
                      <div className="muted">
                        <code>{membership.slug}</code>
                      </div>
                    </th>
                    <td>{orgRoleLabel(membership.role)}</td>
                    <td>
                      <VerifiedBadge verified={membership.verified} gloss />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
