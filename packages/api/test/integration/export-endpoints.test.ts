/**
 * The live full-dataset downloads over HTTP: what they serve, what they refuse, what they never
 * leak, how they revalidate — and the invariant the whole feature exists for, which is that a
 * download and a published archive of the same records are the same bytes.
 *
 * Gated on DATABASE_URL like the other integration suites. Seeds its own isolated fixtures
 * (ecosystem "LIVEEXPORT", ids "livexport:*") — including one PENDING and one UNLISTED record,
 * which the public-read invariant must keep out of both formats — and cleans them up.
 *
 * The empty-dataset case is at the bottom, ungated: the integration suites share one database and
 * cannot empty it, so it is asserted against the service with a stubbed read instead. It is the
 * case most likely to be got wrong, because the export WRITER refuses an empty dataset outright
 * (`ExportFloorError`) and a download must not inherit that — nothing is being replaced.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Opportunity } from "@the-rfp-hub/standard";
import { inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeExport } from "../../scripts/export-writer.js";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities, organizations } from "../../src/db/schema.js";
import { ExportService } from "../../src/modules/services/export/export.service.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { CSV_COLUMNS, EXPORT_LICENSE } from "../../src/modules/shared/export-format.js";
import { DOWNLOAD_CACHE_CONTROL } from "../../src/modules/shared/http-cache.js";
import { describeWithDb } from "./db-gate.js";

const run = describeWithDb;

const TAG = "LIVEEXPORT";
const JSON_URL = "/v1/export/opportunities.json";
const CSV_URL = "/v1/export/opportunities.csv";

const fixture = (over: Partial<Opportunity> & Pick<Opportunity, "id">): Opportunity =>
  ({
    specVersion: "1.0.0",
    fundingType: "grant",
    title: `Download fixture ${over.id}`,
    description: "A download fixture.",
    status: "open",
    operatingOrganizations: [{ name: "Download Org", slug: "livexport-org" }],
    source: { ingestedVia: "import", verifiedAgainstSource: null },
    ecosystems: [TAG],
    fundingDetails: { fundingType: "grant" },
    ...over,
  }) as Opportunity;

/** Parse RFC 4180 CSV into rows of cells: quoted fields may hold commas, newlines and `""`. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') {
        cell += c;
        continue;
      }
      if (text[i + 1] === '"') {
        cell += '"';
        i += 1;
        continue;
      }
      quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      continue;
    }
    if (c === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (c === "\r") continue;
    if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

run("GET /v1/export/opportunities.{json,csv}", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const service = new OpportunityService();
    // Visible. The two ids are chosen to tell CODE-UNIT ordering apart from a locale collation:
    // 'Z' (U+005A) sorts before 'a' (U+0061) by code unit, and after it under almost every
    // language-sensitive collation a database might apply.
    for (const record of [
      fixture({ id: "livexport:apple" }),
      fixture({ id: "livexport:Zebra" }),
      fixture({
        id: "livexport:hostile",
        // Every character that has to survive a CSV round trip, plus a formula prefix.
        title: '=cmd|" /c calc"!A1, "quoted", line\nbreak',
        applicationUrl: "https://example.org/apply?a=1&b=2",
      }),
    ]) {
      await service.upsertFromStandard(record, { reviewStatus: "approved", isListed: true });
    }
    // Invisible: the two halves of the public-read invariant.
    await service.upsertFromStandard(fixture({ id: "livexport:pending" }), {
      reviewStatus: "pending",
      isListed: true,
    });
    await service.upsertFromStandard(fixture({ id: "livexport:unlisted" }), {
      reviewStatus: "approved",
      isListed: false,
    });

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await db.delete(opportunities).where(like(opportunities.publicId, "livexport:%"));
    await db.delete(organizations).where(inArray(organizations.slug, ["livexport-org"]));
    await app.close();
    await pool.end();
  });

  const get = (url: string, headers?: Record<string, string>) =>
    app.inject({ method: "GET", url, headers });

  /**
   * The integration suites share one database and vitest runs their files in parallel, so the
   * dataset legitimately CAN change between two reads — every suite seeds and deletes its own
   * fixtures. The assertions that compare two reads to each other therefore retry until they
   * observe a settled pair. This weakens nothing: what is being asserted is compared exactly, and
   * the last attempt asserts unconditionally so a real mismatch fails with the real diff rather
   * than with "never settled".
   */
  const ATTEMPTS = 10;

  it("serves the whole public dataset as a JSON attachment in the published envelope", async () => {
    const res = await get(JSON_URL);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="opportunities-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers["cache-control"]).toBe(DOWNLOAD_CACHE_CONTROL);

    const body = JSON.parse(res.rawPayload.toString("utf8"));
    // The envelope `latest.json` carries, key for key — a consumer must be able to treat a live
    // download and a published snapshot as the same document.
    expect(Object.keys(body)).toEqual([
      "specVersion",
      "license",
      "generatedAt",
      "count",
      "opportunities",
    ]);
    expect(body.specVersion).toBe("1.0.0");
    expect(body.license).toBe(EXPORT_LICENSE);
    expect(body.count).toBe(body.opportunities.length);
    // `generatedAt` is NOW, not an ingest time: within a minute of the request either way.
    expect(Math.abs(Date.parse(body.generatedAt) - Date.now())).toBeLessThan(60_000);

    const ours = body.opportunities.filter((o: Opportunity) => o.id.startsWith("livexport:"));
    expect(ours.map((o: Opportunity) => o.id).sort()).toEqual([
      "livexport:Zebra",
      "livexport:apple",
      "livexport:hostile",
    ]);
    // Full Standard objects, not the list endpoint's thin projection.
    for (const record of ours) expect(record.fundingDetails).toBeTruthy();
  });

  it("never serves a record the rest of the API hides", async () => {
    const json = JSON.parse((await get(JSON_URL)).rawPayload.toString("utf8"));
    const csv = (await get(CSV_URL)).rawPayload.toString("utf8");

    for (const hidden of ["livexport:pending", "livexport:unlisted"]) {
      expect(json.opportunities.some((o: Opportunity) => o.id === hidden)).toBe(false);
      expect(csv).not.toContain(hidden);
    }
  });

  it("orders records by id ascending, compared by code unit", async () => {
    const { opportunities: records } = JSON.parse(
      (await get(JSON_URL)).rawPayload.toString("utf8"),
    );
    const ids = records.map((o: Opportunity) => o.id);

    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i - 1] < ids[i], `${ids[i - 1]} must precede ${ids[i]}`).toBe(true);
    }
    // The discriminating pair: uppercase before lowercase, which no locale collation would give.
    expect(ids.indexOf("livexport:Zebra")).toBeLessThan(ids.indexOf("livexport:apple"));
  });

  it("serves the same dataset as a CSV attachment with the published columns", async () => {
    const res = await get(CSV_URL);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="opportunities-\d{4}-\d{2}-\d{2}\.csv"$/,
    );

    const text = res.rawPayload.toString("utf8");
    expect(text.endsWith("\n")).toBe(true);
    const rows = parseCsv(text);
    const header = rows.shift() ?? [];
    expect(header).toEqual([...CSV_COLUMNS]);
    // Every row is exactly as wide as the header — the parse, not a substring match, proves it.
    expect(new Set(rows.map((r) => r.length))).toEqual(new Set([header.length]));

    const idColumn = header.indexOf("id");
    const hostile = rows.find((r) => r[idColumn] === "livexport:hostile");
    // The formula-injection guard survived the round trip through HTTP.
    expect(hostile?.[header.indexOf("title")]).toBe('\'=cmd|" /c calc"!A1, "quoted", line\nbreak');
  });

  it("serves the same records in the same order in both formats", async () => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const json = JSON.parse((await get(JSON_URL)).rawPayload.toString("utf8"));
      const rows = parseCsv((await get(CSV_URL)).rawPayload.toString("utf8"));
      const header = rows.shift() ?? [];
      const csvIds = rows.map((r) => r[header.indexOf("id")]);
      const jsonIds = json.opportunities.map((o: Opportunity) => o.id);

      const settled = csvIds.length === jsonIds.length;
      if (settled || attempt === ATTEMPTS - 1) {
        expect(csvIds).toEqual(jsonIds);
        return;
      }
    }
  });

  /**
   * A poll, then a revalidation of it whose `If-None-Match` was built from THAT poll's tag. The
   * pair has to be retried: a sibling suite committing a fixture in between moves the dataset, and
   * a tag that is correctly stale is a 200, not a bug.
   */
  async function revalidate(url: string, header: (etag: string) => string) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const fresh = await get(url);
      const etag = String(fresh.headers.etag);
      const res = await get(url, { "if-none-match": header(etag) });
      if (res.statusCode === 304) return { fresh, etag, res };
    }
    throw new Error(`${url} never revalidated to a 304 in ${ATTEMPTS} attempts`);
  }

  it("revalidates to a 304 that keeps the validator and the cache policy", async () => {
    for (const url of [JSON_URL, CSV_URL]) {
      const { fresh, etag, res } = await revalidate(url, (tag) => tag);

      expect(res.rawPayload.length, url).toBe(0);
      // RFC 9110 §15.4.5: a client that revalidates repeatedly must keep a usable cache entry.
      expect(res.headers.etag, url).toBe(etag);
      expect(res.headers["cache-control"], url).toBe(DOWNLOAD_CACHE_CONTROL);
      expect(res.headers["content-disposition"], url).toBe(fresh.headers["content-disposition"]);
    }
  });

  it("honours every form of If-None-Match the specification defines", async () => {
    for (const url of [JSON_URL, CSV_URL]) {
      // `*` matches any existing representation, and a comma-separated list matches if the tag is
      // anywhere in it (RFC 9110 §13.1.2). The weak comparison ignores a `W/` on either side, so
      // an intermediary that weakened a strong tag still gets its 304.
      for (const header of [
        (_tag: string) => "*",
        (tag: string) => `"other", ${tag}`,
        (tag: string) => (tag.startsWith("W/") ? tag.slice(2) : `W/${tag}`),
      ]) {
        await revalidate(url, header); // throws if it never reaches a 304
      }
      // A tag that is not this representation's is a full response, not a 304.
      expect((await get(url, { "if-none-match": '"not-the-tag"' })).statusCode, url).toBe(200);
    }
  });

  it("tags the JSON weakly and the CSV strongly, and neither from the request clock", async () => {
    // The JSON body carries `generatedAt`, so its bytes differ between two requests over identical
    // data — a strong tag would be a false claim, and a tag taken from the body would never yield
    // a 304. The CSV holds no timestamp, so it can and does promise byte-equality.
    const json = await get(JSON_URL);
    expect(String(json.headers.etag)).toMatch(/^W\/"[A-Za-z0-9_-]{27}"$/);

    const csv = await get(CSV_URL);
    expect(String(csv.headers.etag)).toMatch(/^"[A-Za-z0-9_-]{27}"$/);

    // Unchanged data, unchanged tags — the tag must move with the DATASET, not with the clock.
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const [firstJson, secondJson] = [await get(JSON_URL), await get(JSON_URL)];
      const [firstCsv, secondCsv] = [await get(CSV_URL), await get(CSV_URL)];
      const settled = secondCsv.rawPayload.equals(firstCsv.rawPayload);
      if (settled || attempt === ATTEMPTS - 1) {
        expect(secondJson.headers.etag).toBe(firstJson.headers.etag);
        expect(secondCsv.headers.etag).toBe(firstCsv.headers.etag);
        // …and where the two responses were stamped at different milliseconds, their bytes really
        // did differ under that one shared tag — which is exactly why the JSON tag is weak. (Two
        // requests can land in the same millisecond, and then there is nothing to observe.)
        const stampOf = (payload: Buffer) => JSON.parse(payload.toString("utf8")).generatedAt;
        if (stampOf(firstJson.rawPayload) !== stampOf(secondJson.rawPayload)) {
          expect(secondJson.rawPayload.equals(firstJson.rawPayload)).toBe(false);
        }
        return;
      }
    }
  });

  it("400s on any query parameter at all, instead of ignoring it", async () => {
    for (const url of [JSON_URL, CSV_URL]) {
      for (const query of [
        "?nope=1", // an undocumented parameter
        "?stauts=open", // a typo is an undocumented parameter
        "?status=open", // a real parameter of the LIST endpoint, not of this one
        "?limit=10",
        "?page=2",
        "?fundingType=grant",
        "?format=csv",
      ]) {
        const res = await get(url + query);
        expect(res.statusCode, url + query).toBe(400);
        expect(res.json().error, url + query).toBe("bad_request");
        expect(typeof res.json().message, url + query).toBe("string");
      }
    }
  });

  /**
   * THE INVARIANT. A live download and a published archive of the same records must be the same
   * bytes, or a consumer cannot treat the two interchangeably and every claim this feature makes
   * is false.
   *
   * The CSV is compared byte for byte. The JSON is compared byte for byte after `generatedAt` — the
   * one field that is a timestamp rather than data, and the only licensed difference between the
   * two documents — is normalized away on both sides.
   *
   * `minCount: 0` on the writer because a test fixture set is far under the publication floor; the
   * floor is what stops a short run from replacing a good dataset, and nothing is being replaced
   * here.
   */
  it("serves byte-for-byte what the export writer would publish from the same records", async () => {
    const outRoot = await mkdtemp(join(tmpdir(), "rfphub-live-export-"));
    const stripStamp = (json: string) =>
      json.replace(/^ {2}"generatedAt": ".*",$/m, '  "generatedAt": "<normalized>",');

    try {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const outDir = join(outRoot, `run-${attempt}`);
        const served = {
          json: (await get(JSON_URL)).rawPayload.toString("utf8"),
          csv: (await get(CSV_URL)).rawPayload.toString("utf8"),
        };
        // The writer's own input, read the way the export command reads it.
        await writeExport(await new OpportunityService().listAll(), { outDir, minCount: 0 });
        const published = {
          json: await readFile(join(outDir, "latest.json"), "utf8"),
          csv: await readFile(join(outDir, "latest.csv"), "utf8"),
        };

        // A sibling suite committing a fixture between the two reads is a moved dataset, not a
        // format mismatch — retry, but assert unconditionally on the final attempt so a genuine
        // divergence fails with the diff rather than with a timeout.
        const settled = served.csv === published.csv;
        if (settled || attempt === ATTEMPTS - 1) {
          expect(served.csv).toBe(published.csv);
          expect(stripStamp(served.json)).toBe(stripStamp(published.json));
          // The normalization removed exactly one line from each, and nothing else.
          expect(stripStamp(served.json)).not.toBe(served.json);
          expect(stripStamp(published.json)).not.toBe(published.json);
          return;
        }
      }
    } finally {
      await rm(outRoot, { recursive: true, force: true });
    }
  });

  it("documents both operations in the served OpenAPI document", async () => {
    const doc = (await get("/v1/docs/json")).json();

    const documented: [path: string, operationId: string, mediaType: string][] = [
      [JSON_URL, "downloadOpportunitiesJson", "application/json"],
      [CSV_URL, "downloadOpportunitiesCsv", "text/csv"],
    ];
    for (const [path, operationId, mediaType] of documented) {
      const operation = doc.paths?.[path]?.get;
      expect(operation, `${path} is documented`).toBeTruthy();
      expect(operation.operationId).toBe(operationId);
      expect(operation.tags).toEqual(["export"]);
      // Exactly the media type served, and only that one.
      expect(Object.keys(operation.responses["200"].content)).toEqual([mediaType]);
      expect(operation.responses["400"], "the strict query contract is published").toBeTruthy();
      // No parameters at all — the contract is that the download takes none.
      expect(operation.parameters ?? []).toEqual([]);
      // The attachment behaviour is stated where a consumer reads the contract.
      expect(operation.description).toMatch(/attachment/i);
    }

    // The service's own index advertises them.
    const info = (await get("/")).json();
    expect(info.endpoints).toEqual(expect.arrayContaining([JSON_URL, CSV_URL]));
  });
});

