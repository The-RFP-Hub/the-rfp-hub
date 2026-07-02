/**
 * PURE query-string parsing/normalization for the list endpoint — no Fastify/DB deps, unit-tested.
 *
 * `listQuerySchema` (below) is the authoritative contract: Fastify validates the querystring first,
 * so unknown params (additionalProperties:false) and out-of-enum `sort`/`order` are rejected with
 * 400 before this parser runs. The parser normalizes schema-permitted inputs (splitting comma
 * lists, trimming, de-duping, coercing numbers) and whitelists the free-text list params
 * (type/status) — for those the whitelist IS the filter. Its sort/order fallbacks are a defensive
 * default for non-HTTP callers, not a "forgiving" HTTP behaviour.
 */
import type { OpportunityStatus, OpportunityType } from "@rfp-hub/standard";
import type { OpportunityQuery, SortField } from "../../controller/Opportunity.controller.js";

// Values may already be coerced (numbers) by the Fastify querystring schema below.
export type RawQuery = Record<string, unknown>;

const TYPES: OpportunityType[] = ["grant", "hackathon", "bounty", "accelerator", "vc_fund", "rfp"];
const STATUSES: OpportunityStatus[] = ["upcoming", "open", "closed", "archived"];
const SORT_FIELDS: SortField[] = ["closesAt", "opensAt", "postedAt", "updatedAt", "createdAt"];

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

export function parseOpportunityQuery(raw: RawQuery): OpportunityQuery {
  const type = list(raw.type)?.filter((t): t is OpportunityType => (TYPES as string[]).includes(t));
  const status = list(raw.status)?.filter((s): s is OpportunityStatus =>
    (STATUSES as string[]).includes(s),
  );

  const sortRaw = str(raw.sort);
  const sort: SortField =
    sortRaw && (SORT_FIELDS as string[]).includes(sortRaw) ? (sortRaw as SortField) : "closesAt";
  const order: "asc" | "desc" = str(raw.order) === "desc" ? "desc" : "asc";

  return {
    type: type?.length ? type : undefined,
    status: status?.length ? status : undefined,
    ecosystem: list(raw.ecosystem),
    network: list(raw.network),
    category: list(raw.category),
    tag: list(raw.tag),
    organization: str(raw.organization),
    minAward: nbr(raw.minAward),
    maxAward: nbr(raw.maxAward),
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
    type: {
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
    organization: { type: "string", description: "Organization slug" },
    minAward: { type: "number", description: "Min award/budget in major units" },
    maxAward: { type: "number", description: "Max award/budget in major units" },
    q: { type: "string", description: "Full-text-ish search over title, summary and description" },
    sort: { type: "string", enum: SORT_FIELDS, default: "closesAt" },
    order: { type: "string", enum: ["asc", "desc"], default: "asc" },
    page: { type: "integer", minimum: 1, default: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
  additionalProperties: false,
} as const;
