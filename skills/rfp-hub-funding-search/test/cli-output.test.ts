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
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_API_BASE, announceBase } from "../scripts/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const searchScript = resolve(here, "../scripts/search.mjs");
const getScript = resolve(here, "../scripts/get.mjs");

// The projection bounds every per-item field, so the payload only exceeds a common OS pipe buffer
// (16KB on macOS, 64KB on Linux) through the item COUNT — the fake API below ignores `limit` and
// always serves the whole fixture page, which is what makes the transfer big enough to matter.
const LONG_ORG_NAME_LEN = 300;
const ORG_NAME_CAP = 80;
const ITEM_COUNT = 300;

function fakeItem(i: number) {
  return {
    id: `fixture:${i}`,
    title: `Fixture Opportunity Number ${i}`,
    fundingType: "grant",
    status: "open",
    operatingOrganizations: [{ name: "A".repeat(LONG_ORG_NAME_LEN) }],
    ecosystems: ["Ethereum"],
    deadlines: [{ deadlineType: "fixed", date: "2099-01-01T00:00:00.000Z", label: "application" }],
    fundingInfo: { currency: "USD", budget: 1000 + i },
    applicationUrl: "https://example.org/apply",
    website: "https://example.org",
  };
}

const items = Array.from({ length: ITEM_COUNT }, (_, i) => fakeItem(i));

function startFakeApi(): Promise<{ server: Server; base: string; requestUrls: string[] }> {
  const requestUrls: string[] = [];
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      requestUrls.push(url);
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
      resolvePromise({ server, base: `http://127.0.0.1:${port}`, requestUrls });
    });
  });
}

/** A fake API with a caller-supplied handler, for the failure modes the fixture page can't model.
 * Response-level errors are swallowed: a client that stops reading mid-body (the point of the
 * response-cap test) leaves the server writing into a closed socket. */
