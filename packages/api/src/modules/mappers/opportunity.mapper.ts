/**
 * PURE mappers between DB rows and the RFP Hub Standard object — no DB access, fully unit-testable.
 *
 * - `toStandard(row)`  — read path (detail): full, schema-valid `Opportunity`.
 * - `toSummary(row)`   — read path (list): thin `OpportunitySummary` projection, omits the
 *                          `opportunity[fundingType]` block + `extensions` per FIELDS.md
 *                          "Delivery (API list vs detail)".
 * - `fromStandard(std)` — write path: Standard → { organization directory inserts, opp insert }.
 *
 * Since the re-cut the organizations an opportunity names are ARRAYS with semantic order, stored
 * verbatim on the opportunity row as jsonb, so the read mappers no longer take an organization row.
 */
import type {
  Deadline,
  Funding,
  Milestone,
  Opportunity,
  Organization,
} from "@the-rfp-hub/standard";
import type { OpportunityInsert, OpportunityRow, OrganizationInsert } from "../../db/schema.js";
import { nextDeadlineAt } from "../shared/deadlines.js";

/** Strip the generated type's `[k: string]: unknown` index signature so Omit can drop named keys. */
type RemoveIndex<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/**
 * Thin list projection type — a full Opportunity minus the six type-specific blocks and
 * `extensions` (a delivery concern, per FIELDS.md "Delivery (API list vs detail)").
 */
export type OpportunitySummary = Omit<
  RemoveIndex<Opportunity>,
  "grant" | "hackathon" | "bounty" | "accelerator" | "vc_fund" | "rfp" | "extensions"
>;

/** The six `fundingType` values — also the six type-block keys. */
export const FUNDING_TYPES = [
  "grant",
  "hackathon",
  "bounty",
  "accelerator",
  "vc_fund",
  "rfp",
] as const;

