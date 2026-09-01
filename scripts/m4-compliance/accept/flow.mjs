/**
 * The real 3-phase MCP submission, driven end to end against a staging deployment.
 *
 * This is the one place in the M4 tooling that exercises the interlock for real: `submit_opportunity`
 * phase 1 (preview, no network write) → a SEPARATE process running `rfphub-mcp approve <id>`,
 * simulating the human step the plan requires never be automatable from inside the MCP channel
 * itself → `submit_opportunity` phase 3 (commit, the actual `POST`). `check-m4.mjs`'s MCP check
 * never does this — it only proves phase 1 writes nothing, against a local mock. This is the tool
 * that proves the whole cycle actually lands an entry.
 *
 * WHY THE APPROVAL SUBPROCESS GETS "approve\n" ON STDIN. `rfphub-mcp approve <id>` (`packages/mcp/
 * src/cli.ts`) prompts `Type \`approve\` to authorize, anything else to cancel: ` and compares the
 * TRIMMED answer against the literal string `"approve"` — nothing else counts, including "y". An
 * acceptance run has no operator; it stands in for one by writing that exact literal to the
 * subprocess's stdin, which is the same trust boundary the plan itself names as NOT isolated from
 * an agent that already has shell access under the same user (README "What this does — and what it
 * does not"). That is exactly why this driver lives in `accept-m4.mjs`, a tool a human runs
 * deliberately against staging, and not in the read-only `check-m4.mjs` that defaults to
 * production. `execFile`'s callback/promise form has no `input` option (that exists only on the
 * `*Sync` variants), so this spawns the subprocess directly and writes to `child.stdin` itself.
 */
import { spawn } from "node:child_process";
import { callJson } from "../../m3-compliance/client.mjs";
import { resolveCommand } from "../checks/mcp.mjs";
import { McpStdioClient } from "../mcp-client.mjs";

/**
 * Run `rfphub-mcp approve <id>`, answering its confirmation prompt with the literal it requires.
 * Rejects with an Error carrying `.stdout`/`.stderr` on a non-zero exit, a spawn error, or a
 * timeout — the caller decides what a failure here means for the overall cycle.
 */
function runApprove(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(Object.assign(new Error(`timed out after ${timeoutMs}ms`), { stdout, stderr }));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(err, { stdout, stderr }));
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(Object.assign(new Error(`exited with code ${code}`), { stdout, stderr }));
      }
    });

    // The exact, trimmed literal `approve()` in cli.ts requires — anything else, "y" included, is
    // read as a cancellation.
    child.stdin.write("approve\n");
    child.stdin.end();
  });
}

function extractPayload(response) {
  const result = response?.result;
  if (!result) return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((block) => block.type === "text")?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result.content;
}

function fixtureDocument(run) {
  return {
    specVersion: "1.0.0",
    id: `m4check:m4check-${run}`,
    fundingType: "grant",
    title: `m4check-${run} — M4 acceptance fixture`,
    summary:
      "Created by scripts/accept-m4.mjs to verify the real MCP 3-phase submission interlock.",
    description:
      "Created by the RFP Hub M4 acceptance tool to verify the submit_opportunity interlock end to end against staging. Not a real funding opportunity — reject and unlist after the run.",
    status: "open",
    operatingOrganizations: [{ name: "m4check", slug: "m4check" }],
    ecosystems: ["Ethereum"],
    categories: ["tooling"],
    source: {},
    fundingDetails: { fundingType: "grant" },
  };
}

/**
 * Runs the full cycle. Returns `{ approvalId, opportunityId, submitResult }` on success; throws
 * with a message naming exactly which phase failed otherwise. The caller (accept-m4.mjs) is
 * responsible for reporting into a Report criterion and for calling `teardown` afterwards.
 *
 * MUTATES `state` as it goes, and does so BEFORE each network call rather than after, on purpose:
 *
 *   - `state.candidateOpportunityId` is set from the document's own declared `id` before phase 1
 *     ever runs — the document CHOOSES its id, so this is known with certainty from the start, not
 *     derived from a response that might never arrive.
 *   - `state.commitAttempted` is set immediately before the phase-3 `tools/call`, which is the one
 *     request whose failure is AMBIGUOUS: a `POST` that this process never got a reply for may
 *     still have reached the API (see submit.ts's own "never restore a claimed approval" rule for
 *     why). Phase 1 and phase 2 have no such ambiguity — phase 1 is specified not to write, and
 *     phase 2 is a local file operation — so a throw before `commitAttempted` is set means nothing
 *     was created.
 *
 * The caller (`accept-m4.mjs`) reads `state.candidateOpportunityId` and `state.commitAttempted`
 * from a catch block to decide whether an ambiguous outcome needs verifying and tearing down even
 * though this function threw.
 */
