/**
 * PURE API-key token format: mint, parse, hash. No DB, no HTTP, unit-tested.
 *
 * Format: `rfph_<prefix>_<secret>`
 *
 *   `rfph_`   a fixed marker. It is what lets one `Authorization: Bearer …` header carry either
 *             kind of credential: a value starting with it is an API key, anything else is a
 *             session token. Discriminating on the token itself means a caller cannot present an
 *             API key and have it treated as a session, which is how the session-only routes stay
 *             session-only.
 *   `prefix`  8 lowercase base32 characters, stored in the clear. It identifies a key in a UI and
 *             in an audit row without the secret existing anywhere to identify it by.
 *   `secret`  32 bytes from the CSPRNG, base64url. 256 bits.
 *
 * WHY A PLAIN SHA-256 AND NOT A KDF — the first question any reviewer asks, so the answer lives in
 * the code as well as in docs/auth.md. A KDF's cost exists to make GUESSING expensive, and guessing
 * is only a threat when the secret comes from a small space: a human-chosen password. This secret
 * is 256 bits of CSPRNG output. There is no dictionary, no rainbow table and no plausible search;
 * an attacker with the hash has nothing to attack it with. What a KDF would buy in exchange is an
 * argon2 on the hot path of every authenticated request. So: `sha256(full token)`, hex, over a
 * unique index — one indexed lookup, constant time.
 *
 * The secret is returned by the mint exactly once and never stored. `key_hash` is all the database
 * holds, so a database disclosure yields nothing usable.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** The marker every API key starts with, and the thing credential-kind detection keys on. */
export const API_KEY_PREFIX = "rfph_";

/** Crockford-ish base32 without the ambiguous glyphs, so a prefix survives being read aloud. */
const BASE32 = "abcdefghjkmnpqrstvwxyz0123456789";
const PREFIX_LENGTH = 8;
const SECRET_BYTES = 32;

export interface MintedApiKey {
  /** The full token. Shown to the user ONCE; never stored, never logged. */
  token: string;
  /** The public identifier, stored in the clear. */
  prefix: string;
  /** `sha256(token)`, hex. This is what the database holds. */
  keyHash: string;
}

/** Unbiased base32 over the CSPRNG: 32 is a power of two, so masking five bits is uniform. */
function base32(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += BASE32[byte & 31];
  return out;
}

/** A new key. The only place a secret ever exists. */
export function mintApiKey(): MintedApiKey {
  const prefix = base32(PREFIX_LENGTH);
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const token = `${API_KEY_PREFIX}${prefix}_${secret}`;
  return { token, prefix, keyHash: hashApiKey(token) };
}

/** `sha256(token)` as hex — the stored form, and the lookup key. */
export function hashApiKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Whether a bearer value is an API key rather than a session token. */
export function isApiKeyToken(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX);
}

export interface ParsedApiKey {
  prefix: string;
  keyHash: string;
}

/**
 * Validate the SHAPE of a presented token and return what a lookup needs.
 *
 * Shape-checking first is not about security — the hash lookup would fail anyway — it is about not
 * issuing a database query for every malformed string that arrives in an Authorization header.
 * Returns undefined rather than throwing: a bad credential is a 401, not an exception.
 */
export function parseApiKey(value: string): ParsedApiKey | undefined {
  if (!isApiKeyToken(value)) return undefined;
  const rest = value.slice(API_KEY_PREFIX.length);
  const at = rest.indexOf("_");
  if (at !== PREFIX_LENGTH) return undefined;
  const prefix = rest.slice(0, at);
  const secret = rest.slice(at + 1);
  if (!new RegExp(`^[${BASE32}]{${PREFIX_LENGTH}}$`).test(prefix)) return undefined;
  if (!/^[A-Za-z0-9_-]{16,}$/.test(secret)) return undefined;
  return { prefix, keyHash: hashApiKey(value) };
}

/**
 * Constant-time hash comparison.
 *
 * The stored hash is found by an indexed equality lookup, so this is belt-and-braces for any code
 * path that compares two hashes it already holds. `timingSafeEqual` throws on a length mismatch,
 * which is itself a leak of one bit and a crash — so lengths are checked first and simply return
 * false.
 */
export function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
