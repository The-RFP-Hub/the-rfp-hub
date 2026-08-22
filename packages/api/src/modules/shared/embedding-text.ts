/**
 * PURE composition of the text an opportunity is embedded as — no DB, no HTTP, unit-tested.
 *
 * Determinism is the whole requirement. `content_hash` decides whether a stored embedding is still
 * current, so the same record must produce the same string on every process, in every order, or
 * every backfill run re-embeds the entire table and pays for it.
 *
 * What goes in, and why only this: title and summary carry the identity of a programme; the
 * organizations, ecosystems and categories are what distinguish two programmes with similar names.
 * The description is used only when there is no summary, and truncated, because a long body is
 * mostly boilerplate — eligibility prose, application instructions — that is nearly identical
 * across unrelated programmes and would pull every pair's similarity up.
 *
 * NO LITERAL NUL BYTE IS EVER USED AS A DELIMITER, here or in the hash input. `check:neutral`
 * SKIPS a tracked file containing a NUL (loudly, but it skips it), and `git diff` treats such a
 * file as binary. A NUL delimiter would therefore make this file invisible to the repository's own
 * source-neutrality scan and unreviewable in a diff. The delimiter is a blank line.
 */
import { createHash } from "node:crypto";

/** How much of a description is used when there is no summary. */
export const DESCRIPTION_LIMIT = 2000;

/** The delimiter between parts. A blank line: textual, diffable, and visible to every scanner. */
const DELIMITER = "\n\n";

export interface EmbeddableOpportunity {
  title?: string | null;
  summary?: string | null;
  description?: string | null;
  fundingType?: string | null;
  ecosystems?: (string | null | undefined)[] | null;
  categories?: (string | null | undefined)[] | null;
  operatingOrganizations?: { name?: string | null }[] | null;
}

/**
 * All whitespace — including newlines and tabs — collapsed to single spaces, ends trimmed.
 *
 * Without this the same record embeds differently depending on whether its description arrived
 * with CRLF or LF line endings, which is a property of whoever pasted it rather than of the
 * programme it describes.
 */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Truncate on a word boundary where one is near, so a cut never lands mid-token. */
function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > limit * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/** A list part: non-empty entries, collapsed, joined. Order is preserved, not sorted — see below. */
function listPart(values: (string | null | undefined)[] | null | undefined): string {
  if (!Array.isArray(values)) return "";
  return values
    .map((v) => collapseWhitespace(String(v ?? "")))
    .filter((v) => v !== "")
    .join(", ");
}

/**
 * The text to embed.
 *
 * Array order is PRESERVED rather than sorted. `operatingOrganizations` has semantic order in the
 * Standard ([0] is the primary/display organization) and reordering it would change what the
 * record says; `ecosystems` and `categories` are treated the same way for consistency, and because
 * a stored array's order is stable — it is written once from the submitted document and served
 * back verbatim, so it is as deterministic as a sort would be.
 */
export function embeddingText(record: EmbeddableOpportunity): string {
  const title = collapseWhitespace(record.title ?? "");
  const body = record.summary?.trim()
    ? collapseWhitespace(record.summary)
    : truncate(collapseWhitespace(record.description ?? ""), DESCRIPTION_LIMIT);
  const orgs = listPart(record.operatingOrganizations?.map((o) => o?.name));

  return [
    title,
    body,
    orgs,
    listPart(record.ecosystems),
    listPart(record.categories),
    collapseWhitespace(record.fundingType ?? ""),
  ]
    .filter((part) => part !== "")
    .join(DELIMITER);
}

/**
 * The identity of a stored embedding: the text AND what produced it.
 *
 * The model and provider are part of the hash because vectors from two different models are not
 * comparable. Hashing the text alone would leave a row that survives a provider switch looking
 * current while its vector belongs to a space nothing else in the table is in — silently, and with
 * no way to detect it afterwards.
 */
export function contentHash(text: string, model: string, providerId: string): string {
  return createHash("sha256").update(`${text}\n${model}\n${providerId}`, "utf8").digest("hex");
}