export async function runSubmissionCycle(ctx, state) {
  const resolved = resolveCommand(ctx);
  state.serverDescribe = resolved.describe;

  const document = fixtureDocument(state.run);
  state.candidateOpportunityId = document.id;

  const client = new McpStdioClient(resolved.command, resolved.args, {
    cwd: ctx.repoRoot,
    env: {
      RFPHUB_API_BASE: ctx.api,
      RFPHUB_API_KEY: ctx.writeKey,
      RFPHUB_MCP_ENABLE_SUBMIT: "1",
    },
  });
  client.start();

  try {
    // ── phase 1: preview (specified not to write) ───────────────────────────
    const previewResponse = await client.request(
      "tools/call",
      { name: "submit_opportunity", arguments: { document } },
      { timeoutMs: ctx.timeoutMs },
    );
    if (previewResponse.error) {
      throw new Error(
        `phase 1 (preview) failed: JSON-RPC error ${JSON.stringify(previewResponse.error)}`,
      );
    }
    const preview = extractPayload(previewResponse);
    const approvalId = preview?.approvalId;
    if (!approvalId) {
      throw new Error(
        `phase 1 (preview) did not return an approvalId: ${JSON.stringify(preview).slice(0, 500)}`,
      );
    }
    const status = preview?.status;
    if (status && status !== "pending") {
      throw new Error(`phase 1 (preview) returned status "${status}", expected "pending"`);
    }
    state.approvalId = approvalId;
    state.previewPayload = preview;

    // ── phase 2: approval, in a SEPARATE process (a local file operation — not ambiguous) ──────
    const approveArgs = resolveCommand(ctx, ["approve", approvalId]);
    let approveResult;
    try {
      approveResult = await runApprove(approveArgs.command, approveArgs.args, {
        cwd: ctx.repoRoot,
        timeoutMs: ctx.approveTimeoutMs,
      });
    } catch (err) {
      throw new Error(
        `phase 2 (rfphub-mcp approve ${approvalId}) failed: ${err.message}${err.stderr ? `\nstderr: ${err.stderr}` : ""}`,
      );
    }
    state.approveOutput = `${approveResult.stdout}${approveResult.stderr ?? ""}`;

    // ── phase 3: commit — from here, a throw means AMBIGUOUS, not "nothing happened" ───────────
    state.commitAttempted = true;
    const commitResponse = await client.request(
      "tools/call",
      { name: "submit_opportunity", arguments: { document, approvalId } },
      { timeoutMs: ctx.timeoutMs },
    );
    if (commitResponse.error) {
      throw new Error(
        `phase 3 (commit) failed: JSON-RPC error ${JSON.stringify(commitResponse.error)}`,
      );
    }
    const commit = extractPayload(commitResponse);
    // `commit.id` is always present per the real submittedSchema (packages/mcp/src/tools/
    // submit.ts), but the candidate is a sound fallback either way — it is the id the document
    // itself declared, and the API does not get to choose a different one for a client-supplied id.
    const opportunityId = commit?.id ?? state.candidateOpportunityId;
    state.opportunityId = opportunityId;
    state.commitPayload = commit;

    return { approvalId, opportunityId, submitResult: commit };
  } finally {
    await client.close();
  }
}

/**
 * Verifies the fixture landed `pending` — via `GET /v1/me/opportunities` with the SAME write
 * credential that submitted it, never the public read surface, which hides pending entries by
 * design (the same distinction `m3-compliance/checks/namespace.mjs` draws).
 */
export async function verifyLandedPending(ctx, opportunityId) {
  const mine = await callJson(ctx, "/v1/me/opportunities?limit=100", {
    token: ctx.writeKey,
    agent: "rfphub-m4-accept",
  });
  if (!mine.ok || mine.status !== 200) {
    throw new Error(
      `GET /v1/me/opportunities answered ${mine.status ?? mine.error} — could not verify the fixture landed`,
    );
  }
  const entry = (mine.json?.items ?? []).find((item) => item.id === opportunityId);
  if (!entry) {
    throw new Error(`${opportunityId} is not in GET /v1/me/opportunities at all`);
  }
  if (entry.reviewStatus !== "pending") {
    throw new Error(
      `${opportunityId} has reviewStatus "${entry.reviewStatus}", expected "pending"`,
    );
  }
  return entry;
}

/**
 * Reject and unlist the fixture with the reviewer credential — the write-acceptance equivalent of
 * `m3-compliance/cleanup.mjs`, reused rather than reimplemented where the shape matches: same
 * reject endpoint, same "leave it named rather than silently drop it" behavior on failure.
 */
export async function teardown(ctx, opportunityId) {
  if (!opportunityId) return { skipped: "no fixture was created" };
  const rejected = await callJson(
    ctx,
    `/v1/review/opportunities/${encodeURIComponent(opportunityId)}/reject`,
    {
      method: "POST",
      token: ctx.reviewerToken,
      body: { reason: "M4 acceptance fixture" },
      agent: "rfphub-m4-accept",
    },
  );
  if (!rejected.ok || rejected.status !== 200) {
    throw new Error(
      `could not reject ${opportunityId}: ${rejected.status ?? rejected.error} — REJECT/UNLIST IT BY HAND`,
    );
  }
  return { rejected: true };
}

export { fixtureDocument };
