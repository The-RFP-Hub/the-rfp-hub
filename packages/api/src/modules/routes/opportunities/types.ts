/**
 * PURE query-string parsing/normalization for the list endpoint — no Fastify/DB deps, unit-tested.
 *
 * `listQuerySchema` (below) is the authoritative contract: Fastify validates the querystring first,
 * so unknown params (additionalProperties:false), out-of-enum `sort`/`order` and malformed
 * `deadlineAfter`/`deadlineBefore` instants are rejected with 400 before this parser runs. The
 * parser normalizes schema-permitted inputs (splitting comma lists, trimming, de-duping, coercing
 * numbers/dates) and whitelists the free-text list params (fundingType/status) — for those the
 * whitelist IS the filter. Its sort/order fallbacks are a defensive default for non-HTTP callers,
 * not a "forgiving" HTTP behaviour.
 */
import type { FundingType, OpportunityStatus } from "@rfp-hub/standard";
import type {
  OpportunityQuery,
  SortField,
} from "../../services/opportunities/opportunity.service.js";

// Values may already be coerced (numbers) by the Fastify querystring schema below.
export type RawQuery = Record<string, unknown>;

const FUNDING_TYPES: FundingType[] = [
  "grant",
  "hackathon",
  "bounty",
  "accelerator",
  "vc_fund",
  "rfp",
];
const STATUSES: OpportunityStatus[] = ["upcoming", "open", "closed", "archived"];
const SORT_FIELDS: SortField[] = [
  "nextDeadlineAt",
  "opensAt",
  "postedAt",
  "updatedAt",
  "createdAt",
];

/**
 * Records with no next fixed deadline — rolling-only, all-past, or no `deadlines[]` at all — have
 * a NULL `nextDeadlineAt`. Repeated verbatim on every parameter that touches it.
 */
const ROLLING_NOTE =
  "Records with no upcoming fixed deadline (rolling-only programs, all-past deadlines, or none at all) have a null nextDeadlineAt: they sort LAST and are EXCLUDED by this filter.";

/** Split a repeated or comma-separated param into a clean string list (`undefined` if empty). */
function list(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const parts = Array.isArray(v) ? v : [v];
  const raw = parts.flatMap((s) => String(s).split(","));
  const items = [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
  return items.length ? items : undefined;
}

function str(v: unknown): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s === "number") return Number.isFinite(s) ? String(s) : undefined;
  if (typeof s !== "string") return undefined;
  const trimmed = s.trim();
  return trimmed ? trimmed : undefined;
}

function nbr(v: unknown): number | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s === "number") return Number.isFinite(s) ? s : undefined;
  const text = str(s);
  if (text === undefined) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/** RFC 3339 instant → Date; `undefined` when absent or unparseable (HTTP 400s first). */
function date(v: unknown): Date | undefined {
  const text = str(v);
  if (text === undefined) return undefined;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function parseOpportunityQuery(raw: RawQuery): OpportunityQuery {
  const fundingType = list(raw.fundingType)?.filter((t): t is FundingType =>
    (FUNDING_TYPES as string[]).includes(t),
  );
  const status = list(raw.status)?.filter((s): s is OpportunityStatus =>
    (STATUSES as string[]).includes(s),
  );

  const sortRaw = str(raw.sort);
  const sort: SortField =
    sortRaw && (SORT_FIELDS as string[]).includes(sortRaw)
      ? (sortRaw as SortField)
      : "nextDeadlineAt";
  const order: "asc" | "desc" = str(raw.order) === "desc" ? "desc" : "asc";

  return {
    fundingType: fundingType?.length ? fundingType : undefined,
    status: status?.length ? status : undefined,
    ecosystem: list(raw.ecosystem),
    network: list(raw.network),
    category: list(raw.category),
    tag: list(raw.tag),
    organization: str(raw.organization),
    minAward: nbr(raw.minAward),
    maxAward: nbr(raw.maxAward),
    deadlineAfter: date(raw.deadlineAfter),
    deadlineBefore: date(raw.deadlineBefore),
    q: str(raw.q),
    sort,
    order,
    page: nbr(raw.page) ?? 1,
    limit: nbr(raw.limit) ?? 20,
  };
}

/** JSON Schema for the list querystring — drives request coercion + the OpenAPI/Swagger docs. */
export const listQuerySchema = {
  type: "object",
  properties: {
    fundingType: {
      type: "string",
      description: "Comma-separated: grant,hackathon,bounty,accelerator,vc_fund,rfp",
    },
    status: { type: "string", description: "Comma-separated: upcoming,open,closed,archived" },
    ecosystem: {
      type: "string",
      description: "Comma-separated ecosystem names (e.g. Optimism,Base)",
    },
    network: { type: "string", description: "Comma-separated network names" },
    category: { type: "string", description: "Comma-separated categories" },
    tag: { type: "string", description: "Comma-separated tags" },
    organization: {
      type: "string",
      description:
        "Sponsoring-organization slug. Matches ANY entry in sponsoringOrganizations (not only the primary [0] one); organizations that publish no slug are matched on a slug derived from their name. operatingOrganizations are NOT matched.",
    },
    minAward: { type: "number", description: "Min award/budget in major units" },
    maxAward: { type: "number", description: "Max award/budget in major units" },
    deadlineAfter: {
      type: "string",
      format: "date-time",
      description: `Only opportunities whose nextDeadlineAt (earliest upcoming fixed deadline) is at or after this RFC 3339 instant. ${ROLLING_NOTE}`,
    },
    deadlineBefore: {
      type: "string",
      format: "date-time",
      description: `Only opportunities whose nextDeadlineAt (earliest upcoming fixed deadline) is at or before this RFC 3339 instant. ${ROLLING_NOTE}`,
    },
    q: { type: "string", description: "Full-text-ish search over title, summary and description" },
    sort: {
      type: "string",
      enum: SORT_FIELDS,
      default: "nextDeadlineAt",
      description: `Sort key. nextDeadlineAt is DERIVED from deadlines[] — the earliest fixed deadline still in the future. ${ROLLING_NOTE}`,
    },
    order: { type: "string", enum: ["asc", "desc"], default: "asc" },
    page: { type: "integer", minimum: 1, default: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
  additionalProperties: false,
} as const;
