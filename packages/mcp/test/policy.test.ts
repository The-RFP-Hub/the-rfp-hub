/**
 * The caps, and the one property that makes them worth having: the KIND is a property of the
 * INVOCATION, not of the tool. `submit_opportunity` spends the preview budget on its first call
 * and the commit budget only when it reaches the request.
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { APPROVAL_TTL_MS, listPending, writeApproval } from "../src/approvals.js";
import { ApiClient } from "../src/http.js";
import { DEFAULT_CAPS, Policy, counterPath } from "../src/policy.js";
import { clearRegisteredSecrets } from "../src/redact.js";
import type { ToolContext } from "../src/tools/context.js";
import { run } from "../src/tools/submit.js";
import { stubFetch, testConfig, validDocument } from "./helpers.js";

afterEach(() => clearRegisteredSecrets());

const NOW = new Date("2026-06-01T12:00:00Z");

describe("caps", () => {
  it("allows exactly the per-minute budget, then refuses", () => {
    const home = testConfig().home;
    const policy = new Policy(home, {
      caps: { ...DEFAULT_CAPS, read: { perMinute: 3, perDay: 100 } },
      now: () => NOW,
    });
    policy.consume("read");
    policy.consume("read");
    policy.consume("read");
    expect(() => policy.consume("read")).toThrowError(/per minute/);
    expect(policy.usage("read").minute).toBe(3);
  });

  it("rolls the window over at the next minute", () => {
    const home = testConfig().home;
    let now = NOW;
    const policy = new Policy(home, {
      caps: { ...DEFAULT_CAPS, read: { perMinute: 1, perDay: 100 } },
      now: () => now,
    });
    policy.consume("read");
    expect(() => policy.consume("read")).toThrow();
    now = new Date(NOW.getTime() + 61_000);
    expect(() => policy.consume("read")).not.toThrow();
  });

  it("enforces the daily budget independently of the per-minute one", () => {
    const home = testConfig().home;
    let now = NOW;
    const policy = new Policy(home, {
      caps: { ...DEFAULT_CAPS, commit: { perMinute: 10, perDay: 2 } },
      now: () => now,
    });
    policy.consume("commit");
    now = new Date(NOW.getTime() + 120_000);
    policy.consume("commit");
    now = new Date(NOW.getTime() + 240_000);
    expect(() => policy.consume("commit")).toThrowError(/per day/);
  });

  it("counts each kind separately", () => {
    const home = testConfig().home;
    const policy = new Policy(home, {
      caps: { ...DEFAULT_CAPS, read: { perMinute: 1, perDay: 1 } },
      now: () => NOW,
    });
    policy.consume("read");
    expect(() => policy.consume("preview")).not.toThrow();
  });

  it("ships a commit budget far tighter than the read budget", () => {
    expect(DEFAULT_CAPS.commit.perDay).toBeLessThan(DEFAULT_CAPS.preview.perDay);
    expect(DEFAULT_CAPS.preview.perMinute).toBeLessThan(DEFAULT_CAPS.read.perMinute);
  });
});

describe("fail-closed", () => {
  it("denies rather than allows when the counter file is corrupt", () => {
    const home = testConfig().home;
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(counterPath(home), "{not json");
    const policy = new Policy(home, { now: () => NOW });
    // Resetting to zero on a corrupt file is what an attacker who can truncate it would want.
    expect(() => policy.consume("read")).toThrowError(/fails\s+closed|unusable/);
  });

  it("treats a missing file as a first call, not as a broken store", () => {
    const policy = new Policy(testConfig().home, { now: () => NOW });
    expect(() => policy.consume("read")).not.toThrow();
  });

  it("writes the counter file 0600", () => {
    const home = testConfig().home;
    new Policy(home, { now: () => NOW }).consume("read");
    expect(fs.statSync(counterPath(home)).mode & 0o777).toBe(0o600);
  });
});

describe("submit spends the budget of the PHASE, not of the tool", () => {
  function context(policy: Policy, responses: Parameters<typeof stubFetch>[0], home: string) {
    const config = testConfig({ submitEnabled: true, home });
    const stub = stubFetch(responses);
    const ctx: ToolContext = {
      config,
      api: new ApiClient(config, { fetchImpl: stub.fetchImpl }),
      policy,
      now: () => NOW,
      protocolVersion: "2026-07-28",
    };
    return { ctx, stub };
  }

  it("a preview spends preview, and nothing of commit", async () => {
    const home = testConfig().home;
    const policy = new Policy(home, { now: () => NOW });
    const { ctx } = context(policy, [{ body: {} }], home);
    await run({ document: validDocument() }, ctx);
    expect(policy.usage("preview").day).toBe(1);
    expect(policy.usage("commit").day).toBe(0);
  });

  it("a commit refused for a missing approval spends NO commit budget", async () => {
    const home = testConfig().home;
    const policy = new Policy(home, { now: () => NOW });
    const { ctx } = context(policy, [{ body: {} }], home);
    const preview = await run({ document: validDocument() }, ctx);
    const id = String(preview.structured.approvalId);
    await expect(run({ document: validDocument(), approvalId: id }, ctx)).rejects.toThrow();
    // Otherwise five refused attempts would exhaust the day's writes without one being made.
    expect(policy.usage("commit").day).toBe(0);
  });

  it("only the call that reaches the request spends commit budget", async () => {
    const home = testConfig().home;
    const policy = new Policy(home, { now: () => NOW });
    const { ctx, stub } = context(
      policy,
      [
        {
          body: {
            opportunity: validDocument(),
            created: true,
            reviewStatus: "pending",
            isListed: false,
            warnings: [],
            duplicateCheck: "ok",
            duplicates: [],
          },
        },
      ],
      home,
    );
    const preview = await run({ document: validDocument() }, ctx);
    const id = String(preview.structured.approvalId);
    const pending = listPending(home).find((r) => r.approvalId === id);
    if (pending === undefined) throw new Error("no pending record");
    writeApproval(home, {
      apiOrigin: pending.apiOrigin,
      keyFingerprint: pending.keyFingerprint,
      operation: pending.operation,
      protocolVersion: pending.protocolVersion,
      documentHash: pending.documentHash,
      approvalId: id,
      approvedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + APPROVAL_TTL_MS).toISOString(),
    });
    await run({ document: validDocument(), approvalId: id }, ctx);
    expect(stub.calls).toHaveLength(1);
    expect(policy.usage("commit").day).toBe(1);
    expect(policy.usage("preview").day).toBe(1);
  });
});
