/**
 * PURE mapper: an upstream funding-map registry program → RFP Hub Standard `Opportunity`.
 * No network/DB — fully unit-testable. The seed loader validates each result with
 * `rfphub-validate` and skips any that don't conform, so this aims for best-effort fidelity.
 *
 * Field rules were derived from the committed examples in
 * packages/standard/schemas/v1.0.0/examples. The provenance namespace (id prefix + source_system)
 * and the fallback program URL are supplied by the caller — this mapper is source-agnostic.
 */
import type { Opportunity, OpportunityStatus, OpportunityType } from "@rfp-hub/standard";

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
    networks?: string[];
    grantTypes?: string[];
    organizations?: string[];
    minGrantSize?: number | string | null;
    maxGrantSize?: number | string | null;
    programBudget?: number | string | null;
    website?: string;
    logoImg?: string;
    bannerImg?: string;
    socialLinks?: Record<string, string>;
  };
  hackathonMetadata?: Record<string, unknown> | null;
  bountyMetadata?: Record<string, unknown> | null;
  acceleratorMetadata?: Record<string, unknown> | null;
  vcFundMetadata?: Record<string, unknown> | null;
  rfpMetadata?: Record<string, unknown> | null;
}

const TYPES: OpportunityType[] = ["grant", "hackathon", "bounty", "accelerator", "vc_fund", "rfp"];
const STATUSES: OpportunityStatus[] = ["upcoming", "open", "closed", "archived"];

/** Standard-allowed keys per type block (additionalProperties:false ⇒ whitelist before emit). */
const TYPE_BLOCK_KEYS: Record<OpportunityType, string[]> = {
  grant: ["fundingMechanism", "milestoneBased", "recurring"],
  hackathon: [
    "startDate",
    "endDate",
    "location",
    "online",
    "tracks",
    "prizes",
    "registrationDeadline",
    "submissionDeadline",
    "teamSize",
  ],
  bounty: ["reward", "difficulty", "skills", "platform"],
  accelerator: [
    "applicationDeadline",
    "programDurationWeeks",
    "batchSize",
    "equity",
    "funding",
    "stage",
    "location",
    "online",
  ],
  vc_fund: ["checkSize", "stages", "thesis", "portfolio", "contactMethod", "activelyInvesting"],
  rfp: ["issuingOrganization", "budget", "scope", "requirements", "proposalDeadline"],
};

const SOCIAL_KEYS = ["twitter", "discord", "github", "telegram", "farcaster", "forum", "blog"];

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

/** A prize with a numeric amount and a currency (defaults USD); dropped if amount isn't numeric. */
function coercePrize(p: unknown): Record<string, unknown> | undefined {
  if (!p || typeof p !== "object") return undefined;
  const o = p as Record<string, unknown>;
  const amount = num(o.amount);
  if (amount === undefined) return undefined;
  const out: Record<string, unknown> = {
    amount,
    currency: nonEmpty(o.currency) ? o.currency : "USD",
  };
  if (o.track !== undefined) out.track = o.track;
  return out;
}

/** Coerce a `{amount, currency}` money object; drop if amount isn't numeric. */
function coerceMoney(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const amount = num(o.amount);
  if (amount === undefined) return undefined;
  return { amount, currency: nonEmpty(o.currency) ? o.currency : "USD" };
}

const BLOCK_DATE_KEYS = [
  "startDate",
  "endDate",
  "registrationDeadline",
  "submissionDeadline",
  "applicationDeadline",
  "proposalDeadline",
];
const BLOCK_NUM_KEYS = ["programDurationWeeks", "batchSize"];

/** Coerce a `{min?, max?, currency?}` numeric range (checkSize); undefined if nothing survives. */
function coerceRange(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const mn = num(r.min);
  const mx = num(r.max);
  if (mn !== undefined) out.min = mn;
  if (mx !== undefined) out.max = mx;
  if (nonEmpty(r.currency)) out.currency = r.currency;
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
  fundingMechanism: ["retroactive", "proactive", "streaming", "quadratic", "other"],
  difficulty: ["beginner", "intermediate", "advanced"],
  stage: ["pre-seed", "seed", "series-a"],
  contactMethod: ["email", "form", "intro-only"],
};
const STAGE_VALUES = ["pre-seed", "seed", "series-a", "series-b+", "growth"]; // vc_fund.stages items
const BLOCK_BOOLEANS = new Set(["milestoneBased", "recurring", "online", "activelyInvesting"]);

