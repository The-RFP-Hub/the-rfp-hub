/**
 * M4-4 — the MCP server is installable and behaves. M4-4b, at the bottom of this file, is the
 * separate question of whether it is PUBLISHED: a server behaves identically whether it came from
 * npm, the Registry or a local build, so that needs its own evidence.
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
import { isLoopbackHost, request } from "../../m2-compliance/http.mjs";
import { McpStdioClient, findCredentialLeak } from "../mcp-client.mjs";
import { RecordingServer } from "../mock-server.mjs";

const execFileAsync = promisify(execFile);

/**
 * Exported for `accept/flow.mjs`: both tools drive the same binary, and resolving it twice —
 * possibly differently — would be its own bug. Throws when `--mcp-spec local` has nothing to run.
 */
export function resolveCommand(ctx, extraArgs = []) {
  // A seam, used by this checker's own tests to point the criterion at a stand-in server: the
  // assertions M4-4 makes are a different question from how the binary under test is located.
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
async function probeRegistryInstall(spec, ctx) {
  const args = ["-y", `@the-rfp-hub/mcp@${spec}`, "--version"];
  try {
    const { stdout } = await execFileAsync("npx", args, {
      cwd: ctx.repoRoot,
      timeout: Math.max(ctx.timeoutMs, 30000),
    });
    return { ok: true, detail: stdout.trim().slice(0, 200) || "resolved" };
  } catch (err) {
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

async function spawnClient(resolved, env, ctx, unset = []) {
  const client = new McpStdioClient(resolved.command, resolved.args, {
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
 * `RFPHUB_API_BASE` must be a BARE ORIGIN — https off loopback, and no path, query, fragment or
 * userinfo — or the server refuses to start. Passing `--api` through unchanged would surface that
 * as an opaque startup failure inside "tools/list succeeds"; this names it instead.
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
      // a body this checker cannot parse is the API's problem, reported by the M4-2/M4-3 rows
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

/** One report line per sub-criterion, so an omission cannot hide inside one M4-4 PASS. */
async function checkSearchPage(c, client, ctx, tool, { q, limit, page }) {
  const label = `search_opportunities q="${q}" page ${page}`;
  const response = await client.request(
    "tools/call",
    { name: "search_opportunities", arguments: { q, limit, page } },
    { timeoutMs: ctx.timeoutMs },
  );
  if (response.error) {
    c.fail(`${label} succeeds`, `JSON-RPC error: ${JSON.stringify(response.error)}`);
    return null;
  }
  const payload = structuredPayload(c, response, tool, `${label} returns valid structuredContent`);
  if (!payload) return null;

  const api = await apiPage(ctx, { q, limit, page });
  if (!api) {
    c.fail(`${label} matches GET /v1/opportunities`, "could not fetch the comparison page");
    return null;
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
  return mcpIds;
}

export async function checkMcp(report, ctx) {
  const local = ctx.mcpSpec === "local";
  const c = report.criterion(
    "M4-4",
    local ? "MCP server callable from a local build" : "MCP server installable and callable",
    local
      ? "--mcp-spec local: exercises packages/mcp/dist/cli.js directly. NOT evidence the package is published — see M4-4b. Exactly two tools without the submit env and three with it, each with an outputSchema and boolean annotations; search returns structuredContent that validates against its own schema and matches the API page for page; no rfph_ substring leaks anywhere, including after the process exits; phase 1 returns pending and performs no network write."
      : "npx resolves @the-rfp-hub/mcp from the real npm registry and its CLI runs; exactly two tools without the submit env and three with it, each with an outputSchema and boolean annotations; search returns structuredContent that validates against its own schema and matches the API page for page; no rfph_ substring leaks anywhere, including after the process exits; phase 1 returns pending and performs no network write.",
  );

  if (ctx.skip.has("mcp")) {
    c.skip("mcp", "--skip mcp");
    c.finish();
    return checkMcpPublication(report, ctx);
  }

  let resolved;
  try {
    resolved = resolveCommand(ctx);
  } catch (err) {
    c.fail("resolve the MCP server under test", err.message);
    c.finish();
    return checkMcpPublication(report, ctx);
  }
  c.info("MCP server under test", resolved.describe);

  const apiBase = mcpApiBase(ctx.api);
  if (apiBase.refusedByServer) {
    c.fail(
      "the API base is one the MCP server will accept",
      `${ctx.api} is plaintext and not loopback; the server requires https off loopback and would refuse to start`,
    );
    c.finish();
    return checkMcpPublication(report, ctx);
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
      c.skip(
        "tools/list, search matching, and the submit interlock",
        "the package did not resolve from the registry (see the check above)",
      );
      c.finish();
      return checkMcpPublication(report, ctx);
    }
  }

  // A real server appends an audit line under `RFPHUB_MCP_HOME` for every tool call, and the
  // preview below would land in `~/.rfphub/pending/` indistinguishable from a real one.
  const mcpHome = await mkdtemp(join(tmpdir(), "m4-check-mcp-home-"));
  try {
    let readClient;
    try {
      readClient = await spawnClient(
        resolved,
        { RFPHUB_API_BASE: apiBase.origin, RFPHUB_MCP_HOME: mcpHome },
        ctx,
        ["RFPHUB_API_KEY", "RFPHUB_MCP_ENABLE_SUBMIT"],
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
          "tools/list is exactly the two read tools without RFPHUB_MCP_ENABLE_SUBMIT",
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
          `no query in the live corpus at ${ctx.api} returns more than one page, so pagination cannot be exercised — seed the deployment before signing M4 off`,
        );
      } else {
        const first = await checkSearchPage(c, readClient, ctx, searchTool, { ...query, page: 1 });
        const second = await checkSearchPage(c, readClient, ctx, searchTool, { ...query, page: 2 });
        if (first && second) {
          c.expect(
            JSON.stringify(first) !== JSON.stringify(second),
            "page 2 returns different ids from page 1",
            `${first.length} then ${second.length} item(s), different`,
            `both pages returned [${first.join(", ")}] — pagination is not reaching the API`,
          );
        }
        const leak = scanClientForLeak(readClient);
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
      let submitTool;
      if (listResponse.error) {
        c.fail(
          "tools/list is exactly three tools with RFPHUB_MCP_ENABLE_SUBMIT=1",
          `JSON-RPC error: ${JSON.stringify(listResponse.error)}`,
        );
      } else {
        const tools = listResponse.result?.tools ?? [];
        const names = tools.map((t) => t.name).sort();
        c.expect(
          names.length === 3 && [...READ_TOOLS, SUBMIT_TOOL].every((n) => names.includes(n)),
          "tools/list is exactly three tools with RFPHUB_MCP_ENABLE_SUBMIT=1",
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
      c.fail("MCP server starts with RFPHUB_MCP_ENABLE_SUBMIT=1", err.message);
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

  c.finish();
  return checkMcpPublication(report, ctx);
}

/** The document phase 1 previews, in the `m4check` namespace so it is recognizable anywhere. */
export function fixtureDocument() {
  return {
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
}

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0";
const PACKAGE_NAME = "@the-rfp-hub/mcp";
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

async function npmView(fields, spec, ctx) {
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["view", `${PACKAGE_NAME}@${spec}`, ...fields, "--json"],
      {
        cwd: ctx.repoRoot,
        timeout: Math.max(ctx.timeoutMs, 30000),
      },
    );
    return { ok: true, value: stdout.trim() ? JSON.parse(stdout) : undefined };
  } catch (err) {
    const stderr = (err.stderr ?? "").toString().trim();
    return { ok: false, detail: (stderr || err.message).slice(0, 500) };
  }
}

/**
 * Every snippet a reader copies must pin an exact version: a moving tag turns "the description
 * digest binds this build" into a promise about a build nobody has seen. Only `npx`/`-y` lines are
 * examined — `pnpm --filter @the-rfp-hub/mcp build` names a workspace package, not an install.
 */
export function unpinnedReadmeSpecs(readme) {
  const offenders = [];
  for (const block of readme.split(/^```/m).filter((_, i) => i % 2 === 1)) {
    for (const line of block.split("\n")) {
      if (line.includes("--filter") || !/npx|"-y"|'-y'/.test(line)) continue;
      for (const match of line.matchAll(/@the-rfp-hub\/mcp(@[^"'\s\],]*)?/g)) {
        const version = match[1]?.slice(1);
        if (!version || !EXACT_VERSION.test(version)) {
          offenders.push(`${match[0]} — ${line.trim().slice(0, 110)}`);
        }
      }
    }
  }
  return offenders;
}

/** M4-4b — the release channel. It FAILS while unpublished; that is correct, not a gap. */
export async function checkMcpPublication(report, ctx) {
  const c = report.criterion(
    "M4-4b",
    "MCP server published to npm and the official Registry",
    `npm resolves an exact ${PACKAGE_NAME} version whose published mcpName matches the manifest, the official MCP Registry carries that server at that version with the same npm package identifier, and every configuration snippet in packages/mcp/README.md pins an exact version.`,
  );

  if (ctx.skip.has("mcp")) {
    c.skip("mcp", "--skip mcp");
    return c.finish();
  }

  const readmePath = join(ctx.repoRoot, "packages/mcp/README.md");
  if (!existsSync(readmePath)) {
    c.fail(
      "packages/mcp/README.md pins an exact version in every configuration snippet",
      `not found at ${readmePath} — the documented install path cannot be checked`,
    );
  } else {
    const offenders = unpinnedReadmeSpecs(readFileSync(readmePath, "utf8"));
    c.expect(
      offenders.length === 0,
      "packages/mcp/README.md pins an exact version in every configuration snippet",
      "every npx snippet names an exact version",
      `unpinned or moving spec(s): ${offenders.join(" | ")}`,
    );
  }

  const expectedName = declaredMcpName(ctx.repoRoot);
  if (!expectedName) {
    c.fail(
      "packages/mcp declares an mcpName",
      "neither packages/mcp/package.json's mcpName nor packages/mcp/server.json's name is readable in this checkout",
    );
  }

  if (ctx.mcpSpec === "local") {
    c.unmet(
      "npm and the official MCP Registry carry this server",
      "--mcp-spec local: a local build is not evidence of publication, so this criterion cannot be established from this run",
    );
    return c.finish();
  }

  const spec = ctx.mcpSpec ?? "next";
  const resolvedVersion = await npmView(["version"], spec, ctx);
  if (!resolvedVersion.ok || typeof resolvedVersion.value !== "string") {
    c.fail(
      `npm resolves ${PACKAGE_NAME}@${spec} to an exact version`,
      resolvedVersion.detail ?? `npm view returned ${JSON.stringify(resolvedVersion.value)}`,
    );
    return c.finish();
  }
  const version = resolvedVersion.value;
  c.pass(`npm resolves ${PACKAGE_NAME}@${spec} to an exact version`, version);

  const published = await npmView(["mcpName"], version, ctx);
  c.expect(
    published.ok && published.value === expectedName,
    `the published ${PACKAGE_NAME}@${version} carries mcpName "${expectedName}"`,
    `mcpName=${published.value}`,
    published.ok
      ? `published mcpName is ${JSON.stringify(published.value)}, the manifest declares ${JSON.stringify(expectedName)}`
      : (published.detail ?? "npm view failed"),
  );

  const url = `${REGISTRY_BASE}/servers/${encodeURIComponent(expectedName ?? "")}/versions/${encodeURIComponent(version)}`;
  const res = await request(url, { timeoutMs: ctx.timeoutMs, follow: true });
  if (!res.ok || res.status !== 200) {
    c.fail(
      `the official MCP Registry carries ${expectedName}@${version}`,
      res.ok ? `${url} — HTTP ${res.status}` : `transport: ${res.error}`,
    );
    return c.finish();
  }
  let entry;
  try {
    entry = JSON.parse(res.body)?.server;
  } catch (err) {
    c.fail(
      `the official MCP Registry carries ${expectedName}@${version}`,
      `${url} — ${err.message}`,
    );
    return c.finish();
  }
  c.expect(
    entry?.name === expectedName && entry?.version === version,
    `the official MCP Registry carries ${expectedName}@${version}`,
    `${entry?.name}@${entry?.version}`,
    `${url} answered with ${JSON.stringify(entry?.name)}@${JSON.stringify(entry?.version)}`,
  );
  const npmPackage = (entry?.packages ?? []).find((p) => p.identifier === PACKAGE_NAME);
  c.expect(
    npmPackage?.version === version,
    `the Registry entry names ${PACKAGE_NAME}@${version} as its npm package`,
    `identifier=${npmPackage?.identifier}, version=${npmPackage?.version}`,
    npmPackage
      ? `the Registry entry names ${PACKAGE_NAME}@${npmPackage.version}, not @${version}`
      : `no packages[] entry with identifier ${PACKAGE_NAME}`,
  );

  return c.finish();
}

/** The mcpName the repository declares — `package.json`'s field, or `server.json`'s own name. */
function declaredMcpName(repoRoot) {
  for (const [relPath, field] of [
    ["packages/mcp/package.json", "mcpName"],
    ["packages/mcp/server.json", "name"],
  ]) {
    try {
      const value = JSON.parse(readFileSync(join(repoRoot, relPath), "utf8"))[field];
      if (typeof value === "string" && value) return value;
    } catch {
      // try the next candidate; the call site reports the failure by name
    }
  }
  return undefined;
}
