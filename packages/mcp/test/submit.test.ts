/**
 * Phase 0, local validation, and the way the three duplicate-check states are reported.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { McpConfig } from "../src/config.js";
import { ApiClient } from "../src/http.js";
import { Policy } from "../src/policy.js";
import { clearRegisteredSecrets } from "../src/redact.js";
import type { ToolContext } from "../src/tools/context.js";
import {
  deriveFacts,
  explainDuplicateCheck,
  explainPublicVisibility,
  inputSchema,
  outputSchema,
  rejectEmbeddedCredential,
  renderSubmission,
  run,
} from "../src/tools/submit.js";
import { FAKE_KEY, rejection, stubFetch, tempHome, testConfig, validDocument } from "./helpers.js";

afterEach(() => clearRegisteredSecrets());

function context(overrides: { apiKey?: string | null } = {}) {
  const config = testConfig(overrides);
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

  it.each([
    ["pending", true, false, "will appear if a reviewer approves"],
    ["pending", false, false, "listing preference is hidden"],
    ["approved", true, true, "visible on the public site"],
    ["approved", false, false, "approved but NOT visible"],
    ["rejected", true, false, "review decision is rejected"],
    ["rejected", false, false, "review decision is rejected"],
  ] as const)(
    "derives public visibility for %s + isListed=%s",
    (reviewStatus, isListed, isPubliclyVisible, expectedCopy) => {
      const out = renderSubmission({ ...result, reviewStatus, isListed });
      expect(out.structured.isPubliclyVisible).toBe(isPubliclyVisible);
      expect(out.structured.publicVisibilityExplanation).toContain(expectedCopy);
      expect(out.text).toContain(expectedCopy);
      expect(explainPublicVisibility(reviewStatus, isListed)).toContain(expectedCopy);
      expect(outputSchema.safeParse(out.structured).success).toBe(true);
    },
  );
});

/**
 * The preview's own words, checked literally.
 *
 * This sentence is the one a model reads to decide what just happened, and every clause in it is
 * load-bearing: `status: "pending"` says the call produced a record and not a submission, "the
 * person at this machine" says the next step is not the model's, and "no approval secret" says
 * there is nothing in this response to spend.
 */
describe("the preview says exactly what it is required to say", () => {
  async function previewOf(
    document: Record<string, unknown> = validDocument(),
    configOverrides: Partial<McpConfig> = {},
  ) {
    const home = configOverrides.home ?? tempHome();
    const config = testConfig({ ...configOverrides, home });
    const ctx: ToolContext = {
      config,
      api: new ApiClient(config, { fetchImpl: stubFetch([{ body: {} }]).fetchImpl }),
      policy: new Policy(home),
      now: () => new Date(),
      protocolVersion: "2026-07-28",
    };
    return run({ document }, ctx);
  }

  it("opens with the prescribed sentence, verbatim", async () => {
    const preview = await previewOf();
    const id = String(preview.structured.approvalId);
    const prescribed = `Nothing has been submitted. \`status: "pending"\`. To submit, the person at this machine must run \`rfphub-mcp approve ${id}\` in their own terminal and read what it prints. No approval secret is ever returned here.`;
    expect(String(preview.structured.instruction).startsWith(prescribed)).toBe(true);
    expect(preview.text).toContain('Nothing has been submitted. `status: "pending"`.');
  });

  it("names the state directory in that command when this server was given one", async () => {
    // Without the flag the person's terminal reads ~/.rfphub, finds nothing, and the instruction
    // that sent them there reads like a broken approval rather than a different directory.
    const preview = await previewOf(validDocument(), {
      home: "/tmp/rfphub state",
      stateDirExplicit: true,
    });
    const id = String(preview.structured.approvalId);
    const prescribed = `Nothing has been submitted. \`status: "pending"\`. To submit, the person at this machine must run \`rfphub-mcp --state-dir '/tmp/rfphub state' approve ${id}\` in their own terminal and read what it prints. No approval secret is ever returned here.`;
    expect(String(preview.structured.instruction).startsWith(prescribed)).toBe(true);
  });

  it("states the derived namespace and whether the id satisfies the rule", async () => {
    const preview = await previewOf();
    const structured = preview.structured as { preview: Record<string, unknown> };
    expect(structured.preview.idMatchesNamespace).toBe(true);
    expect(String(structured.preview.idRule)).toBe(
      "A public id must be `<namespace>:<local>`. This server derives the namespace from the " +
        "document as `example-org` (`source.publisher`, or `operatingOrganizations[0].slug` when " +
        "that is absent), so the id has to start `example-org:`. The id in this document is " +
        "`example-org:test-grant`, which satisfies that rule.",
    );
    expect(preview.text).toContain("so the id has to start `example-org:`");
  });

  it("says so when the id does not carry the derived namespace", async () => {
    const preview = await previewOf(
      validDocument({ id: "somebody-else:test-grant", source: { publisher: "example-org" } }),
    );
    const structured = preview.structured as { preview: Record<string, unknown> };
    expect(structured.preview.idMatchesNamespace).toBe(false);
    expect(String(structured.preview.idRule)).toContain(
      "does NOT satisfy that rule — the API will refuse it",
    );
  });
});