/** Coerce type-block fields to the Standard's expected shapes; drop any value that can't conform. */
function normalizeBlock(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (BLOCK_DATE_KEYS.includes(k)) {
      const d = isoDate(v);
      if (d) out[k] = d;
    } else if (BLOCK_NUM_KEYS.includes(k)) {
      const n = num(v);
      if (n !== undefined) out[k] = n;
    } else if (k === "prizes" && Array.isArray(v)) {
      const prizes = v.map(coercePrize).filter((x): x is Record<string, unknown> => Boolean(x));
      if (prizes.length) out[k] = prizes;
    } else if (k === "reward" || k === "funding" || k === "budget") {
      const money = coerceMoney(v);
      if (money) out[k] = money;
    } else if (k === "teamSize") {
      const ts = coerceTeamSize(v);
      if (ts) out[k] = ts;
    } else if (k === "checkSize") {
      const range = coerceRange(v);
      if (range) out[k] = range;
    } else if (k in BLOCK_ENUMS) {
      if (typeof v === "string" && BLOCK_ENUMS[k]?.includes(v)) out[k] = v;
    } else if (k === "stages" && Array.isArray(v)) {
      const stages = v.filter(
        (x): x is string => typeof x === "string" && STAGE_VALUES.includes(x),
      );
      if (stages.length) out[k] = stages;
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

function socialLinksOf(src: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!src) return out;
  for (const k of SOCIAL_KEYS) if (nonEmpty(src[k])) out[k] = src[k];
  return out;
}

function typeBlockOf(p: RegistryProgram, type: OpportunityType): Record<string, unknown> {
  const raw: Record<string, unknown> =
    type === "hackathon"
      ? (p.hackathonMetadata ?? {})
      : type === "bounty"
        ? (p.bountyMetadata ?? {})
        : type === "accelerator"
          ? (p.acceleratorMetadata ?? {})
          : type === "vc_fund"
            ? (p.vcFundMetadata ?? {})
            : type === "rfp"
              ? (p.rfpMetadata ?? {})
              : {};
  const picked: Record<string, unknown> = {};
  for (const k of TYPE_BLOCK_KEYS[type]) {
    const v = raw[k];
    if (v !== undefined && v !== null && v !== "") picked[k] = v;
  }
  const out = normalizeBlock(picked);
  // bounty.reward is required by the Standard — synthesize from the budget if absent.
  if (type === "bounty" && !out.reward) {
    const { amount, currency } = parseAmount(p.metadata?.programBudget);
    if (amount !== undefined) out.reward = { amount, currency: currency ?? "USD" };
  }
  return out;
}

export function mapProgram(
  p: RegistryProgram,
  opts: { sourceSystem?: string; programUrlBase?: string } = {},
): Opportunity {
  const sourceSystem = opts.sourceSystem || "fundingmap";
  const md = p.metadata ?? {};
  const type: OpportunityType = (TYPES as string[]).includes(p.type ?? "")
    ? (p.type as OpportunityType)
    : "grant";

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

  const budget = parseAmount(md.programBudget);
  const minAward = num(md.minGrantSize);
  const maxAward = num(md.maxGrantSize);
  const funding = compact({
    currency: budget.currency,
    minAward,
    maxAward,
    totalBudget: budget.amount,
  });

  const sl = md.socialLinks;
  const social = socialLinksOf(sl);
  // Provenance fallback: a program's page on the source. Source-agnostic — no fabricated URL when
  // the caller supplies no base (the entry then lacks source.url and is skipped by validation).
  const fallbackUrl = opts.programUrlBase
    ? `${opts.programUrlBase.replace(/\/+$/, "")}/${programId}`
    : undefined;
  const sourceUrl = validUri(p.submissionUrl) ?? validUri(md.website) ?? fallbackUrl;

  const out: Record<string, unknown> = compact({
    specVersion: "1.0.0",
    id: `${sourceSystem}:${programId}`,
    type,
    title,
    description,
    summary:
      nonEmpty(md.shortDescription) && md.shortDescription !== title
        ? md.shortDescription.slice(0, 500)
        : undefined,
    status: statusOf(p),
    organization: compact({
      name: title.slice(0, 256), // Standard caps organization.name at 256 (title allows 300)
      slug: slugify(nonEmpty(communitySlug) ? communitySlug : title),
      logoUrl: validUri(md.logoImg),
      ecosystems,
    }),
    source: compact({
      url: sourceUrl,
      publisher: nonEmpty(communitySlug) ? slugify(communitySlug) : undefined,
      ingestedVia: "import",
      originalId: programId,
      verifiedAgainstSource: null,
    }),
    ecosystems,
    networks: cleanArr(md.networks),
    categories: cleanArr(md.categories),
    tags: cleanArr(md.grantTypes),
    applicationUrl: validUri(p.submissionUrl) ?? validUri(sl?.grantsSite),
    website: validUri(md.website) ?? validUri(sl?.website),
    logoUrl: validUri(md.logoImg),
    bannerUrl: validUri(md.bannerImg),
    socialLinks: Object.keys(social).length ? social : undefined,
    funding: Object.keys(funding).length ? funding : undefined,
    opensAt: isoDate(md.startsAt),
    closesAt: isoDate(p.deadline ?? md.endsAt),
    createdAt: isoDate(p.createdAt),
    updatedAt: isoDate(p.updatedAt),
  });

  // required type-specific block under the `type` key (may be {} for grants)
  out[type] = typeBlockOf(p, type);
  // source.verifiedAgainstSource must survive compaction of `null` — re-add explicitly
  (out.source as Record<string, unknown>).verifiedAgainstSource = null;

  return out as Opportunity;
}
