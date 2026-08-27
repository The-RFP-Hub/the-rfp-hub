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
  apiBase,
  buildSearchQuery,
  clampLimit,
  exitCodeFor,
  fetchJson,
  formatTable,
  newInvocationId,
  parseArgs,
  projectPage,
} from "./lib.mjs";

const HELP = `rfp-hub-funding-search — search.mjs

Search open Ethereum-ecosystem funding opportunities via the RFP Hub public API.

  node search.mjs [options]

Options map 1:1 to GET /v1/opportunities query params:
  --q <text>                Free-text search over title/summary/description
  --fundingType <list>      grant,hackathon,bounty,accelerator,vc_fund,rfp
  --status <list>           upcoming,open,closed,archived
  --ecosystem <list>        e.g. Optimism,Base
  --category <list>         e.g. DeFi,"Public Goods"
  --organization <slug>     matches any operating OR sponsoring organization
  --minAward <number>       --maxAward <number>
  --deadlineAfter <iso>     --deadlineBefore <iso>   RFC 3339 instants
  --sort <field>            nextDeadlineAt|opensAt|postedAt|updatedAt|createdAt
  --order <asc|desc>
  --page <n>                --limit <n>              capped at 25 by this skill
  --format <json|table>     default json
  --help                    show this message

A "<list>" value may be comma-separated: --ecosystem Optimism,Base

Env: RFPHUB_API_BASE (default https://api.ethrfps.app), RFPHUB_TIMEOUT_MS (default 10000).
See references/api-reference.md for the full parameter table and enum values.
`;

async function main(argv) {
  const { flags } = parseArgs(argv);
  if (flags.help !== undefined) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  const { format: rawFormat, limit: rawLimit, ...searchFlags } = flags;
  const format = rawFormat === "table" ? "table" : "json";

  let limit;
  try {
    limit = clampLimit(rawLimit);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return EXIT.USAGE;
  }

  let query;
  try {
    query = buildSearchQuery({ ...searchFlags, limit });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return EXIT.USAGE;
  }

  const base = apiBase();
  const url = `${base}/v1/opportunities?${query.toString()}`;
  const invocationId = newInvocationId();

  let page;
  try {
    page = await fetchJson(url, { invocationId });
  } catch (err) {
    if (err instanceof RequestError) {
      process.stderr.write(`${err.message}\n`);
      return exitCodeFor(err);
    }
    process.stderr.write(`Unexpected error: ${err.message}\n`);
    return EXIT.NETWORK;
  }

  const projected = projectPage(page, base);
  if (format === "table") {
    process.stdout.write(`${formatTable(projected)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(projected, null, 2)}\n`);
  }
  return EXIT.OK;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`Unexpected error: ${err?.message ?? err}\n`);
    process.exit(EXIT.NETWORK);
  },
);
