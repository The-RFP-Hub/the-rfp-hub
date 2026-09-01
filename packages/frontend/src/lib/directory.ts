/**
 * PURE state → querystring for the public directory, and back. No React, no network, so the two
 * parts of the browse page that can silently break — sending a parameter the API does not accept,
 * and losing the reader's filters on a back button — are unit testable on their own.
 *
 * THE RULE THIS MODULE EXISTS TO KEEP: every key it can emit is a parameter `GET /v1/opportunities`
 * declares. That endpoint validates its querystring with `additionalProperties: false` and ajv's
 * `removeAdditional` disabled, so a misspelled or invented filter is a hard 400 rather than a filter
 * that quietly does nothing. Building the query in one pure function is what makes that checkable.
 *
 * The filter VALUES are read out of the Standard's own schema at module load, exactly as the API
 * reads them for the request contract. Re-typing the six funding types and four statuses here would
 * mean this frontend could offer a filter the API answers with a 400, or omit one the API accepts,
 * and neither would show up until somebody clicked it.
 *
 * TWO DIFFERENT QUERYSTRINGS LIVE HERE and they are not the same thing:
 *
 *   `directoryQuery`  — what goes to the API. Its keys are the endpoint's parameters.
 *   `selectionToParams` / `selectionFromParams` — what goes in the BROWSER'S address bar. Its keys
 *     are short and readable because a person reads and shares them, and it omits anything at its
 *     default so that the front page's URL is `/` rather than `/?status=open&sort=…&page=1`.
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

const schemaFundingTypes = schemaEnum("fundingType");

export const FUNDING_TYPES = [
  ...schemaFundingTypes.filter((value) => value === "rfp"),
  ...schemaFundingTypes.filter((value) => value !== "rfp"),
] as FundingType[];
export const STATUSES = schemaEnum("status") as OpportunityStatus[];

/**
 * A starting list of ecosystems, offered as SUGGESTIONS rather than as the permitted set.
 *
 * `ecosystems[]` is free text in the Standard and always will be: it is what a publisher called
 * their own ecosystem, and a fixed vocabulary would either reject a real answer or quietly rewrite
 * it. But a bare text box asks a reader to guess the exact spelling a stranger used, which is why
 * the control is a `<datalist>` — type anything, or pick one of these.
 *
 * The list is a convenience and is allowed to be incomplete. It is NOT a claim about which
 * ecosystems the Hub covers, and nothing is filtered out for being absent from it.
 */
export const SUGGESTED_ECOSYSTEMS = [
  "Ethereum",
  "Arbitrum",
  "Base",
  "Celo",
  "Filecoin",
  "Gnosis Chain",
  "Linea",
  "Mantle",
  "Optimism",
  "Polygon",
  "Scroll",
  "Starknet",
  "The Graph",
  "ZKsync Era",
] as const;

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
  { value: "nextDeadlineAt:asc", label: "Next deadline" },
  { value: "postedAt:desc", label: "Recently posted" },
  { value: "updatedAt:desc", label: "Recently updated" },
] as const;

export type Ordering = (typeof ORDERINGS)[number]["value"];

const ORDERING_VALUES = new Set<string>(ORDERINGS.map((option) => option.value));

/** What the filter controls hold. An empty string means "no filter", never a value sent as blank. */
export interface DirectorySelection {
  q: string;
  fundingType: string;
  status: string;
  ecosystem: string;
  /** Free text, same shape as `ecosystem` — `categories[]` is not a closed vocabulary either. */
  category: string;
  /** An organization SLUG. Matches any operating OR sponsoring organization — see the field's hint. */
  organization: string;
  /** The control's raw text, so an in-progress edit ("1" before "1500") never round-trips a parse. */
  minAward: string;
  maxAward: string;
  /** The `<input type="date">` value, `YYYY-MM-DD`. `directoryQuery` widens it to an RFC 3339
   *  instant, once, rather than in every place that reads or writes this field. */
  deadlineAfter: string;
  deadlineBefore: string;
  ordering: Ordering;
  page: number;
}

/**
 * THE DIRECTORY OPENS ON OPEN OPPORTUNITIES, and the control says so.
 *
 * Roughly one listing in eight here is closed or archived, and a reader arriving at a public
 * register of funding is looking for something they can still apply to — a first page whose top row
 * is a program that shut in June is a first page that has wasted their most attentive thirty
 * seconds. So the default narrows, and two things make that honest rather than a hidden filter:
 * the Status control is rendered holding `open` (never blank), and the count line carries a
 * one-click way to see everything. A default that a reader cannot see and cannot undo would be the
 * dishonest version of this.
 */
