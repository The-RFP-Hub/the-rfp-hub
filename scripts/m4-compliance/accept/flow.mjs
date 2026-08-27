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
 * WHY THE APPROVAL SUBPROCESS GETS "y\n" ON STDIN. `rfphub-mcp approve <id>` is specified to prompt
 * interactively in the operator's terminal. An acceptance run has no operator; it stands in for one
 * by piping a confirming answer to the subprocess's stdin, which is the same trust boundary the
 * plan itself names as NOT isolated from an agent that already has shell access under the same
 * user (§3.4 "what this interlock does NOT guarantee"). That is exactly why this driver lives in
 * `accept-m4.mjs`, a tool a human runs deliberately against staging, and not in the read-only
 * `check-m4.mjs` that defaults to production.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { callJson } from "../../m3-compliance/client.mjs";
import { resolveCommand } from "../checks/mcp.mjs";
import { McpStdioClient } from "../mcp-client.mjs";

const execFileAsync = promisify(execFile);

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
 */
export async function runSubmissionCycle(ctx, state) {
  const resolved = resolveCommand(ctx);
  state.serverDescribe = resolved.describe;

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
    const document = fixtureDocument(state.run);

    // ── phase 1: preview ──────────────────────────────────────────────────
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

    // ── phase 2: approval, in a SEPARATE process, "y\n" standing in for the operator ──────────
    const approveArgs = resolveCommand(ctx, ["approve", approvalId]);
    let approveResult;
    try {
      approveResult = await execFileAsync(approveArgs.command, approveArgs.args, {
        cwd: ctx.repoRoot,
        timeout: ctx.approveTimeoutMs,
        input: "y\n",
      });
    } catch (err) {
      throw new Error(
        `phase 2 (rfphub-mcp approve ${approvalId}) failed: ${err.message}${err.stderr ? `\nstderr: ${err.stderr}` : ""}`,
      );
    }
    state.approveOutput = `${approveResult.stdout}${approveResult.stderr ?? ""}`;

    // ── phase 3: commit ───────────────────────────────────────────────────
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
    const opportunityId = commit?.id ?? commit?.opportunity?.id;
    if (!opportunityId) {
      throw new Error(
        `phase 3 (commit) did not return an opportunity id: ${JSON.stringify(commit).slice(0, 500)}`,
      );
    }
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
 * reject endpoint, same "leave it named rather than silently drop it" behaviour on failure.
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
