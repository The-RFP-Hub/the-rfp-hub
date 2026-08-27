/**
 * Recursive redaction of API-key-shaped strings, applied to EVERY outbound surface.
 *
 * This is a backstop, not the control. The control is that the key is only ever read from the
 * environment and only ever attached to one request header; redaction exists because an error
 * body, a stack frame or a document a caller pasted can carry a key that nothing intended to put
 * there, and because "we never log the key" is a claim that only holds until the first unexpected
 * `JSON.stringify(err)`.
 *
 * The scan is by SHAPE (`rfph_` + at least four key characters), plus any literal secret the
 * process registers — the configured key is registered at boot, so even a credential in a format
 * this pattern would miss is scrubbed.
 */

/**
 * The credential shape. `g` is deliberately absent here: a `g`-flagged RegExp carries mutable
 * `lastIndex` state across calls, which makes `.test()` alternate true/false on the same input.
 * Every use below builds its own flagged copy.
 */
const KEY_SHAPE_SOURCE = "rfph_[A-Za-z0-9_-]{4,}";

/** Matches an API-key-shaped substring. A fresh instance per call — see above. */
export function keyShapeRegExp(): RegExp {
  return new RegExp(KEY_SHAPE_SOURCE, "g");
}

export const REDACTED = "[REDACTED-RFPHUB-KEY]";

const literalSecrets = new Set<string>();

/**
 * Register an exact secret so it is scrubbed even if it does not match the shape.
 *
 * Short strings are refused: registering, say, `"a"` would turn every output into redaction
 * markers, which is worse than the leak it guards.
 */
export function registerSecret(secret: string | null | undefined): void {
  if (typeof secret !== "string") return;
  const trimmed = secret.trim();
  if (trimmed.length < 8) return;
  literalSecrets.add(trimmed);
}

/** Test-only: forget every registered literal. The shape pattern is unaffected. */
export function clearRegisteredSecrets(): void {
  literalSecrets.clear();
}

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactString(input: string): string {
  let out = input.replace(keyShapeRegExp(), REDACTED);
  for (const secret of literalSecrets) {
    if (out.includes(secret)) {
      out = out.replace(new RegExp(escapeForRegExp(secret), "g"), REDACTED);
    }
  }
  return out;
}

/** Whether a string carries anything the redactor would scrub. */
export function stringHasSecret(input: string): boolean {
  if (keyShapeRegExp().test(input)) return true;
  for (const secret of literalSecrets) if (input.includes(secret)) return true;
  return false;
}

/**
 * Recursively rebuild `value` with every string redacted.
 *
 * Objects and arrays are rebuilt rather than mutated, so a caller's input is never altered under
 * it. Object KEYS are redacted too — a document could carry a key as a property name. Cycles are
 * broken with a marker rather than by throwing: a redactor that can crash on odd input is a
 * redactor that gets skipped on the error path, which is exactly the path that leaks.
 */
export function redact<T>(value: T): T {
  return redactValue(value, new WeakSet<object>()) as T;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (value instanceof Error) {
    const clone = new Error(redactString(value.message));
    clone.name = value.name;
    if (typeof value.stack === "string") clone.stack = redactString(value.stack);
    return clone;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[redactString(key)] = redactValue(item, seen);
  }
  return out;
}

/**
 * Whether anything ANYWHERE in `value` is key-shaped — strings, array members, object keys and
 * values, at any depth.
 *
 * Used by the write tool's first phase. Output redaction cannot help there: the API accepts free
 * text, so a key inside `description` would be PERSISTED and only then redacted out of the reply.
 * The document has to be refused before the request is built.
 */
export function findSecretPaths(value: unknown): string[] {
  const hits: string[] = [];
  walk(value, "", hits, new WeakSet<object>());
  return hits;
}

function walk(value: unknown, path: string, hits: string[], seen: WeakSet<object>): void {
  if (typeof value === "string") {
    if (stringHasSecret(value)) hits.push(path || "(root)");
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, hits, seen));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (stringHasSecret(key)) hits.push(`${path}/${key} (property name)`);
    walk(item, `${path}/${key}`, hits, seen);
  }
}
