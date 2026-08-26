/**
 * The CONTENT projection of an opportunity row — pure, no DB, no HTTP.
 *
 * "Did this write actually say anything different?" is asked by more than one write path, and both
 * of them must answer it the same way or the audit trail contradicts itself: the submission path
 * uses it to decide whether an approved entry returns to the review queue, and the import path uses
 * it to decide whether a re-run of an unchanged corpus appends a history row at all. Two private
 * copies of the rule would drift, and the drift would show up as an entry that is "unchanged" to
 * one path and "changed" to the other.
 *
 * What is excluded is SERVER-OWNED BOOKKEEPING: identity, timestamps, editorial state, ownership,
 * verification results and derived columns. None of it is what the document says, and all of it
 * moves on writes that changed nothing a reader would call a change — `next_deadline_at` is
 * recomputed from `now()` on every upsert, `last_seen_at` is stamped on every assertion, and
 * `review_status` is decided by a path of its own that appends its own audit row. Comparing on any
 * of them would make a nightly re-import look like a nightly edit of the whole corpus.
 */

/** Columns that are the server's own bookkeeping rather than the document's content. */
export const NON_CONTENT: ReadonlySet<string> = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "reviewStatus",
  "isListed",
  "submittedBy",
  "approvedBy",
  "approvedAt",
  "lastSeenAt",
  "mergedIntoId",
  "mergedFromPublic",
  "sourceSubmittedAt",
  "verifiedAgainstSource",
  "verifiedAt",
  "snapshotUrl",
  "nextDeadlineAt",
  "sourceSystem",
]);

/**
 * The comparable projection of a row or an insert: content only.
 *
 * `undefined` is normalized to `null` because the two sides being compared are not the same shape —
 * an insert object omits a column it does not set, a row read back from Postgres carries it as
 * `null` — and an absent column is not an edit.
 */
export function comparableOpportunity(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (NON_CONTENT.has(key)) continue;
    out[key] = value === undefined ? null : value;
  }
  return out;
}
