/**
 * M4-4's assertions, each shown to fail on a server that violates it. The criterion reported 11
 * passes while `outputSchema`, annotations, `structuredContent`, page 2 and the pagination envelope
 * were never looked at; a stand-in server that takes a defect by name is the only way to know an
 * assertion is doing anything.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkMcp } from "../checks/mcp.mjs";
import { Report } from "../report.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

/** 12 records, so `limit=5` gives three pages and page 2 is genuinely different from page 1. */
const CORPUS = Array.from({ length: 12 }, (_, i) => ({ id: `acme:item-${i + 1}` }));

let server;
let api;
let writes;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== "GET") {
      writes.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    const url = new URL(req.url, "http://localhost");
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const page = Number(url.searchParams.get("page") ?? 1);
    const items = CORPUS.slice((page - 1) * limit, page * limit);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        items,
        total: CORPUS.length,
        page,
        limit,
        totalPages: Math.ceil(CORPUS.length / limit),
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function run(defect) {
  writes = [];
  const report = new Report({ siteUrl: api, baseUrl: api, node: process.version });
  const ctx = {
    repoRoot: process.cwd(),
    api,
    site: api,
    mcpSpec: "local",
    skip: new Set(),
    timeoutMs: 20000,
    concurrency: 4,
    // `resolveCommand` is bypassed: these tests are about what the criterion ASSERTS, not about
    // how the binary under test is located (that is mcp-resolve-command.test.mjs).
    resolveOverride: {
      command: process.execPath,
      args: [FAKE],
      describe: `node ${FAKE} (test fixture, defect=${defect})`,
      local: true,
      spec: "local",
    },
    childEnv: { FAKE_MCP_DEFECT: defect },
  };
  await checkMcp(report, ctx);
  const json = report.toJSON();
  const m44 = json.criteria.find((c) => c.id === "M4-4");
  return {
    status: m44.status,
    failed: m44.checks.filter((c) => c.status === "fail").map((c) => c.name),
    names: m44.checks.map((c) => c.name),
  };
}

describe("a correct server passes every sub-criterion", () => {
  it("has one report line per sub-criterion, and none of them fails", async () => {
    const result = await run("none");
    expect(result.failed).toEqual([]);
    expect(result.status).toBe("pass");
    for (const fragment of [
      "exactly the two read tools",
      "exactly three tools",
      "advertises an outputSchema",
      "every annotation hint is a boolean",
      "page 1 ids equal the API's, in order",
      "page 2 ids equal the API's, in order",
      "pagination envelope equals the API's",
      "page 2 returns different ids from page 1",
      'phase 1 returns status: "pending"',
      "phase 1 performs no network write",
      "after the read-only process exits",
    ]) {
      expect(result.names.some((n) => n.includes(fragment))).toBe(true);
    }
    expect(writes).toEqual([]);
  });
});

describe("each defect is caught by the assertion that owns it", () => {
  const cases = [
    ["extra-tool", /exactly the two read tools/],
    ["no-output-schema", /advertises an outputSchema/],
    ["non-boolean-hint", /every annotation hint is a boolean/],
    ["read-tool-not-read-only", /readOnlyHint is true/],
    ["destructive-submit", /destructiveHint is false/],
    ["text-only", /valid structuredContent/],
    ["schema-drift", /valid structuredContent/],
    ["envelope-drift", /pagination envelope equals the API's/],
    ["same-page", /ids equal the API's, in order/],
    ["leaks-in-search", /no rfph_ substring in search_opportunities output/],
    ["not-pending", /phase 1 returns status/],
    ["writes-before-approval", /phase 1 performs no network write/],
    ["leaks-on-exit", /after the .* process exits/],
  ];
  for (const [defect, expected] of cases) {
    it(`fails on ${defect}`, async () => {
      const result = await run(defect);
      expect(result.status).toBe("fail");
      expect(result.failed.join(" | ")).toMatch(expected);
    });
  }
});
