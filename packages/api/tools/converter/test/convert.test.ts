/**
 * The convert step's contract: it produces a DRAFT for a human, so what matters is that it hides
 * nothing. A record the mapper cannot turn into a conforming document is named and excluded — never
 * patched into shape, because a converter that repairs its own output is one whose fidelity nobody
 * can measure, and the curator downstream would be reviewing the repair rather than the data.
 */
import { describe, expect, it } from "vitest";
import { convert, programsFromSnapshot } from "../convert.js";
import { UPSTREAM_PROGRAMS, grantProgram } from "./upstream-programs.js";

const PROGRAMS = Object.values(UPSTREAM_PROGRAMS);

describe("programsFromSnapshot", () => {
  it("accepts a bare array and an envelope carrying one", () => {
    expect(programsFromSnapshot([grantProgram])).toEqual([grantProgram]);
    expect(programsFromSnapshot({ note: "raw", programs: [grantProgram] })).toEqual([grantProgram]);
  });

  it("refuses a snapshot that would silently convert nothing", () => {
    expect(() => programsFromSnapshot([], "s.json")).toThrow(/no programs/);
    expect(() => programsFromSnapshot({ programs: {} }, "s.json")).toThrow(/expected an array/);
    expect(() => programsFromSnapshot(null, "s.json")).toThrow(/expected an array/);
  });
});

describe("convert", () => {
  it("turns every recorded upstream shape into a conforming Standard document", () => {
    const { documents, rejected } = convert(PROGRAMS);
    expect(rejected).toEqual([]);
    expect(documents).toHaveLength(PROGRAMS.length);
    for (const d of documents) expect(d.fundingDetails.fundingType).toBe(d.fundingType);
  });

  /**
   * Two upstream rows on one id is data loss, not a tidy-up: the second row's content — a different
   * title here — never reaches the draft, and nothing about a one-document output says a second row
   * existed. So the collision is NAMED, with its id and how many rows landed on it, and the run
   * reports failure rather than success. Which row the curator meant is not a question arrival
   * order gets to answer.
   */
  it("names a duplicate id rather than quietly emitting one document for two rows", () => {
    const { documents, duplicates } = convert([
      grantProgram,
      { ...grantProgram, metadata: { title: "Again" } },
    ]);
    expect(documents).toHaveLength(1);
    expect(duplicates).toEqual([{ id: documents[0]?.id, count: 2 }]);
  });

  it("reports no duplicates when every row has its own id", () => {
    expect(convert(PROGRAMS).duplicates).toEqual([]);
  });

  /**
   * A bulk refresh reads whatever the upstream had that day, so the degenerate rows are the ones
   * worth pinning: an empty row, an unknown discriminator, a URL that is not one. The mapper
   * defaults its way through all of them and the output still conforms — which is why `rejected`
   * is empty here and stays a safety net rather than a routine outcome. It matters that the net
   * NAMES what it catches: the alternative is a draft that is quietly shorter than its input, and
   * a curator has no way to notice records that were never offered to them.
   */
  it("converts degenerate upstream rows rather than dropping them", () => {
    const degenerate = [
      { programId: "901", type: "grant" },
      { programId: "902", type: "not-a-funding-type", metadata: {} },
      { programId: "903", type: "grant", submissionUrl: "not a url", metadata: { title: "T" } },
    ];
    const { documents, rejected } = convert(degenerate as never[]);
    expect(rejected).toEqual([]);
    expect(documents.map((d) => d.id)).toEqual([
      "fundingmap:901",
      "fundingmap:902",
      "fundingmap:903",
    ]);
  });
});
