/**
 * Zero-dependency TypeScript client for the RFP Hub public /v1/ API.
 *
 * Uses only Node's built-in `fetch` — no HTTP library. The `@the-rfp-hub/standard` import below is
 * type-only (erased at run time): it demonstrates that the detail endpoint returns a real
 * `Opportunity` from the standard's generated types, it is not a runtime dependency. That makes
 * this file a type-contract demo as much as a client — if the published standard and this
 * consumer's usage ever disagreed, `npm run typecheck` would say so.
 *
 * IMPORTING THIS FILE RUNS NOTHING. The demo at the bottom is behind an entrypoint guard, so
 * `import { listOpportunities } from "./index.js"` performs no I/O; only running the file
 * directly (`npm start`) makes requests. Every type and function this file defines is exported.
 *
 * Run: `npm start` (Node 22.18+ strips the types natively). See ./README.md.
 */
import { fileURLToPath } from "node:url";
import type { Opportunity } from "@the-rfp-hub/standard";

const BASE_URL = process.env.RFPHUB_API_BASE ?? "http://localhost:3001";

/** Strip the generated type's `[k: string]: unknown` index signature so Omit can drop named keys. */
type RemoveIndex<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/**
 * The list endpoint's thin projection: a full `Opportunity` minus `fundingDetails`.
 *
 * The re-cut replaced the six per-type blocks (`grant`/`hackathon`/…) with ONE tagged union slot,
 * so there is exactly one key to omit here. Fetch the detail endpoint (`getOpportunity` below) to
 * get it, and switch on its own `fundingType` tag to narrow the union.
 */
export type OpportunitySummary = Omit<RemoveIndex<Opportunity>, "fundingDetails">;

/** The list envelope. */
export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** The /v1/stats payload. */
export interface Stats {
  total: number;
  byFundingType: Record<string, number>;
  byStatus: Record<string, number>;
  topEcosystems: { ecosystem: string; count: number }[];
  lastUpdatedAt: string | null;
}

/**
 * Every filter/sort/pagination param the list endpoint accepts (all optional).
 *
 * This is the COMPLETE set, and the API's query contract is STRICT: a parameter it does not
 * define — a typo, or a filter from an older version of the API — is rejected with `400
 * bad_request`, as is an out-of-enum `fundingType`, `status`, `sort` or `order`. Nothing is
 * silently ignored, so a mistyped filter fails loudly instead of returning the entire unfiltered
 * dataset with a 200. An explicitly empty value (`fundingType: []`) is the one thing that is
 * accepted and ignored, so a client that always emits every key need not strip the blank ones.
 *
 * `organization` takes an organization slug and matches either organization role.
 */
export interface ListOpportunitiesParams {
  fundingType?: ("grant" | "hackathon" | "bounty" | "accelerator" | "vc_fund" | "rfp")[];
  status?: ("upcoming" | "open" | "closed" | "archived")[];
  ecosystem?: string[];
  category?: string[];
  organization?: string;
  minAward?: number;
  maxAward?: number;
  deadlineAfter?: string;
  deadlineBefore?: string;
  q?: string;
  sort?: "nextDeadlineAt" | "opensAt" | "postedAt" | "updatedAt" | "createdAt";
  order?: "asc" | "desc";
  page?: number;
  limit?: number;
}

