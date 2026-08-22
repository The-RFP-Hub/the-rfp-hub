/**
 * PURE before/after diffs for the audit trail — no DB, no HTTP, unit-tested.
 *
 * An audit row records WHAT CHANGED, and that has two audiences with different rights:
 *
 *   - the public trail exposes field NAMES only (`changedFields`), because a pending or rejected
 *     entry's contents are not public and neither is a publisher's contact email;
 *   - the submitter, the publishing organization and T3+ see the full patch.
 *
 * Both come from the same computation, so the public view can never be a different, staler answer
 * than the private one. `changedFields(patch)` is literally the keys of the patch.
 *
 * Deliberately NOT RFC 6902. A JSON Patch is an instruction for reproducing a change; what an
 * audit reader wants is the pair — what it was, what it became — and reconstructing that from an
 * op list requires replaying the whole trail. The shape here is `{field: {before, after}}`.
 */

/** One field's change. `undefined` on either side means the field was absent then/now. */
export interface FieldChange {
  before: unknown;
  after: unknown;
}

export type Patch = Record<string, FieldChange>;

/**
 * Structural equality for the values that reach an audit patch: scalars, dates, arrays and the
 * Standard's JSONB sub-objects.
 *
 * Dates compare by instant — a `Date` read back from Postgres is never the same object as the one
 * written, and comparing by reference would mark every timestamp as changed on every write, which
 * is the fastest way to make an audit trail useless.
 *
 * Object comparison is key-order-insensitive: `{a:1,b:2}` and `{b:2,a:1}` are the same JSONB
 * value, and a driver is under no obligation to preserve insertion order.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : new Date(a as string).getTime();
    const bt = b instanceof Date ? b.getTime() : new Date(b as string).getTime();
    return Number.isFinite(at) && Number.isFinite(bt) && at === bt;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== "object" || typeof b !== "object") return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const key of keys) if (!deepEqual(ao[key], bo[key])) return false;
  return true;
}

/**
 * Fields that never belong in a patch: server-maintained timestamps that change on every write and
 * would bury the one field a reader is looking for.
 *
 * `created_at` is here too. It does not change, so a diff would never surface it — but a create
 * diffs against `{}`, where every column looks "added", and an audit reader is not served by being
 * told the row has a creation time.
 */
const IGNORED = new Set(["updatedAt", "updated_at", "createdAt", "created_at"]);

/**
 * The changed fields between two states, as `{field: {before, after}}`.
 *
 * A create passes `{}` as `before`, which yields every supplied field with `before: undefined` —
 * which is exactly right: on a create, everything is new.
 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  options: { ignore?: Iterable<string> } = {},
): Patch {
  const ignore = new Set([...IGNORED, ...(options.ignore ?? [])]);
  const patch: Patch = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (ignore.has(key)) continue;
    if (deepEqual(before[key], after[key])) continue;
    patch[key] = { before: before[key], after: after[key] };
  }
  return patch;
}

/** The public projection of a patch: field names, sorted so the trail reads the same every time. */
export function changedFields(patch: Patch): string[] {
  return Object.keys(patch).sort();
}

/** Whether a patch records any change at all — an update that changed nothing writes no audit row. */
export function isEmptyPatch(patch: Patch): boolean {
  return Object.keys(patch).length === 0;
}
