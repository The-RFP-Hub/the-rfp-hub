/**
 * The pure half of the public browse surface: what goes on the wire, and how a Standard record's
 * dates and amounts become the two columns a directory row is really read for.
 *
 * The querystring assertions are the load-bearing ones. `GET /v1/opportunities` validates its
 * querystring with `additionalProperties: false`, so a parameter this frontend invents is a 400 in
 * the browser rather than a filter that quietly does nothing — and the only place that can be
 * checked without a running API is here.
 */
import {
  DEFAULT_SELECTION,
  FUNDING_TYPES,
  ORDERINGS,
  STATUSES,
  directoryQuery,
  isFiltered,
} from "@/lib/directory";
import { describeAward, describeDeadline, formatAmount, nextFixedDeadline } from "@/lib/format";
import type { Deadline } from "@/lib/types";
import { describe, expect, it } from "vitest";

/** Exactly the parameters `listQuerySchema` declares. Anything else is a 400 from the API. */
const ACCEPTED = new Set([
  "fundingType",
  "status",
  "ecosystem",
  "category",
  "organization",
  "minAward",
  "maxAward",
  "deadlineAfter",
  "deadlineBefore",
  "q",
  "sort",
  "order",
  "page",
  "limit",
]);

describe("the directory querystring", () => {
  it("emits only parameters the list endpoint declares", () => {
    const query = directoryQuery({
      q: "retro funding",
      fundingType: "grant",
      status: "open",
      ecosystem: "Optimism",
      ordering: "postedAt:desc",
      page: 3,
    });

    for (const key of Object.keys(query)) expect(ACCEPTED.has(key)).toBe(true);
  });

  it("drops an empty control instead of sending it blank", () => {
    const query = directoryQuery(DEFAULT_SELECTION);

    expect(query.q).toBeUndefined();
    expect(query.fundingType).toBeUndefined();
    expect(query.status).toBeUndefined();
    expect(query.ecosystem).toBeUndefined();
    // The ones that always have a value still do.
    expect(query.sort).toBe("nextDeadlineAt");
    expect(query.order).toBe("asc");
    expect(query.page).toBe(1);
    expect(query.limit).toBe(20);
  });

  it("trims what the reader typed", () => {
    const query = directoryQuery({ ...DEFAULT_SELECTION, q: "  zk proofs  " });
    expect(query.q).toBe("zk proofs");
  });

  it("splits one ordering control back into the API's two parameters", () => {
    expect(directoryQuery({ ...DEFAULT_SELECTION, ordering: "updatedAt:desc" })).toMatchObject({
      sort: "updatedAt",
      order: "desc",
    });
    expect(directoryQuery({ ...DEFAULT_SELECTION, ordering: "nextDeadlineAt:asc" })).toMatchObject({
      sort: "nextDeadlineAt",
      order: "asc",
    });
  });

  it("offers only sort keys the endpoint accepts", () => {
    const sortable = new Set(["nextDeadlineAt", "opensAt", "postedAt", "updatedAt", "createdAt"]);
    for (const option of ORDERINGS) {
      const [sort, order] = option.value.split(":");
      expect(sortable.has(String(sort))).toBe(true);
      expect(["asc", "desc"]).toContain(order);
    }
  });

  it("reads its filter values out of the Standard rather than re-typing them", () => {
    expect(FUNDING_TYPES).toEqual([
      "grant",
      "hackathon",
      "bounty",
      "accelerator",
      "vc_fund",
      "rfp",
    ]);
    expect(STATUSES).toEqual(["upcoming", "open", "closed", "archived"]);
  });

  it("knows whether an empty result means 'none' or 'none match'", () => {
    expect(isFiltered(DEFAULT_SELECTION)).toBe(false);
    expect(isFiltered({ ...DEFAULT_SELECTION, q: "  " })).toBe(false);
    expect(isFiltered({ ...DEFAULT_SELECTION, ecosystem: "Base" })).toBe(true);
  });
});

describe("the deadline column", () => {
  const now = new Date("2026-08-17T00:00:00Z");
  const fixed = (date: string, label?: string): Deadline => ({
    deadlineType: "fixed",
    date,
    label: label ?? null,
  });

  it("picks the earliest fixed deadline still in the future", () => {
    const deadlines = [
      fixed("2026-12-01T00:00:00Z", "final report"),
      fixed("2026-01-01T00:00:00Z", "last round"),
      fixed("2026-09-30T23:59:00Z", "application"),
    ];
    expect(nextFixedDeadline(deadlines, now)?.label).toBe("application");
    expect(describeDeadline(deadlines, now)).toBe("30 Sep 23:59 UTC");
  });

  it("says rolling rather than inventing a date", () => {
    expect(describeDeadline([{ deadlineType: "rolling" }], now)).toBe("Rolling");
  });

  it("distinguishes 'all dates passed' from 'no dates at all'", () => {
    expect(describeDeadline([fixed("2020-01-01T00:00:00Z")], now)).toBe("No upcoming deadline");
    expect(describeDeadline([], now)).toBe("—");
    expect(describeDeadline(undefined, now)).toBe("—");
  });

  it("ignores an unparseable date instead of rendering Invalid Date", () => {
    expect(describeDeadline([fixed("not a date")], now)).toBe("—");
  });

  it("prefers a fixed date over a rolling entry on a record carrying both", () => {
    const deadlines: Deadline[] = [{ deadlineType: "rolling" }, fixed("2026-09-30T23:59:00Z")];
    expect(describeDeadline(deadlines, now)).toBe("30 Sep 23:59 UTC");
  });
});

describe("amounts", () => {
  it("groups without a locale and never converts a currency", () => {
    expect(formatAmount(1500000, "USD")).toBe("1,500,000 USD");
    expect(formatAmount(2500.5, "OP")).toBe("2,500.5 OP");
    expect(formatAmount(0, "ETH")).toBe("0 ETH");
    expect(formatAmount(1000)).toBe("1,000");
  });

  it("has nothing to show for an absent amount", () => {
    expect(formatAmount(null, "USD")).toBeNull();
    expect(formatAmount(undefined)).toBeNull();
  });

  it("prefers the per-award range over the programme budget", () => {
    expect(
      describeAward({ currency: "USD", minAward: 5000, maxAward: 50000, budget: 1000000 }),
    ).toBe("5,000–50,000 USD per award");
    expect(describeAward({ currency: "USD", maxAward: 50000 })).toBe("Up to 50,000 USD per award");
    expect(describeAward({ currency: "USD", minAward: 5000 })).toBe("From 5,000 USD per award");
    expect(describeAward({ currency: "USD", budget: 1000000 })).toBe(
      "1,000,000 USD programme budget",
    );
  });

  it("shows nothing rather than a zero for an empty envelope", () => {
    expect(describeAward({})).toBeNull();
    expect(describeAward(undefined)).toBeNull();
  });
});
