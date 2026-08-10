/**
 * DB-gated export test: seed a fixture, run the exporter to a temp dir, and assert the written
 * file set + dataset_snapshots rows. Also covers the EXPORT_MIN_COUNT floor, the content-addressed
 * archive keys, and the partial-write failure. Self-cleaning. Gated on DATABASE_URL.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PutObjectCommand } from "@aws-sdk/client-s3";
import type { Opportunity } from "@the-rfp-hub/standard";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CSV_COLUMNS } from "../../scripts/csv.js";
import { ExportFloorError, ExportWriteError, runExport } from "../../scripts/export.js";
import { type S3Like, createS3Sink } from "../../scripts/upload.js";
import { db, pool } from "../../src/db/client.js";
import { datasetSnapshots, opportunities, organizations } from "../../src/db/schema.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { describeWithDb } from "./db-gate.js";

const run = describeWithDb;
const ROOT = join(tmpdir(), "rfphub-export-test");
const OUT = join(ROOT, "run");
const BUCKET = "rfphub-export-test-bucket";
const fixtureId = "etest:export-1";

/** The digest prefix an archive key carries, computed from the bytes stored under it. */
const digest = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** The archive key of one format out of a run's published set. */
const archive = (keys: string[], ext: string): string => {
  const hit = keys.find((k) => k.startsWith("opportunities-") && k.endsWith(`.${ext}`));
  if (!hit) throw new Error(`no ${ext} archive in ${keys.join(", ")}`);
  return hit;
};

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
        operatingOrganizations: [{ name: "Export Org", slug: "export-org" }],
        source: { ingestedVia: "import", verifiedAgainstSource: null },
        ecosystems: ["EXPORTTEST"],
        categories: ["Tooling"],
        fundingInfo: { budget: 12345, currency: "USD" },
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
    await db.delete(datasetSnapshots).where(like(datasetSnapshots.url, `s3://${BUCKET}/%`));
    await db.delete(opportunities).where(like(opportunities.publicId, "etest:export-%"));
    await db.delete(organizations).where(eq(organizations.slug, "export-org"));
    await rm(ROOT, { recursive: true, force: true });
    await pool.end();
  });

  it("writes the sidecar, the archive and the stable aliases, and records dataset_snapshots", async () => {
    const startedAt = Date.now();
    const { count, date, artifacts } = await runExport({ outDir: OUT, minCount: 1 });
    expect(count).toBeGreaterThanOrEqual(1);

    // the rights sidecar goes first and the aliases last, so no data file is ever readable without
    // its CC0 notice and no alias ever names a half-written dataset
    const keys = artifacts.map((a) => a.key);
    expect(keys).toEqual([
      "LICENSE",
      archive(keys, "json"),
      archive(keys, "csv"),
      "latest.json",
      "latest.csv",
    ]);
    expect(archive(keys, "json")).toMatch(
      new RegExp(`^opportunities-${date}-[0-9a-f]{12}\\.json$`),
    );

    const path = (name: string): string => join(OUT, name);
    const jsonText = await readFile(path(archive(keys, "json")), "utf8");
    const json = JSON.parse(jsonText);
    expect(json.license).toBe("CC0-1.0");
    expect(json.specVersion).toBe("1.0.0");
    expect(json.count).toBe(count);
    // `generatedAt` comes from the CLOCK, not from the data. That is why a re-run over unchanged
    // data is byte-identical in CSV but not in JSON — the envelope, its digest and its archive key
    // all move with the run. Documented as such rather than claimed away.
    expect(Date.parse(json.generatedAt)).toBeGreaterThanOrEqual(startedAt);
    expect(Date.parse(json.generatedAt)).toBeLessThanOrEqual(Date.now());
    const exported = json.opportunities.find((o: Opportunity) => o.id === fixtureId);
    expect(exported).toBeTruthy();
    // the JSON export carries the full re-cut shape: operating primacy, the single-currency
    // fundingInfo envelope, the tagged fundingDetails slot and the deadlines array
    expect(exported.fundingType).toBe("grant");
    expect(exported.operatingOrganizations[0].slug).toBe("export-org");
    expect(exported.fundingInfo).toEqual({ budget: 12345, currency: "USD" });
    expect(exported.fundingDetails).toEqual({ fundingType: "grant" });
    expect(exported.deadlines).toHaveLength(1);
    expect(exported).not.toHaveProperty("closesAt");

    const csv = await readFile(path(archive(keys, "csv")), "utf8");
    // the header IS the Standard-derived column set — the closed core dropped network/tag, the
    // org role split made the display org operatingOrganizations[0], and the single-currency rule
    // gave the row one `currency` that denominates every amount column after it. Asserted
    // VERBATIM: a later change to the core cannot reshape the published dataset silently.
    const header = csv.split("\n")[0] as string;
    expect(header).toBe(CSV_COLUMNS.join(","));
    expect(header).toBe(
      "id,fundingType,status,title,organization,organizationSlug,ecosystems,categories," +
        "currency,minAward,maxAward,budget,allocated,opensAt,nextDeadlineAt,rollingDeadline," +
        "applicationUrl",
    );
    expect(csv).toContain(fixtureId);
    // CSV flattens deadlines[] to the derived nextDeadlineAt
    expect(csv).toContain("2999-01-01T00:00:00.000Z");
    // and the one currency denominates the amounts in the same row
    const row = csv.split("\n").find((l) => l.startsWith(fixtureId)) as string;
    const cells = row.split(",");
    expect(cells[CSV_COLUMNS.indexOf("organization")]).toBe("Export Org");
    expect(cells[CSV_COLUMNS.indexOf("currency")]).toBe("USD");
    expect(cells[CSV_COLUMNS.indexOf("budget")]).toBe("12345");
    expect(cells[CSV_COLUMNS.indexOf("categories")]).toBe("Tooling");

    // the stable aliases are byte-identical to the archive they alias
    expect(await readFile(path("latest.json"), "utf8")).toBe(jsonText);
    expect(await readFile(path("latest.csv"), "utf8")).toBe(csv);

    const license = await readFile(path("LICENSE"), "utf8");
    expect(license).toContain("SPDX-License-Identifier: CC0-1.0");
    expect(license).toContain("CC0 1.0 Universal");

    // snapshots point at the ARCHIVE, not at the moving aliases, and the digest each row records
    // is the one embedded in the name that row points at
    const snapshots = await db
      .select()
      .from(datasetSnapshots)
      .where(like(datasetSnapshots.url, `${OUT}%`));
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((s) => s.format).sort()).toEqual(["csv", "json"]);
    expect(snapshots.every((s) => s.entryCount === count)).toBe(true);
    expect(snapshots.map((s) => s.url).sort()).toEqual(
      [path(archive(keys, "csv")), path(archive(keys, "json"))].sort(),
    );
    for (const s of snapshots) {
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.url).toContain(String(s.sha256).slice(0, 12));
    }

    expect((await readdir(OUT)).sort()).toEqual([...keys].sort());
  });

  // A second run on the same UTC day. Every archive is named after the bytes stored under it, so
  // one key never holds two different datasets and a re-run writes its own archive rather than
  // overwriting the one already there. The property holds whatever the data does — the other
  // integration suites are adding and removing rows in the same database while this runs, which is
  // precisely the case a claim of immutability has to survive.
  it("names every archive after its own bytes, so a re-run overwrites nothing", async () => {
    const first = await runExport({ outDir: OUT, minCount: 1 });
    const second = await runExport({ outDir: OUT, minCount: 1 });
    expect(second.date).toBe(first.date);

    const listing = await readdir(OUT);
    for (const r of [first, second]) {
      for (const ext of ["json", "csv"]) {
        const key = archive(
          r.artifacts.map((a) => a.key),
          ext,
        );
        expect(listing).toContain(key);
        const bytes = await readFile(join(OUT, key), "utf8");
        expect(key).toBe(`opportunities-${r.date}-${digest(bytes)}.${ext}`);
      }
    }
  });

  // The sink's own behaviour — key prefixing, header emission, URL construction — is covered by
  // test/unit/upload.test.ts against a stub. What is left to prove here is that the EXPORTER drives
  // a sink end-to-end: the same five keys in the same order, the immutable header reserved for the
  // content-addressed archive, and the archive's URL — not an alias — recorded in the snapshots.
  it("drives an object-store sink and records the archive object URL", async () => {
    const puts: { key: string; cacheControl?: string }[] = [];
    const client: S3Like = {
      async send(command: PutObjectCommand) {
        puts.push({ key: String(command.input.Key), cacheControl: command.input.CacheControl });
        return {};
      },
    };
    const sink = createS3Sink({ bucket: BUCKET, prefix: "", publicBaseUrl: "" }, client);
    const { count, artifacts } = await runExport({ sink, minCount: 1 });

    const keys = artifacts.map((a) => a.key);
    expect(puts.map((p) => p.key)).toEqual(keys);
    expect(keys).toEqual([
      "LICENSE",
      archive(keys, "json"),
      archive(keys, "csv"),
      "latest.json",
      "latest.csv",
    ]);
    // only the content-addressed archive may claim immutability; the stable keys are rewritten
    expect(puts.filter((p) => p.cacheControl?.includes("immutable")).map((p) => p.key)).toEqual([
      archive(keys, "json"),
      archive(keys, "csv"),
    ]);

    const snapshots = await db
      .select()
      .from(datasetSnapshots)
      .where(like(datasetSnapshots.url, `s3://${BUCKET}/%`));
    expect(snapshots.map((s) => s.url).sort()).toEqual(
      [`s3://${BUCKET}/${archive(keys, "csv")}`, `s3://${BUCKET}/${archive(keys, "json")}`].sort(),
    );
    expect(snapshots.every((s) => s.entryCount === count)).toBe(true);
  });

  // Nothing makes five objects land atomically. When one does not land, the failure has to say
  // which ones did — a bare EISDIR from writeFile says nothing about the state of the destination.
  it("names what was written and what failed when a write fails part-way", async () => {
    const out = join(ROOT, "partial");
    // a directory where `latest.csv` should go: the last write of the run fails, the four before it
    // have already landed
    await mkdir(join(out, "latest.csv"), { recursive: true });

    await expect(runExport({ outDir: out, minCount: 1 })).rejects.toThrow(ExportWriteError);
    await expect(runExport({ outDir: out, minCount: 1 })).rejects.toThrow(
      /failed to write latest\.csv after writing LICENSE, opportunities-.+, opportunities-.+, latest\.json/,
    );

    // no snapshot row claims a run that never finished writing
    expect(
      await db
        .select()
        .from(datasetSnapshots)
        .where(like(datasetSnapshots.url, `${out}%`)),
    ).toHaveLength(0);
  });

  it("refuses to publish below the floor, writing nothing, whichever path set the floor", async () => {
    const out = join(ROOT, "floor");
    const before = await db.select().from(datasetSnapshots);

    await expect(runExport({ outDir: out, minCount: 1_000_000 })).rejects.toThrow(ExportFloorError);
    await expect(runExport({ outDir: out, minCount: 1_000_000 })).rejects.toThrow(
      /refusing to publish: \d+ live opportunit(y|ies) is below the floor of 1000000/,
    );
    // and the floor is no weaker for a programmatic caller than for the environment variable
    await expect(runExport({ outDir: out, minCount: -1 })).rejects.toThrow(
      /minCount must be a non-negative integer/,
    );
    await expect(runExport({ outDir: out, minCount: 1.5 })).rejects.toThrow(
      /minCount must be a non-negative integer/,
    );

    // nothing was written at all: the directory was never even created
    await expect(readdir(out)).rejects.toThrow();
    expect(await db.select().from(datasetSnapshots)).toHaveLength(before.length);
  });
});
