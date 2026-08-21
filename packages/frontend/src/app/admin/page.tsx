"use client";

/**
 * Accounts and roles — who may review, and who may publish without a membership.
 *
 * TWO INDEPENDENT AXES, and the page keeps them apart because conflating them is how somebody ends
 * up publishing by accident. A global role decides who may REVIEW. `directCreate` decides who may
 * PUBLISH into any namespace without a membership. Reviewing is not publishing, and neither of them
 * elevates an API key: a `write`-only key on a direct-create account still lands its submissions
 * pending.
 *
 * ORGANISATIONS ARE NOT HERE ANY MORE. This page used to carry a read-only copy of the organisation
 * directory, which taught the wrong thing twice over: it implied organisation management was an
 * administrator's job when verification is a REVIEWER capability, and a table with no controls on
 * the page named "administration" reads as a control somebody has forgotten to add. It lives on
 * Review, with the claims it usually accompanies.
 *
 * Both routes here are session-only and administrator-only on the API. This page is the interface,
 * and the account search it works from is the reviewer-level directory route.
 */
import { RequireSession } from "@/components/Chrome";
import { ConfirmPanel } from "@/components/Confirm";
import { UntrustedText } from "@/components/UntrustedText";
import { ActionNote, EmptyState, ResourceView } from "@/components/states";
import { ApiError } from "@/lib/api";
import { formatInstant } from "@/lib/format";
import { useResource } from "@/lib/resource";
import { useApi, useSession } from "@/lib/session";
import type { AccountRole, AccountSummary, Me } from "@/lib/types";
import Link from "next/link";
import { useCallback, useState } from "react";

const ROLES: AccountRole[] = ["submitter", "reviewer", "admin"];

/** What each role actually grants, said where the choice is made rather than in a document. */
const ROLE_MEANING: Record<AccountRole, string> = {
  submitter:
    "may submit listings and manage their own. No queues, no decisions about anybody else.",
  reviewer:
    "may approve, refuse and merge anybody's listings, decide claims, and verify organisations — which grants publishing rights over a whole namespace.",
  admin: "everything a reviewer may do, plus changing roles and granting direct-create.",
};

export default function AdminPage() {
  return (
    <RequireSession
      capability={{ needs: (me) => me.canAdmin, label: "the administrator capability" }}
    >
      {(me) => (
        <section>
          <h1>Accounts &amp; roles</h1>
          <p className="lede">
            Roles decide who may review. Direct-create decides who may publish without a membership.
            Organisation verification is a reviewer capability and lives on{" "}
            <Link href="/review?tab=organisations">Review queues → Organisations</Link>.
          </p>
          <Accounts me={me} />
        </section>
      )}
    </RequireSession>
  );
}

function Accounts({ me }: { me: Me }) {
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
    <>
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
        <button type="submit" className="button-primary">
          Search
        </button>
      </form>
      <ActionNote note={note} />

      <ResourceView resource={state} what="accounts" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState
              title={search === "" ? "No accounts yet." : "No accounts matched."}
              detail={
                search === ""
                  ? "An account is created the first time somebody signs in."
                  : "Handles, display names and provider subjects are all searched."
              }
              action={
                search !== "" ? (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setSearch("");
                    }}
                  >
                    Show every account
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="table-scroll">
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
                    <AccountRow key={account.id} account={account} me={me} busy={busy} act={act} />
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
    </>
  );
}

