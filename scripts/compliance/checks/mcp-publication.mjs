/**
 * The release channel: whether the MCP server is PUBLISHED, which is a separate question from
 * whether it behaves. `checks/mcp.mjs` answers the second one — a server behaves identically
 * whether it came from npm, the Registry or a local build, so publication needs its own evidence
 * and its own criterion. It FAILS while unpublished; that is correct, not a gap.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { request } from "../http.mjs";

const execFileAsync = promisify(execFile);

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
 * digest binds this build" into a promise about a build nobody has seen.
 *
 * EVERY package reference inside a fence counts, not only lines that also say `npx`/`-y`: a JSON
 * config spreads `"args": [` over several lines, leaving `"@the-rfp-hub/mcp@next"` alone on one of
 * them. The one exemption is `--filter`, which names a workspace package, not an install.
 */
export function unpinnedReadmeSpecs(readme) {
  const offenders = [];
  for (const block of readme.split(/^```/m).filter((_, i) => i % 2 === 1)) {
    for (const line of block.split("\n")) {
      if (line.includes("--filter")) continue;
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

export async function checkMcpPublication(report, ctx) {
  const c = report.criterion(
    "mcp-publication",
    "MCP server published to npm and the official Registry",
    `npm resolves an exact ${PACKAGE_NAME} version whose published mcpName matches the manifest, the official MCP Registry carries that server at that version with the same npm package identifier, and every configuration snippet in packages/mcp/README.md pins an exact version.`,
  );

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

export const meta = {
  key: "mcp-publication",
  requires: [],
  needs: ["repoRoot"],
  contract: { m4: "M4-4b" },
};

export async function run(ctx) {
  return checkMcpPublication(ctx.report, ctx);
}
