/**
 * Regenerate the committed document-frequency table from the committed corpus.
 *
 *   pnpm --filter @the-rfp-hub/api build:idf
 *
 * WHY THE TABLE IS FROZEN RATHER THAN COMPUTED LIVE. IDF weights come from document frequencies;
 * computing them from the live database would make every write shift every token's idf, which
 * changes every vector, which changes every `content_hash` — and the backfill cursor would then
 * select the entire table on every pass, forever. So the frequencies are a committed artefact of
 * the committed corpus: versioned, diffable, and part of the model identity (`tfidf-hashed-v1`).
 * Refreshing it is a deliberate release event — rerun this script, bump the model string, and the
 * existing backfill machinery re-embeds everything exactly once.
 *
 * The FULL frequency map is committed, not a floor-filtered one: the low-frequency tail is where
 * the discriminating tokens live, and the whole file is a few tens of kilobytes.
 *
 * Reads `data/seed-corpus.json` and nothing else; writes the JSON with sorted keys so a rerun over
 * an unchanged corpus is byte-identical — which is what the regenerability test asserts.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tokenize } from "../src/modules/services/dedupe/embedding-provider.js";
import { embeddingText } from "../src/modules/shared/embedding-text.js";
import { type CorpusDocument, loadCorpus } from "./dedupe-threshold-report.js";

const OUT_PATH = fileURLToPath(
  new URL("../src/modules/services/dedupe/idf-table.json", import.meta.url),
);

export interface IdfTable {
  version: number;
  documentCount: number;
  df: Record<string, number>;
}

/** Document frequency: in how many corpus documents each token appears at least once. */
export function buildIdfTable(documents: CorpusDocument[]): IdfTable {
  const df = new Map<string, number>();
  for (const doc of documents) {
    for (const token of new Set(tokenize(embeddingText(doc)))) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  const sorted: Record<string, number> = {};
  for (const token of [...df.keys()].sort()) sorted[token] = df.get(token) as number;
  return { version: 1, documentCount: documents.length, df: sorted };
}

/** The exact bytes the table is committed as — one serialisation, shared with the test. */
export function renderIdfTable(table: IdfTable): string {
  return `${JSON.stringify(table, null, 2)}\n`;
}

const isCliEntry =
  !process.env.VITEST &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isCliEntry) {
  const table = buildIdfTable(loadCorpus());
  writeFileSync(OUT_PATH, renderIdfTable(table));
  console.log(
    `wrote ${OUT_PATH}: ${Object.keys(table.df).length} tokens over ${table.documentCount} documents`,
  );
}
