/**
 * THE RULE THIS FILE ENFORCES: every governance document this frontend links to is named ONCE, in
 * `src/lib/links.ts`.
 *
 * `src/lib/links.ts`'s own header explains why — three different spellings of the same outbound
 * address is how a public, source-neutral repository ends up with one of them 404ing, and the fix
 * is a single greppable module rather than a literal repeated at every call site. That module
 * already collects `REPOSITORY` and `STANDARD`; `GOVERNANCE`, `PUBLISHERS_DOC`, `REVIEW_CRITERIA`
 * and `RFC_PROCESS` are the same pattern for the governance framework, and this scan is what keeps
 * a future edit — a footer link added the fast way, a URL pasted straight into a page — from
 * quietly reintroducing a second spelling.
 *
 * The scan reads the SOURCE TREE from disk rather than importing modules, for the same reason
 * `no-raw-html.test.ts` does: the point is to cover code no test happens to execute.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = process.cwd();
const sourceRoot = join(packageRoot, "src");
const linksModule = join(sourceRoot, "lib", "links.ts");

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) found.push(full);
  }
  return found;
}

/** The document paths `links.ts` names, matched wherever they appear as a literal. */
const GOVERNANCE_DOCS = [
  "GOVERNANCE.md",
  "PUBLISHERS.md",
  "REVIEW-CRITERIA.md",
  "PROCESS.md#rfc-process",
];

describe("governance document URLs live in one module", () => {
  it("names every governance document at least once, so the list below cannot go stale", () => {
    const links = readFileSync(linksModule, "utf8");
    for (const doc of GOVERNANCE_DOCS) expect(links).toContain(doc);
  });

  it("is the ONLY file naming a governance document's path", () => {
    const offenders: { file: string; doc: string }[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      if (file === linksModule) continue;
      const contents = readFileSync(file, "utf8");
      for (const doc of GOVERNANCE_DOCS) {
        if (contents.includes(doc)) offenders.push({ file, doc });
      }
    }
    expect(offenders).toEqual([]);
  });
});
