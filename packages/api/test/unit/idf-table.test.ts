/**
 * The committed document-frequency table cannot drift from the corpus it claims to describe.
 *
 * The table is a frozen artefact on purpose (see `scripts/build-idf-table.ts` for why live IDF
 * would put the backfill into a permanent full-table loop). Frozen means REGENERABLE: rebuilding
 * it from the committed corpus must reproduce the committed bytes exactly. Failing this does not
 * mean the test is stale — it means somebody changed the corpus, the tokenizer, or the table
 * without rerunning `pnpm --filter @the-rfp-hub/api build:idf`, and the weights the detector is
 * using no longer describe the corpus the threshold was settled against.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildIdfTable, renderIdfTable } from "../../scripts/build-idf-table.js";
import { loadCorpus } from "../../scripts/dedupe-threshold-report.js";

const COMMITTED = fileURLToPath(
  new URL("../../src/modules/services/dedupe/idf-table.json", import.meta.url),
);

describe("the committed idf table", () => {
  it("is byte-for-byte what the committed corpus regenerates", () => {
    const regenerated = renderIdfTable(buildIdfTable(loadCorpus()));
    expect(regenerated).toBe(readFileSync(COMMITTED, "utf8"));
  });

  it("counts documents, not occurrences — no token exceeds the corpus size", () => {
    const table = buildIdfTable(loadCorpus());
    expect(table.documentCount).toBeGreaterThan(0);
    for (const [token, df] of Object.entries(table.df)) {
      expect(df, token).toBeGreaterThan(0);
      expect(df, token).toBeLessThanOrEqual(table.documentCount);
    }
  });
});
