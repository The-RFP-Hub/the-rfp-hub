/**
 * PURE comparison of a submitted entry against the page at its `applicationUrl` — no I/O.
 *
 * WHAT THIS IS: an explicit, field-by-field statement of what the page does and does not appear to
 * corroborate, for a human reviewer to read. Every check is a presence test with a named result.
 *
 * WHAT THIS IS NOT: a fact-check, and not a language model. Determinism is the reason — the same
 * page and record must produce the same diff on every run, so a reviewer comparing two runs is
 * looking at a change in the page rather than a change in a sampler. It also costs nothing per
 * submission and can be tested exhaustively against fixtures, neither of which is true of a prose
 * verdict. A reviewer is better served by "the deadline 2026-03-01 does not appear on the page, in
 * any of three formats" than by a paragraph asserting the same thing without saying how it knows.
 *
 * The whole output feeds `verification_runs.field_diff`, and only the title check feeds `matched`.
 */

/**
 * English function words, and nothing else.
 *
 * The tempting longer list — dropping "grant", "programme", "round", "funding" as too common —
 * is wrong HERE, and the tests caught it. This similarity compares one record's title against the
 * title of the page that record points at, so the domain words are most of the shared evidence
 * that the two are the same programme: strip them and "Ecosystem Grants Round 5" versus
 * "Ecosystem Grants Round 5 | Example Foundation" collapses to a single shared token and scores
 * below the threshold. A domain stop list would belong to a search ranker comparing DIFFERENT
 * records, which is not what this is.
 */
const STOP = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "for",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
]);

/** Lowercased alphanumeric tokens, stop words removed, deduplicated. */
export function tokenize(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !STOP.has(t));
  return new Set(tokens);
}

/**
 * Jaccard similarity of two token sets: |intersection| / |union|.
 *
 * Chosen over an edit distance because a page title is the record's title plus the site's
 * furniture — "Ecosystem Grants Round 5 | Example Foundation". Character distance reads that as
 * very different; set overlap reads it as the same programme with extra words, which is what it
 * is. Two empty sets are 0, not 1: no evidence is not agreement.
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Above this, the page's title and the record's title are taken to be the same programme. */
export const TITLE_MATCH_THRESHOLD = 0.4;

/**
 * The written forms of one calendar date.
 *
 * A deadline is published as `2026-03-01`, `March 1, 2026` or `1 March 2026` depending on the
 * site, so testing one form would report almost every real page as missing its own deadline.
 * Day-first and month-first are both generated, without abbreviating months to three letters
 * (which `includes` already covers, since "March".startsWith("Mar")).
 */
export function dateForms(iso: string): string[] {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return [];
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const d = at.getUTCDate();
  const month = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ][m];
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    `${y}-${pad(m + 1)}-${pad(d)}`,
    `${pad(m + 1)}/${pad(d)}/${y}`,
    `${pad(d)}/${pad(m + 1)}/${y}`,
    `${month} ${d}, ${y}`,
    `${month} ${d} ${y}`,
    `${d} ${month} ${y}`,
  ];
}

/**
 * The written forms of an amount: bare digits and grouped by thousands.
 *
 * `50000` and `50,000` are the same award, and a page writes whichever its designer preferred.
 * Decimals are dropped — a page saying "$50,000" should corroborate a stored `50000.00`.
 */
export function amountForms(value: number): string[] {
  if (!Number.isFinite(value)) return [];
  const whole = Math.trunc(Math.abs(value));
  const bare = String(whole);
  const grouped = bare.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return grouped === bare ? [bare] : [bare, grouped];
}

/** One presence test: what was looked for, whether it was found, and in which written form. */
export interface PresenceCheck {
  value: string;
  found: boolean;
  /** The form that matched, when one did — so a reviewer can see what the page actually says. */
  matchedAs?: string;
}

function presence(haystack: string, value: string, forms: string[]): PresenceCheck {
  const matchedAs = forms.find((form) => haystack.includes(form.toLowerCase()));
  return matchedAs ? { value, found: true, matchedAs } : { value, found: false };
}

