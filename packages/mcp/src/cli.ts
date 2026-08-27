#!/usr/bin/env node
/**
 * The executable. Four modes, and only the first one speaks MCP.
 *
 *   rfphub-mcp                  serve MCP over stdio (what an MCP client runs)
 *   rfphub-mcp pending          list previews awaiting a human, and approvals already granted
 *   rfphub-mcp approve <id>     print the five bindings and the document, ask, and grant
 *   rfphub-mcp revoke <id>      delete a pending preview and any approval for it
 *
 * NOTHING BUT PROTOCOL GOES TO STDOUT IN SERVER MODE. stdio transport means stdout IS the wire; a
 * stray `console.log` corrupts the session. Diagnostics go to stderr, and they never carry a
 * request body.
 *
 * The approval modes are the human half of the write interlock. They exist as a separate mode of
 * the same binary rather than as a tool because a tool is reachable from the model's loop and a
 * terminal command is not — with the honest caveat, stated in the README and ADR 0012, that an
 * agent holding a shell as this same user can run this command too.
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
import { ConfigError, loadConfig } from "./config.js";
import { redactString, registerSecret } from "./redact.js";
import { PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION, createServer } from "./server.js";
import { RedactingTransport } from "./transport.js";

/**
 * ONE message for "that preview is not available", whichever way it became unavailable.
 *
 * There are two code paths into it — the record is gone when `approve` first reads it, and the
 * record is gone when `approve` claims it after the confirmation — and from the terminal they are
 * the same situation: the thing you were asked about is not there any more, and nothing was
 * approved. Which of the two fired depends on how a race happened to interleave, so reporting them
 * differently would give the operator a detail they cannot act on and cannot reproduce, and it
 * would make the visible outcome of a concurrent approve nondeterministic. The next step is
 * identical either way, and it is what the message says.
 */
function previewUnavailable(id: string): string {
  return `That preview is not available: ${id} was never pending, was revoked, or another \`approve\` for the same id completed first. NOTHING WAS APPROVED. Run \`rfphub-mcp pending\` to see what is actually waiting.`;
}

/**
 * ONE message for "that preview's window has passed", from either of the two points that can
 * notice — before the question, and after the answer. Same reasoning as above: the operator's next
 * step does not depend on which check caught it.
 */
function previewExpired(expiresAt: string): string {
  return `That preview expired at ${expiresAt}, so NOTHING WAS APPROVED. Approvals are deliberately short-lived. Ask for a fresh preview and approve that one.`;
}

const USAGE = `rfphub-mcp — the RFP Hub MCP server

  rfphub-mcp                 serve MCP over stdio (this is what an MCP client runs)
  rfphub-mcp pending         list previews awaiting approval, and approvals already granted
  rfphub-mcp approve <id>    review one preview and approve it
  rfphub-mcp revoke <id>     delete a preview and any approval for it
  rfphub-mcp --help

Environment:
  RFPHUB_API_BASE            API base URL (default https://api.ethrfps.app)
  RFPHUB_API_KEY             credential, needed only to submit; searching is anonymous
  RFPHUB_MCP_ENABLE_SUBMIT   set to 1 to register the write tool at all
  RFPHUB_MCP_HOME            state directory (default ~/.rfphub); must be writable
`;

/** stderr only. See the file header. */
function say(line: string): void {
  process.stderr.write(`${redactString(line)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const [mode, ...rest] = argv;

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
    config = loadConfig();
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
      `submit ${config.submitEnabled ? "ENABLED" : "disabled"} · key ${config.apiKey ? "present" : "absent"}`,
  );
  // The factory is called per connection; one server instance serves the connection's lifetime.
  serveStdio(() => createServer({ config }), {
    // Wrapped so that EVERY outbound message is redacted, including the ones the SDK produces on
    // its own error paths. See transport.ts.
    transport: new RedactingTransport(new StdioServerTransport()),
    onerror: (error) => say(`transport error: ${error.message}`),
  });
  // Resolve never: the process lives until stdin closes and the runtime drains.
  return new Promise<number>(() => {});
}

function pending(home: string): number {
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
    lines.push(`    approve with: rfphub-mcp approve ${record.approvalId}`);
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
  // VALIDATED BEFORE IT TOUCHES A PATH. An approval id is joined onto a directory, so an argument
  // like `../../.ssh/config` would otherwise be a traversal — a file read and printed to the
  // terminal, or worse a file removed by `revoke`. The id is a digest and the shape is exact, so
  // there is nothing to sanitize: anything that is not 64 lowercase hex characters is not an id.
  try {
    assertApprovalId(id);
  } catch (err) {
    say(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const record = readPending(config.home, id);
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
    process.stdout.write("Cancelled. Nothing was approved.\n");
    return 1;
  }

  // THE PREVIEW IS CLAIMED AFTER THE ANSWER, NOT BEFORE THE QUESTION.
  //
  // Everything above this line happened across an unbounded wait for a human, and the world can
  // move inside it: the preview can be revoked from another terminal, its window can pass, or a
  // second `approve` for the same id can be sitting at its own prompt. Writing the approval on the
  // strength of what was read before the question would let two confirmations mint two approvals —
  // two writes out of one decision. One atomic rename decides it; everyone else is refused.
  const claimed = claimPending(config.home, record.approvalId);
  if (claimed === null) {
    // Deliberately the SAME sentence the read-side miss prints. Losing this race and finding the
    // preview already gone are one outcome as far as anybody at this terminal is concerned.
    say(previewUnavailable(record.approvalId));
    return 1;
  }

  // Re-checked against the claimed record, because the answer to "has it expired" can change while
  // the question is being asked, and because the claimed copy is the one nobody else can alter.
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

/**
 * True when this file is what Node was asked to run, rather than something a test imported.
 * `fileURLToPath` + `resolve` rather than string-building a `file://` URL: the latter is wrong for
 * any path containing a space.
 */
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
