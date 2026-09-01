/**
 * `resolveCommand` — registry by default, local only as an explicit opt-out (an earlier revision
 * silently preferred a local build, so "installable" could PASS without npm being involved), and
 * the local path's symlink canonicalization: `cli.ts` compares `fileURLToPath(import.meta.url)`
 * (symlinks resolved) against `path.resolve(process.argv[1])` (not resolved), so a `--repo-root`
 * through a symlink made the CLI silently do nothing and exit 0.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCommand } from "../checks/mcp.mjs";

let base;
let realDir;
let linkedDir;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "m4-check-resolve-command-"));
  realDir = join(base, "real-repo");
  await mkdir(join(realDir, "packages/mcp/dist"), { recursive: true });
  await writeFile(join(realDir, "packages/mcp/dist/cli.js"), "// placeholder\n");
  linkedDir = join(base, "linked-repo");
  await symlink(realDir, linkedDir);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("resolveCommand — default is the npm registry, not a local build", () => {
  it("defaults to npx @the-rfp-hub/mcp@next when no --mcp-spec is given", () => {
    const resolved = resolveCommand({ repoRoot: realDir });
    expect(resolved.command).toBe("npx");
    expect(resolved.spec).toBe("next");
    expect(resolved.local).toBe(false);
    expect(resolved.args).toEqual(["-y", "@the-rfp-hub/mcp@next"]);
  });

  it("does NOT silently prefer a local build even when one exists on disk", () => {
    // The exact regression: realDir has a real packages/mcp/dist/cli.js, and an earlier revision
    // of resolveCommand would have picked it automatically here.
    const resolved = resolveCommand({ repoRoot: realDir });
    expect(resolved.command).toBe("npx");
  });

  it("uses an explicit --mcp-spec version for npx", () => {
    const resolved = resolveCommand({ repoRoot: realDir, mcpSpec: "0.1.0" });
    expect(resolved.command).toBe("npx");
    expect(resolved.spec).toBe("0.1.0");
    expect(resolved.args).toEqual(["-y", "@the-rfp-hub/mcp@0.1.0"]);
  });

  it("appends extraArgs after the npm spec", () => {
    const resolved = resolveCommand({ repoRoot: realDir }, ["approve", "abc123"]);
    expect(resolved.args).toEqual(["-y", "@the-rfp-hub/mcp@next", "approve", "abc123"]);
  });
});

describe("resolveCommand — --mcp-spec local (explicit opt-out)", () => {
  it("resolves through a symlinked repoRoot to the canonical path", async () => {
    const resolved = resolveCommand({ repoRoot: linkedDir, mcpSpec: "local" });
    expect(resolved.command).toBe("node");
    expect(resolved.local).toBe(true);
    const canonical = await realpath(join(realDir, "packages/mcp/dist/cli.js"));
    expect(resolved.args[0]).toBe(canonical);
    // The bug this guards against: the symlinked path is absolute too, so a naive "is it
    // absolute" check would miss that it is not the SAME string the real cli.ts will see itself
    // invoked with.
    expect(resolved.args[0]).not.toBe(join(linkedDir, "packages/mcp/dist/cli.js"));
  });

  it("still returns the canonical path when repoRoot has no symlink in it", async () => {
    const resolved = resolveCommand({ repoRoot: realDir, mcpSpec: "local" });
    const canonical = await realpath(join(realDir, "packages/mcp/dist/cli.js"));
    expect(resolved.args[0]).toBe(canonical);
  });

  it("appends extraArgs after the resolved path", () => {
    const resolved = resolveCommand({ repoRoot: linkedDir, mcpSpec: "local" }, [
      "approve",
      "abc123",
    ]);
    expect(resolved.args.slice(1)).toEqual(["approve", "abc123"]);
  });

  it("throws a clear error, naming the missing build, rather than crashing opaquely", async () => {
    const empty = await mkdtemp(join(tmpdir(), "m4-check-resolve-command-empty-"));
    try {
      expect(() => resolveCommand({ repoRoot: empty, mcpSpec: "local" })).toThrow(
        /packages\/mcp\/dist\/cli\.js not found/,
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
