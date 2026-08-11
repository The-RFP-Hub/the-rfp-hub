/**
 * OFFLINE TOOL — step 1 of the bulk-refresh pipeline: FETCH → convert → curate → commit.
 * Not on the seed path, not on any request path. See tools/converter/README.md.
 *
 * This program pages through a live upstream funding-map registry and writes a snapshot of raw
 * upstream programs to a working file. `convert.ts` then turns that file into draft Standard
 * documents for a human to review; only what survives that review is committed to
 * `data/seed-corpus.json`, which is what the seed loads.
 *
 *   SOURCE_API_URL=… SOURCE_BRAND="acme,acme-labs" pnpm --filter @the-rfp-hub/api corpus:fetch
 *
 * This is the ONLY file in the package that reads SOURCE_API_URL, and it is run BY HAND when the
 * dataset needs a bulk refresh — never in CI, never by the server, never on a deploy, never by the
 * seed. The var is env-only and must never be committed with a value: the upstream host appears in
 * no tracked file in this repo. Its output is a working file, gitignored for the same reason —
 * this tool's raw output is not a repo artifact, the CURATED Standard corpus is.
 *
 * NEUTRALIZATION (why this program exists rather than a curl into a file):
 * this repo is source-neutral, so nothing that names the upstream vendor or its hosts may be
 * committed. Real-world data — organisation names, ecosystems, the funding programs' own URLs —
 * is public and kept verbatim; only vendor identity is removed:
 *
 *   1. `DROP_KEYS` are deleted at every depth: vendor-coupled flags, vendor-hosted asset URLs, and
 *      operational contact addresses that have no business in a public fixture.
 *   2. Any key whose NAME matches a vendor term is deleted at every depth.
 *   3. Any record still mentioning a vendor term (or an internal tracker id) anywhere in its
 *      values is excluded outright, rather than rewritten — a rewritten record is no longer a
 *      recording of what the upstream sends.
 *
 * Vendor terms are never hard-coded here: they are derived from the SOURCE_API_URL host, plus
 * whatever SOURCE_BRAND lists (comma-separated). Both are runtime env vars — the only pointers at
 * the upstream anywhere in this package.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RegistryProgram } from "./map-program.js";

/** Working directory for this tool's intermediate files. Gitignored — see the header. */
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "out");
const OUT_PATH = join(OUT_DIR, "raw-programs.json");
const TARGET = Number(process.env.CORPUS_SIZE ?? 150);
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
/** One id for every page of one run, so the upstream can correlate this crawl in its own logs. */
const INVOCATION_ID = randomUUID();

/** Deleted at every depth: vendor-coupled flags, vendor-hosted assets, operational contacts. */
const DROP_KEYS = new Set(["isValid", "imageUrl", "platformsUsed", "adminEmails", "financeEmails"]);

/** Host labels too generic to be a vendor term on their own. */
const GENERIC_LABELS = new Set([
  "www",
  "api",
  "app",
  "web",
  "co",
  "com",
  "net",
  "org",
  "io",
  "xyz",
]);

/**
 * Internal tracker ids are barred repo-wide by scripts/check-neutral.mjs — bar them here too, with
 * exactly that script's pattern. A broader `[A-Z]{2,6}-\d+` shape would also match the ordinary
 * vocabulary of this domain (ERC-4337, EIP-1559, BIP-32, CIP-64) and, since a hit excludes the
 * WHOLE record, would silently drop every standards-heavy funding program from the corpus.
 */
const TRACKER_ID = /\bDEV-\d+\b/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Vendor terms: the SOURCE_API_URL host's distinctive labels + anything in SOURCE_BRAND. */
export function vendorTerms(apiUrl: string, brands = ""): string[] {
  const labels = new URL(apiUrl).hostname.split(".").filter((l) => !GENERIC_LABELS.has(l));
  const branded = brands
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...labels, ...branded].map((t) => t.toLowerCase()))];
}

/** Recursively delete `DROP_KEYS` and any key whose name matches a vendor term. */
export function stripKeys(value: unknown, vendor: RegExp): unknown {
  if (Array.isArray(value)) return value.map((v) => stripKeys(v, vendor));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_KEYS.has(k) || vendor.test(k)) continue;
    out[k] = stripKeys(v, vendor);
  }
  return out;
}

/** True when nothing in the record's own values names the vendor or an internal tracker id. */
export function isNeutral(record: unknown, vendor: RegExp): boolean {
  const text = JSON.stringify(record);
  return !vendor.test(text) && !TRACKER_ID.test(text);
}

async function fetchPage(
  apiUrl: string,
  page: number,
): Promise<{ programs: RegistryProgram[]; hasNext: boolean }> {
  const url = new URL("/v2/program-registry/search", apiUrl);
  url.searchParams.set("isValid", "accepted");
  url.searchParams.set("limit", String(PAGE_LIMIT));
  url.searchParams.set("page", String(page));
  url.searchParams.set("sortField", "updatedAt");
  url.searchParams.set("sortOrder", "desc");
  const res = await fetch(url, {
    headers: { "X-Source": "rfp-hub-api:corpus", "X-Invocation-Id": INVOCATION_ID },
  });
  if (!res.ok) throw new Error(`source registry API ${res.status} on page ${page}`);
  const body = (await res.json()) as { programs?: RegistryProgram[]; hasNext?: boolean };
  return { programs: body.programs ?? [], hasNext: Boolean(body.hasNext) };
}

async function main(): Promise<void> {
  const apiUrl = process.env.SOURCE_API_URL;
  if (!apiUrl) throw new Error("SOURCE_API_URL is not set — point it at the upstream registry API");
  const terms = vendorTerms(apiUrl, process.env.SOURCE_BRAND);
  const vendor = new RegExp(terms.map(escapeRe).join("|"), "i");

  const kept: RegistryProgram[] = [];
  let excluded = 0;
  for (let page = 1; page <= MAX_PAGES && kept.length < TARGET; page++) {
    const { programs, hasNext } = await fetchPage(apiUrl, page);
    if (programs.length === 0) break;
    for (const program of programs) {
      if (kept.length >= TARGET) break;
      const neutral = stripKeys(program, vendor) as RegistryProgram;
      if (!isNeutral(neutral, vendor)) {
        excluded++;
        continue;
      }
      kept.push(neutral);
    }
    if (!hasNext) break;
  }

  const envelope = {
    note:
      "Neutralized snapshot of RAW upstream funding-map registry programs — a working file for " +
      "tools/converter, not a repo artifact and not loadable by the seed. Rebuild with " +
      "`pnpm corpus:fetch`; convert with `pnpm corpus:convert`. Program data is public; vendor " +
      "identity is removed.",
    programs: kept,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(envelope, null, 2)}\n`);
  console.log(`✓ ${kept.length} programs → ${OUT_PATH} (${excluded} excluded as non-neutral)`);
}

if (!process.env.VITEST) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
