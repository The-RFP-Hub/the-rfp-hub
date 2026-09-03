/**
 * The bytes that are validated must be the bytes that are published: a stale published skill used
 * to pass while the local copy passed validation and nothing compared them. These tests serve a
 * "published" tree from a local server and drift it on purpose.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PUBLISHED_FILES, SKILL_DIR, checkSkill } from "../checks/skill.mjs";
import { Report } from "../report.mjs";

const HELPER_SAFE = `#!/usr/bin/env node
const base = process.env.RFPHUB_API_BASE;
const page = await (await fetch(base + "/v1/opportunities?status=open&limit=5")).json();
process.stdout.write(JSON.stringify({
  total: page.total,
  items: page.items.map((o) => ({ id: o.id, fundingType: o.fundingType })),
}));
`;

const HELPER_LEAKY = `#!/usr/bin/env node
const base = process.env.RFPHUB_API_BASE;
const page = await (await fetch(base + "/v1/opportunities?status=open&limit=5")).json();
process.stdout.write(JSON.stringify(page));
`;

const LINT_OK = "process.stdout.write('\\u2713 1 skill(s) checked\\n');\n";
const LINT_FAIL =
  "process.stderr.write('\\u2717 SKILL.md: missing required section\\n');process.exit(1);\n";

function fileSet({ helper = HELPER_SAFE } = {}) {
  return {
    ".claude-plugin/marketplace.json": '{"name":"rfp-hub"}\n',
    [`${SKILL_DIR}/SKILL.md`]: "---\nname: funding-search\n---\n\n# What this is\n",
    [`${SKILL_DIR}/.claude-plugin/plugin.json`]: '{"name":"funding-search"}\n',
    [`${SKILL_DIR}/scripts/search.mjs`]: helper,
    [`${SKILL_DIR}/scripts/get.mjs`]: "// get\n",
    [`${SKILL_DIR}/scripts/lib.mjs`]: "// lib\n",
  };
}

let repoRoot;
let server;
let rawBase;
let served;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "m4-skill-test-repo-"));
  served = fileSet();
  server = createServer((req, res) => {
    const relPath = decodeURIComponent(req.url ?? "").replace(/^\//, "");
    const body = served[relPath];
    if (body === undefined) {
      res.writeHead(404);
      res.end("404: Not Found");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  rawBase = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
});

async function writeLocal(files, lint = LINT_OK) {
  for (const [relPath, body] of Object.entries(files)) {
    const target = join(repoRoot, relPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  await mkdir(join(repoRoot, "scripts"), { recursive: true });
  await writeFile(join(repoRoot, "scripts/check-skill.mjs"), lint);
}

async function run() {
  const report = new Report({ siteUrl: "n/a", baseUrl: "n/a", node: process.version });
  await checkSkill(report, {
    repoRoot,
    rawBase,
    api: "n/a",
    skip: new Set(),
    timeoutMs: 20000,
    concurrency: 4,
  });
  const criterion = report.toJSON().criteria[0];
  return {
    status: criterion.status,
    failed: criterion.checks.filter((c) => c.status === "fail").map((c) => c.name),
  };
}

describe("checkSkill", () => {
  it("passes when the published bytes are the audited bytes and the helper projects", async () => {
    await writeLocal(fileSet());
    const result = await run();
    expect(result.failed).toEqual([]);
    expect(result.status).toBe("pass");
  });

  it("fails when a published file drifts from the audited local copy", async () => {
    await writeLocal(fileSet());
    served[`${SKILL_DIR}/SKILL.md`] = "---\nname: something-else\n---\n\n# Different\n";
    const result = await run();
    expect(result.failed.join(" | ")).toMatch(/published bytes equal the audited local bytes/);
  });

  it("fails when a required file is not published at all", async () => {
    await writeLocal(fileSet());
    delete served[`${SKILL_DIR}/scripts/lib.mjs`];
    const result = await run();
    expect(result.failed.join(" | ")).toMatch(/lib\.mjs is published on main/);
  });

  it("fails when the repository's own lint rejects the published tree", async () => {
    await writeLocal(fileSet(), LINT_FAIL);
    const result = await run();
    expect(result.failed.join(" | ")).toMatch(/skill lint passes against the published copy/);
  });

  it("fails when the PUBLISHED helper passes injected prose through", async () => {
    // The published helper is the one that runs: a projection fixed only in the local copy would
    // otherwise still read as green.
    const leaky = fileSet({ helper: HELPER_LEAKY });
    await writeLocal(leaky);
    served = leaky;
    const result = await run();
    expect(result.failed.join(" | ")).toMatch(
      /never emits injected prose|carries no description field/,
    );
  });
});
