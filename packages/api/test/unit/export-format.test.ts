import { type Opportunity, SPEC_VERSION } from "@the-rfp-hub/standard";
import { describe, expect, it } from "vitest";
import {
  CSV_COLUMNS,
  EXPORT_LICENSE,
  csvCell,
  datasetIdentity,
  orderForExport,
  toCsv,
  toExportJson,
} from "../../src/modules/shared/export-format.js";

describe("csvCell", () => {
  it("passes plain values through unquoted", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell(1234)).toBe("1234");
  });

  it("renders null/undefined as empty", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes and escapes commas, quotes, and newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("neutralizes spreadsheet formula injection", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@x")).toBe("'@x");
    // still quoted if it also contains a comma
    expect(csvCell("=1,2")).toBe('"\'=1,2"');
  });
});

describe("toCsv", () => {
  const opp = {
    specVersion: "1.0.0",
    id: "x:1",
    fundingType: "grant",
    title: "Title, with comma",
    description: "d",
    status: "open",
    operatingOrganizations: [
      { name: "Primary Org", slug: "primary-org" },
      { name: "Second Org", slug: "second-org" },
    ],
    sponsoringOrganizations: [{ name: "Backer Org", slug: "backer-org" }],
    source: { ingestedVia: "import", verifiedAgainstSource: null },
    ecosystems: ["Ethereum", "Base"],
    categories: ["DeFi"],
    fundingInfo: { minAward: 100, maxAward: 500, budget: 9000, allocated: 4000, currency: "USD" },
    applicationUrl: "https://example.com/1",
    deadlines: [
      { deadlineType: "fixed", date: "2999-12-31T00:00:00.000Z", label: "application" },
      { deadlineType: "fixed", date: "2000-01-01T00:00:00.000Z", label: "registration" },
    ],
    fundingDetails: { fundingType: "grant" },
  } as Opportunity;

  it("writes a header row + one row per item, joining arrays with |", () => {
    const csv = toCsv([opp]);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Title, with comma"'); // comma quoted
    expect(lines[1]).toContain("Ethereum|Base"); // array joined
    expect(lines[1]).toContain("https://example.com/1");
  });

  it("uses operatingOrganizations[0] as the display organization", () => {
    const row = toCsv([opp]).trimEnd().split("\n")[1] as string;
    expect(row).toContain("Primary Org");
    expect(row).toContain("primary-org");
    expect(row).not.toContain("Second Org");
    expect(row).not.toContain("Backer Org"); // sponsors are not the display org
  });

  it("flattens deadlines[] to the derived nextDeadlineAt, skipping past entries", () => {
    const row = toCsv([opp]).trimEnd().split("\n")[1] as string;
    expect(row).toContain("2999-12-31T00:00:00.000Z");
    expect(row).not.toContain("2000-01-01T00:00:00.000Z");
  });

  it("marks a rolling program (empty nextDeadlineAt, rollingDeadline=true)", () => {
    // no embedded commas in this fixture, so a naive split lines up with CSV_COLUMNS
    const rolling = {
      ...opp,
      title: "Rolling program",
      deadlines: [{ deadlineType: "rolling", label: "application" }],
    } as Opportunity;
    const cells = (toCsv([rolling]).trimEnd().split("\n")[1] as string).split(",");
    expect(cells[CSV_COLUMNS.indexOf("nextDeadlineAt")]).toBe("");
    expect(cells[CSV_COLUMNS.indexOf("rollingDeadline")]).toBe("true");
  });

  it("no longer emits the removed source.url / closesAt columns", () => {
    expect(CSV_COLUMNS).not.toContain("sourceUrl");
    expect(CSV_COLUMNS).not.toContain("closesAt");
    expect(CSV_COLUMNS).not.toContain("totalBudget");
    expect(CSV_COLUMNS).toContain("fundingType");
  });

  it("ends with a trailing newline", () => {
    expect(toCsv([opp]).endsWith("\n")).toBe(true);
  });
});

/**
 * The two halves of the format the CSV projection does not cover: the published ORDER, and the JSON
 * envelope. Both are shared by the export writer and the live download routes, so a change here
 * changes what `exports/latest.json` and `/v1/export/opportunities.json` BOTH serve.
 */
