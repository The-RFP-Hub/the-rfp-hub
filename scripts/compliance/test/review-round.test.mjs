/** One review round's findings, each written to fail against the code as it stood before the fix. */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extraLinkSources } from "../checks/docs.mjs";
import { governanceCheckName } from "../checks/governance.mjs";
import { unpinnedReadmeSpecs } from "../checks/mcp-publication.mjs";
import { ACCEPTANCE_SCOPE, acceptanceReport } from "../report.mjs";

vi.mock("../client.mjs", () => ({ callJson: vi.fn() }));
vi.mock("../http.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  request: vi.fn(),
}));
const { callJson } = await import("../client.mjs");
const { request } = await import("../http.mjs");
const { TARGET_SELECTOR, deriveFilterValues, hasNoindexMeta, robotsBlocksAll } = await import(
  "../checks/frontend.mjs"
);
const { verifyTornDown, waitForHumanApproval } = await import("../accept/flow.mjs");

describe("1 — an acceptance run is never a deployment sign-off", () => {
  it("reports signOff false and a scoped result even when every criterion passed", () => {
    // A write run registers acceptance criteria, not milestone rows. Built as a bare Report, a
    // clean acceptance run emitted `signOff: true` for a milestone none of its checks looked at.
    const report = acceptanceReport({ siteUrl: "(n/a)", baseUrl: "https://api.example.org" });
    report.criterion("write-cycle", "interlock", "d").pass("held").finish();
    report.criterion("teardown", "teardown", "d").pass("gone").finish();

    expect(report.result).toBe("pass");
    expect(report.toJSON().signOff).toBe(false);
    expect(report.toJSON().scope).toBe(ACCEPTANCE_SCOPE);
    const rendered = report.render();
    expect(rendered).toContain("RESULT: SCOPED PASS");
    expect(rendered).toContain("NOT a deployment sign-off");
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
    const result = await verifyTornDown({ writeKey: "rfph_x" }, "compliance:x");
    expect(result.ok).toBe(false);
    expect(result.ownerStatus).toContain("unverified");
  });

  it("fails when the owner listing has no items array", async () => {
    callJson.mockImplementation(async (_ctx, path) =>
      path.startsWith("/v1/me/") ? { ok: true, status: 200, json: {} } : publicGone,
    );
    expect((await verifyTornDown({ writeKey: "rfph_x" }, "compliance:x")).ok).toBe(false);
  });

  it("passes only on a 200 owner listing that no longer carries the fixture", async () => {
    callJson.mockImplementation(async (_ctx, path) =>
      path.startsWith("/v1/me/") ? { ok: true, status: 200, json: { items: [] } } : publicGone,
    );
    expect((await verifyTornDown({ writeKey: "rfph_x" }, "compliance:x")).ok).toBe(true);
  });

  it("fails when the entry is still pending for its owner", async () => {
    callJson.mockImplementation(async (_ctx, path) =>
      path.startsWith("/v1/me/")
        ? {
            ok: true,
            status: 200,
            json: { items: [{ id: "compliance:x", reviewStatus: "pending" }] },
          }
        : publicGone,
    );
    expect((await verifyTornDown({ writeKey: "rfph_x" }, "compliance:x")).ok).toBe(false);
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

describe("staging validation — the home page is held to one link, not four", () => {
  it("names the two pages' different requirements", () => {
    // The home deliberately carries GOVERNANCE + REVIEW-CRITERIA in its own content, not all
    // four; requiring four there failed on correct behavior.
    expect(governanceCheckName({ label: "home", requireAll: false })).toBe(
      "home links to a governance document outside the footer",
    );
    expect(governanceCheckName({ label: "/how-it-works", requireAll: true })).toBe(
      "/how-it-works links to all four governance documents",
    );
  });
});

describe("staging validation — a filter value has to change the FIRST PAGE", () => {
  const OPEN_TOTAL = 142;
  const BASELINE = ["a", "b", "c"];
  // Staging's exact shape. `Ethereum` is the dominant ecosystem: its total DIFFERS from the
  // unfiltered one (115 of 142) and its first page does not, so a total-based discriminator still
  // picked it and the UI assertion failed on correct behavior. `Nowhere` matches nothing.
  const PAGES = {
    Ethereum: { ids: BASELINE, total: 115 },
    Optimism: { ids: ["c", "d"], total: 40 },
    Nowhere: { ids: [], total: 0 },
    grant: { ids: BASELINE, total: 120 },
    bounty: { ids: ["z"], total: 12 },
  };

  function mockCorpus() {
    request.mockImplementation(async (url) => {
      const params = new URL(url).searchParams;
      const key = params.get("ecosystem") ?? params.get("fundingType");
      const page =
        key === null ? { ids: BASELINE, total: OPEN_TOTAL } : (PAGES[key] ?? { ids: [], total: 0 });
      const items =
        key === null && params.get("limit") === "100"
          ? [
              { id: "a", fundingType: "grant", ecosystems: ["Ethereum", "Optimism"] },
              { id: "b", fundingType: "bounty", ecosystems: ["Nowhere"] },
            ]
          : page.ids.map((id) => ({ id, fundingType: "grant", ecosystems: ["Ethereum"] }));
      return { ok: true, status: 200, body: JSON.stringify({ items, total: page.total }) };
    });
  }

  it("skips a dominant value whose total differs but whose first page does not", async () => {
    mockCorpus();
    const filters = await deriveFilterValues({ api: "https://api.example.org", timeoutMs: 5000 });
    expect(filters.ecosystem).toBe("Optimism");
    expect(filters.fundingType).toBe("bounty");
    expect(filters.baselineTotal).toBe(OPEN_TOTAL);
  });

  it("reports the candidates it considered, so an unmet row can say why", async () => {
    mockCorpus();
    const filters = await deriveFilterValues({ api: "https://api.example.org", timeoutMs: 5000 });
    expect(filters.candidates.ecosystem).toEqual(["Ethereum", "Optimism", "Nowhere"]);
  });

  it("chooses nothing when no candidate changes the first page", async () => {
    request.mockImplementation(async (url) => {
      const params = new URL(url).searchParams;
      // Every filtered page is the unfiltered page, whatever the total says.
      const items = BASELINE.map((id) => ({ id, fundingType: "grant", ecosystems: ["Ethereum"] }));
      const total = params.get("ecosystem") || params.get("fundingType") ? 115 : OPEN_TOTAL;
      return { ok: true, status: 200, body: JSON.stringify({ items, total }) };
    });
    const filters = await deriveFilterValues({ api: "https://api.example.org", timeoutMs: 5000 });
    expect(filters.ecosystem).toBeUndefined();
    expect(filters.fundingType).toBeUndefined();
    expect(filters.candidates.ecosystem).toEqual(["Ethereum"]);
  });
});

describe("staging validation — only form controls and nav links are measured", () => {
  it("measures the set 13-responsive.spec.ts names, and no bare anchor", () => {
    // Staging flagged block-level prose and footer text links ("All opportunities" 116×23,
    // "Browse the directory"). A text link's hit area is its line box whatever its `display`, so
    // the previous `display:inline` exemption was the wrong test — the selector is.
    const terms = TARGET_SELECTOR.split(", ");
    expect(terms).toEqual([
      "input",
      "select",
      "textarea",
      "button",
      '[role="button"]',
      "nav a[href]",
    ]);
    expect(terms).not.toContain("a[href]");
    expect(terms).not.toContain('[role="link"]');
    expect(terms.filter((t) => t.includes("a[href]")).every((t) => t.startsWith("nav "))).toBe(
      true,
    );
  });

  it("is the set the checker README documents", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    for (const term of [
      "`input`",
      "`select`",
      "`textarea`",
      "`button`",
      '`[role="button"]`',
      "`nav a`",
    ]) {
      expect(readme).toContain(term);
    }
  });
});
