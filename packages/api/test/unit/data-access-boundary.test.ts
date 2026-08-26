/**
 * Architectural boundary: repositories own every database query and transaction.
 *
 * Production database access is permitted only in the permanent implementation locations below.
 * The completed migration leaves the temporary allowlist empty and its ceiling at zero: the exact
 * offender assertion makes that zero-debt state a permanent invariant.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const API_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCAN_ROOTS = ["src", "scripts", "test", "tools"];
const ROOT_SOURCE_FILES = ["drizzle.config.ts", "tsup.config.ts"];

interface PermanentEntry {
  label: string;
  matches(file: string): boolean;
}

const PERMANENT_ALLOWLIST: PermanentEntry[] = [
  { label: "src/db/**", matches: (file) => file.startsWith("src/db/") },
  {
    label: "src/modules/repositories/**",
    matches: (file) => file.startsWith("src/modules/repositories/"),
  },
  // Config-only Better-Auth drizzleAdapter wiring; verified to contain zero query call sites.
  { label: "src/auth/better-auth.ts", matches: (file) => file === "src/auth/better-auth.ts" },
  { label: "scripts/migrate.ts", matches: (file) => file === "scripts/migrate.ts" },
  { label: "scripts/create-db.ts", matches: (file) => file === "scripts/create-db.ts" },
  { label: "drizzle.config.ts", matches: (file) => file === "drizzle.config.ts" },
  { label: "test/**", matches: (file) => file.startsWith("test/") },
];

// Migration complete. Keep empty: production access outside the permanent locations is a defect.
const TEMPORARY_ALLOWLIST: string[] = [];
const TEMPORARY_CEILING = 0;

type Violation = "drizzle-import" | "schema-value-import" | "transaction";

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesBelow(absolute);
    return entry.isFile() && entry.name.endsWith(".ts")
      ? [relative(API_ROOT, absolute).replaceAll("\\", "/")]
      : [];
  });
}

function sourceFiles(): string[] {
  return [
    ...SCAN_ROOTS.flatMap((root) => sourceFilesBelow(resolve(API_ROOT, root))),
    ...ROOT_SOURCE_FILES.filter((file) => existsSync(resolve(API_ROOT, file))),
  ].sort();
}

function isSchemaModule(specifier: string): boolean {
  return /(?:^|\/)db\/(?:auth-)?schema\.js$/.test(specifier);
}

function importHasRuntimeValue(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings?.elements.some((element) => !element.isTypeOnly) ?? false;
}

function violationsIn(file: string): Set<Violation> {
  const source = readFileSync(resolve(API_ROOT, file), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const violations = new Set<Violation>();

  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (specifier === "drizzle-orm" || specifier.startsWith("drizzle-orm/")) {
      violations.add("drizzle-import");
    }
    if (isSchemaModule(specifier) && importHasRuntimeValue(statement)) {
      violations.add("schema-value-import");
    }
  }

  function findTransactionCall(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "transaction"
    ) {
      violations.add("transaction");
    }
    ts.forEachChild(node, findTransactionCall);
  }
  findTransactionCall(ast);
  return violations;
}

const files = sourceFiles();
const violations = new Map(files.map((file) => [file, violationsIn(file)]));
const isPermanent = (file: string) => PERMANENT_ALLOWLIST.some((entry) => entry.matches(file));
const offenders = files.filter((file) => !isPermanent(file) && violations.get(file)?.size);

describe("repository data-access boundary", () => {
  it("keeps drizzle-orm imports inside the allowlist", () => {
    expect(
      offenders.filter(
        (file) =>
          violations.get(file)?.has("drizzle-import") && !TEMPORARY_ALLOWLIST.includes(file),
      ),
    ).toEqual([]);
  });

  it("keeps runtime schema imports inside the allowlist while permitting import type", () => {
    expect(
      offenders.filter(
        (file) =>
          violations.get(file)?.has("schema-value-import") && !TEMPORARY_ALLOWLIST.includes(file),
      ),
    ).toEqual([]);
  });

  it("keeps transaction ownership inside the allowlist", () => {
    expect(
      offenders.filter(
        (file) => violations.get(file)?.has("transaction") && !TEMPORARY_ALLOWLIST.includes(file),
      ),
    ).toEqual([]);
  });

  it("keeps migration debt at zero as a permanent invariant", () => {
    expect(offenders).toEqual(TEMPORARY_ALLOWLIST);
    expect(TEMPORARY_ALLOWLIST).toEqual([]);
    expect(TEMPORARY_CEILING).toBe(0);
  });

  it("scans a non-vacuous tree and keeps every permanent allowlist entry live", () => {
    expect(files.length).toBeGreaterThan(80);
    for (const entry of PERMANENT_ALLOWLIST) {
      expect(
        files.some((file) => entry.matches(file)),
        `${entry.label} exists`,
      ).toBe(true);
    }
  });
});
