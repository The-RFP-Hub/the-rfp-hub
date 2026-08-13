/**
 * DB-gated export test: seed a fixture, run the exporter to a temp dir, and assert the written
 * file set + dataset_snapshots rows. Also covers the EXPORT_MIN_COUNT floor, the content-addressed
 * archive names, and the partial-write failure. Self-cleaning. Gated on DATABASE_URL.
 *
 * The alias pair's all-or-nothing promotion is pinned twice: end-to-end here, and directly against
 * `promoteAliases` in the ungated block at the bottom, which needs no database.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Opportunity } from "@the-rfp-hub/standard";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ExportFloorError,
  ExportWriteError,
  MANIFEST_NAME,
  promoteAliases,
} from "../../scripts/export-writer.js";
import { runExport } from "../../scripts/export.js";
import { db, pool } from "../../src/db/client.js";
import { datasetSnapshots, opportunities, organizations } from "../../src/db/schema.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { CSV_COLUMNS } from "../../src/modules/shared/export-format.js";
import { describeWithDb } from "./db-gate.js";

const run = describeWithDb;
const ROOT = join(tmpdir(), "rfphub-export-test");
const OUT = join(ROOT, "run");
const fixtureId = "etest:export-1";

/**
 * Seed one listed, approved entry. Taking the id makes a row a MARKER: an alias that contains it is
 * demonstrably on the run that followed the seed, which is what makes "which run is this alias on"
 * an answerable question at all — over unchanged data the CSV is byte-identical across runs.
 */
