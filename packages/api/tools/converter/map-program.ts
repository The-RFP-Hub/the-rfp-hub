/**
 * OFFLINE TOOL — not on the seed path, not on any request path. See tools/converter/README.md.
 *
 * PURE mapper: an upstream funding-map registry program → RFP Hub Standard `Opportunity`.
 * No network/DB — fully unit-testable. `convert.ts` validates each result with `rfphub-validate`
 * and reports the ones that don't conform, so this aims for best-effort fidelity; its output is a
 * DRAFT for a curator to review, never something loaded straight into a database.
 *
 * Field rules were derived from the committed examples in
 * packages/standard/schemas/v1.0.0/examples. The provenance namespace (id prefix + source_system)
 * is the `SOURCE_SYSTEM` constant below — a data contract, not a caller's knob.
 *
 * ── Old-upstream → re-cut Standard ─────────────────────────────────────────────────
 * The upstream registry still speaks the pre-re-cut vocabulary, so THIS FILE is where the
 * conversion lives (the same rules the Standard's own examples were regenerated with):
 *
 *   type                       → fundingType
 *   metadata.organizations[]   → operatingOrganizations[]     (rfp.issuingOrganization wins the name;
 *                                                              then the listing community, then — last
 *                                                              resort — the program title)
 *   deadline / metadata.endsAt → deadlines[{deadlineType:'fixed', date, label:'application'}]
 *   hackathon.registrationDeadline / submissionDeadline / startDate / endDate
 *                              → deadlines[… label 'registration' | 'submission' | 'event start' | 'event end']
 *   accelerator.applicationDeadline, rfp.proposalDeadline
 *                              → deadlines[… label 'application']
 *   funding.totalBudget        → fundingInfo.budget  (rfp.budget folds into the same envelope)
 *   metadata.socialLinks (map) → socialLinks[{platform, url}]
 *   grant.fundingMechanism     → fundingDetails.fundingMechanisms[]
 *   per-item {amount, currency} money (bounty.reward, prizes[], accelerator.funding, checkSize)
 *                              → plain numbers; an upstream per-item currency hoists into the
 *                                document-wide fundingInfo.currency (see THE CURRENCY RULE below)
 *   <type>Metadata blob        → fundingDetails { fundingType: <type>, …whitelisted keys }
 *   source.url                 → removed; a program's OWN submission/website URL feeds
 *                                `applicationUrl`, and nothing is substituted when it publishes none
 *   every timestamp            → RFC 3339 **UTC** (trailing 'Z') — see `isoDate`
 *   bounty (no upstream kind)  → fundingDetails.bountyKind, inferred from DOMAIN signals, and the
 *                                compensation shape that kind requires — see `typeBlockOf`
 *
 * ── Fields the upstream carries that the Standard has a home for ───────────────────
 *   metadata.amountDistributedToDate → fundingInfo.allocated   (only when positive)
 *   metadata.anyoneCanJoin           → eligibility (free text — the re-cut made it one string)
 *   socialLinks.grantsSite / metadata.bugBounty → additionalReferences (when not applicationUrl)
 *   socialLinks.orgWebsite           → operatingOrganizations[0].website
 *   createdAt                        → postedAt (first listed at the source)
 *   hackathon/accelerator location "Online" → the block's `online` flag
 *
 * ── Fields the upstream carries that the CLOSED CORE has no home for (dropped) ──────
 * The re-cut closed the core: `additionalProperties:false` at the top level and no `extensions`
 * escape hatch, so data with no field is data that cannot be published. Each of these was carried
 * before and is now an accepted, recorded loss rather than a silent one:
 *   metadata.networks        — `networks` was removed (ecosystems is the surviving axis)
 *   metadata.grantTypes      — `tags` was removed (categories is the surviving axis)
 *   metadata.grantsToDate    — award COUNT to date; no field, and not derivable from `allocated`
 *   chainID                  — payout chain; no field, and not an ecosystem name
 *
 * ── THE CURRENCY RULE (one currency per document) ──────────────────────────────────
 * The re-cut denominates EVERY monetary amount in the document in the single
 * `fundingInfo.currency`: budget, allocated, minAward/maxAward, prizes[].amount, bounty.reward,
 * accelerator.funding and vcFund.checkSize. No sub-block carries a currency of its own, so an
 * upstream record that names more than one cannot be published as-is. The rule, applied in
 * `mapProgram` and asserted by tests, is deliberate and in this order:
 *
 *   1. a DOCUMENT-level currency wins — `metadata.programBudget`'s suffix ("2000000 USDC"),
 *      then `rfp.budget.currency`. It denominates the program's own envelope, so it is the
 *      publisher's statement about the program rather than about one line item.
 *   2. otherwise the first PER-ITEM currency seen is hoisted into `fundingInfo.currency`
 *      (prizes → reward/funding → checkSize), so a bounty that only ever names "OP" is still
 *      denominated instead of publishing a bare number.
 *   3. on DISAGREEMENT the document-level currency wins and every amount is KEPT. Dropping the
 *      amounts would lose real figures over a label, and re-denominating them would require an
 *      exchange rate the Hub does not have and must not invent. This is normalization at ingest,
 *      stated here rather than performed silently.
 *
 * Still unmapped because the upstream publishes nothing for them: sponsoringOrganizations (the
 * upstream names no backer distinct from the operator — see `organizationNamesOf`), prerequisites,
 * serviceAgreement, milestones, and the three JSON-LD self-identification keys.
 */
