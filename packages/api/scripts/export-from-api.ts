/**
 * API-sourced open-data export: the same six files, written by the same writer, from a LIVE `/v1/`
 * API instead of from a database.
 *
 * `export-writer.ts` holds the writer; `export.ts` is the database source. This file is the second
 * SOURCE and nothing else: it obtains records over HTTP, proves they are worth publishing, and
 * hands them to the same `writeExport`. The published format — serialization, ordering, digests,
 * archive names, the promotion order, the CC0 sidecar, the floor — has exactly one implementation,
 * and it is not in this file.
 *
 *   EXPORT_API_URL=https://api.example.org pnpm --filter @the-rfp-hub/api export:api
 *
 * ── Why a second source ────────────────────────────────────────────────────────────
 * A publisher that runs where the API is reachable needs no database credentials, no network path
 * to Postgres and no schema knowledge: it publishes what the public actually receives. That makes
 * the export a check on the deployment rather than a second, privileged view of it — if the API
 * serves something the Standard rejects, this run fails instead of publishing it.
 *
 * There is no database on this path, so no `dataset_snapshots` row is recorded. That table
 * describes publications the database itself can account for; a row inserted by a process with no
 * connection would be a claim about a database that never saw the run.
 *
 * ── What a run proves before it publishes anything ─────────────────────────────────
 *  1. every page of `/v1/opportunities` was read, and the pages joined without a repeated id;
 *  2. the number of records fetched equals `/v1/stats` `total` — a dataset that changed under the
 *     run, or a paging bug that silently dropped a page, fails here and publishes NOTHING;
 *  3. every record validates against the Standard, one by one, not a sample;
 *  4. the floor (EXPORT_MIN_COUNT) is met — asserted by the writer, before a byte is written.
 *
 * Any of those failing means the previous export stays exactly where it is. An empty API — a fresh
 * deployment whose data has not been loaded yet — is the case (2) and (4) exist for: it publishes
 * nothing and exits non-zero, rather than replacing a good dataset with an empty one.
 *
 * ── Configuration ──────────────────────────────────────────────────────────────────
 *   EXPORT_API_URL    required. Origin of the deployed API, e.g. https://api.example.org — the
 *                     ORIGIN, not a path: `/v1/...` is appended to it.
 *   EXPORT_OUT_DIR    where to write. Defaults to ./exports, like the database source.
 *   EXPORT_MIN_COUNT  the publication floor, read by the writer (default 100).
 */
import { type Opportunity, SPEC_VERSION } from "@the-rfp-hub/standard";
import { config as loadDotenv } from "dotenv";
import { humanizeErrors, validateOpportunity } from "rfphub-validate";
import { isLoopbackHost } from "../src/shared/loopback.js";
import {
  ExportAliasError,
  ExportFloorError,
  type ExportResult,
  ExportWriteError,
  writeExport,
} from "./export-writer.js";

// Same load as src/config.ts, and for the same reason: a `.env` beside this package's package.json
// configures a local run. A real environment variable always wins — dotenv never overwrites one.
loadDotenv({ quiet: true });

/** The API's own maximum page size (see listQuerySchema). Fewer round trips is the only reason. */
const PAGE_SIZE = 100;
/** Detail requests in flight. Bounded so a publisher never behaves like a load generator. */
const CONCURRENCY = 8;
const TIMEOUT_MS = 30_000;
/** Attempts per request, including the first. Transient failures are retried; 4xx never is. */
const ATTEMPTS = 3;
/** Errors reported per failing check before the rest are summarized. */
const SHOWN = 5;

export interface ApiExportOptions {
  /** Origin of the API to publish, e.g. `https://api.example.org`. */
  baseUrl: string;
  /** Where to write. Defaults to `./exports`. */
  outDir?: string;
  /** Minimum records required to publish. Defaults to EXPORT_MIN_COUNT, then 100. */
  minCount?: number;
}

/**
 * The API could not be read: a transport failure, a status the run cannot proceed from, or a body
 * that is not the shape the documented contract promises. Nothing has been written when it is
 * raised — every fetch happens before the writer is called.
 */
export class ExportSourceError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ExportSourceError";
  }
}

