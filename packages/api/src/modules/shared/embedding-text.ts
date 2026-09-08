/**
 * PURE composition of the text an opportunity is embedded as — no DB, no HTTP, unit-tested.
 *
 * Determinism is the whole requirement. `content_hash` decides whether a stored embedding is still
 * current, so the same record must produce the same string on every process, in every order, or
 * every backfill run re-embeds the entire table and pays for it.
 *
 * What goes in: title, summary AND a truncated description, then the organizations, ecosystems
 * and categories that distinguish two programmes with similar names. Summary and description are
 * BOTH always in, on every record. The previous rule — summary when present, description only as
 * a fallback — compared two records on different text whenever exactly one of them carried a
 * summary, and a verbatim copy of a live listing submitted without its summary scored 0.31
 * against it. The boilerplate a long body carries does narrow the band between true duplicates
 * and the hardest unrelated pairs (measured in `scripts/dedupe-threshold-report.ts`), which is
 * why the description is truncated and why the operating point was re-settled with this change.
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
  const summary = collapseWhitespace(record.summary ?? "");
  const description = truncate(collapseWhitespace(record.description ?? ""), DESCRIPTION_LIMIT);
  const orgs = listPart(record.operatingOrganizations?.map((o) => o?.name));

  return [
    title,
    summary,
    description,
    orgs,
    listPart(record.ecosystems),
    listPart(record.categories),
    collapseWhitespace(record.fundingType ?? ""),
  ]
    .filter((part) => part !== "")
    .join(DELIMITER);
}

/** Below this many normalised characters a description is too short to call a copy on its own. */
export const DESCRIPTION_HASH_MIN_CHARS = 200;

/**
 * The exact-copy key: sha256 over the WHOLE description, Unicode-normalised, lowercased and
 * whitespace-collapsed. Independent of the embedding — a copied body is a copy whatever title,
 * summary or taxonomy was put around it, and the vector's 2 000-character truncation must not
 * decide it. `null` for a body under `DESCRIPTION_HASH_MIN_CHARS`: two short template sentences
 * are not evidence of the same programme.
 */
export function descriptionHash(description: string | null | undefined): string | null {
  const normalized = collapseWhitespace((description ?? "").normalize("NFKC")).toLowerCase();
  if (normalized.length < DESCRIPTION_HASH_MIN_CHARS) return null;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
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