import {
  type Deadline,
  type FundingType,
  type Opportunity,
  type OpportunityStatus,
  SPEC_VERSION,
  type SocialLink,
} from "@the-rfp-hub/standard";

/**
 * The provenance namespace for everything this mapper produces. ONE definition, in code, on
 * purpose — it is a data contract, not a deployment knob, and it was an environment variable
 * until this commit:
 *
 *   - it forms every public id (`<system>:<id>`), so a missing or mistyped value silently
 *     rewrites every id in the dataset and breaks every link a consumer has stored;
 *   - it fills the `source_system` column, which carries a uniqueness constraint together with
 *     `original_id`. Change it and idempotency goes with it: the next run no longer matches the
 *     rows it wrote last time and inserts duplicates instead of updating them.
 *
 * Neither failure is loud. An env var that can be forgotten or fat-fingered in one deployment is
 * the wrong shape for a value with those consequences, so it is a constant that ships with the
 * code that depends on it. In M3 a publisher's namespace becomes a property of the publisher
 * record — per-source data, keyed by the row it describes — rather than one global for the
 * process; this constant is the single-source stand-in until then.
 */
export const SOURCE_SYSTEM = "fundingmap";

export interface RegistryCommunity {
  uid?: string;
  name?: string;
  slug?: string;
  imageUrl?: string;
}

export interface RegistryProgram {
  id?: string;
  programId?: string | number;
  type?: string;
  name?: string;
  isActive?: boolean;
  deadline?: string | null;
  submissionUrl?: string | null;
  communities?: RegistryCommunity[];
  createdAt?: string | null;
  updatedAt?: string | null;
  metadata?: Record<string, unknown> & {
    title?: string;
    description?: string;
    shortDescription?: string;
    status?: string;
    startsAt?: string | null;
    endsAt?: string | null;
    categories?: string[];
    ecosystems?: string[];
    /** The real organisations behind the program — the ones that run it, in upstream order. */
    organizations?: string[];
    minGrantSize?: number | string | null;
    maxGrantSize?: number | string | null;
    programBudget?: number | string | null;
    /** Committed to date. Upstream defaults it to "0", so only a positive value means anything. */
    amountDistributedToDate?: number | string | null;
    /** Whether anyone may apply, or the program invites/pre-selects. The one eligibility signal. */
    anyoneCanJoin?: boolean;
    /** Bug-bounty page, when the program runs one. Folded into `additionalReferences`. */
    bugBounty?: string;
    website?: string;
    logoImg?: string;
    bannerImg?: string;
    socialLinks?: Record<string, string>;
  };
  grantMetadata?: Record<string, unknown> | null;
  hackathonMetadata?: Record<string, unknown> | null;
  bountyMetadata?: Record<string, unknown> | null;
  acceleratorMetadata?: Record<string, unknown> | null;
  vcFundMetadata?: Record<string, unknown> | null;
  rfpMetadata?: Record<string, unknown> | null;
}

const FUNDING_TYPES: FundingType[] = [
  "grant",
  "hackathon",
  "bounty",
  "accelerator",
  "vc_fund",
  "rfp",
];
const STATUSES: OpportunityStatus[] = ["upcoming", "open", "closed", "archived"];

/**
 * Standard-allowed keys per type block (additionalProperties:false ⇒ whitelist before emit).
 * Every date key is absent by design — the re-cut moved them all into the shared `deadlines[]`.
 */