/**
 * The records fetched and the dataset the API reports do not agree. This is the guard against
 * publishing a SILENTLY PARTIAL dataset — the failure that is otherwise invisible, because a short
 * export is a perfectly well-formed file. A page dropped by a paging bug, a record that vanished
 * between the first page and the last, a duplicate id joining two pages: all land here, and none of
 * them publishes.
 */
export class ExportCountError extends Error {
  constructor(
    readonly fetched: number,
    readonly reported: number,
    detail: string,
  ) {
    super(
      [
        `refusing to publish: ${detail}.`,
        `Fetched ${fetched} record(s); /v1/stats reports ${reported}.`,
        "Nothing was written — the previous export is untouched.",
        "A dataset that changed mid-run resolves itself on the next run.",
      ].join(" "),
    );
    this.name = "ExportCountError";
  }
}

/**
 * The API served at least one record the Standard rejects. Schema conformance is not sampled here
 * and it is not advisory: an export is a published artifact carrying a spec version, so a document
 * that does not meet it must not travel under that label. Advisory check-tier warnings are NOT
 * consulted — a warning describes quality, not conformance, and never fails a publication.
 */
export class ExportSchemaError extends Error {
  constructor(readonly invalid: readonly { id: string; errors: string[] }[]) {
    const shown = invalid
      .slice(0, SHOWN)
      .map(({ id, errors }) => `  ${id}: ${errors.join("; ")}`)
      .join("\n");
    const rest = invalid.length > SHOWN ? `\n  …and ${invalid.length - SHOWN} more` : "";
    super(
      `refusing to publish: ${invalid.length} record(s) do not validate against the RFP Hub ` +
        `Standard ${SPEC_VERSION}. Nothing was written — the previous export is untouched.\n` +
        `${shown}${rest}`,
    );
    this.name = "ExportSchemaError";
  }
}

/**
 * The API origin, validated.
 *
 * https is required for every host that is not loopback, on the same reasoning `PUBLIC_BASE_URL`
 * uses it (src/config.ts): this URL decides what gets published under this project's name, so
 * anyone able to rewrite plaintext on the path chooses the contents of a public dataset. Loopback
 * is exempt because there is no path to sit on.
 *
 * A path, query or fragment is rejected rather than trimmed: `/v1/...` is appended to this value,
 * and quietly discarding part of an operator's URL is how a run ends up reading a different
 * deployment than the one they named.
 */
export function readApiBaseUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new Error(
      "EXPORT_API_URL is required: the origin of the API to publish, e.g. https://api.example.org",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `EXPORT_API_URL must be an absolute URL (e.g. https://api.example.org), got ${JSON.stringify(value)}.`,
    );
  }
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    throw new Error(
      [
        "EXPORT_API_URL must use https:// for any host that is not loopback — this URL decides",
        "what gets published, so plaintext lets the path choose the dataset.",
        `Got ${JSON.stringify(value)}.`,
      ].join(" "),
    );
  }
  if (url.search || url.hash || url.pathname !== "/") {
    throw new Error(
      `EXPORT_API_URL must be a bare origin with no path, query or fragment ("/v1/..." is appended to it), got ${JSON.stringify(value)}.`,
    );
  }
  return url.origin;
}

/** The run's inputs, read off the environment. Pure, so the rules are testable without a run. */
export function parseApiExportOptions(
  env: Record<string, string | undefined> = process.env,
): ApiExportOptions {
  const outDir = (env.EXPORT_OUT_DIR ?? "").trim();
  return { baseUrl: readApiBaseUrl(env.EXPORT_API_URL), ...(outDir ? { outDir } : {}) };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET one JSON document, with a bounded retry.
 *
 * Retried: a transport failure, a timeout, 429, and 5xx — the failures that say "ask again", and
 * the ones a nightly publisher hits for no reason of its own. NOT retried: any other 4xx, which
 * says the request itself is wrong and will be exactly as wrong the second time.
 */
async function getJson(url: string): Promise<unknown> {
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(500 * (attempt - 1));
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      last = new ExportSourceError(`${url}: request failed — ${(err as Error).message}`, err);
      continue;
    }
    if (!res.ok) {
      const err = new ExportSourceError(`${url}: HTTP ${res.status} ${res.statusText}`);
      if (res.status !== 429 && res.status < 500) throw err;
      last = err;
      continue;
    }
    try {
      return await res.json();
    } catch (err) {
      // A body that is not JSON is a broken deployment, not a transient one (a proxy's error page,
      // a truncated response); it is reported as-is rather than retried into a timeout.
      throw new ExportSourceError(`${url}: response is not JSON — ${(err as Error).message}`, err);
    }
  }
  throw last;
}

