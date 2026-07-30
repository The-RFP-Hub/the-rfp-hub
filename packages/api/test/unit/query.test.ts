import { describe, expect, it } from "vitest";
import {
  listQuerySchema,
  parseOpportunityQuery,
} from "../../src/modules/routes/opportunities/types.js";

describe("parseOpportunityQuery", () => {
  it("applies safe defaults for an empty query", () => {
    expect(parseOpportunityQuery({})).toMatchObject({
      sort: "nextDeadlineAt",
      order: "asc",
      page: 1,
      limit: 20,
    });
  });

  it("splits comma lists and repeated params into de-duped value lists", () => {
    expect(parseOpportunityQuery({ fundingType: "grant,hackathon" }).fundingType).toEqual([
      "grant",
      "hackathon",
    ]);
    expect(parseOpportunityQuery({ fundingType: ["grant", "rfp"] }).fundingType).toEqual([
      "grant",
      "rfp",
    ]);
    // mixed forms OR together, duplicates collapse
    expect(parseOpportunityQuery({ status: ["open,closed", "open"] }).status).toEqual([
      "open",
      "closed",
    ]);
  });

  it("whitelists enum values defensively (HTTP returns 400 for them first)", () => {
    // Over HTTP `bogus` fails listQuerySchema's comma-list pattern and yields 400 before the
    // parser runs; the whitelist below only guards direct (non-HTTP) callers.
    const q = parseOpportunityQuery({ fundingType: "grant,bogus,hackathon", status: "open,nope" });
    expect(q.fundingType).toEqual(["grant", "hackathon"]);
    expect(q.status).toEqual(["open"]);
    expect(parseOpportunityQuery({ fundingType: "bogus" }).fundingType).toBeUndefined();
  });

  it("no longer accepts the pre-re-cut `type` param name", () => {
    const q = parseOpportunityQuery({ type: "grant" } as Record<string, unknown>);
    expect(q.fundingType).toBeUndefined();
    expect(listQuerySchema.properties).not.toHaveProperty("type");
  });

  it("normalizes strings and numbers (Fastify may pre-coerce)", () => {
    const q = parseOpportunityQuery({
      page: "2",
      limit: 50,
      minAward: "1000",
      maxAward: 5000,
      q: "  defi  ",
      ecosystem: "Optimism, Base",
    });
    expect(q).toMatchObject({ page: 2, limit: 50, minAward: 1000, maxAward: 5000, q: "defi" });
    expect(q.ecosystem).toEqual(["Optimism", "Base"]);
  });

  it("parses the deadline-window bounds into Dates", () => {
    const q = parseOpportunityQuery({
      deadlineAfter: "2026-07-01T00:00:00.000Z",
      deadlineBefore: "2026-12-31T00:00:00.000Z",
    });
    expect(q.deadlineAfter?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(q.deadlineBefore?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });

  it("drops an unparseable deadline bound (HTTP returns 400 via format:date-time first)", () => {
    expect(parseOpportunityQuery({ deadlineAfter: "yesterday" }).deadlineAfter).toBeUndefined();
  });

  it("normalizes schema-permitted sort and order inputs", () => {
    expect(parseOpportunityQuery({ sort: "updatedAt", order: "desc" })).toMatchObject({
      sort: "updatedAt",
      order: "desc",
    });
  });

  it("falls back for out-of-enum sort/order (defensive; HTTP schema returns 400 first)", () => {
    // Over HTTP these inputs fail listQuerySchema's `sort`/`order` enums and yield 400 before the
    // parser runs; the fallbacks below only guard direct (non-HTTP) callers.
    expect(parseOpportunityQuery({ sort: "bogus" }).sort).toBe("nextDeadlineAt");
    expect(parseOpportunityQuery({ sort: "closesAt" }).sort).toBe("nextDeadlineAt"); // removed key
    expect(parseOpportunityQuery({ order: "sideways" }).order).toBe("asc");
  });
});

describe("listQuerySchema", () => {
  it("documents the rolling-only exclusion on every nextDeadlineAt-backed param", () => {
    for (const key of ["deadlineAfter", "deadlineBefore", "sort"] as const) {
      expect(listQuerySchema.properties[key].description).toMatch(/rolling-only/i);
    }
  });

  it("documents that `organization` matches any sponsor", () => {
    expect(listQuerySchema.properties.organization.description).toMatch(/ANY entry/);
  });

  it("offers nextDeadlineAt instead of closesAt as the sort default", () => {
    expect(listQuerySchema.properties.sort.default).toBe("nextDeadlineAt");
    expect(listQuerySchema.properties.sort.enum).not.toContain("closesAt");
  });

  it("constrains fundingType/status to their value sets (so a bad value 400s, not silently drops)", () => {
    const cases = [
      [listQuerySchema.properties.fundingType, ["grant", "hackathon", "rfp"], ["grants", "bogus"]],
      [listQuerySchema.properties.status, ["open", "archived"], ["opened", "nope"]],
    ] as const;
    for (const [param, valid, invalid] of cases) {
      const re = new RegExp(param.items.pattern);
      for (const value of valid) expect(re.test(value), value).toBe(true);
      for (const value of invalid) expect(re.test(value), value).toBe(false);
      // the pattern spans the whole comma list, so one bad entry rejects the request
      expect(re.test(valid.join(","))).toBe(true);
      expect(re.test(valid.join(", "))).toBe(true); // whitespace the parser would trim
      expect(re.test(`${valid[0]},${invalid[0]}`)).toBe(false);
      // …but an EMPTY value is accepted and then ignored, exactly like ecosystem/tag/q: a client
      // that emits every filter key with the unselected ones blank must not get a 400 from these
      // two alone. `list()` above drops it, so the filter simply does not apply.
      expect(re.test("")).toBe(true);
      expect(re.test("  ")).toBe(true);
    }
  });

  it("types every list param as a repeatable array and says so in its description", () => {
    for (const key of [
      "fundingType",
      "status",
      "ecosystem",
      "network",
      "category",
      "tag",
    ] as const) {
      expect(listQuerySchema.properties[key].type, key).toBe("array");
      expect(listQuerySchema.properties[key].description, key).toMatch(/Repeat the parameter/);
    }
  });

  it("keeps additionalProperties:false so unknown params are rejected", () => {
    expect(listQuerySchema.additionalProperties).toBe(false);
  });
});
