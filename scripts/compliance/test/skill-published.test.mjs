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
import {
  MAX_TITLE_LEN as SKILL_LIB_MAX_TITLE_LEN,
  project,
} from "../../../skills/funding-search/scripts/lib.mjs";
import {
  MAX_TITLE_LEN,
  PROJECTED_ITEM_KEYS,
  PUBLISHED_FILES,
  SKILL_DIR,
  checkSkill,
} from "../checks/skill.mjs";
import { Report } from "../report.mjs";

/** Stands in for the real projection: drops every prose field, keeps `title` truncated. */
const HELPER_SAFE = `#!/usr/bin/env node
const base = process.env.RFPHUB_API_BASE;
const page = await (await fetch(base + "/v1/opportunities?status=open&limit=5")).json();
const cap = ${MAX_TITLE_LEN};
const cut = (t) => (t.length <= cap ? t : t.slice(0, cap - 1) + "\u2026");
process.stdout.write(JSON.stringify({
  total: page.total,
  items: page.items.map((o) => ({ id: o.id, title: cut(o.title ?? ""), fundingType: o.fundingType })),
}));
`;

const HELPER_LEAKY = `#!/usr/bin/env node
const base = process.env.RFPHUB_API_BASE;
const page = await (await fetch(base + "/v1/opportunities?status=open&limit=5")).json();
process.stdout.write(JSON.stringify(page));
`;

/** Drops the prose but copies `title` through whole — the one thing the bound fixture catches. */
const HELPER_UNBOUNDED_TITLE = `#!/usr/bin/env node
const base = process.env.RFPHUB_API_BASE;
const page = await (await fetch(base + "/v1/opportunities?status=open&limit=5")).json();
process.stdout.write(JSON.stringify({
  total: page.total,
  items: page.items.map((o) => ({ id: o.id, title: o.title, fundingType: o.fundingType })),
}));
`;

/** Drops `title` entirely: the projection declares it KEEPS the field, bounded, so this is wrong too. */
const HELPER_DROPS_TITLE = `#!/usr/bin/env node
const base = process.env.RFPHUB_API_BASE;
const page = await (await fetch(base + "/v1/opportunities?status=open&limit=5")).json();
process.stdout.write(JSON.stringify({
  total: page.total,
  items: page.items.map((o) => ({ id: o.id, fundingType: o.fundingType })),
}));
`;

/** Rewrites the prose instead of copying it: the instruction literal never appears, the KEY does. */
const HELPER_TRANSFORMS_PROSE = `#!/usr/bin/env node
const base = process.env.RFPHUB_API_BASE;
const page = await (await fetch(base + "/v1/opportunities?status=open&limit=5")).json();
const cap = ${MAX_TITLE_LEN};
const cut = (t) => (t.length <= cap ? t : t.slice(0, cap - 1) + "\u2026");
process.stdout.write(JSON.stringify({
  total: page.total,
  items: page.items.map((o) => ({
    id: o.id,
    title: cut(o.title ?? ""),
    summary: (o.summary ?? "").slice(0, 20),
  })),
}));
`;

/** Short, so a length-only bound would call it truncated — but it is not the title at all. */
const HELPER_REDACTED_TITLE = `#!/usr/bin/env node
const base = process.env.RFPHUB_API_BASE;
const page = await (await fetch(base + "/v1/opportunities?status=open&limit=5")).json();
process.stdout.write(JSON.stringify({
  total: page.total,
  items: page.items.map((o) => ({ id: o.id, title: "redacted", fundingType: o.fundingType })),
}));
`;

/** One character over the cap, with no ellipsis: the off-by-one a `<=` on its own would miss. */
const HELPER_OFF_BY_ONE_TITLE = `#!/usr/bin/env node
const base = process.env.RFPHUB_API_BASE;
const page = await (await fetch(base + "/v1/opportunities?status=open&limit=5")).json();
process.stdout.write(JSON.stringify({
  total: page.total,
  items: page.items.map((o) => ({
    id: o.id,
    title: (o.title ?? "").slice(0, ${MAX_TITLE_LEN} + 1),
    fundingType: o.fundingType,
  })),
}));
`;

