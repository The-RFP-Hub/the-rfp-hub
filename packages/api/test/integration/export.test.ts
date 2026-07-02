/**
 * DB-gated export test: seed a fixture, run the exporter to a temp dir, and assert the JSON/CSV
 * files + dataset_snapshots rows. Self-cleaning. Gated on DATABASE_URL (skipped otherwise).
 */
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Opportunity } from "@rfp-hub/standard";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runExport } from "../../scripts/export.js";
import { db, pool } from "../../src/db/client.js";
import { datasetSnapshots, opportunities, organizations } from "../../src/db/schema.js";
import { OpportunityController } from "../../src/modules/controller/Opportunity.controller.js";

const run = process.env.DATABASE_URL ? describe : describe.skip;
const OUT = join(tmpdir(), "rfphub-export-test");
const fixtureId = "etest:export-1";

run("open-data export", () => {
  beforeAll(async () => {
    const ctl = new OpportunityController();
    await ctl.upsertFromStandard(
      {
        specVersion: "1.0.0",
        id: fixtureId,
        type: "grant",
        title: "Export Fixture",
        description: "d",
        status: "open",
        organization: { name: "Export Org", slug: "export-org" },
        source: {
          url: "https://example.com/export-1",
          ingestedVia: "import",
          verifiedAgainstSource: null,
        },
        ecosystems: ["EXPORTTEST"],
        grant: {},
      } satisfies Opportunity,
      { reviewStatus: "approved", isListed: true },
    );
  });

  afterAll(async () => {
    await db.delete(datasetSnapshots).where(like(datasetSnapshots.url, `${OUT}%`));
    await db.delete(opportunities).where(like(opportunities.publicId, "etest:export-%"));
    await db.delete(organizations).where(eq(organizations.slug, "export-org"));
    await rm(OUT, { recursive: true, force: true });
    await pool.end();
  });

  it("writes JSON + CSV (CC0-marked) and records dataset_snapshots", async () => {
    const { jsonPath, csvPath, count } = await runExport(OUT);
    expect(count).toBeGreaterThanOrEqual(1);

    const json = JSON.parse(await readFile(jsonPath, "utf8"));
    expect(json.license).toBe("CC0-1.0");
    expect(json.specVersion).toBe("1.0.0");
    expect(json.count).toBe(count);
    expect(json.opportunities.some((o: Opportunity) => o.id === fixtureId)).toBe(true);

    const csv = await readFile(csvPath, "utf8");
    expect(csv.split("\n")[0]).toContain("id,type,status,title");
    expect(csv).toContain(fixtureId);

    const snapshots = await db
      .select()
      .from(datasetSnapshots)
      .where(like(datasetSnapshots.url, `${OUT}%`));
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((s) => s.format).sort()).toEqual(["csv", "json"]);
    expect(snapshots.every((s) => s.entryCount === count)).toBe(true);

    // a temp dir listing shows exactly the two files
    const files = await readdir(OUT);
    expect(files.filter((f) => f.endsWith(".json") || f.endsWith(".csv"))).toHaveLength(2);
  });
});
