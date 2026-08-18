/**
 * Where a Playwright worker gets a real access token.
 *
 * A worker is a separate process from the runner, and access tokens are short-lived (roughly an
 * hour). A run long enough to matter will outlive a token minted at bring-up, so the workers need
 * to be able to mint, not just to receive. Two sources exist, and which one is available IS the
 * difference between two ladder levels:
 *
 *   MINT   — the app secret is present, so a worker asks the provider for a fresh test-account
 *            token whenever the one it holds is close to expiry. This is the normal path.
 *   HARVEST — no app secret, but a browser session was established; the token the page put on its
 *            own `/v1/me` request was captured at bring-up and handed over through a file. It is a
 *            genuine provider-issued token, and it is the only one available at the browser-only
 *            level. It cannot be refreshed from here, so a run at that level is bounded by the
 *            token's lifetime — which the runner states in the report rather than hiding.
 *
 * WHY THE APP SECRET REACHES A PLAYWRIGHT WORKER AT ALL, when it deliberately never reaches an API
 * process. The two are not the same risk. An API process is the system under test: giving it a
 * credential it does not need would mean the suite could not tell whether a behaviour came from the
 * product or from a capability the harness handed it, and `config.ts` only reads the secret for a
 * bootstrap path this suite does not use. A Playwright worker is the harness — it is the party that
 * is *supposed* to hold identity material — and withholding the secret there would not remove the
 * secret from the run, it would only force every token to be minted once, up front, and shared
 * through a file for the whole run. The secret is registered with the redactor and is one of the
 * long-lived values the end-of-run artifact scan searches for.
 */
import { readFileSync } from "node:fs";
import { decodeJwt } from "jose";
import { register } from "./redact.js";

/** Written by the runner into the run's 0700 temp directory. Never in the repository. */
export interface IdentityRecord {
  did: string;
  /** The credential that mints this DID's token, when minting is available. */
  email?: string;
  phone?: string;
  /** A token already in hand — the browser-harvested path. */
  token?: string;
}

export const IDENTITIES_ENV = "E2E_IDENTITIES_FILE";
export const APP_ID_ENV = "E2E_PRIVY_APP_ID";
/** Deliberately a DIFFERENT name from `PRIVY_APP_SECRET`, so it cannot be inherited into an API child. */
export const APP_SECRET_ENV = "E2E_PRIVY_APP_SECRET";

/** Re-mint once the remaining lifetime drops below this. */
const REFRESH_MARGIN_SECONDS = 300;

interface CachedToken {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();
let records: IdentityRecord[] | undefined;

function identities(): IdentityRecord[] {
  if (records) return records;
  const path = process.env[IDENTITIES_ENV];
  if (!path) {
    records = [];
    return records;
  }
  try {
    records = JSON.parse(readFileSync(path, "utf8")) as IdentityRecord[];
  } catch {
    records = [];
  }
  return records;
}

/** True when this process can obtain a token for any identity at all. */
export function available(): boolean {
  return identities().length > 0;
}

function expiryOf(token: string): number {
  try {
    const claims = decodeJwt(token);
    return typeof claims.exp === "number" ? claims.exp : 0;
  } catch {
    return 0;
  }
}

function fresh(entry: CachedToken | undefined): entry is CachedToken {
  return Boolean(entry && entry.expiresAt - REFRESH_MARGIN_SECONDS > Math.floor(Date.now() / 1000));
}

/**
 * A usable access token for a DID.
 *
 * Throws rather than returning undefined: every call site is a spec that has already established
 * (through the ladder level) that this identity should be reachable, so a failure here is a real
 * failure and must not be swallowed into a passing test.
 */
export async function tokenForDid(did: string): Promise<string> {
  const cached = cache.get(did);
  if (fresh(cached)) return cached.token;

  const record = identities().find((identity) => identity.did === did);
  if (!record) {
    throw new Error(`tokens: no identity record for ${did} — the run did not provision this actor`);
  }

  // The harvested path first: when it is present it is the ONLY source, and re-minting is not
  // possible. An expired harvested token is a hard stop with an explanation, not a silent retry.
  if (record.token && !record.email && !record.phone) {
    if (!fresh({ token: record.token, expiresAt: expiryOf(record.token) })) {
      throw new Error(
        `tokens: the browser-harvested token for ${did} has expired and cannot be re-minted at this ladder level (no app secret). Re-run the suite, or provide PRIVY_APP_SECRET so workers can mint.`,
      );
    }
    cache.set(did, { token: record.token, expiresAt: expiryOf(record.token) });
    return record.token;
  }

  const appId = process.env[APP_ID_ENV];
  const appSecret = process.env[APP_SECRET_ENV];
  if (!appId || !appSecret) {
    if (record.token) {
      cache.set(did, { token: record.token, expiresAt: expiryOf(record.token) });
      return record.token;
    }
    throw new Error(
      `tokens: cannot mint for ${did} — ${APP_SECRET_ENV} is not set in this process`,
    );
  }
  register(appSecret, { label: "privy-app-secret", longLived: true });

  const { PrivyClient } = await import("@privy-io/node");
  const apps = new PrivyClient({ appId, appSecret }).apps();
  const response = record.email
    ? await apps.getTestAccessToken({ email: record.email })
    : record.phone
      ? await apps.getTestAccessToken({ phone_number: record.phone })
      : await apps.getTestAccessToken();

  const token = response.access_token;
  register(token, { label: "privy-access-token", longLived: false });
  cache.set(did, { token, expiresAt: expiryOf(token) });
  return token;
}
