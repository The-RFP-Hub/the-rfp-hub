/**
 * The MCP server is installable and behaves. Whether it is PUBLISHED is a separate question, in
 * `checks/mcp-publication.mjs`: a server behaves identically whether it came from npm, the
 * Registry or a local build, so that needs its own evidence.
 *
 * "Installable" has to mean installable from where a real user installs it, so the default resolves
 * the package from the real npm registry and FAILS by name before publish. `--mcp-spec local` is
 * the explicit opt-out for developing the package, and says plainly it is not publication evidence.
 *
 * Each sub-check spawns its own server process with the minimum environment its case calls for:
 * sharing one would let a rate-limit counter or a cached tool list from an earlier call leak into
 * a later assertion.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import AjvModule from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";
import { isLoopbackHost, request } from "../http.mjs";
import { McpStdioClient, findCredentialLeak } from "../mcp-client.mjs";
import { RecordingServer } from "../mock-server.mjs";

const execFileAsync = promisify(execFile);

/**
 * Exported for `accept/flow.mjs`: both tools drive the same binary, and resolving it twice —
 * possibly differently — would be its own bug. Throws when `--mcp-spec local` has nothing to run.
 */
export function resolveCommand(ctx, extraArgs = []) {
  // A seam, used by this checker's own tests to point the criterion at a stand-in server: the
  // assertions this criterion makes are a different question from how the binary is located.
  if (ctx.resolveOverride) {
    return { ...ctx.resolveOverride, args: [...ctx.resolveOverride.args, ...extraArgs] };
  }
  if (ctx.mcpSpec === "local") {
    const local = join(ctx.repoRoot, "packages/mcp/dist/cli.js");
    if (!existsSync(local)) {
      throw new Error(
        `--mcp-spec local: packages/mcp/dist/cli.js not found under --repo-root (${ctx.repoRoot}). Build it first: pnpm --filter @the-rfp-hub/mcp build.`,
      );
    }
    // REAL, not merely absolute. `cli.ts`'s entrypoint guard compares `fileURLToPath(import.meta
    // .url)` (symlinks resolved) against `path.resolve(process.argv[1])` (not resolved), so a
    // `--repo-root` under `os.tmpdir()` — macOS's `/tmp` → `/private/tmp` — made the two disagree:
    // `main()` never ran and the process exited 0 in silence, indistinguishable from "hung".
    const resolvedPath = realpathSync(local);
    const args = [resolvedPath, ...extraArgs];
    return {
      command: "node",
      args,
      describe: `node ${args.join(" ")} (--mcp-spec local — a local build, NOT evidence of npm/registry publication)`,
      local: true,
      spec: "local",
    };
  }
  const spec = ctx.mcpSpec ?? "next";
  const args = ["-y", `@the-rfp-hub/mcp@${spec}`, ...extraArgs];
  return { command: "npx", args, describe: `npx ${args.join(" ")}`, local: false, spec };
}

/**
 * `--version` is cheap and still forces npx to complete a REAL install first, so an unpublished
 * package fails here with npm's own 404 in one clearly-named check, rather than as a raw error
 * inside "tools/list succeeds" — a message shaped for a protocol bug, not a missing package.
 */
/** A cold `npx` install pulls the package and three dependencies; 30 s was tight on a slow link. */
const PREFLIGHT_FLOOR_MS = 60000;

async function probeRegistryInstall(spec, ctx) {
  const args = ["-y", `@the-rfp-hub/mcp@${spec}`, "--version"];
  try {
    const { stdout } = await execFileAsync("npx", args, {
      cwd: ctx.repoRoot,
      timeout: Math.max(ctx.timeoutMs, PREFLIGHT_FLOOR_MS),
    });
    const printed = stdout.trim();
    if (!/\d+\.\d+\.\d+/.test(printed)) {
      return {
        ok: false,
        detail: `npx installed the package, but \`--version\` exited 0 and printed ${printed ? JSON.stringify(printed.slice(0, 200)) : "nothing"} — the bin shim loaded the module without running its CLI`,
      };
    }
    return { ok: true, detail: printed.slice(0, 200) };
  } catch (err) {
    if (err.killed) {
      return {
        ok: false,
        detail: `npx did not finish within ${Math.max(ctx.timeoutMs, PREFLIGHT_FLOOR_MS)} ms — a cold install on a slow network, or a registry fetch that hung; retry, or raise --timeout`,
      };
    }
    const stderr = (err.stderr ?? "").toString().trim();
    return { ok: false, detail: (stderr || err.message).slice(0, 800) };
  }
}

