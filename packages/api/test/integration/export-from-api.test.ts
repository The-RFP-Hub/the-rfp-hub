/**
 * The API-sourced export, driven end to end against a REAL HTTP server on a loopback port.
 *
 * No database and no gate: this path has neither, which is half of what it exists to prove. The
 * server is a stub rather than the Fastify app because every test here is about what the exporter
 * does with an answer it did not choose — pages that must be joined, a `/v1/stats` total that
 * disagrees with them, a record the Standard rejects, a dataset too small to publish. A real
 * database serving correct data can produce none of those on demand.
 *
 * What the happy path asserts is the SAME six-file layout the database-sourced export is held to,
 * because both go through one writer: same order, same content-addressed names, same aliases, same
 * manifest with digests that re-hash. Nothing about the format is re-implemented here — if it
 * drifted, it drifted for both sources at once, which is the point of the split.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Opportunity } from "@the-rfp-hub/standard";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { CSV_COLUMNS } from "../../scripts/csv.js";
import {
  ExportCountError,
  ExportSchemaError,
  ExportSourceError,
  fetchDataset,
  parseApiExportOptions,
  readApiBaseUrl,
  runApiExport,
} from "../../scripts/export-from-api.js";
import { ExportFloorError, MANIFEST_NAME } from "../../scripts/export-writer.js";

const ROOT = join(tmpdir(), "rfphub-export-api-test");

/** A schema-valid Standard document. `n` orders the ids; the fixtures are otherwise identical. */
const fixture = (n: number): Opportunity =>
  ({
    specVersion: "1.0.0",
    id: `etest:api-${n}`,
    fundingType: "grant",
    title: `API Fixture ${n}`,
    description: "d",
    status: "open",
    operatingOrganizations: [{ name: "Export Org", slug: "export-org" }],
    source: { ingestedVia: "import", verifiedAgainstSource: null },
    ecosystems: ["EXPORTTEST"],
    categories: ["Tooling"],
    fundingInfo: { budget: 12345, currency: "USD" },
    deadlines: [{ deadlineType: "fixed", date: "2999-01-01T00:00:00.000Z", label: "application" }],
    fundingDetails: { fundingType: "grant" },
  }) satisfies Opportunity;

/** The THIN list projection the real list endpoint serves: everything but `fundingDetails`. */
const summarize = (doc: Opportunity): Record<string, unknown> => {
  const { fundingDetails: _omitted, ...rest } = doc;
  return rest;
};

interface Stub {
  /** Documents, in the order the list endpoint serves them. */
  docs: Opportunity[];
  /** What `/v1/stats` reports. Defaults to `docs.length` — set it to disagree on purpose. */
  statsTotal?: number;
  /** Records per page, whatever the client asks for. Small values force a multi-page walk. */
  pageSize?: number;
  /** Replace one document's detail response, by id. */
  detail?: (id: string) => { status: number; body: unknown } | undefined;
}

interface Stubbed {
  baseUrl: string;
  /** Every path+query the server was asked for, in order. */
  requests: string[];
}

const servers: Server[] = [];

