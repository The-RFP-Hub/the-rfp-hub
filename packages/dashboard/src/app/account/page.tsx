"use client";

/**
 * The account: who the API thinks you are, what it says you may do, and the one identity field you
 * can change.
 *
 * The handle is not cosmetic — it is the attribution carried on everything this account publishes,
 * which is why changing it is session-only on the API and why this page says what it affects.
 *
 * The capability list is rendered from the API's own answer, not from anything computed here. If it
 * disagrees with what a page lets you do, the API is right and this dashboard has a bug.
 */
import { RequireSession } from "@/components/Chrome";
import { UntrustedText } from "@/components/UntrustedText";
import { VerifiedBadge } from "@/components/badges";
import { ActionNote } from "@/components/states";
import { ApiError } from "@/lib/api";
import { formatInstant } from "@/lib/format";
import { useApi, useSession } from "@/lib/session";
import type { Me } from "@/lib/types";
import { useState } from "react";

export default function AccountPage() {
  return <RequireSession>{(me) => <Account me={me} />}</RequireSession>;
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
      setNote({
        kind: "error",
        message:
          error instanceof ApiError
            ? `${error.message} (${error.code})`
            : "Could not save changes.",
      });
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
          The handle is what appears as <code>source.submittedBy</code> on everything you publish.
          Changing it changes future attribution; entries already published keep the attribution
          they were stored with.
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
        <button type="button" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <ActionNote note={note} />
      </div>

      <div className="card">
        <h2>What the API says this account may do</h2>
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
              <td>{me.role}</td>
            </tr>
            <tr>
              <th scope="row">Credential in use</th>
              <td>{me.credentialKind === "session" ? "browser session" : "API key"}</td>
            </tr>
            <tr>
              <th scope="row">Direct create</th>
              <td>
                {me.directCreate
                  ? "yes — may publish into any namespace without a membership"
                  : "no"}
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

      <div className="card">
        <h2>Organisations</h2>
        {me.memberships.length === 0 ? (
          <p className="muted">
            No memberships. Submissions from this account land pending, which is the normal path for
            a community submission. Claiming an entry for an organisation you run is how that
            changes.
          </p>
        ) : (
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
                    <UntrustedText value={membership.name} />
                    <div className="muted">
                      <code>{membership.slug}</code>
                    </div>
                  </th>
                  <td>{membership.role}</td>
                  <td>
                    <VerifiedBadge verified={membership.verified} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