/** Leaks one prose field only — the assertion must not depend on the whole page coming through. */
const HELPER_LEAKS_ONE_PROSE_FIELD = `#!/usr/bin/env node
const base = process.env.RFPHUB_API_BASE;
const page = await (await fetch(base + "/v1/opportunities?status=open&limit=5")).json();
const cap = ${MAX_TITLE_LEN};
const cut = (t) => (t.length <= cap ? t : t.slice(0, cap - 1) + "\u2026");
process.stdout.write(JSON.stringify({
  total: page.total,
  items: page.items.map((o) => ({
    id: o.id,
    title: cut(o.title ?? ""),
    scopeOfWork: o.fundingDetails?.rfp?.scopeOfWork ?? null,
  })),
}));
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
      /prose fields carrying an injection|carries no description field/,
    );
  });

  it("fails when a single prose field leaks, with the title left clean", async () => {
    const leaky = fileSet({ helper: HELPER_LEAKS_ONE_PROSE_FIELD });
    await writeLocal(leaky);
    served = leaky;
    const result = await run();
    expect(result.failed).toContain(
      "the published search.mjs emits none of the prose fields carrying an injection",
    );
  });

  it("fails when the helper copies a hostile title through unbounded", async () => {
    const unbounded = fileSet({ helper: HELPER_UNBOUNDED_TITLE });
    await writeLocal(unbounded);
    served = unbounded;
    const result = await run();
    expect(result.failed).toEqual([
      "the published search.mjs bounds the third-party title it keeps",
    ]);
  });

  it("fails when the helper drops the title the projection promises to keep", async () => {
    const dropped = fileSet({ helper: HELPER_DROPS_TITLE });
    await writeLocal(dropped);
    served = dropped;
    const result = await run();
    expect(result.failed).toEqual([
      "the published search.mjs bounds the third-party title it keeps",
    ]);
  });

  it("fails on rewritten prose that never carries the injection literal", async () => {
    // The literal is gone; the KEY is not. A substring test alone would call this green.
    const transformed = fileSet({ helper: HELPER_TRANSFORMS_PROSE });
    await writeLocal(transformed);
    served = transformed;
    const result = await run();
    expect(result.failed).toEqual([
      "the published search.mjs emits only the keys its projection names",
    ]);
  });

  it("fails when the helper replaces the title instead of truncating it", async () => {
    const redacted = fileSet({ helper: HELPER_REDACTED_TITLE });
    await writeLocal(redacted);
    served = redacted;
    const result = await run();
    expect(result.failed).toEqual([
      "the published search.mjs bounds the third-party title it keeps",
    ]);
  });

  it("fails when the emitted title is one character over the cap", async () => {
    const off = fileSet({ helper: HELPER_OFF_BY_ONE_TITLE });
    await writeLocal(off);
    served = off;
    const result = await run();
    expect(result.failed).toEqual([
      "the published search.mjs bounds the third-party title it keeps",
    ]);
  });

  it("asserts the cap the skill's own library declares", () => {
    expect(MAX_TITLE_LEN).toBe(SKILL_LIB_MAX_TITLE_LEN);
  });

  it("pins the allow-list to what the skill's own project() emits", () => {
    const emitted = Object.keys(
      project(
        {
          id: "x",
          title: "t",
          fundingType: "grant",
          status: "open",
          ecosystems: ["Ethereum"],
          operatingOrganizations: [{ name: "Acme" }],
          applicationUrl: "https://example.org/apply",
          fundingInfo: { budget: 1 },
          deadlines: [],
        },
        "https://api.example",
      ),
    );
    expect([...emitted].sort()).toEqual([...PROJECTED_ITEM_KEYS].sort());
  });
});
