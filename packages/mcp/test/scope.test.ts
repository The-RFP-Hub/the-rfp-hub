/**
 * The scope preflight: the write tool asks what the configured key may do before it does anything.
 * A `publish`-scoped key makes an approved submission live at once, so "it waits for review" would
 * be a claim about an entry that never waited; a key without `write` fails three phases in, after
 * a person has spent a single-use approval on it.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "../src/http.js";
import { Policy } from "../src/policy.js";
import { clearRegisteredSecrets, registerSecret } from "../src/redact.js";
import { readCredentialFacts, resetKeyScopeCache, scopeRefusal } from "../src/scope.js";
import { formatToolError, toToolError } from "../src/server.js";
import type { ToolContext } from "../src/tools/context.js";
import { run } from "../src/tools/submit.js";
import {
  FAKE_KEY,
  type StubResponse,
  rejection,
  stubFetch,
  tempHome,
  testConfig,
  validDocument,
} from "./helpers.js";

beforeEach(() => resetKeyScopeCache());
afterEach(() => {
  resetKeyScopeCache();
  clearRegisteredSecrets();
});

function context(me?: StubResponse) {
  const home = tempHome();
  const config = testConfig({ home });
  const stub = stubFetch([{ body: {} }], me === undefined ? {} : { me });
  const ctx: ToolContext = {
    config,
    api: new ApiClient(config, { fetchImpl: stub.fetchImpl }),
    policy: new Policy(home),
    now: () => new Date(),
    protocolVersion: "2026-07-28",
  };
  return { ctx, stub, home };
}

/** Nothing may be left behind for a person to approve. */
function pendingFiles(home: string): string[] {
  const dir = path.join(home, "pending");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
}

describe("a key the write path must not use", () => {
  it("refuses a `publish` key and writes no pending record", async () => {
    const { ctx, stub, home } = context({
      body: { credentialKind: "api_key", scopes: ["read", "write", "publish"] },
    });
    const error = await rejection(run({ document: validDocument() }, ctx));
    expect(error.code).toBe("policy_denied");
    expect(error.message).toContain("it carries `publish`");
    expect(error.message).toContain("go live immediately");
    expect(error.message).toContain("Mint a `write`-only key");
    expect(pendingFiles(home)).toHaveLength(0);
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses a key without `write` before the approval is ever asked for", async () => {
    const { ctx, stub, home } = context({ body: { credentialKind: "api_key", scopes: ["read"] } });
    const error = await rejection(run({ document: validDocument() }, ctx));
    expect(error.code).toBe("policy_denied");
    expect(error.message).toContain("it does not carry `write`");
    expect(error.message).toContain("single-use approval");
    expect(pendingFiles(home)).toHaveLength(0);
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses a credential the API does not report as an API key", async () => {
    const { ctx } = context({ body: { credentialKind: "session", scopes: [] } });
    const error = await rejection(run({ document: validDocument() }, ctx));
    expect(error.code).toBe("policy_denied");
    expect(error.message).toContain("not report the configured credential as an API key");
  });

  it("refuses a body carrying no scopes at all", async () => {
    const { ctx } = context({ body: { credentialKind: "api_key" } });
    const error = await rejection(run({ document: validDocument() }, ctx));
    expect(error.code).toBe("policy_denied");
    expect(error.message).toContain("no list of scopes");
  });

  it.each([401, 403])("reports a %s as the key not being accepted", async (status) => {
    const { ctx } = context({ status, body: { error: "unauthorized" } });
    const error = await rejection(run({ document: validDocument() }, ctx));
    expect(error.code).toBe("policy_denied");
    expect(error.message).toContain("the key was not accepted");
  });
});

describe("a key the write path may use", () => {
  it("lets the preview through", async () => {
    const { ctx, stub } = context();
    const preview = await run({ document: validDocument() }, ctx);
    expect(preview.structured.status).toBe("pending");
    expect(stub.meCalls).toHaveLength(1);
    expect(stub.calls).toHaveLength(0);
  });

  it("sends the credential on that one read, and on no other", async () => {
    const { ctx, stub } = context();
    await run({ document: validDocument() }, ctx);
    const headers = stub.meCalls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it("asks once for the life of the client", async () => {
    const { ctx, stub } = context();
    await run({ document: validDocument() }, ctx);
    await run({ document: validDocument({ title: "A Second Program" }) }, ctx);
    expect(stub.meCalls).toHaveLength(1);
  });

  /** One process can hold two servers on two credentials, and a verdict about one key says
   * nothing about the other. */
  it("does not lend its verdict to a second client in the same process", async () => {
    const allowed = context();
    await run({ document: validDocument() }, allowed.ctx);
    expect(allowed.stub.meCalls).toHaveLength(1);

    const refused = context({
      body: { credentialKind: "api_key", scopes: ["read", "publish"] },
    });
    const error = await rejection(run({ document: validDocument() }, refused.ctx));
    expect(error.code).toBe("policy_denied");
    expect(refused.stub.meCalls).toHaveLength(1);
  });
});

describe("a preflight that got no answer", () => {
  it("fails as exec_failed and is asked again on the next call", async () => {
    const { ctx, stub } = context({ status: 500, body: { error: "internal" } });
    const first = await rejection(run({ document: validDocument() }, ctx));
    expect(first.code).toBe("exec_failed");
    expect(stub.meCalls).toHaveLength(1);

    const second = await rejection(run({ document: validDocument() }, ctx));
    expect(second.code).toBe("exec_failed");
    expect(stub.meCalls).toHaveLength(2);
  });

  it("remembers a refusal rather than re-asking", async () => {
    const { ctx, stub } = context({ body: { credentialKind: "api_key", scopes: ["publish"] } });
    await rejection(run({ document: validDocument() }, ctx));
    await rejection(run({ document: validDocument() }, ctx));
    expect(stub.meCalls).toHaveLength(1);
  });
});

describe("the refusal carries no credential", () => {
  it("redacts a key-shaped scope the API echoed back", async () => {
    registerSecret(FAKE_KEY);
    const { ctx } = context({ body: { credentialKind: "api_key", scopes: ["read", FAKE_KEY] } });
    const error = await rejection(run({ document: validDocument() }, ctx));
    const wire = formatToolError(toToolError(error));
    expect(wire).not.toContain(FAKE_KEY);
    expect(wire).toContain("[policy_denied]");
  });
});

describe("the facts are read off the body rather than trusted", () => {
  it.each([null, "text", 42, ["read"]])("copes with %s", (body) => {
    expect(readCredentialFacts(body)).toEqual({ credentialKind: null, scopes: null });
  });

  it("keeps only the string members of a mixed scopes array", () => {
    const facts = readCredentialFacts({ credentialKind: "api_key", scopes: ["write", 7, null] });
    expect(facts.scopes).toEqual(["write"]);
  });

  it("passes a key scoped exactly as the write path needs", () => {
    expect(scopeRefusal({ credentialKind: "api_key", scopes: ["read", "write"] })).toBeNull();
  });

  /** The API's `canWriteWith` accepts `write` OR `publish`, so a `publish` key is not ALSO
   * missing `write` — saying so would send someone to mint the scope they already outrank. */
  it("refuses a `publish` key for publishing, never for a missing `write`", () => {
    const refusal = scopeRefusal({ credentialKind: "api_key", scopes: ["read", "publish"] }) ?? "";
    expect(refusal).toContain("it carries `publish`");
    expect(refusal).not.toContain("does not carry `write`");
  });
});
