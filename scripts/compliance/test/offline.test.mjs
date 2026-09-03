/**
 * `--offline` used to be metadata: it was carried in `ctx`, put in the report's target block, and
 * ignored. `--offline --only liveness` opened a socket to the deployment and reported PASS.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { READ_CRITERIA } from "../criteria.mjs";

const BINARY = fileURLToPath(new URL("../../check-deployment.mjs", import.meta.url));

let running;
afterEach(async () => {
  if (running) await new Promise((resolve) => running.close(resolve));
  running = undefined;
});

/** An API that answers everything, and counts what it was asked. */
async function countingApi() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", db: "up" }));
  });
  running = server;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}

/** The report, which `--json -` prints as the only line starting a JSON object at column 0. */
function reportOf(out) {
  return JSON.parse(out.slice(out.lastIndexOf("\n{\n") + 1));
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BINARY, ...args], {
      env: { ...process.env, NO_COLOR: "1" },
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe("--offline", () => {
  it("makes no request at all, and does not report the criterion as passed", async () => {
    const api = await countingApi();
    const { code, out } = await run([
      "--offline",
      "--only",
      "liveness",
      "--api",
      api.origin,
      "--json",
      "-",
      "--no-color",
    ]);

    expect(api.seen).toEqual([]);
    expect(code).toBe(1);
    expect(out).toContain("skipped: --offline");
    expect(out).toContain("INCOMPLETE");

    const json = reportOf(out);
    expect(json.result).toBe("incomplete");
    expect(json.signOff).toBe(false);
    expect(json.criteria.map((c) => [c.id, c.status])).toEqual([["liveness", "incomplete"]]);
  });

  // Exit 2, "the run could not be made", is a different answer from an honest INCOMPLETE.
  it("with no other flags: every criterion unmet, nothing refused, nothing requested", async () => {
    const api = await countingApi();
    const { code, out } = await run([
      "--offline",
      "--api",
      api.origin,
      "--json",
      "-",
      "--no-color",
    ]);

    expect(out).not.toContain("refuses to run");
    expect(out).not.toContain("--export-url is required");
    expect(api.seen).toEqual([]);
    expect(code).toBe(1);

    const json = reportOf(out);
    expect(json.signOff).toBe(false);
    // Derived from the registry, not listed: a criterion added later must be classified by its own
    // `offline` flag rather than silently joining whichever list this test happened to spell.
    const grounded = READ_CRITERIA.filter((c) => c.meta.offline !== true).map((c) => c.meta.key);
    const reachable = READ_CRITERIA.filter((c) => c.meta.offline === true).map((c) => c.meta.key);
    expect(json.criteria.map((c) => c.id).sort()).toEqual([...grounded, ...reachable].sort());
    for (const key of grounded) {
      const criterion = json.criteria.find((c) => c.id === key);
      expect(criterion.status, key).toBe("incomplete");
      expect(criterion.unmet[0], key).toBe("skipped: --offline");
    }
    for (const key of reachable) {
      expect(json.criteria.find((c) => c.id === key).unmet, key).toBeUndefined();
    }
  });

  it("a weakened run reaches the deployment but is not a sign-off", async () => {
    const api = await countingApi();
    const { out } = await run([
      "--only",
      "liveness",
      "--max-details",
      "5",
      "--api",
      api.origin,
      "--json",
      "-",
      "--no-color",
    ]);

    expect(api.seen.length).toBeGreaterThan(0);
    expect(out).toContain("weakened: --max-details 5");
    const json = reportOf(out);
    expect(json.signOff).toBe(false);
    expect(json.scope).toContain("weakened: --max-details 5");
  });

  it("still reaches the deployment without the flag, so the test above proves the flag", async () => {
    const api = await countingApi();
    const { code } = await run([
      "--only",
      "liveness",
      "--api",
      api.origin,
      "--json",
      "-",
      "--no-color",
    ]);

    expect(api.seen.length).toBeGreaterThan(0);
    expect(code).not.toBe(2);
  });
});
