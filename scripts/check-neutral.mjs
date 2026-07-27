// Source-neutrality lint, repo-wide.
//
// The standard is CC0 and designed to be embedded, forked and code-generated from. An internal
// issue-tracker ID inside it travels into every downstream copy and every generated file, and
// it points at a system nobody outside this project can read. `packages/standard` has its own
// copy of this rule inside scripts/check-spec.mjs, because the published package must be able to
// enforce it on its own; this one covers everything else — the API, the validator, the docs,
// the workflows.
//
// Run with `pnpm check:neutral`. Exits non-zero on any hit.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TRACKER_ID = /\bDEV-\d+\b/g;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".turbo", ".next", "coverage", "build"]);
const TEXT_EXT = /\.(json|jsonc|jsonld|ts|tsx|mjs|cjs|js|md|yml|yaml|sql|sh|txt)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (TEXT_EXT.test(name)) out.push(full);
  }
  return out;
}

const files = walk(repoRoot);
const failures = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const hits = text.match(TRACKER_ID);
  if (!hits) continue;
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const found = line.match(TRACKER_ID);
    if (found) {
      failures.push(`${relative(repoRoot, file)}:${i + 1}  ${[...new Set(found)].join(", ")}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`✗ check-neutral: ${failures.length} internal tracker ID(s) in a public repo`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "\n  Describe the decision in plain language, or link a public artifact (an ADR, an issue\n" +
      "  in this repo). Internal tracker IDs are unreadable to everyone downstream.",
  );
  process.exit(1);
}

console.log(`✓ check-neutral: ${files.length} files scanned, no internal tracker IDs`);
