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
  ANY_STATUS,
  DEFAULT_SELECTION,
  FUNDING_TYPES,
  ORDERINGS,
  STATUSES,
  SUGGESTED_ECOSYSTEMS,
  directoryQuery,
  isFiltered,
  selectionFromParams,
  selectionToHref,
  selectionToParams,
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
    expect(query.ecosystem).toBeUndefined();
    // The ones that always have a value still do.
    expect(query.sort).toBe("nextDeadlineAt");
    expect(query.order).toBe("asc");
    expect(query.page).toBe(1);
    expect(query.limit).toBe(20);
  });

  it("OPENS ON OPEN OPPORTUNITIES, and sends that as a real filter", () => {
    // The default narrows. That is a product decision — most of a public funding register's
    // readers are looking for something they can still apply to — and it is only defensible
    // because the control shows the value and the count line offers the way out. This assertion
    // is the machine-readable half of that decision: if the default ever changes, it changes here
    // first, deliberately, rather than by somebody editing an initial-state literal.
    expect(DEFAULT_SELECTION.status).toBe("open");
    expect(directoryQuery(DEFAULT_SELECTION).status).toBe("open");
  });

  it("offers ecosystem suggestions that are suggestions, not a permitted set", () => {
    // The control is a datalist over these, plus anything the reader types: `ecosystems[]` is free
    // text in the Standard, and a closed list would hide real listings whose spelling is not here.
    expect(SUGGESTED_ECOSYSTEMS.length).toBeGreaterThan(5);
    expect(SUGGESTED_ECOSYSTEMS).toContain("Ethereum");
    // Nothing filters against it — a typed value that is not on the list is passed through whole.
    expect(directoryQuery({ ...DEFAULT_SELECTION, ecosystem: "Nowhere Chain" }).ecosystem).toBe(
      "Nowhere Chain",
    );
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
    // The DEFAULT view is now a filtered one, so an empty result on it reads as "nothing matches"
    // and offers the way out — not as "nothing has ever been published here", which would be a
    // lie told to somebody who had merely picked a quiet status.
    expect(isFiltered(DEFAULT_SELECTION)).toBe(true);
    const unfiltered = { ...DEFAULT_SELECTION, status: "" };
    expect(isFiltered(unfiltered)).toBe(false);
    expect(isFiltered({ ...unfiltered, q: "  " })).toBe(false);
    expect(isFiltered({ ...unfiltered, ecosystem: "Base" })).toBe(true);
  });
});

/**
 * THE ADDRESS BAR IS THE FILTER STATE.
 *
 * Three user-visible failures were the same missing round trip: Back landed on an unfiltered page,
 * a filtered view could not be shared, and a reload lost the search. These assertions are what stop
 * that regressing, and the awkward case — `status` — is the one worth reading. The selection's
 * empty string means "every status" while the DEFAULT is "open", so an absent parameter cannot mean
 * "empty" or the "Include closed and upcoming" link would have no address to point at.
 */
describe("the directory's URL state", () => {
  const roundTrip = (selection: Parameters<typeof selectionToParams>[0]) =>
    selectionFromParams(selectionToParams(selection));

  it("survives a round trip through the address bar", () => {
    const selection = {
      ...DEFAULT_SELECTION,
      q: "zk proofs",
      ecosystem: "Optimism",
      fundingType: "grant",
      status: "closed",
      ordering: "updatedAt:desc" as const,
      page: 4,
    };
    expect(roundTrip(selection)).toEqual(selection);
  });

  it("writes nothing that is at its default, so the front page keeps a clean URL", () => {
    expect(selectionToParams(DEFAULT_SELECTION).toString()).toBe("");
    expect(selectionToHref(DEFAULT_SELECTION)).toBe("/");
  });

  it("distinguishes 'the reader turned the status filter off' from 'the reader chose nothing'", () => {
    const everything = { ...DEFAULT_SELECTION, status: "" };
    // Turning it off is an explicit, linkable value...
    expect(selectionToParams(everything).get("status")).toBe(ANY_STATUS);
    expect(selectionFromParams(new URLSearchParams("status=any")).status).toBe("");
    // ...and an ABSENT parameter is the default, not "everything".
    expect(selectionFromParams(new URLSearchParams("")).status).toBe("open");
  });

  it("ignores a hand-edited value the API would answer with a 400", () => {
    // A bad URL lands the reader on the directory, not on an error panel: every one of these is a
    // parameter the list endpoint validates, so forwarding it would turn a typo into a 400.
    const parsed = selectionFromParams(
      new URLSearchParams("type=not-a-type&status=nonsense&sort=title:asc&page=-3"),
    );
    expect(parsed.fundingType).toBe("");
    expect(parsed.status).toBe(DEFAULT_SELECTION.status);
    expect(parsed.ordering).toBe(DEFAULT_SELECTION.ordering);
    expect(parsed.page).toBe(1);
  });

  it("does not forward malformed or database-overflowing pages from a shared URL", () => {
    // `parseInt` accepts a numeric prefix and rounds huge integers. The resulting value was sent
    // to PostgreSQL as OFFSET; sufficiently large values turn a public URL into a 500 response.
    expect(selectionFromParams(new URLSearchParams("page=2junk")).page).toBe(1);
    expect(selectionFromParams(new URLSearchParams("page=9223372036854775807")).page).toBe(1);
  });

  it("keeps free text verbatim, including the characters a querystring has to escape", () => {
    const selection = { ...DEFAULT_SELECTION, q: "zk & rollups", ecosystem: "ZKsync Era" };
    expect(roundTrip(selection)).toEqual(selection);
    expect(selectionToHref(selection)).toContain("?");
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
