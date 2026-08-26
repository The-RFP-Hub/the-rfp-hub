/**
 * Architectural boundary: repositories own every database query and transaction.
 *
 * The temporary allowlist is migration debt, not permission. Its exact-match assertion is a
 * two-way ratchet: a new offender fails because it is absent, and a migrated offender fails because
 * its stale entry remains. Reduce the list and TEMPORARY_CEILING together; never raise the ceiling.
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

// Seeded by running this scanner against the pre-R0 tree. Keep sorted.
const TEMPORARY_ALLOWLIST: string[] = [
  "scripts/export.ts",
  "scripts/grant-admin.ts",
  "scripts/seed.ts",
  "src/modules/routes/redirects/redirect.controller.ts",
  "src/modules/services/admin/admin.service.ts",
  "src/modules/services/audit/audit.service.ts",
  "src/modules/services/auth/account.service.ts",
  "src/modules/services/auth/api-key.service.ts",
  "src/modules/services/auth/publish-authority.ts",
  "src/modules/services/claims/claim.service.ts",
  "src/modules/services/dedupe/dedupe.service.ts",
  "src/modules/services/health/health.service.ts",
  "src/modules/services/insights/event-buffer.ts",
  "src/modules/services/insights/insights.service.ts",
  "src/modules/services/insights/rollup.service.ts",
  "src/modules/services/jobs/staleness.service.ts",
  "src/modules/services/memberships/membership-invite.service.ts",
  "src/modules/services/notifications/notification-dispatch.service.ts",
  "src/modules/services/notifications/notification.service.ts",
  "src/modules/services/opportunities/managed-opportunity.service.ts",
  "src/modules/services/opportunities/opportunity-meta.service.ts",
  "src/modules/services/opportunities/opportunity-ownership.ts",
  "src/modules/services/opportunities/opportunity-write.service.ts",
  "src/modules/services/opportunities/opportunity.service.ts",
  "src/modules/services/publishers/publisher.service.ts",
  "src/modules/services/review/review.service.ts",
  "src/modules/services/stats/stats.service.ts",
  "src/modules/services/verification/verification.service.ts",
];
const TEMPORARY_CEILING = 28;

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

  it("ratchets the current migration debt in both directions", () => {
    expect(offenders).toEqual(TEMPORARY_ALLOWLIST);
    expect(TEMPORARY_CEILING).toBeGreaterThanOrEqual(TEMPORARY_ALLOWLIST.length);
  });

  it("scans a non-vacuous tree and keeps every allowlist entry live", () => {
    expect(files.length).toBeGreaterThan(80);
    for (const entry of PERMANENT_ALLOWLIST) {
      expect(
        files.some((file) => entry.matches(file)),
        `${entry.label} exists`,
      ).toBe(true);
    }
    for (const file of TEMPORARY_ALLOWLIST) {
      expect(files, `${file} exists`).toContain(file);
    }
  });
});
