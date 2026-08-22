/**
 * THE RULE THIS FILE ENFORCES: nothing in this package renders publisher-supplied content as
 * markup.
 *
 * The Standard says a `description` is untrusted and must be sanitised before rendering, and every
 * other string on a listing arrives by the same route. React escapes a text child, so the whole
 * defence is never leaving that path — and the one API call that leaves it is
 * `dangerouslySetInnerHTML`. A code review catches that on the day it is added; this catches it on
 * every day after, including the day somebody adds it inside an unrelated layout change.
 *
 * The scan reads the SOURCE TREE from disk rather than importing modules, because the point is to
 * cover code no test happens to execute.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// `process.cwd()`, not `import.meta.url`: this suite runs under jsdom, where the module URL is an
// http: URL that `fileURLToPath` refuses. Vitest runs it with the package directory as the cwd.
const packageRoot = process.cwd();
const sourceRoot = join(packageRoot, "src");

/** Every `.ts`/`.tsx` file under `src`, with its repo-relative-ish path for a readable failure. */
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

/**
 * Occurrences that are the API being CALLED, not the words appearing in prose.
 *
 * The comments in this package name the prohibition in order to explain it, and a scan that could
 * not tell the difference would force the documentation to talk around its own rule.
 */
const CALLS = [
  /dangerouslySetInnerHTML\s*=/,
  /\.innerHTML\s*=/,
  /\.outerHTML\s*=/,
  /insertAdjacentHTML\s*\(/,
  /document\.write\s*\(/,
];

describe("untrusted content is never rendered as markup", () => {
  const files = sourceFiles(sourceRoot);

  it("finds a source tree to scan at all", () => {
    // Without this, a rename that emptied `src` would make every assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(15);
  });

  it("has no HTML-injecting call anywhere in src/", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const pattern of CALLS) {
        if (pattern.test(text)) offenders.push(`${file.slice(packageRoot.length)}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("pulls in no markdown or sanitiser dependency that would reintroduce the path", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const names = Object.keys(manifest.dependencies ?? {});
    const rendering = names.filter((name) =>
      /markdown|sanitize|sanitise|dompurify|html/i.test(name),
    );
    // Not a ban forever — adding one is a reviewable decision, and this is what makes it one.
    expect(rendering).toEqual([]);
  });
});
