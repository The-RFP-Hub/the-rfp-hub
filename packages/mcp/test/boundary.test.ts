/**
 * Failures the SDK raises before this package's code runs must still come out coded, audited and
 * redacted.
 *
 * The dangerous one is argument validation. The tools declare STRICT schemas, so an unknown
 * property is rejected — and the SDK's own rejection message quotes the offending property back.
 * A caller who puts a credential in a property NAME would otherwise have it echoed to them
 * verbatim, from a code path with no audit line and no error code.
 *
 * Driven over real stdio against the built executable, because the whole point is what reaches the
 * wire, not what a function returns.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditPath } from "../src/audit.js";
import { REDACTED } from "../src/redact.js";
import { RedactingTransport } from "../src/transport.js";
import { tempHome } from "./helpers.js";

const CLI = path.resolve(import.meta.dirname, "../dist/cli.js");

/** A key-shaped string used as a PROPERTY NAME, which is the case output redaction alone misses. */
const SECRET = "rfph_SECRET1234abcdefghijklmnop";

let home: string;
let child: ChildProcessWithoutNullStreams;
const waiters: ((line: Record<string, unknown>) => void)[] = [];

function send(message: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no response in 10s")), 10_000);
    waiters.push((line) => {
      clearTimeout(timer);
      resolve(line);
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error("run `pnpm --filter @the-rfp-hub/mcp build` before this suite");
  }
  home = tempHome();
  child = spawn(process.execPath, [CLI], {
    env: {
      ...process.env,
      RFPHUB_API_BASE: "http://127.0.0.1:1/never-reached",
      RFPHUB_MCP_HOME: home,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at !== -1) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line.length > 0) waiters.shift()?.(JSON.parse(line) as Record<string, unknown>);
      at = buffer.indexOf("\n");
    }
  });
});

afterAll(() => {
  child?.kill();
});

describe("argument validation", () => {
  it("never echoes an unknown property whose NAME is a credential", async () => {
    const reply = await send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_opportunities", arguments: { [SECRET]: "x" } },
    });
    const wire = JSON.stringify(reply);
    expect(wire).not.toContain(SECRET);
    expect(wire).toContain(REDACTED);
  });

  it("never echoes a credential in an unknown property's VALUE", async () => {
    const reply = await send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search_opportunities", arguments: { apiKey: SECRET } },
    });
    expect(JSON.stringify(reply)).not.toContain(SECRET);
  });

  it("refuses with a code from the map rather than an SDK-worded protocol failure", async () => {
    const reply = await send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_opportunities", arguments: { limit: 9999 } },
    });
    const result = reply.result as { isError?: boolean; content: { text: string }[] };
    expect(reply.error).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("[invalid_input]");
  });

  it("writes an audit line for the refusal, with key names and no values", async () => {
    await send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "search_opportunities", arguments: { q: "audited", nope: 1 } },
    });
    const lines = fs.readFileSync(auditPath(home), "utf8").trim().split("\n").map(String);
    const refusals = lines.filter((l) => l.includes('"status":"invalid_input"'));
    expect(refusals.length).toBeGreaterThan(0);
    const last = refusals.at(-1) ?? "";
    expect(last).toContain('"tool":"search_opportunities"');
    // Key NAMES are recorded; the value "audited" is not.
    expect(last).toContain('"nope"');
    expect(last).not.toContain("audited");
  });
});

describe("unknown tools", () => {
  it("never echo a credential-shaped tool name, even though the SDK words that error", async () => {
    const reply = await send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: SECRET, arguments: {} },
    });
    // The SDK raises this one OUTSIDE the handler, as a JSON-RPC error rather than a tool result.
    // The transport wrapper is what catches it, which is exactly why that wrapper exists.
    expect(JSON.stringify(reply)).not.toContain(SECRET);
  });
});

describe("RedactingTransport", () => {
  it("redacts outbound messages and leaves inbound ones alone", async () => {
    const sent: unknown[] = [];
    const inner = {
      start: async () => {},
      close: async () => {},
      send: async (message: unknown) => {
        sent.push(message);
      },
    };
    const wrapped = new RedactingTransport(inner as never);
    const received: unknown[] = [];
    wrapped.onmessage = (message) => received.push(message);

    await wrapped.send({ jsonrpc: "2.0", id: 1, result: { note: `key ${SECRET}` } } as never);
    expect(JSON.stringify(sent)).not.toContain(SECRET);

    // The handler assignment reached the INNER transport — storing it on the wrapper would leave
    // the real transport with no handler and silently drop every request.
    expect(inner).toHaveProperty("onmessage");
    (inner as { onmessage?: (m: unknown) => void }).onmessage?.({ untouched: SECRET });
    expect(JSON.stringify(received)).toContain(SECRET);
  });
});
