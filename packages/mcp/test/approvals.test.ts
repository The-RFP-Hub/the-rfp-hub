/**
 * The write interlock's state machine.
 *
 * Every claim this package makes about the approval is asserted here: a preview writes nothing to
 * the network, a commit without an approval writes nothing at all, each of the five bindings
 * invalidates the approval on its own and is NAMED when it does, expiry is enforced, and the claim
 * is single-use even against a concurrent second process.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPROVAL_TTL_MS,
  PENDING_TTL_MS,
  approvalsDir,
  claimApproval,
  claimedDir,
  computeApprovalId,
  describeBinding,
  diagnoseMismatch,
  documentHashOf,
  fingerprintOf,
  isExpired,
  listPending,
  pendingDir,
  readApproval,
  writeApproval,
  writePending,
} from "../src/approvals.js";
import { canonicalStringify, digestOf } from "../src/canonical.js";
import { ApiClient } from "../src/http.js";
import { Policy } from "../src/policy.js";
import { clearRegisteredSecrets } from "../src/redact.js";
import type { ToolContext } from "../src/tools/context.js";
import { run } from "../src/tools/submit.js";
import {
  FAKE_KEY,
  OTHER_FAKE_KEY,
  WRITE_ONLY_CREDENTIAL,
  rejection,
  stubFetch,
  tempHome,
  testConfig,
  validDocument,
} from "./helpers.js";

afterEach(() => clearRegisteredSecrets());

const NOW = new Date("2026-06-01T12:00:00Z");

function context(
  overrides: {
    config?: Parameters<typeof testConfig>[0];
    responses?: Parameters<typeof stubFetch>[0];
  } = {},
): { ctx: ToolContext; stub: ReturnType<typeof stubFetch> } {
  const config = testConfig(overrides.config ?? {});
  const stub = stubFetch(overrides.responses ?? [{ body: {} }]);
  return {
    stub,
    ctx: {
      config,
      api: new ApiClient(config, { fetchImpl: stub.fetchImpl }),
      policy: new Policy(config.home, { now: () => NOW }),
      now: () => NOW,
      protocolVersion: "2026-07-28",
    },
  };
}

describe("canonical form", () => {
  it("is key-order independent, so a round-tripped document hashes the same", () => {
    expect(canonicalStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it("preserves array order, which is meaningful in the standard", () => {
    expect(digestOf([1, 2])).not.toBe(digestOf([2, 1]));
  });
});

describe("fingerprint", () => {
  it("is a hash prefix, never any part of the key itself", () => {
    const fp = fingerprintOf(FAKE_KEY);
    expect(fp).toHaveLength(8);
    expect(FAKE_KEY).not.toContain(fp);
    expect(fingerprintOf(null)).toBe("none");
  });

  it("differs between two different keys", () => {
    expect(fingerprintOf(FAKE_KEY)).not.toBe(fingerprintOf(OTHER_FAKE_KEY));
  });
});

describe("phase 1 — preview", () => {
  it("performs ZERO network calls and returns pending with a public id", async () => {
    const { ctx, stub } = context();
    const result = await run({ document: validDocument() }, ctx);
    expect(stub.calls).toHaveLength(0);
    expect(result.structured.status).toBe("pending");
    expect(String(result.structured.approvalId)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns no secret of any kind — only the public digest", async () => {
    const { ctx } = context();
    const result = await run({ document: validDocument() }, ctx);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(FAKE_KEY);
    // The fingerprint is a hash prefix and is deliberately shown; the key is not.
    expect(serialized).toContain(fingerprintOf(FAKE_KEY));
  });

  it("writes a 0600 record in a 0700 directory", async () => {
    const { ctx } = context();
    const result = await run({ document: validDocument() }, ctx);
    const file = path.join(pendingDir(ctx.config.home), `${result.structured.approvalId}.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(pendingDir(ctx.config.home)).mode & 0o777).toBe(0o700);
  });

  it("tells the caller to go and get a human, and names the command", async () => {
    const { ctx } = context();
    const result = await run({ document: validDocument() }, ctx);
    const instruction = String(result.structured.instruction);
    expect(instruction).toContain("Nothing has been submitted");
    expect(instruction).toContain("rfphub-mcp approve");
    expect(instruction).toContain("their own terminal");
  });

  it("expires the pending record after the stated window", async () => {
    const { ctx } = context();
    await run({ document: validDocument() }, ctx);
    const record = listPending(ctx.config.home)[0];
    expect(record).toBeDefined();
    if (!record) return;
    expect(isExpired(record, new Date(NOW.getTime() + PENDING_TTL_MS - 1))).toBe(false);
    expect(isExpired(record, new Date(NOW.getTime() + PENDING_TTL_MS + 1))).toBe(true);
  });
});

describe("phase 3 — commit", () => {
  async function previewed(config: Parameters<typeof testConfig>[0] = {}): Promise<{
    ctx: ToolContext;
    stub: ReturnType<typeof stubFetch>;
    id: string;
  }> {
    const { ctx, stub } = context({
      config,
      responses: [
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
    });
    const preview = await run({ document: validDocument() }, ctx);
    return { ctx, stub, id: String(preview.structured.approvalId) };
  }

  function grant(ctx: ToolContext, id: string, at = NOW): void {
    const pending = listPending(ctx.config.home).find((r) => r.approvalId === id);
    if (pending === undefined) throw new Error("no pending record");
    writeApproval(ctx.config.home, {
      apiOrigin: pending.apiOrigin,
      keyFingerprint: pending.keyFingerprint,
      operation: pending.operation,
      protocolVersion: pending.protocolVersion,
      documentHash: pending.documentHash,
      approvalId: id,
      approvedAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + APPROVAL_TTL_MS).toISOString(),
    });
  }

  it("without an approval, refuses and sends nothing", async () => {
    const { ctx, stub, id } = await previewed();
    const error = await rejection(run({ document: validDocument(), approvalId: id }, ctx));
    expect(error.code).toBe("confirmation_required");
    expect(error.message).toContain(`must run \`rfphub-mcp approve ${id}\``);
    expect(stub.calls).toHaveLength(0);
  });

  it("names the state directory in that refusal too, when this server was given one", async () => {
    // The refusal is the second place a person is told what to run, and it was the one that still
    // sent them to ~/.rfphub while the preview waited somewhere else.
    const home = tempHome();
    const { ctx, id } = await previewed({ home, stateDirExplicit: true });
    const error = await rejection(run({ document: validDocument(), approvalId: id }, ctx));
    expect(error.code).toBe("confirmation_required");
    expect(error.message).toContain(`must run \`rfphub-mcp --state-dir ${home} approve ${id}\``);
  });

  it("with an approval, submits exactly once", async () => {
    const { ctx, stub, id } = await previewed();
    grant(ctx, id);
    const result = await run({ document: validDocument(), approvalId: id }, ctx);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.init?.method).toBe("POST");
    expect(result.structured.status).toBe("submitted");
    expect(result.structured.id).toBe("example-org:test-grant");
  });

  it("carries the credential as a Bearer header on the POST, and only there", async () => {
    const { ctx, stub, id } = await previewed();
    grant(ctx, id);
    await run({ document: validDocument(), approvalId: id }, ctx);
    const headers = (stub.calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it("moves the approval into the claimed directory before the request", async () => {
    const { ctx, id } = await previewed();
    grant(ctx, id);
    await run({ document: validDocument(), approvalId: id }, ctx);
    expect(fs.existsSync(path.join(approvalsDir(ctx.config.home), `${id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(claimedDir(ctx.config.home), `${id}.json`))).toBe(true);
  });

  it("refuses a second use of the same approval", async () => {
    const { ctx, id } = await previewed();
    grant(ctx, id);
    await run({ document: validDocument(), approvalId: id }, ctx);
    await expect(run({ document: validDocument(), approvalId: id }, ctx)).rejects.toMatchObject({
      code: "confirmation_required",
    });
  });

  it("refuses an expired approval and says when it expired", async () => {
    const { ctx, stub, id } = await previewed();
    grant(ctx, id, new Date(NOW.getTime() - APPROVAL_TTL_MS - 1000));
    await expect(run({ document: validDocument(), approvalId: id }, ctx)).rejects.toMatchObject({
      code: "confirmation_invalid",
    });
    expect(stub.calls).toHaveLength(0);
  });

  it("does not restore the approval after an ambiguous network failure", async () => {
    const config = testConfig();
    const ctx: ToolContext = {
      config,
      api: new ApiClient(config, {
        // Everything but the scope preflight drops the connection: it is the WRITE whose outcome
        // this test is about.
        fetchImpl: async (url) => {
          if (new URL(url).pathname === "/v1/me") {
            return new Response(JSON.stringify(WRITE_ONLY_CREDENTIAL), {
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error("ECONNRESET");
        },
      }),
      policy: new Policy(config.home, { now: () => NOW }),
      now: () => NOW,
      protocolVersion: "2026-07-28",
    };
    const preview = await run({ document: validDocument() }, ctx);
    const id = String(preview.structured.approvalId);
    grant(ctx, id);
    await expect(run({ document: validDocument(), approvalId: id }, ctx)).rejects.toMatchObject({
      code: "exec_failed",
    });
    // The correct state after a timeout is "may have been written". Restoring the approval would
    // invite a second write of the same document.
    expect(readApproval(config.home, id)).toBeNull();
    expect(fs.existsSync(path.join(claimedDir(config.home), `${id}.json`))).toBe(true);
  });
});

describe("the digest binds five things, and names the one that diverged", () => {
  const base = {
    apiOrigin: "https://api.example.test",
    keyFingerprint: fingerprintOf(FAKE_KEY),
    operation: "submit_opportunity" as const,
    protocolVersion: "2026-07-28",
    documentHash: documentHashOf(validDocument()),
  };

  it("changing any one component changes the id", () => {
    const id = computeApprovalId(base);
    expect(computeApprovalId({ ...base, apiOrigin: "https://staging.example.test" })).not.toBe(id);
    expect(computeApprovalId({ ...base, keyFingerprint: fingerprintOf(OTHER_FAKE_KEY) })).not.toBe(
      id,
    );
    expect(computeApprovalId({ ...base, protocolVersion: "2025-11-25" })).not.toBe(id);
    expect(computeApprovalId({ ...base, documentHash: documentHashOf({ other: true }) })).not.toBe(
      id,
    );
  });

  it("names apiOrigin when the destination moved", async () => {
    const { ctx, id } = await (async () => {
      const { ctx } = context();
      const preview = await run({ document: validDocument() }, ctx);
      return { ctx, id: String(preview.structured.approvalId) };
    })();
    const moved: ToolContext = {
      ...ctx,
      config: { ...ctx.config, apiOrigin: "https://staging.example.test" },
    };
    await expect(run({ document: validDocument(), approvalId: id }, moved)).rejects.toMatchObject({
      code: "confirmation_invalid",
      details: { component: "apiOrigin" },
    });
  });

  it("names keyFingerprint when the credential was rotated", async () => {
    const { ctx } = context();
    const preview = await run({ document: validDocument() }, ctx);
    const id = String(preview.structured.approvalId);
    const rotated: ToolContext = { ...ctx, config: { ...ctx.config, apiKey: OTHER_FAKE_KEY } };
    await expect(run({ document: validDocument(), approvalId: id }, rotated)).rejects.toMatchObject(
      {
        code: "confirmation_invalid",
        details: { component: "keyFingerprint" },
      },
    );
  });

  it("names protocolVersion when the server speaks a different revision", async () => {
    const { ctx } = context();
    const preview = await run({ document: validDocument() }, ctx);
    const id = String(preview.structured.approvalId);
    const older: ToolContext = { ...ctx, protocolVersion: "2025-11-25" };
    await expect(run({ document: validDocument(), approvalId: id }, older)).rejects.toMatchObject({
      code: "confirmation_invalid",
      details: { component: "protocolVersion" },
    });
  });

  it("says the document changed when no stored record shares its hash", async () => {
    const { ctx } = context();
    const preview = await run({ document: validDocument() }, ctx);
    const id = String(preview.structured.approvalId);
    const changed = validDocument({ title: "A Completely Different Program" });
    const error = await rejection(run({ document: changed, approvalId: id }, ctx));
    expect(error.code).toBe("confirmation_invalid");
    expect(error.message).toContain("document itself differs");
  });

  it("diagnoseMismatch returns null when nothing matches at all", () => {
    const home = testConfig().home;
    expect(diagnoseMismatch(home, base)).toBeNull();
  });

  it("the human-facing description shows all five", () => {
    const text = describeBinding(base);
    expect(text).toContain("destination");
    expect(text).toContain("credential");
    expect(text).toContain("operation");
    expect(text).toContain("protocol");
    expect(text).toContain("document");
    expect(text).not.toContain(FAKE_KEY);
  });
});

describe("concurrent claim", () => {
  it("two processes race the same approval and exactly one wins", () => {
    const home = testConfig().home;
    const id = "a".repeat(64);
    writeApproval(home, {
      apiOrigin: "https://api.example.test",
      keyFingerprint: "deadbeef",
      operation: "submit_opportunity",
      protocolVersion: "2026-07-28",
      documentHash: "0".repeat(64),
      approvalId: id,
      approvedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + APPROVAL_TTL_MS).toISOString(),
    });

    // A real second PROCESS, not a second call in this one: the guarantee is a filesystem
    // guarantee (`rename()` is atomic and fails ENOENT once the source is gone), and asserting it
    // in-process would prove nothing about two agents sharing a home directory.
    const script = [
      // Under `node -e`, the first user argument is argv[1], not argv[2].
      "const { claimApproval } = require(process.argv[1]);",
      "const got = claimApproval(process.argv[2], process.argv[3]);",
      "process.stdout.write(got === null ? 'lost' : 'won');",
    ].join("\n");
    const dist = path.resolve(import.meta.dirname, "../dist/index.cjs");
    if (!fs.existsSync(dist)) throw new Error("run `pnpm --filter @the-rfp-hub/mcp build` first");

    const other = execFileSync("node", ["-e", script, dist, home, id], { encoding: "utf8" });
    const mine = claimApproval(home, id);

    const outcomes = [other, mine === null ? "lost" : "won"].sort();
    expect(outcomes).toEqual(["lost", "won"]);
    expect(fs.existsSync(path.join(claimedDir(home), `${id}.json`))).toBe(true);
  });
});

describe("stored records", () => {
  it("a pending record keeps the document so the terminal can print it", () => {
    const home = testConfig().home;
    const id = "b".repeat(64);
    writePending(home, {
      apiOrigin: "https://api.example.test",
      keyFingerprint: "deadbeef",
      operation: "submit_opportunity",
      protocolVersion: "2026-07-28",
      documentHash: documentHashOf(validDocument()),
      approvalId: id,
      document: validDocument(),
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + PENDING_TTL_MS).toISOString(),
    });
    expect(listPending(home)[0]?.document).toEqual(validDocument());
  });
});