const seedFixture = async (id: string, title: string): Promise<void> => {
  await new OpportunityService().upsertFromStandard(
    {
      specVersion: "1.0.0",
      id,
      fundingType: "grant",
      title,
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
};

/** Staging files the promotion should never leave behind. */
const temps = (names: string[]): string[] => names.filter((n) => n.endsWith(".tmp"));

/** The digest prefix an archive name carries, computed from the bytes stored under it. */
const digest = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** The archive name of one format out of a run's written file set. */
const archive = (names: string[], ext: string): string => {
  const hit = names.find((n) => n.startsWith("opportunities-") && n.endsWith(`.${ext}`));
  if (!hit) throw new Error(`no ${ext} archive in ${names.join(", ")}`);
  return hit;
};

run("open-data export", () => {
  beforeAll(async () => {
    await seedFixture(fixtureId, "Export Fixture");
  });

  afterAll(async () => {
    await db.delete(datasetSnapshots).where(like(datasetSnapshots.url, `${ROOT}%`));
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
    const names = artifacts.map((a) => a.name);
    expect(names).toEqual([
      "LICENSE",
      archive(names, "json"),
      archive(names, "csv"),
      "latest.json",
      "latest.csv",
      MANIFEST_NAME,
    ]);
    expect(archive(names, "json")).toMatch(
      new RegExp(`^opportunities-${date}-[0-9a-f]{12}\\.json$`),
    );

    const path = (name: string): string => join(OUT, name);
    const jsonText = await readFile(path(archive(names, "json")), "utf8");
    const json = JSON.parse(jsonText);
    expect(json.license).toBe("CC0-1.0");
    expect(json.specVersion).toBe("1.0.0");
    expect(json.count).toBe(count);
    // `generatedAt` comes from the CLOCK, not from the data. That is why a re-run over unchanged
    // data is byte-identical in CSV but not in JSON — the envelope, its digest and its archive name
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

    const csv = await readFile(path(archive(names, "csv")), "utf8");
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
      [path(archive(names, "csv")), path(archive(names, "json"))].sort(),
    );
    for (const s of snapshots) {
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.url).toContain(String(s.sha256).slice(0, 12));
    }

    expect((await readdir(OUT)).sort()).toEqual([...names].sort());
  });

  // A second run on the same UTC day. Every archive is named after the bytes stored under it, so
  // one name never holds two different datasets and a re-run writes its own archive rather than
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
        const name = archive(
          r.artifacts.map((a) => a.name),
          ext,
        );
        expect(listing).toContain(name);
        const bytes = await readFile(join(OUT, name), "utf8");
        expect(name).toBe(`opportunities-${r.date}-${digest(bytes)}.${ext}`);
      }
    }
  });

  // Nothing makes five files land atomically. When one does not land, the failure has to say which
  // ones did — a bare EISDIR from writeFile says nothing about the state of the destination.
  //
  // The ALIAS PAIR carries a stronger obligation than the rest of the file set: `latest.json` and
  // `latest.csv` are read together, so a run that cannot finish must advance NEITHER — not the one
  // that happens to be written first. Writing them in sequence advanced `latest.json` and then
  // failed on `latest.csv`, leaving the pair straddling two runs with nothing to signal it.
  it("names what was written and what failed, and advances neither alias, when a write fails", async () => {
    const out = join(ROOT, "partial");

    // a COMPLETE run first — this is the pair the failed run has to leave exactly where it is
    const complete = await runExport({ outDir: out, minCount: 1 });
    const before = await readFile(join(out, "latest.json"), "utf8");
    const snapshotsBefore = await db
      .select()
      .from(datasetSnapshots)
      .where(like(datasetSnapshots.url, `${out}%`));

    // a row only a LATER run can carry, so "which run is this alias on" has an answer
    const marker = "etest:export-partial";
    await seedFixture(marker, "Export Fixture (partial)");
    expect(before).not.toContain(marker);

    // a directory where `latest.csv` belongs: rename cannot replace it, so the run cannot complete
    // its pair. Making a destination unusable is the only way to fail one alias from outside the
    // exporter, and it costs the test the ability to read `latest.csv` back — which is why the
    // all-or-nothing contract is ALSO driven straight at `promoteAliases` below, with both aliases
    // left readable.
    await rm(join(out, "latest.csv"));
    await mkdir(join(out, "latest.csv"), { recursive: true });

    await expect(runExport({ outDir: out, minCount: 1 })).rejects.toThrow(ExportWriteError);

    // THE INVARIANT, asserted before anything about the message: `latest.json` was not moved onto a
    // run whose `latest.csv` never landed. It is byte-for-byte the alias the last complete run left
    // behind, and it does not carry the row that only the failed run could have brought.
    const after = await readFile(join(out, "latest.json"), "utf8");
    expect(after).toBe(before);
    expect(after).not.toContain(marker);

    // and the failed run left no staging beside it
    expect(temps(await readdir(out))).toEqual([]);

    // the manifest is still the last COMPLETE run's: the pointer never advanced onto a run that
    // could not finish, so a consumer resolving it gets the newest run that actually published
    const manifest = JSON.parse(await readFile(join(out, MANIFEST_NAME), "utf8"));
    expect(manifest.runId).toBe(complete.manifest.runId);
    expect(manifest).toEqual(complete.manifest);

    // the sidecar and both archives landed; NEITHER alias is named as written, because neither was
    await expect(runExport({ outDir: out, minCount: 1 })).rejects.toThrow(
      /failed to write latest\.csv after writing LICENSE, opportunities-\S+, opportunities-\S+ —/,
    );

    // no snapshot row claims a run that never finished writing — only the complete one is recorded
    const snapshotsAfter = await db
      .select()
      .from(datasetSnapshots)
      .where(like(datasetSnapshots.url, `${out}%`));
    expect(snapshotsAfter.map((s) => s.url).sort()).toEqual(
      snapshotsBefore.map((s) => s.url).sort(),
    );
    expect(snapshotsBefore).toHaveLength(2);
  });

  // The other half of the same promise: when a run DOES complete, both aliases move, together, onto
  // it. An alias pair that never mismatches by never advancing would satisfy the invariant and be
  // useless.
  it("advances both aliases onto the run that completed", async () => {
    const out = join(ROOT, "pair");
    const marker = "etest:export-pair";

    await runExport({ outDir: out, minCount: 1 });
    expect(await readFile(join(out, "latest.json"), "utf8")).not.toContain(marker);
    expect(await readFile(join(out, "latest.csv"), "utf8")).not.toContain(marker);

    await seedFixture(marker, "Export Fixture (pair)");
    const second = await runExport({ outDir: out, minCount: 1 });
    const names = second.artifacts.map((a) => a.name);

    // both aliases carry the new row, and both are byte-identical to THIS run's archives — one run,
    // named twice, not two runs named once each
    const latestJson = await readFile(join(out, "latest.json"), "utf8");
    const latestCsv = await readFile(join(out, "latest.csv"), "utf8");
    expect(latestJson).toContain(marker);
    expect(latestCsv).toContain(marker);
    expect(latestJson).toBe(await readFile(join(out, archive(names, "json")), "utf8"));
    expect(latestCsv).toBe(await readFile(join(out, archive(names, "csv")), "utf8"));
    expect(names.slice(-3)).toEqual(["latest.json", "latest.csv", MANIFEST_NAME]);

    // promotion leaves no staging behind on the happy path either
    expect(temps(await readdir(out))).toEqual([]);
  });

  /**
   * The manifest is the answer to the question the alias pair cannot answer. Two independently
   * named mutable files cannot be replaced as a pair, so a consumer fetching both can catch one of
   * each run; a consumer that reads the manifest ONCE gets a single run's identity plus the
   * immutable names and full digests of both archives, and can verify what it downloaded.
   *
   * So what is pinned here is exactly the consumer's procedure: resolve the pointer once, fetch
   * what it names, hash the bytes, compare.
   */
  it("publishes a manifest naming both archives with their full digests, promoted last", async () => {
    const out = join(ROOT, "manifest");
    const { artifacts, manifest, count, date, directorySynced } = await runExport({
      outDir: out,
      minCount: 1,
    });
    const names = artifacts.map((a) => a.name);

    // ONE rename, and it is the last thing the run does: everything the manifest names was on disk
    // before the pointer to it existed, so a manifest a consumer can read never outruns its data.
    expect(names.at(-1)).toBe(MANIFEST_NAME);

    const published = JSON.parse(await readFile(join(out, MANIFEST_NAME), "utf8"));
    expect(published).toEqual(manifest);
    expect(published.runId).toMatch(/^[0-9a-f]{32}$/);
    expect(published.count).toBe(count);
    expect(published.license).toBe("CC0-1.0");
    expect(published.specVersion).toBe("1.0.0");
    expect(Date.parse(published.generatedAt)).toBeGreaterThan(0);

    // It names the IMMUTABLE archives, never the aliases — an alias href would reintroduce exactly
    // the mutability the manifest exists to route around.
    expect(published.artifacts.map((a: { format: string }) => a.format)).toEqual(["json", "csv"]);
    for (const artifact of published.artifacts) {
      expect(artifact.href).toBe(archive(names, artifact.format));
      expect(artifact.href).not.toContain("latest.");
      expect(artifact.count).toBe(count);
      // the FULL sha256, not the 12-hex prefix the name carries: a consumer verifies the bytes it
      // downloaded, and 48 bits of name is an addressing scheme rather than a checksum
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      const bytes = await readFile(join(out, artifact.href), "utf8");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
      expect(artifact.href).toContain(artifact.sha256.slice(0, 12));
      expect(artifact.href).toContain(date);
    }

    // The directory fsync is reported, not asserted: everywhere it is permitted it is expected to
    // have happened, and where it is not the run says so instead of claiming a durability it
    // did not obtain.
    expect(typeof directorySynced).toBe("boolean");
    if (process.platform !== "win32") expect(directorySynced).toBe(true);
  });

  // A run identity the alias pair genuinely cannot carry: over unchanged data the CSV is
  // byte-identical across same-day runs, so its archive name is too. The manifest is what tells
  // two such runs apart, and what a later run advances as one indivisible step.
  it("mints a fresh run id per run and advances the manifest to the newest one", async () => {
    const out = join(ROOT, "manifest-runs");
    const first = await runExport({ outDir: out, minCount: 1 });
    const second = await runExport({ outDir: out, minCount: 1 });

    expect(second.manifest.runId).not.toBe(first.manifest.runId);
    const current = JSON.parse(await readFile(join(out, MANIFEST_NAME), "utf8"));
    expect(current.runId).toBe(second.manifest.runId);

    // the first run's archives are still on disk and still hash to what its manifest recorded, so a
    // consumer holding the older manifest keeps a consistent, verifiable pair
    for (const artifact of first.manifest.artifacts) {
      const bytes = await readFile(join(out, artifact.href), "utf8");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
    }
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

/**
 * The alias-pair guarantee on its own terms. No database: `promoteAliases` is a filesystem
 * operation, and driving it directly is the only way to watch BOTH aliases across a failure —
 * failing one alias through a full export means making its destination unusable, which destroys the
 * very file the assertion has to read back. So this runs even when the DB-gated suites above skip.
 */
describe("export alias promotion", () => {
  const ROOT_A = join(tmpdir(), "rfphub-export-alias-test");

  afterAll(async () => {
    await rm(ROOT_A, { recursive: true, force: true });
  });

  it("promotes the whole alias set or none of it, leaving every alias on one run", async () => {
    const out = join(ROOT_A, "atomic");
    await mkdir(out, { recursive: true });
    const read = (n: string): Promise<string> => readFile(join(out, n), "utf8");
    const runA = { json: '{"run":"A"}\n', csv: "run\nA\n" };
    const runB = { json: '{"run":"B"}\n', csv: "run\nB\n" };

    const promoted = await promoteAliases(
      out,
      [
        { name: "latest.json", body: runA.json },
        { name: "latest.csv", body: runA.csv },
      ],
      [],
    );
    expect(promoted.map((a) => a.name)).toEqual(["latest.json", "latest.csv"]);
    expect(await read("latest.json")).toBe(runA.json);
    expect(await read("latest.csv")).toBe(runA.csv);

    // Run B cannot complete: one member of the set has a directory for a destination, the one entry
    // rename cannot replace. The member is a stand-in for whatever makes a promotion impossible —
    // a full disk, a read-only directory — and its position (last) is the point: the failure is
    // discovered only after the two real aliases were already staged and ready to go.
    await mkdir(join(out, "latest.blocked"), { recursive: true });
    await expect(
      promoteAliases(
        out,
        [
          { name: "latest.json", body: runB.json },
          { name: "latest.csv", body: runB.csv },
          { name: "latest.blocked", body: runB.json },
        ],
        ["LICENSE"],
      ),
    ).rejects.toThrow(ExportWriteError);

    // BOTH aliases are still on run A. Not one on A and one on B — that mismatch is the whole
    // point, because a consumer reads the pair together and nothing in the pair would admit to it.
    expect(await read("latest.json")).toBe(runA.json);
    expect(await read("latest.csv")).toBe(runA.csv);

    // and nothing staged for the abandoned run is left lying beside them
    expect((await readdir(out)).sort()).toEqual(["latest.blocked", "latest.csv", "latest.json"]);
  });

  it("reports which files were already written when it refuses to promote", async () => {
    const out = join(ROOT_A, "message");
    await mkdir(join(out, "latest.csv"), { recursive: true });

    await expect(
      promoteAliases(
        out,
        [
          { name: "latest.json", body: "{}\n" },
          { name: "latest.csv", body: "x\n" },
        ],
        ["LICENSE", "opportunities-2026-01-01-0123456789ab.json"],
      ),
    ).rejects.toThrow(
      /failed to write latest\.csv after writing LICENSE, opportunities-2026-01-01-0123456789ab\.json/,
    );

    // the first alias was never created, let alone advanced
    expect((await readdir(out)).sort()).toEqual(["latest.csv"]);
  });
});
