/**
 * PURE state → querystring for the public directory. No React, no network, so the one part of the
 * browse page that can silently break — sending a parameter the API does not accept — is unit
 * testable on its own.
 *
 * THE RULE THIS MODULE EXISTS TO KEEP: every key it can emit is a parameter `GET /v1/opportunities`
 * declares. That endpoint validates its querystring with `additionalProperties: false` and ajv's
 * `removeAdditional` disabled, so a misspelled or invented filter is a hard 400 rather than a filter
 * that quietly does nothing. Building the query in one pure function is what makes that checkable.
 *
 * The filter VALUES are read out of the Standard's own schema at module load, exactly as the API
 * reads them for the request contract. Re-typing the six funding types and four statuses here would
 * mean this dashboard could offer a filter the API answers with a 400, or omit one the API accepts,
 * and neither would show up until somebody clicked it.
 */
import { opportunitySchema } from "@the-rfp-hub/standard";
import type { DirectoryQuery } from "./api";
import type { FundingType, OpportunityStatus } from "./types";

/** The `enum` a Standard property declares. Throws at load if that property ever loses it. */
function schemaEnum(name: string): string[] {
  const properties = (opportunitySchema as { properties?: Record<string, { enum?: unknown }> })
    .properties;
  const values = properties?.[name]?.enum;
  if (!Array.isArray(values)) {
    throw new Error(`the Standard's '${name}' property declares no enum`);
  }
  return values.map(String);
}

export const FUNDING_TYPES = schemaEnum("fundingType") as FundingType[];
export const STATUSES = schemaEnum("status") as OpportunityStatus[];

/**
 * The orderings offered, as one control rather than two.
 *
 * `sort` and `order` are separate parameters on the API, but "next deadline, descending" is not a
 * question anybody asks — pairing them here means every option on screen is one somebody wants,
 * and the pair is split back apart in `directoryQuery`.
 *
 * `nextDeadlineAt` is DERIVED: the earliest fixed deadline still in the future. Entries with none —
 * rolling-only, all-past, or no deadlines at all — sort LAST on it in both directions, which is why
 * that is the default rather than a filter.
 */
export const ORDERINGS = [
  { value: "nextDeadlineAt:asc", label: "Deadline soonest" },
  { value: "postedAt:desc", label: "Recently posted" },
  { value: "updatedAt:desc", label: "Recently updated" },
] as const;

export type Ordering = (typeof ORDERINGS)[number]["value"];

/** What the filter controls hold. An empty string means "no filter", never a value sent as blank. */
export interface DirectorySelection {
  q: string;
  fundingType: string;
  status: string;
  ecosystem: string;
  ordering: Ordering;
  page: number;
}

export const DEFAULT_SELECTION: DirectorySelection = {
  q: "",
  fundingType: "",
  status: "",
  ecosystem: "",
  ordering: "nextDeadlineAt:asc",
  page: 1,
};

/** How many rows a page of the directory holds. The endpoint's own default; its maximum is 100. */
export const PAGE_SIZE = 20;

/** Trimmed, or `undefined` when the control was left empty. */
function filled(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The querystring for one selection.
 *
 * Empty controls become `undefined` and are dropped by the client rather than sent blank: the list
 * endpoint does accept an empty filter, but sending one says "the user chose nothing" in a form the
 * request log cannot distinguish from a bug.
 */
export function directoryQuery(
  selection: DirectorySelection,
  limit: number = PAGE_SIZE,
): DirectoryQuery {
  const [sort, order] = selection.ordering.split(":");
  return {
    q: filled(selection.q),
    fundingType: filled(selection.fundingType),
    status: filled(selection.status),
    ecosystem: filled(selection.ecosystem),
    sort,
    order: order === "desc" ? "desc" : "asc",
    page: selection.page,
    limit,
  };
}

/** Whether anything is filtered — decides whether an empty result reads as "none" or "none match". */
export function isFiltered(selection: DirectorySelection): boolean {
  return (
    filled(selection.q) !== undefined ||
    filled(selection.fundingType) !== undefined ||
    filled(selection.status) !== undefined ||
    filled(selection.ecosystem) !== undefined
  );
}