export interface DiffInput {
  title?: string | null;
  deadlines?: { deadlineType?: string | null; date?: string | null }[] | null;
  minAward?: number | null;
  maxAward?: number | null;
  budget?: number | null;
  operatingOrganizations?: { name?: string | null }[] | null;
}

export interface DiffPage {
  title?: string;
  ogTitle?: string;
  text: string;
}

export interface FieldDiff {
  title: {
    submitted: string;
    page?: string;
    similarity: number;
    matched: boolean;
  };
  /** Set when the final URL left the requested URL's registrable host. */
  offDomainRedirect?: { from: string; to: string };
  /** One entry per FIXED deadline that carries a date. Rolling entries have nothing to look for. */
  deadlines: PresenceCheck[];
  /** Award figures the record states, each looked for in both written forms. */
  amounts: PresenceCheck[];
  /** The primary operating organization's name. */
  organization?: PresenceCheck;
}

/**
 * Whether the final URL left the host that was requested.
 *
 * A flag, never a rejection: a foundation legitimately redirects to its grants platform, and a
 * dead programme legitimately redirects to a homepage. Only a reviewer can tell those apart, so
 * this records the fact and says nothing about what it means. Compared on the last two labels so
 * `grants.example.org` → `www.example.org` is not reported as leaving the site.
 */
export function offDomainRedirect(
  requestedUrl: string,
  finalUrl: string,
): { from: string; to: string } | undefined {
  const site = (raw: string): string | undefined => {
    try {
      return new URL(raw).hostname.toLowerCase().split(".").slice(-2).join(".");
    } catch {
      return undefined;
    }
  };
  const from = site(requestedUrl);
  const to = site(finalUrl);
  if (!from || !to || from === to) return undefined;
  return { from, to };
}

/** The full diff. Everything is lowercased once; every check is a substring test over that. */
export function fieldDiff(
  record: DiffInput,
  page: DiffPage,
  urls: { requested: string; final: string },
): FieldDiff {
  const haystack = `${page.title ?? ""} ${page.ogTitle ?? ""} ${page.text}`.toLowerCase();
  const submittedTitle = record.title ?? "";
  const pageTitle = page.ogTitle ?? page.title;
  const similarity = pageTitle ? jaccard(tokenize(submittedTitle), tokenize(pageTitle)) : 0;

  const deadlines = (record.deadlines ?? [])
    .filter((d) => d?.deadlineType === "fixed" && typeof d?.date === "string" && d.date !== "")
    .map((d) => presence(haystack, d.date as string, dateForms(d.date as string)));

  const amounts = (
    [
      ["minAward", record.minAward],
      ["maxAward", record.maxAward],
      ["budget", record.budget],
    ] as const
  )
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0)
    .map(([label, value]) => {
      const check = presence(haystack, String(value), amountForms(value as number));
      return { ...check, value: `${label}=${value}` };
    });

  const orgName = record.operatingOrganizations?.[0]?.name?.trim();

  return {
    title: {
      submitted: submittedTitle,
      page: pageTitle,
      similarity: Math.round(similarity * 1000) / 1000,
      matched: similarity >= TITLE_MATCH_THRESHOLD,
    },
    offDomainRedirect: offDomainRedirect(urls.requested, urls.final),
    deadlines,
    amounts,
    organization: orgName ? presence(haystack, orgName, [orgName]) : undefined,
  };
}

/**
 * The single boolean that reaches `opportunities.verified_against_source`.
 *
 * Deliberately a LOW BAR: the page exists and its title is about the same programme. It is an
 * anti-spam signal — it catches an `applicationUrl` pointing at nothing, or at something unrelated
 * — and it is not a claim that the amounts, dates or eligibility are correct. An admin still
 * approves, and docs/data-model.md says the same thing in the same words.
 */
export function isMatched(existsAtSource: boolean, diff: FieldDiff): boolean {
  return existsAtSource && diff.title.matched;
}
