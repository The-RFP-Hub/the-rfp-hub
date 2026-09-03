#!/usr/bin/env node
/**
 * The executable. Four modes, and only the first speaks MCP.
 *
 *   rfphub-mcp                  serve MCP over stdio (what an MCP client runs)
 *   rfphub-mcp pending          list previews awaiting a human, and approvals already granted
 *   rfphub-mcp approve <id>     print the five bindings and the document, ask, and grant
 *   rfphub-mcp revoke <id>      delete a pending preview and any approval for it
 *
 * `--state-dir` is accepted in every mode and must name the SAME directory in all of them: the
 * server writes the preview there and the approval modes read it back. It is a flag rather than a
 * variable because a path is not a secret and an MCP client that can pass `env` can pass `args`.
 *
 * IN SERVER MODE STDOUT IS THE WIRE: a stray `console.log` corrupts the session, so diagnostics go
 * to stderr and never carry a request body. The approval modes are a separate mode of the same
 * binary rather than a tool because a tool is reachable from the model's loop — with the caveat,
 * stated in the README and ADR 0012, that an agent holding a shell as this user can run them too.
 */
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  APPROVAL_TTL_MS,
  approvalsDir,
  assertApprovalId,
  claimPending,
  claimedDir,
  deleteApproval,
  deletePending,
  describeBinding,
  isExpired,
  listApprovals,
  listPending,
  pendingDir,
  readPending,
  writeApproval,
} from "./approvals.js";
import { ConfigError, defaultStateDir, loadConfig } from "./config.js";
import { redactString, registerSecret } from "./redact.js";
import { PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION, createServer } from "./server.js";
import { RedactingTransport } from "./transport.js";

/**
 * ONE message however the preview became unavailable. Which of the two paths fired depends on how
 * a race interleaved, so distinguishing them would report a detail nobody can act on.
 */
function previewUnavailable(id: string): string {
  return `That preview is not available: ${id} was never pending, was revoked, or another \`approve\` for the same id completed first. NOTHING WAS APPROVED. Run \`rfphub-mcp pending\` to see what is actually waiting.`;
}

/** ONE message from either point that can notice it. Same reasoning as above. */
function previewExpired(expiresAt: string): string {
  return `That preview expired at ${expiresAt}, so NOTHING WAS APPROVED. Approvals are deliberately short-lived. Ask for a fresh preview and approve that one.`;
}

const USAGE = `rfphub-mcp — the RFP Hub MCP server

  rfphub-mcp                 serve MCP over stdio (this is what an MCP client runs)
  rfphub-mcp pending         list previews awaiting approval, and approvals already granted
  rfphub-mcp approve <id>    review one preview and approve it
  rfphub-mcp revoke <id>     delete a preview and any approval for it
  rfphub-mcp --help

Options (every mode):
  --state-dir <dir>          approvals, rate-limit counters and the audit log (default ~/.rfphub).
                             Pass the same directory to the server and to \`approve\`. Required
                             where this user has no writable home, as in a container.

Environment:
  RFPHUB_API_BASE            API base URL (default https://api.ethrfps.app)
  RFPHUB_API_KEY             credential. Searching and fetching are anonymous and never send it;
                             setting it is what registers the write tool at all
`;

class UsageError extends Error {}

const STATE_DIR_USAGE =
  "--state-dir needs a directory, as in `rfphub-mcp --state-dir /var/lib/rfphub`.";

/**
 * Only one flag, so no parser library. `--state-dir` is pulled out wherever it appears; everything
 * else stays a positional word in order, which keeps `approve <id>` reading the same.
 */
function parseArgs(argv: string[]): { words: string[]; stateDir: string | undefined } {
  const words: string[] = [];
  let stateDir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--state-dir") {
      const value = argv[i + 1];
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new UsageError(STATE_DIR_USAGE);
      }
      stateDir = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--state-dir=")) {
      const value = arg.slice("--state-dir=".length);
      if (value === "") throw new UsageError(STATE_DIR_USAGE);
      stateDir = value;
      continue;
    }
    words.push(arg);
  }
  return { words, stateDir };
}

