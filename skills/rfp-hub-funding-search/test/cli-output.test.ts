/**
 * Regression test for a specific, well-documented Node.js pitfall: calling `process.exit(n)`
 * immediately after `process.stdout.write(bigPayload)` can truncate the output when stdout is a
 * pipe (as it always is under a child process or a shell pipeline) rather than a TTY. Writes to a
 * pipe are asynchronous in Node; `process.exit()` tears the process down synchronously and does
 * not wait for a queued write to actually reach the OS. The fix (see search.mjs/get.mjs) is to
 * set `process.exitCode` and let the event loop drain naturally instead of forcing an exit.
 *
 * This spins up a local, in-process HTTP server (no network, no live API dependency) that serves
 * a payload deliberately larger than any common pipe buffer (tens of KB), points the real CLI
 * scripts at it via `RFPHUB_API_BASE`, and asserts the FULL, valid, byte-exact output arrives at
 * the parent when the child's stdout is a pipe — exactly the transport a caller piping this
 * skill's output (or an agent runtime capturing it) actually uses.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { type Server, createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const searchScript = resolve(here, "../scripts/search.mjs");
const getScript = resolve(here, "../scripts/get.mjs");

// Comfortably larger than any common OS pipe buffer (16KB on macOS, 64KB on Linux by default).
const BIG_ORG_NAME_LEN = 6000;
const ITEM_COUNT = 25;

function fakeItem(i: number) {
  return {
    id: `fixture:${i}`,
    title: `Fixture Opportunity Number ${i}`,
    fundingType: "grant",
    status: "open",
    operatingOrganizations: [{ name: "A".repeat(BIG_ORG_NAME_LEN) }],
    ecosystems: ["Ethereum"],
    deadlines: [{ deadlineType: "fixed", date: "2099-01-01T00:00:00.000Z", label: "application" }],
    fundingInfo: { currency: "USD", budget: 1000 + i },
    applicationUrl: "https://example.org/apply",
    website: "https://example.org",
  };
}

const items = Array.from({ length: ITEM_COUNT }, (_, i) => fakeItem(i));

function startFakeApi(): Promise<{ server: Server; base: string }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/v1/opportunities/")) {
        const id = decodeURIComponent(url.split("/").pop() ?? "");
        const item = items.find((it) => it.id === id) ?? fakeItem(0);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(item));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ total: items.length, page: 1, totalPages: 1, limit: items.length, items }),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

/** Run a script as a real child process with stdout/stderr as PIPES (never a TTY), and collect
 * everything it wrote before it exits. This is the exact scenario the bug required: stdout must
 * be a pipe for Node's async-write-vs-sync-exit race to be observable at all. */
function run(
  script: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

describe("CLI output is not truncated when stdout is a pipe", () => {
  let server: Server;
  let base: string;

  afterEach(() => {
    server?.close();
  });

  it("search.mjs delivers every byte of a large piped payload and exits 0", async () => {
    ({ server, base } = await startFakeApi());
    const { code, stdout, stderr } = await run(searchScript, ["--limit", String(ITEM_COUNT)], {
      RFPHUB_API_BASE: base,
    });

    expect(stderr).toBe("");
    expect(code).toBe(0);
    // A truncated write would fail to parse, or parse short — either way this proves it didn't.
    const parsed = JSON.parse(stdout);
    expect(parsed.items).toHaveLength(ITEM_COUNT);
    // The whole point: a large per-item field (organization name) survived byte-for-byte.
    expect(parsed.items.at(-1).organization).toHaveLength(BIG_ORG_NAME_LEN);
    expect(stdout.length).toBeGreaterThan(64 * 1024); // actually exceeded a typical pipe buffer
  });

  it("get.mjs delivers every byte of a large piped payload and exits 0", async () => {
    ({ server, base } = await startFakeApi());
    const { code, stdout, stderr } = await run(getScript, ["fixture:0"], {
      RFPHUB_API_BASE: base,
    });

    expect(stderr).toBe("");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.organization).toHaveLength(BIG_ORG_NAME_LEN);
    expect(parsed.links).toEqual({
      apply: `${base}/v1/r/fixture%3A0/apply`,
      source: `${base}/v1/r/fixture%3A0/source`,
    });
  });

  it("search.mjs --format table also survives the full transfer", async () => {
    ({ server, base } = await startFakeApi());
    const { code, stdout } = await run(
      searchScript,
      ["--limit", String(ITEM_COUNT), "--format", "table"],
      { RFPHUB_API_BASE: base },
    );
    expect(code).toBe(0);
    // Every item's title must be present, including the LAST one — a truncated pipe write drops
    // the tail of the payload first, so a missing final title is exactly what this would catch.
    for (let i = 0; i < ITEM_COUNT; i++) {
      expect(stdout).toContain(`Fixture Opportunity Number ${i}`);
    }
    expect(stdout).toContain(`${ITEM_COUNT} total`);
  });

  it("neither script's actual exit call sites use process.exit(...) — only process.exitCode", async () => {
    const { readFileSync } = await import("node:fs");
    // Checks for the exact call SITES the buggy code used to have (`process.exit(code)` /
    // `process.exit(EXIT.NETWORK)`), not the bare phrase "process.exit()" — which also appears
    // inside this file's and the scripts' own explanatory comments describing the bug being
    // fixed, and would make a naive substring/regex check on that phrase a false positive.
    const bannedCallSites = [/\bprocess\.exit\(code\)/, /\bprocess\.exit\(EXIT\./];
    for (const script of [searchScript, getScript]) {
      const src = readFileSync(script, "utf8");
      for (const pattern of bannedCallSites) {
        expect(src).not.toMatch(pattern);
      }
      expect(src).toMatch(/process\.exitCode\s*=/);
    }
  });
});
