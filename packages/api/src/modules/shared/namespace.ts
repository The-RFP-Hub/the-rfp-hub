/**
 * PURE namespace rules for the write path — no DB, no HTTP, unit-tested.
 *
 * A submitted entry's namespace is the thing authorization is decided against: publishing into a
 * namespace you hold a membership on is what auto-approval means. It therefore has to be derived
 * one way, from the document, by one function that everything calls — not re-derived at each call
 * site, where the two derivations eventually disagree and the disagreement is a privilege bug.
 *
 * Two rules, and they must agree:
 *
 * 1. The namespace is `source.publisher`, falling back to the primary operating organization's
 *    slug. The Standard's own words for `source.publisher` are "namespace — an organisation slug —
 *    this entry was published under", so this is reading the field for what it says it is.
 * 2. The public id is `<namespace>:<local>`. `scripts/seed.ts` already derives `source_system` by
 *    splitting the id on its first colon, and `ux_opp_source` is keyed on
 *    `(source_system, original_id)` — so an id whose prefix does not match the namespace it was
 *    authorized under would file the row under a system it does not belong to.
 *
 * Rule 2 is enforced on write rather than inferred: rejecting a mismatch with a message naming the
 * required form is the only version of this that a submitter can act on.
 */

/** The character separating a namespace from the local part of a public id. */
const SEPARATOR = ":";

/**
 * A namespace is an organization slug, so it is held to slug shape: lowercase alphanumerics and
 * single hyphens, 2–64 characters. Deliberately narrower than "anything without a colon" —
 * whitespace, uppercase and punctuation in a namespace produce ids that differ only by
 * normalization, which is how two entries end up looking like one.
 */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isNamespaceSlug(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && SLUG.test(value);
}

export interface NamespaceSource {
  source?: { publisher?: string | null } | null;
  operatingOrganizations?: { slug?: string | null }[] | null;
}

/**
 * The namespace a document is published under: `source.publisher`, else the primary operating
 * organization's slug. `undefined` when the document names neither — the caller decides whether
 * that is a 400 (a submission) or simply an unattributed record (an import).
 */
export function resolveNamespace(record: NamespaceSource): string | undefined {
  const publisher = record.source?.publisher?.trim();
  if (publisher) return publisher;
  const operating = record.operatingOrganizations?.[0]?.slug?.trim();
  return operating || undefined;
}

export interface ParsedPublicId {
  namespace: string;
  local: string;
}

/**
 * Split `<namespace>:<local>`. The FIRST colon separates: a local part may contain colons (a URN,
 * a compound key), and splitting on the last would silently reassign the namespace of any id that
 * does.
 */
export function parsePublicId(id: string): ParsedPublicId | undefined {
  const at = id.indexOf(SEPARATOR);
  if (at <= 0 || at === id.length - 1) return undefined;
  return { namespace: id.slice(0, at), local: id.slice(at + 1) };
}

/** The namespace half of an id, or undefined — the same derivation `source_system` uses. */
export function namespaceOfPublicId(id: string): string | undefined {
  return parsePublicId(id)?.namespace;
}

/**
 * Whether a submitted id is usable for the namespace it was authorized under.
 *
 * Returns a message rather than a boolean because every rejection here is a 400 a human has to
 * act on, and "invalid id" without the required form is not actionable.
 */
export function checkPublicId(id: unknown, namespace: string): string | undefined {
  if (typeof id !== "string" || id.trim() === "") {
    return "`id` is required and must be a string of the form `<namespace>:<local>`.";
  }
  const parsed = parsePublicId(id.trim());
  if (!parsed) {
    return `\`id\` must be of the form \`<namespace>:<local>\` (e.g. \`${namespace}:spring-round\`), got ${JSON.stringify(id)}.`;
  }
  if (parsed.namespace !== namespace) {
    return `\`id\` must start with the namespace this entry is published under: expected \`${namespace}:…\`, got \`${parsed.namespace}:…\`.`;
  }
  return undefined;
}