/** Run `worker` over `items` with at most `limit` in flight, preserving input order in the result. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await worker(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return out;
}

interface StatsSummary {
  total: number;
}

interface ListPage {
  items: { id: string }[];
  total: number;
  totalPages: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `/v1/stats`, reduced to the one field this run needs: the size of the public dataset. */
async function fetchTotal(baseUrl: string): Promise<number> {
  const url = `${baseUrl}/v1/stats`;
  const body = await getJson(url);
  const total = isObject(body) ? body.total : undefined;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) {
    throw new ExportSourceError(`${url}: total is ${JSON.stringify(total)}, want a whole number`);
  }
  return total;
}

/** One page of the list endpoint, checked against the shape the documented contract promises. */
async function fetchPage(baseUrl: string, page: number): Promise<ListPage> {
  // `createdAt` never changes for a record, so an update landing mid-run cannot slide a record
  // across the page window under us. Inserts and deletes still can — which is what the id and
  // count checks below are for; this ordering narrows the exposure, it does not remove it.
  const url = `${baseUrl}/v1/opportunities?page=${page}&limit=${PAGE_SIZE}&sort=createdAt&order=asc`;
  const body = await getJson(url);
  if (!isObject(body) || !Array.isArray(body.items)) {
    throw new ExportSourceError(`${url}: response has no items[]`);
  }
  const { total, totalPages } = body;
  if (typeof total !== "number" || typeof totalPages !== "number") {
    throw new ExportSourceError(`${url}: response is missing a numeric total/totalPages`);
  }
  for (const item of body.items) {
    if (!isObject(item) || typeof item.id !== "string" || !item.id) {
      throw new ExportSourceError(`${url}: an item has no string id`);
    }
  }
  return { items: body.items as { id: string }[], total, totalPages };
}

/**
 * Every id in the public dataset, in one pass over the list endpoint, held against the total
 * `/v1/stats` already reported.
 *
 * The loop is bounded by the `totalPages` the API itself reports, so a service that always answers
 * with a full page cannot spin it forever; a page that comes back empty before the ids are all in
 * ends the run rather than publishing what happened to arrive.
 */