const TYPE_BLOCK_KEYS: Record<FundingType, string[]> = {
  grant: ["fundingMechanisms", "programModel", "milestoneBased", "recurring"],
  hackathon: ["location", "online", "tracks", "prizes", "teamSize"],
  bounty: [
    "bountyKind",
    "reward",
    "rewardTiers",
    "severityScheme",
    "rewardPoolStatus",
    "difficulty",
    "skills",
    "platform",
  ],
  accelerator: [
    "programDurationWeeks",
    "batchSize",
    "equity",
    "funding",
    "stage",
    "location",
    "online",
  ],
  vc_fund: ["checkSize", "stages", "thesis", "portfolio", "contactMethod", "activelyInvesting"],
  rfp: ["scope", "requirements"],
};

/**
 * Per-type block date fields that fold into `deadlines[]`, and the conventional label each takes
 * (registries/deadline-labels.json). Consumers select by label, never by array position.
 */
const BLOCK_DEADLINE_LABELS: Partial<Record<FundingType, Record<string, string>>> = {
  hackathon: {
    registrationDeadline: "registration",
    submissionDeadline: "submission",
    startDate: "event start",
    endDate: "event end",
  },
  accelerator: { applicationDeadline: "application" },
  rfp: { proposalDeadline: "application" },
};

/**
 * Platforms that host security bug bounty programs and nothing else — a listing here IS a
 * vulnerability-disclosure program regardless of how its name was ingested. Task-bounty boards
 * (Gitcoin, Layer3, Superteam Earn) are deliberately absent: their listings stay tasks.
 */
const SECURITY_BOUNTY_PLATFORMS = new Set([
  "immunefi",
  "cantina",
  "hackenproof",
  "sherlock",
  "code4rena",
  "hats finance",
]);

const SOCIAL_KEYS: SocialLink["platform"][] = [
  "twitter",
  "discord",
  "github",
  "telegram",
  "farcaster",
  "forum",
  "blog",
];

const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;

/** Dedupe + drop empty items from an open string list (Standard requires uniqueItems + minLength 1). */
function cleanArr(a: unknown): string[] {
  if (!Array.isArray(a)) return [];
  return [...new Set(a.filter(nonEmpty))];
}

