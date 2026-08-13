/**
 * DB-gated publish test: run the REAL exporter, then plan a publication of what it wrote.
 *
 * The unit suite drives the publish step against a hand-built fixture, which proves it does what it
 * was told. This proves the two halves still agree — that the manifest `export.ts` promotes is a
 * manifest `publish.ts` can resolve, that the six files it names are the six files that landed, and
 * that the sizes and digests the plan reports are the ones on disk. A fixture cannot fail when the
 * writer's naming rule changes; this can.
 *
 * The dry run is the whole test surface: no bucket, no credentials, no network. Gated on
 * DATABASE_URL, like every other integration suite. Self-cleaning.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Opportunity } from "@the-rfp-hub/standard";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MANIFEST_NAME, runExport } from "../../scripts/export.js";
import { CACHE_CONTROL, formatPlan, runPublish } from "../../scripts/publish.js";
import { db, pool } from "../../src/db/client.js";
import { datasetSnapshots, opportunities, organizations } from "../../src/db/schema.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { describeWithDb } from "./db-gate.js";

const run = describeWithDb;
const ROOT = join(tmpdir(), "rfphub-publish-integration-test");
const OUT = join(ROOT, "run");
const fixtureId = "ptest:publish-1";

// A destination that exists nowhere: the dry run never opens a socket, and no bucket name belongs
// in this repo in the first place. Everything real is supplied by the environment at run time.
const config = { bucket: "example-bucket", prefix: "open-data/" };

run("publishing a real export", () => {
  beforeAll(async () => {
    await new OpportunityService().upsertFromStandard(
      {
        specVersion: "1.0.0",
        id: fixtureId,
        fundingType: "grant",
        title: "Publish Fixture",
        description: "d",
        status: "open",
        operatingOrganizations: [{ name: "Publish Org", slug: "publish-org" }],
        source: { ingestedVia: "import", verifiedAgainstSource: null },
        ecosystems: ["PUBLISHTEST"],
        categories: ["Tooling"],
        fundingInfo: { budget: 1, currency: "USD" },
        deadlines: [
          { deadlineType: "fixed", date: "2999-01-01T00:00:00.000Z", label: "application" },
        ],
        fundingDetails: { fundingType: "grant" },
      } satisfies Opportunity,
      { reviewStatus: "approved", isListed: true },
    );
  });

  afterAll(async () => {
    await db.delete(datasetSnapshots).where(like(datasetSnapshots.url, `${ROOT}%`));
    await db.delete(opportunities).where(like(opportunities.publicId, "ptest:publish-%"));
    await db.delete(organizations).where(eq(organizations.slug, "publish-org"));
    await rm(ROOT, { recursive: true, force: true });
    await pool.end();
  });

  it("plans exactly the file set the exporter wrote, in the exporter's order", async () => {
    const exported = await runExport({ outDir: OUT, minCount: 1 });
    const written = exported.artifacts.map((a) => a.name);

    const result = await runPublish({ dir: OUT, config, dryRun: true });

    // the plan IS the run: same run id, same names, same order, and nothing invented or dropped
    expect(result.runId).toBe(exported.manifest.runId);
    expect(result.uploads.map((u) => u.name)).toEqual(written);
    expect(result.uploads.map((u) => u.name).at(-1)).toBe(MANIFEST_NAME);
    expect((await readdir(OUT)).sort()).toEqual([...written].sort());

    // the archive keys are the manifest's hrefs, carrying their own digests, under the prefix
    for (const artifact of exported.manifest.artifacts) {
      const upload = result.uploads.find((u) => u.name === artifact.href);
      expect(upload?.key).toBe(`open-data/${artifact.href}`);
      expect(upload?.cacheControl).toBe(CACHE_CONTROL.immutable);
      expect(upload?.sha256).toBe(artifact.sha256);
      // the size and the digest are the file's own, not the manifest's word for it
      const bytes = await readFile(join(OUT, artifact.href));
      expect(upload?.size).toBe(bytes.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
    }

    // the moving names get the short TTL, the pointer included — see the note in publish.ts
    for (const name of ["LICENSE", "latest.json", "latest.csv", MANIFEST_NAME]) {
      expect(result.uploads.find((u) => u.name === name)?.cacheControl, name).toBe(
        CACHE_CONTROL.mutable,
      );
    }

    const printed = formatPlan(result);
    expect(printed).toContain("DRY RUN — nothing was uploaded");
    expect(printed).toContain(`run ${exported.manifest.runId}`);
    expect(printed).toContain(`open-data/${MANIFEST_NAME}`);
  });

  // A second run leaves the previous archives in place and moves the pointer. The publication has
  // to follow the pointer, not the directory: publishing yesterday's archive because it is still
  // sitting there would upload objects the current manifest does not name.
  it("publishes the newest run's archives, not everything in the directory", async () => {
    const first = await runExport({ outDir: OUT, minCount: 1 });
    const second = await runExport({ outDir: OUT, minCount: 1 });
    const result = await runPublish({ dir: OUT, config, dryRun: true });

    expect(result.runId).toBe(second.manifest.runId);
    const keys = result.uploads.map((u) => u.name);
    for (const artifact of second.manifest.artifacts) expect(keys).toContain(artifact.href);
    // the JSON archive is named after an envelope that stamps the clock, so the two runs differ
    const staleJson = first.manifest.artifacts.find((a) => a.format === "json")?.href as string;
    const freshJson = second.manifest.artifacts.find((a) => a.format === "json")?.href as string;
    expect(staleJson).not.toBe(freshJson);
    expect(keys).not.toContain(staleJson);
    expect(keys).toHaveLength(6);
  });
});