// ── small helpers ────────────────────────────────────────────────────────────────
/** Drop keys whose value is `undefined` (keeps `false`/`0`/`""`/`null`), returning a new object. */
function compact<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}
/** numeric column (string|null) → number | undefined */
function num(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
/** timestamptz (Date|null) → ISO string | undefined */
function iso(d: Date | null): string | undefined {
  return d ? d.toISOString() : undefined;
}
/** [] → undefined (so empty arrays are omitted from the Standard object) */
function arr<T>(a: T[] | null | undefined): T[] | undefined {
  return Array.isArray(a) && a.length ? [...a] : undefined;
}
/** {} → undefined */
function obj<T extends Record<string, unknown>>(o: T | null | undefined): T | undefined {
  return o && Object.keys(o).length ? o : undefined;
}

function sourceOf(r: OpportunityRow): Record<string, unknown> {
  // `source` is a required object with NO required member since the re-cut — `{}` is valid.
  return compact({
    publisher: r.sourcePublisher ?? undefined,
    submittedBy: r.sourceSubmittedBy ?? undefined,
    submittedAt: iso(r.sourceSubmittedAt),
    ingestedVia: r.ingestedVia ?? undefined,
    originalId: r.originalId ?? undefined,
    // keep an explicit `null` (= "not yet verified"); only `undefined` is dropped by compact()
    verifiedAgainstSource: r.verifiedAgainstSource,
    verifiedAt: iso(r.verifiedAt),
    snapshotUrl: r.snapshotUrl ?? undefined,
  });
}

function fundingOf(r: OpportunityRow): Funding | undefined {
  const f = compact({
    currency: r.currency ?? undefined,
    budget: num(r.budget),
    allocated: num(r.allocated),
    minAward: num(r.minAward),
    maxAward: num(r.maxAward),
  });
  return Object.keys(f).length ? (f as Funding) : undefined;
}

/** Common fields shared by list and detail (everything except the type block + extensions). */
function baseOf(row: OpportunityRow): Record<string, unknown> {
  return compact({
    specVersion: row.specVersion,
    id: row.publicId,
    fundingType: row.fundingType,
    title: row.title,
    description: row.description,
    summary: row.summary ?? undefined,
    status: row.status,
    sponsoringOrganizations: row.sponsoringOrganizations,
    operatingOrganizations: arr(row.operatingOrganizations),
    source: sourceOf(row),
    ecosystems: arr(row.ecosystems),
    networks: arr(row.networks),
    categories: arr(row.categories),
    tags: arr(row.tags),
    eligibility: obj(row.eligibility),
    prerequisites: row.prerequisites ?? undefined,
    resourceLinks: row.resourceLinks ?? undefined,
    serviceAgreement: row.serviceAgreement ?? undefined,
    applicationUrl: row.applicationUrl ?? undefined,
    website: row.website ?? undefined,
    logoUrl: row.logoUrl ?? undefined,
    bannerUrl: row.bannerUrl ?? undefined,
    socialLinks: obj(row.socialLinks),
    funding: fundingOf(row),
    milestones: arr(row.milestones),
    opensAt: iso(row.opensAt),
    deadlines: arr(row.deadlines),
    postedAt: iso(row.postedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

/** Full, schema-valid Standard object (detail endpoint, exports, snapshots). */
export function toStandard(row: OpportunityRow): Opportunity {
  const out = baseOf(row);
  // type-specific block lives under a key equal to `fundingType` (grant→grant, vc_fund→vc_fund, …).
  out[row.fundingType] = row.typeData ?? {};
  const ext = obj(row.extensions);
  if (ext) out.extensions = ext;
  return out as Opportunity;
}

/** Thin list projection — omits the type block + extensions (a delivery concern, not a schema). */
export function toSummary(row: OpportunityRow): OpportunitySummary {
  return baseOf(row) as OpportunitySummary;
}

// ── inverse (write path) ──────────────────────────────────────────────────────────
/** opp insert minus the server-side fields the ingest sets itself. */
export type OpportunityInsertData = Omit<
  OpportunityInsert,
  "reviewStatus" | "isListed" | "sourceSystem"
>;

function numStr(v: number | null | undefined): string | null {
  return v === null || v === undefined ? null : String(v);
}
function dateOrNull(v: string | null | undefined): Date | null {
  return v ? new Date(v) : null;
}
function dateOrUndef(v: string | null | undefined): Date | undefined {
  return v ? new Date(v) : undefined;
}
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "org"
  );
}

/** The directory key for an organization: its own slug, or one derived from its display name. */
export function orgSlug(o: Organization): string {
  return o.slug ?? slugify(o.name);
}

/**
 * INGEST GUARD — the re-cut made "one block per funding type" a schema guarantee: the matching
 * block is required and every non-matching block is FORBIDDEN. Enforce it at the write boundary
 * so a malformed record can never be stored (the read path serves `row.typeData` under whatever
 * `fundingType` says, and would silently lose a second block).
 */
export function assertSingleTypeBlock(std: Opportunity): void {
  const record = std as Record<string, unknown>;
  if (record[std.fundingType] === undefined) {
    throw new Error(
      `opportunity '${std.id}' has fundingType '${std.fundingType}' but no matching '${std.fundingType}' block`,
    );
  }
  const extra = FUNDING_TYPES.filter((t) => t !== std.fundingType && record[t] !== undefined);
  if (extra.length) {
    throw new Error(
      `opportunity '${std.id}' has fundingType '${std.fundingType}' but also carries: ${extra.join(", ")}`,
    );
  }
}

/**
 * The organization-directory rows an opportunity implies — every sponsoring AND operating
 * organization, deduped by slug. These keep `organizations` a complete directory; the opportunity's
 * own (order-significant) arrays are stored on the opportunity row itself.
 */
export function organizationInserts(std: Opportunity): OrganizationInsert[] {
  const all = [...std.sponsoringOrganizations, ...(std.operatingOrganizations ?? [])];
  const bySlug = new Map<string, OrganizationInsert>();
  for (const o of all) {
    bySlug.set(orgSlug(o), {
      slug: orgSlug(o),
      name: o.name,
      type: o.type ?? null,
      description: o.description ?? null,
      website: o.website ?? null,
      logoUrl: o.logoUrl ?? null,
      bannerUrl: o.bannerUrl ?? null,
      socialLinks: (o.socialLinks ?? {}) as Record<string, string>,
      ecosystems: o.ecosystems ?? [],
      contacts: o.contacts ?? [],
    });
  }
  return [...bySlug.values()];
}

/**
 * Standard object → DB inserts.
 *
 * Absorbs the whole re-cut shape: `fundingType`, the organization arrays (+ the denormalized
 * `sponsorSlugs` lookup key), `deadlines[]` and the derived `nextDeadlineAt`, the renamed funding
 * envelope, and the new optional blocks. The three self-identification properties
 * (`$schema`/`@context`/`@type`) are ACCEPTED and STRIPPED — they describe the document, not the
 * opportunity, so they are never persisted or re-emitted.
 */
export function fromStandard(
  std: Opportunity,
  now: Date = new Date(),
): {
  orgs: OrganizationInsert[];
  opp: OpportunityInsertData;
} {
  assertSingleTypeBlock(std);

  const s = std.source ?? {};
  const typeBlock = (std as Record<string, unknown>)[std.fundingType];
  const deadlines = (std.deadlines ?? []) as Deadline[];

  const opp: OpportunityInsertData = {
    publicId: std.id,
    specVersion: std.specVersion,
    fundingType: std.fundingType,
    status: std.status,
    title: std.title,
    description: std.description,
    summary: std.summary ?? null,
    sponsoringOrganizations: std.sponsoringOrganizations,
    operatingOrganizations: std.operatingOrganizations ?? [],
    sponsorSlugs: std.sponsoringOrganizations.map(orgSlug),
    applicationUrl: std.applicationUrl ?? null,
    website: std.website ?? null,
    logoUrl: std.logoUrl ?? null,
    bannerUrl: std.bannerUrl ?? null,
    socialLinks: (std.socialLinks ?? {}) as Record<string, string>,
    ecosystems: std.ecosystems ?? [],
    networks: std.networks ?? [],
    categories: std.categories ?? [],
    tags: std.tags ?? [],
    eligibility: std.eligibility ?? {},
    prerequisites: std.prerequisites ?? null,
    resourceLinks: std.resourceLinks ?? null,
    serviceAgreement: std.serviceAgreement ?? null,
    currency: std.funding?.currency ?? null,
    minAward: numStr(std.funding?.minAward),
    maxAward: numStr(std.funding?.maxAward),
    budget: numStr(std.funding?.budget),
    allocated: numStr(std.funding?.allocated),
    milestones: (std.milestones ?? []) as Milestone[],
    opensAt: dateOrNull(std.opensAt),
    deadlines,
    nextDeadlineAt: nextDeadlineAt(deadlines, now),
    postedAt: dateOrNull(std.postedAt), // (read mapper emits postedAt; keep the inverse symmetric)
    createdAt: dateOrUndef(std.createdAt), // omit → DB default now()
    updatedAt: dateOrUndef(std.updatedAt),
    typeData: (typeBlock as Record<string, unknown>) ?? {},
    extensions: std.extensions ?? {},
    sourcePublisher: s.publisher ?? null,
    sourceSubmittedBy: s.submittedBy ?? null,
    sourceSubmittedAt: dateOrNull(s.submittedAt),
    ingestedVia: s.ingestedVia ?? null,
    originalId: s.originalId ?? null,
    verifiedAgainstSource: s.verifiedAgainstSource ?? null,
    verifiedAt: dateOrNull(s.verifiedAt),
    snapshotUrl: s.snapshotUrl ?? null,
  };

  return { orgs: organizationInserts(std), opp };
}
