/**
 * Canonical JSON and SHA-256, the two primitives the write approval is built on.
 *
 * A digest over `JSON.stringify(document)` would be a digest over KEY ORDER: the same document
 * round-tripped through a different client would hash differently, and every approval would look
 * tampered with. Canonicalization sorts object keys at every depth and preserves array order,
 * which is the actual semantics of a JSON document.
 */
import { createHash } from "node:crypto";

/** Sorted-key, whitespace-free JSON. Arrays keep their order — it is meaningful in the standard. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, new WeakSet<object>()));
}

function canonicalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("cannot canonicalize a cyclic value");
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined) continue;
    out[key] = canonicalize(item, seen);
  }
  seen.delete(value);
  return out;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** SHA-256 over the canonical form of a value. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}