async function fetchIds(baseUrl: string, reported: number): Promise<string[]> {
  const first = await fetchPage(baseUrl, 1);
  if (first.total !== reported) {
    throw new ExportCountError(
      first.total,
      reported,
      "the list endpoint's own total disagrees with /v1/stats",
    );
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  const collect = (page: ListPage, number: number): void => {
    for (const item of page.items) {
      // The one paging failure that is otherwise invisible: a record served twice makes the pages
      // add up to the right COUNT while the dataset is missing something else entirely.
      if (seen.has(item.id)) {
        throw new ExportCountError(
          ids.length,
          reported,
          `page ${number} repeated the id ${item.id}, so the pages do not join into one dataset`,
        );
      }
      seen.add(item.id);
      ids.push(item.id);
    }
  };

  collect(first, 1);
  for (let page = 2; page <= first.totalPages; page++) {
    const next = await fetchPage(baseUrl, page);
    if (next.items.length === 0) {
      throw new ExportSourceError(
        `${baseUrl}/v1/opportunities: page ${page} of ${first.totalPages} is empty after ${ids.length} record(s)`,
      );
    }
    collect(next, page);
  }
  return ids;
}

/**
 * The full Standard document for one id.
 *
 * The DETAIL endpoint, one request per record, because the list endpoint serves a thin projection
 * that omits `fundingDetails` — a REQUIRED property of the Standard, so a list item is not a record
 * this export could publish or even validate. The cost is one bounded-concurrency request per
 * record, paid once a night, and the return is that what is published is byte-for-byte what a
 * consumer of the API receives.
 */
async function fetchDocument(baseUrl: string, id: string): Promise<Opportunity> {
  const url = `${baseUrl}/v1/opportunities/${encodeURIComponent(id)}`;
  const body = await getJson(url);
  if (!isObject(body)) throw new ExportSourceError(`${url}: response is not an object`);
  if (body.id !== id) {
    throw new ExportSourceError(`${url}: served id ${JSON.stringify(body.id)}, asked for ${id}`);
  }
  return body as unknown as Opportunity;
}

export interface ApiFetchResult {
  items: Opportunity[];
  /** What `/v1/stats` reported, which the fetched count had to equal to get here. */
  reported: number;
}

/**
 * Read the whole public dataset off a live API and prove it is publishable — or throw.
 *
 * Exported so the guarantees can be driven directly in tests, and so a caller that wants the
 * records without publishing them (a dry run, a diff against a previous export) does not have to
 * write six files to get them.
 */
export async function fetchDataset(baseUrl: string): Promise<ApiFetchResult> {
  // `/v1/stats` FIRST, before any paging starts: it is an aggregate the API computes over the whole
  // public dataset with a different query than the list endpoint runs, so it is an INDEPENDENT
  // answer to "how big is this dataset" rather than a restatement of the walk it is checking.
  const reported = await fetchTotal(baseUrl);
  const ids = await fetchIds(baseUrl, reported);

  // The cross-check, before a single document is fetched. Agreement between two independently
  // produced counts is evidence; disagreement is a run that must not publish, whichever of the two
  // is right — a dropped page and a record added mid-walk are indistinguishable from here, and
  // neither is a dataset worth replacing a good one with.
  if (ids.length !== reported) {
    throw new ExportCountError(
      ids.length,
      reported,
      "the records served by /v1/opportunities and the total /v1/stats reports do not agree",
    );
  }

  const items = await mapLimit(ids, CONCURRENCY, (id) => fetchDocument(baseUrl, id));

  // EVERY record, not a sample. `checks: false` keeps the advisory tier out of it: a warning is a
  // quality signal about something the schema deliberately leaves open, and it has never been a
  // reason to withhold a publication (the seed's `--strict` draws the same line).
  const invalid: { id: string; errors: string[] }[] = [];
  for (const item of items) {
    const { valid, errors } = validateOpportunity(item, { checks: false });
    if (!valid) invalid.push({ id: item.id, errors: humanizeErrors(errors, item) });
  }
  if (invalid.length > 0) throw new ExportSchemaError(invalid);

  return { items, reported };
}

/** Fetch the dataset from `baseUrl` and publish it through the shared writer. */
export async function runApiExport(options: ApiExportOptions): Promise<ExportResult> {
  const { items } = await fetchDataset(options.baseUrl);
  const { baseUrl: _baseUrl, ...writerOptions } = options;
  return writeExport(items, writerOptions);
}

// CLI entry — skipped under Vitest so tests can import the pieces without side effects.
if (!process.env.VITEST) {
  const started = Date.now();
  Promise.resolve()
    .then(() => runApiExport(parseApiExportOptions()))
    .then(({ count, artifacts, manifest, directorySynced }) => {
      const written = artifacts.map(({ path }) => `  ${path}`).join("\n");
      const durability = directorySynced
        ? "directory fsynced"
        : "directory fsync attempted, not permitted on this platform";
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `✓ exported ${count} opportunities from ${process.env.EXPORT_API_URL} as run ` +
          `${manifest.runId} in ${seconds}s (${durability})\n${written}`,
      );
    })
    .catch((err) => {
      // Every refusal this script can reach is a designed one, and each says what to do about it.
      // Anything else is printed whole, stack and all, because it is a surprise.
      const expected =
        err instanceof ExportSourceError ||
        err instanceof ExportCountError ||
        err instanceof ExportSchemaError ||
        err instanceof ExportFloorError ||
        err instanceof ExportWriteError ||
        err instanceof ExportAliasError;
      console.error(expected ? `✗ ${err.message}` : err);
      process.exitCode = 1;
    });
}
