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
import { ActionNote, EmptyState, ResourceView, actionErrorNote } from "@/components/states";
import { formatInstant } from "@/lib/format";
import { MCP_GUIDE } from "@/lib/links";
import { CAPABILITY_DENIAL_COPY, ROUTE_GATE_COPY } from "@/lib/presentation";
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
      "Allows immediate publication when the account also has that authority. Leave this off for the MCP's reviewed submission flow.",
  },
];

export default function KeysPage() {
  return (
    <RequireSession
      gate={ROUTE_GATE_COPY.keys}
      capability={{ needs: (me) => me.canManageKeys, ...CAPABILITY_DENIAL_COPY.keyManagement }}
    >
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
  const [createNote, setCreateNote] = useState<{
    kind: "ok" | "error";
    message: string;
  } | null>(null);
  const [revokeResult, setRevokeResult] = useState<{
    keyId: number;
    note: { kind: "ok" | "error"; message: string };
  } | null>(null);
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
    setCreateNote(null);
    try {
      const created = await api.keys.create({ name: name || null, scopes });
      setSecret(created.token);
      setCopyResult(null);
      setName("");
      setCreateNote({
        kind: "ok",
        message: "Key created. Copy it now; it will not be shown again.",
      });
      reload();
    } catch (error) {
      setCreateNote(actionErrorNote(error, "Could not mint a key."));
    } finally {
      setCreateBusy(false);
    }
  };

  const revoke = async (id: number, keyName: string) => {
    setRevokingKeyId(id);
    setRevokeResult(null);
    try {
      await api.keys.revoke(id);
      setRevokeResult({
        keyId: id,
        note: {
          kind: "ok",
          message: `Revoked ${keyName}. Audit rows naming it still resolve.`,
        },
      });
      setConfirmingKeyId(null);
      reload();
    } catch (error) {
      setRevokeResult({
        keyId: id,
        note: actionErrorNote(error, "Could not revoke."),
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

  const prepareMcpKey = () => {
    setName((current) => current || "RFP Hub MCP");
    setScopes(["read", "write"]);
    document.getElementById("key-name")?.focus();
  };

  return (
    <section>
      <h1>API keys</h1>
      <p className="muted footnote">
        API keys let integrations submit listings on your behalf. The RFP Hub MCP searches without a
        key; give it a <code>write</code> key only when you want it to submit. A key cannot manage
        your account, review a submission or grant a role.
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
          <p>
            Using this key with the MCP? Set <code>RFPHUB_API_BASE</code> to{" "}
            <code className="wrap-anywhere">{api.baseUrl}</code> and store the key as{" "}
            <code>RFPHUB_API_KEY</code> in your MCP client&rsquo;s private environment. Then restart
            the client. Keep this page open while you continue. Never paste the key into a prompt,
            tool argument or terminal command.
          </p>
          <div className="row">
            <button type="button" className="button-primary" onClick={() => void copySecret()}>
              Copy key
            </button>
            <a href={MCP_GUIDE} target="_blank" rel="noopener noreferrer">
              Open MCP setup guide (new tab)
            </a>
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

      <section className="card card-strong" aria-labelledby="mcp-setup-heading">
        <h2 id="mcp-setup-heading">Connect the RFP Hub MCP</h2>
        <p className="prose">
          This page is the first step only when an AI client should submit. Search and fetch work
          anonymously, without an account or key. The server is model-provider agnostic: any MCP
          client that can launch a local <code>stdio</code> server can use it.
        </p>
        <ol className="integration-steps">
          <li>
            <strong>Mint safely.</strong> Use <code>read</code> and <code>write</code>; leave{" "}
            <code>publish</code> off so new submissions wait for review.
          </li>
          <li>
            <strong>Point it at this deployment.</strong> Set <code>RFPHUB_API_BASE</code> to{" "}
            <code className="wrap-anywhere">{api.baseUrl}</code>, then store the one-time secret as{" "}
            <code>RFPHUB_API_KEY</code> in the client&rsquo;s private environment.
          </li>
          <li>
            <strong>Install and restart.</strong> Add the client-neutral <code>stdio</code>{" "}
            connection from the guide to your MCP client. The server will then expose{" "}
            <code>submit_opportunity</code> and ask for a separate terminal approval before writing.
          </li>
        </ol>
        <div className="row">
          <button type="button" onClick={prepareMcpKey}>
            Prepare an MCP key
          </button>
          <a href={MCP_GUIDE} target="_blank" rel="noopener noreferrer">
            Open MCP setup guide (new tab)
          </a>
        </div>
      </section>

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
              <label className="choice-row">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope.value)}
                  onChange={() => toggle(scope.value)}
                />
                <code>{scope.label}</code>
              </label>
              <span className="hint">{scope.detail}</span>
            </p>
          ))}
        </fieldset>
        <button
          type="button"
          className="button-primary"
          onClick={() => void create()}
          disabled={createBusy || scopes.length === 0}
        >
          {createBusy ? "Minting…" : "Mint"}
        </button>
        <ActionNote note={createNote} />
      </div>

      <ResourceView resource={state} what="your keys" onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState
              title="No keys yet."
              detail="Nothing is broken — an account that only uses this frontend never needs one. A key is for scripts and integrations that submit on your behalf."
              action={<a href="#mint-key">Mint your first key</a>}
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
                                onClick={() => {
                                  setRevokeResult(null);
                                  setConfirmingKeyId(key.id);
                                }}
                              >
                                Revoke…
                              </button>
                            )}
                          </td>
                        </tr>
                        {confirmingKeyId === key.id || revokeResult?.keyId === key.id ? (
                          <tr>
                            <td colSpan={5}>
                              {confirmingKeyId === key.id ? (
                                <ConfirmPanel
                                  title={`Revoke ${keyName}?`}
                                  confirmLabel="Revoke key"
                                  busyLabel="Revoking…"
                                  busy={revokingKeyId === key.id}
                                  onCancel={() => setConfirmingKeyId(null)}
                                  onConfirm={() => void revoke(key.id, keyName)}
                                >
                                  <p>
                                    Integrations using this key stop authenticating immediately.
                                    Revocation cannot be undone. To rotate without an outage: create
                                    the replacement, deploy it, then revoke this key.
                                  </p>
                                </ConfirmPanel>
                              ) : null}
                              <ActionNote
                                note={revokeResult?.keyId === key.id ? revokeResult.note : null}
                              />
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
