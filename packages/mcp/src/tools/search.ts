/**
 * `search_opportunities` — the filtered list, projected down to what a caller needs to CHOOSE.
 *
 * THE PROJECTION IS THE CONTROL. `description` and `summary` do not appear: they are the longest
 * publisher-controlled free-text fields, they are where an instruction addressed to an agent would
 * live, and a field that is not returned cannot be acted on — a stronger property than any amount
 * of labeling. A caller who wants the prose asks for one record by id.
 *
 * `title` and organization names REMAIN and remain third-party text. That residual risk is real
 * and is not claimed away. `awardSummary`, `nextDeadline` and both URLs are rendered by this server
 * from numeric and structural fields; no publisher prose passes through them.
 */
import { z } from "zod";
import { FUNDING_TYPES, SORT_FIELDS, SORT_ORDERS, STATUSES, asEnumValues } from "../enums.js";
import type { OpportunitySummary, Paginated } from "../http.js";
import { SEARCH_NOTICE, delimit, truncate } from "../untrusted.js";
import type { ToolContext, ToolSuccess } from "./context.js";

export const TOOL_NAME = "search_opportunities";

/** How much of a title survives into a result row. */
export const TITLE_MAX = 140;

/**
 * Caps on the ecosystem list.
 *
 * `ecosystems` is a deliberately OPEN list in the standard — no registry, no enum — so a publisher
 * may put anything in it, at any length, as many times as they like. Every other third-party
 * string in this projection is bounded; leaving this one unbounded would make it the obvious place
 * to park a payload, and twenty long values across twenty rows is also just a wasted context
 * window. Values past the cap are dropped and the row says how many were dropped, rather than
 * silently showing a short list as if it were the whole one.
 */
export const ECOSYSTEM_VALUE_MAX = 40;
export const ECOSYSTEM_COUNT_MAX = 8;

/**
 * The description a client shows. Deliberately free of implementation vocabulary — a caller
 * choosing a tool needs to know what it answers, not how it is stored — and free of any imperative
 * addressed to the agent.
 */
export const TOOL_DESCRIPTION =
  "Search published funding opportunities in the Ethereum ecosystem — grants, hackathons, " +
  "bounties, accelerators, VC funds and RFPs — by keyword, funding type, status, ecosystem, " +
  "award size and deadline window. Returns a short row per match: title, organizations, award " +
  "range, next deadline and the id to pass to fetch_opportunity for the full record. Full " +
  "descriptions are not included in these results.";