/** Parse "2000000", "2026 USD", "110 USDC" → { amount, currency? }. */
function parseAmount(v: unknown): { amount?: number; currency?: string } {
  if (typeof v === "number") return Number.isFinite(v) ? { amount: v } : {};
  if (!nonEmpty(v)) return {};
  const m = v.trim().match(/^([0-9][0-9,.]*)\s*([A-Za-z]{2,10})?$/);
  if (!m?.[1]) return {};
  const amount = Number(m[1].replace(/,/g, ""));
  return { amount: Number.isFinite(amount) ? amount : undefined, currency: m[2] || undefined };
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (nonEmpty(v)) {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Coerce to an RFC 3339 date-time in **UTC**, or undefined if it doesn't parse.
 *
 * The re-cut requires a trailing 'Z' on every timestamp field (`pattern: "Z$"`), and an upstream
 * that sends a local offset ("2026-06-16T23:59:00+02:00") would otherwise be published verbatim
 * and rejected by the gate. `Date.toISOString()` is what makes this total: it converts the instant
 * to UTC rather than trimming the offset, so the moment in time is preserved, not relabelled.
 */
function isoDate(v: unknown): string | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  if (typeof v === "string" && v.trim() === "") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Return the value only if it's a valid absolute http(s) URL (Standard fields use format:uri). */
function validUri(v: unknown): string | undefined {
  if (!nonEmpty(v)) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A currency found on an upstream per-item money shape (prize/reward/funding/checkSize). The
 * re-cut Standard has no per-type currency slot — every amount is denominated in the document-wide
 * `fundingInfo.currency` — so these are reported for hoisting there, never emitted in the details.
 */
type CurrencyHoist = (currency: string | undefined) => void;

/**
 * Upstream money in any shape — a plain number, "110 USDC", or the pre-re-cut
 * `{amount, currency}` object — → `{amount?, currency?}`. Amount is undefined if non-numeric.
 */
function moneyOf(v: unknown): { amount?: number; currency?: string } {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const amount = num(o.amount);
    if (amount === undefined) return {};
    return { amount, currency: nonEmpty(o.currency) ? o.currency : undefined };
  }
  return parseAmount(v);
}

/**
 * A prize with a numeric amount (dropped if the amount isn't numeric). The re-cut prize shape is
 * `{track?, amount}` — an upstream per-prize currency is hoisted, not emitted.
 */
function coercePrize(p: unknown, hoist: CurrencyHoist): Record<string, unknown> | undefined {
  if (!p || typeof p !== "object") return undefined;
  const o = p as Record<string, unknown>;
  const amount = num(o.amount);
  if (amount === undefined) return undefined;
  hoist(nonEmpty(o.currency) ? o.currency : undefined);
  const out: Record<string, unknown> = { amount };
  if (o.track !== undefined) out.track = o.track;
  return out;
}

/**
 * Coerce upstream money to the plain number the re-cut expects for `bounty.reward` and
 * `accelerator.funding`; an upstream currency is hoisted. Undefined if the amount isn't numeric.
 */
function coerceAmount(v: unknown, hoist: CurrencyHoist): number | undefined {
  const { amount, currency } = moneyOf(v);
  if (amount === undefined) return undefined;
  hoist(currency);
  return amount;
}

const BLOCK_NUM_KEYS = ["programDurationWeeks", "batchSize"];

/**
 * Coerce a `{min?, max?}` numeric range (checkSize); undefined if no bound survives. The re-cut
 * amountRange carries no currency — an upstream one is hoisted instead.
 */
function coerceRange(v: unknown, hoist: CurrencyHoist): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  if (nonEmpty(r.currency)) hoist(r.currency);
  const out: Record<string, unknown> = {};
  const mn = num(r.min);
  const mx = num(r.max);
  if (mn !== undefined) out.min = mn;
  if (mx !== undefined) out.max = mx;
  return Object.keys(out).length ? out : undefined;
}

/** teamSize: integer bounds >= 1, no currency (distinct from checkSize, which allows floats/currency). */
function coerceTeamSize(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const mn = num(r.min);
  const mx = num(r.max);
  if (mn !== undefined && mn >= 1) out.min = Math.round(mn);
  if (mx !== undefined && mx >= 1) out.max = Math.round(mx);
  return Object.keys(out).length ? out : undefined;
}

/** Standard enum values for constrained single-string type-block fields. */
const BLOCK_ENUMS: Record<string, string[]> = {
  difficulty: ["beginner", "intermediate", "advanced"],
  stage: ["pre-seed", "seed", "series-a"],
  contactMethod: ["email", "form", "intro-only"],
};
/** grant.fundingMechanisms items — 'matching' was added by the re-cut. */
const FUNDING_MECHANISMS = [
  "retroactive",
  "proactive",
  "streaming",
  "quadratic",
  "matching",
  "other",
];
const STAGE_VALUES = ["pre-seed", "seed", "series-a", "series-b+", "growth"]; // vc_fund.stages items
const BLOCK_BOOLEANS = new Set(["milestoneBased", "recurring", "online", "activelyInvesting"]);

/** Keep only the members of `values` present in `v` (accepting a bare scalar for an array field). */
function enumArray(v: unknown, values: string[]): string[] | undefined {
  const raw = Array.isArray(v) ? v : [v];
  const kept = [...new Set(raw.filter((x): x is string => typeof x === "string"))].filter((x) =>
    values.includes(x),
  );
  return kept.length ? kept : undefined;
}

/** Coerce type-block fields to the Standard's expected shapes; drop any value that can't conform. */
function normalizeBlock(
  src: Record<string, unknown>,
  hoist: CurrencyHoist,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (BLOCK_NUM_KEYS.includes(k)) {
      const n = num(v);
      if (n !== undefined) out[k] = n;
    } else if (k === "prizes" && Array.isArray(v)) {
      const prizes = v
        .map((p) => coercePrize(p, hoist))
        .filter((x): x is Record<string, unknown> => Boolean(x));
      if (prizes.length) out[k] = prizes;
    } else if (k === "reward" || k === "funding") {
      const amount = coerceAmount(v, hoist);
      if (amount !== undefined) out[k] = amount;
    } else if (k === "teamSize") {
      const ts = coerceTeamSize(v);
      if (ts) out[k] = ts;
    } else if (k === "checkSize") {
      const range = coerceRange(v, hoist);
      if (range) out[k] = range;
    } else if (k === "fundingMechanisms") {
      const mechanisms = enumArray(v, FUNDING_MECHANISMS);
      if (mechanisms) out[k] = mechanisms;
    } else if (k in BLOCK_ENUMS) {
      if (typeof v === "string" && BLOCK_ENUMS[k]?.includes(v)) out[k] = v;
    } else if (k === "stages" && Array.isArray(v)) {
      const stages = enumArray(v, STAGE_VALUES);
      if (stages) out[k] = stages;
    } else if (BLOCK_BOOLEANS.has(k)) {
      if (typeof v === "boolean") out[k] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Drop undefined / null / "" / [] values, returning a new object. */
function compact<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as T;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "org"
  );
}

function statusOf(p: RegistryProgram): OpportunityStatus {
  const raw = p.metadata?.status?.toLowerCase();
  if (raw && (STATUSES as string[]).includes(raw)) return raw as OpportunityStatus;
  return p.isActive ? "open" : "closed";
}

/** Upstream `{platform: url}` map → the Standard's `socialLinks[]` entries (valid URLs only). */
function socialLinksOf(src: Record<string, string> | undefined): SocialLink[] {
  const out: SocialLink[] = [];
  if (!src) return out;
  for (const platform of SOCIAL_KEYS) {
    const url = validUri(src[platform]);
    if (url) out.push({ platform, url });
  }
  return out;
}

/** Standard caps an organization name at 256 characters. */
const ORG_NAME_MAX = 256;

/** Where an organisation's NAME came from. The caller keys the directory slug off it. */
export type OrgNameSource = "upstream" | "community" | "title";

/**
 * The names of the organisations the upstream actually publishes for the program, in its order.
 *
 * ── Which ROLE these fill, and why ─────────────────────────────────────────────────
 * The re-cut split organisations into two roles: `sponsoringOrganizations` (issuer or backer) and
 * `operatingOrganizations` (whoever runs intake, process and the application funnel — required,
 * minItems 1, entry 0 primary and the one to display). The upstream draws no such distinction: it
 * publishes one flat list of the organisations behind the program, and those organisations are the
 * ones running it. So they fill `operatingOrganizations`, and `sponsoringOrganizations` is left
 * ABSENT rather than filled with the same names or with the listing community — the Standard says
 * a backer that is not published simply has no entry, and asserting a funding relationship the
 * source never states would be a fabrication of exactly the kind this function exists to prevent.
 *
 * ── Where the names come from ──────────────────────────────────────────────────────
 * The upstream carries them in `metadata.organizations`, and for an RFP `rfp.issuingOrganization`
 * names the issuer as free text — that one wins the primary slot. Names are deduped
 * case-insensitively, because an upstream list can repeat the issuer.
 *
 * The Standard requires at least one operating organisation, and most upstream programs name none,
 * so there are two fallbacks and the order between them matters:
 *
 *   community — the ecosystem community that lists the program ("Filecoin", "Optimism"). A real,
 *               lookup-able organisation with a slug the upstream itself publishes.
 *   title     — last resort, and nothing more: a title is not an organisation, and publishing one
 *               fabricates an org ("Filecoin ProPGF Batch 3") nobody can look up or deduplicate.
 *               It exists only because the field is required and a record with no organisation at
 *               all cannot be published; `source` below is what keeps it from doing damage.
 *
 * `source` is what stops the two from being mixed. A title-derived name must NEVER be filed under
 * the community's slug: several programs of one community would then land on a single directory
 * row under whichever fabricated name was written last, and `?organization=<slug>` would conflate
 * them. Title fallbacks therefore get their own (title-derived) slug.
 */
export function organizationNamesOf(
  organizations: unknown,
  issuingOrganization: unknown,
  fallbacks: { community?: unknown; title: string },
): { names: string[]; source: OrgNameSource } {
  const candidates = [
    ...(nonEmpty(issuingOrganization) ? [issuingOrganization] : []),
    ...cleanArr(organizations),
  ];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const name = raw.trim().slice(0, ORG_NAME_MAX);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length) return { names, source: "upstream" };
  if (nonEmpty(fallbacks.community)) {
    return { names: [fallbacks.community.trim().slice(0, ORG_NAME_MAX)], source: "community" };
  }
  return { names: [fallbacks.title.trim().slice(0, ORG_NAME_MAX)], source: "title" };
}

