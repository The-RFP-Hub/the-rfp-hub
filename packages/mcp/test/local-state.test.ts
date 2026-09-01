/**
 * The local state directory is a security boundary, so it is checked rather than assumed.
 *
 * The properties that matter: the home is a real directory this user owns at 0700, every file in
 * it is a regular 0600 file, and neither is reached through a symlink. Where those cannot be
 * established, approvals and counters REFUSE, and the audit log declines to write.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PENDING_TTL_MS, readPending, writePending } from "../src/approvals.js";
import { AUDIT_MAX_BYTES, appendAudit, auditPath, rotatedAuditPath } from "../src/audit.js";
import { Policy, counterPath } from "../src/policy.js";
import { InsecureStateError, ensureDir, secureFile } from "../src/state.js";
import { tempHome, validDocument } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const NOW = new Date("2026-06-01T12:00:00Z");
const ID = "a".repeat(64);

function mode(target: string): string {
  return (fs.lstatSync(target).mode & 0o777).toString(8);
}

function pendingRecord() {
  return {
    apiOrigin: "https://api.example.test",
    keyFingerprint: "abcd1234",
    operation: "submit_opportunity" as const,
    protocolVersion: "2026-07-28",
    documentHash: "b".repeat(64),
    approvalId: ID,
    document: validDocument(),
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + PENDING_TTL_MS).toISOString(),
  };
}

const entry = {
  at: NOW.toISOString(),
  tool: "search_opportunities",
  kind: "read" as const,
  status: "ok",
  inputSummary: { keys: [], bytes: 2 },
  durationMs: 1,
};

describe("a pre-existing path is brought to the documented mode", () => {
  it("tightens a world-writable home to 0700", () => {
    const home = tempHome();
    fs.chmodSync(home, 0o777);
    ensureDir(home);
    expect(mode(home)).toBe("700");
  });

  it("tightens a world-readable counter file, approval file and audit log to 0600", () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, "pending"), { recursive: true });
    fs.writeFileSync(counterPath(home), '{"minute":{},"day":{}}', { mode: 0o666 });
    fs.chmodSync(counterPath(home), 0o666);
    fs.writeFileSync(auditPath(home), "", { mode: 0o666 });
    fs.chmodSync(auditPath(home), 0o666);
    const record = path.join(home, "pending", `${ID}.json`);
    fs.writeFileSync(record, "{}", { mode: 0o666 });
    fs.chmodSync(record, 0o666);

    new Policy(home, { now: () => NOW }).consume("read");
    appendAudit(home, entry);
    writePending(home, pendingRecord());

    expect(mode(counterPath(home))).toBe("600");
    expect(mode(auditPath(home))).toBe("600");
    expect(mode(record)).toBe("600");
    expect(fs.readFileSync(auditPath(home), "utf8")).toContain('"status":"ok"');
  });
});

describe("a path that is not what it claims to be is refused", () => {
  it("refuses a home that is a symlink, without using its target", () => {
    const target = tempHome();
    const link = path.join(os.tmpdir(), `rfphub-mcp-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(target, link);
    try {
      expect(() => ensureDir(link)).toThrow(InsecureStateError);
      expect(() => ensureDir(link)).toThrow(/symbolic link/);
      expect(() => new Policy(link, { now: () => NOW }).consume("read")).toThrow(/symbolic link/);
    } finally {
      fs.unlinkSync(link);
    }
  });

  it("refuses a dangling symlink where the home belongs", () => {
    const link = path.join(os.tmpdir(), `rfphub-mcp-dangling-${process.pid}-${Date.now()}`);
    fs.symlinkSync(path.join(os.tmpdir(), "rfphub-mcp-nothing-here"), link);
    try {
      expect(() => ensureDir(link)).toThrow(/symbolic link/);
    } finally {
      fs.unlinkSync(link);
    }
  });

  it("refuses a regular file where the home belongs", () => {
    const file = path.join(tempHome(), "home");
    fs.writeFileSync(file, "");
    expect(() => ensureDir(file)).toThrow(/is not a directory/);
  });

  it("refuses a state file that is a symlink or a second hard link", () => {
    const home = tempHome();
    const elsewhere = path.join(home, "elsewhere");
    fs.writeFileSync(elsewhere, "{}", { mode: 0o600 });

    const link = path.join(home, "linked.json");
    fs.symlinkSync(elsewhere, link);
    expect(() => secureFile(link)).toThrow(/symbolic link/);

    const hard = path.join(home, "hard.json");
    fs.linkSync(elsewhere, hard);
    expect(() => secureFile(hard)).toThrow(/more than one hard link/);
  });

  it("does not read an approval record through a symlink", () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, "pending"), { recursive: true });
    const decoy = path.join(home, "decoy.json");
    fs.writeFileSync(decoy, JSON.stringify({ ...pendingRecord(), apiOrigin: "https://evil.test" }));
    fs.symlinkSync(decoy, path.join(home, "pending", `${ID}.json`));
    expect(readPending(home, ID)).toBeNull();
  });
});

describe("a mode that cannot be established fails closed", () => {
  it("refuses when chmod does not take", () => {
    const home = tempHome();
    fs.chmodSync(home, 0o777);
    vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw new Error("EPERM: operation not permitted");
    });
    expect(() => ensureDir(home)).toThrow(InsecureStateError);
    expect(() => ensureDir(home)).toThrow(/could not be changed/);
  });

  it("refuses when a chmod reports success but the mode does not change", () => {
    const home = tempHome();
    fs.chmodSync(home, 0o777);
    vi.spyOn(fs, "chmodSync").mockImplementation(() => {});
    expect(() => ensureDir(home)).toThrow(/stayed at mode/);
  });

  it("refuses a home under a directory it cannot create in", () => {
    if (process.getuid?.() === 0) return; // root ignores the mode, so there is nothing to prove.
    const parent = tempHome();
    fs.chmodSync(parent, 0o500);
    try {
      expect(() => ensureDir(path.join(parent, "state"))).toThrow();
    } finally {
      fs.chmodSync(parent, 0o700);
    }
  });
});

describe("the audit log stays non-fatal, but does not write where it cannot", () => {
  it("declines to append through a symlink, and leaves the target untouched", () => {
    const home = tempHome();
    const target = path.join(home, "somebody-elses-file");
    fs.writeFileSync(target, "original\n");
    fs.symlinkSync(target, auditPath(home));

    expect(() => appendAudit(home, entry)).not.toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("original\n");
  });

  it("swallows a home that cannot be created at all", () => {
    if (process.getuid?.() === 0) return;
    const parent = tempHome();
    fs.chmodSync(parent, 0o500);
    try {
      expect(() => appendAudit(path.join(parent, "state"), entry)).not.toThrow();
    } finally {
      fs.chmodSync(parent, 0o700);
    }
  });
});

describe("the audit log is bounded", () => {
  it("rotates at the cap, keeps exactly one generation, and keeps both at 0600", () => {
    const home = tempHome();
    ensureDir(home);
    fs.writeFileSync(auditPath(home), "x".repeat(AUDIT_MAX_BYTES), { mode: 0o600 });

    appendAudit(home, entry);

    expect(fs.statSync(rotatedAuditPath(home)).size).toBe(AUDIT_MAX_BYTES);
    expect(mode(rotatedAuditPath(home))).toBe("600");
    expect(mode(auditPath(home))).toBe("600");
    const live = fs.readFileSync(auditPath(home), "utf8");
    expect(live.trim().split("\n")).toHaveLength(1);
    expect(live).toContain('"tool":"search_opportunities"');

    // A second rotation replaces the previous generation rather than accumulating.
    fs.writeFileSync(auditPath(home), "y".repeat(AUDIT_MAX_BYTES), { mode: 0o600 });
    appendAudit(home, entry);
    expect(fs.readFileSync(rotatedAuditPath(home), "utf8").startsWith("y")).toBe(true);
    expect(fs.existsSync(`${rotatedAuditPath(home)}.1`)).toBe(false);
  });

  it("keeps the line even when the rotation itself fails", () => {
    const home = tempHome();
    ensureDir(home);
    fs.writeFileSync(auditPath(home), "x".repeat(AUDIT_MAX_BYTES), { mode: 0o600 });
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EXDEV: cross-device link not permitted");
    });

    expect(() => appendAudit(home, entry)).not.toThrow();
    expect(fs.readFileSync(auditPath(home), "utf8")).toContain('"tool":"search_opportunities"');
  });

  it("leaves a log under the cap alone", () => {
    const home = tempHome();
    ensureDir(home);
    fs.writeFileSync(auditPath(home), "x".repeat(1_000), { mode: 0o600 });
    appendAudit(home, entry);
    expect(fs.existsSync(rotatedAuditPath(home))).toBe(false);
  });
});
