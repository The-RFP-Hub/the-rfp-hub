import { mkdtemp, rm } from "node:fs/promises";
/**
 * The `safe-read` grammar and executor: what the real guides write is accepted, and every hostile
 * shape the audit named is refused BEFORE anything is spawned. The execution half spawns real
 * `curl`/`jq`/`head` against a local server this file starts — never the network — because "a
 * failed request cannot be hidden by a downstream jq" is an interaction mocking would not prove.
 */
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSafeReadBlock, runSafeReadBlock, safeReadEnv } from "../safe-read.mjs";

let server;
let api;
let scratch;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [{ id: "acme:one" }] }));
      return;
    }
    if (req.url === "/one/acme:one") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "acme:one" }));
      return;
    }
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      // Enough lines that `head -5` is done long before this finishes writing — the shape that
      // made `pipefail` report a false failure under the previous bash implementation.
      for (let i = 0; i < 5000; i++) res.write(`line ${i}\n`);
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${server.address().port}`;
  scratch = await mkdtemp(join(tmpdir(), "m4-safe-read-test-"));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
});

const parse = (source) => parseSafeReadBlock(source, { api: "https://api.example.org" });

describe("the grammar accepts what the handoff guides actually write", () => {
  const real = [
    'curl -s "$API/v1/health" | jq',
    "curl -s \"$API/v1/docs/json\" | jq '.info, (.paths | keys)'",
    'curl -s "$API/v1/feeds/opportunities.atom" | head -40      # Atom 1.0',
    'curl -s "$API/v1/export/opportunities.json" -o dataset.json',
    'ID=$(curl -s "$API/v1/opportunities?limit=1" | jq -r \'.items[0].id\')\ncurl -s "$API/v1/opportunities/$ID" | jq',
    '# the 400 is the point, so swallow it\ncurl -si "$API/v1/opportunities?funding_type=grant" | head -1 || true',
    "ID=$(curl -s \"$API/v1/opportunities?limit=1\" | jq -r '.items[0].id')\ncurl -si -H 'DNT: 1' \"$API/v1/r/$ID/apply\" | head -3",
  ];
  for (const source of real) {
    it(`accepts ${JSON.stringify(source.split("\n")[0]).slice(0, 60)}`, () => {
      expect(parse(source)).toMatchObject({ ok: true });
    });
  }
});

describe("the grammar refuses everything that is not a read", () => {
  const hostile = [
    ['curl -X POST "$API/v1/opportunities"', /not a read/],
    ['curl --request DELETE "$API/v1/opportunities/x"', /not a read/],
    ['curl -s -d @payload.json "$API/v1/opportunities"', /request body/],
    ['curl -s -F file=@x "$API/v1/opportunities"', /multipart/],
    ['curl -s -T x.json "$API/v1/opportunities"', /upload/],
    ['curl -s -u user:pass "$API/v1/me"', /credentials/],
    ['curl -s -H "Authorization: Bearer x" "$API/v1/me"', /authorization header/],
    ["curl -s -H 'Cookie: session=x' \"$API/v1/me\"", /cookie header/],
    ['curl -s "$(cat ~/.npmrc)"', /command substitution/],
    ["curl -s `cat /etc/passwd`", /backtick/],
    ['curl -s "$API/v1/health" > stolen.txt', /redirection/],
    ['curl -s "$API/v1/health" && rm -rf /', /&/],
    ['curl -s "$API/v1/health"; rm -rf /', /sequencing/],
    ['curl -s "$API/v1/health" | bash', /may not appear/],
    ['curl -s "$API/v1/health" | sh -c "x"', /may not appear/],
    ["curl -s https://evil.example.com/collect", /not the deployment under test/],
    ['curl -s "$API/v1/r/abc/apply"', /DNT: 1/],
    ['curl -s "$NOT_DEFINED/v1/health"', /undefined variable/],
    ["rm -rf /", /must start with curl/],
    ['curl -s "$API/v1/health" || curl -s "$API/v1/other"', /trailing/],
    ['curl -s -o ../../escape.json "$API/v1/health"', /plain filename/],
    ['curl -s "$API/v1/health" | python3 -c "import os; os.system(\'x\')"', /json.tool/],
  ];
  for (const [source, reason] of hostile) {
    it(`refuses ${JSON.stringify(source).slice(0, 60)}`, () => {
      const result = parse(source);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(reason);
    });
  }
});

describe("the child environment is an allowlist, not the operator's shell", () => {
  it("carries no credential-shaped variable through", () => {
    const env = safeReadEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      NPM_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      RFPHUB_API_KEY: "rfph_leaked_from_dev_shell",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x" });
  });
});

describe("execution", () => {
  const run = async (source) => {
    const parsed = parseSafeReadBlock(source, { api });
    expect(parsed.ok).toBe(true);
    return runSafeReadBlock(parsed, { cwd: scratch, timeoutMs: 10000, api });
  };

  it("succeeds on a normal curl | jq round trip", async () => {
    expect(await run('curl -s "$API/ok" | jq .')).toEqual({ ok: true });
  });

  it("FAILS a request whose 404 was previously hidden by the downstream jq", async () => {
    // The documented gap in the bash implementation: `curl -f … | jq` reported only jq's status,
    // and plain jq on the empty body curl left behind exits 0. Running the stages separately
    // examines curl's own exit code, so the pipeline cannot pass on a failed request.
    const result = await run('curl -s "$API/missing" | jq .');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/curl exited/);
  });

  it("does not report a false failure when head closes the pipe early", async () => {
    expect(await run('curl -s "$API/big" | head -5')).toEqual({ ok: true });
  });

  it("honors a trailing `|| true` for a block that demonstrates an error status", async () => {
    expect(await run('curl -si "$API/missing" | head -1 || true')).toEqual({ ok: true });
  });

  it("carries a captured id into the next line's path", async () => {
    expect(
      await run('ID=$(curl -s "$API/ok" | jq -r \'.items[0].id\')\ncurl -s "$API/one/$ID" | jq .'),
    ).toEqual({ ok: true });
  });
});
