/**
 * Zero-dependency TypeScript client for the RFP Hub public /v1/ API.
 *
 * Uses only Node 18+'s built-in `fetch` — no HTTP library. The `@the-rfp-hub/standard` import
 * below is type-only (erased at build/run time): it demonstrates that the detail endpoint returns
 * a real `Opportunity` from the standard's generated types, it is not a runtime dependency.
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
 * The list endpoint's thin projection: a full `Opportunity` minus the six type-specific blocks
 * (`grant`/`hackathon`/`bounty`/`accelerator`/`vc_fund`/`rfp`) and `extensions`. Fetch the detail
 * endpoint (see `getOpportunity` below) for the full object.
 */
type OpportunitySummary = Omit<
  RemoveIndex<Opportunity>,
  "grant" | "hackathon" | "bounty" | "accelerator" | "vc_fund" | "rfp" | "extensions"
>;

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

/** Every filter/sort/pagination param the list endpoint accepts (all optional). */
export interface ListOpportunitiesParams {
  fundingType?: string[];
  status?: string[];
  ecosystem?: string[];
  network?: string[];
  category?: string[];
  tag?: string[];
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
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText} from ${path}: ${body}`);
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
  console.log(`${list.total} total match, showing ${list.items.length} (page ${list.page}/${list.totalPages})`);
  for (const o of list.items) console.log(`  ${o.id}  ${o.title}`);

  const firstId = list.items[0]?.id;
  if (firstId) {
    console.log(`\n-- detail: ${firstId} --`);
    const detail = await getOpportunity(firstId);
    console.log(`  title:  ${detail.title}`);
    console.log(`  status: ${detail.status}`);
    console.log(`  applicationUrl: ${detail.applicationUrl ?? "(none)"}`);
  }

  console.log("\n-- stats --");
  const stats = await getStats();
  console.log(`  total: ${stats.total}`);
  console.log(`  byFundingType:`, stats.byFundingType);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
