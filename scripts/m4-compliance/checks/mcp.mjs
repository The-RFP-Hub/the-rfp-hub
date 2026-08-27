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
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    // REAL, not merely absolute. `cli.ts`'s own entrypoint guard compares
    // `fileURLToPath(import.meta.url)` (which Node resolves through any symlink in the path) to
    // `path.resolve(process.argv[1])` (which does NOT resolve symlinks). Passing `local` as given
    // — through, say, macOS's `/tmp` → `/private/tmp` symlink, which is exactly what a `--repo-root`
    // under `os.tmpdir()` looks like — makes the two disagree, `isEntrypoint` comes back false,
    // `main()` never runs, and the process exits 0 having done nothing: no banner, no error, no
    // response, silence indistinguishable from "hung" until this checker's own timeout fires. Found
    // by actually spawning a real built `packages/mcp` (this checker's own tests, and every
    // `--mcp-spec`-less run before the package is published, only ever exercised the npx-404
    // fallback) — not a hypothetical, and not specific to this one package: any well-behaved CLI
    // using this common `isEntrypoint` idiom would hit the same thing under a symlinked repo root.
    const resolved = realpathSync(local);
    const args = [resolved, ...extraArgs];
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

/**
 * `findCredentialLeak` over every value given, PLUS the client's own `stderr` and any stdout
 * lines that weren't valid JSON-RPC. A key-shaped string can leak into a diagnostic log line or a
 * stray `console.log` just as easily as into a tool's JSON output, and scanning only the parsed
 * response objects — what every leak check here did before — would miss exactly that surface.
 */
function scanClientForLeak(client, ...values) {
  for (const value of values) {
    const leak = findCredentialLeak(value);
    if (leak) return leak;
  }
  if (client.stderr) {
    const leak = findCredentialLeak(client.stderr, "$.stderr");
    if (leak) return leak;
  }
  if (client.stdoutNonJsonLines) {
    const leak = findCredentialLeak(client.stdoutNonJsonLines, "$.stdoutNonJsonLines");
    if (leak) return leak;
  }
  return null;
}

async function spawnClient(resolved, env, ctx, unset = []) {
  const client = new McpStdioClient(resolved.command, resolved.args, {
    cwd: ctx.repoRoot,
    env,
    unset,
  });
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

  // A real server writes an audit-log line under `RFPHUB_MCP_HOME` (default `~/.rfphub`) for
  // EVERY tool call, read or write — `server.ts`'s `guard()` wrapper runs `appendAudit` in a
  // `finally`, unconditionally. Left unset, even the read-only cases below (tools/list, a plain
  // search) would leave entries in the PERSON RUNNING THIS CHECKER's own `~/.rfphub/audit.log`,
  // and case C's synthetic preview would land in `~/.rfphub/pending/`, indistinguishable from a
  // real preview `rfphub-mcp pending` would list. One fresh, disposable directory for the whole
  // check — cleaned up in the `finally` below regardless of how the checks inside fare — keeps
  // every case's fixtures out of anyone's real state.
  const mcpHome = await mkdtemp(join(tmpdir(), "m4-check-mcp-home-"));
  try {
    // ── case A: default env — read-only tools only ──────────────────────────
    // `unset` guarantees this case is actually tested with no credential and no submit flag
    // present — not merely "not set by this call", which could still see them if the checker's
    // own process happens to have inherited them from a developer's shell.
    let readClient;
    try {
      readClient = await spawnClient(
        resolved,
        { RFPHUB_API_BASE: ctx.api, RFPHUB_MCP_HOME: mcpHome },
        ctx,
        ["RFPHUB_API_KEY", "RFPHUB_MCP_ENABLE_SUBMIT"],
      );
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
        const leak = scanClientForLeak(readClient, listResponse);
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

        const leak = scanClientForLeak(readClient, callResponse);
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
          RFPHUB_MCP_HOME: mcpHome,
        },
        ctx,
      );

      const listResponse = await submitClient.request(
        "tools/list",
        {},
        { timeoutMs: ctx.timeoutMs },
      );
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

        // The synthetic key (`rfph_test_notreal`) is also a "credential-shaped" string, so this
        // process's tools/list is exactly the surface most likely to leak one — e.g. into a tool's
        // description if a future change ever interpolated config into it.
        const listLeak = scanClientForLeak(submitClient, listResponse);
        c.expect(
          !listLeak,
          "no rfph_ substring in tools/list output (submit-enabled process)",
          "clean",
          listLeak ? `found "${listLeak.match}" at ${listLeak.path}` : "",
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
        // The success condition is the STRUCTURED contract, not a regex over the human-readable
        // text block: `structuredContent.status === "pending"` is what `submit.ts`'s own
        // `outputSchema` actually promises, and a regex over `asText` would happily pass on the
        // word "pending" appearing anywhere at all — inside an error message explaining that
        // something is NOT pending, for instance.
        const structured = submitResponse.result?.structuredContent;
        c.expect(
          structured?.status === "pending",
          'submit_opportunity phase 1 returns status: "pending" (structuredContent)',
          JSON.stringify(structured).slice(0, 300),
          `structuredContent.status is not "pending": ${JSON.stringify(structured ?? submitResponse.result).slice(0, 500)}`,
        );

        const leak = scanClientForLeak(submitClient, submitResponse);
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
  } finally {
    await rm(mcpHome, { recursive: true, force: true });
  }

  return c.finish();
}
