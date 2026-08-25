"use client";

/**
 * API keys: mint, see, revoke.
 *
 * THE SECRET IS SHOWN EXACTLY ONCE, and this page is built around that fact rather than working
 * around it. It is held in component state, never written to storage, and disappears on any
 * navigation — so the page says so before minting, and keeps the value on screen until the operator
 * explicitly dismisses it.
 *
 * Every route here is session-only on the API: a key cannot mint another key. Rotation is therefore
 * create-then-revoke, in that order, which overlaps by construction — the page spells the sequence
 * out because doing it the other way round is a self-inflicted outage.
 */
import { RequireSession } from "@/components/Chrome";
import { ConfirmPanel } from "@/components/Confirm";
import { UntrustedText } from "@/components/UntrustedText";
import { ActionNote, EmptyState, ResourceView } from "@/components/states";
import { ApiError } from "@/lib/api";
import { formatInstant } from "@/lib/format";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import type { ApiKeyScope } from "@/lib/types";
import { Fragment, useCallback, useState } from "react";

const SCOPES: { value: ApiKeyScope; label: string; detail: string }[] = [
  { value: "read", label: "read", detail: "Read the same data an anonymous caller can." },
  { value: "write", label: "write", detail: "Submit and replace listings." },
  {
    value: "publish",
    label: "publish",
    detail:
      "Required for ANY path that publishes immediately — including on an account that could otherwise publish. Without it, an auto-approving submission lands pending instead.",
  },
];

export default function KeysPage() {
  return (
    <RequireSession capability={{ needs: (me) => me.canManageKeys, label: "key management" }}>
      {() => <Keys />}
    </RequireSession>
  );
}

