/**
 * `SAFE_READ_PREAMBLE` — the shell preamble every `docs/**` `safe-read` block runs under.
 *
 * These are integration tests (they spawn a real `bash`, `curl` and `jq`, against a local HTTP
 * server this file starts itself — never the network) rather than pure-function unit tests,
 * because the property being locked in is a real interaction between three external tools that no
 * amount of mocking would actually prove. They exist because the design shipped here is the THIRD
 * one tried — the first two each looked correct and broke a legitimate block in the real
 * `docs/api-integration.md` (see the module docstring in `checks/docs.mjs`) — so the specific
 * failure modes that ruled the first two out are asserted here, not just described in a comment.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAFE_READ_PREAMBLE } from "../checks/docs.mjs";

const execFileAsync = promisify(execFile);

let server;
let base;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [{ slug: "acme" }] }));
      return;
    }
    if (req.url === "/missing") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      // Enough lines that `head -5` closes its end of the pipe before this finishes writing —
      // the exact shape of the real `.../opportunities.atom | head -40` block that broke pipefail.
      for (let i = 0; i < 5000; i++) res.write(`line ${i}\n`);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function run(source) {
  return execFileAsync("bash", ["-c", SAFE_READ_PREAMBLE + source], {
    env: { ...process.env, API: base },
    timeout: 5000,
  });
}

describe("SAFE_READ_PREAMBLE", () => {
  it("succeeds on a normal curl | jq round trip", async () => {
    await expect(run('curl -s "$API/ok" | jq .')).resolves.toBeTruthy();
  });

  it("propagates a bare curl -f failure (no pipe)", async () => {
    await expect(run('curl -s "$API/missing" -o /dev/null')).rejects.toThrow();
  });

  it("does NOT propagate a curl failure piped to jq (the known, documented gap)", async () => {
    // This is deliberately asserting the GAP, not the fix: unmodified `jq` on the empty body that
    // `curl -f` leaves behind still exits 0 (verified separately: `printf '' | jq .` exits 0), so
    // this line "succeeds" even though the request failed. Closing it would need per-line
    // `PIPESTATUS` instrumentation of the doc's own text, which this checker deliberately does not
    // do. If this test ever starts failing, the gap has closed — good news, but the module
    // docstring in checks/docs.mjs needs updating to match.
    await expect(run('curl -s "$API/missing" | jq .')).resolves.toBeTruthy();
  });

  it("does NOT fail on curl | head even when head closes the pipe early (the pipefail regression)", async () => {
    // The exact shape of docs/api-integration.md's real, legitimate
    // `curl -s "$API/v1/feeds/opportunities.atom" | head -40` block. `set -euo pipefail` broke
    // this; plain `set -eu` (no pipefail) must not.
    await expect(run('curl -s "$API/big" | head -5 >/dev/null')).resolves.toBeTruthy();
  });

  it("still shows an intentional non-2xx status when piped to head (the select()/400-demo case)", async () => {
    // `-f` on the shadowed `curl` makes it treat the 404 as a failure internally, but since this
    // line pipes to `head` (not the last-and-only command being curl itself) and there is no
    // pipefail, only `head`'s own exit status is examined — so a block deliberately showing a
    // reader "here is what an error status looks like" keeps working.
    const { stdout } = await run(`curl -si "$API/missing" | head -1`);
    expect(stdout).toContain("404");
  });

  it("does not let an undefined variable pass silently (set -u)", async () => {
    await expect(run("echo $THIS_IS_NOT_SET")).rejects.toThrow();
  });
});
