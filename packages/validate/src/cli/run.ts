import { SPEC_VERSION } from "@rfp-hub/standard";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { createValidator, validateOpportunity } from "../validator.js";
import { HELP, parseArgs } from "./args.js";
import { type EntryResult, JsonReporter, type Reporter, TextReporter } from "./reporter.js";
import { expandInputs, readEntries, readStdin } from "./sources.js";

interface Source {
  source: string;
  entries: unknown[];
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

/** Run the CLI. Returns the process exit code (0 ok, 1 invalid, 2 usage/IO). */
export function run(argv: string[]): number {
  let opts: ReturnType<typeof parseArgs>;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (opts.listSpecs) {
    process.stdout.write(`${SPEC_VERSION}\n`);
    return 0;
  }

  let validator: ValidateFunction;
  try {
    if (opts.spec !== SPEC_VERSION) {
      throw new Error(`unsupported spec (this build ships ${SPEC_VERSION})`);
    }
    validator = createValidator();
  } catch (e) {
    process.stderr.write(`Cannot load spec '${opts.spec}': ${(e as Error).message}\n`);
    return 2;
  }

  let ioError = false;
  const inputs: Source[] = [];

  if (opts.stdin || opts.files.length === 0) {
    try {
      inputs.push({ source: "<stdin>", entries: readStdin() });
    } catch (e) {
      process.stderr.write(`<stdin>: ${(e as Error).message}\n`);
      return 2;
    }
  } else {
    for (const target of opts.files) {
      let files: string[];
      try {
        files = expandInputs([target]);
      } catch (e) {
        process.stderr.write(`${target}: ${(e as Error).message}\n`);
        ioError = true;
        continue;
      }
      for (const file of files) {
        try {
          inputs.push({ source: file, entries: readEntries(file) });
        } catch (e) {
          process.stderr.write(`${file}: invalid JSON: ${(e as Error).message}\n`);
          ioError = true;
        }
      }
    }
  }

  const results: EntryResult[] = [];
  for (const { source, entries } of inputs) {
    entries.forEach((data, index) => {
      const obj = asRecord(data);
      results.push({
        source,
        index,
        count: entries.length,
        id: typeof obj.id === "string" ? obj.id : undefined,
        type: typeof obj.type === "string" ? obj.type : undefined,
        result: validateOpportunity(data, { validator }),
      });
    });
  }

  const reporter: Reporter = opts.json ? new JsonReporter(opts.spec) : new TextReporter(opts.quiet);
  reporter.report(results);

  if (results.some((r) => !r.result.valid)) return 1;
  if (ioError) return 2;
  return 0;
}
