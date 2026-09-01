/** The Codex review's findings, each written to fail against the code as it stood before the fix. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extraLinkSources } from "../checks/docs.mjs";
import { hasNoindexMeta, robotsBlocksAll } from "../checks/frontend.mjs";
import { unpinnedReadmeSpecs } from "../checks/mcp.mjs";
import { ACCEPTANCE_SCOPE, acceptanceReport } from "../report.mjs";

vi.mock("../../m3-compliance/client.mjs", () => ({ callJson: vi.fn() }));
const { callJson } = await import("../../m3-compliance/client.mjs");
const { verifyTornDown, waitForHumanApproval } = await import("../accept/flow.mjs");

describe("1 — an acceptance run is never an M4 sign-off", () => {
  it("reports signOff false and a scoped result even when every criterion passed", () => {
    // accept-m4 registers M4-ACCEPT criteria, not the M4 rows. Built as a bare Report, a clean
    // acceptance run emitted `signOff: true` for a milestone none of its checks looked at.
    const report = acceptanceReport({ siteUrl: "(n/a)", baseUrl: "https://api.example.org" });
    report.criterion("M4-ACCEPT", "interlock", "d").pass("held").finish();
    report.criterion("M4-ACCEPT-T", "teardown", "d").pass("gone").finish();

    expect(report.result).toBe("pass");
    expect(report.toJSON().signOff).toBe(false);
    expect(report.toJSON().scope).toBe(ACCEPTANCE_SCOPE);
    const rendered = report.render();
    expect(rendered).toContain("RESULT: SCOPED PASS");
    expect(rendered).toContain("NOT an M4 sign-off");
    expect(rendered).not.toMatch(/RESULT: PASS/);
  });
});

describe("2 — a throwing approval poll rejects rather than hanging", () => {
  it("rejects with the polling error, so the caller's finally can still tear down", async () => {
    // The rejection used to escape the interval callback unhandled — which Node's default mode
    // turns into a process crash, so nothing tore the staging fixture down.
    const state = {
      approvalConsumed: async () => {
        throw new Error("owner listing answered 500");
      },
    };
    await expect(
      waitForHumanApproval(state, {
        command: "rfphub-mcp approve abc",
        timeoutMs: 10_000,
        onPrompt: () => {},
        pollMs: 5,
      }),
    ).rejects.toThrow(/polling for the operator's approval failed: owner listing answered 500/);
  });

  it("still times out when the operator never approves", async () => {
    const state = { approvalConsumed: async () => false };
    await expect(
      waitForHumanApproval(state, {
        command: "rfphub-mcp approve abc",
        timeoutMs: 20,
        onPrompt: () => {},
        pollMs: 5,
      }),
    ).rejects.toThrow(/no approval was recorded/);
  });
});

describe("3 — teardown is not verified by an owner listing that did not answer", () => {
  const publicGone = { ok: true, status: 404 };

  it("fails when the owner listing errors, even though the public route is gone", async () => {
    // `(mine.json?.items ?? [])` made a 500 look exactly like "the entry is absent".
    callJson.mockImplementation(async (_ctx, path) =>
      path.startsWith("/v1/me/") ? { ok: true, status: 500 } : publicGone,
    );
    const result = await verifyTornDown({ writeKey: "rfph_x" }, "m4check:x");
    expect(result.ok).toBe(false);
    expect(result.ownerStatus).toContain("unverified");
  });

  it("fails when the owner listing has no items array", async () => {
    callJson.mockImplementation(async (_ctx, path) =>
      path.startsWith("/v1/me/") ? { ok: true, status: 200, json: {} } : publicGone,
    );
    expect((await verifyTornDown({ writeKey: "rfph_x" }, "m4check:x")).ok).toBe(false);
  });

  it("passes only on a 200 owner listing that no longer carries the fixture", async () => {
    callJson.mockImplementation(async (_ctx, path) =>
      path.startsWith("/v1/me/") ? { ok: true, status: 200, json: { items: [] } } : publicGone,
    );
    expect((await verifyTornDown({ writeKey: "rfph_x" }, "m4check:x")).ok).toBe(true);
  });

  it("fails when the entry is still pending for its owner", async () => {
    callJson.mockImplementation(async (_ctx, path) =>
      path.startsWith("/v1/me/")
        ? { ok: true, status: 200, json: { items: [{ id: "m4check:x", reviewStatus: "pending" }] } }
        : publicGone,
    );
    expect((await verifyTornDown({ writeKey: "rfph_x" }, "m4check:x")).ok).toBe(false);
  });
});

describe("5 — the README pin scan reads every package reference in a fence", () => {
  it("catches a moving tag on its own line in a multiline JSON config", () => {
    // The line carries neither `npx` nor `-y`, so the previous scan skipped it entirely.
    const readme = [
      "```json",
      '  "args": [',
      '    "-y",',
      '    "@the-rfp-hub/mcp@next"',
      "  ]",
      "```",
    ].join("\n");
    expect(unpinnedReadmeSpecs(readme)).toHaveLength(1);
    expect(unpinnedReadmeSpecs(readme)[0]).toContain("@next");
  });

  it("catches a bare package reference with no version at all", () => {
    const readme = [
      "```json",
      '  "args": [',
      '    "-y",',
      '    "@the-rfp-hub/mcp"',
      "  ]",
      "```",
    ].join("\n");
    expect(unpinnedReadmeSpecs(readme)).toHaveLength(1);
  });

  it("still accepts an exact version and still exempts a workspace command", () => {
    const readme = [
      "```json",
      '  "args": [',
      '    "-y",',
      '    "@the-rfp-hub/mcp@0.1.0"',
      "  ]",
      "```",
      "",
      "```sh",
      "pnpm --filter @the-rfp-hub/mcp build",
      "```",
    ].join("\n");
    expect(unpinnedReadmeSpecs(readme)).toEqual([]);
  });
});

describe("6 — robots.txt is parsed by group", () => {
  it("does not read a per-bot block as a site-wide one", () => {
    // The regex spanned groups: `user-agent: *` … `disallow: /` matched across the blank line.
    const robots = ["User-agent: *", "Allow: /", "", "User-agent: BadBot", "Disallow: /"].join(
      "\n",
    );
    expect(robotsBlocksAll(robots)).toBe(false);
  });

  it("merges repeated wildcard groups rather than using only the first", () => {
    // The standard combines groups that name the same agent; taking the first meant a later
    // `Disallow: /` under a second `User-agent: *` was never seen.
    const robots = ["User-agent: *", "Disallow: /private", "", "User-agent: *", "Disallow: /"].join(
      "\n",
    );
    expect(robotsBlocksAll(robots)).toBe(true);
  });

  it("still lets an Allow: / in a later wildcard group win the tie", () => {
    const robots = ["User-agent: *", "Disallow: /", "", "User-agent: *", "Allow: /"].join("\n");
    expect(robotsBlocksAll(robots)).toBe(false);
  });

  it("reports a real site-wide block", () => {
    expect(robotsBlocksAll("User-agent: *\nDisallow: /")).toBe(true);
  });

  it("lets Allow: / win the tie against Disallow: / in the same group", () => {
    expect(robotsBlocksAll("User-agent: *\nDisallow: /\nAllow: /")).toBe(false);
  });

  it("groups consecutive user-agent lines together", () => {
    expect(robotsBlocksAll("User-agent: Foo\nUser-agent: *\nDisallow: /")).toBe(true);
  });

  it("ignores comments and a path-scoped disallow", () => {
    expect(robotsBlocksAll("# a comment\nUser-agent: *\nDisallow: /admin")).toBe(false);
  });

  it("does not block when no group addresses every crawler", () => {
    expect(robotsBlocksAll("User-agent: BadBot\nDisallow: /")).toBe(false);
  });
});

describe("7 — the robots meta tag is read in any attribute order", () => {
  it("finds noindex when content precedes name", () => {
    expect(hasNoindexMeta('<meta content="noindex, nofollow" name="robots">')).toBe(true);
  });

  it("finds noindex in the conventional order too", () => {
    expect(hasNoindexMeta('<meta name="robots" content="noindex">')).toBe(true);
  });

  it("is not fooled by another meta tag or by an indexable page", () => {
    expect(hasNoindexMeta('<meta name="description" content="noindex is a word">')).toBe(false);
    expect(hasNoindexMeta('<meta name="robots" content="index, follow">')).toBe(false);
    expect(hasNoindexMeta("<html><head></head></html>")).toBe(false);
  });
});

describe("8 — every markdown file under skills/ is link-checked", () => {
  let repoRoot;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "m4-skills-walk-"));
    await mkdir(join(repoRoot, "skills/rfp-hub-funding-search/references"), { recursive: true });
    await writeFile(join(repoRoot, "skills/README.md"), "# skills\n");
    await writeFile(join(repoRoot, "skills/rfp-hub-funding-search/SKILL.md"), "# skill\n");
    await writeFile(
      join(repoRoot, "skills/rfp-hub-funding-search/references/api-reference.md"),
      "# reference\n",
    );
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("includes a reference document nested beside SKILL.md", () => {
    // The walk took only top-level markdown and each directory's own SKILL.md, so a broken link
    // in `references/api-reference.md` was never looked at.
    const sources = extraLinkSources(repoRoot);
    expect(sources).toContain("skills/rfp-hub-funding-search/references/api-reference.md");
    expect(sources).toContain("skills/rfp-hub-funding-search/SKILL.md");
    expect(sources).toContain("skills/README.md");
  });
});
