/**
 * The real 3-phase MCP submission against staging, including what a happy path never touches: an
 * owner SNAPSHOT before anything, and a phase-3 commit attempted WITHOUT an approval that must be
 * refused with that snapshot unchanged.
 *
 * WHAT THE APPROVAL PROVES. By default this driver writes the literal `approve` into the CLI's
 * stdin — that automates the CLI, it does not demonstrate a human decision, and the report says
 * `approval: SIMULATED (non-interactive)`. `--interactive-approval` waits for an operator and says
 * `approval: HUMAN`. Both are honest; only one is evidence of the human step.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callJson } from "../../m3-compliance/client.mjs";
import { resolveCommand } from "../checks/mcp.mjs";
import { McpStdioClient } from "../mcp-client.mjs";

const READ_TOOLS = ["fetch_opportunity", "search_opportunities"];
const SUBMIT_TOOL = "submit_opportunity";

/**
 * Collision-resistant per PROCESS: a timestamp truncated to the minute gave two runs started in
 * the same minute the same fixture id, and the second one then "found" the first one's entry.
 */
export function runToken(now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `${stamp}-${process.pid.toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function fixtureDocument(run) {
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

/** Run `rfphub-mcp approve <id>`, answering its prompt with the literal it requires. */
function runApprove(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
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
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`exited with code ${code}`), { stdout, stderr }));
    });

    // The exact, trimmed literal `approve()` in cli.ts requires — anything else, "y" included, is
    // read as a cancellation.
    child.stdin.write("approve\n");
    child.stdin.end();
  });
}

/** Wait for a human to run the approval in another terminal. */
function waitForHumanApproval(state, { command, timeoutMs, onPrompt }) {
  onPrompt(
    [
      "",
      "  ACTION REQUIRED — approve this submission in ANOTHER terminal:",
      "",
      `      ${command}`,
      "",
      `  Waiting up to ${Math.round(timeoutMs / 1000)}s. Ctrl-C cancels the run (the fixture has not been created).`,
      "",
    ].join("\n"),
  );
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = setInterval(async () => {
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`no approval was recorded within ${timeoutMs}ms`));
        return;
      }
      if (await state.approvalConsumed()) {
        clearInterval(poll);
        resolve({ stdout: "(approved by the operator, out of band)", stderr: "" });
      }
    }, 1000);
  });
}

function extractPayload(response) {
  return response?.result?.structuredContent;
}

/** Every entry this credential owns, past the first 100. */
export async function ownedIds(ctx) {
  const ids = [];
  for (let page = 1; page <= 50; page++) {
    const res = await callJson(ctx, `/v1/me/opportunities?limit=100&page=${page}`, {
      token: ctx.writeKey,
      agent: "rfphub-m4-accept",
    });
    if (!res.ok || res.status !== 200) {
      throw new Error(`GET /v1/me/opportunities answered ${res.status ?? res.error}`);
    }
    const items = res.json?.items ?? [];
    for (const item of items) ids.push(item.id);
    if (items.length < 100 || ids.length >= (res.json?.total ?? ids.length)) break;
  }
  return ids;
}

/**
 * MUTATES `state` BEFORE each network call: `commitAttempted` is set immediately before the phase-3
 * POST, the one request whose failure is AMBIGUOUS — it may have reached the API even though this
 * process never saw the reply.
 */
export async function runSubmissionCycle(ctx, state, c) {
  const resolved = resolveCommand(ctx);
  state.serverDescribe = resolved.describe;
  c.info("MCP server under test", resolved.describe);

  const document = fixtureDocument(state.run);
  state.candidateOpportunityId = document.id;

  // Disposable, always removed: otherwise every run leaves state in the OPERATOR's own ~/.rfphub,
  // and a leftover approval could satisfy the "commit without approval is refused" case wrongly.
  const mcpHome = await mkdtemp(join(tmpdir(), "m4-accept-mcp-home-"));
  state.mcpHome = mcpHome;
  const env = {
    // A bare origin: the server refuses a base carrying a path, query, fragment or userinfo.
    RFPHUB_API_BASE: new URL(ctx.api).origin,
    RFPHUB_API_KEY: ctx.writeKey,
    RFPHUB_MCP_ENABLE_SUBMIT: "1",
    RFPHUB_MCP_HOME: mcpHome,
  };
  const client = new McpStdioClient(resolved.command, resolved.args, { cwd: ctx.repoRoot, env });
  client.start();

  try {
    const listResponse = await client.request("tools/list", {}, { timeoutMs: ctx.timeoutMs });
    const names = (listResponse.result?.tools ?? []).map((t) => t.name).sort();
    c.expect(
      names.length === 3 && [...READ_TOOLS, SUBMIT_TOOL].every((n) => names.includes(n)),
      "tools/list is exactly three tools with RFPHUB_MCP_ENABLE_SUBMIT=1",
      names.join(", "),
      `expected exactly [${[...READ_TOOLS, SUBMIT_TOOL].sort().join(", ")}], got [${names.join(", ")}]`,
    );

    const before = await ownedIds(ctx);
    c.pass(
      "owner snapshot taken before anything is submitted",
      `${before.length} entry(ies) owned`,
    );

    const previewResponse = await client.request(
      "tools/call",
      { name: SUBMIT_TOOL, arguments: { document } },
      { timeoutMs: ctx.timeoutMs },
    );
    if (previewResponse.error) {
      throw new Error(
        `phase 1 (preview) failed: JSON-RPC error ${JSON.stringify(previewResponse.error)}`,
      );
    }
    const preview = extractPayload(previewResponse);
    c.expect(
      preview?.status === "pending",
      'phase 1 (preview) returns status: "pending"',
      JSON.stringify(preview).slice(0, 300),
      `status is ${JSON.stringify(preview?.status)}, expected "pending" — a missing status used to be accepted`,
    );
    const approvalId = preview?.approvalId;
    if (!approvalId) {
      throw new Error(
        `phase 1 (preview) did not return an approvalId: ${JSON.stringify(preview).slice(0, 500)}`,
      );
    }
    state.approvalId = approvalId;
    state.previewPayload = preview;

    const afterPreview = await ownedIds(ctx);
    c.expect(
      afterPreview.length === before.length && !afterPreview.includes(document.id),
      "phase 1 created nothing, proved against /v1/me/opportunities",
      `${afterPreview.length} entry(ies) owned, unchanged, and ${document.id} is absent`,
      `the owner listing changed after the preview: ${before.length} → ${afterPreview.length}${afterPreview.includes(document.id) ? `, and ${document.id} is present` : ""}`,
    );

    // The interlock's whole point, and the case a happy path never reaches.
    const unapproved = await client.request(
      "tools/call",
      { name: SUBMIT_TOOL, arguments: { document, approvalId: "0".repeat(64) } },
      { timeoutMs: ctx.timeoutMs },
    );
    const refusal = JSON.stringify(unapproved.result ?? unapproved.error ?? {});
    c.expect(
      /confirmation_required|confirmation_invalid/.test(refusal),
      "phase 3 without a valid approval is refused",
      refusal.slice(0, 300),
      `expected confirmation_required/confirmation_invalid, got ${refusal.slice(0, 400)}`,
    );
    const afterRefusal = await ownedIds(ctx);
    c.expect(
      afterRefusal.length === before.length && !afterRefusal.includes(document.id),
      "the refused commit created nothing",
      `${afterRefusal.length} entry(ies) owned, unchanged`,
      `the owner listing changed after a REFUSED commit: ${before.length} → ${afterRefusal.length}`,
    );

    const approveArgs = resolveCommand(ctx, ["approve", approvalId]);
    const approveCommand = `${approveArgs.command} ${approveArgs.args.join(" ")}`;
    state.approvalMode = ctx.interactiveApproval ? "HUMAN" : "SIMULATED (non-interactive)";
    try {
      if (ctx.interactiveApproval) {
        state.approvalConsumed = async () => {
          const pending = await client.request(
            "tools/call",
            { name: SUBMIT_TOOL, arguments: { document, approvalId } },
            { timeoutMs: ctx.timeoutMs },
          );
          // Only a consumed approval lets the commit through; anything else is "still waiting".
          const text = JSON.stringify(pending.result ?? pending.error ?? {});
          if (/confirmation_required|confirmation_invalid/.test(text)) return false;
          state.commitAttempted = true;
          state.interactiveCommitResponse = pending;
          return true;
        };
        await waitForHumanApproval(state, {
          command: `RFPHUB_MCP_HOME=${mcpHome} ${approveCommand}`,
          timeoutMs: ctx.approveTimeoutMs,
          onPrompt: (text) => process.stderr.write(`${text}\n`),
        });
      } else {
        const approveResult = await runApprove(approveArgs.command, approveArgs.args, {
          cwd: ctx.repoRoot,
          env: { ...process.env, ...env },
          timeoutMs: ctx.approveTimeoutMs,
        });
        state.approveOutput = `${approveResult.stdout}${approveResult.stderr ?? ""}`;
      }
    } catch (err) {
      throw new Error(
        `phase 2 (${approveCommand}) failed: ${err.message}${err.stderr ? `\nstderr: ${err.stderr}` : ""}`,
      );
    }
    c.info("approval", `approval: ${state.approvalMode} — ${approveCommand}`);

    let commitResponse = state.interactiveCommitResponse;
    if (!commitResponse) {
      state.commitAttempted = true;
      commitResponse = await client.request(
        "tools/call",
        { name: SUBMIT_TOOL, arguments: { document, approvalId } },
        { timeoutMs: ctx.timeoutMs },
      );
    }
    if (commitResponse.error) {
      throw new Error(
        `phase 3 (commit) failed: JSON-RPC error ${JSON.stringify(commitResponse.error)}`,
      );
    }
    const commit = extractPayload(commitResponse);
    // `commit.id` is always present per the real submittedSchema; the candidate is a sound fallback
    // either way — it is the id the document itself declared.
    const opportunityId = commit?.id ?? state.candidateOpportunityId;
    state.opportunityId = opportunityId;
    state.commitPayload = commit;
    c.pass(
      "preview → out-of-band approval → commit completes",
      `approvalId=${approvalId}, opportunityId=${opportunityId}, approval: ${state.approvalMode}`,
    );

    return opportunityId;
  } finally {
    await client.close();
    await rm(mcpHome, { recursive: true, force: true });
  }
}

/**
 * Via `GET /v1/me/opportunities` with the SAME write credential that submitted it, never the public
 * read surface, which hides pending entries by design.
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
  if (!entry) throw new Error(`${opportunityId} is not in GET /v1/me/opportunities at all`);
  if (entry.reviewStatus !== "pending") {
    throw new Error(
      `${opportunityId} has reviewStatus "${entry.reviewStatus}", expected "pending"`,
    );
  }
  return entry;
}

/** Reject and unlist the fixture with the reviewer credential, as `m3-compliance/cleanup.mjs` does. */
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

/**
 * Teardown is done when the entry is gone from the surfaces a reader can reach, not when the reject
 * endpoint answers 200.
 */
export async function verifyTornDown(ctx, opportunityId) {
  const mine = await callJson(ctx, "/v1/me/opportunities?limit=100", {
    token: ctx.writeKey,
    agent: "rfphub-m4-accept",
  });
  const owned = (mine.json?.items ?? []).find((item) => item.id === opportunityId);
  const publicRes = await callJson(ctx, `/v1/opportunities/${encodeURIComponent(opportunityId)}`, {
    agent: "rfphub-m4-accept",
  });
  return {
    ownerStatus: owned?.reviewStatus ?? "(absent)",
    publicStatus: publicRes.status,
    ok: (owned === undefined || owned.reviewStatus !== "pending") && publicRes.status === 404,
  };
}
