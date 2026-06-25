// Generates src/generated/opportunity.ts from the canonical JSON Schema.
// Run via `pnpm codegen`. The committed output is the source consumers compile against.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFromFile } from "json-schema-to-typescript";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "../schemas/v1.0.0/opportunity.schema.json");
const outPath = resolve(here, "../src/generated/opportunity.ts");

const banner =
  "// GENERATED from schemas/v1.0.0/opportunity.schema.json — do not edit by hand.\n" +
  "// Regenerate with `pnpm codegen`.\n/* biome-ignore-all lint: generated */";

const ts = await compileFromFile(schemaPath, {
  bannerComment: banner,
  additionalProperties: false,
  declareExternallyReferenced: true,
  enableConstEnums: false,
  style: { singleQuote: false },
});

// `--check` mode: verify the committed file is in sync, never write. Used in CI.
if (process.argv.includes("--check")) {
  const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  if (current !== ts) {
    console.error(
      "✗ generated types are out of sync with the schema.\n" +
        "  Run `pnpm codegen` and commit packages/standard/src/generated/opportunity.ts.",
    );
    process.exit(1);
  }
  console.log("✓ generated types are in sync with the schema");
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, ts);
  console.log(`wrote ${outPath}`);
}
