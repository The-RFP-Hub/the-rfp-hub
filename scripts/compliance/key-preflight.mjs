/**
 * Proving the SCOPE of the m4 write key before the MCP server starts.
 *
 * The profile's whole claim is that a submission lands `pending` by construction rather than by
 * luck, and what makes that true is the key's scope. A `publish`-scoped key would publish the
 * fixture outright, so the "it is pending" assertion would pass against an entry that never was;
 * a read-only key would fail three phases in, after the run had already told the operator it was
 * exercising the interlock. Both are answerable in one request, before anything is spawned.
 *
 * `GET /v1/me` reports `credentialKind` and, for an API key, the `scopes` it was minted with; a
 * session reports `scopes: []` because scopes are a property of a delegation, not of the account.
 */
import { callJson } from "./client.mjs";

const WHY =
  "the m4 profile proves that a submission lands PENDING by construction, and the key's scope is what makes that true rather than incidental";

/** Why this run must not write, or `null` when the key is scoped exactly as the profile needs. */
export async function keyScopeRefusal(ctx, opts) {
  if (opts.milestone !== "m4") return null;

  const me = await callJson(ctx, "/v1/me", { token: opts.apiKey });
  if (!me.ok) {
    return `--api-key could not be checked against ${ctx.api}/v1/me — ${me.error}`;
  }
  if (me.status === 401) {
    return `--api-key was answered 401 by ${ctx.api}/v1/me: this deployment does not accept that credential. It may be revoked, or minted against a different deployment.`;
  }
  if (me.status !== 200) {
    return `--api-key was answered ${me.status} by ${ctx.api}/v1/me, so its scopes cannot be established — ${WHY}`;
  }
  if (me.json?.credentialKind !== "api_key") {
    return `--api-key is not an API key: ${ctx.api}/v1/me reports credentialKind ${JSON.stringify(me.json?.credentialKind)}. Pass the \`rfph_\` key the MCP server will submit with; a session belongs in --session-token.`;
  }
  const scopes = me.json?.scopes;
  if (!Array.isArray(scopes)) {
    return `${ctx.api}/v1/me returned no scopes array for --api-key, so what it may do cannot be established — ${WHY}`;
  }

  const faults = [];
  if (!scopes.includes("write")) {
    faults.push(
      "it is missing the `write` scope, so the submission would be refused three phases in, after this run had already reported that it was exercising the interlock",
    );
  }
  if (scopes.includes("publish")) {
    faults.push(
      "it carries the `publish` scope, which would publish the fixture outright — the `pending` assertion would then hold against an entry that never was pending, and the teardown would be rejecting a LIVE listing",
    );
  }
  if (faults.length === 0) return null;
  return `--api-key has scopes [${scopes.join(", ")}] and ${faults.join("; and ")}. Mint a write-only key: ${WHY}.`;
}
