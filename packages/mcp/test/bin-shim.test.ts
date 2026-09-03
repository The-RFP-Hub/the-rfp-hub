/**
 * Every installer's bin — npx's, npm's, pnpm's `node_modules/.bin/rfphub-mcp` — is a symlink to
 * `dist/cli.js`. Started through it the CLI must still recognise itself as the entrypoint; 0.1.0
 * did not, and exited 0 without serving a single request.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempHome } from "./helpers.js";

const CLI = path.resolve(import.meta.dirname, "../dist/cli.js");

describe("started through a bin symlink", () => {
  it("runs main, exactly as when started by its real path", () => {
    if (!fs.existsSync(CLI)) {
      throw new Error("run `pnpm --filter @the-rfp-hub/mcp build` before this suite");
    }
    // realpath: macOS's temp dir is itself a symlink, and a relative link from the unresolved path dangles.
    const bin = path.join(fs.realpathSync(tempHome()), "rfphub-mcp");
    fs.symlinkSync(path.relative(path.dirname(bin), CLI), bin);

    const viaSymlink = execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
    const viaRealPath = execFileSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });

    expect(viaRealPath.trim()).toMatch(/\d+\.\d+\.\d+/);
    expect(viaSymlink).toBe(viaRealPath);
  });
});
