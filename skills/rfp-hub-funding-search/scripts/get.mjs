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
  assertKnownFlags,
  assertNoExtraPositionals,
  exitCodeFor,
  fetchJson,
  formatDetailTable,
  newInvocationId,
  parseArgs,
  projectDetail,
  sanitizeText,
  validateFormat,
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

/** Every flag this script accepts. `--id` is the alternative to the positional argument. */
const GET_ALLOWED_FLAGS = new Set(["id", "format", "help"]);

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.help !== undefined) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  try {
    assertKnownFlags(flags, GET_ALLOWED_FLAGS, "get.mjs");
    assertNoExtraPositionals(positional, 1, "get.mjs takes exactly one <id> (or --id <id>).");
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return EXIT.USAGE;
  }

  let format;
  try {
    format = validateFormat(flags.format);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return EXIT.USAGE;
  }

  const id = flags.id ?? positional[0];
  if (!id) {
    process.stderr.write("Usage: node get.mjs <id> [--format json|table]\n");
    return EXIT.USAGE;
  }

  const base = apiBase();
  const url = `${base}/v1/opportunities/${encodeURIComponent(id)}`;
  const invocationId = newInvocationId();

  let opportunity;
  try {
    opportunity = await fetchJson(url, { invocationId });
  } catch (err) {
    if (err instanceof RequestError) {
      if (err.status === 404 && err.body?.error === "opportunity_merged") {
        // The API's contract for this field is `{ id, title }` (see
        // OpportunityService#findMergedDestination), never a bare string — read `.id`. `title` is
        // ANOTHER entry's third-party title, so it goes through the same sanitizer as every other
        // publisher-supplied string this file ever prints (see lib.mjs's `sanitizeText`) before
        // being interpolated into this message.
        const merged = err.body.mergedInto;
        const mergedId = merged && typeof merged === "object" ? merged.id : merged;
        const mergedTitle =
          merged && typeof merged === "object" && typeof merged.title === "string"
            ? sanitizeText(merged.title)
            : undefined;
        const suffix = mergedTitle ? ` ("${mergedTitle}")` : "";
        process.stderr.write(
          `'${id}' was merged into '${mergedId}'${suffix}. Try fetching that id instead.\n`,
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
    process.stdout.write(`${formatDetailTable(projected)}\n`);
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