function startServerWith(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; base: string }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      res.on("error", () => {});
      handler(req, res);
    });
    server.on("clientError", () => {});
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
    const { code, stdout, stderr } = await run(searchScript, ["--limit", "25"], {
      RFPHUB_API_BASE: base,
    });

    expect(stderr.trim()).toBe(`Querying ${base} (RFPHUB_API_BASE)`);
    expect(code).toBe(0);
    // A truncated write would fail to parse, or parse short — either way this proves it didn't.
    const parsed = JSON.parse(stdout);
    expect(parsed.items).toHaveLength(ITEM_COUNT);
    // The tail of the payload is what a truncated pipe write loses first.
    expect(parsed.items.at(-1).title).toBe(`Fixture Opportunity Number ${ITEM_COUNT - 1}`);
    expect(parsed.items.at(-1).organization).toHaveLength(ORG_NAME_CAP);
    expect(stdout.length).toBeGreaterThan(64 * 1024); // actually exceeded a typical pipe buffer
  });

  it("get.mjs delivers every byte of a large piped payload and exits 0", async () => {
    ({ server, base } = await startFakeApi());
    const { code, stdout, stderr } = await run(getScript, ["fixture:0"], {
      RFPHUB_API_BASE: base,
    });

    expect(stderr.trim()).toBe(`Querying ${base} (RFPHUB_API_BASE)`);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.organization).toHaveLength(ORG_NAME_CAP);
    expect(parsed.links).toEqual({
      apply: `${base}/v1/r/fixture%3A0/apply`,
      source: `${base}/v1/r/fixture%3A0/source`,
    });
  });

  it("search.mjs --format table also survives the full transfer", async () => {
    ({ server, base } = await startFakeApi());
    const { code, stdout } = await run(searchScript, ["--limit", "25", "--format", "table"], {
      RFPHUB_API_BASE: base,
    });
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

describe("search.mjs defaults to status=open unless --status is passed explicitly", () => {
  let server: Server;

  afterEach(() => {
    server?.close();
  });

  it("sends status=open when --status is omitted", async () => {
    const fake = await startFakeApi();
    server = fake.server;
    const { code } = await run(searchScript, ["--q", "grant"], { RFPHUB_API_BASE: fake.base });
    expect(code).toBe(0);
    expect(fake.requestUrls).toHaveLength(1);
    const params = new URLSearchParams(fake.requestUrls[0].split("?")[1] ?? "");
    expect(params.get("status")).toBe("open");
  });

  it("honors an explicit --status instead of the default", async () => {
    const fake = await startFakeApi();
    server = fake.server;
    const { code } = await run(searchScript, ["--status", "closed"], {
      RFPHUB_API_BASE: fake.base,
    });
    expect(code).toBe(0);
    const params = new URLSearchParams(fake.requestUrls[0].split("?")[1] ?? "");
    expect(params.get("status")).toBe("closed");
  });

  it("honors an explicit multi-value --status (e.g. asking for every status)", async () => {
    const fake = await startFakeApi();
    server = fake.server;
    const { code } = await run(searchScript, ["--status", "upcoming,open,closed,archived"], {
      RFPHUB_API_BASE: fake.base,
    });
    expect(code).toBe(0);
    const params = new URLSearchParams(fake.requestUrls[0].split("?")[1] ?? "");
    expect(params.get("status")).toBe("upcoming,open,closed,archived");
  });
});

describe("usage errors exit 1 BEFORE any network call", () => {
  // Port 1 is a privileged port nothing in this test suite listens on: any attempted connection
  // fails fast and distinctly (ECONNREFUSED -> this skill's own "network" exit code, 2) — which
  // is different from the usage exit code (1) these tests expect. If a fix regressed and let one
  // of these bad invocations reach fetchJson, the exit code would flip from 1 to 2, catching it
  // without needing to prove a negative ("no request was sent") any other way.
  const UNREACHABLE_BASE = "http://127.0.0.1:1";
  const USAGE_EXIT_CODE = 1;
  const NETWORK_EXIT_CODE = 2;

  it("search.mjs rejects an unknown flag", async () => {
    const { code, stderr } = await run(searchScript, ["--bogus", "x"], {
      RFPHUB_API_BASE: UNREACHABLE_BASE,
    });
    expect(code).toBe(USAGE_EXIT_CODE);
    expect(code).not.toBe(NETWORK_EXIT_CODE);
    expect(stderr).toMatch(/Unknown option|Unknown parameter/);
  });

  it("search.mjs rejects an invalid --format value", async () => {
    const { code, stderr } = await run(searchScript, ["--format", "yaml"], {
      RFPHUB_API_BASE: UNREACHABLE_BASE,
    });
    expect(code).toBe(USAGE_EXIT_CODE);
    expect(stderr).toMatch(/--format must be/);
  });

  it("search.mjs rejects extra positional arguments", async () => {
    const { code, stderr } = await run(searchScript, ["stray-positional"], {
      RFPHUB_API_BASE: UNREACHABLE_BASE,
    });
    expect(code).toBe(USAGE_EXIT_CODE);
    expect(stderr).toMatch(/no positional arguments/);
  });

  it("search.mjs rejects a non-integer --limit and --page", async () => {
    const badLimit = await run(searchScript, ["--limit", "10.5"], {
      RFPHUB_API_BASE: UNREACHABLE_BASE,
    });
    expect(badLimit.code).toBe(USAGE_EXIT_CODE);
    expect(badLimit.stderr).toMatch(/--limit must be a positive integer/);

    const badPage = await run(searchScript, ["--page", "1.5"], {
      RFPHUB_API_BASE: UNREACHABLE_BASE,
    });
    expect(badPage.code).toBe(USAGE_EXIT_CODE);
    expect(badPage.stderr).toMatch(/--page must be a positive integer/);
  });

  it("search.mjs rejects a repeated flag rather than silently dropping one value", async () => {
    const { code, stderr } = await run(searchScript, ["--status", "open", "--status", "closed"], {
      RFPHUB_API_BASE: UNREACHABLE_BASE,
    });
    expect(code).toBe(USAGE_EXIT_CODE);
    expect(code).not.toBe(NETWORK_EXIT_CODE);
    expect(stderr).toMatch(/--status was given more than once/);
  });

  it("search.mjs rejects an over-long --q, naming the limit", async () => {
    const { code, stderr } = await run(searchScript, ["--q", "x".repeat(5000)], {
      RFPHUB_API_BASE: UNREACHABLE_BASE,
    });
    expect(code).toBe(USAGE_EXIT_CODE);
    expect(stderr).toMatch(/--q is 5000 characters.*200/);
  });

  it("search.mjs rejects a bad enum value before the round trip, naming the allowed values", async () => {
    const { code, stderr } = await run(searchScript, ["--sort", "deadline"], {
      RFPHUB_API_BASE: UNREACHABLE_BASE,
    });
    expect(code).toBe(USAGE_EXIT_CODE);
    expect(code).not.toBe(NETWORK_EXIT_CODE);
    expect(stderr).toMatch(/--sort does not accept "deadline"/);
    expect(stderr).toMatch(/nextDeadlineAt/);
  });

  it("get.mjs rejects an unknown flag", async () => {
    const { code, stderr } = await run(getScript, ["fixture:0", "--bogus", "x"], {
      RFPHUB_API_BASE: UNREACHABLE_BASE,
    });
    expect(code).toBe(USAGE_EXIT_CODE);
    expect(code).not.toBe(NETWORK_EXIT_CODE);
    expect(stderr).toMatch(/Unknown option/);
  });

  it("get.mjs rejects an invalid --format value", async () => {
    const { code, stderr } = await run(getScript, ["fixture:0", "--format", "xml"], {
      RFPHUB_API_BASE: UNREACHABLE_BASE,
    });
    expect(code).toBe(USAGE_EXIT_CODE);
    expect(stderr).toMatch(/--format must be/);
  });

  it("get.mjs rejects an extra positional argument beyond the single <id>", async () => {
    const { code, stderr } = await run(getScript, ["fixture:0", "fixture:1"], {
      RFPHUB_API_BASE: UNREACHABLE_BASE,
    });
    expect(code).toBe(USAGE_EXIT_CODE);
    expect(stderr).toMatch(/takes exactly one/);
  });

  it("get.mjs still requires an id when none is given", async () => {
    const { code, stderr } = await run(getScript, [], { RFPHUB_API_BASE: UNREACHABLE_BASE });
    expect(code).toBe(USAGE_EXIT_CODE);
    expect(stderr).toMatch(/Usage: node get\.mjs/);
  });
});

describe("an unusable response body fails loudly instead of reading as an empty page", () => {
  const MALFORMED_EXIT_CODE = 6;
  let server: Server;

  afterEach(() => {
    server?.closeAllConnections?.();
    server?.close();
  });

  it("exits 6 on valid JSON that is not an object", async () => {
    const fake = await startServerWith((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    });
    server = fake.server;
    const { code, stdout, stderr } = await run(searchScript, [], { RFPHUB_API_BASE: fake.base });
    expect(code).toBe(MALFORMED_EXIT_CODE);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/not an object/);
  });

  it("exits 6 on a body whose declared Content-Length is over the cap", async () => {
    const fake = await startServerWith((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"pad":"${"x".repeat(2 * 1024 * 1024)}"}`);
    });
    server = fake.server;
    const { code, stderr } = await run(getScript, ["fixture:0"], { RFPHUB_API_BASE: fake.base });
    expect(code).toBe(MALFORMED_EXIT_CODE);
    expect(stderr).toMatch(/Narrow the query/);
  });

  it("exits promptly, not once the socket dies, when an oversize length is declared and the body then stalls", async () => {
    const fake = await startServerWith((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(4 * 1024 * 1024),
      });
      // Headers must be flushed for the client to see the declared length at all; the body then
      // never arrives. Without an abort before the throw, the request holds the socket — and the
      // process — open long after exit 6 was already decided.
      res.flushHeaders();
    });
    server = fake.server;
    const startedAt = Date.now();
    const { code, stderr } = await run(searchScript, [], {
      RFPHUB_API_BASE: fake.base,
      RFPHUB_TIMEOUT_MS: "30000",
    });
    expect(code).toBe(MALFORMED_EXIT_CODE);
    expect(stderr).toMatch(/Narrow the query/);
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });

  it("exits 6 on a chunked body that grows past the cap with no Content-Length to warn first", async () => {
    const fake = await startServerWith((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
      for (let i = 0; i < 8; i++) res.write("x".repeat(256 * 1024));
      res.end();
    });
    server = fake.server;
    const { code, stderr } = await run(searchScript, [], { RFPHUB_API_BASE: fake.base });
    expect(code).toBe(MALFORMED_EXIT_CODE);
    expect(stderr).toMatch(/exceeded this skill's/);
  });
});

describe("a self-hosted base URL on an IPv6 loopback address", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
  });

  /** Resolves null when the runner has no such address, so an IPv6-less CI box skips instead of
   * failing on something the skill does not control. */
  function tryListen(host: string): Promise<{ server: Server; base: string } | null> {
    return new Promise((resolvePromise) => {
      const created = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ total: 0, page: 1, totalPages: 1, limit: 10, items: [] }));
      });
      created.once("error", () => resolvePromise(null));
      created.listen(0, host, () => {
        const address = created.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolvePromise({ server: created, base: `http://[${host}]:${port}` });
      });
    });
  }

  it("reaches an API listening on ::1 through a bracketed RFPHUB_API_BASE", async (ctx) => {
    const started = await tryListen("::1");
    if (!started) return ctx.skip();
    server = started.server;
    const { code, stdout, stderr } = await run(searchScript, [], {
      RFPHUB_API_BASE: started.base,
    });
    expect(stderr.trim()).toBe(`Querying ${started.base} (RFPHUB_API_BASE)`);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).total).toBe(0);
  });
});