/** stderr only. See the file header. */
function say(line: string): void {
  process.stderr.write(`${redactString(line)}\n`);
}

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    say(err instanceof UsageError ? err.message : String(err));
    return 2;
  }
  const [mode, ...rest] = parsed.words;

  if (mode === "--help" || mode === "-h" || mode === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (mode === "--version" || mode === "-v") {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return 0;
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env, { stateDir: parsed.stateDir });
  } catch (err) {
    if (err instanceof ConfigError) {
      say(`configuration error: ${err.message}`);
      return 2;
    }
    throw err;
  }
  registerSecret(config.apiKey);

  switch (mode) {
    case undefined:
      return serve(config);
    case "pending":
      return pending(config.home);
    case "approve":
      return approve(config, rest[0]);
    case "revoke":
      return revoke(config.home, rest[0]);
    default:
      say(`unknown command: ${mode}\n\n${USAGE}`);
      return 2;
  }
}

function serve(config: ReturnType<typeof loadConfig>): Promise<number> {
  say(
    `${SERVER_NAME} ${SERVER_VERSION} on stdio · protocol ${PROTOCOL_VERSION} · api ${config.apiOrigin} · ` +
      `submit ${config.apiKey ? "ENABLED" : "disabled"} · key ${config.apiKey ? "present" : "absent"} · state ${config.home}`,
  );
  serveStdio(() => createServer({ config }), {
    // Wrapped so EVERY outbound message is redacted, the SDK's own error paths included.
    transport: new RedactingTransport(new StdioServerTransport()),
    onerror: (error) => say(`transport error: ${error.message}`),
  });
  // Resolve never: the process lives until stdin closes and the runtime drains.
  return new Promise<number>(() => {});
}

function pending(home: string): number {
  // The hint has to be runnable: a listing of a directory the default would not have found must
  // carry the flag that found it.
  const flag = home === defaultStateDir() ? "" : ` --state-dir ${home}`;
  const previews = listPending(home);
  const approvals = listApprovals(home);
  const now = new Date();

  if (previews.length === 0 && approvals.length === 0) {
    process.stdout.write(
      `No previews and no approvals.\n  previews:  ${pendingDir(home)}\n  approvals: ${approvalsDir(home)}\n`,
    );
    return 0;
  }

  const lines: string[] = [];
  lines.push(`Previews awaiting approval (${pendingDir(home)}):`);
  if (previews.length === 0) lines.push("  (none)");
  for (const record of previews) {
    const state = isExpired(record, now) ? "EXPIRED" : `expires ${record.expiresAt}`;
    lines.push(`  ${record.approvalId}  ${state}`);
    lines.push(describeBinding(record).replace(/^/gm, "  "));
    lines.push(`    approve with: rfphub-mcp${flag} approve ${record.approvalId}`);
  }
  lines.push("");
  lines.push(`Approvals granted and not yet used (${approvalsDir(home)}):`);
  if (approvals.length === 0) lines.push("  (none)");
  for (const record of approvals) {
    const state = isExpired(record, now) ? "EXPIRED" : `expires ${record.expiresAt}`;
    lines.push(`  ${record.approvalId}  approved ${record.approvedAt}  ${state}`);
  }
  lines.push("");
  lines.push(`Spent approvals are moved to ${claimedDir(home)} and are never reusable.`);
  process.stdout.write(`${redactString(lines.join("\n"))}\n`);
  return 0;
}

