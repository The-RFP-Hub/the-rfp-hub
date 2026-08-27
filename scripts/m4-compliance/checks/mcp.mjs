/**
 * M4-4 — the MCP server is installable and behaves.
 *
 * Resolving the server under test, in order:
 *
 *   1. `--mcp-spec <spec>`   → `npx -y @the-rfp-hub/mcp@<spec>` (an explicit npm version or "next")
 *   2. `packages/mcp/dist/cli.js`, if it exists in this checkout → `node <that file>` — so this
 *      check works BEFORE the package is ever published, which matters because `packages/mcp` is
 *      being built concurrently with this checker.
 *   3. Otherwise `npx -y @the-rfp-hub/mcp@next` as a last resort, which is expected to fail loudly
 *      until the package is actually published — that failure is reported by name, not swallowed.
 *
 * The transport is newline-delimited JSON-RPC (see `mcp-client.mjs` for why it is hand-rolled
 * rather than pulled from an SDK this repo does not depend on). Three separate server processes are
 * spawned across the sub-checks below, each with the minimum environment the case calls for —
 * sharing one process across cases would let state from an earlier call (a rate-limit counter, a
 * cached tool list) leak into a later assertion.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { request } from "../../m2-compliance/http.mjs";
import { McpStdioClient, findCredentialLeak } from "../mcp-client.mjs";
import { RecordingServer } from "../mock-server.mjs";

/**
 * Exported for `accept/flow.mjs`: the write-acceptance tool drives the exact same server binary
 * this read-only check does, and resolving it twice — possibly differently — would be its own bug.
 */
export function resolveCommand(ctx, extraArgs = []) {
  if (ctx.mcpSpec) {
    const args = ["-y", `@the-rfp-hub/mcp@${ctx.mcpSpec}`, ...extraArgs];
    return { command: "npx", args, describe: `npx ${args.join(" ")}` };
  }
  const local = join(ctx.repoRoot, "packages/mcp/dist/cli.js");
  if (existsSync(local)) {
    const args = [local, ...extraArgs];
    return { command: "node", args, describe: `node ${args.join(" ")}` };
  }
  const args = ["-y", "@the-rfp-hub/mcp@next", ...extraArgs];
  return {
    command: "npx",
    args,
    describe: `npx ${args.join(" ")} (fallback — package not found locally and no --mcp-spec given)`,
  };
}

/** Pull a JSON-shaped result out of a `tools/call` response, trying structuredContent first. */
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

async function spawnClient(resolved, env, ctx) {
  const client = new McpStdioClient(resolved.command, resolved.args, { cwd: ctx.repoRoot, env });
  client.start();
  return client;
}

