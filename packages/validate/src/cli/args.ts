import { SPEC_VERSION } from "@the-rfp-hub/standard";

export interface CliOptions {
  spec: string;
  quiet: boolean;
  json: boolean;
  strict: boolean;
  help: boolean;
  listSpecs: boolean;
  stdin: boolean;
  files: string[];
}

export const HELP = `rfphub-validate — validate funding opportunities against the RFP Hub Standard

Usage:
  rfphub-validate [options] <file|dir|->...

Inputs:
  Each input may be a JSON file, a directory (all *.json in it are validated),
  or '-' for stdin. Each JSON document may be a single opportunity object or an
  array of opportunity objects.

Two tiers are reported. SCHEMA ERRORS are hard conformance failures. ADVISORY WARNINGS
cover what the schema deliberately leaves open — unregistered eligibility keys, deadline
labels and grant.programModel values, and milestone amounts with no envelope currency to
denominate them. Warnings never make a document non-conformant unless you pass --strict.

Options:
  --spec <version>   Standard version to validate against (default: ${SPEC_VERSION})
  --list-specs       List bundled spec versions and exit
  --json             Emit a machine-readable JSON report
  --strict           Treat advisory warnings as failures (exit 1)
  -q, --quiet        Only print failures, warnings and the summary
  -h, --help         Show this help

Exit codes:
  0  all entries valid
  1  one or more entries invalid (or, with --strict, any advisory warning)
  2  usage / IO / parse error

Examples:
  rfphub-validate opportunity.json
  rfphub-validate ./exports/
  rfphub-validate --strict --json ./exports/
  cat opportunity.json | rfphub-validate -`;

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    spec: SPEC_VERSION,
    quiet: false,
    json: false,
    strict: false,
    help: false,
    listSpecs: false,
    stdin: false,
    files: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-q" || a === "--quiet") opts.quiet = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--strict") opts.strict = true;
    else if (a === "--list-specs") opts.listSpecs = true;
    else if (a === "--spec") {
      const next = argv[++i];
      if (next === undefined) throw new Error("--spec requires a value");
      opts.spec = next;
    } else if (a.startsWith("--spec=")) opts.spec = a.slice("--spec=".length);
    else if (a === "-") opts.stdin = true;
    else if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
    else opts.files.push(a);
  }
  return opts;
}
