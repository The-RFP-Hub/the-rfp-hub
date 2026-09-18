import { createHmac, timingSafeEqual } from "node:crypto";

export type UnsubscribePurpose = "stale_listing_reminder";

export const UNSUBSCRIBE_PATH = "/v1/email/unsubscribe";
export const UNSUBSCRIBE_TOKEN_PATTERN = "^[1-9][0-9]{0,15}\\.[A-Za-z0-9_-]{43}$";

const TOKEN = new RegExp(UNSUBSCRIBE_TOKEN_PATTERN);
// Domain separation: the session secret must never produce a MAC usable in any other context.
const KEY_LABEL = "rfphub:email-unsubscribe:v1";

function mac(secret: string, accountId: number, purpose: UnsubscribePurpose): Buffer {
  const key = createHmac("sha256", secret).update(KEY_LABEL).digest();
  return createHmac("sha256", key).update(`${purpose}:${accountId}`).digest();
}

export function signUnsubscribeToken(
  secret: string,
  accountId: number,
  purpose: UnsubscribePurpose,
): string {
  return `${accountId}.${mac(secret, accountId, purpose).toString("base64url")}`;
}

/** The account a token names, or undefined when it is malformed or not ours. */
export function verifyUnsubscribeToken(
  secret: string,
  token: string,
  purpose: UnsubscribePurpose,
): number | undefined {
  if (!TOKEN.test(token)) return undefined;
  const [rawId = "", signature = ""] = token.split(".");
  const accountId = Number(rawId);
  if (!Number.isSafeInteger(accountId)) return undefined;
  const expected = mac(secret, accountId, purpose);
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  return accountId;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function unsubscribeUrl(
  apiBaseUrl: string,
  token: string,
  production = process.env.NODE_ENV === "production",
): string {
  const url = new URL(UNSUBSCRIBE_PATH, apiBaseUrl);
  // An unset BETTER_AUTH_URL falls back to loopback; a dead opt-out link must not reach a recipient.
  if (production && LOOPBACK.has(url.hostname)) {
    throw new Error("unsubscribe link would point at a loopback host; set BETTER_AUTH_URL");
  }
  url.searchParams.set("token", token);
  return url.href;
}