/** The API's error envelope: every 400/404/500 carries a stable machine-readable `error` code. */
export interface ApiError {
  error: string;
  message: string;
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`);
  } catch (cause) {
    throw new Error(
      `Could not reach the RFP Hub API at ${BASE_URL}${path}. Is it running? ` +
        "See ../../packages/api/README.md to start it locally (Postgres + migrate + seed).",
      { cause },
    );
  }
  if (!res.ok) {
    // Read the body ONCE. `res.json()` consumes it even when it then rejects on non-JSON, so a
    // `res.text()` fallback would throw "Body is unusable" and bury the actual HTTP error —
    // which is exactly the case that matters, e.g. a proxy returning an HTML 502.
    const raw = await res.text().catch(() => "");
    let detail = raw || "(empty body)";
    try {
      const body = JSON.parse(raw) as ApiError;
      if (body?.error) detail = `${body.error}: ${body.message}`;
    } catch {
      // Not the API's JSON envelope — keep the raw text.
    }
    throw new Error(`${res.status} ${res.statusText} from ${path} — ${detail}`);
  }
  return res.json() as Promise<T>;
}

/** GET /v1/opportunities — filtered, sorted, paginated thin list. */
export async function listOpportunities(
  params: ListOpportunitiesParams = {},
): Promise<Paginated<OpportunitySummary>> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    qs.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const query = qs.toString();
  return getJson(`/v1/opportunities${query ? `?${query}` : ""}`);
}

/** GET /v1/opportunities/:id — full Standard object, or throws on 404. */
export async function getOpportunity(id: string): Promise<Opportunity> {
  return getJson(`/v1/opportunities/${encodeURIComponent(id)}`);
}

/** GET /v1/stats — dataset totals and breakdowns. */
export async function getStats(): Promise<Stats> {
  return getJson("/v1/stats");
}

/**
 * The display organization is `operatingOrganizations[0]` — the party that actually runs the
 * intake. Array order is semantic, and sponsors are a SEPARATE role: an entry may have a sponsor,
 * several, or none, and a sponsor is never the one to display.
 */
export function displayOrg(o: OpportunitySummary): string {
  return o.operatingOrganizations[0].name;
}

/**
 * One currency per document denominates every amount in it, so it prints once alongside them.
 * `currency` is `string | null | undefined` in the Standard, so `??` (not `||` on a lookup default)
 * is what makes an explicit null print the placeholder.
 */
export function money(o: OpportunitySummary): string {
  const f = o.fundingInfo;
  if (!f) return "(no funding info)";
  const currency = f.currency ?? "?";
  if (f.minAward != null && f.maxAward != null) {
    return `${f.minAward}–${f.maxAward} ${currency}`;
  }
  if (f.budget != null) return `${f.budget} ${currency} budget`;
  return `(${currency})`;
}

/** Print one `fundingDetails` payload, handling all six shapes the union can take. */
function describeFundingDetails(details: Opportunity["fundingDetails"]): string {
  switch (details.fundingType) {
    case "grant":
      return `grant, milestone-based: ${details.milestoneBased ?? "unstated"}`;
    case "hackathon":
      return `hackathon, location: ${details.location ?? "online-only"}`;
    case "bounty":
      return `bounty, reward: ${details.reward}`;
    case "accelerator":
      return `accelerator, ${details.programDurationWeeks ?? "?"} weeks, equity: ${details.equity ?? "unstated"}`;
    case "vc_fund":
      return `vc_fund, check size: ${details.checkSize?.min ?? "?"}–${details.checkSize?.max ?? "?"}`;
    case "rfp":
      return `rfp, ${details.requirements?.length ?? 0} stated requirement(s)`;
    default: {
      // Every member of the union is handled above, so `details` is `never` here. This assignment
      // is what makes the switch EXHAUSTIVE rather than merely narrowing: if the Standard ever
      // adds a seventh fundingType, this line stops compiling.
      const unhandled: never = details;
      throw new Error(`unhandled fundingDetails: ${JSON.stringify(unhandled)}`);
    }
  }
}

async function main() {
  console.log(`Talking to ${BASE_URL} ...\n`);

  console.log("-- list: open grants on Optimism, soonest deadline first --");
  const list = await listOpportunities({
    fundingType: ["grant"],
    status: ["open"],
    ecosystem: ["Optimism"],
    sort: "nextDeadlineAt",
    order: "asc",
    limit: 5,
  });
  console.log(
    `${list.total} total match, showing ${list.items.length} (page ${list.page}/${list.totalPages})`,
  );
  for (const o of list.items) {
    console.log(`  ${o.id}  ${o.title}  [${displayOrg(o)}]  ${money(o)}`);
  }

  const firstId = list.items[0]?.id;
  if (firstId) {
    console.log(`\n-- detail: ${firstId} --`);
    const detail = await getOpportunity(firstId);
    console.log(`  title:  ${detail.title}`);
    console.log(`  status: ${detail.status}`);
    console.log(`  applicationUrl: ${detail.applicationUrl ?? "(none)"}`);
    // fundingDetails is the one field the list projection omits, and its own tag equals the
    // top-level fundingType.
    console.log(`  ${describeFundingDetails(detail.fundingDetails)}`);
  }

  console.log("\n-- stats --");
  const stats = await getStats();
  console.log(`  total: ${stats.total}`);
  console.log("  byFundingType:", stats.byFundingType);
}

// Entrypoint guard: the demo runs only when this file is executed directly, never on import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
