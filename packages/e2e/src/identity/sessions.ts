/**
 * Signing in, over real HTTP, against the run's own disposable stack.
 *
 * WHAT REPLACED WHAT. This module stands where `tokens.ts` did, and the difference is the point of
 * the migration: that file asked a third-party tenant for a token, needed an app id and an app
 * secret to do it, cached what it got because minting was rate-limited and finite, and could hand
 * out only as many distinct identities as somebody had provisioned in a dashboard. This one performs
 * the product's own sign-in — request a code, read it out of the file transport, exchange it — so an
 * identity is created by using it, and there is no tenant, no secret and no ceiling.
 *
 * `E2E_PRIVY_APP_ID` and `E2E_PRIVY_APP_SECRET` are gone with the tenant. There is no credential for
 * this process to hold: the only thing it needs is the outbox directory, which the runner created.
 *
 * WHY ALL THREE FIELDS ARE RETURNED. `email` is what the browser types, `token` is what HTTP calls
 * carry, and `userId` is what rows key on — `accounts.auth_user_id` joins to `auth_user.id`, so a
 * seed or a cleanup that had only the address would have to go and look it up. Returning the id the
 * sign-in response already carried costs nothing and removes a whole class of lookup.
 */
import { readFileSync } from "node:fs";
import { ApiClient } from "../http.js";
import { register } from "../redact.js";
import { waitForOtp } from "./outbox.js";

/** Points every process in a run at the identities the runner has already established. */
export const IDENTITIES_ENV = "E2E_IDENTITIES_FILE";
/** Where the API writes sign-in codes. Set by the runner; inside the run's 0700 directory. */
export const OUTBOX_ENV = "E2E_OUTBOX_DIR";
/** The API's own origin, so a worker can sign in without reading the whole state file. */
export const API_URL_ENV = "E2E_API_URL";
/**
 * This run's session-signing secret.
 *
 * Reaches the Playwright child and nothing else. A spec that boots a SECOND API against the same
 * database — `ssrf.spec.ts` does, to get an instance with the address checks on — has to sign its
 * sessions with the same secret, or the run's existing tokens would be refused by it and every
 * assertion in that file would fail as an authentication error wearing a refusal's clothes.
 *
 * It is kept out of `state.json` deliberately: that file is identifiers and configuration and is
 * printed into reports. This is a secret, so it travels the way the tokens do — through the run's
 * 0700 material and the child environment — and it is registered with the redactor.
 */
export const AUTH_SECRET_ENV = "E2E_AUTH_SECRET";

export interface Identity {
  /** The address the browser types and the outbox is keyed on. */
  email: string;
  /** `auth_user.id` — the join key for `accounts.auth_user_id`. */
  userId: string;
  /** The signed session token: what `Authorization: Bearer` carries. */
  token: string;
}

/**
 * Addresses are `@rfphub.invalid` on purpose.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve, so a misconfigured run that somehow
 * reached a real mail transport would fail to deliver rather than send a live sign-in code to
 * somebody's actual inbox.
 */
export function addressFor(runId: string, label: string): string {
  return `e2e+${runId}-${label}@rfphub.invalid`;
}

/** Cached per address, per process: signing in twice for the same identity is pure waste. */
const cache = new Map<string, Identity>();

interface SignInDeps {
  apiUrl: string;
  outboxDir: string;
}

function deps(): SignInDeps {
  const apiUrl = process.env[API_URL_ENV];
  const outboxDir = process.env[OUTBOX_ENV];
  if (!apiUrl || !outboxDir) {
    throw new Error(
      `sessions: ${API_URL_ENV} and ${OUTBOX_ENV} must both be set. They are exported by the runner (packages/e2e/src/run.ts); \`playwright test\` on its own has no stack to sign in to.`,
    );
  }
  return { apiUrl, outboxDir };
}

/**
 * Signs in as `email`, creating the identity if this is its first time.
 *
 * There is no separate "register" step, and that is the product's design rather than a shortcut: the
 * first successful code exchange for an address creates the `auth_user` row. The corresponding
 * `accounts` row is created just-in-time by the API on the first `/v1/me` — which is itself an M3
 * criterion, and is why nothing here calls `/v1/me` as a side effect.
 */
export async function identityFor(
  email: string,
  options: Partial<SignInDeps> = {},
): Promise<Identity> {
  const cached = cache.get(email);
  if (cached) return cached;

  const resolved = { ...deps(), ...options };
  const client = new ApiClient({ baseUrl: resolved.apiUrl });

  const sent = await client.post("/api/auth/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  if (sent.status !== 200) {
    throw new Error(
      `sessions: could not request a sign-in code for ${email} — POST /api/auth/email-otp/send-verification-otp → ${sent.status} ${sent.text.slice(0, 300)}`,
    );
  }

  // The send is deliberately NOT awaited by the API (awaiting the provider would make the response
  // time a function of whether the address exists, which is an enumeration oracle), so the file
  // appears strictly after this call resolves. `waitForOtp` polls for it and deletes it on read.
  const otp = await waitForOtp(resolved.outboxDir, email);

  const signedIn = await client.post<{ user?: { id?: string } }>("/api/auth/sign-in/email-otp", {
    email,
    otp,
  });
  if (signedIn.status !== 200) {
    throw new Error(
      `sessions: sign-in failed for ${email} — POST /api/auth/sign-in/email-otp → ${signedIn.status} ${signedIn.text.slice(0, 300)}`,
    );
  }

  // The SIGNED token, from the bearer plugin's `set-auth-token` mirror — not the raw session cookie.
  // The API verifies the HMAC before it touches the database, so an unsigned value is refused
  // outright; `auth-negative.spec.ts` pins exactly that.
  const token = signedIn.headers.get("set-auth-token");
  const userId = signedIn.body?.user?.id;
  if (!token || !userId) {
    throw new Error(
      `sessions: sign-in for ${email} returned ${token ? "no user id" : "no set-auth-token header"}. Both are required: HTTP calls use the token, and rows key on the user id.`,
    );
  }

  register(token, { label: "session-token", longLived: false });

  const identity: Identity = { email, userId, token };
  cache.set(email, identity);
  return identity;
}

/**
 * Ends a session, so the token that carried it stops working.
 *
 * The revocation is what makes sign-out meaningful, and it is a capability the previous provider did
 * not give this suite at all: a token there was a self-contained assertion that stayed valid until
 * it expired, whoever wanted it stopped. Here the session is a row, and deleting it is immediate.
 */
export async function signOut(token: string, apiUrl = process.env[API_URL_ENV]): Promise<void> {
  if (!apiUrl) throw new Error(`sessions: ${API_URL_ENV} is not set`);
  const response = await new ApiClient({ baseUrl: apiUrl, token }).post("/api/auth/sign-out", {});
  if (response.status !== 200) {
    throw new Error(`sessions: sign-out → ${response.status} ${response.text.slice(0, 200)}`);
  }
  for (const [email, identity] of cache) {
    if (identity.token === token) cache.delete(email);
  }
}

/** The identities the runner established, as written to the run's identity file. */
export function established(path = process.env[IDENTITIES_ENV]): Identity[] {
  if (!path) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Identity[];
  } catch {
    return [];
  }
}

/**
 * A usable token for an identity the runner already established, signing in again if the cache in
 * this process is empty (a Playwright worker starts with nothing).
 */
export async function sessionFor(email: string): Promise<Identity> {
  const known = established().find((identity) => identity.email === email);
  if (known) {
    cache.set(email, known);
    register(known.token, { label: "session-token", longLived: false });
    return known;
  }
  return identityFor(email);
}
