#!/usr/bin/env node
/**
 * Fallback CLI for the rfp-hub-funding-search skill: `GET /v1/opportunities/{id}`, projected the
 * same way as search.mjs (see lib.mjs's `project`), plus the two link-outs. See ../SKILL.md.
 *
 * Usage:
 *   node get.mjs <id> [--format json|table]
 *   node get.mjs --id <id> [--format json|table]
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
  exitCodeFor,
  fetchJson,
  formatTable,
  newInvocationId,
  parseArgs,
  projectDetail,
} from "./lib.mjs";

const HELP = `rfp-hub-funding-search — get.mjs

Fetch one funding opportunity by id via the RFP Hub public API.

  node get.mjs <id> [--format json|table]

Options:
  --id <id>              alternative to the positional argument
  --format <json|table>  default json
  --help                 show this message

Env: RFPHUB_API_BASE (default https://api.ethrfps.app), RFPHUB_TIMEOUT_MS (default 10000).
`;

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.help !== undefined) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  const id = flags.id ?? positional[0];
  if (!id) {
    process.stderr.write("Usage: node get.mjs <id> [--format json|table]\n");
    return EXIT.USAGE;
  }

  const format = flags.format === "table" ? "table" : "json";
  const base = apiBase();
  const url = `${base}/v1/opportunities/${encodeURIComponent(id)}`;
  const invocationId = newInvocationId();

  let opportunity;
  try {
    opportunity = await fetchJson(url, { invocationId });
  } catch (err) {
    if (err instanceof RequestError) {
      if (err.status === 404 && err.body?.error === "opportunity_merged") {
        process.stderr.write(
          `'${id}' was merged into '${err.body.mergedInto}'. Try fetching that id instead.\n`,
        );
        return EXIT.CLIENT_ERROR;
      }
      process.stderr.write(`${err.message}\n`);
      return exitCodeFor(err);
    }
    process.stderr.write(`Unexpected error: ${err.message}\n`);
    return EXIT.NETWORK;
  }

  const projected = projectDetail(opportunity, base);
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