/** A location that literally says the event is remote — the upstream has no `online` flag. */
const ONLINE_LOCATION = /^\s*(online|virtual|remote)\b/i;

/**
 * `eligibility` is ONE free-text string in the re-cut — deliberately unstructured, "for reading,
 * not faceting" — where it used to be an open key-value map. The upstream publishes exactly one
 * eligibility signal, whether anyone may apply, so that signal becomes the whole sentence. Absent
 * flag ⇒ no field: silence is not a claim that the program is open, nor that it is closed.
 */
function eligibilityOf(anyoneCanJoin: unknown): string | undefined {
  if (typeof anyoneCanJoin !== "boolean") return undefined;
  return anyoneCanJoin
    ? "Anyone may apply — no invitation or pre-selection."
    : "Not open to all applicants — the program invites or pre-selects participants.";
}

/**
 * Supporting links no other Standard field carries, as the re-cut's `additionalReferences` — one
 * free-form string, "because publishers paste what they have" (it replaced `resourceLinks`).
 * `applicationUrl` is the single link-back target, so a program that publishes BOTH a submission
 * URL and a separate program page would otherwise drop the page.
 */
function additionalReferencesOf(
  sl: Record<string, string> | undefined,
  bugBounty: unknown,
  applicationUrl: string | undefined,
): string | undefined {
  const parts: string[] = [];
  const programSite = validUri(sl?.grantsSite);
  if (programSite && programSite !== applicationUrl) parts.push(`Program site: ${programSite}`);
  const bounty = validUri(bugBounty);
  if (bounty) parts.push(`Bug bounty: ${bounty}`);
  return parts.length ? parts.join(" · ") : undefined;
}

