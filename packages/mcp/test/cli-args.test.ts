/**
 * The command line itself: `--state-dir` is the only flag, and it has to work in every mode,
 * because the server writes a preview into that directory and `approve` reads it back out. A flag
 * that the server honored and `approve` ignored would send a person looking at an empty `~/.rfphub`
 * while a real preview waits somewhere else.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { documentHashOf, writePending } from "../src/approvals.js";
import { main } from "../src/cli.js";
import { tempHome, validDocument } from "./helpers.js";

const CLI = path.resolve(import.meta.dirname, "../dist/cli.js");

function run(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { status: number; stdout: string; stderr: string } {
  if (!fs.existsSync(CLI)) {
    throw new Error("run `pnpm --filter @the-rfp-hub/mcp build` before this suite");
  }
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout?: string; stderr?: string };
    return { status: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** A preview in `home`, so `pending` has something to print an `approve` line for. */
function seedPending(home: string, id: string): void {
  writePending(home, {
    apiOrigin: "https://api.example.test",
    keyFingerprint: "none",
    operation: "submit_opportunity",
    protocolVersion: "2026-07-28",
    documentHash: documentHashOf(validDocument()),
    approvalId: id,
    document: validDocument(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
}

describe("--help", () => {
  it("documents the flag and the two variables, and nothing that was removed", () => {
    const { status, stdout } = run(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("--state-dir <dir>");
    expect(stdout).toContain("RFPHUB_API_BASE");
    expect(stdout).toContain("RFPHUB_API_KEY");
    expect(stdout).not.toMatch(/RFPHUB_MCP_[A-Z_]+/);
  });

  it("is reachable with the flag in front of it", () => {
    expect(run(["--state-dir", tempHome(), "--help"]).status).toBe(0);
  });
});

describe("--state-dir", () => {
  it("points `pending` at that directory, in either spelling", () => {
    const home = tempHome();
    for (const args of [
      ["--state-dir", home, "pending"],
      [`--state-dir=${home}`, "pending"],
    ]) {
      const { status, stdout } = run(args);
      expect(status).toBe(0);
      expect(stdout).toContain(path.join(home, "pending"));
    }
  });

  it("is accepted after the mode as well as before it", () => {
    const home = tempHome();
    const { status, stdout } = run(["pending", "--state-dir", home]);
    expect(status).toBe(0);
    expect(stdout).toContain(path.join(home, "pending"));
  });

  it("lists with HOME unset, so nothing on the path needs one", () => {
    const home = tempHome();
    const { HOME: _h, USERPROFILE: _u, ...rest } = process.env;
    const { status, stdout } = run(["pending", "--state-dir", home], rest);
    expect(status).toBe(0);
    expect(stdout).toContain(path.join(home, "pending"));
  });

  // HOME unset is not the hard case: `os.homedir()` still answers from the passwd entry. The hard
  // case is a container UID with no entry at all, where it THROWS — exactly the case this flag
  // exists for. Driven in-process, because a subprocess cannot be given a broken `homedir`.
  it("lists without resolving the default at all, even when os.homedir() throws", async () => {
    const home = tempHome();
    const id = "d".repeat(64);
    seedPending(home, id);
    const spy = vi.spyOn(os, "homedir").mockImplementation(() => {
      throw new Error("uv_os_homedir returned ENOENT");
    });
    let printed = "";
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        printed += String(chunk);
        return true;
      });
    try {
      await expect(main(["pending", "--state-dir", home])).resolves.toBe(0);
    } finally {
      write.mockRestore();
      spy.mockRestore();
    }
    expect(printed).toContain(`rfphub-mcp --state-dir ${home} approve ${id}`);
  });

  it("makes the copy-paste hint carry the directory it listed", () => {
    const home = tempHome();
    const id = "a".repeat(64);
    seedPending(home, id);
    expect(run(["pending", "--state-dir", home]).stdout).toContain(
      `rfphub-mcp --state-dir ${home} approve ${id}`,
    );
  });

  it("shell-quotes a directory a paste would otherwise break on", () => {
    const parent = tempHome();
    const home = path.join(parent, "my $state dir");
    const id = "b".repeat(64);
    seedPending(home, id);
    // Single-quoted, so the space does not split the argument and `$state` is not expanded.
    expect(run(["pending", "--state-dir", home]).stdout).toContain(
      `rfphub-mcp --state-dir '${home}' approve ${id}`,
    );
  });

  it("closes, escapes and reopens the quoting around a single quote in the path", () => {
    const parent = tempHome();
    const home = path.join(parent, "it's here");
    const id = "c".repeat(64);
    seedPending(home, id);
    const quoted = `'${home.replaceAll("'", "'\\''")}'`;
    expect(run(["pending", "--state-dir", home]).stdout).toContain(
      `rfphub-mcp --state-dir ${quoted} approve ${id}`,
    );
  });

  it("refuses a flag with no directory after it, and writes nothing to stdout", () => {
    const { status, stdout, stderr } = run(["--state-dir"]);
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("--state-dir needs a directory");
  });

  it("refuses a flag followed by another flag", () => {
    const { status, stderr } = run(["--state-dir", "--help"]);
    expect(status).toBe(2);
    expect(stderr).toContain("--state-dir needs a directory");
  });

  it("still reports an unknown command as one", () => {
    const { status, stderr } = run(["--state-dir", tempHome(), "frobnicate"]);
    expect(status).toBe(2);
    expect(stderr).toContain("unknown command: frobnicate");
  });
});