export const inputSchema = z
  .strictObject({
    q: z
      .string()
      .max(200)
      .optional()
      .describe("Free-text search over title, summary and description."),
    fundingType: z
      .array(z.enum(asEnumValues(FUNDING_TYPES)))
      .optional()
      .describe(`Restrict to these funding types. One of: ${FUNDING_TYPES.join(", ")}.`),
    status: z
      .array(z.enum(asEnumValues(STATUSES)))
      .optional()
      .describe(`Restrict to these statuses. One of: ${STATUSES.join(", ")}.`),
    ecosystem: z
      .array(z.string().min(1).max(100))
      .optional()
      .describe("Ecosystem names, e.g. Optimism, Base. Values OR together."),
    category: z
      .array(z.string().min(1).max(100))
      .optional()
      .describe("Categories. Values OR together."),
    organization: z
      .string()
      .max(200)
      .optional()
      .describe("Organization slug. Matches an operating OR a sponsoring organization."),
    minAward: z.number().optional().describe("Minimum award or budget, in major currency units."),
    maxAward: z.number().optional().describe("Maximum award or budget, in major currency units."),
    deadlineAfter: z
      .string()
      .optional()
      .describe(
        "RFC 3339 instant. Only entries whose earliest upcoming fixed deadline is at or after " +
          "it. Entries with no upcoming fixed deadline (rolling programs, all-past deadlines, or " +
          "none at all) are EXCLUDED by this filter.",
      ),
    deadlineBefore: z
      .string()
      .optional()
      .describe(
        "RFC 3339 instant. Only entries whose earliest upcoming fixed deadline is at or before " +
          "it. Entries with no upcoming fixed deadline are EXCLUDED by this filter.",
      ),
    sort: z
      .enum(SORT_FIELDS)
      .optional()
      .describe(
        "Sort key; defaults to nextDeadlineAt, the earliest fixed deadline still in the future. " +
          "Entries without one sort last.",
      ),
    order: z.enum(SORT_ORDERS).optional().describe("Sort direction. Defaults to ascending."),
    page: z.number().int().min(1).optional().describe("1-based page number."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe("Results per page, 1 to 25. Defaults to 10."),
  })
  .describe("Filters for the opportunity list. Every field is optional.");

export type SearchInput = z.infer<typeof inputSchema>;

const organizationSchema = z.object({
  name: z.string().describe("Third-party text: the organization's published display name."),
  slug: z.string(),
});

const itemSchema = z.object({
  id: z.string().describe("Public id, `<namespace>:<local>`. Pass this to fetch_opportunity."),
  namespace: z.string().describe("The publishing organization's namespace — the id's prefix."),
  title: z.string().describe(`Third-party text, truncated to ${TITLE_MAX} characters.`),
  fundingType: z.string(),
  status: z.string(),
  organizations: z
    .array(organizationSchema)
    .describe("The organizations that operate the program."),
  ecosystems: z
    .array(z.string())
    .describe(
      `Third-party text, at most ${ECOSYSTEM_COUNT_MAX} values of ${ECOSYSTEM_VALUE_MAX} characters.`,
    ),
  ecosystemsOmitted: z
    .number()
    .describe("How many ecosystem values were dropped by the cap. 0 when the list is complete."),
  awardSummary: z
    .string()
    .nullable()
    .describe("Rendered here from the numeric funding fields; never publisher prose."),
  nextDeadline: z
    .string()
    .nullable()
    .describe("Earliest fixed deadline still in the future, or null when there is none."),
  applyUrl: z.string().describe("The hub's counted redirect to the application page."),
  sourceUrl: z.string().describe("The hub's counted redirect to the original listing."),
  detailHint: z.string(),
});

export const outputSchema = z.object({
  notice: z.string(),
  total: z.number().describe("Total matches. An empty result is `total === 0`; `totalPages` is 1."),
  page: z.number(),
  limit: z.number(),
  totalPages: z.number().describe("Always at least 1, even for an empty result."),
  items: z.array(itemSchema),
});

const DETAIL_HINT = "Call fetch_opportunity with this id for the full record.";

/** Arrays go as comma lists, which the API accepts for every filter. */
export function toQuery(input: SearchInput): URLSearchParams {
  const qs = new URLSearchParams();
  const set = (key: string, value: string | number | undefined) => {
    if (value !== undefined) qs.set(key, String(value));
  };
  const setList = (key: string, values: readonly string[] | undefined) => {
    if (values && values.length > 0) qs.set(key, values.join(","));
  };
  set("q", input.q);
  setList("fundingType", input.fundingType);
  setList("status", input.status);
  setList("ecosystem", input.ecosystem);
  setList("category", input.category);
  set("organization", input.organization);
  set("minAward", input.minAward);
  set("maxAward", input.maxAward);
  set("deadlineAfter", input.deadlineAfter);
  set("deadlineBefore", input.deadlineBefore);
  set("sort", input.sort);
  set("order", input.order);
  set("page", input.page);
  qs.set("limit", String(input.limit ?? 10));
  return qs;
}

type FundingInfo = OpportunitySummary["fundingInfo"];

/** Built only from numbers and a currency code. */
export function awardSummary(funding: FundingInfo): string | null {
  if (!funding) return null;
  const currency = typeof funding.currency === "string" ? funding.currency : null;
  const unit = currency ?? "(currency unstated)";
  const { minAward, maxAward, budget } = funding;
  if (typeof minAward === "number" && typeof maxAward === "number") {
    return `${minAward}–${maxAward} ${unit} per award`;
  }
  if (typeof maxAward === "number") return `up to ${maxAward} ${unit} per award`;
  if (typeof minAward === "number") return `from ${minAward} ${unit} per award`;
  if (typeof budget === "number") return `${budget} ${unit} total budget`;
  return null;
}

/** Derived, not copied: the API sorts on a denormalized column it does not publish as a field. */
export function nextDeadline(deadlines: OpportunitySummary["deadlines"], now: Date): string | null {
  if (!Array.isArray(deadlines)) return null;
  let best: { at: number; iso: string } | null = null;
  for (const deadline of deadlines) {
    if (deadline.deadlineType !== "fixed" || typeof deadline.date !== "string") continue;
    const at = Date.parse(deadline.date);
    if (!Number.isFinite(at) || at <= now.getTime()) continue;
    // INSTANTS, not strings: an offset form sorts lexicographically before an earlier UTC one.
    if (best === null || at < best.at) best = { at, iso: deadline.date };
  }
  return best?.iso ?? null;
}

/** Ids are `<namespace>:<local>`; anything else yields an empty string. */
export function namespaceOf(id: string): string {
  const at = id.indexOf(":");
  return at > 0 ? id.slice(0, at) : "";
}

/** Reports how much was dropped rather than hiding it. */
export function boundEcosystems(values: unknown): { ecosystems: string[]; omitted: number } {
  if (!Array.isArray(values)) return { ecosystems: [], omitted: 0 };
  const strings = values.filter((v): v is string => typeof v === "string");
  const kept = strings.slice(0, ECOSYSTEM_COUNT_MAX).map((v) => truncate(v, ECOSYSTEM_VALUE_MAX));
  return { ecosystems: kept, omitted: strings.length - kept.length };
}

export function project(
  page: Paginated<OpportunitySummary>,
  apiBase: string,
  now: Date,
): z.infer<typeof outputSchema> {
  return {
    notice: SEARCH_NOTICE,
    total: page.total,
    page: page.page,
    limit: page.limit,
    totalPages: page.totalPages,
    items: page.items.map((item) => ({
      id: item.id,
      namespace: namespaceOf(item.id),
      title: truncate(item.title, TITLE_MAX),
      fundingType: item.fundingType,
      status: item.status,
      organizations: item.operatingOrganizations.map((org) => ({ name: org.name, slug: org.slug })),
      ...(() => {
        const bounded = boundEcosystems(item.ecosystems);
        return { ecosystems: bounded.ecosystems, ecosystemsOmitted: bounded.omitted };
      })(),
      awardSummary: awardSummary(item.fundingInfo),
      nextDeadline: nextDeadline(item.deadlines, now),
      applyUrl: `${apiBase}/v1/r/${encodeURIComponent(item.id)}/apply`,
      sourceUrl: `${apiBase}/v1/r/${encodeURIComponent(item.id)}/source`,
      detailHint: DETAIL_HINT,
    })),
  };
}

/** Every third-party string goes inside a delimited block. */
export function renderText(result: z.infer<typeof outputSchema>): string {
  if (result.total === 0) {
    return `${result.notice}\n\nNo opportunity matches those filters.`;
  }
  const rows = result.items.map((item) => {
    const orgs = item.organizations.map((o) => `${o.name} (${o.slug})`).join(", ");
    const facts = [
      `id: ${item.id}`,
      `type: ${item.fundingType}`,
      `status: ${item.status}`,
      item.awardSummary ? `award: ${item.awardSummary}` : null,
      item.nextDeadline ? `next deadline: ${item.nextDeadline}` : "next deadline: none upcoming",
      `apply: ${item.applyUrl}`,
      `source: ${item.sourceUrl}`,
    ]
      .filter((f): f is string => f !== null)
      .join("\n  ");
    return `${delimit(`title of ${item.id}`, item.title)}\n${delimit(`organizations of ${item.id}`, orgs)}\n  ${facts}`;
  });
  return [
    result.notice,
    "",
    `${result.total} match(es); page ${result.page} of ${result.totalPages}, ${result.items.length} shown.`,
    "",
    ...rows,
    "",
    DETAIL_HINT,
  ].join("\n");
}

export async function run(input: SearchInput, ctx: ToolContext): Promise<ToolSuccess> {
  const page = await ctx.api.listOpportunities(toQuery(input));
  const projected = project(page, ctx.config.apiBase, ctx.now());
  return { text: renderText(projected), structured: projected };
}
