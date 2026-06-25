import { humanizeErrors } from "../errors.js";
import type { ValidationResult } from "../validator.js";

export interface EntryResult {
  source: string;
  index: number;
  count: number;
  id?: string;
  type?: string;
  result: ValidationResult;
}

/** Strategy for rendering validation results — implement to add new output formats. */
export interface Reporter {
  report(results: EntryResult[]): void;
}

function label(r: EntryResult): string {
  return `${r.source}${r.count > 1 ? ` [${r.index}]` : ""}${r.id ? ` ${r.id}` : ""}`;
}

export class TextReporter implements Reporter {
  constructor(private readonly quiet = false) {}

  report(results: EntryResult[]): void {
    for (const r of results) {
      if (r.result.valid) {
        if (!this.quiet) process.stdout.write(`✓ PASS  ${label(r)}\n`);
      } else {
        process.stdout.write(`✗ FAIL  ${label(r)}\n`);
        for (const line of humanizeErrors(r.result.errors)) {
          process.stdout.write(`        - ${line}\n`);
        }
      }
    }
    const passed = results.filter((r) => r.result.valid).length;
    process.stdout.write(`\n${passed} passed, ${results.length - passed} failed\n`);
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
      results: results.map((r) => ({
        source: r.source,
        index: r.index,
        count: r.count,
        id: r.id,
        type: r.type,
        valid: r.result.valid,
        errors: r.result.valid ? [] : humanizeErrors(r.result.errors),
      })),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
}
