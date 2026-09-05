/**
 * What the configured credential is allowed to do, settled once before the first submission. A
 * `publish`-scoped key makes an approved submission live at once, and a key without `write` is
 * refused by the API only after a person has already spent a single-use approval.
 *
 * NOT at startup: `initialize` stays network-free. The question is asked on the first write call
 * and the ANSWER is cached for the life of the process; a preflight that got no answer is not.
 */
import { ToolError, keyScopeError } from "./errors.js";
import type { ApiClient } from "./http.js";
import { truncate } from "./untrusted.js";

/** The scopes list is third-party text on an error path, so the echo of it is bounded. */
export const MAX_SCOPES_CHARS = 200;

export interface CredentialFacts {
  /** `api_key` for a minted key; a session reports something else and carries no scopes. */
  credentialKind: string | null;
  scopes: string[] | null;
}

let verdict: Promise<void> | null = null;

/** Test-only: forget the cached verdict so the next call asks again. */
export function resetKeyScopeCache(): void {
  verdict = null;
}

/** Shape-checked rather than trusted: this is a network body. */
export function readCredentialFacts(body: unknown): CredentialFacts {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { credentialKind: null, scopes: null };
  }
  const record = body as Record<string, unknown>;
  return {
    credentialKind: typeof record.credentialKind === "string" ? record.credentialKind : null,
    scopes: Array.isArray(record.scopes)
      ? record.scopes.filter((scope): scope is string => typeof scope === "string")
      : null,
  };
}

/** Why this key must not submit, or `null` when it carries exactly what the write path needs. */
export function scopeRefusal(facts: CredentialFacts): string | null {
  if (facts.credentialKind !== "api_key") {
    return `The API does not report the configured credential as an API key (\`credentialKind\`: ${JSON.stringify(facts.credentialKind)}), so what it may do cannot be established.`;
  }
  if (facts.scopes === null) {
    return "The API returned no list of scopes for the configured credential, so what it may do cannot be established.";
  }

  const faults: string[] = [];
  if (!facts.scopes.includes("write")) {
    faults.push(
      "it does not carry `write`, so the API would refuse the submission after a person had already spent a single-use approval",
    );
  }
  if (facts.scopes.includes("publish")) {
    faults.push(
      "it carries `publish`, so an approved submission would go live immediately instead of waiting for a reviewer",
    );
  }
  if (faults.length === 0) return null;

  const listed = truncate(facts.scopes.join(", "), MAX_SCOPES_CHARS);
  return `The configured credential has scopes [${listed}] and ${faults.join("; and ")}.`;
}

/** Resolves when the key may submit; throws the coded refusal when it may not. */
export async function assertKeyMaySubmit(api: ApiClient): Promise<void> {
  verdict ??= check(api).catch((err: unknown) => {
    if (!(err instanceof ToolError) || err.code !== "policy_denied") verdict = null;
    throw err;
  });
  return verdict;
}

async function check(api: ApiClient): Promise<void> {
  const { status, body } = await api.describeCredential();

  if (status === 401 || status === 403) {
    throw keyScopeError(
      `The API answered ${status} when asked what the configured credential may do, so the key was not accepted.`,
    );
  }
  if (status !== 200) {
    // Not a verdict about the key, so it is retried rather than remembered.
    throw new ToolError(
      "exec_failed",
      `The API answered ${status} when asked what the configured credential may do, so its scopes could not be established and nothing was validated, previewed or sent. Try again.`,
      { status },
    );
  }

  const refusal = scopeRefusal(readCredentialFacts(body));
  if (refusal !== null) throw keyScopeError(refusal);
}
