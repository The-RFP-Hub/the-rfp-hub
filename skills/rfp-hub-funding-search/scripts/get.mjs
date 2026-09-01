#!/usr/bin/env node
/**
 * `GET /v1/opportunities/{id}`, projected the same way as search.mjs plus the two link-outs. Run
 * `--help` for the options; see ../SKILL.md and ../references/api-reference.md for the rest.
 */
import {
  EXIT,
  MAX_TITLE_LEN,
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
  truncateText,
  validateFormat,
} from "./lib.mjs";

const HELP = `rfp-hub-funding-search — get.mjs

Fetch one funding opportunity by id via the RFP Hub public API.

  node get.mjs <id> [--format json|table]

Options:
  --id <id>              alternative to the positional argument
  --format <json|table>  default json
  --help                 show this message

Env: RFPHUB_API_BASE (default https://api.ethrfps.app), RFPHUB_TIMEOUT_MS (default 10000, clamped to 60000).
`;

const GET_ALLOWED_FLAGS = new Set(["id", "format", "help"]);

async function main(argv) {
  let flags;
  let positional;
  try {
    ({ flags, positional } = parseArgs(argv));
    if (flags.help !== undefined) {
      process.stdout.write(HELP);
      return EXIT.OK;
    }
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
        // `mergedInto` is `{ id, title }`, never a bare string. That `title` is ANOTHER entry's
        // third-party text, so it gets the projection's own title treatment before being printed.
        const merged = err.body.mergedInto;
        const mergedId = merged && typeof merged === "object" ? merged.id : merged;
        const mergedTitle =
          merged && typeof merged === "object" && typeof merged.title === "string"
            ? truncateText(merged.title, MAX_TITLE_LEN)
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

// `process.exitCode = n`, never `process.exit(n)`: pipe writes are asynchronous on POSIX, and
// `exit()` tears the process down before a queued `stdout.write` can flush.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`Unexpected error: ${err?.message ?? err}\n`);
    process.exitCode = EXIT.NETWORK;
  },
);