const record = (id: string): Opportunity =>
  ({
    specVersion: "1.0.0",
    id,
    fundingType: "grant",
    title: `Record ${id}`,
    description: "d",
    status: "open",
    operatingOrganizations: [{ name: "Org", slug: "org" }],
    source: { ingestedVia: "import", verifiedAgainstSource: null },
    fundingDetails: { fundingType: "grant" },
  }) as Opportunity;

describe("orderForExport", () => {
  it("sorts by id ascending, compared by code unit rather than by locale", () => {
    const ordered = orderForExport([record("b"), record("Z"), record("a"), record("A")]);
    // 'A' (U+0041) < 'Z' (U+005A) < 'a' (U+0061) < 'b' (U+0062). A locale collation would
    // interleave the cases instead, which is exactly the server-dependent order this avoids.
    expect(ordered.map((o) => o.id)).toEqual(["A", "Z", "a", "b"]);
  });

  it("does not mutate its input", () => {
    const input = [record("b"), record("a")];
    orderForExport(input);
    expect(input.map((o) => o.id)).toEqual(["b", "a"]);
  });

  it("is stable across the two orders the same records can arrive in", () => {
    const forwards = orderForExport([record("a"), record("b"), record("c")]);
    const backwards = orderForExport([record("c"), record("b"), record("a")]);
    expect(forwards.map((o) => o.id)).toEqual(backwards.map((o) => o.id));
  });
});

describe("toExportJson", () => {
  const at = "2026-08-13T09:41:00.000Z";

  it("emits the published envelope, in the published key order", () => {
    const json = toExportJson(orderForExport([record("b"), record("a")]), at);
    const parsed = JSON.parse(json);

    expect(Object.keys(parsed)).toEqual([
      "specVersion",
      "license",
      "generatedAt",
      "count",
      "opportunities",
    ]);
    expect(parsed.specVersion).toBe(SPEC_VERSION);
    expect(parsed.license).toBe(EXPORT_LICENSE);
    expect(parsed.generatedAt).toBe(at);
    expect(parsed.count).toBe(2);
    expect(parsed.opportunities.map((o: Opportunity) => o.id)).toEqual(["a", "b"]);
  });

  it("is indented two spaces and newline-terminated", () => {
    const json = toExportJson([record("a")], at);
    expect(json).toContain('\n  "specVersion"');
    expect(json.endsWith("\n")).toBe(true);
    expect(json).toBe(`${JSON.stringify(JSON.parse(json), null, 2)}\n`);
  });

  it("serves an empty dataset as a complete envelope, not as nothing", () => {
    const parsed = JSON.parse(toExportJson([], at));
    expect(parsed.count).toBe(0);
    expect(parsed.opportunities).toEqual([]);
    expect(parsed.license).toBe(EXPORT_LICENSE);
  });

  it("produces identical bytes for identical records and stamp", () => {
    const ordered = orderForExport([record("a"), record("b")]);
    expect(toExportJson(ordered, at)).toBe(toExportJson([...ordered], at));
  });
});

describe("datasetIdentity", () => {
  const at = "2026-08-13T09:41:00.000Z";

  it("ignores the stamp the envelope carries, so a tag built on it tracks the DATA", () => {
    const ordered = orderForExport([record("a"), record("b")]);
    const early = toExportJson(ordered, "2026-08-13T00:00:00.000Z");
    const late = toExportJson(ordered, "2026-08-13T23:59:59.000Z");

    expect(early).not.toBe(late); // the bodies differ …
    expect(datasetIdentity(ordered)).toBe(datasetIdentity(ordered)); // … the identity does not
  });

  it("changes when any record changes", () => {
    const before = orderForExport([record("a"), record("b")]);
    const after = orderForExport([record("a"), { ...record("b"), title: "Renamed" }]);
    expect(datasetIdentity(after)).not.toBe(datasetIdentity(before));
  });

  it("changes when the record set changes, empty included", () => {
    expect(datasetIdentity([])).not.toBe(datasetIdentity([record("a")]));
    expect(datasetIdentity([])).toBe("[]");
  });
});