function Keys() {
  const api = useApi();
  const load = useCallback(() => api.keys.list(), [api]);
  const { state, reload } = useResource(load);

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["read"]);
  const [createBusy, setCreateBusy] = useState(false);
  const [confirmingKeyId, setConfirmingKeyId] = useState<number | null>(null);
  const [revokingKeyId, setRevokingKeyId] = useState<number | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copyResult, setCopyResult] = useState<{
    kind: "ok" | "error";
    message: string;
  } | null>(null);

  const toggle = (scope: ApiKeyScope) =>
    setScopes((current) =>
      current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope],
    );

  const create = async () => {
    setCreateBusy(true);
    setNote(null);
    try {
      const created = await api.keys.create({ name: name || null, scopes });
      setSecret(created.token);
      setCopyResult(null);
      setName("");
      setNote({ kind: "ok", message: "Key created. The secret below is shown once." });
      reload();
    } catch (error) {
      setNote({
        kind: "error",
        message:
          error instanceof ApiError ? `${error.message} (${error.code})` : "Could not mint a key.",
      });
    } finally {
      setCreateBusy(false);
    }
  };

  const revoke = async (id: number) => {
    setRevokingKeyId(id);
    setNote(null);
    try {
      await api.keys.revoke(id);
      setNote({ kind: "ok", message: `Key ${id} revoked. Audit rows naming it still resolve.` });
      setConfirmingKeyId(null);
      reload();
    } catch (error) {
      setNote({
        kind: "error",
        message:
          error instanceof ApiError ? `${error.message} (${error.code})` : "Could not revoke.",
      });
    } finally {
      setRevokingKeyId(null);
    }
  };

  const copySecret = async () => {
    if (!secret) return;
    if (!navigator.clipboard) {
      setCopyResult({
        kind: "error",
        message: "Clipboard access is unavailable. Copy the secret manually.",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(secret);
      setCopyResult({ kind: "ok", message: "Copied to the clipboard." });
    } catch {
      setCopyResult({
        kind: "error",
        message: "Could not copy to the clipboard. Copy the secret manually.",
      });
    }
  };

  return (
    <section>
      <h1>API keys</h1>
      <p className="muted footnote">
        A key authenticates a machine — an ingestion job, a data partner&rsquo;s pipeline. It can
        never mint another key, change this account&rsquo;s identity, review anything or grant a
        role: those need a signed-in session, which is what you are using right now.
      </p>

      {secret ? (
        <div className="card">
          <h2>Copy this now</h2>
          <p>
            This is the only time it will ever be shown. It is not stored by this frontend and the
            API keeps only a hash of it — a lost secret is replaced by minting a new key, never
            recovered.
          </p>
          <p className="secret">{secret}</p>
          <div className="row">
            <button type="button" onClick={() => void copySecret()}>
              Copy
            </button>
            <button
              type="button"
              onClick={() => {
                setSecret(null);
                setCopyResult(null);
              }}
            >
              I have stored it
            </button>
            <ActionNote note={copyResult} />
          </div>
        </div>
      ) : null}

      <div className="card" id="mint-key">
        <h2>Mint a key</h2>
        <div className="field">
          <label htmlFor="key-name">Label</label>
          <p className="hint">For your own bookkeeping. It is not a secret and not an identity.</p>
          <input id="key-name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <fieldset className="field">
          <legend>Scopes</legend>
          {SCOPES.map((scope) => (
            <p key={scope.value}>
              <label>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope.value)}
                  onChange={() => toggle(scope.value)}
                  style={{ width: "auto", marginRight: "0.5rem" }}
                />
                <code>{scope.label}</code>
              </label>
              <span className="hint">{scope.detail}</span>
            </p>
          ))}
        </fieldset>
        <button
          type="button"
          onClick={() => void create()}
          disabled={createBusy || scopes.length === 0}
        >
          {createBusy ? "Minting…" : "Mint"}
        </button>
        <ActionNote note={note} />
      </div>

      <ResourceView resource={state} what="your keys" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState
              title="No keys yet."
              detail="Nothing is broken — an account that only uses this frontend never needs one. A key is for scripts and integrations that submit on your behalf."
              action={
                <a href="#mint-key" className="button-primary">
                  Mint your first key
                </a>
              }
            />
          ) : (
            <div className="table-scroll">
              <table>
                <caption>
                  To rotate: mint the replacement, deploy it, then revoke the old one — in that
                  order.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Key</th>
                    <th scope="col">Scopes</th>
                    <th scope="col">Last used</th>
                    <th scope="col">State</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((key) => {
                    const keyName = key.name || `${key.keyPrefix}…`;
                    return (
                      <Fragment key={key.id}>
                        <tr>
                          <th scope="row">
                            <UntrustedText value={key.name} fallback="(unlabelled)" />
                            <div className="muted">
                              <code>{key.keyPrefix}…</code> · created {formatInstant(key.createdAt)}
                            </div>
                          </th>
                          <td>
                            <code>{key.scopes.join(", ") || "none"}</code>
                          </td>
                          <td className="muted">
                            {key.lastUsedAt ? formatInstant(key.lastUsedAt) : "never"}
                            <div className="muted">recorded at most once every few minutes</div>
                          </td>
                          <td>
                            {key.revokedAt ? `revoked ${formatInstant(key.revokedAt)}` : "active"}
                          </td>
                          <td>
                            {key.revokedAt ? null : (
                              <button
                                type="button"
                                disabled={revokingKeyId !== null}
                                onClick={() => setConfirmingKeyId(key.id)}
                              >
                                Revoke…
                              </button>
                            )}
                          </td>
                        </tr>
                        {confirmingKeyId === key.id ? (
                          <tr>
                            <td colSpan={5}>
                              <ConfirmPanel
                                title={`Revoke ${keyName}?`}
                                confirmLabel="Revoke key"
                                busyLabel="Revoking…"
                                busy={revokingKeyId === key.id}
                                onCancel={() => setConfirmingKeyId(null)}
                                onConfirm={() => void revoke(key.id)}
                              >
                                <p>
                                  Integrations using this key stop authenticating immediately.
                                  Revocation cannot be undone. To rotate without an outage: create
                                  the replacement, deploy it, then revoke this key.
                                </p>
                              </ConfirmPanel>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
    </section>
  );
}