/** The raw upstream metadata blob for a funding type (all of them keep their old key names). */
function rawBlockOf(p: RegistryProgram, type: FundingType): Record<string, unknown> {
  switch (type) {
    case "hackathon":
      return p.hackathonMetadata ?? {};
    case "bounty":
      return p.bountyMetadata ?? {};
    case "accelerator":
      return p.acceleratorMetadata ?? {};
    case "vc_fund":
      return p.vcFundMetadata ?? {};
    case "rfp":
      return p.rfpMetadata ?? {};
    default:
      return p.grantMetadata ?? {};
  }
}

/**
 * Build `deadlines[]` from the program's top-level deadline plus every per-type date field the
 * re-cut folded in. Entries are deduped on (type, date, label) and ordered earliest-first, and a
 * date that doesn't parse is dropped rather than emitted as a `fixed` entry without a date (which
 * the schema forbids).
 */
function deadlinesOf(
  p: RegistryProgram,
  type: FundingType,
  rawBlock: Record<string, unknown>,
): Deadline[] {
  const entries: Deadline[] = [];
  const push = (value: unknown, label: string): void => {
    const date = isoDate(value);
    if (date) entries.push({ deadlineType: "fixed", date, label });
  };

  // The single upstream deadline is the application deadline (metadata.endsAt is the fallback).
  push(p.deadline ?? p.metadata?.endsAt, "application");
  for (const [key, label] of Object.entries(BLOCK_DEADLINE_LABELS[type] ?? {})) {
    push(rawBlock[key], label);
  }

  const seen = new Set<string>();
  return entries
    .filter((d) => {
      const key = `${d.deadlineType}|${d.date}|${d.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function typeBlockOf(
  p: RegistryProgram,
  type: FundingType,
  rawBlock: Record<string, unknown>,
  hoist: CurrencyHoist,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const k of TYPE_BLOCK_KEYS[type]) {
    const v = rawBlock[k];
    if (v !== undefined && v !== null && v !== "") picked[k] = v;
  }
  // Pre-re-cut upstreams send the scalar `fundingMechanism`; wrap it into the array field.
  if (type === "grant" && picked.fundingMechanisms === undefined) {
    const legacy = rawBlock.fundingMechanism;
    if (legacy !== undefined && legacy !== null && legacy !== "") picked.fundingMechanisms = legacy;
  }
  const out = normalizeBlock(picked, hoist);
  // hackathon/accelerator `online` has no upstream field, but a location of "Online" (or Virtual /
  // Remote) states it in words — read it rather than leave the flag unset on a remote event.
  if ((type === "hackathon" || type === "accelerator") && out.online === undefined) {
    if (nonEmpty(out.location) && ONLINE_LOCATION.test(out.location)) out.online = true;
  }
  if (type !== "bounty") return out;

  // The bounty block is the one type whose required field depends on a discriminator, so it is
  // rebuilt rather than mutated: `reward` and `rewardTiers` are each present or absent, never
  // present-and-undefined, which is the only shape the Standard's if/then/else accepts.
  const { bountyKind, reward, rewardTiers, ...rest } = out;

  // An empty array is not a tier table — the Standard requires minItems 1, so passing one
  // through would emit an invalid document, and it must not influence the inference either.
  const tiers = Array.isArray(rewardTiers) && rewardTiers.length > 0 ? rewardTiers : undefined;

  // bountyKind is required by the Standard and upstream does not send it. Payout shape alone
  // cannot decide it: the real upstream never extracts a tier table, so every security bug
  // bounty it carries — "Lido Bug Bounty" on Immunefi, and its peers — arrives as a bare
  // scalar, indistinguishable by shape from a task listing. The kind is the DOMAIN, so it is
  // inferred from domain signals: the program calling itself a bug bounty, or living on a
  // platform that hosts nothing else. Shape still decides the one case it can (a tier table
  // with no scalar is a security program however it is named), and tiers-plus-reward stays a
  // graded task, since the Standard allows a placement ladder on a task bounty.
  const nameStr = `${p.name ?? ""} ${p.metadata?.title ?? ""}`;
  const platformStr = typeof rest.platform === "string" ? rest.platform.trim().toLowerCase() : "";
  const securityByShape = tiers !== undefined && reward === undefined;
  const securityByDomain =
    /\bbug[\s-]*bount/i.test(nameStr) || SECURITY_BOUNTY_PLATFORMS.has(platformStr);
  const kind = bountyKind ?? (securityByShape || securityByDomain ? "security" : "task");

  // Compensation is EXACTLY ONE of reward or rewardTiers. A security bounty must carry the
  // table and may not carry the scalar, so where upstream published only a number the table is
  // synthesized from it: one row, selected by label, paying up to that number — which is what
  // the scalar on a bug bounty listing means. With no figure at all the row is discretionary.
  // Either way the record says what the source actually knows: this program pays for findings
  // of any severity, up to X where X is published, and the per-severity breakdown is not
  // carried by the source. Inventing a task label instead would assert one scoped job paying a
  // fixed amount — the exact misrepresentation the tier table exists to prevent.
  if (kind === "security") {
    const scalar = typeof reward === "number" && reward > 0 ? reward : undefined;
    const table = tiers ?? [
      scalar !== undefined
        ? { label: "any severity", payout: { model: "up_to", max: scalar } }
        : { label: "any severity", payout: { model: "discretionary" } },
    ];
    return { ...rest, bountyKind: kind, rewardTiers: table };
  }

  // Task path: the table wins where it exists — dropping it to keep a scalar would discard
  // grading the upstream took the trouble to publish. A reward is synthesized from the budget
  // only when there is no table and none was supplied.
  let scalarReward: unknown;
  if (tiers === undefined) {
    scalarReward = reward;
    if (scalarReward === undefined) {
      const { amount } = parseAmount(p.metadata?.programBudget);
      if (amount !== undefined) scalarReward = amount;
    }
  }

  return {
    ...rest,
    bountyKind: kind,
    ...(scalarReward !== undefined ? { reward: scalarReward } : {}),
    ...(tiers !== undefined ? { rewardTiers: tiers } : {}),
  };
}

export function mapProgram(p: RegistryProgram): Opportunity {
  const md = p.metadata ?? {};
  const fundingType: FundingType = (FUNDING_TYPES as string[]).includes(p.type ?? "")
    ? (p.type as FundingType)
    : "grant";
  const rawBlock = rawBlockOf(p, fundingType);

  const programId = String(p.programId ?? p.id ?? "");
  const title = nonEmpty(md.title) ? md.title : (p.name ?? programId);
  const description = nonEmpty(md.description)
    ? md.description
    : nonEmpty(md.shortDescription)
      ? md.shortDescription
      : title;

  const community = p.communities?.[0];
  const communitySlug = community?.slug;
  const ecosystems = cleanArr(
    md.ecosystems?.length ? md.ecosystems : p.communities?.map((c) => c.name),
  );

  // `rfp.issuingOrganization` was free text describing the real issuer — it now names the primary
  // operating organization, ahead of `metadata.organizations`; the community that lists the
  // program comes next, and the title is the last resort. See organizationNamesOf for why these
  // fill the OPERATING role and why sponsoringOrganizations is left absent.
  const issuing = fundingType === "rfp" ? rawBlock.issuingOrganization : undefined;
  const { names: orgNames, source: orgNameSource } = organizationNamesOf(
    md.organizations,
    issuing,
    {
      community: community?.name,
      title,
    },
  );

  // Per-item currencies the upstream still sends inside prize/reward/funding/checkSize shapes.
  // First one seen wins among themselves; document-level sources outrank them all (below).
  let detailCurrency: string | undefined;
  const hoist: CurrencyHoist = (c) => {
    detailCurrency ??= c;
  };
  const detailsBlock = typeBlockOf(p, fundingType, rawBlock, hoist);

  const budget = parseAmount(md.programBudget);
  // `rfp.budget` ({amount, currency}) folds into the shared top-level funding envelope.
  const rfpBudget = fundingType === "rfp" ? moneyOf(rawBlock.budget) : undefined;
  // `allocated` is committed-to-date. The upstream defaults it to 0 on programs that never report
  // it, so only a positive figure is a fact worth publishing.
  const allocated = num(md.amountDistributedToDate);
  const funding = compact({
    // THE CURRENCY RULE, in one expression — see the file header for the reasoning. Document-level
    // first (programBudget's suffix, then rfp.budget.currency), a hoisted per-item currency only
    // when neither named one, and on disagreement the document level wins with every amount kept:
    // the Standard cannot express two currencies, and the Hub has no rate with which to convert.
    // `allocated` needs no rule of its own — it is part of this same envelope by construction.
    currency: budget.currency ?? rfpBudget?.currency ?? detailCurrency,
    minAward: num(md.minGrantSize),
    maxAward: num(md.maxGrantSize),
    budget: budget.amount ?? rfpBudget?.amount,
    allocated: allocated !== undefined && allocated > 0 ? allocated : undefined,
  });

  const sl = md.socialLinks;
  const social = socialLinksOf(sl);
  // `source.url` is gone, which makes `applicationUrl` the single link-back target — but only for
  // links the PROGRAM published. There is deliberately no last-resort fallback: pointing at the
  // program's listing page on the aggregator we ingested it from would state, in the field
  // consumers read as "apply here", a URL the program never gave. That is the same fabrication
  // this branch removed when it stopped inventing sponsoring organisations out of program titles.
  // A program that publishes no URL gets no `applicationUrl` — the field is optional, and an
  // absent value is a fact where a substituted one is a guess.
  const applicationUrl =
    validUri(p.submissionUrl) ?? validUri(sl?.grantsSite) ?? validUri(md.website);

  // Array order is semantic: entry 0 is the primary organisation and the one to display. Only it
  // carries the program's branding; a co-operator the upstream names in passing gets the identity
  // it actually published. The slug is derived from the name that is actually published, so two
  // different organisation names can never share one directory row. The single exception is the
  // community fallback, where the name IS the community's and its own published slug is the more
  // authoritative spelling.
  const orgSlug = (name: string): string =>
    slugify(orgNameSource === "community" && nonEmpty(communitySlug) ? communitySlug : name);
  const operatingOrganizations = orgNames.map((name, i) =>
    compact({
      name,
      slug: orgSlug(name),
      website: i === 0 ? validUri(sl?.orgWebsite) : undefined,
      logoUrl: i === 0 ? validUri(md.logoImg) : undefined,
      ecosystems: i === 0 ? ecosystems : undefined,
    }),
  );

  const out: Record<string, unknown> = compact({
    specVersion: SPEC_VERSION,
    id: `${SOURCE_SYSTEM}:${programId}`,
    fundingType,
    title,
    description,
    summary:
      nonEmpty(md.shortDescription) && md.shortDescription !== title
        ? md.shortDescription.slice(0, 500)
        : undefined,
    status: statusOf(p),
    // The upstream's own organisations, in the required OPERATING role. sponsoringOrganizations is
    // deliberately NOT emitted: the upstream names no backer distinct from the operator.
    operatingOrganizations,
    source: compact({
      publisher: nonEmpty(communitySlug) ? slugify(communitySlug) : undefined,
      ingestedVia: "import",
      originalId: programId,
      verifiedAgainstSource: null,
    }),
    ecosystems,
    categories: cleanArr(md.categories),
    eligibility: eligibilityOf(md.anyoneCanJoin),
    additionalReferences: additionalReferencesOf(sl, md.bugBounty, applicationUrl),
    applicationUrl,
    website: validUri(md.website) ?? validUri(sl?.website),
    logoUrl: validUri(md.logoImg),
    bannerUrl: validUri(md.bannerImg),
    socialLinks: social.length ? social : undefined,
    fundingInfo: Object.keys(funding).length ? funding : undefined,
    opensAt: isoDate(md.startsAt),
    deadlines: deadlinesOf(p, fundingType, rawBlock),
    // The upstream record is created when the program is first listed at the source — the closest
    // thing it publishes to "first publicly announced", which is what postedAt means.
    postedAt: isoDate(p.createdAt),
    createdAt: isoDate(p.createdAt),
    updatedAt: isoDate(p.updatedAt),
  });

  // required `fundingDetails` slot: the type-specific payload, self-described by its required
  // `fundingType` tag (which must equal the top-level discriminator — the binding allOf enforces it).
  // For grants it may carry nothing beyond the tag.
  out.fundingDetails = { fundingType, ...detailsBlock };
  // source.verifiedAgainstSource must survive compaction of `null` — re-add explicitly
  (out.source as Record<string, unknown>).verifiedAgainstSource = null;

  return out as Opportunity;
}
