/**
 * PURE mappers between DB rows and the RFP Hub Standard object — no DB access, fully unit-testable.
 *
 * - `toStandard(row, org)`  — read path (detail): full, schema-valid `Opportunity`.
 * - `toSummary(row, org)`   — read path (list): thin projection, omits the `opportunity[type]`
 *                              block + `extensions` per FIELDS.md "Delivery (API list vs detail)".
 * - `fromStandard(std)`     — write path: Standard → { org insert, opp insert } for the seed loader.
 */
import type { Funding, Opportunity, Organization, Provenance } from "@rfp-hub/standard";
import type {
  OpportunityInsert,
  OpportunityRow,
  OrganizationInsert,
  OrganizationRow,
} from "../../db/schema.js";

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
function arr(a: string[]): string[] | undefined {
  return a.length ? [...a] : undefined;
}
/** {} → undefined */
function obj<T extends Record<string, unknown>>(o: T): T | undefined {
  return Object.keys(o).length ? o : undefined;
}

function organizationOf(o: OrganizationRow): Organization {
  return compact({
    name: o.name,
    slug: o.slug,
    type: o.type ?? undefined,
    description: o.description ?? undefined,
    website: o.website ?? undefined,
    logoUrl: o.logoUrl ?? undefined,
    bannerUrl: o.bannerUrl ?? undefined,
    socialLinks: obj(o.socialLinks),
    ecosystems: arr(o.ecosystems),
  }) as Organization;
}

function sourceOf(r: OpportunityRow): Provenance {
  return compact({
    url: r.sourceUrl,
    publisher: r.sourcePublisher ?? undefined,
    submittedBy: r.sourceSubmittedBy ?? undefined,
    submittedAt: iso(r.sourceSubmittedAt),
    ingestedVia: r.ingestedVia ?? undefined,
    originalId: r.originalId ?? undefined,
    // keep an explicit `null` (= "not yet verified"); only `undefined` is dropped by compact()
    verifiedAgainstSource: r.verifiedAgainstSource,
    verifiedAt: iso(r.verifiedAt),
    snapshotUrl: r.snapshotUrl ?? undefined,
  }) as Provenance;
}

function fundingOf(r: OpportunityRow): Funding | undefined {
  const f = compact({
    currency: r.currency ?? undefined,
    minAward: num(r.minAward),
    maxAward: num(r.maxAward),
    totalBudget: num(r.totalBudget),
    amountDistributed: num(r.amountDistributed),
    awardsToDate: r.awardsToDate ?? undefined,
  });
  return Object.keys(f).length ? (f as Funding) : undefined;
}

/** Common fields shared by list and detail (everything except the type block + extensions). */
function baseOf(row: OpportunityRow, org: OrganizationRow): Record<string, unknown> {
  return compact({
    specVersion: row.specVersion,
    id: row.publicId,
    type: row.type,
    title: row.title,
    description: row.description,
    summary: row.summary ?? undefined,
    status: row.status,
    organization: organizationOf(org),
    source: sourceOf(row),
    ecosystems: arr(row.ecosystems),
    networks: arr(row.networks),
    categories: arr(row.categories),
    tags: arr(row.tags),
    applicationUrl: row.applicationUrl ?? undefined,
    website: row.website ?? undefined,
    logoUrl: row.logoUrl ?? undefined,
    bannerUrl: row.bannerUrl ?? undefined,
    socialLinks: obj(row.socialLinks),
    funding: fundingOf(row),
    opensAt: iso(row.opensAt),
    closesAt: iso(row.closesAt),
    postedAt: iso(row.postedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

/** Full, schema-valid Standard object (detail endpoint, exports, snapshots). */
export function toStandard(row: OpportunityRow, org: OrganizationRow): Opportunity {
  const out = baseOf(row, org);
  // type-specific block lives under a key equal to `type` (grant→grant, vc_fund→vc_fund, …).
  out[row.type] = row.typeData ?? {};
  const ext = obj(row.extensions);
  if (ext) out.extensions = ext;
  return out as Opportunity;
}

/** Thin list projection — omits the type block + extensions (a delivery concern, not a schema). */
export function toSummary(row: OpportunityRow, org: OrganizationRow): Opportunity {
  return baseOf(row, org) as Opportunity;
}

// ── inverse (write path) ──────────────────────────────────────────────────────────
/** opp insert minus the FK + server-side fields the seed sets itself. */
export type OpportunityInsertData = Omit<
  OpportunityInsert,
  "organizationId" | "reviewStatus" | "isListed" | "sourceSystem"
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
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "org"
  );
}

/** Standard object → DB inserts. `opp.organizationId` and server-side fields are added by the seed. */
export function fromStandard(std: Opportunity): {
  org: OrganizationInsert;
  opp: OpportunityInsertData;
} {
  const o = std.organization;
  const org: OrganizationInsert = {
    slug: o.slug ?? slugify(o.name),
    name: o.name,
    type: o.type ?? null,
    description: o.description ?? null,
    website: o.website ?? null,
    logoUrl: o.logoUrl ?? null,
    bannerUrl: o.bannerUrl ?? null,
    socialLinks: (o.socialLinks ?? {}) as Record<string, string>,
    ecosystems: o.ecosystems ?? [],
  };

  const s = std.source;
  const typeBlock = (std as Record<string, unknown>)[std.type];
  const opp: OpportunityInsertData = {
    publicId: std.id,
    specVersion: std.specVersion,
    type: std.type,
    status: std.status,
    title: std.title,
    description: std.description,
    summary: std.summary ?? null,
    applicationUrl: std.applicationUrl ?? null,
    website: std.website ?? null,
    logoUrl: std.logoUrl ?? null,
    bannerUrl: std.bannerUrl ?? null,
    socialLinks: (std.socialLinks ?? {}) as Record<string, string>,
    ecosystems: std.ecosystems ?? [],
    networks: std.networks ?? [],
    categories: std.categories ?? [],
    tags: std.tags ?? [],
    currency: std.funding?.currency ?? null,
    minAward: numStr(std.funding?.minAward),
    maxAward: numStr(std.funding?.maxAward),
    totalBudget: numStr(std.funding?.totalBudget),
    amountDistributed: numStr(std.funding?.amountDistributed),
    awardsToDate: std.funding?.awardsToDate ?? null,
    opensAt: dateOrNull(std.opensAt),
    closesAt: dateOrNull(std.closesAt),
    postedAt: dateOrNull(std.postedAt), // (read mapper emits postedAt; keep the inverse symmetric)
    createdAt: dateOrUndef(std.createdAt), // omit → DB default now()
    updatedAt: dateOrUndef(std.updatedAt),
    typeData: (typeBlock as Record<string, unknown>) ?? {},
    extensions: std.extensions ?? {},
    sourceUrl: s.url,
    sourcePublisher: s.publisher ?? null,
    sourceSubmittedBy: s.submittedBy ?? null,
    sourceSubmittedAt: dateOrNull(s.submittedAt),
    ingestedVia: s.ingestedVia ?? null,
    originalId: s.originalId ?? null,
    verifiedAgainstSource: s.verifiedAgainstSource ?? null,
    verifiedAt: dateOrNull(s.verifiedAt),
    snapshotUrl: s.snapshotUrl ?? null,
  };

  return { org, opp };
}