/**
 * Every value given, PLUS the client's `stderr` and any stdout line that was not valid JSON-RPC: a
 * key-shaped string leaks into a diagnostic line as easily as into a tool's JSON output.
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

async function spawnClient(resolved, env, ctx, unset = [], extraArgs = []) {
  const client = new McpStdioClient(resolved.command, [...resolved.args, ...extraArgs], {
    cwd: ctx.repoRoot,
    env: { ...env, ...ctx.childEnv },
    unset,
  });
  client.start();
  return client;
}

// ajv is a root devDependency; its CJS default export needs unwrapping under ESM, and the two
// dialects need different classes — the real server's zod-generated schemas declare
// `$schema: …/2020-12/schema`, which the draft-07 build refuses to compile at all.
const Ajv = AjvModule.default ?? AjvModule;
const Ajv2020 = Ajv2020Module.default?.default ?? Ajv2020Module.default ?? Ajv2020Module;
const AJV_OPTIONS = { strict: false, allErrors: true, validateFormats: false };

export function schemaErrors(schema, value) {
  const dialect = String(schema?.$schema ?? "");
  const ajv = dialect.includes("2020-12") ? new Ajv2020(AJV_OPTIONS) : new Ajv(AJV_OPTIONS);
  try {
    const validate = ajv.compile(schema);
    return validate(value) ? null : ajv.errorsText(validate.errors, { separator: "; " });
  } catch (err) {
    return `the advertised outputSchema is not usable: ${err.message}`;
  }
}

const READ_TOOLS = ["fetch_opportunity", "search_opportunities"];

/**
 * `RFPHUB_API_BASE` must be a BARE ORIGIN, https off loopback, or the server refuses to start —
 * which would surface as an opaque failure inside "tools/list succeeds". This names it instead.
 */
export function mcpApiBase(api) {
  const url = new URL(api);
  const loopback = isLoopbackHost(url.hostname);
  return {
    origin: url.origin,
    trimmed: url.origin !== String(api).replace(/\/+$/, ""),
    refusedByServer: !loopback && url.protocol !== "https:",
  };
}
const SUBMIT_TOOL = "submit_opportunity";

/** Every tool's shape: an outputSchema, and annotations whose values are booleans. */
function checkToolDefinitions(c, tools, { label, readOnly }) {
  for (const tool of tools) {
    const where = `${tool.name} (${label})`;
    c.expect(
      tool.outputSchema && typeof tool.outputSchema === "object",
      `${where} advertises an outputSchema`,
      "present",
      "no outputSchema — a client cannot validate structuredContent against anything",
    );
    const annotations = tool.annotations;
    if (!annotations || typeof annotations !== "object") {
      c.fail(`${where} carries annotations`, "no annotations object");
      continue;
    }
    const nonBoolean = Object.entries(annotations).filter(
      ([key, value]) => key.endsWith("Hint") && typeof value !== "boolean",
    );
    c.expect(
      nonBoolean.length === 0,
      `${where}: every annotation hint is a boolean`,
      JSON.stringify(annotations),
      `non-boolean hint(s): ${nonBoolean.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}`,
    );
    const expected = readOnly.includes(tool.name);
    c.expect(
      annotations.readOnlyHint === expected,
      `${where}: readOnlyHint is ${expected}`,
      `readOnlyHint=${annotations.readOnlyHint}`,
      `readOnlyHint=${JSON.stringify(annotations.readOnlyHint)}, expected ${expected}`,
    );
    if (!expected) {
      c.expect(
        annotations.destructiveHint === false,
        `${where}: destructiveHint is false`,
        "destructiveHint=false",
        `destructiveHint=${JSON.stringify(annotations.destructiveHint)} — a submission behind an approval never destroys anything`,
      );
    }
  }
}

/**
 * The structured contract, with no text fallback: accepting a JSON-shaped text block instead let a
 * server that never produced structured output pass this criterion.
 */
