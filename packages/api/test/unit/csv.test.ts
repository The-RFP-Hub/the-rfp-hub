import type { Opportunity } from "@rfp-hub/standard";
import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, csvCell, toCsv } from "../../scripts/csv.js";

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
    type: "grant",
    title: "Title, with comma",
    description: "d",
    status: "open",
    organization: { name: "Org", slug: "org" },
    source: { url: "https://example.com/1", ingestedVia: "import", verifiedAgainstSource: null },
    ecosystems: ["Ethereum", "Base"],
    categories: ["DeFi"],
    funding: { minAward: 100, maxAward: 500, currency: "USD" },
    closesAt: "2026-12-31T00:00:00.000Z",
    grant: {},
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

  it("ends with a trailing newline", () => {
    expect(toCsv([opp]).endsWith("\n")).toBe(true);
  });
});
