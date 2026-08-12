// Source-neutrality lint, repo-wide.
//
// The standard is CC0 and designed to be embedded, forked and code-generated from. An internal
// issue-tracker ID inside it travels into every downstream copy and every generated file, and
// it points at a system nobody outside this project can read. `packages/standard` has its own
// copy of this rule inside scripts/check-spec.mjs, because the published package must be able to
// enforce it on its own; this one covers everything else — the API, the validator, the docs,
// the workflows.
//
// Second rule, same reasoning one step out: the name of the vendor whose infrastructure this
// project was first built and deployed on, and that vendor's hosts. Those are provenance and
// deployment detail. They describe nothing a reader of this standard can act on, they date the
// repo to one company's estate, and — as happened in the deploy workflows — they arrive by
// being copied out of an internal repo rather than by anyone deciding to publish them.
// Infrastructure names belong in repository variables; prose should say what a thing does.
//
// Run with `pnpm check:neutral`. Exits non-zero on any hit.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TRACKER_ID = /\bDEV-\d+\b/g;
// The vendor's name, and its API host. Both are assembled from parts so this rule does not trip
// itself — the same trick packages/standard/scripts/check-spec.mjs uses for the retired domain
// and the retired npm scope. The trailing `\w*` is what catches the suffixed forms (the tracker
// host, the cluster names) without needing a pattern per variant.
const VENDOR_NAME = new RegExp(`\\b${["kar", "ma"].join("")}\\w*`, "gi");
const VENDOR_API_HOST = new RegExp(`\\b${["gap", "api"].join("")}\\w*`, "gi");

// The one file the vendor rule does not apply to. M1-Research-Report.md is a verbatim archive of
// user interviews conducted before this repo was public: the names in it are quoted source
// material — who was interviewed, which system they were describing — not configuration this
// repo binds itself to. Rewriting quotes to hide their subject would falsify the record.
//
// Exempt by exact path, one entry, deliberately not a prefix or a glob: a new file dropped into
// user-interviews/ must not inherit the exemption by accident. The tracker-ID rule above still
// applies to it, and to everything else, with no exemptions at all.
const VENDOR_EXEMPT = new Set(["user-interviews/M1-Research-Report.md"]);

const RULES = [
  {
    label: "internal tracker ID",
    patterns: [TRACKER_ID],
    exempt: new Set(),
    remedy:
      "Describe the decision in plain language, or link a public artifact (an ADR, an issue\n" +
      "  in this repo). Internal tracker IDs are unreadable to everyone downstream.",
  },
  {
    label: "vendor-branded identifier",
    patterns: [VENDOR_NAME, VENDOR_API_HOST],
    exempt: VENDOR_EXEMPT,
    remedy:
      "Infrastructure names (clusters, services, hosts) belong in repository variables —\n" +
      "  `${{ vars.NAME }}` in a workflow, an env var at runtime — not in a public repo. In\n" +
      "  prose, say what the thing is rather than whose it is.",
  },
];

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
const scanned = new Set(files.map((f) => relative(repoRoot, f)));
const failures = new Map(RULES.map((rule) => [rule.label, []]));

// An exemption for a file that no longer exists is an exemption nobody is reading. Catch it here
// rather than letting the list rot into something wider than anyone intended.
for (const rule of RULES) {
  for (const path of rule.exempt) {
    if (!scanned.has(path)) {
      failures
        .get(rule.label)
        .push(`${path}  (exempted by check-neutral.mjs, but no such file is scanned)`);
    }
  }
}

for (const file of files) {
  const rel = relative(repoRoot, file);
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (const rule of RULES) {
    if (rule.exempt.has(rel)) continue;
    for (const pattern of rule.patterns) {
      // `text.match` first so most files cost one pass, not one pass per line. Both calls go
      // through String.prototype.match, which resets a /g regex's lastIndex — `pattern.test`
      // would not, and would then start the next file mid-string.
      if (!text.match(pattern)) continue;
      for (const [i, line] of lines.entries()) {
        const found = line.match(pattern);
        if (found) {
          failures.get(rule.label).push(`${rel}:${i + 1}  ${[...new Set(found)].join(", ")}`);
        }
      }
    }
  }
}

const total = [...failures.values()].reduce((n, list) => n + list.length, 0);

if (total > 0) {
  console.error(`✗ check-neutral: ${total} source-neutrality violation(s) in a public repo`);
  for (const rule of RULES) {
    const hits = failures.get(rule.label);
    if (hits.length === 0) continue;
    console.error(`\n  ${hits.length} ${rule.label}(s):`);
    for (const f of hits) console.error(`    ${f}`);
    console.error(`\n  ${rule.remedy}`);
  }
  process.exit(1);
}

console.log(
  `✓ check-neutral: ${files.length} files scanned, no internal tracker IDs and no vendor-branded identifiers`,
);
