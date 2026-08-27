/**
 * `resolveCommand`'s local-build path must return the REAL path to `dist/cli.js`, not merely an
 * absolute one — found by actually spawning a real built `packages/mcp` under a `--repo-root`
 * through a symlink (macOS's `/tmp` → `/private/tmp`, exactly what `os.tmpdir()` gives every
 * `mkdtemp`-based fixture, including this checker's own).
 *
 * The real `packages/mcp/src/cli.ts` decides whether to run at all with:
 *   `fileURLToPath(import.meta.url) === path.resolve(process.argv[1])`
 * Node resolves `import.meta.url` through any symlink when it loads the module; `path.resolve`
 * does not touch symlinks at all. Pass a path that still has a symlink component and the two
 * disagree, the CLI silently does nothing, and the process exits 0 with no output whatsoever —
 * indistinguishable from "hung" until this checker's own timeout. This test doesn't need a real
 * MCP build: any file will do, since the property under test is purely "did resolveCommand hand
 * back the canonical path".
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

describe("resolveCommand — local build path", () => {
  it("resolves through a symlinked repoRoot to the canonical path", async () => {
    const resolved = resolveCommand({ repoRoot: linkedDir });
    expect(resolved.command).toBe("node");
    const canonical = await realpath(join(realDir, "packages/mcp/dist/cli.js"));
    expect(resolved.args[0]).toBe(canonical);
    // The bug this guards against: the symlinked path is absolute too, so a naive "is it
    // absolute" check would miss that it is not the SAME string the real cli.ts will see itself
    // invoked with.
    expect(resolved.args[0]).not.toBe(join(linkedDir, "packages/mcp/dist/cli.js"));
  });

  it("still returns the canonical path when repoRoot has no symlink in it", async () => {
    const resolved = resolveCommand({ repoRoot: realDir });
    const canonical = await realpath(join(realDir, "packages/mcp/dist/cli.js"));
    expect(resolved.args[0]).toBe(canonical);
  });

  it("appends extraArgs after the resolved path", () => {
    const resolved = resolveCommand({ repoRoot: linkedDir }, ["approve", "abc123"]);
    expect(resolved.args.slice(1)).toEqual(["approve", "abc123"]);
  });
});
