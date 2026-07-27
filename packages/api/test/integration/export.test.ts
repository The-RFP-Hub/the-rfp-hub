/**
 * DB-gated export test: seed a fixture, run the exporter to a temp dir, and assert the JSON/CSV
 * files + dataset_snapshots rows. Self-cleaning. Gated on DATABASE_URL (skipped otherwise).
 */
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Opportunity } from "@the-rfp-hub/standard";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runExport } from "../../scripts/export.js";
import { db, pool } from "../../src/db/client.js";
import { datasetSnapshots, opportunities, organizations } from "../../src/db/schema.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";

const run = process.env.DATABASE_URL ? describe : describe.skip;
const OUT = join(tmpdir(), "rfphub-export-test");
const fixtureId = "etest:export-1";

run("open-data export", () => {
  beforeAll(async () => {
    const ctl = new OpportunityService();
    await ctl.upsertFromStandard(
      {
        specVersion: "1.0.0",
        id: fixtureId,
        fundingType: "grant",
        title: "Export Fixture",
        description: "d",
        status: "open",
        sponsoringOrganizations: [{ name: "Export Org", slug: "export-org" }],
        source: { ingestedVia: "import", verifiedAgainstSource: null },
        ecosystems: ["EXPORTTEST"],
        funding: { budget: 12345, currency: "USD" },
        deadlines: [{ type: "fixed", date: "2999-01-01T00:00:00.000Z", label: "application" }],
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
    const { jsonPath, csvPath, licensePath, count } = await runExport(OUT);
    expect(count).toBeGreaterThanOrEqual(1);

    const json = JSON.parse(await readFile(jsonPath, "utf8"));
    expect(json.license).toBe("CC0-1.0");
    expect(json.specVersion).toBe("1.0.0");
    expect(json.count).toBe(count);
    const exported = json.opportunities.find((o: Opportunity) => o.id === fixtureId);
    expect(exported).toBeTruthy();
    // the JSON export carries the full re-cut shape, including the deadlines array
    expect(exported.fundingType).toBe("grant");
    expect(exported.sponsoringOrganizations[0].slug).toBe("export-org");
    expect(exported.funding).toEqual({ budget: 12345, currency: "USD" });
    expect(exported.deadlines).toHaveLength(1);
    expect(exported).not.toHaveProperty("closesAt");

    const csv = await readFile(csvPath, "utf8");
    expect(csv.split("\n")[0]).toContain("id,fundingType,status,title");
    expect(csv.split("\n")[0]).toContain("nextDeadlineAt,rollingDeadline");
    expect(csv).toContain(fixtureId);
    // CSV flattens deadlines[] to the derived nextDeadlineAt
    expect(csv).toContain("2999-01-01T00:00:00.000Z");

    const license = await readFile(licensePath, "utf8");
    expect(license).toContain("SPDX-License-Identifier: CC0-1.0");
    expect(license).toContain("CC0 1.0 Universal");

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
    expect(files).toContain("LICENSE");
  });
});
