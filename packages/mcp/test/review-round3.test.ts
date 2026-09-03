/**
 * The third round of review findings.
 *
 * Two themes. Most of them are about a claim being narrower than it sounded — "we did not follow
 * the redirect" is not "nothing was written", a 2xx is not a submission result, `keyConfigured` is
 * not "a key exists". The rest are resource hygiene: bodies that were abandoned rather than
 * canceled, and a stale-lock break that could delete a live lock.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/audit.js";
import { ID_RULE, apiErrorToToolError } from "../src/errors.js";
import { ApiClient, MAX_RESPONSE_BYTES, isSubmissionResult, readCapped } from "../src/http.js";
import { withLock } from "../src/lock.js";
import { DEFAULT_CAPS, Policy } from "../src/policy.js";
import { clearRegisteredSecrets } from "../src/redact.js";
import { createServer } from "../src/server.js";
import {
  FAKE_KEY,
  listPage,
  rejection,
  stubFetch,
  tempHome,
  testConfig,
  validDocument,
} from "./helpers.js";

afterEach(() => clearRegisteredSecrets());

const NOW = new Date("2026-06-01T12:00:00Z");
const PKG = path.resolve(import.meta.dirname, "..");
const DIST = path.join(PKG, "dist/index.cjs");

// ────────────────────────────────────────────── 1. the build cannot eat its own output ──
describe("the build emits both entry points", () => {
  it("leaves dist/cli.js in place, which is what `bin` points at", () => {
    // The failure this guards against is specific and quiet: with `clean: true` on one of two
    // array-config builds, the cleaner can delete what the other has already written, and the file
    // it eats is the executable. Every other check in the build still passes.
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };
    for (const target of Object.values(pkg.bin)) {
      expect(fs.existsSync(path.join(PKG, target)), `${target} is missing from dist`).toBe(true);
    }
  });

  it("ships an executable that actually runs", () => {
    const out = execFileSync(process.execPath, [path.join(PKG, "dist/cli.js"), "--version"], {
      encoding: "utf8",
    });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("cleans exactly once, before either build, rather than during one of them", () => {
    const config = fs.readFileSync(path.join(PKG, "tsup.config.ts"), "utf8");
    expect(config).toContain("NEITHER BUILD CLEANS");
    expect(config).not.toMatch(/clean:\s*true/);
  });
});

// ────────────────────────────────────── 3. a 2xx that is not a submission result ──
describe("a write's 2xx body is checked before it is believed", () => {
  const cases: Record<string, { status?: number; body?: unknown; raw?: string }> = {
    "an empty 200": { status: 200, raw: "" },
    "an empty object": { status: 200, body: {} },
    "a body from something that is not this API": { status: 200, body: { ok: true } },
    "a result with no opportunity id": {
      status: 200,
      body: { opportunity: {}, created: true, reviewStatus: "pending", isListed: false },
    },
    "a result whose flags are the wrong type": {
      status: 201,
      body: {
        opportunity: { id: "org:x" },
        created: "yes",
        reviewStatus: "pending",
        isListed: false,
      },
    },
  };

  for (const [what, response] of Object.entries(cases)) {
    it(`treats ${what} as ambiguous`, async () => {
      const client = new ApiClient(testConfig(), { fetchImpl: stubFetch([response]).fetchImpl });
      const error = await rejection(client.submitOpportunity(validDocument()));
      expect(error.message, what).toContain("may have landed");
      expect(error.details?.ambiguous, what).toBe(true);
    });
  }

  it("accepts a well-formed result", async () => {
    const client = new ApiClient(testConfig(), {
      fetchImpl: stubFetch([
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
      ]).fetchImpl,
    });
    await expect(client.submitOpportunity(validDocument())).resolves.toMatchObject({
      created: true,
    });
  });

  it("checks every member it consumes, and tolerates ones it does not", () => {
    const complete = {
      opportunity: { id: "org:x" },
      created: true,
      reviewStatus: "pending",
      isListed: false,
      warnings: [],
      duplicateCheck: "ok",
      duplicates: [],
    };
    // A response that is fine and merely NEWER must not be rejected: this client does not own the
    // contract, and refusing unknown members would break on the API's next additive change.
    expect(isSubmissionResult({ ...complete, somethingAddedLater: 42 })).toBe(true);
    expect(isSubmissionResult(null)).toBe(false);
    expect(isSubmissionResult("a string")).toBe(false);
    expect(isSubmissionResult({ opportunity: { id: 1 } })).toBe(false);
    // Everything the renderer reads is required, because a missing one renders as a plausible
    // success and an unknown enum value crashes an exhaustive switch after the write has landed.
    expect(isSubmissionResult({ ...complete, warnings: undefined })).toBe(false);
    expect(isSubmissionResult({ ...complete, duplicates: undefined })).toBe(false);
    expect(isSubmissionResult({ ...complete, duplicateCheck: "future-value" })).toBe(false);
    expect(isSubmissionResult({ ...complete, reviewStatus: "quarantined" })).toBe(false);
    expect(isSubmissionResult({ ...complete, warnings: [1] })).toBe(false);
    expect(isSubmissionResult({ ...complete, duplicates: [{ id: "a" }] })).toBe(false);
  });
});

// ─────────────────────────────── 4. a pre-handler rejection is metered as a submit ──
describe("arguments rejected before the handler still spend the write tool's budget", () => {
  interface Seams {
    validateToolInput(tool: unknown, args: unknown, toolName: string): Promise<unknown>;
    _registeredTools: Record<string, { executor: (a: unknown, c: unknown) => Promise<unknown> }>;
  }

  function build(home: string, policy: Policy) {
    const config = testConfig({ home });
    const server = createServer({
      config,
      api: new ApiClient(config, { fetchImpl: stubFetch([{ body: {} }]).fetchImpl }),
      policy,
      now: () => NOW,
    });
    return server as unknown as Seams;
  }

  it("charges an attempt when the SDK rejects the arguments", async () => {
    const home = tempHome();
    const policy = new Policy(home, { now: () => NOW });
    const seams = build(home, policy);
    const tool = seams._registeredTools.submit_opportunity;

    // Malformed: `document` is required, and an unknown key is refused by the strict schema.
    await expect(
      seams.validateToolInput(tool, { nope: 1 }, "submit_opportunity"),
    ).rejects.toThrow();
    expect(policy.usage("attempt").day).toBe(1);
  });

  it("audits it as the submit tool, not as a read", async () => {
    const home = tempHome();
    const seams = build(home, new Policy(home, { now: () => NOW }));
    const tool = seams._registeredTools.submit_opportunity;
    await expect(
      seams.validateToolInput(tool, { nope: 1 }, "submit_opportunity"),
    ).rejects.toThrow();

    const line = fs.readFileSync(auditPath(home), "utf8").trim().split("\n").at(-1) ?? "";
    const entry = JSON.parse(line) as { tool: string; kind: string; status: string };
    expect(entry).toMatchObject({
      tool: "submit_opportunity",
      kind: "attempt",
      status: "invalid_input",
    });
  });

  it("does not charge a read tool's rejection to the write budget", async () => {
    const home = tempHome();
    const policy = new Policy(home, { now: () => NOW });
    const seams = build(home, policy);
    const tool = seams._registeredTools.search_opportunities;
    await expect(
      seams.validateToolInput(tool, { nope: 1 }, "search_opportunities"),
    ).rejects.toThrow();
    expect(policy.usage("attempt").day).toBe(0);
  });

  it("does NOT double-charge a call that passes validation", async () => {
    const home = tempHome();
    const policy = new Policy(home, { now: () => NOW });
    const seams = build(home, policy);

    // A valid call goes through the handler, which charges its own attempt. One, not two.
    await seams._registeredTools.submit_opportunity?.executor(
      { document: validDocument(), approvalId: "0".repeat(64) },
      {},
    );
    expect(policy.usage("attempt").day).toBe(1);
  });

  it("returns the SCHEMA error even when the attempt budget is already gone", async () => {
    const home = tempHome();
    const policy = new Policy(home, {
      caps: { ...DEFAULT_CAPS, attempt: { perMinute: 0, perDay: 0 } },
      now: () => NOW,
    });
    const seams = build(home, policy);
    const tool = seams._registeredTools.submit_opportunity;
    // The arguments are still wrong; `rate_limited` here would send the caller to fix the wrong
    // thing entirely.
    const error = await rejection(seams.validateToolInput(tool, { nope: 1 }, "submit_opportunity"));
    expect(error.message).toContain("[invalid_input]");
    expect(error.message).not.toContain("rate_limited");
  });
});

// ─────────────────────────── 5. breaking a stale lock cannot delete a live one ──
describe("a stale lock is broken atomically", () => {
  it("lets exactly one of two racing PROCESSES break the same stale lock", () => {
    const home = tempHome();
    const dir = path.join(home, "contended.lock");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(home, "evidence"), { recursive: true });

    // Both processes see the same abandoned lock, both break it, both then hold it while writing a
    // marker and sleeping. With a non-atomic `rm`-then-`mkdir`, the loser's `rm` deletes the
    // winner's LIVE lock and both run the critical section at once — two markers.
    const script = `
      const { withLock } = require(process.argv[1]);
      const fs = require("node:fs");
      const path = require("node:path");
      withLock(process.argv[2], () => {
        const marker = path.join(process.argv[3], String(process.pid));
        const held = fs.readdirSync(process.argv[3]);
        fs.writeFileSync(marker, held.join(","));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        fs.unlinkSync(marker);
      }, { staleMs: 0, timeoutMs: 5000 });
      process.stdout.write("done");
    `;
    if (!fs.existsSync(DIST)) throw new Error("run `pnpm --filter @the-rfp-hub/mcp build` first");

    const run = () =>
      execFileSync("node", ["-e", script, DIST, dir, path.join(home, "evidence")], {
        encoding: "utf8",
      });
    // Sequential here would prove nothing; the marker file each one writes records who else was
    // inside the section at the same moment.
    const outputs = [run(), run()];
    expect(outputs).toEqual(["done", "done"]);
    // Nobody ever saw another holder's marker: the sections did not overlap.
    expect(fs.readdirSync(path.join(home, "evidence"))).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("does not leave the tombstone behind", () => {
    const home = tempHome();
    const dir = path.join(home, "stale.lock");
    fs.mkdirSync(dir, { recursive: true });
    withLock(dir, () => "ok", { staleMs: 0, timeoutMs: 1_000 });
    const leftovers = fs.readdirSync(home).filter((n) => n.includes(".stale."));
    expect(leftovers).toEqual([]);
  });

  it("renames rather than removes, so a live lock cannot be deleted by a racing breaker", () => {
    const source = fs.readFileSync(path.join(PKG, "src/lock.ts"), "utf8");
    expect(source).toContain("breaking is itself atomic");
    expect(source).toContain("fs.renameSync(dir, tombstone)");
    expect(source).not.toContain(
      "fs.rmSync(dir, { recursive: true, force: true });\n  } catch {\n    return",
    );
  });
});

// ────────────────────────────────── 6. inherited members are not tools ──
describe("the tool lookup answers for own properties only", () => {
  function tools(home: string) {
    const config = testConfig({ apiKey: null, home });
    const server = createServer({
      config,
      api: new ApiClient(config, { fetchImpl: stubFetch([{ body: {} }]).fetchImpl }),
      policy: new Policy(home, { now: () => NOW }),
      now: () => NOW,
    });
    return (
      server as unknown as {
        _registeredTools: Record<
          string,
          { executor?: (a: unknown, c: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools;
  }

  for (const inherited of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
    it(`answers tool_not_found for the inherited \`${inherited}\``, async () => {
      const registry = tools(tempHome());
      const entry = registry[inherited];
      // `Reflect.has` would have found these on Object.prototype and handed back a function that
      // is not a tool, which the dispatcher would then try to use as one.
      expect(typeof entry?.executor, inherited).toBe("function");
      let message = "";
      try {
        await entry?.executor?.({}, {});
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, inherited).toContain("[tool_not_found]");
    });
  }

  it("still returns the real tools", () => {
    const registry = tools(tempHome());
    expect(registry.search_opportunities?.executor).toBeTypeOf("function");
    expect(Object.keys(registry).sort()).toEqual(["fetch_opportunity", "search_opportunities"]);
  });
});

// ────────────────────────────────── 7. the id rule goes where an id was supplied ──
describe("the id rule is attached only where the caller supplied an id", () => {
  it("is attached to a submission's 400", () => {
    const error = apiErrorToToolError(
      400,
      { error: "publisher_not_operating" },
      { operation: "submit_opportunity", keyConfigured: true },
    );
    expect(error.message).toContain(ID_RULE);
  });

  it("is attached to a fetch's 400", () => {
    const error = apiErrorToToolError(
      400,
      { error: "bad_request" },
      { operation: "fetch_opportunity", keyConfigured: false },
    );
    expect(error.message).toContain(ID_RULE);
  });

  it("is NOT attached to a search's 400 — nothing there carries an id", () => {
    const error = apiErrorToToolError(
      400,
      { error: "bad_request", message: "unknown query parameter" },
      { operation: "search_opportunities", keyConfigured: false },
    );
    expect(error.message).toContain("unknown query parameter");
    expect(error.message).not.toContain("operatingOrganizations[].slug");
  });

  it("never attaches it to a field-by-field validation report", () => {
    const error = apiErrorToToolError(
      400,
      { error: "validation_failed", issues: [{ path: "/title", message: "must be a string" }] },
      { operation: "submit_opportunity", keyConfigured: true },
    );
    expect(error.message).toContain("/title");
    expect(error.message).not.toContain(ID_RULE);
  });
});

// ──────────────────── 8. keyConfigured describes THIS request, not the environment ──
describe("a 401 on a read never claims a credential was rejected", () => {
  it("tells an anonymous read that reads need no key, even with one in the environment", async () => {
    // The config HAS a key. The read did not send it, so "the API rejected the configured
    // credential" would be false and would send somebody to rotate a key that is fine.
    const client = new ApiClient(testConfig({ apiKey: FAKE_KEY }), {
      fetchImpl: stubFetch([{ status: 401, body: { error: "unauthorized" } }]).fetchImpl,
    });
    const error = await rejection(client.getOpportunity("org:x"));
    expect(error.message).toContain("Reads are anonymous");
    expect(error.message).not.toContain("rejected the configured credential");
  });

  it("does tell a WRITE that its credential was rejected", async () => {
    const client = new ApiClient(testConfig({ apiKey: FAKE_KEY }), {
      fetchImpl: stubFetch([{ status: 401, body: { error: "unauthorized" } }]).fetchImpl,
    });
    const error = await rejection(client.submitOpportunity(validDocument()));
    expect(error.message).toContain("rejected the configured credential");
    expect(error.message).not.toContain(FAKE_KEY);
  });
});

// ──────────────────────────────── 9 & 10. bodies are canceled, not abandoned ──
describe("refused responses release their connection", () => {
  it("cancels the first 429's body before sleeping and retrying", async () => {
    let canceled = false;
    const first = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 429, headers: { "retry-after": "0" } },
    );
    let call = 0;
    const client = new ApiClient(testConfig(), {
      sleep: async () => {
        // By the time the retry waits, the refused body must already be released.
        expect(canceled).toBe(true);
      },
      fetchImpl: async () => {
        call += 1;
        return call === 1 ? first : new Response(JSON.stringify(listPage([])));
      },
    });
    const page = await client.listOpportunities(new URLSearchParams());
    expect(page.total).toBe(0);
    expect(canceled).toBe(true);
  });

  it("cancels the body when Content-Length alone puts it over the cap", async () => {
    let canceled = false;
    const res = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("the body was read despite an over-cap content-length");
        },
        cancel() {
          canceled = true;
        },
      }),
      { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } },
    );
    await expect(readCapped(res)).rejects.toThrow();
    expect(canceled).toBe(true);
  });

  it("cancels the body of an unfollowed redirect on a write", async () => {
    let canceled = false;
    const res = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("ignored"));
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 303, headers: { location: "https://elsewhere.test/x" } },
    );
    const client = new ApiClient(testConfig(), { fetchImpl: async () => res });
    await rejection(client.submitOpportunity(validDocument()));
    expect(canceled).toBe(true);
  });
});