async function approve(
  config: ReturnType<typeof loadConfig>,
  id: string | undefined,
): Promise<number> {
  if (id === undefined) {
    say("usage: rfphub-mcp approve <approvalId>");
    return 2;
  }
  // BEFORE IT TOUCHES A PATH: the id is joined onto a directory, so `../../.ssh/config` would be
  // a traversal. Nothing to sanitize — anything but 64 lowercase hex is not an id.
  try {
    assertApprovalId(id);
  } catch (err) {
    say(err instanceof Error ? err.message : String(err));
    return 2;
  }
  let record: ReturnType<typeof readPending>;
  try {
    record = readPending(config.home, id);
  } catch (err) {
    // A preview this process cannot vouch for is not printed for a person to authorize.
    say(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (record === null) {
    say(previewUnavailable(id));
    return 1;
  }
  const now = new Date();
  if (isExpired(record, now)) {
    say(previewExpired(record.expiresAt));
    return 1;
  }

  const document = JSON.stringify(record.document, null, 2);
  const out = [
    "",
    "APPROVE A SUBMISSION",
    "",
    "You are about to authorize one write. Read all five bindings — an approval is valid only for",
    "exactly this destination, credential, operation, protocol revision and document.",
    "",
    describeBinding(record),
    "",
    "Document:",
    document,
    "",
    `This approval is single-use and expires ${APPROVAL_TTL_MS / 60000} minutes from now. It is stored as a file readable only by you;`,
    "that is a courtesy against other users of this machine, not protection from programs running",
    "as you — including an agent with a shell here.",
    "",
  ].join("\n");
  process.stdout.write(`${redactString(out)}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = (await rl.question("Type `approve` to authorize, anything else to cancel: ")).trim();
  } finally {
    rl.close();
  }
  if (answer !== "approve") {
    process.stdout.write("Canceled. Nothing was approved.\n");
    return 1;
  }

  // CLAIMED AFTER THE ANSWER, NOT BEFORE THE QUESTION: everything above happened across an
  // unbounded wait for a human, inside which the preview can be revoked, expire, or be approved
  // in a second terminal. One atomic rename decides it.
  let claimed: ReturnType<typeof claimPending>;
  try {
    claimed = claimPending(config.home, record.approvalId);
  } catch (err) {
    say(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (claimed === null) {
    // Deliberately the SAME sentence the read-side miss prints.
    say(previewUnavailable(record.approvalId));
    return 1;
  }

  // Re-checked: the answer to "has it expired" can change while the question is being asked.
  const approvedAt = new Date();
  if (isExpired(claimed, approvedAt)) {
    say(previewExpired(claimed.expiresAt));
    return 1;
  }

  writeApproval(config.home, {
    apiOrigin: claimed.apiOrigin,
    keyFingerprint: claimed.keyFingerprint,
    operation: claimed.operation,
    protocolVersion: claimed.protocolVersion,
    documentHash: claimed.documentHash,
    approvalId: claimed.approvalId,
    approvedAt: approvedAt.toISOString(),
    expiresAt: new Date(approvedAt.getTime() + APPROVAL_TTL_MS).toISOString(),
  });
  process.stdout.write(
    `Approved ${claimed.approvalId}. The submit tool may now perform this one write, once.\n`,
  );
  return 0;
}

function revoke(home: string, id: string | undefined): number {
  if (id === undefined) {
    say("usage: rfphub-mcp revoke <approvalId>");
    return 2;
  }
  // Same reasoning as `approve`, and the stakes are higher: this one DELETES.
  try {
    assertApprovalId(id);
  } catch (err) {
    say(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const removedPending = deletePending(home, id);
  const removedApproval = deleteApproval(home, id);
  if (!removedPending && !removedApproval) {
    say(`Nothing to revoke for ${id}.`);
    return 1;
  }
  process.stdout.write(
    `Revoked ${id}${removedApproval ? " (an approval had been granted; it is gone)" : ""}.\n`,
  );
  return 0;
}

/** `fileURLToPath` rather than building a `file://` URL, which is wrong for a path with a space. */
const isEntrypoint = (() => {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(invoked);
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((err: unknown) => {
      say(`fatal: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}

export { main };
