/**
 * The two pure decisions on the write and audit paths that are worth testing without a database:
 * the per-field size caps, and the coarse actor label the public audit trail uses.
 */
import { describe, expect, it } from "vitest";
import { publicActor } from "../../src/modules/services/audit/audit.service.js";
import {
  FIELD_CAPS,
  assertWithinCaps,
} from "../../src/modules/services/opportunities/opportunity-write.service.js";
import { isHttpError } from "../../src/modules/shared/http-error.js";

function capsError(record: Record<string, unknown>): string[] {
  try {
    assertWithinCaps(record);
  } catch (error) {
    if (isHttpError(error)) return (error.details.errors as string[]) ?? [];
    throw error;
  }
  return [];
}

describe("per-field size caps", () => {
  it("accepts a document at exactly the cap", () => {
    expect(
      capsError({
        title: "t".repeat(FIELD_CAPS.title),
        summary: "s".repeat(FIELD_CAPS.summary),
        description: "d".repeat(FIELD_CAPS.description),
        ecosystems: Array.from({ length: FIELD_CAPS.arrayEntries }, () => "x"),
      }),
    ).toEqual([]);
  });

  it("names every field that is over, not just the first", () => {
    const problems = capsError({
      title: "t".repeat(FIELD_CAPS.title + 1),
      description: "d".repeat(FIELD_CAPS.description + 1),
    });
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toContain("`title`");
    expect(problems.join(" ")).toContain("`description`");
  });

  it("caps any array, including one the Standard has never heard of", () => {
    const problems = capsError({
      whateverArray: Array.from({ length: FIELD_CAPS.arrayEntries + 1 }, () => 1),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("`whateverArray`");
  });

  it("ignores a non-string in a capped field — that is the validator's complaint, not this one", () => {
    expect(capsError({ title: 42, description: null })).toEqual([]);
  });
});

describe("the public audit actor label", () => {
  it("coarsens an editorial action to `reviewer`, whatever the handle", () => {
    expect(publicActor("user", "alice", "reviewer")).toBe("reviewer");
    expect(publicActor("user", "alice", "admin")).toBe("reviewer");
    expect(publicActor("api_key", "alice", "admin")).toBe("reviewer");
  });

  it("credits a submitter by their public handle, which is what a handle is for", () => {
    expect(publicActor("user", "alice", "submitter")).toBe("alice");
    expect(publicActor("api_key", "example-org", "submitter")).toBe("example-org");
  });

  it("says `community` when nobody chose a handle", () => {
    expect(publicActor("user", null, "submitter")).toBe("community");
    expect(publicActor("user", null, null)).toBe("community");
  });

  it("names the machine actors as machines, never as a person", () => {
    expect(publicActor("job", "alice", "admin")).toBe("job");
    expect(publicActor("outbox", "alice", "admin")).toBe("outbox");
  });
});
