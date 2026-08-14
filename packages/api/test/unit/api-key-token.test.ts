/**
 * THE API-KEY TOKEN FORMAT.
 *
 * What has to hold: the marker discriminates a key from a session token (which is how the
 * session-only routes stay session-only), the secret never appears in what is stored, and a
 * malformed bearer value is rejected on shape before it costs a database round trip.
 */
import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  hashApiKey,
  hashesEqual,
  isApiKeyToken,
  mintApiKey,
  parseApiKey,
} from "../../src/modules/shared/api-key-token.js";

describe("mintApiKey", () => {
  it("produces rfph_<8-char prefix>_<secret>", () => {
    const { token, prefix } = mintApiKey();
    expect(token.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(prefix).toHaveLength(8);
    expect(token).toMatch(/^rfph_[a-z0-9]{8}_[A-Za-z0-9_-]{40,}$/);
  });

  it("never repeats", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => mintApiKey().token));
    expect(tokens.size).toBe(200);
  });

  // The stored row must be useless to whoever obtains it. `key_hash` is a digest and the prefix is
  // deliberately public; neither reconstructs the secret.
  it("stores only a digest — the secret is not recoverable from what is kept", () => {
    const { token, prefix, keyHash } = mintApiKey();
    const secret = token.slice(`${API_KEY_PREFIX}${prefix}_`.length);
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keyHash).not.toContain(secret);
    expect(keyHash).toBe(hashApiKey(token));
  });
});

describe("isApiKeyToken", () => {
  // This is what stops a caller presenting an API key on a session-only route and having it
  // treated as a session — the discrimination is on the token, not on the caller's word.
  it("recognises a key and nothing else", () => {
    expect(isApiKeyToken(mintApiKey().token)).toBe(true);
    for (const value of ["eyJhbGciOiJFUzI1NiJ9.e30.sig", "", "Bearer rfph_x", "rfph"]) {
      expect(isApiKeyToken(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("parseApiKey", () => {
  it("returns the prefix and the lookup hash for a well-formed token", () => {
    const minted = mintApiKey();
    expect(parseApiKey(minted.token)).toEqual({ prefix: minted.prefix, keyHash: minted.keyHash });
  });

  // Shape-checking first is about not issuing a query for every piece of junk that arrives in an
  // Authorization header — the hash lookup would fail anyway.
  it("rejects malformed values without a lookup", () => {
    for (const value of [
      "",
      "rfph_",
      "rfph_short_abcdefghijklmnopqrstuvwxyz012345",
      "rfph_toolongprefix_abcdefghijklmnopqrstuvwxyz012345",
      "rfph_ABCDEFGH_abcdefghijklmnopqrstuvwxyz012345", // uppercase prefix
      "rfph_abcdefgh_tooshort",
      "rfph_abcdefgh_has spaces in the secret part!!",
      "not-a-key-at-all",
    ]) {
      expect(parseApiKey(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});

describe("hashesEqual", () => {
  it("compares equal and unequal digests", () => {
    const a = hashApiKey("one");
    expect(hashesEqual(a, hashApiKey("one"))).toBe(true);
    expect(hashesEqual(a, hashApiKey("two"))).toBe(false);
  });

  // `timingSafeEqual` throws on a length mismatch, which is both a crash and a one-bit leak.
  it("returns false for a length mismatch rather than throwing", () => {
    expect(hashesEqual("abc", hashApiKey("abc"))).toBe(false);
    expect(hashesEqual("", "")).toBe(true);
  });
});
