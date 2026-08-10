/**
 * Zero-dependency TypeScript client for the RFP Hub public /v1/ API.
 *
 * Uses only Node 18+'s built-in `fetch` — no HTTP library. The `@the-rfp-hub/standard` import
 * below is type-only (erased at build/run time): it demonstrates that the detail endpoint returns
 * a real `Opportunity` from the standard's generated types, it is not a runtime dependency. That
 * makes this file a type-contract demo as much as a client — if the API and the published standard
 * ever disagreed, `npm run typecheck` would say so.
 *
 * Run: `npm install && npm start` (or `npx tsx index.ts`). See ./README.md.
 */
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
type OpportunitySummary = Omit<RemoveIndex<Opportunity>, "fundingDetails">;

interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface Stats {
  total: number;
  byFundingType: Record<string, number>;
  byStatus: Record<string, number>;
  topEcosystems: { ecosystem: string; count: number }[];
  lastUpdatedAt: string | null;
}

/**
 * Every filter/sort/pagination param the list endpoint accepts (all optional).
 *
 * This is the COMPLETE set — the closed core removed `network` and `tag`, and the API strips
 * parameters it does not define rather than rejecting them, so a stale filter fails silently
 * instead of erroring. `organization` matches either organization role.
 */
export interface ListOpportunitiesParams {
  fundingType?: string[];
  status?: string[];
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
interface ApiError {
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
    const body = (await res.json().catch(() => null)) as ApiError | null;
    const detail = body?.error ? `${body.error}: ${body.message}` : await res.text();
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
function displayOrg(o: OpportunitySummary): string {
  return o.operatingOrganizations[0].name;
}

/** One currency per document denominates every amount in it, so it prints once alongside them. */
function money(o: OpportunitySummary): string {
  const f = o.fundingInfo;
  if (!f) return "(no funding info)";
  const currency = f.currency ?? "?";
  if (f.minAward != null && f.maxAward != null) {
    return `${f.minAward}–${f.maxAward} ${currency}`;
  }
  if (f.budget != null) return `${f.budget} ${currency} budget`;
  return `(${currency})`;
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
    // fundingDetails is the one field the list projection omits. Its own tag equals the top-level
    // fundingType and narrows the union, so this switch is exhaustive over the six shapes.
    const details = detail.fundingDetails;
    switch (details.fundingType) {
      case "grant":
        console.log(`  grant, milestone-based: ${details.milestoneBased ?? "unstated"}`);
        break;
      case "hackathon":
        console.log(`  hackathon, location: ${details.location ?? "unstated"}`);
        break;
      case "bounty":
        console.log(`  bounty, reward: ${details.reward ?? "unstated"}`);
        break;
      default:
        console.log(`  ${details.fundingType} details: ${JSON.stringify(details)}`);
    }
  }

  console.log("\n-- stats --");
  const stats = await getStats();
  console.log(`  total: ${stats.total}`);
  console.log("  byFundingType:", stats.byFundingType);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
