/**
 * PURE mapper: an upstream funding-map registry program → RFP Hub Standard `Opportunity`.
 * No network/DB — fully unit-testable. The seed loader validates each result with
 * `rfphub-validate` and skips any that don't conform, so this aims for best-effort fidelity.
 *
 * Field rules were derived from the committed examples in
 * packages/standard/schemas/v1.0.0/examples. The provenance namespace (id prefix + source_system)
 * and the fallback program URL are supplied by the caller — this mapper is source-agnostic.
 *
 * ── Old-upstream → re-cut Standard ─────────────────────────────────────────────────
 * The upstream registry still speaks the pre-re-cut vocabulary, so THIS FILE is where the
 * conversion lives (the same rules the Standard's own examples were regenerated with):
 *
 *   type                       → fundingType
 *   organization (single)      → operatingOrganizations[0]   (rfp.issuingOrganization wins the
 *                                name; the upstream org RUNS the program, so it is the operator —
 *                                sponsoringOrganizations stays absent for ingested records)
 *   deadline / metadata.endsAt → deadlines[{deadlineType:'fixed', date, label:'application'}]
 *   hackathon.registrationDeadline / submissionDeadline / startDate / endDate
 *                              → deadlines[… label 'registration' | 'submission' | 'event start' | 'event end']
 *   accelerator.applicationDeadline, rfp.proposalDeadline
 *                              → deadlines[… label 'application']
 *   funding.totalBudget        → fundingInfo.budget  (rfp.budget folds into the same envelope)
 *   metadata.socialLinks (map) → socialLinks[{platform, url}]
 *   metadata.networks / grantTypes → dropped (the Standard removed networks/tags; accepted loss)
 *   grant.fundingMechanism     → fundingDetails.fundingMechanisms[]
 *   per-item {amount, currency} money (bounty.reward, prizes[], accelerator.funding, checkSize)
 *                              → plain numbers; an upstream per-item currency hoists into the
 *                                document-wide fundingInfo.currency (which wins on disagreement)
 *   <type>Metadata blob        → fundingDetails { fundingType: <type>, …whitelisted keys }
 *   source.url                 → removed; the program URL now feeds `applicationUrl`
 */
import type {
  Deadline,
  FundingType,
  Opportunity,
  OpportunityStatus,
  SocialLink,
} from "@the-rfp-hub/standard";

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
    organizations?: string[];
    minGrantSize?: number | string | null;
    maxGrantSize?: number | string | null;
    programBudget?: number | string | null;
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

/** Coerce to an RFC 3339 date-time string, or undefined if it doesn't parse. */
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
  if (type === "bounty") {
    // An empty tier array is not a tier table — the Standard requires minItems 1, so passing it
    // through would emit an invalid document. Drop it before it can influence the inference.
    if (Array.isArray(out.rewardTiers) && out.rewardTiers.length === 0) delete out.rewardTiers;
    const hasTiers = Array.isArray(out.rewardTiers) && out.rewardTiers.length > 0;
    // bountyKind is required by the Standard and upstream does not send it. Infer from the
    // payout shape: a tier table AND no scalar reward is a security program. Tiers alone are not
    // enough — the Standard permits them on a task bounty that grades a placement ladder, and
    // such a record keeps its reward, so calling it 'security' would both mislabel it and (since
    // security forbids the scalar reward) make it invalid.
    if (out.bountyKind === undefined) {
      out.bountyKind = hasTiers && out.reward === undefined ? "security" : "task";
    }
    // reward is required for a task bounty — synthesize from the budget if absent (a plain
    // number now; the budget's parsed currency reaches fundingInfo via parseAmount in mapProgram).
    // Never synthesized for a security bounty: collapsing a graded table to one number is the
    // misrepresentation the tier table exists to prevent, and the Standard forbids it there.
    if (out.bountyKind === "task" && out.reward === undefined) {
      const { amount } = parseAmount(p.metadata?.programBudget);
      if (amount !== undefined) out.reward = amount;
    }
    // A security bounty may not carry the scalar reward at all.
    if (out.bountyKind === "security") delete out.reward;
  }
  return out;
}

export function mapProgram(
  p: RegistryProgram,
  opts: { sourceSystem?: string; programUrlBase?: string } = {},
): Opportunity {
  const sourceSystem = opts.sourceSystem || "fundingmap";
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
  // operating organization, which is strictly better than the title-derived fallback.
  const issuing = fundingType === "rfp" ? rawBlock.issuingOrganization : undefined;
  const orgName = (nonEmpty(issuing) ? issuing : title).slice(0, 256); // Standard caps name at 256

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
  const funding = compact({
    // Ingest normalization: the re-cut Standard denominates EVERY monetary amount in the document
    // in the single fundingInfo.currency — no per-type currency exists. So an upstream per-item
    // currency (prize/reward/funding/checkSize) is hoisted here when no document-level currency
    // (programBudget / rfp.budget) established one. When they disagree, the document-level
    // currency wins: the Standard cannot express the disagreement, so ingestion normalizes to the
    // document-wide denomination and keeps the amounts rather than dropping them (best-effort
    // fidelity — the seed gate would otherwise lose the whole record over a label).
    currency: budget.currency ?? rfpBudget?.currency ?? detailCurrency,
    minAward: num(md.minGrantSize),
    maxAward: num(md.maxGrantSize),
    budget: budget.amount ?? rfpBudget?.amount,
  });

  const sl = md.socialLinks;
  const social = socialLinksOf(sl);
  // `source.url` is gone; `applicationUrl` is now the single link-back target, so the program's
  // page on the source becomes its last-resort value. Source-agnostic — nothing is fabricated when
  // the caller supplies no base.
  const fallbackUrl = opts.programUrlBase
    ? `${opts.programUrlBase.replace(/\/+$/, "")}/${programId}`
    : undefined;

  const out: Record<string, unknown> = compact({
    specVersion: "1.0.0",
    id: `${sourceSystem}:${programId}`,
    fundingType,
    title,
    description,
    summary:
      nonEmpty(md.shortDescription) && md.shortDescription !== title
        ? md.shortDescription.slice(0, 500)
        : undefined,
    status: statusOf(p),
    // The upstream org RUNS the program, so it is the operator ("the real deal"); the Standard
    // requires operatingOrganizations (minItems 1) and slug (synthesized — upstream has none).
    // sponsoringOrganizations is deliberately NOT emitted for ingested records.
    operatingOrganizations: [
      compact({
        name: orgName,
        slug: slugify(nonEmpty(communitySlug) ? communitySlug : orgName),
        logoUrl: validUri(md.logoImg),
        ecosystems,
      }),
    ],
    source: compact({
      publisher: nonEmpty(communitySlug) ? slugify(communitySlug) : undefined,
      ingestedVia: "import",
      originalId: programId,
      verifiedAgainstSource: null,
    }),
    ecosystems,
    categories: cleanArr(md.categories),
    applicationUrl:
      validUri(p.submissionUrl) ??
      validUri(sl?.grantsSite) ??
      validUri(md.website) ??
      validUri(fallbackUrl),
    website: validUri(md.website) ?? validUri(sl?.website),
    logoUrl: validUri(md.logoImg),
    bannerUrl: validUri(md.bannerImg),
    socialLinks: social.length ? social : undefined,
    fundingInfo: Object.keys(funding).length ? funding : undefined,
    opensAt: isoDate(md.startsAt),
    deadlines: deadlinesOf(p, fundingType, rawBlock),
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
