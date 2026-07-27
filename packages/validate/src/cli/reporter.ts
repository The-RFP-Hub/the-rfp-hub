import { entryPhrase } from "../checks/index.js";
import { humanizeErrors } from "../errors.js";
import type { ValidationResult } from "../validator.js";

export interface EntryResult {
  source: string;
  index: number;
  count: number;
  id?: string;
  fundingType?: string;
  /** The validated instance. Kept so error rendering can name the offending value. */
  data?: unknown;
  result: ValidationResult;
}

/** Strategy for rendering validation results — implement to add new output formats. */
export interface Reporter {
  report(results: EntryResult[]): void;
}

function label(r: EntryResult): string {
  return `${r.source}${r.count > 1 ? ` [${r.index}]` : ""}${r.id ? ` ${r.id}` : ""}`;
}

/**
 * How many ENTRIES (not warnings) each check fired on, in the checks' declared order.
 * Counting entries rather than warnings is what makes the summary actionable — "3 of 40
 * entries use an unregistered eligibility key" is a coverage statement; "11 warnings" is not.
 */
function warningCountsByCode(results: EntryResult[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of results) {
    for (const code of new Set(r.result.warnings.map((w) => w.code))) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return counts;
}

export class TextReporter implements Reporter {
  constructor(private readonly quiet = false) {}

  report(results: EntryResult[]): void {
    for (const r of results) {
      const hasWarnings = r.result.warnings.length > 0;
      if (r.result.valid) {
        if (!this.quiet || hasWarnings) {
          process.stdout.write(`${hasWarnings ? "! WARN" : "✓ PASS"}  ${label(r)}\n`);
        }
      } else {
        process.stdout.write(`✗ FAIL  ${label(r)}\n`);
        for (const line of humanizeErrors(r.result.errors, r.data)) {
          process.stdout.write(`        - ${line}\n`);
        }
      }
      if (hasWarnings) {
        for (const w of r.result.warnings) {
          process.stdout.write(`        ~ ${w.instancePath || "(root)"} ${w.message}\n`);
        }
      }
    }

    const passed = results.filter((r) => r.result.valid).length;
    process.stdout.write(`\n${passed} passed, ${results.length - passed} failed\n`);

    const counts = warningCountsByCode(results);
    if (counts.size > 0) {
      process.stdout.write("\nAdvisory (does not affect conformance; --strict to enforce):\n");
      for (const [code, n] of counts) {
        process.stdout.write(`  ${n} of ${results.length} entries ${entryPhrase(code)}\n`);
      }
    }
  }
}

export class JsonReporter implements Reporter {
  constructor(private readonly spec: string) {}

  report(results: EntryResult[]): void {
    const passed = results.filter((r) => r.result.valid).length;
    const payload = {
      spec: this.spec,
      total: results.length,
      passed,
      failed: results.length - passed,
      warned: results.filter((r) => r.result.warnings.length > 0).length,
      warningsByCode: Object.fromEntries(warningCountsByCode(results)),
      results: results.map((r) => ({
        source: r.source,
        index: r.index,
        count: r.count,
        id: r.id,
        fundingType: r.fundingType,
        valid: r.result.valid,
        errors: r.result.valid ? [] : humanizeErrors(r.result.errors, r.data),
        warnings: r.result.warnings,
      })),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
}
