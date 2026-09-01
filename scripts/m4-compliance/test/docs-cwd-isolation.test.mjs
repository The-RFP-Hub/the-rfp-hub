/**
 * `checkDocs` must never write into `ctx.repoRoot` — the caller's own checkout. A real block in
 * `docs/api-integration.md` does `curl ... -o dataset.json`; running that with `cwd: ctx.repoRoot`
 * (an earlier revision) left the file sitting in the repo after every run of a tool advertised as
 * read-only.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HANDOFF_DOCS, checkDocs } from "../checks/docs.mjs";
import { Report } from "../report.mjs";

let repoRoot;
let server;
let api;

beforeEach(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${server.address().port}`;

  repoRoot = await mkdtemp(join(tmpdir(), "m4-check-docs-cwd-isolation-"));
  await mkdir(join(repoRoot, "docs"), { recursive: true });
  for (const relPath of HANDOFF_DOCS) {
    await writeFile(join(repoRoot, relPath), "# placeholder\n");
  }
  await writeFile(
    join(repoRoot, "docs/api-integration.md"),
    [
      "# API integration",
      "",
      "```sh safe-read",
      'curl -s "$API/v1/export/opportunities.json" -o dataset.json',
      "```",
      "",
    ].join("\n"),
  );
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
});

describe("checkDocs — safe-read blocks run outside ctx.repoRoot", () => {
  it("leaves nothing behind in ctx.repoRoot", async () => {
    const report = new Report({ siteUrl: "n/a", baseUrl: api, node: process.version });
    const ctx = {
      repoRoot,
      api,
      site: api,
      offline: false,
      skip: new Set(),
      concurrency: 4,
      timeoutMs: 10000,
    };

    await checkDocs(report, ctx);

    const json = report.toJSON();
    const check = json.criteria[0].checks.find((c) => c.name.includes("safe-read block"));
    // Confirm the block actually ran and passed — a check that never executed would make
    // "nothing was written" a vacuous pass.
    expect(check?.status).toBe("pass");

    const entries = await readdir(repoRoot, { recursive: true });
    expect(entries.some((e) => e.endsWith("dataset.json"))).toBe(false);
  });
});