function structuredPayload(c, response, tool, name) {
  const structured = response?.result?.structuredContent;
  if (structured === undefined) {
    c.fail(name, "the reply carries no structuredContent — a text block is not the contract");
    return undefined;
  }
  const errors = tool?.outputSchema ? schemaErrors(tool.outputSchema, structured) : null;
  c.expect(
    errors === null,
    name,
    "structuredContent validates against the advertised outputSchema",
    `structuredContent does not match the tool's own outputSchema: ${errors}`,
  );
  return errors === null ? structured : undefined;
}

/**
 * A query the live corpus answers with MORE THAN ONE PAGE, so page 2 proves something. Hard-coding
 * `q=grant` made this vacuous the day the corpus stopped matching: two empty pages compare equal.
 */
export async function deriveSearchQuery(ctx, limit = 5) {
  for (const q of ["grant", "funding", "ethereum", "open", "public goods"]) {
    const res = await request(
      `${ctx.api}/v1/opportunities?q=${encodeURIComponent(q)}&limit=${limit}&page=1`,
      { timeoutMs: ctx.timeoutMs },
    );
    if (!res.ok || res.status !== 200) continue;
    try {
      const json = JSON.parse(res.body);
      if (Number(json.total) > limit) return { q, limit };
    } catch {
      // a body this checker cannot parse is the API's problem, reported by the publishers/frontend rows
    }
  }
  return null;
}