describe("the --limit cap boundary", () => {
  let server: Server;

  afterEach(() => {
    server?.close();
  });

  it("warns on stderr at one past the cap, and still exits 0", async () => {
    const fake = await startFakeApi();
    server = fake.server;
    const { code, stderr } = await run(searchScript, ["--limit", "26"], {
      RFPHUB_API_BASE: fake.base,
    });
    expect(code).toBe(0);
    expect(stderr).toMatch(/--limit 26 exceeds this skill's cap of 25/);
    const params = new URLSearchParams(fake.requestUrls[0].split("?")[1] ?? "");
    expect(params.get("limit")).toBe("25");
  });
});

describe("a merged opportunity's title is bounded like any other third-party title", () => {
  let server: Server;

  afterEach(() => {
    server?.closeAllConnections?.();
    server?.close();
  });

  it("truncates the merged entry's title to the projection's own cap before printing it", async () => {
    const TITLE_CAP = 140;
    const longTitle = "M".repeat(400);
    const fake = await startServerWith((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "opportunity_merged",
          message: "merged",
          mergedInto: { id: "fixture:winner", title: longTitle },
        }),
      );
    });
    server = fake.server;
    const { code, stderr } = await run(getScript, ["fixture:loser"], {
      RFPHUB_API_BASE: fake.base,
    });
    expect(code).toBe(3);
    expect(stderr).toContain("fixture:winner");
    expect(stderr).not.toContain("M".repeat(TITLE_CAP + 1));
    expect(stderr).toContain(`${"M".repeat(TITLE_CAP - 1)}\u2026`);
  });
});

