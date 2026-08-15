"use client";

/**
 * Administration: global roles, and the direct-create grant.
 *
 * TWO INDEPENDENT AXES, and the page keeps them apart because conflating them is how somebody ends
 * up publishing by accident. A global role decides who may REVIEW. `directCreate` decides who may
 * PUBLISH into any namespace without a membership. Reviewing is not publishing, and neither of them
 * elevates an API key: a `write`-only key on a direct-create account still lands its submissions
 * pending.
 *
 * Both routes are session-only and administrator-only on the API. This page is the interface, and
 * the account search it works from is the reviewer-level directory route.
 */
import { RequireSession } from "@/components/Chrome";
import { UntrustedText } from "@/components/UntrustedText";
import { VerifiedBadge } from "@/components/badges";
import { ActionNote, EmptyState, ResourceView } from "@/components/states";
import { ApiError } from "@/lib/api";
import { formatInstant } from "@/lib/format";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import type { AccountRole } from "@/lib/types";
import { useCallback, useState } from "react";

const ROLES: AccountRole[] = ["submitter", "reviewer", "admin"];

export default function AdminPage() {
  return (
    <RequireSession
      capability={{ needs: (me) => me.canAdmin, label: "the administrator capability" }}
    >
      {() => (
        <section>
          <h1>Administration</h1>
          <Accounts />
          <Organizations />
        </section>
      )}
    </RequireSession>
  );
}

function Accounts() {
  const api = useApi();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const load = useCallback(
    () => api.review.accounts({ q: search || undefined, limit: 25 }),
    [api, search],
  );
  const { state, reload } = useResource(load);
  const [note, setNote] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (work: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote({ kind: "ok", message: await work() });
      reload();
    } catch (error) {
      setNote({
        kind: "error",
        message:
          error instanceof ApiError ? `${error.message} (${error.code})` : "The change failed.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Accounts</h2>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(query.trim());
        }}
      >
        <input
          aria-label="Search accounts"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="handle, display name or provider subject"
        />
        <button type="submit">Search</button>
      </form>
      <ActionNote note={note} />

      <ResourceView resource={state} what="accounts" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState title="No accounts matched." />
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Global role</th>
                  <th scope="col">Direct create</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((account) => (
                  <tr key={account.id}>
                    <th scope="row">
                      <UntrustedText value={account.handle} fallback="(no handle)" />
                      <div className="muted">
                        <code>#{account.id}</code> ·{" "}
                        <UntrustedText value={account.displayName} fallback="—" /> · joined{" "}
                        {formatInstant(account.createdAt)}
                      </div>
                    </th>
                    <td>
                      <select
                        aria-label={`Global role for account ${account.id}`}
                        value={account.globalRole}
                        disabled={busy}
                        onChange={(event) => {
                          const role = event.target.value as AccountRole;
                          void act(async () => {
                            await api.admin.setRole(account.id, role);
                            return `Account ${account.id} is now ${role}.`;
                          });
                        }}
                      >
                        {ROLES.map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api.admin.setDirectCreate(account.id, !account.directCreate);
                            return account.directCreate
                              ? `Direct create revoked for account ${account.id}.`
                              : `Direct create granted to account ${account.id}. It may now publish into any namespace without a membership.`;
                          })
                        }
                      >
                        {account.directCreate ? "Revoke" : "Grant"}
                      </button>
                      <div className="muted">
                        {account.directCreate ? "granted" : "not granted"}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </ResourceView>
    </div>
  );
}

/**
 * The organisation directory, read-only here.
 *
 * Verification itself is a REVIEWER action and lives on `/review` with the claim it usually
 * accompanies — putting a second copy of the button on the administrator page would suggest the two
 * are different decisions.
 */
function Organizations() {
  const api = useApi();
  const load = useCallback(() => api.review.organizations({ limit: 50 }), [api]);
  const { state, reload } = useResource(load);

  return (
    <div className="card">
      <h2>Organisations</h2>
      <p className="muted footnote">
        A verified organisation publishes without review, and every member of it inherits that. The
        verify and unverify actions are reviewer capabilities and live on the review screen.
      </p>
      <ResourceView resource={state} what="organisations" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState title="No organisations yet." />
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Organisation</th>
                  <th scope="col">Members</th>
                  <th scope="col">Publishing</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((org) => (
                  <tr key={org.slug}>
                    <th scope="row">
                      <UntrustedText value={org.name} />
                      <div className="muted">
                        <code>{org.slug}</code>
                      </div>
                    </th>
                    <td>{org.memberCount}</td>
                    <td>
                      <VerifiedBadge verified={org.verified} />
                      {org.verifiedAt ? (
                        <div className="muted">since {formatInstant(org.verifiedAt)}</div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </ResourceView>
    </div>
  );
}
