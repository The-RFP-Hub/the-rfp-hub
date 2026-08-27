/**
 * The audit log's two properties: it records key names and sizes but never values, and it never
 * takes a tool down with it.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendAudit, auditPath, summarizeInput } from "../src/audit.js";
import { clearRegisteredSecrets, registerSecret } from "../src/redact.js";
import { FAKE_KEY, testConfig, validDocument } from "./helpers.js";

afterEach(() => clearRegisteredSecrets());

describe("inputSummary", () => {
  it("keeps key names and a byte count, and no value at all", () => {
    const summary = summarizeInput({ q: "a secret search term", limit: 5 });
    expect(summary.keys).toEqual(["limit", "q"]);
    expect(summary.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(summary)).not.toContain("a secret search term");
  });

  it("never carries a submitted document's contents", () => {
    const summary = summarizeInput({ document: validDocument() });
    expect(summary.keys).toEqual(["document"]);
    expect(JSON.stringify(summary)).not.toContain("Test Grant Program");
  });

  it("records that unserializable input arrived, without recording it", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(summarizeInput(cyclic).bytes).toBe(-1);
  });

  it("has no keys for a non-object argument", () => {
    expect(summarizeInput("plain").keys).toEqual([]);
    expect(summarizeInput(undefined).keys).toEqual([]);
  });
});

describe("appendAudit", () => {
  const entry = {
    at: "2026-06-01T12:00:00.000Z",
    tool: "search_opportunities",
    kind: "read" as const,
    status: "ok",
    inputSummary: { keys: ["q"], bytes: 12 },
    durationMs: 3,
  };

  it("writes one JSON line per call, 0600", () => {
    const home = testConfig().home;
    appendAudit(home, entry);
    appendAudit(home, { ...entry, status: "rate_limited" });
    const lines = fs.readFileSync(auditPath(home), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ tool: "search_opportunities" });
    expect(fs.statSync(auditPath(home)).mode & 0o777).toBe(0o600);
  });

  it("redacts a key that somehow reached an audit field", () => {
    const home = testConfig().home;
    registerSecret(FAKE_KEY);
    appendAudit(home, { ...entry, inputSummary: { keys: [FAKE_KEY], bytes: 1 } });
    expect(fs.readFileSync(auditPath(home), "utf8")).not.toContain(FAKE_KEY);
  });

  it("never throws, even when the destination cannot be written", () => {
    // A read-only home is a reason to lose the record, never a reason to fail the call.
    const home = path.join(testConfig().home, "file-not-a-directory");
    fs.writeFileSync(home, "");
    expect(() => appendAudit(home, entry)).not.toThrow();
  });
});