export async function checkMcp(report, ctx) {
  const c = report.criterion(
    "M4-4",
    "MCP server installable and callable",
    "tools/list has search_opportunities and fetch_opportunity and NOT submit_opportunity without the env; search matches the API in ids; no rfph_ substring leaks anywhere; with the submit env, phase 1 returns pending and performs no network write.",
  );

  if (ctx.skip.has("mcp")) {
    c.skip("mcp", "--skip mcp");
    return c.finish();
  }

  const resolved = resolveCommand(ctx);
  c.info("MCP server under test", resolved.describe);

  // ── case A: default env — read-only tools only ──────────────────────────
  let readClient;
  try {
    readClient = await spawnClient(resolved, { RFPHUB_API_BASE: ctx.api }, ctx);
    const listResponse = await readClient.request("tools/list", {}, { timeoutMs: ctx.timeoutMs });
    if (listResponse.error) {
      c.fail("tools/list succeeds", `JSON-RPC error: ${JSON.stringify(listResponse.error)}`);
    } else {
      const names = (listResponse.result?.tools ?? []).map((t) => t.name);
      c.expect(
        names.includes("search_opportunities"),
        "tools/list includes search_opportunities",
        names.join(", "),
        `search_opportunities missing from tools/list: [${names.join(", ")}]`,
      );
      c.expect(
        names.includes("fetch_opportunity"),
        "tools/list includes fetch_opportunity",
        names.join(", "),
        `fetch_opportunity missing from tools/list: [${names.join(", ")}]`,
      );
      c.expect(
        !names.includes("submit_opportunity"),
        "tools/list does NOT include submit_opportunity without RFPHUB_MCP_ENABLE_SUBMIT",
        names.join(", "),
        `submit_opportunity is registered even though RFPHUB_MCP_ENABLE_SUBMIT was not set: [${names.join(", ")}]`,
      );
      const leak = findCredentialLeak(listResponse);
      c.expect(
        !leak,
        "no rfph_ substring in tools/list output",
        "clean",
        leak ? `found "${leak.match}" at ${leak.path}` : "",
      );
    }

    // ── case B: search matches the API ────────────────────────────────────
    const callResponse = await readClient.request(
      "tools/call",
      { name: "search_opportunities", arguments: { q: "grant", limit: 5 } },
      { timeoutMs: ctx.timeoutMs },
    );
    if (callResponse.error) {
      c.fail(
        "search_opportunities matches GET /v1/opportunities in ids",
        `JSON-RPC error: ${JSON.stringify(callResponse.error)}`,
      );
    } else {
      const payload = extractPayload(callResponse);
      const mcpIds = Array.isArray(payload?.items) ? payload.items.map((i) => i.id) : undefined;

      const apiRes = await request(`${ctx.api}/v1/opportunities?q=grant&limit=5`, {
        timeoutMs: ctx.timeoutMs,
      });
      let apiIds;
      try {
        apiIds = apiRes.ok ? JSON.parse(apiRes.body).items.map((i) => i.id) : undefined;
      } catch {
        apiIds = undefined;
      }

      if (!mcpIds) {
        c.fail(
          "search_opportunities matches GET /v1/opportunities in ids",
          `could not find an items[].id array in the tool's payload: ${JSON.stringify(payload).slice(0, 500)}`,
        );
      } else if (!apiIds) {
        c.fail(
          "search_opportunities matches GET /v1/opportunities in ids",
          `could not fetch a comparison result from ${ctx.api}/v1/opportunities?q=grant&limit=5`,
        );
      } else {
        c.expect(
          JSON.stringify(mcpIds) === JSON.stringify(apiIds),
          "search_opportunities ids equal GET /v1/opportunities ids, in order",
          `[${mcpIds.join(", ")}]`,
          `MCP returned [${mcpIds.join(", ")}], API returned [${apiIds.join(", ")}]`,
        );
      }

      const leak = findCredentialLeak(callResponse);
      c.expect(
        !leak,
        "no rfph_ substring in search_opportunities output",
        "clean",
        leak ? `found "${leak.match}" at ${leak.path}` : "",
      );
    }
  } catch (err) {
    c.fail("MCP server starts and answers tools/list", err.message);
  } finally {
    await readClient?.close();
  }

  // ── case C: submit_opportunity, fail-closed, no network write ───────────
  const mock = new RecordingServer();
  let submitClient;
  try {
    const origin = await mock.start();
    submitClient = await spawnClient(
      resolved,
      {
        RFPHUB_API_BASE: origin,
        RFPHUB_API_KEY: "rfph_test_notreal",
        RFPHUB_MCP_ENABLE_SUBMIT: "1",
      },
      ctx,
    );

    const listResponse = await submitClient.request("tools/list", {}, { timeoutMs: ctx.timeoutMs });
    if (listResponse.error) {
      c.fail(
        "tools/list includes submit_opportunity with RFPHUB_MCP_ENABLE_SUBMIT=1",
        `JSON-RPC error: ${JSON.stringify(listResponse.error)}`,
      );
    } else {
      const names = (listResponse.result?.tools ?? []).map((t) => t.name);
      c.expect(
        names.includes("submit_opportunity"),
        "tools/list includes submit_opportunity with RFPHUB_MCP_ENABLE_SUBMIT=1",
        names.join(", "),
        `submit_opportunity missing even with the env set: [${names.join(", ")}]`,
      );
    }

    const document = {
      specVersion: "1.0.0",
      id: "m4check:mcp-submit-fixture",
      fundingType: "grant",
      title: "M4 compliance MCP submission fixture",
      summary: "A fixture submitted by scripts/check-m4.mjs to verify the fail-closed interlock.",
      description: "Not a real funding opportunity.",
      status: "open",
      operatingOrganizations: [{ name: "m4check", slug: "m4check" }],
      ecosystems: ["Ethereum"],
      categories: ["tooling"],
      source: {},
      fundingDetails: { fundingType: "grant" },
    };
    const submitResponse = await submitClient.request(
      "tools/call",
      { name: "submit_opportunity", arguments: { document } },
      { timeoutMs: ctx.timeoutMs },
    );

    if (submitResponse.error) {
      c.fail(
        "submit_opportunity phase 1 returns pending",
        `JSON-RPC error: ${JSON.stringify(submitResponse.error)}`,
      );
    } else {
      const payload = extractPayload(submitResponse);
      const status = payload?.status ?? (typeof payload === "string" ? payload : undefined);
      const asText = JSON.stringify(payload ?? submitResponse);
      c.expect(
        status === "pending" || /\bpending\b/.test(asText),
        'submit_opportunity phase 1 returns status: "pending"',
        asText.slice(0, 300),
        `no "pending" status found in the tool's response: ${asText.slice(0, 500)}`,
      );

      const leak = findCredentialLeak(submitResponse);
      c.expect(
        !leak,
        "no rfph_ substring in submit_opportunity output",
        "clean",
        leak ? `found "${leak.match}" at ${leak.path}` : "",
      );
    }

    c.expect(
      mock.writeRequests.length === 0,
      "phase 1 performs no network write",
      `${mock.requests.length} request(s) total to the mock API, all reads`,
      `${mock.writeRequests.length} write request(s) reached the mock API before approval: ${mock.writeRequests
        .map((r) => `${r.method} ${r.url}`)
        .join(", ")}`,
    );
  } catch (err) {
    c.fail("MCP server starts with RFPHUB_MCP_ENABLE_SUBMIT=1", err.message);
  } finally {
    await submitClient?.close();
    await mock.stop();
  }

  return c.finish();
}
