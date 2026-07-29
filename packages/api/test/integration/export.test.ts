/**
 * DB-gated export test: seed a fixture, run the exporter, and assert the published artifacts +
 * dataset_snapshots rows — against the local directory sink AND against an S3 sink with an
 * injected stub client (no network, no credentials). Also covers the EXPORT_MIN_COUNT floor.
 * Self-cleaning. Gated on DATABASE_URL (skipped otherwise).
 */
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PutObjectCommand } from "@aws-sdk/client-s3";
import type { Opportunity } from "@the-rfp-hub/standard";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExportFloorError, LatestAliasMismatchError, runExport } from "../../scripts/export.js";
import { type S3Like, createS3Sink } from "../../scripts/upload.js";
import { db, pool } from "../../src/db/client.js";
import { datasetSnapshots, opportunities, organizations } from "../../src/db/schema.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";

const run = process.env.DATABASE_URL ? describe : describe.skip;
const OUT = join(tmpdir(), "rfphub-export-test");
const BUCKET = "rfphub-export-test-bucket";
const fixtureId = "etest:export-1";

interface RecordedPut {
  key: string;
  body: string;
  contentType: string;
  cacheControl?: string;
}

/** Records every PutObjectCommand instead of talking to S3. `failOn` simulates a mid-run failure. */
function stubS3(failOn?: string): { client: S3Like; puts: RecordedPut[] } {
  const puts: RecordedPut[] = [];
  return {
    puts,
    client: {
      async send(command: PutObjectCommand) {
        const { Key, Body, ContentType, CacheControl } = command.input;
        if (failOn && String(Key).endsWith(failOn)) throw new Error("SlowDown: 503 from the store");
        puts.push({
          key: String(Key),
          body: String(Body),
          contentType: String(ContentType),
          cacheControl: CacheControl,
        });
        return {};
      },
    },
  };
}

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
    await db.delete(datasetSnapshots).where(like(datasetSnapshots.url, `s3://${BUCKET}/%`));
    await db.delete(datasetSnapshots).where(like(datasetSnapshots.url, "https://cdn.example/%"));
    await db.delete(opportunities).where(like(opportunities.publicId, "etest:export-%"));
    await db.delete(organizations).where(eq(organizations.slug, "export-org"));
    await rm(OUT, { recursive: true, force: true });
    await pool.end();
  });

  it("writes dated + latest JSON/CSV (CC0-marked) and records dataset_snapshots", async () => {
    const { count, date, artifacts } = await runExport({ outDir: OUT, minCount: 1 });
    expect(count).toBeGreaterThanOrEqual(1);

    const url = (key: string): string => {
      const hit = artifacts.find((a) => a.key === key);
      if (!hit) throw new Error(`no artifact ${key} in ${artifacts.map((a) => a.key).join(", ")}`);
      return hit.url;
    };
    expect(artifacts.map((a) => a.key)).toEqual([
      `opportunities-${date}.json`,
      `opportunities-${date}.csv`,
      "latest.json",
      "latest.csv",
      "LICENSE",
    ]);

    const jsonText = await readFile(url(`opportunities-${date}.json`), "utf8");
    const json = JSON.parse(jsonText);
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

    const csv = await readFile(url(`opportunities-${date}.csv`), "utf8");
    expect(csv.split("\n")[0]).toContain("id,fundingType,status,title");
    expect(csv.split("\n")[0]).toContain("nextDeadlineAt,rollingDeadline");
    expect(csv).toContain(fixtureId);
    // CSV flattens deadlines[] to the derived nextDeadlineAt
    expect(csv).toContain("2999-01-01T00:00:00.000Z");

    // the stable aliases are byte-identical to the dated archive they alias
    expect(await readFile(url("latest.json"), "utf8")).toBe(jsonText);
    expect(await readFile(url("latest.csv"), "utf8")).toBe(csv);

    const license = await readFile(url("LICENSE"), "utf8");
    expect(license).toContain("SPDX-License-Identifier: CC0-1.0");
    expect(license).toContain("CC0 1.0 Universal");

    // snapshots point at the DATED objects, not the moving aliases
    const snapshots = await db
      .select()
      .from(datasetSnapshots)
      .where(like(datasetSnapshots.url, `${OUT}%`));
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((s) => s.format).sort()).toEqual(["csv", "json"]);
    expect(snapshots.every((s) => s.entryCount === count)).toBe(true);
    expect(snapshots.map((s) => s.url).sort()).toEqual(
      [url(`opportunities-${date}.csv`), url(`opportunities-${date}.json`)].sort(),
    );

    const files = await readdir(OUT);
    expect(files.sort()).toEqual(
      [
        "LICENSE",
        "latest.csv",
        "latest.json",
        `opportunities-${date}.csv`,
        `opportunities-${date}.json`,
      ].sort(),
    );
  });

  it("uploads every artifact to the S3 sink and records the object URL", async () => {
    const { client, puts } = stubS3();
    const sink = createS3Sink(
      { bucket: BUCKET, prefix: "data/", publicBaseUrl: "https://cdn.example" },
      client,
    );
    const { count, date, artifacts } = await runExport({ sink, minCount: 1 });

    expect(puts.map((p) => p.key)).toEqual([
      `data/opportunities-${date}.json`,
      `data/opportunities-${date}.csv`,
      "data/latest.json",
      "data/latest.csv",
      "data/LICENSE",
    ]);
    expect(puts.map((p) => p.contentType)).toEqual([
      "application/json; charset=utf-8",
      "text/csv; charset=utf-8",
      "application/json; charset=utf-8",
      "text/csv; charset=utf-8",
      "text/plain; charset=utf-8",
    ]);
    // the immutable dated archive and the moving aliases must not share a cache policy: a CDN in
    // front of the bucket would otherwise serve yesterday's `latest.*` for its own default TTL
    expect(puts.map((p) => p.cacheControl)).toEqual([
      "public, max-age=31536000, immutable",
      "public, max-age=31536000, immutable",
      "public, max-age=300",
      "public, max-age=300",
      "public, max-age=300",
    ]);
    // the CC0 sidecar travels with the data
    expect(puts.at(-1)?.body).toContain("SPDX-License-Identifier: CC0-1.0");
    expect(artifacts.map((a) => a.url)).toEqual(puts.map((p) => `https://cdn.example/${p.key}`));

    const snapshots = await db
      .select()
      .from(datasetSnapshots)
      .where(like(datasetSnapshots.url, "https://cdn.example/%"));
    expect(snapshots.map((s) => s.url).sort()).toEqual([
      `https://cdn.example/data/opportunities-${date}.csv`,
      `https://cdn.example/data/opportunities-${date}.json`,
    ]);
    expect(snapshots.every((s) => s.entryCount === count)).toBe(true);
  });

  // An object store has no cross-object atomicity, so `latest.json` can land and `latest.csv` not.
  // The two advertised stable URLs then describe different datasets — that has to be reported by
  // name, not left for a consumer to discover by diffing the two formats a day later.
  it("names the divergence when one stable alias lands and the other does not", async () => {
    const sinkOf = (stub: ReturnType<typeof stubS3>) =>
      createS3Sink({ bucket: BUCKET, prefix: "", publicBaseUrl: "" }, stub.client);

    await expect(runExport({ sink: sinkOf(stubS3("latest.csv")), minCount: 1 })).rejects.toThrow(
      /published latest\.json but FAILED to publish latest\.csv/,
    );

    const stub = stubS3("latest.csv");
    const { puts } = stub;
    await expect(runExport({ sink: sinkOf(stub), minCount: 1 })).rejects.toThrow(
      LatestAliasMismatchError,
    );

    // the dated archive for the run is complete, so a re-run converges the aliases
    expect(puts.map((p) => p.key).filter((k) => k.startsWith("opportunities-"))).toHaveLength(2);
    expect(puts.map((p) => p.key)).toContain("latest.json");
    expect(puts.map((p) => p.key)).not.toContain("LICENSE");

    // and no snapshot row claims a run that never finished publishing
    expect(
      await db
        .select()
        .from(datasetSnapshots)
        .where(like(datasetSnapshots.url, `s3://${BUCKET}/opportunities-%`)),
    ).toHaveLength(0);
  });

  it("refuses to publish below the floor, writing and uploading nothing", async () => {
    const { client, puts } = stubS3();
    const sink = createS3Sink({ bucket: BUCKET, prefix: "", publicBaseUrl: "" }, client);
    const before = await db.select().from(datasetSnapshots);

    await expect(runExport({ sink, minCount: 1_000_000 })).rejects.toThrow(ExportFloorError);
    await expect(runExport({ sink, minCount: 1_000_000 })).rejects.toThrow(
      /refusing to publish: \d+ live opportunit(y|ies) is below the floor of 1000000/,
    );

    expect(puts).toHaveLength(0);
    expect(await db.select().from(datasetSnapshots)).toHaveLength(before.length);
  });
});