async function apiPage(ctx, { q, limit, page }) {
  const res = await request(
    `${ctx.api}/v1/opportunities?q=${encodeURIComponent(q)}&limit=${limit}&page=${page}`,
    { timeoutMs: ctx.timeoutMs },
  );
  if (!res.ok || res.status !== 200) return null;
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

/** One report line per sub-criterion, so an omission cannot hide inside one PASS. */
async function checkSearchPage(c, client, ctx, tool, { q, limit, page }) {
  const label = `search_opportunities q="${q}" page ${page}`;
  const response = await client.request(
    "tools/call",
    { name: "search_opportunities", arguments: { q, limit, page } },
    { timeoutMs: ctx.timeoutMs },
  );
  if (response.error) {
    // The envelope still comes back to the caller: an error message is exactly the kind of
    // diagnostic that interpolates configuration, and returning null skipped the leak scan AND
    // made the caller dereference it.
    c.fail(`${label} succeeds`, `JSON-RPC error: ${JSON.stringify(response.error)}`);
    return { response, ids: null };
  }
  const payload = structuredPayload(c, response, tool, `${label} returns valid structuredContent`);
  if (!payload) return { response, ids: null };

  const api = await apiPage(ctx, { q, limit, page });
  if (!api) {
    c.fail(`${label} matches GET /v1/opportunities`, "could not fetch the comparison page");
    return { response, ids: null };
  }
  const mcpIds = (payload.items ?? []).map((i) => i.id);
  const apiIds = (api.items ?? []).map((i) => i.id);
  c.expect(
    mcpIds.length > 0,
    `${label} is non-empty`,
    `${mcpIds.length} item(s)`,
    "zero items — two empty pages compare equal, so an empty page proves nothing",
  );
  c.expect(
    JSON.stringify(mcpIds) === JSON.stringify(apiIds),
    `${label} ids equal the API's, in order`,
    `[${mcpIds.join(", ")}]`,
    `MCP returned [${mcpIds.join(", ")}], API returned [${apiIds.join(", ")}]`,
  );
  const envelope = ["total", "page", "limit", "totalPages"];
  const mismatched = envelope.filter((key) => payload[key] !== api[key]);
  c.expect(
    mismatched.length === 0,
    `${label} pagination envelope equals the API's`,
    envelope.map((k) => `${k}=${payload[k]}`).join(", "),
    mismatched
      .map((k) => `${k}: MCP ${JSON.stringify(payload[k])} vs API ${JSON.stringify(api[k])}`)
      .join("; "),
  );
  return { response, ids: mcpIds };
}

export async function checkMcp(report, ctx) {
  const local = ctx.mcpSpec === "local";
  const c = report.criterion(
    "mcp",
    local ? "MCP server callable from a local build" : "MCP server installable and callable",
    local
      ? "--mcp-spec local: exercises packages/mcp/dist/cli.js directly. NOT evidence the package is published — see the `mcp-publication` criterion. Exactly two tools without a credential and three with one, each with an outputSchema and boolean annotations; search returns structuredContent that validates against its own schema and matches the API page for page; no rfph_ substring leaks anywhere, including after the process exits; phase 1 returns pending and performs no network write."
      : "npx resolves @the-rfp-hub/mcp from the real npm registry and its CLI runs; exactly two tools without a credential and three with one, each with an outputSchema and boolean annotations; search returns structuredContent that validates against its own schema and matches the API page for page; no rfph_ substring leaks anywhere, including after the process exits; phase 1 returns pending and performs no network write.",
  );

  let resolved;
  try {
    resolved = resolveCommand(ctx);
  } catch (err) {
    c.fail("resolve the MCP server under test", err.message);
    return c.finish();
  }
  c.info("MCP server under test", resolved.describe);

  const apiBase = mcpApiBase(ctx.api);
  if (apiBase.refusedByServer) {
    c.fail(
      "the API base is one the MCP server will accept",
      `${ctx.api} is plaintext and not loopback; the server requires https off loopback and would refuse to start`,
    );
    return c.finish();
  }
  if (apiBase.trimmed) {
    c.info(
      "API base passed to the server",
      `${apiBase.origin} — the server accepts a bare origin only`,
    );
  }

  if (!resolved.local) {
    const probe = await probeRegistryInstall(resolved.spec, ctx);
    c.expect(
      probe.ok,
      `npx resolves @the-rfp-hub/mcp@${resolved.spec} from the npm registry and runs`,
      probe.detail,
      probe.detail,
    );
    if (!probe.ok) {
      c.unmet(
        "tools/list, search matching, and the submit interlock",
        "the package did not resolve from the registry (see the check above)",
      );
      return c.finish();
    }
  }

  // A real server appends an audit line under its state directory for every tool call, and without
  // `--state-dir` the preview below would land in the operator's own `~/.rfphub/pending/`,
  // indistinguishable from a real one.
  const mcpHome = await mkdtemp(join(tmpdir(), "compliance-mcp-home-"));
  try {
    let readClient;
    try {
      readClient = await spawnClient(
        resolved,
        { RFPHUB_API_BASE: apiBase.origin },
        ctx,
        ["RFPHUB_API_KEY"],
        ["--state-dir", mcpHome],
      );
      const listResponse = await readClient.request("tools/list", {}, { timeoutMs: ctx.timeoutMs });
      let searchTool;
      if (listResponse.error) {
        c.fail("tools/list succeeds", `JSON-RPC error: ${JSON.stringify(listResponse.error)}`);
      } else {
        const tools = listResponse.result?.tools ?? [];
        const names = tools.map((t) => t.name).sort();
        c.expect(
          names.length === 2 && READ_TOOLS.every((n) => names.includes(n)),
          "tools/list is exactly the two read tools without RFPHUB_API_KEY",
          names.join(", "),
          `expected exactly [${READ_TOOLS.join(", ")}], got [${names.join(", ")}]`,
        );
        checkToolDefinitions(c, tools, { label: "read-only process", readOnly: READ_TOOLS });
        searchTool = tools.find((t) => t.name === "search_opportunities");
        const leak = scanClientForLeak(readClient, listResponse);
        c.expect(
          !leak,
          "no rfph_ substring in tools/list output",
          "clean",
          leak ? `found "${leak.match}" at ${leak.path}` : "",
        );
      }

      const query = await deriveSearchQuery(ctx);
      if (!query) {
        c.unmet(
          "search_opportunities matches the API across two pages",
          `no query in the live corpus at ${ctx.api} returns more than one page, so pagination cannot be exercised — seed the deployment before signing it off`,
        );
      } else {
        const first = await checkSearchPage(c, readClient, ctx, searchTool, { ...query, page: 1 });
        const second = await checkSearchPage(c, readClient, ctx, searchTool, { ...query, page: 2 });
        if (first.ids && second.ids) {
          c.expect(
            JSON.stringify(first.ids) !== JSON.stringify(second.ids),
            "page 2 returns different ids from page 1",
            `${first.ids.length} then ${second.ids.length} item(s), different`,
            `both pages returned [${first.ids.join(", ")}] — pagination is not reaching the API`,
          );
        }
        // The whole envelopes, not just stderr: a key can leak into a `notice` or an error message,
        // which the id comparison above never reads.
        const leak = scanClientForLeak(readClient, first.response, second.response);
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
      // AFTER the child has fully exited: a shutdown path that logs configuration is exactly the
      // surface a scan taken while the process was still running would miss.
      await readClient?.close();
      const exitLeak = readClient ? scanClientForLeak(readClient) : null;
      c.expect(
        !exitLeak,
        "no rfph_ substring on any surface after the read-only process exits",
        "clean",
        exitLeak ? `found "${exitLeak.match}" at ${exitLeak.path}` : "",
      );
    }

    const mock = new RecordingServer();
    let submitClient;
    try {
      const origin = await mock.start();
      submitClient = await spawnClient(
        resolved,
        { RFPHUB_API_BASE: origin, RFPHUB_API_KEY: "rfph_test_notreal" },
        ctx,
        [],
        ["--state-dir", mcpHome],
      );

      const listResponse = await submitClient.request(
        "tools/list",
        {},
        { timeoutMs: ctx.timeoutMs },
      );
      let submitTool;
      if (listResponse.error) {
        c.fail(
          "tools/list is exactly three tools with RFPHUB_API_KEY set",
          `JSON-RPC error: ${JSON.stringify(listResponse.error)}`,
        );
      } else {
        const tools = listResponse.result?.tools ?? [];
        const names = tools.map((t) => t.name).sort();
        c.expect(
          names.length === 3 && [...READ_TOOLS, SUBMIT_TOOL].every((n) => names.includes(n)),
          "tools/list is exactly three tools with RFPHUB_API_KEY set",
          names.join(", "),
          `expected exactly [${[...READ_TOOLS, SUBMIT_TOOL].sort().join(", ")}], got [${names.join(", ")}]`,
        );
        checkToolDefinitions(c, tools, { label: "submit-enabled process", readOnly: READ_TOOLS });
        submitTool = tools.find((t) => t.name === SUBMIT_TOOL);
        // The synthetic key is itself credential-shaped, so this process's tools/list is the
        // surface most likely to leak one — into a description that interpolated config, say.
        const listLeak = scanClientForLeak(submitClient, listResponse);
        c.expect(
          !listLeak,
          "no rfph_ substring in tools/list output (submit-enabled process)",
          "clean",
          listLeak ? `found "${listLeak.match}" at ${listLeak.path}` : "",
        );
      }

      const submitResponse = await submitClient.request(
        "tools/call",
        { name: SUBMIT_TOOL, arguments: { document: fixtureDocument() } },
        { timeoutMs: ctx.timeoutMs },
      );
      if (submitResponse.error) {
        c.fail(
          "submit_opportunity phase 1 returns pending",
          `JSON-RPC error: ${JSON.stringify(submitResponse.error)}`,
        );
      } else {
        const preview = structuredPayload(
          c,
          submitResponse,
          submitTool,
          "submit_opportunity phase 1 returns valid structuredContent",
        );
        c.expect(
          preview?.status === "pending",
          'submit_opportunity phase 1 returns status: "pending"',
          JSON.stringify(preview ?? null).slice(0, 300),
          `status is not "pending": ${JSON.stringify(preview ?? submitResponse.result ?? null).slice(0, 500)}`,
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
      c.fail("MCP server starts with RFPHUB_API_KEY set", err.message);
    } finally {
      await submitClient?.close();
      const exitLeak = submitClient ? scanClientForLeak(submitClient) : null;
      c.expect(
        !exitLeak,
        "no rfph_ substring on any surface after the submit-enabled process exits",
        "clean",
        exitLeak ? `found "${exitLeak.match}" at ${exitLeak.path}` : "",
      );
      await mock.stop();
    }
  } finally {
    await rm(mcpHome, { recursive: true, force: true });
  }

  return c.finish();
}

/** The document phase 1 previews, in the `compliance` namespace so it is recognizable anywhere. */
export function fixtureDocument() {
  return {
    specVersion: "1.0.0",
    id: "compliance:mcp-submit-fixture",
    fundingType: "grant",
    title: "Compliance MCP submission fixture",
    summary:
      "A fixture submitted by scripts/check-deployment.mjs to verify the fail-closed interlock.",
    description: "Not a real funding opportunity.",
    status: "open",
    operatingOrganizations: [{ name: "compliance", slug: "compliance" }],
    ecosystems: ["Ethereum"],
    categories: ["tooling"],
    source: {},
    fundingDetails: { fundingType: "grant" },
  };
}

export const meta = {
  key: "mcp",
  requires: [],
  needs: ["api", "repoRoot"],
  contract: { m4: "M4-4" },
};

export async function run(ctx) {
  return checkMcp(ctx.report, ctx);
}
