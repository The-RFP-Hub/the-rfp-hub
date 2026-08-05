/**
 * PURE mappers between DB rows and the RFP Hub Standard object — no DB access, fully unit-testable.
 *
 * - `toStandard(row)`  — read path (detail): full, schema-valid `Opportunity`.
 * - `toSummary(row)`   — read path (list): thin `OpportunitySummary` projection, omits
 *                          `fundingDetails` per FIELDS.md "Delivery (API list vs detail)".
 * - `fromStandard(std)` — write path: Standard → { organization directory inserts, opp insert }.
 *
 * Since the re-cut the organizations an opportunity names are ARRAYS with semantic order, stored
 * verbatim on the opportunity row as jsonb, so the read mappers no longer take an organization row.
 * `operatingOrganizations` is the required, primary array — entry [0] is the display org.
 */
import type { Deadline, Funding, Milestone, Opportunity } from "@the-rfp-hub/standard";
import type { OpportunityInsert, OpportunityRow, OrganizationInsert } from "../../db/schema.js";
import { nextDeadlineAt } from "../shared/deadlines.js";

/** Strip the generated type's `[k: string]: unknown` index signature so Omit can drop named keys. */
type RemoveIndex<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/**
 * Thin list projection type — a full Opportunity minus the type-specific `fundingDetails` slot
 * (a delivery concern, per FIELDS.md "Delivery (API list vs detail)").
 */
export type OpportunitySummary = Omit<RemoveIndex<Opportunity>, "fundingDetails">;

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

/** Common fields shared by list and detail (everything except the type block). */
function baseOf(row: OpportunityRow): Record<string, unknown> {
  return compact({
    specVersion: row.specVersion,
    id: row.publicId,
    fundingType: row.fundingType,
    title: row.title,
    description: row.description,
    summary: row.summary ?? undefined,
    status: row.status,
    sponsoringOrganizations: arr(row.sponsoringOrganizations),
    operatingOrganizations: row.operatingOrganizations,
    source: sourceOf(row),
    ecosystems: arr(row.ecosystems),
    categories: arr(row.categories),
    eligibility: row.eligibility ?? undefined,
    prerequisites: row.prerequisites ?? undefined,
    additionalReferences: row.additionalReferences ?? undefined,
    serviceAgreement: row.serviceAgreement ?? undefined,
    applicationUrl: row.applicationUrl ?? undefined,
    website: row.website ?? undefined,
    logoUrl: row.logoUrl ?? undefined,
    bannerUrl: row.bannerUrl ?? undefined,
    socialLinks: arr(row.socialLinks),
    fundingInfo: fundingOf(row),
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
  // `typeData` is stored TAG-FREE (see fromStandard); the read path reattaches the `fundingType`
  // tag from the column, so the served tag can never disagree with the top-level discriminator.
  out.fundingDetails = { fundingType: row.fundingType, ...(row.typeData ?? {}) };
  return out as Opportunity;
}

/** Thin list projection — omits `fundingDetails` (a delivery concern, not a schema). */
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
/**
 * The organization-directory rows an opportunity implies — every operating AND sponsoring
 * organization, deduped by slug (a Standard-required field since the re-cut). These keep
 * `organizations` a complete directory; the opportunity's own (order-significant) arrays are
 * stored on the opportunity row itself.
 */
export function organizationInserts(std: Opportunity): OrganizationInsert[] {
  const all = [...std.operatingOrganizations, ...(std.sponsoringOrganizations ?? [])];
  const bySlug = new Map<string, OrganizationInsert>();
  for (const o of all) {
    bySlug.set(o.slug, {
      slug: o.slug,
      name: o.name,
      orgType: o.orgType ?? null,
      description: o.description ?? null,
      website: o.website ?? null,
      logoUrl: o.logoUrl ?? null,
      bannerUrl: o.bannerUrl ?? null,
      socialLinks: o.socialLinks ?? [],
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
 * `orgSlugs` lookup key, the UNION of operating + sponsoring slugs), `deadlines[]` and the derived
 * `nextDeadlineAt`, the renamed funding envelope, and the new optional blocks. The three
 * self-identification properties
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
  const s = std.source ?? {};
  // `fundingDetails` is a tagged union — its required inner `fundingType` tag equals the
  // top-level discriminator (the Standard's binding allOf keeps the two in step). The tag is
  // STRIPPED before storage: `typeData` stays a tag-free jsonb payload, because the tag is
  // derivable from the `fundingType` column and storing it twice would let the copies disagree.
  // `toStandard` reattaches it on read.
  const details: Record<string, unknown> = { ...std.fundingDetails };
  const { fundingType: _detailsTag, ...typeData } = details;
  const deadlines = (std.deadlines ?? []) as Deadline[];

  const opp: OpportunityInsertData = {
    publicId: std.id,
    specVersion: std.specVersion,
    fundingType: std.fundingType,
    status: std.status,
    title: std.title,
    description: std.description,
    summary: std.summary ?? null,
    sponsoringOrganizations: std.sponsoringOrganizations ?? [],
    operatingOrganizations: std.operatingOrganizations,
    orgSlugs: [
      ...new Set(
        [...std.operatingOrganizations, ...(std.sponsoringOrganizations ?? [])].map((o) => o.slug),
      ),
    ],
    applicationUrl: std.applicationUrl ?? null,
    website: std.website ?? null,
    logoUrl: std.logoUrl ?? null,
    bannerUrl: std.bannerUrl ?? null,
    socialLinks: std.socialLinks ?? [],
    ecosystems: std.ecosystems ?? [],
    categories: std.categories ?? [],
    eligibility: std.eligibility ?? null,
    prerequisites: std.prerequisites ?? null,
    additionalReferences: std.additionalReferences ?? null,
    serviceAgreement: std.serviceAgreement ?? null,
    currency: std.fundingInfo?.currency ?? null,
    minAward: numStr(std.fundingInfo?.minAward),
    maxAward: numStr(std.fundingInfo?.maxAward),
    budget: numStr(std.fundingInfo?.budget),
    allocated: numStr(std.fundingInfo?.allocated),
    milestones: (std.milestones ?? []) as Milestone[],
    opensAt: dateOrNull(std.opensAt),
    deadlines,
    nextDeadlineAt: nextDeadlineAt(deadlines, now),
    postedAt: dateOrNull(std.postedAt), // (read mapper emits postedAt; keep the inverse symmetric)
    createdAt: dateOrUndef(std.createdAt), // omit → DB default now()
    updatedAt: dateOrUndef(std.updatedAt),
    typeData,
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