/** Start a stub `/v1/` API on a loopback port. Closed by the suite's `afterEach`. */
async function startApi(stub: Stub): Promise<Stubbed> {
  const pageSize = stub.pageSize ?? 100;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(`${url.pathname}${url.search}`);
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/v1/stats") {
      return send(200, {
        total: stub.statsTotal ?? stub.docs.length,
        byFundingType: {},
        byStatus: {},
        topEcosystems: [],
        lastUpdatedAt: null,
      });
    }

    if (url.pathname === "/v1/opportunities") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const items = stub.docs.slice((page - 1) * pageSize, page * pageSize).map(summarize);
      return send(200, {
        items,
        page,
        limit: pageSize,
        total: stub.docs.length,
        totalPages: Math.max(1, Math.ceil(stub.docs.length / pageSize)),
      });
    }

    const match = /^\/v1\/opportunities\/(.+)$/.exec(url.pathname);
    if (match) {
      const id = decodeURIComponent(match[1] as string);
      const override = stub.detail?.(id);
      if (override) return send(override.status, override.body);
      const doc = stub.docs.find((d) => d.id === id);
      return doc ? send(200, doc) : send(404, { error: "not_found" });
    }

    send(404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

/** The archive name of one format out of a run's written file set. */
const archive = (names: string[], ext: string): string => {
  const hit = names.find((n) => n.startsWith("opportunities-") && n.endsWith(`.${ext}`));
  if (!hit) throw new Error(`no ${ext} archive in ${names.join(", ")}`);
  return hit;
};

describe("API-sourced export", () => {
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  it("joins every page into one dataset and publishes the six-file layout", async () => {
    const out = join(ROOT, "happy");
    // Served in a scrambled order across THREE pages: the walk has to join them, and the writer has
    // to publish them in `id` order regardless of the order the API happened to hand them over in.
    const docs = [3, 1, 5, 2, 4].map(fixture);
    const { baseUrl, requests } = await startApi({ docs, pageSize: 2 });

    const { count, artifacts, manifest, date } = await runApiExport({
      baseUrl,
      outDir: out,
      minCount: 1,
    });
    expect(count).toBe(5);

    // every page was actually requested, and every record was hydrated from the DETAIL endpoint —
    // the list projection omits `fundingDetails`, which the Standard requires
    expect(requests.filter((r) => r.startsWith("/v1/opportunities?"))).toHaveLength(3);
    expect(requests.filter((r) => /^\/v1\/opportunities\/[^?]+$/.test(r))).toHaveLength(5);
    expect(requests[0]).toBe("/v1/stats");

    // the same layout, in the same order, as the database-sourced export: one writer, one format
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
    expect((await readdir(out)).sort()).toEqual([...names].sort());

    const path = (name: string): string => join(out, name);
    const jsonText = await readFile(path(archive(names, "json")), "utf8");
    const json = JSON.parse(jsonText);
    expect(json.license).toBe("CC0-1.0");
    expect(json.specVersion).toBe("1.0.0");
    expect(json.count).toBe(5);
    // joined AND ordered: all five records, sorted by id, not in the order the pages arrived
    expect(json.opportunities.map((o: Opportunity) => o.id)).toEqual([
      "etest:api-1",
      "etest:api-2",
      "etest:api-3",
      "etest:api-4",
      "etest:api-5",
    ]);
    // the full detail document travelled, not the thin list projection
    expect(json.opportunities[0].fundingDetails).toEqual({ fundingType: "grant" });

    const csvText = await readFile(path(archive(names, "csv")), "utf8");
    const lines = csvText.trim().split("\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual(
      json.opportunities.map((o: Opportunity) => o.id),
    );

    // the aliases are this run's archives byte for byte
    expect(await readFile(path("latest.json"), "utf8")).toBe(jsonText);
    expect(await readFile(path("latest.csv"), "utf8")).toBe(csvText);
    expect(await readFile(path("LICENSE"), "utf8")).toContain("SPDX-License-Identifier: CC0-1.0");

    // and the manifest is verified the way a consumer must: hash what it names, compare
    const published = JSON.parse(await readFile(path(MANIFEST_NAME), "utf8"));
    expect(published).toEqual(manifest);
    expect(published.count).toBe(5);
    for (const entry of published.artifacts) {
      const bytes = await readFile(path(entry.href), "utf8");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
      expect(entry.href).not.toContain("latest.");
    }
  });

  it("refuses to publish when the fetched records and /v1/stats disagree", async () => {
    const out = join(ROOT, "mismatch");
    const docs = [1, 2, 3].map(fixture);
    const { baseUrl } = await startApi({ docs, statsTotal: 4 });

    await expect(runApiExport({ baseUrl, outDir: out, minCount: 1 })).rejects.toThrow(
      ExportCountError,
    );
    await expect(runApiExport({ baseUrl, outDir: out, minCount: 1 })).rejects.toThrow(
      /Fetched 3 record\(s\); \/v1\/stats reports 4/,
    );
    // nothing was written at all: the directory was never even created
    await expect(readdir(out)).rejects.toThrow();
  });

  it("refuses to publish when a page repeats an id it already served", async () => {
    const out = join(ROOT, "duplicate");
    // four rows served, one of them twice — the count adds up, the dataset does not
    const docs = [1, 2, 2, 3].map(fixture);
    const { baseUrl } = await startApi({ docs, pageSize: 2 });

    await expect(runApiExport({ baseUrl, outDir: out, minCount: 1 })).rejects.toThrow(
      /page 2 repeated the id etest:api-2/,
    );
    await expect(readdir(out)).rejects.toThrow();
  });

  it("refuses to publish when any served record fails the Standard", async () => {
    const out = join(ROOT, "invalid");
    const docs = [1, 2, 3].map(fixture);
    // one record served without `fundingDetails` — a REQUIRED property, and exactly what the thin
    // list projection omits, so this is also what publishing the list without hydrating would do
    const thin = summarize(fixture(2));
    const { baseUrl } = await startApi({
      docs,
      detail: (id) => (id === "etest:api-2" ? { status: 200, body: thin } : undefined),
    });

    await expect(runApiExport({ baseUrl, outDir: out, minCount: 1 })).rejects.toThrow(
      ExportSchemaError,
    );
    await expect(runApiExport({ baseUrl, outDir: out, minCount: 1 })).rejects.toThrow(
      /1 record\(s\) do not validate[\s\S]*etest:api-2/,
    );
    await expect(readdir(out)).rejects.toThrow();
  });

  it("refuses to publish below the floor, and an empty API is that case", async () => {
    const short = join(ROOT, "short");
    const { baseUrl } = await startApi({ docs: [1, 2, 3].map(fixture) });
    await expect(runApiExport({ baseUrl, outDir: short, minCount: 100 })).rejects.toThrow(
      ExportFloorError,
    );
    await expect(readdir(short)).rejects.toThrow();

    // A deployment whose data has not been loaded yet: /v1/stats agrees with the list (both zero),
    // so the count check passes and the FLOOR is what stands between an empty API and an empty
    // `latest.json` replacing a good one.
    const empty = join(ROOT, "empty");
    const { baseUrl: emptyUrl } = await startApi({ docs: [] });
    await expect(runApiExport({ baseUrl: emptyUrl, outDir: empty, minCount: 1 })).rejects.toThrow(
      /refusing to publish: 0 live opportunities is below the floor of 1/,
    );
    await expect(readdir(empty)).rejects.toThrow();
  });

  it("gives up on a detail endpoint that keeps failing, and publishes nothing", async () => {
    const out = join(ROOT, "broken");
    const docs = [1, 2].map(fixture);
    const { baseUrl } = await startApi({
      docs,
      detail: (id) =>
        id === "etest:api-2" ? { status: 500, body: { error: "internal" } } : undefined,
    });

    await expect(runApiExport({ baseUrl, outDir: out, minCount: 1 })).rejects.toThrow(
      ExportSourceError,
    );
    await expect(readdir(out)).rejects.toThrow();
  });

  it("returns the fetched dataset without writing anything", async () => {
    const docs = [2, 1].map(fixture);
    const { baseUrl } = await startApi({ docs });

    const { items, reported } = await fetchDataset(baseUrl);
    expect(reported).toBe(2);
    // the SOURCE hands over what the API served, in the API's order — ordering is the writer's job
    expect(items.map((i) => i.id)).toEqual(["etest:api-2", "etest:api-1"]);
  });
});

/**
 * The source URL is a published-dataset control: it decides what gets written under this project's
 * name, so the rules it is held to are asserted directly rather than inferred from a run.
 */
describe("API export configuration", () => {
  it("requires an absolute origin", () => {
    expect(() => readApiBaseUrl(undefined)).toThrow(/EXPORT_API_URL is required/);
    expect(() => readApiBaseUrl("   ")).toThrow(/EXPORT_API_URL is required/);
    expect(() => readApiBaseUrl("api.example.org")).toThrow(/must be an absolute URL/);
  });

  it("requires https for any host that is not loopback", () => {
    expect(() => readApiBaseUrl("http://api.example.org")).toThrow(/must use https/);
    expect(readApiBaseUrl("https://api.example.org")).toBe("https://api.example.org");
    // loopback is exempt: there is no network path to sit on
    expect(readApiBaseUrl("http://localhost:3001")).toBe("http://localhost:3001");
    expect(readApiBaseUrl("http://127.0.0.2:3001")).toBe("http://127.0.0.2:3001");
  });

  it("rejects a path, query or fragment rather than silently dropping it", () => {
    expect(() => readApiBaseUrl("https://api.example.org/v1")).toThrow(/bare origin/);
    expect(() => readApiBaseUrl("https://api.example.org/?a=1")).toThrow(/bare origin/);
    // a bare origin with the trailing slash a browser adds is the same origin, and is accepted
    expect(readApiBaseUrl("https://api.example.org/")).toBe("https://api.example.org");
  });

  it("reads the output directory from the environment, defaulting to the writer's", () => {
    expect(parseApiExportOptions({ EXPORT_API_URL: "https://api.example.org" })).toEqual({
      baseUrl: "https://api.example.org",
    });
    expect(
      parseApiExportOptions({ EXPORT_API_URL: "https://api.example.org", EXPORT_OUT_DIR: "  " }),
    ).toEqual({ baseUrl: "https://api.example.org" });
    expect(
      parseApiExportOptions({
        EXPORT_API_URL: "https://api.example.org",
        EXPORT_OUT_DIR: "/tmp/x",
      }),
    ).toEqual({ baseUrl: "https://api.example.org", outDir: "/tmp/x" });
  });
});