function AccountRow({
  account,
  me,
  busy,
  act,
}: {
  account: AccountSummary;
  me: Me;
  busy: boolean;
  act: (work: () => Promise<string>) => Promise<void>;
}) {
  const api = useApi();
  const session = useSession();
  const [proposed, setProposed] = useState<AccountRole | null>(null);
  const [directCreate, setDirectCreate] = useState(false);

  const isSelf = account.id === me.accountId;
  /** Demoting yourself out of `admin` is the one change that cannot be undone from this screen. */
  const selfDemotion = isSelf && account.globalRole === "admin" && proposed !== "admin";

  const name = account.handle ?? `account ${account.id}`;

  return (
    <>
      <tr>
        <th scope="row">
          <span className="row-title">
            <UntrustedText value={account.handle} fallback={`account ${account.id}`} />
          </span>
          {isSelf ? <span className="badge badge-pending">you</span> : null}
          <div className="muted">
            <code>#{account.id}</code> ·{" "}
            <UntrustedText value={account.displayName} fallback="no display name" /> · joined{" "}
            {formatInstant(account.createdAt)}
          </div>
        </th>
        <td>
          <select
            aria-label={`Global role for account ${account.id}`}
            value={proposed ?? account.globalRole}
            disabled={busy}
            onChange={(event) => {
              const role = event.target.value as AccountRole;
              setProposed(role === account.globalRole ? null : role);
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
          <button type="button" disabled={busy} onClick={() => setDirectCreate(!directCreate)}>
            {account.directCreate ? "Revoke…" : "Grant…"}
          </button>
          <div className="muted">{account.directCreate ? "granted" : "not granted"}</div>
        </td>
      </tr>

      {proposed !== null ? (
        <tr>
          <td colSpan={3}>
            <ConfirmPanel
              title={`Make ${name} ${proposed === "admin" ? "an" : "a"} ${proposed}?`}
              confirmLabel={`Change the role to ${proposed}`}
              busyLabel="Changing…"
              busy={busy}
              onCancel={() => setProposed(null)}
              onConfirm={() =>
                void act(async () => {
                  await api.admin.setRole(account.id, proposed);
                  setProposed(null);
                  // A role change to YOURSELF changes what this very page may do, and the capability
                  // flags the navigation renders from came with the session. Re-reading them is what
                  // stops the UI insisting you still hold something the API has just taken away.
                  if (isSelf) session.reloadMe();
                  return `${name} is now ${proposed}.`;
                })
              }
            >
              <p>
                A <strong>{proposed}</strong> {ROLE_MEANING[proposed]}
              </p>
              {selfDemotion ? (
                <p>
                  <strong>
                    This is your own account, and it takes your administrator rights away.
                  </strong>{" "}
                  You will not be able to undo it from this page — nobody can change roles except an
                  administrator, so another one has to change yours back. If you are the only
                  administrator, nobody can.
                </p>
              ) : null}
              {proposed === "admin" && !isSelf ? (
                <p>
                  An administrator can change any role, including yours, and can grant themselves
                  direct-create.
                </p>
              ) : null}
            </ConfirmPanel>
          </td>
        </tr>
      ) : null}

      {directCreate ? (
        <tr>
          <td colSpan={3}>
            <ConfirmPanel
              title={
                account.directCreate
                  ? `Revoke direct-create from ${name}?`
                  : `Grant direct-create to ${name}?`
              }
              confirmLabel={account.directCreate ? "Revoke it" : "Grant it"}
              busyLabel={account.directCreate ? "Revoking…" : "Granting…"}
              busy={busy}
              onCancel={() => setDirectCreate(false)}
              onConfirm={() =>
                void act(async () => {
                  await api.admin.setDirectCreate(account.id, !account.directCreate);
                  setDirectCreate(false);
                  return account.directCreate
                    ? `Direct-create revoked from ${name}.`
                    : `Direct-create granted to ${name}.`;
                })
              }
            >
              {account.directCreate ? (
                <p>
                  Their submissions go back to landing pending, unless they hold a membership on a
                  verified organisation. Listings they have already published stay published.
                </p>
              ) : (
                <p>
                  They will publish into <strong>any namespace</strong> — including one belonging to
                  an organisation they are not a member of — immediately and without review, from a
                  browser session. It is the widest grant on this page and it is not scoped to
                  anything.{" "}
                  <strong>
                    A membership on a verified organisation is the narrower way to give somebody
                    publishing rights
                  </strong>{" "}
                  and is almost always the one that is meant.
                </p>
              )}
              <p className="muted footnote">
                It does not elevate an API key: a `write`-scoped key on this account still lands its
                submissions pending. Publishing without review is a session-only power.
              </p>
            </ConfirmPanel>
          </td>
        </tr>
      ) : null}
    </>
  );
}
