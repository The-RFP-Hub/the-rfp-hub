#!/usr/bin/env node
/**
 * Fallback CLI for the rfp-hub-funding-search skill: `GET /v1/opportunities`, with the tracking
 * headers and the projection applied BEFORE anything reaches stdout (and therefore before it can
 * reach an agent's context). See ../SKILL.md and ../references/api-reference.md.
 *
 * This is the ONLY documented way to call the API without the `@the-rfp-hub/mcp` server: never
 * `curl` the API directly from this skill (curl and jq are not guaranteed to exist, especially on
 * Windows, and neither one applies the projection for you).
 *
 * Usage:
 *   node search.mjs [--q text] [--fundingType a,b] [--status a,b] [--ecosystem a,b]
 *                    [--category a,b] [--organization slug] [--minAward n] [--maxAward n]
 *                    [--deadlineAfter iso] [--deadlineBefore iso] [--sort field] [--order asc|desc]
 *                    [--page n] [--limit n] [--format json|table]
 *
 * Env:
 *   RFPHUB_API_BASE   default https://api.ethrfps.app
 *   RFPHUB_TIMEOUT_MS default 10000
 *
 * Exit codes: see EXIT in lib.mjs / references/api-reference.md.
 */
import {
  EXIT,
  RequestError,
  SEARCH_PARAMS,
  apiBase,
  assertKnownFlags,
  assertNoExtraPositionals,
  buildSearchQuery,
  clampLimit,
  exitCodeFor,
  fetchJson,
  formatTable,
  newInvocationId,
  parseArgs,
  parsePage,
  projectPage,
  validateFormat,
  withDefaultStatus,
} from "./lib.mjs";

const HELP = `rfp-hub-funding-search — search.mjs

Search open Ethereum-ecosystem funding opportunities via the RFP Hub public API.

  node search.mjs [options]

Options map 1:1 to GET /v1/opportunities query params:
  --q <text>                Free-text search over title/summary/description
  --fundingType <list>      grant,hackathon,bounty,accelerator,vc_fund,rfp
  --status <list>           upcoming,open,closed,archived — DEFAULTS TO "open" when omitted
  --ecosystem <list>        e.g. Optimism,Base
  --category <list>         e.g. DeFi,"Public Goods"
  --organization <slug>     matches any operating OR sponsoring organization
  --minAward <number>       --maxAward <number>
  --deadlineAfter <iso>     --deadlineBefore <iso>   RFC 3339 instants
  --sort <field>            nextDeadlineAt|opensAt|postedAt|updatedAt|createdAt
  --order <asc|desc>
  --page <n>                --limit <n>              positive integers; limit capped at 25
  --format <json|table>     default json
  --help                    show this message

A "<list>" value may be comma-separated: --ecosystem Optimism,Base
This script takes no positional arguments — every filter is a --flag.

Without --status, this skill searches OPEN opportunities only (most requests like "find grants"
mean currently-open ones). Pass --status explicitly to see upcoming/closed/archived entries too,
e.g. --status upcoming,open,closed,archived for everything.

Env: RFPHUB_API_BASE (default https://api.ethrfps.app), RFPHUB_TIMEOUT_MS (default 10000).
See references/api-reference.md for the full parameter table and enum values.
`;

/** Every flag this script itself accepts, beyond the API's own query params: `--format` never
 * reaches the API, and `--help` short-circuits before anything else runs. */
const SEARCH_ALLOWED_FLAGS = new Set([...SEARCH_PARAMS, "format", "help"]);

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.help !== undefined) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  try {
    assertKnownFlags(flags, SEARCH_ALLOWED_FLAGS, "search.mjs");
    assertNoExtraPositionals(
      positional,
      0,
      "search.mjs takes no positional arguments; every filter is a --flag (see --help).",
    );
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return EXIT.USAGE;
  }

  const { format: rawFormat, limit: rawLimit, page: rawPage, ...searchFlags } = flags;

  let format;
  let limit;
  let page;
  try {
    format = validateFormat(rawFormat);
    limit = clampLimit(rawLimit);
    page = parsePage(rawPage);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return EXIT.USAGE;
  }

  let query;
  try {
    query = buildSearchQuery(
      withDefaultStatus({ ...searchFlags, limit, ...(page !== undefined ? { page } : {}) }),
    );
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return EXIT.USAGE;
  }

  const base = apiBase();
  const url = `${base}/v1/opportunities?${query.toString()}`;
  const invocationId = newInvocationId();

  let pageResult;
  try {
    pageResult = await fetchJson(url, { invocationId });
  } catch (err) {
    if (err instanceof RequestError) {
      process.stderr.write(`${err.message}\n`);
      return exitCodeFor(err);
    }
    process.stderr.write(`Unexpected error: ${err.message}\n`);
    return EXIT.NETWORK;
  }

  const projected = projectPage(pageResult, base);
  if (format === "table") {
    process.stdout.write(`${formatTable(projected)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(projected, null, 2)}\n`);
  }
  return EXIT.OK;
}

// `process.exitCode = n` (never `process.exit(n)`) so Node exits only once every pending write —
// including a large `process.stdout.write()` above, when piped to a slow reader — has actually
// flushed. `process.exit()` right after a write to a pipe is a documented truncation hazard: pipe
// writes are asynchronous on POSIX, and `exit()` tears the process down before a queued write can
// complete.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`Unexpected error: ${err?.message ?? err}\n`);
    process.exitCode = EXIT.NETWORK;
  },
);
