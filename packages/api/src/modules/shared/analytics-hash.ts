/**
 * PURE analytics hashing — HMAC, no DB, no HTTP, unit-tested.
 *
 * The publisher dashboard needs "how many distinct visitors", which needs a stable per-visitor
 * token, which must not be a way to recover who the visitor was. Three properties, and each one is
 * a decision that a simpler implementation gets wrong:
 *
 * 1. **HMAC, not `sha256(salt + ip)`.** The IPv4 space is 2^32 — about four billion candidates.
 *    A plain digest with a known or leaked salt is exhaustively invertible on a laptop, so the
 *    "hash" would be a reversible encoding of the address. HMAC's key is not concatenated data,
 *    and the key never enters an image: it arrives at runtime through the task definition's
 *    `secrets:` (docs/deploy.md).
 * 2. **The UTC date is part of the input**, so the effective key rotates daily and yesterday's
 *    hash for an address cannot be joined to today's. That bounds the window in which any
 *    behavioural profile can be assembled to a single day, which is all a daily rollup needs.
 * 3. **Truncated to 128 bits.** Enough that collisions are not a counting problem at any volume
 *    this will see, and it keeps the stored value from being a full-strength digest to attack.
 *
 * The referrer is reduced to its HOST here for the same reason: a full referring URL is a page a
 * person was reading, and the dashboard's question is only which site sent the traffic.
 */
import { createHmac } from "node:crypto";

/** Hex characters kept from each digest — 32 hex = 128 bits. */
const LENGTH = 32;

/** The UTC calendar day, `YYYY-MM-DD`. UTC so the rotation boundary is not a server's timezone. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Join the inputs unambiguously.
 *
 * A separator that cannot appear in any part is what stops `("ab", "c")` and `("a", "bc")` from
 * hashing alike — a concatenation collision is a real way for two visitors to become one. A
 * newline is used rather than a NUL byte: NUL makes a file invisible to `check:neutral` and to
 * `git diff`, and there is no reason to reach for it when a newline cannot appear in an address or
 * a date either.
 */
const join = (parts: string[]): string => parts.join("\n");

function hmac(key: string, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex").slice(0, LENGTH);
}

/**
 * A per-visitor token for one day: address + user agent + the day.
 *
 * Including the user agent is what makes it a rough SESSION rather than a rough person — two
 * browsers on one address count as two, which is both closer to the truth for a shared connection
 * and less identifying than the address alone.
 */
export function sessionHash(
  key: string,
  ip: string,
  userAgent: string,
  at: Date = new Date(),
): string {
  return hmac(key, join(["session", ip, userAgent, utcDay(at)]));
}

/**
 * A per-address token for one day, with no user agent.
 *
 * It exists to spot one address generating implausible traffic. Being keyed differently from
 * `sessionHash` means the two cannot be correlated by anyone who obtains only the stored values.
 */
export function ipHash(key: string, ip: string, at: Date = new Date()): string {
  return hmac(key, join(["ip", ip, utcDay(at)]));
}

/**
 * The host of a referring URL, lowercased — or undefined for an absent, unparseable or
 * same-origin-hidden referrer. Never the path, never the query.
 */
export function referrerHost(referrer: string | undefined | null): string | undefined {
  const value = (referrer ?? "").trim();
  if (value === "") return undefined;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

/**
 * Traffic this project generates about itself, which must never be counted as a publisher's.
 *
 * Without this the nightly export walks every entry and the compliance checker executes every
 * published operation — every night, against production — and every publisher's view count is
 * mostly us. Both identify themselves, so both are excluded by name; the third pattern is a
 * conservative sweep for the obvious crawlers.
 */
const INTERNAL_AGENTS = [
  /\brfphub-exporter\b/i,
  /\brfphub-m2-compliance\b/i,
  /\brfphub-m3-compliance\b/i,
];
const BOT =
  /bot|crawler|spider|crawling|slurp|headless|curl\/|wget\/|python-requests|node-fetch|okhttp|scrapy|monitor|uptime|pingdom|lighthouse/i;

/**
 * Whether a request should be counted at all.
 *
 * `DNT: 1` is honoured. It is not legally required and it is trivially ignorable, which is exactly
 * why honouring it is worth something: the reader has stated a preference and the only cost of
 * respecting it is a slightly smaller number on a chart the docs already label best-effort.
 */
export function isCountableRequest(
  userAgent: string | undefined,
  dnt: string | undefined,
): boolean {
  if ((dnt ?? "").trim() === "1") return false;
  const ua = (userAgent ?? "").trim();
  if (ua === "") return false;
  if (INTERNAL_AGENTS.some((re) => re.test(ua))) return false;
  return !BOT.test(ua);
}
