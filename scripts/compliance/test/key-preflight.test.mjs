/**
 * The m4 write key's SCOPE is proven against the deployment before the MCP server is spawned.
 *
 * Presence was all that was checked. A `publish`-scoped key publishes the fixture outright, so the
 * profile's central assertion — "a submission lands pending by construction" — would have held
 * against an entry that was never pending, and the teardown would have been rejecting a live
 * listing. A read-only key fails three phases in, after the run has already said what it is doing.
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

/**
 * A deployment whose `/v1/me` answers by CREDENTIAL: the reviewer preflight and this one both call
 * it, in that order, and they are asking about different things.
 */
async function fakeApi({ scopes, keyStatus = 200, credentialKind = "api_key" }) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/v1/health") return send(200, { status: "ok", db: "up" });
    if (req.url === "/v1/me") {
      const key = (req.headers.authorization ?? "").includes("rfph_");
      if (!key)
        return send(200, { accountId: 1, canReview: true, credentialKind: "session", scopes: [] });
      return send(keyStatus, { accountId: 1, canReview: false, credentialKind, scopes });
    }
    return send(404, { error: { code: "not_found" } });
  });
  running = server;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}

function run(origin) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        BINARY,
        "--milestone",
        "m4",
        "--api",
        origin,
        "--session-token",
        "reviewer-session",
        "--api-key",
        "rfph_TESTONLYnotarealkey",
        "--json",
        "-",
        "--no-color",
      ],
      {
        env: {
          ...process.env,
          NO_COLOR: "1",
          COMPLIANCE_SESSION_TOKEN: "",
          COMPLIANCE_ADMIN_TOKEN: "",
          COMPLIANCE_API_KEY: "",
        },
      },
    );
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

/** Nothing may be created by a run that is about to be refused. */
const writes = (api) => api.seen.filter((request) => !request.startsWith("GET "));

describe("the m4 write key's scope", () => {
  it("lets a write-only key through to the criteria", async () => {
    const api = await fakeApi({ scopes: ["write"] });
    const { code, out } = await run(api.origin);

    // Not 2: it got past every refusal and started exercising the profile, which then fails on
    // this fake deployment's 404s. That is the pass condition here.
    expect(code).not.toBe(2);
    expect(out).not.toContain("--api-key has scopes");
  });

  it("refuses a publish-scoped key, naming the scope that must not be there", async () => {
    const api = await fakeApi({ scopes: ["read", "write", "publish"] });
    const { code, out } = await run(api.origin);

    expect(code).toBe(2);
    expect(out).toContain("--api-key has scopes [read, write, publish]");
    expect(out).toContain("it carries the `publish` scope");
    expect(out).toContain("never was pending");
    expect(writes(api)).toEqual([]);
  });

  it("refuses a read-only key, naming the scope that is missing", async () => {
    const api = await fakeApi({ scopes: ["read"] });
    const { code, out } = await run(api.origin);

    expect(code).toBe(2);
    expect(out).toContain("it is missing the `write` scope");
    expect(out).not.toContain("`publish` scope");
    expect(writes(api)).toEqual([]);
  });

  it("names both faults at once when a key manages both", async () => {
    const api = await fakeApi({ scopes: ["publish"] });
    const { code, out } = await run(api.origin);

    expect(code).toBe(2);
    expect(out).toContain("it is missing the `write` scope");
    expect(out).toContain("it carries the `publish` scope");
  });

  it("refuses a key the deployment does not accept", async () => {
    const api = await fakeApi({ scopes: [], keyStatus: 401 });
    const { code, out } = await run(api.origin);

    expect(code).toBe(2);
    expect(out).toContain("--api-key was answered 401");
    expect(writes(api)).toEqual([]);
  });

  it("refuses a session passed where the key belongs, rather than reporting a missing scope", async () => {
    const api = await fakeApi({ scopes: [], credentialKind: "session" });
    const { code, out } = await run(api.origin);

    expect(code).toBe(2);
    expect(out).toContain("--api-key is not an API key");
    expect(out).toContain("a session belongs in --session-token");
    expect(writes(api)).toEqual([]);
  });
});
