/**
 * OFFLINE TOOL — step 2 of the bulk-refresh pipeline: fetch → CONVERT → curate → commit.
 * Not on the seed path, not on any request path. See tools/converter/README.md.
 *
 * Reads the raw upstream programs `fetch-corpus.ts` wrote, runs each through the pure `mapProgram`
 * mapper, validates the result against RFP Hub Standard v1.0.0, and writes the conforming
 * documents to a working file.
 *
 *   pnpm --filter @the-rfp-hub/api corpus:convert [in.json] [out.json]
 *
 * What this produces is a DRAFT, and the distinction matters enough to be the reason this tool is
 * not wired into anything. A mapper can only restate what the upstream said; it cannot know that a
 * program closed last month, that a budget was announced in a blog post, or that a "bounty" is
 * really a hackathon. Turning a draft into `data/seed-corpus.json` is a human pass — reconcile each
 * entry against the funder's own published pages, fix what the upstream got wrong, drop what does
 * not belong — and that curated file, not this output, is the dataset the seed loads and the repo
 * versions.
 *
 * A record that fails validation is REPORTED and excluded, never quietly repaired: a mapper that
 * silently patches its own output is a mapper whose fidelity nobody can measure. Two rows mapping
 * onto one id are reported the same way and fail the run, because that is data loss rather than a
 * quality signal — the draft comes out shorter than its input and only the id says so.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Opportunity } from "@the-rfp-hub/standard";
import { humanizeErrors, validateOpportunity } from "rfphub-validate";
import { type RegistryProgram, mapProgram } from "./map-program.js";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "out");
const DEFAULT_IN = join(OUT_DIR, "raw-programs.json");
const DEFAULT_OUT = join(OUT_DIR, "draft-corpus.json");

/** Raw programs, as a bare array or under `programs` in an envelope. */
export function programsFromSnapshot(parsed: unknown, path = "snapshot"): RegistryProgram[] {
  const programs = Array.isArray(parsed)
    ? parsed
    : (parsed as { programs?: unknown } | null)?.programs;
  if (!Array.isArray(programs)) {
    throw new Error(`${path}: expected an array of upstream programs, or { programs: [...] }`);
  }
  if (programs.length === 0) throw new Error(`${path}: contains no programs`);
  return programs as RegistryProgram[];
}

export interface ConversionResult {
  documents: Opportunity[];
  rejected: { id: string; errors: string[] }[];
  /**
   * Ids that more than one upstream row mapped onto, with the number of rows that did. A collision
   * is data loss — two rows, one document — and the curator is the only one who can say which row
   * was meant, so it is reported by id and count rather than resolved by arrival order.
   */
  duplicates: { id: string; count: number }[];
}

/**
 * Map every program, keep the conforming documents, name everything else — both the records that
 * do not conform and the ids two upstream rows collided on. Nothing is dropped in silence: a draft
 * quietly shorter than its input is a draft whose gaps a curator has no way to notice.
 */
export function convert(programs: readonly RegistryProgram[]): ConversionResult {
  const seen = new Map<string, number>();
  const documents: Opportunity[] = [];
  const rejected: ConversionResult["rejected"] = [];
  for (const program of programs) {
    const std = mapProgram(program);
    const before = seen.get(std.id) ?? 0;
    seen.set(std.id, before + 1);
    if (before > 0) continue; // counted as a duplicate below, not silently forgotten
    const { valid, errors } = validateOpportunity(std, { checks: false });
    if (valid) documents.push(std);
    else rejected.push({ id: std.id, errors: humanizeErrors(errors, std) });
  }
  const duplicates = [...seen]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ id, count }));
  return { documents, rejected, duplicates };
}

async function main(): Promise<void> {
  const [inPath = DEFAULT_IN, outPath = DEFAULT_OUT] = process.argv.slice(2).filter((a) => a);
  const programs = programsFromSnapshot(JSON.parse(await readFile(inPath, "utf8")), inPath);
  const { documents, rejected, duplicates } = convert(programs);

  for (const { id, errors } of rejected) {
    console.error(`  ✗ ${id} does not conform:`);
    for (const line of errors) console.error(`      - ${line}`);
  }
  for (const { id, count } of duplicates) {
    console.error(
      `  ✗ ${id}: ${count} upstream rows mapped onto this id; only the first is in the draft`,
    );
  }

  const envelope = {
    note:
      "DRAFT RFP Hub Standard documents, mechanically converted from an upstream registry — a " +
      "working file, not the dataset. Reconcile each entry against the funder's own published " +
      "pages before any of it becomes data/seed-corpus.json.",
    documents,
  };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(envelope, null, 2)}\n`);
  console.log(
    `✓ ${documents.length} draft documents → ${outPath} (${rejected.length} non-conforming, listed above)`,
  );

  // The draft is still written — a curator wants to see what did convert — but a collision means
  // rows went missing, so the run does not report success.
  if (duplicates.length > 0) {
    const named = duplicates.map(({ id, count }) => `${id} (×${count})`).join(", ");
    const lost = duplicates.reduce((n, d) => n + d.count - 1, 0);
    throw new Error(
      `${duplicates.length} duplicate id(s) in the snapshot: ${named} — the draft is short by ${lost} row(s)`,
    );
  }
}

if (!process.env.VITEST) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
