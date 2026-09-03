/**
 * One map, tested. The point of a closed set of codes is that a client can branch on them; the
 * point of testing it is that no tool quietly invents a seventh.
 */
import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  ToolError,
  apiErrorToToolError,
  nonJsonResponseError,
} from "../src/errors.js";
import { toToolError } from "../src/server.js";
import { FAKE_KEY } from "./helpers.js";

const ctx = { operation: "submit_opportunity", keyConfigured: true };

describe("the code set is closed", () => {
  it("has exactly the seven documented codes", () => {
    expect([...ERROR_CODES]).toEqual([
      "tool_not_found",
      "invalid_input",
      "policy_denied",
      "rate_limited",
      "confirmation_required",
      "confirmation_invalid",
      "exec_failed",
    ]);
  });

  it("every HTTP status this package handles maps into the set", () => {
    for (const status of [400, 401, 403, 409, 418, 429, 500, 503]) {
      const error = apiErrorToToolError(status, { error: "x", message: "y" }, ctx);
      expect(ERROR_CODES).toContain(error.code);
    }
  });

  it("an exception from anywhere else becomes exec_failed, never a raw throw", () => {
    expect(toToolError(new TypeError("boom")).code).toBe("exec_failed");
    expect(toToolError("a string").code).toBe("exec_failed");
    const own = new ToolError("rate_limited", "…");
    expect(toToolError(own)).toBe(own);
  });
});

describe("the 400 branch reports fields, never a shrug", () => {
  it("lists each issue with its path", () => {
    const error = apiErrorToToolError(
      400,
      {
        error: "validation_failed",
        message: "the document is not conformant",
        issues: [{ path: "/title", message: "must be a string" }],
      },
      ctx,
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("/title: must be a string");
  });

  it("attaches the id rule to a non-validation 400", () => {
    const error = apiErrorToToolError(400, { error: "publisher_not_operating" }, ctx);
    expect(error.message).toContain("publisher_not_operating");
    expect(error.message).toContain("operatingOrganizations[].slug");
  });
});

describe("credential branches never echo a credential", () => {
  it("401 names the environment variable, not the value", () => {
    const configured = apiErrorToToolError(401, {}, ctx);
    expect(configured.code).toBe("policy_denied");
    expect(configured.message).toContain("RFPHUB_API_KEY");
    expect(configured.message).not.toContain(FAKE_KEY);
    expect(configured.message).not.toContain("rfph_");
  });

  it("401 with no key configured says a key is needed and that reads do not need one", () => {
    const error = apiErrorToToolError(401, {}, { ...ctx, keyConfigured: false });
    expect(error.message).toContain("Reads are anonymous");
  });

  it("403 points at the scope the API named", () => {
    const error = apiErrorToToolError(
      403,
      { error: "forbidden", message: "requires publish" },
      ctx,
    );
    expect(error.code).toBe("policy_denied");
    expect(error.message).toContain("requires publish");
  });
});

describe("queue and rate branches", () => {
  it("409 pending_limit_reached explains the ceiling and how it clears", () => {
    const error = apiErrorToToolError(409, { error: "pending_limit_reached" }, ctx);
    expect(error.code).toBe("policy_denied");
    expect(error.message).toContain("maximum of 5");
    expect(error.message).toContain("nothing was written");
  });

  it("429 is rate_limited", () => {
    expect(apiErrorToToolError(429, {}, ctx).code).toBe("rate_limited");
  });

  it("5xx is exec_failed and says it is server-side", () => {
    const error = apiErrorToToolError(503, {}, ctx);
    expect(error.code).toBe("exec_failed");
    expect(error.message).toContain("server-side");
  });
});

describe("transport failures are distinct from server errors", () => {
  it("a non-JSON body says something else answered", () => {
    const error = nonJsonResponseError(502, "search_opportunities");
    expect(error.code).toBe("exec_failed");
    expect(error.message).toContain("not JSON");
    expect(error.details?.transport).toBe(true);
  });
});
