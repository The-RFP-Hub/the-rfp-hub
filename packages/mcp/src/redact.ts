/**
 * Recursive redaction of key-shaped strings on every outbound surface. A BACKSTOP, NOT THE
 * CONTROL: it exists because an error body or a pasted document can carry a key nothing meant to
 * put there.
 */
/** No `g` flag: its mutable `lastIndex` makes `.test()` alternate on the same input. */
const KEY_SHAPE_SOURCE = "rfph_[A-Za-z0-9_-]{4,}";

/** A fresh instance per call — see above. */
export function keyShapeRegExp(): RegExp {
  return new RegExp(KEY_SHAPE_SOURCE, "g");
}

export const REDACTED = "[REDACTED-RFPHUB-KEY]";

const literalSecrets = new Set<string>();

/** Short strings are refused: registering `"a"` would turn every output into markers. */
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
 * Rebuilt, not mutated. KEYS are redacted too. Cycles are marked rather than thrown on: a redactor
 * that can crash gets skipped on the error path, which is the path that leaks.
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
 * Anything key-shaped at any depth, for the write tool's first phase. Output redaction cannot help
 * there: a key inside `description` would be PERSISTED and only then redacted out of the reply.
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