describe("the base URL that answered is announced on stderr, never on stdout", () => {
  let server: Server;

  afterEach(() => {
    server?.closeAllConnections?.();
    server?.close();
  });

  it("names the base and its source, and leaves stdout pure JSON", async () => {
    const fake = await startFakeApi();
    server = fake.server;
    const { code, stdout, stderr } = await run(searchScript, ["--limit", "1"], {
      RFPHUB_API_BASE: fake.base,
    });
    expect(code).toBe(0);
    expect(stderr.trim()).toBe(`Querying ${fake.base} (RFPHUB_API_BASE)`);
    expect(stdout).not.toContain("Querying");
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it("get.mjs announces it too", async () => {
    const fake = await startFakeApi();
    server = fake.server;
    const { code, stderr } = await run(getScript, ["fixture:0"], { RFPHUB_API_BASE: fake.base });
    expect(code).toBe(0);
    expect(stderr.trim()).toBe(`Querying ${fake.base} (RFPHUB_API_BASE)`);
  });

  it("says the base came from the default when RFPHUB_API_BASE is unset", async () => {
    let warned = "";
    vi.stubEnv("RFPHUB_API_BASE", undefined);
    announceBase(DEFAULT_API_BASE, (msg) => {
      warned = msg;
    });
    vi.unstubAllEnvs();
    expect(warned).toBe(`Querying ${DEFAULT_API_BASE} (default)`);
  });
});
