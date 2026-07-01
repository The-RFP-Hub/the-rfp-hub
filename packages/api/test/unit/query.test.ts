import { describe, expect, it } from "vitest";
import { parseOpportunityQuery } from "../../src/modules/routes/opportunities/types.js";

describe("parseOpportunityQuery", () => {
  it("applies safe defaults for an empty query", () => {
    expect(parseOpportunityQuery({})).toMatchObject({
      sort: "closesAt",
      order: "asc",
      page: 1,
      limit: 20,
    });
  });

  it("splits comma lists and whitelists enum values", () => {
    const q = parseOpportunityQuery({ type: "grant,bogus,hackathon", status: "open,nope" });
    expect(q.type).toEqual(["grant", "hackathon"]);
    expect(q.status).toEqual(["open"]);
  });

  it("drops a filter entirely when no value survives whitelisting", () => {
    expect(parseOpportunityQuery({ type: "bogus" }).type).toBeUndefined();
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

  it("only honors known sort fields and the desc order", () => {
    expect(parseOpportunityQuery({ sort: "updatedAt", order: "desc" })).toMatchObject({
      sort: "updatedAt",
      order: "desc",
    });
    expect(parseOpportunityQuery({ sort: "bogus" }).sort).toBe("closesAt");
    expect(parseOpportunityQuery({ order: "sideways" }).order).toBe("asc");
  });
});
