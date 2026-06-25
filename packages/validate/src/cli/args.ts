import { SPEC_VERSION } from "@rfp-hub/standard";

export interface CliOptions {
  spec: string;
  quiet: boolean;
  json: boolean;
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

Options:
  --spec <version>   Standard version to validate against (default: ${SPEC_VERSION})
  --list-specs       List bundled spec versions and exit
  --json             Emit a machine-readable JSON report
  -q, --quiet        Only print failures and the summary
  -h, --help         Show this help

Exit codes:
  0  all entries valid
  1  one or more entries invalid
  2  usage / IO / parse error

Examples:
  rfphub-validate opportunity.json
  rfphub-validate ./exports/
  cat opportunity.json | rfphub-validate -`;

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    spec: SPEC_VERSION,
    quiet: false,
    json: false,
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
