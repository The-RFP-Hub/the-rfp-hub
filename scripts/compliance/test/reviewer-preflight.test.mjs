/**
 * The teardown credential is proven against the deployment before anything is written.
 *
 * A `--session-token` with no `--admin-token` used to be ASSUMED to name a reviewer. A plain
 * publisher session therefore passed every refusal, wrote four fixtures, and discovered at teardown
 * that it could not reject any of them — leaving them on somebody's public surface.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const BINARY = fileURLToPath(new URL("../../accept-writes.mjs", import.meta.url));

let running;
afterEach(async () => {
  if (running) await new Promise((resolve) => running.close(resolve));
  running = undefined;
});

/** A deployment that answers /v1/health and /v1/me, and records every request it is sent. */
async function fakeApi({ canReview, meStatus = 200 }) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/v1/health") return send(200, { status: "ok", db: "up" });
    if (req.url === "/v1/me") return send(meStatus, { accountId: 1, canReview });
    return send(404, { error: { code: "not_found" } });
  });
  running = server;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BINARY, ...args], {
      env: {
        ...process.env,
        NO_COLOR: "1",
        COMPLIANCE_SESSION_TOKEN: "",
        COMPLIANCE_ADMIN_TOKEN: "",
        COMPLIANCE_API_KEY: "",
        COMPLIANCE_REVIEWER_TOKEN: "",
        COMPLIANCE_WRITE_KEY: "",
        RFPHUB_REVIEWER_TOKEN: "",
        RFPHUB_WRITE_KEY: "",
      },
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

const invocation = (origin, extra) => [
  "--milestone",
  "m3",
  "--api",
  origin,
  "--namespace",
  "my-org",
  "--session-token",
  "publisher-session",
  "--json",
  "-",
  "--no-color",
  ...extra,
];

describe("the teardown credential", () => {
  it("refuses a session that may not review, before writing anything", async () => {
    const api = await fakeApi({ canReview: false });
    const { code, out } = await run(invocation(api.origin, []));

    expect(code).toBe(2);
    expect(out).toContain("--session-token names an account that may not review");
    expect(out).toContain("canReview");
    // The whole point: nothing was created. A POST here means the refusal came too late.
    expect(api.seen.filter((request) => !request.startsWith("GET "))).toEqual([]);
    expect(api.seen).not.toContain("POST /v1/opportunities");
  });

  it("refuses an --admin-token the deployment does not accept", async () => {
    const api = await fakeApi({ canReview: true, meStatus: 401 });
    const { code, out } = await run(invocation(api.origin, ["--admin-token", "expired"]));

    expect(code).toBe(2);
    expect(out).toContain("--admin-token was answered 401");
    expect(api.seen.filter((request) => !request.startsWith("GET "))).toEqual([]);
  });

  it("gets past the preflight when the credential may review", async () => {
    const api = await fakeApi({ canReview: true });
    const { code, out } = await run(invocation(api.origin, []));

    // The run proceeds and then fails on the fake API's 404s — which is the point: it got past the
    // refusal and started exercising criteria, rather than being turned away at the door.
    expect(code).not.toBe(2);
    expect(out).not.toContain("may not review");
  });
});

// The m4 profile reaches the same preflight under its own flag, and it matters more there: its one
// criterion writes through the MCP server, which no refusal downstream could undo.
describe("the m4 profile's reviewer", () => {
  const submission = (origin, extra = []) => [
    "--milestone",
    "m4",
    "--api",
    origin,
    "--reviewer-token",
    "not-a-reviewer",
    "--write-key",
    "rfph_x",
    "--json",
    "-",
    "--no-color",
    ...extra,
  ];

  it("refuses a --reviewer-token that may not review, before the MCP cycle writes", async () => {
    const api = await fakeApi({ canReview: false });
    const { code, out } = await run(submission(api.origin));

    expect(code).toBe(2);
    expect(out).toContain("--reviewer-token names an account that may not review");
    expect(out).toContain("Pass a --reviewer-token whose account may review");
    expect(api.seen.filter((request) => !request.startsWith("GET "))).toEqual([]);
  });

  it("refuses a --reviewer-token the deployment does not accept", async () => {
    const api = await fakeApi({ canReview: true, meStatus: 401 });
    const { code, out } = await run(submission(api.origin));

    expect(code).toBe(2);
    expect(out).toContain("--reviewer-token was answered 401");
    expect(api.seen.filter((request) => !request.startsWith("GET "))).toEqual([]);
  });
});