export const DEFAULT_SELECTION: DirectorySelection = {
  q: "",
  fundingType: "",
  status: "open",
  ecosystem: "",
  category: "",
  organization: "",
  minAward: "",
  maxAward: "",
  deadlineAfter: "",
  deadlineBefore: "",
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

/** A number control's raw text as a finite number, or `undefined` when it is neither. */
function finiteNumber(value: string): number | undefined {
  const text = filled(value);
  if (text === undefined) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/** Not a finite number? FORWARDED AS TYPED, so the endpoint answers a 400 naming the parameter.
 *  Dropping it left the address bar advertising a filter the request never carried. */
function awardParam(value: string): number | string | undefined {
  return finiteNumber(value) ?? filled(value);
}

/** A number input renders BLANK for `?minAward=abc` (and `1e400`, which is `Infinity`), so an
 *  active filter would look like none; the DirectoryList shows the literal value as text instead. */
export function awardInputValue(value: string): string {
  const text = value.trim();
  return finiteNumber(text) === undefined ? "" : text;
}

/** `YYYY-MM-DD` (what `<input type="date">` holds) → `date`; anything already an instant. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** BOTH ENDS ARE INCLUSIVE OF THEIR DAY, so the day widens to its first or last instant rather
 *  than to midnight for both. A value that is not a bare date passes through for the endpoint. */
function instant(value: string, edge: "start" | "end"): string | undefined {
  const text = filled(value);
  if (text === undefined) return undefined;
  if (!DATE_ONLY.test(text)) return text;
  return edge === "start" ? `${text}T00:00:00.000Z` : `${text}T23:59:59.999Z`;
}

/** A DISPLAY VALUE ONLY: the picker renders blank for a full instant, so the day is extracted for
 *  it while `directoryQuery` keeps reading the raw field — a link's time of day is never lost. */
export function dateInputValue(value: string): string {
  const trimmed = value.trim();
  if (DATE_ONLY.test(trimmed)) return trimmed;
  const match = /^(\d{4}-\d{2}-\d{2})T/.exec(trimmed);
  return match?.[1] ?? "";
}

/** How much of a raw, retained URL value the "exact value from the link" hint will ever show. */
export const RETAINED_VALUE_DISPLAY_LIMIT = 200;

/** A query parameter has no length limit of its own. Bounding it where the URL BECOMES the
 *  selection keeps control, address bar and request agreeing on one value. */
export const FREE_TEXT_FILTER_LIMIT = 200;

/** Bounds a reader-supplied URL value on its way to the DOM. A display concern only: the full
 *  value is still what reaches the endpoint. */
export function truncateForDisplay(
  value: string,
  limit: number = RETAINED_VALUE_DISPLAY_LIMIT,
): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** An inverted range can never match, so "nothing matches those filters" — a claim about the
 *  corpus — is the wrong sentence. `organization` takes a slug, which only the placeholder said. */
export function emptyResultHints(selection: DirectorySelection): string[] {
  const hints: string[] = [];

  const min = finiteNumber(selection.minAward);
  const max = finiteNumber(selection.maxAward);
  if (min !== undefined && max !== undefined && min > max) {
    hints.push("Your minimum award is above your maximum, so nothing can match.");
  }

  const after = Date.parse(instant(selection.deadlineAfter, "start") ?? "");
  const before = Date.parse(instant(selection.deadlineBefore, "end") ?? "");
  if (!Number.isNaN(after) && !Number.isNaN(before) && after > before) {
    hints.push("Your deadline range runs backwards: the after date is later than the before date.");
  }

  if (filled(selection.organization) !== undefined) {
    hints.push("Organization takes an organization slug, such as acme, not its display name.");
  }

  return hints;
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
    category: filled(selection.category),
    organization: filled(selection.organization),
    minAward: awardParam(selection.minAward),
    maxAward: awardParam(selection.maxAward),
    deadlineAfter: instant(selection.deadlineAfter, "start"),
    deadlineBefore: instant(selection.deadlineBefore, "end"),
    sort,
    order: order === "desc" ? "desc" : "asc",
    page: selection.page,
    limit,
  };
}

/** Whether anything is narrowing the list — decides whether an empty result reads as "none" or "none match". */
export function isFiltered(selection: DirectorySelection): boolean {
  return (
    filled(selection.q) !== undefined ||
    filled(selection.fundingType) !== undefined ||
    filled(selection.status) !== undefined ||
    filled(selection.ecosystem) !== undefined ||
    filled(selection.category) !== undefined ||
    filled(selection.organization) !== undefined ||
    filled(selection.minAward) !== undefined ||
    filled(selection.maxAward) !== undefined ||
    filled(selection.deadlineAfter) !== undefined ||
    filled(selection.deadlineBefore) !== undefined
  );
}

/**
 * THE ADDRESS BAR IS THE FILTER STATE, and this pair is what makes that true.
 *
 * Three things were broken while the selection lived only in React state, and all three are the
 * same bug: a reader who filtered to open grants on Optimism, opened one, and pressed Back landed
 * on an unfiltered first page; a reader who wanted to send a colleague "these four" had nothing to
 * send; and a reload lost the lot. Round-tripping through `searchParams` fixes all three at once
 * and costs one `router.replace`.
 *
 * `status=any` IS A REAL VALUE IN THE URL, and it has to be. The selection's empty string means
 * "every status", but the DEFAULT is `open` — so an absent `status` parameter cannot mean "empty"
 * or the "Include closed and upcoming" link would be unlinkable and unbookmarkable. Absent means
 * default; `any` means the reader turned the filter off on purpose.
 */
export const ANY_STATUS = "any";

/** Parse whatever is in the address bar, falling back to the default for anything unrecognized. */
export function selectionFromParams(params: URLSearchParams): DirectorySelection {
  const get = (key: string) => params.get(key)?.trim() ?? "";
  const getBounded = (key: string) => get(key).slice(0, FREE_TEXT_FILTER_LIMIT);

  const status = get("status");
  const fundingType = get("type");
  const ordering = get("sort");
  const rawPage = get("page");
  const page = /^\d+$/.test(rawPage) ? Number(rawPage) : Number.NaN;
  // Keep both the page and the offset that the API will derive from it exact. Apart from accepting
  // prefixes such as `2junk`, `parseInt` rounds oversized URL values; PostgreSQL then receives an
  // OFFSET outside its integer range and the public directory renders a 500 error panel.
  const safePage =
    Number.isSafeInteger(page) && page > 1 && (page - 1) * PAGE_SIZE <= Number.MAX_SAFE_INTEGER
      ? page
      : 1;

  return {
    q: get("q"),
    // An unknown value is DROPPED rather than forwarded. The API would answer a 400 for it, and a
    // hand-edited URL should land the reader on the directory, not on an error panel.
    fundingType: (FUNDING_TYPES as readonly string[]).includes(fundingType) ? fundingType : "",
    status:
      status === ANY_STATUS
        ? ""
        : (STATUSES as readonly string[]).includes(status)
          ? status
          : DEFAULT_SELECTION.status,
    ecosystem: get("ecosystem"),
    // Free text on the API side too, so passed straight through: a rejected value becomes the 400
    // this page renders. `organization` is also the param a `/publishers` card links here with.
    category: getBounded("category"),
    organization: getBounded("organization"),
    minAward: get("minAward"),
    maxAward: get("maxAward"),
    deadlineAfter: get("deadlineAfter"),
    deadlineBefore: get("deadlineBefore"),
    ordering: ORDERING_VALUES.has(ordering) ? (ordering as Ordering) : DEFAULT_SELECTION.ordering,
    page: safePage,
  };
}

/**
 * The selection as the address bar should hold it: nothing at its default, so the front page keeps
 * a clean URL and a shared link contains only what the sender actually chose.
 */
export function selectionToParams(selection: DirectorySelection): URLSearchParams {
  const params = new URLSearchParams();
  const q = filled(selection.q);
  if (q) params.set("q", q);
  const ecosystem = filled(selection.ecosystem);
  if (ecosystem) params.set("ecosystem", ecosystem);
  const category = filled(selection.category);
  if (category) params.set("category", category);
  const organization = filled(selection.organization);
  if (organization) params.set("organization", organization);
  const minAward = filled(selection.minAward);
  if (minAward) params.set("minAward", minAward);
  const maxAward = filled(selection.maxAward);
  if (maxAward) params.set("maxAward", maxAward);
  const deadlineAfter = filled(selection.deadlineAfter);
  if (deadlineAfter) params.set("deadlineAfter", deadlineAfter);
  const deadlineBefore = filled(selection.deadlineBefore);
  if (deadlineBefore) params.set("deadlineBefore", deadlineBefore);
  if (selection.fundingType) params.set("type", selection.fundingType);
  if (selection.status !== DEFAULT_SELECTION.status) {
    params.set("status", selection.status === "" ? ANY_STATUS : selection.status);
  }
  if (selection.ordering !== DEFAULT_SELECTION.ordering) params.set("sort", selection.ordering);
  if (selection.page > 1) params.set("page", String(selection.page));
  return params;
}

/** The path plus querystring for a selection — what `router.replace` and a shared link both want. */
export function selectionToHref(selection: DirectorySelection, path = "/"): string {
  const query = selectionToParams(selection).toString();
  return query ? `${path}?${query}` : path;
}