/**
 * The empty dataset — asserted against the service, because the shared integration database cannot
 * be emptied. A download of nothing is a valid, complete document and a 200's worth of bytes; it is
 * NOT the `ExportFloorError` the writer raises, because a download replaces no published file.
 */
describe("a download of an empty dataset", () => {
  const emptyService = () =>
    new ExportService({ listAll: async () => [] } as unknown as OpportunityService);

  it("serves a valid empty envelope rather than an error", async () => {
    const rendered = await emptyService().render("json", new Date("2026-08-13T09:41:00.000Z"));
    const body = JSON.parse(rendered.body.toString("utf8"));

    expect(rendered.recordCount).toBe(0);
    expect(body).toEqual({
      specVersion: "1.0.0",
      license: EXPORT_LICENSE,
      generatedAt: "2026-08-13T09:41:00.000Z",
      count: 0,
      opportunities: [],
    });
    expect(rendered.filename).toBe("opportunities-2026-08-13.json");
    expect(rendered.contentType).toBe("application/json; charset=utf-8");
    // A tag is still issued, so an empty dataset revalidates like any other.
    expect(rendered.etag).toMatch(/^W\/"[A-Za-z0-9_-]{27}"$/);
  });

  it("serves the CSV header row alone, not an empty body", async () => {
    const rendered = await emptyService().render("csv", new Date("2026-08-13T09:41:00.000Z"));

    expect(rendered.body.toString("utf8")).toBe(`${CSV_COLUMNS.join(",")}\n`);
    expect(rendered.body.length).toBeGreaterThan(0);
    expect(rendered.filename).toBe("opportunities-2026-08-13.csv");
    expect(rendered.etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
  });

  it("names the download after the UTC date, wherever the caller is", async () => {
    // 00:30 UTC on the 13th is still the 12th in half the world; the name follows the stamp in the
    // envelope, not the reader's calendar.
    const rendered = await emptyService().render("json", new Date("2026-08-13T00:30:00.000Z"));
    expect(rendered.filename).toBe("opportunities-2026-08-13.json");
  });
});
