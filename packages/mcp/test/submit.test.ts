/**
 * Phase 0, local validation, and the way the three duplicate-check states are reported.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "../src/http.js";
import { Policy } from "../src/policy.js";
import { clearRegisteredSecrets } from "../src/redact.js";
import type { ToolContext } from "../src/tools/context.js";
import {
  deriveFacts,
  explainDuplicateCheck,
  inputSchema,
  outputSchema,
  rejectEmbeddedCredential,
  renderSubmission,
  run,
} from "../src/tools/submit.js";
import { FAKE_KEY, rejection, stubFetch, testConfig, validDocument } from "./helpers.js";

afterEach(() => clearRegisteredSecrets());

function context(overrides: { apiKey?: string | null } = {}) {
  const config = testConfig({ submitEnabled: true, ...overrides });
  const stub = stubFetch([{ body: {} }]);
  const ctx: ToolContext = {
    config,
    api: new ApiClient(config, { fetchImpl: stub.fetchImpl }),
    policy: new Policy(config.home, { now: () => new Date("2026-06-01T12:00:00Z") }),
    now: () => new Date("2026-06-01T12:00:00Z"),
    protocolVersion: "2026-07-28",
  };
  return { ctx, stub };
}

describe("input schema", () => {
  it("takes a document, an optional approval id, and nothing else", () => {
    expect(inputSchema.safeParse({ document: {} }).success).toBe(true);
    expect(inputSchema.safeParse({ document: {}, approvalId: "a".repeat(64) }).success).toBe(true);
    expect(inputSchema.safeParse({ document: {}, apiKey: FAKE_KEY }).success).toBe(false);
    expect(inputSchema.safeParse({ document: {}, approvalId: "short" }).success).toBe(false);
  });

  it("has no parameter through which a credential could be passed", () => {
    const shape = Object.keys(inputSchema.shape);
    expect(shape).toEqual(["document", "approvalId"]);
  });
});

describe("phase 0 — a credential inside the document", () => {
  it("is refused wherever it hides, before any network call", async () => {
    const places: Record<string, Record<string, unknown>> = {
      description: validDocument({ description: `Apply with ${FAKE_KEY} to be considered.` }),
      "nested contact": validDocument({
        operatingOrganizations: [{ name: "Example", slug: "example-org", website: FAKE_KEY }],
      }),
      "array member": validDocument({ categories: ["ok", FAKE_KEY] }),
      "property name": validDocument({ [FAKE_KEY]: "value" }),
    };
    for (const [where, document] of Object.entries(places)) {
      const { ctx, stub } = context();
      const error = await rejection(run({ document }, ctx));
      expect(error, where).toMatchObject({ code: "invalid_input" });
      expect(stub.calls, where).toHaveLength(0);
    }
  });

  it("explains WHY output redaction would not have been enough", () => {
    const error = (() => {
      try {
        rejectEmbeddedCredential({ description: FAKE_KEY });
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a rejection");
    })();
    expect(error.message).toContain("stores the text it is given");
    expect(error.message).toContain("/description");
  });

  it("runs BEFORE schema validation, so an invalid document with a key still refuses for the key", async () => {
    const { ctx } = context();
    const error = await rejection(run({ document: { junk: FAKE_KEY } }, ctx));
    expect(error.message).toContain("shaped like an RFP Hub API key");
  });

  it("lets a clean document through", () => {
    expect(() => rejectEmbeddedCredential(validDocument())).not.toThrow();
  });
});

describe("local validation", () => {
  it("reports each schema violation with its path and sends nothing", async () => {
    const { ctx, stub } = context();
    const error = await rejection(run({ document: { title: "no id, no type" } }, ctx));
    expect(error).toMatchObject({ code: "invalid_input" });
    expect(error.message).toContain("does not conform");
    expect(stub.calls).toHaveLength(0);
  });
});

describe("missing credential", () => {
  it("refuses at preview rather than wasting a human approval", async () => {
    const { ctx, stub } = context({ apiKey: null });
    await expect(run({ document: validDocument() }, ctx)).rejects.toMatchObject({
      code: "policy_denied",
    });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("derived facts", () => {
  it("applies the namespace rule: source.publisher wins, orgs[0].slug is the fallback", () => {
    expect(deriveFacts(validDocument()).namespace).toBe("example-org");
    const noPublisher = validDocument({ source: { ingestedVia: "submission" } });
    expect(deriveFacts(noPublisher).namespace).toBe("example-org");
    const other = validDocument({ source: { publisher: "other-org" } });
    expect(deriveFacts(other).namespace).toBe("other-org");
  });

  it("copes with a document missing everything it looks for", () => {
    const facts = deriveFacts({});
    expect(facts.id).toBe("(no id)");
    expect(facts.namespace).toBe("");
    expect(facts.organizations).toEqual([]);
    expect(facts.deadlineCount).toBe(0);
  });
});

describe("duplicateCheck is reported in three distinguishable ways", () => {
  it("says 'ran and found nothing' only when it ran", () => {
    expect(explainDuplicateCheck("ok", 0)).toContain("RAN and found nothing");
  });

  it("says a failed check is NOT the same as no duplicates", () => {
    expect(explainDuplicateCheck("unavailable", 0)).toContain("DID NOT RUN");
    expect(explainDuplicateCheck("unavailable", 0)).toContain("NOT the same as 'no duplicates'");
  });

  it("says a disabled check is NOT the same as no duplicates", () => {
    expect(explainDuplicateCheck("disabled", 0)).toContain("DID NOT RUN");
    expect(explainDuplicateCheck("disabled", 0)).toContain("NOT the same as 'no duplicates'");
  });

  it("distinguishes one match from several", () => {
    expect(explainDuplicateCheck("ok", 1)).toContain("1 publicly visible entry");
    expect(explainDuplicateCheck("ok", 3)).toContain("3 publicly visible entries");
  });
});

describe("the submission result", () => {
  const result = {
    opportunity: validDocument() as never,
    created: true,
    reviewStatus: "pending" as const,
    isListed: false,
    warnings: ["a warning"],
    duplicateCheck: "unavailable" as const,
    duplicates: [],
  };

  it("promotes opportunity.id to a top-level id and SAYS it did", () => {
    const out = renderSubmission(result);
    expect(out.structured.id).toBe("example-org:test-grant");
    expect(String(out.structured.note)).toContain("no top-level id field");
    expect(outputSchema.safeParse(out.structured).success).toBe(true);
  });

  it("says a pending entry is not on the public site and names the owner route", () => {
    expect(renderSubmission(result).text).toContain("/v1/me/opportunities");
  });
});
