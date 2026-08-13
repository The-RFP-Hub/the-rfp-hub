/**
 * The DATABASE source of the open-data export: read the live public dataset, publish it through the
 * shared writer, and record a `dataset_snapshots` row per format.
 *
 *   pnpm --filter @the-rfp-hub/api export
 *
 * Neither the published format nor the publication is here — the format is
 * `src/modules/shared/export-format.ts` and the file publication is `export-writer.ts`, which every
 * source shares, so the six files this run writes are byte-for-byte the ones any other source would
 * write from the same records (see `export-from-api.ts`, which publishes a deployed API instead).
 * Which rows are public is not here either: that predicate belongs to `OpportunityService`, where
 * every public read in the API already gets it, so an export cannot publish a record the API hides
 * or hide one it publishes. What is left here is the one thing that is genuinely this source's —
 * the snapshot row the run leaves behind.
 *
 * `dataset_snapshots` stays on this path deliberately. It records the ARCHIVE names — the per-run
 * record — with the sha256 of the bytes stored under them, never the aliases, which move; and a
 * source with no database records nothing rather than inserting a claim about a publication the
 * database has no other knowledge of.
 */
import { join } from "node:path";
import { db, pool } from "../src/db/client.js";
import { datasetSnapshots } from "../src/db/schema.js";
import { OpportunityService } from "../src/modules/services/opportunities/opportunity.service.js";
import {
  ExportAliasError,
  ExportFloorError,
  type ExportOptions,
  type ExportResult,
  ExportWriteError,
  writeExport,
} from "./export-writer.js";

/**
 * Publish the live public dataset, then record the run in `dataset_snapshots`. Does not close the
 * pool (caller's job).
 *
 * The snapshot rows are written AFTER the writer returns, and only then: they describe a
 * publication, so a run that could not publish must not leave a row claiming it did. They record
 * exactly what the manifest published, so the two can never describe different files.
 */
export async function runExport(options: ExportOptions = {}): Promise<ExportResult> {
  const records = await new OpportunityService().listAll();

  const result = await writeExport(records, options);

  await db.insert(datasetSnapshots).values(
    result.manifest.artifacts.map((artifact) => ({
      format: artifact.format,
      entryCount: artifact.count,
      url: join(result.outDir, artifact.href),
      sha256: artifact.sha256,
      specVersion: result.manifest.specVersion,
    })),
  );

  return result;
}

// CLI entry — skipped under Vitest so tests can import runExport without side effects.
if (!process.env.VITEST) {
  runExport()
    .then(({ count, artifacts, manifest, directorySynced }) => {
      const written = artifacts.map(({ path }) => `  ${path}`).join("\n");
      // The fsync outcome is printed rather than assumed: on a platform that refuses it, the run
      // still succeeded and the operator should know which guarantee they actually got.
      const durability = directorySynced
        ? "directory fsynced"
        : "directory fsync attempted, not permitted on this platform";
      console.log(
        `✓ exported ${count} opportunities as run ${manifest.runId} (${durability})\n${written}`,
      );
    })
    .catch((err) => {
      const expected =
        err instanceof ExportFloorError ||
        err instanceof ExportWriteError ||
        err instanceof ExportAliasError;
      console.error(expected ? `✗ ${err.message}` : err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
