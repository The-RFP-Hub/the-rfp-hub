/**
 * PURE query-string parsing/normalization for the list endpoint — no Fastify/DB deps, unit-tested.
 *
 * `listQuerySchema` (below) is the authoritative contract and it is STRICT: Fastify validates the
 * querystring first, so unknown params (additionalProperties:false, with ajv `removeAdditional`
 * disabled in buildApp so they are rejected rather than stripped), out-of-enum `fundingType` /
 * `status` / `sort` / `order` values and malformed `deadlineAfter`/`deadlineBefore` instants all
 * return 400 before this parser runs — nothing is silently ignored.
 *
 * The parser therefore only normalizes already-valid input (splitting comma lists, trimming,
 * de-duping, coercing numbers/dates). Its enum whitelisting and sort/order fallbacks are a
 * defensive default for direct, non-HTTP callers, not a "forgiving" HTTP behaviour.
 */
import type { FundingType, OpportunityStatus } from "@the-rfp-hub/standard";
import { standardEnum } from "../../../openapi/standard.js";
import type {
  OpportunityQuery,
  SortField,
} from "../../services/opportunities/opportunity.service.js";

// Values may already be coerced (numbers) by the Fastify querystring schema below.
export type RawQuery = Record<string, unknown>;

/**
 * The REQUEST contract's enums are read out of `@the-rfp-hub/standard` at module load, exactly
 * like the response components (src/openapi/standard.ts). These two are the only value sets whose
 * drift is visible to a client as a hard 400, so re-typing them here would mean the API could
 * publish a `fundingType` in its own OpenAPI document and then reject it as a filter.
 */
const FUNDING_TYPES = standardEnum("fundingType") as FundingType[];
const STATUSES = standardEnum("status") as OpportunityStatus[];
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

/**
 * Every list filter accepts BOTH wire forms and they compose: repeat the parameter
 * (`?tag=a&tag=b`), comma-separate it (`?tag=a,b`), or mix the two. Repeated in every list
 * parameter's description so the OpenAPI docs state it at the point of use.
 */
const LIST_NOTE = "Repeat the parameter and/or comma-separate values; both forms OR together.";

/**
 * ajv `pattern` accepting one value, or a comma-separated list of values, from a fixed set. Used
 * instead of `enum` because these parameters carry a comma list — the pattern is what makes an
 * out-of-set value a 400, and it is also what publishes the accepted values in the OpenAPI docs.
 * Surrounding whitespace is tolerated to match what `list()` below trims off.
 *
 * An EMPTY value (`?fundingType=`) matches too, and is then dropped by `list()`. Query builders,
 * HTML forms and dashboard filter UIs routinely emit every key with the unselected ones blank, and
 * every other list filter (`ecosystem`, `tag`, `q`, …) accepts that; rejecting it here alone would
 * make the same request 400 or 200 depending on which filter the user left empty.
 */
function commaListPattern(values: readonly string[]): string {
  const one = `\\s*(?:${values.join("|")})\\s*`;
  return `^(?:\\s*|${one}(?:,${one})*)$`;
}

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
  // Over HTTP an out-of-enum value already 400'd against listQuerySchema; the whitelists below
  // only guard direct (non-HTTP) callers, exactly like the sort/order fallbacks further down.
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

/**
 * JSON Schema for the list querystring — drives request validation/coercion + the OpenAPI docs.
 * List parameters are typed `array` so a repeated parameter validates; Fastify's ajv runs with
 * `coerceTypes: 'array'`, so a single occurrence is coerced to a one-element array.
 */
export const listQuerySchema = {
  type: "object",
  properties: {
    fundingType: {
      type: "array",
      items: { type: "string", pattern: commaListPattern(FUNDING_TYPES) },
      description: `Filter by funding type. Accepted values: ${FUNDING_TYPES.join(", ")}. ${LIST_NOTE} Any other value is rejected with 400 — it is never silently ignored.`,
    },
    status: {
      type: "array",
      items: { type: "string", pattern: commaListPattern(STATUSES) },
      description: `Filter by status. Accepted values: ${STATUSES.join(", ")}. ${LIST_NOTE} Any other value is rejected with 400 — it is never silently ignored.`,
    },
    ecosystem: {
      type: "array",
      items: { type: "string" },
      description: `Ecosystem names, e.g. Optimism,Base. ${LIST_NOTE}`,
    },
    network: {
      type: "array",
      items: { type: "string" },
      description: `Network names. ${LIST_NOTE}`,
    },
    category: {
      type: "array",
      items: { type: "string" },
      description: `Categories. ${LIST_NOTE}`,
    },
    tag: { type: "array", items: { type: "string" }, description: `Tags. ${LIST_NOTE}` },
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
  // Enforced (not stripped): buildApp disables ajv's `removeAdditional`, so an unknown or
  // misspelled parameter is a 400 instead of a filter that silently does nothing.
  additionalProperties: false,
} as const;
