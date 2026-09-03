/**
 * The handoff docs exist, every link resolves, and the marked `sh` blocks behave.
 *
 * THE MARKER RULE APPLIES TO `docs/**` ONLY. Those four guides are written for this checker and an
 * unmarked block there is a hard failure: a block this tool cannot tell is safe to run would
 * otherwise go unexercised without anyone noticing. Elsewhere — the root `*.md` files, `skills/**`,
 * `packages/mcp/README.md` — the markdown predates the convention and is owned by other streams, so
 * an unmarked block is reported as "not executed" and never fails. Their links and `#anchors` are
 * still validated exactly like the guides': a broken relative link in the root README is as broken
 * for a reader as one in `docs/`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as nodePath from "node:path";
import { mapLimit } from "../http.mjs";
import {
  extractLinks,
  headingSlugs,
  isAbsoluteHttpLink,
  isAnchorLink,
  isUnresolvedReference,
  resolveRelativeLink,
} from "../links.mjs";
import { MARKERS, shellBlocks } from "../markers.mjs";
import { requestPublished } from "../retry.mjs";
import { parseSafeReadBlock, runSafeReadBlock } from "../safe-read.mjs";

export const HANDOFF_DOCS = [
  "docs/deployment.md",
  "docs/api-integration.md",
  "docs/publisher-onboarding.md",
  "docs/external-deploy-test.md",
];

/** Every `*.md` under `<repoRoot>/<dir>`, at any depth, as repo-root-relative paths. */
function markdownUnder(repoRoot, dir, depth = 0) {
  const found = [];
  if (depth > 6) return found;
  const full = join(repoRoot, dir);
  if (!existsSync(full)) return found;
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (entry.isDirectory())
      found.push(...markdownUnder(repoRoot, `${dir}/${entry.name}`, depth + 1));
    else if (entry.isFile() && entry.name.endsWith(".md")) found.push(`${dir}/${entry.name}`);
  }
  return found;
}

/** Markdown outside `docs/**` whose links this criterion still holds to the same standard. */
export function extraLinkSources(repoRoot) {
  const sources = [];
  const add = (relPath) => {
    if (existsSync(join(repoRoot, relPath)) && !HANDOFF_DOCS.includes(relPath)) {
      sources.push(relPath);
    }
  };
  try {
    for (const entry of readdirSync(repoRoot)) if (entry.endsWith(".md")) add(entry);
  } catch {
    // an unreadable repo root is the caller's problem; the guides above already reported it
  }
  add("packages/mcp/README.md");
  // Recursively: `references/*.md` beside a SKILL.md is documentation a reader follows too.
  for (const relPath of markdownUnder(repoRoot, "skills")) add(relPath);
  return sources;
}

function checkLinks(c, ctx, relPath, slugsOf, absoluteToCheck) {
  const full = join(ctx.repoRoot, relPath);
  const text = readFileSync(full, "utf8");
  const fileDir = dirname(full);

  for (const { href, kind } of extractLinks(text)) {
    if (isUnresolvedReference(href)) {
      c.fail(`${relPath}: reference link resolves`, `${href} has no [ref]: definition`);
      continue;
    }
    if (isAnchorLink(href)) {
      c.expect(
        slugsOf(full)?.has(href.slice(1)) === true,
        `${relPath}: anchor "${href}" names a heading`,
        `matches a heading in ${relPath}`,
        `no heading in ${relPath} produces the anchor "${href.slice(1)}"`,
      );
      continue;
    }
    if (isAbsoluteHttpLink(href)) {
      absoluteToCheck.push({ relPath, href, kind });
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // mailto: and friends
    const resolved = resolveRelativeLink(href, {
      fileDir,
      repoRoot: ctx.repoRoot,
      path: nodePath,
    });
    if (resolved === null) continue;
    if (resolved.escapesRepo) {
      c.fail(
        `${relPath}: relative link "${href}" stays inside the repository`,
        `resolves to ${resolved.path}, outside the checkout — it cannot resolve on the published mirror`,
      );
      continue;
    }
    const targetFull = join(ctx.repoRoot, resolved.path);
    const exists = existsSync(targetFull);
    c.expect(
      exists,
      `${relPath}: relative link "${href}" resolves`,
      targetFull,
      `${relPath} links to "${href}", which does not exist at ${targetFull}`,
    );
    if (!exists || resolved.fragment === undefined || !targetFull.endsWith(".md")) continue;
    c.expect(
      slugsOf(targetFull)?.has(resolved.fragment) === true,
      `${relPath}: fragment "#${resolved.fragment}" names a heading in ${resolved.path}`,
      `matches a heading in ${resolved.path}`,
      `no heading in ${resolved.path} produces the anchor "${resolved.fragment}"`,
    );
  }
}

async function checkBlocks(c, ctx, relPath, { markersRequired, scratchDir }) {
  const text = readFileSync(join(ctx.repoRoot, relPath), "utf8");
  for (const block of shellBlocks(text)) {
    const where = `${relPath}:${block.line}`;
    if (!block.marker) {
      if (!markersRequired) {
        c.info(`${where}: unmarked sh block`, "not executed — the marker rule covers docs/** only");
        continue;
      }
      c.fail(
        `${where}: sh block carries a marker`,
        `no ${MARKERS.join("/")} marker found as the second word of the fence's info string (e.g. \`\`\`sh safe-read) — see scripts/compliance/README.md`,
      );
      continue;
    }

    if (block.marker !== "safe-read") {
      c.pass(
        `${where}: ${block.marker} block is never executed by this checker`,
        "not run (by design)",
      );
      continue;
    }

    const name = `${where}: safe-read block is a read, and succeeds`;
    if (ctx.offline) {
      c.skip(name, "--offline");
      continue;
    }
    const parsed = parseSafeReadBlock(block.source, { api: ctx.api, site: ctx.site });
    if (!parsed.ok) {
      c.fail(
        name,
        `refused before execution — ${parsed.reason}. A safe-read block is curl GETs, optionally piped into jq/head/sed -n/python3 -m json.tool; see scripts/compliance/README.md`,
      );
      continue;
    }
    const run = await runSafeReadBlock(parsed, {
      cwd: scratchDir,
      timeoutMs: ctx.timeoutMs,
      api: ctx.api,
      site: ctx.site,
    });
    c.expect(run.ok, name, block.source.trim().slice(0, 200), run.reason ?? "");
  }
}

export async function checkDocs(report, ctx) {
  const c = report.criterion(
    "docs",
    "Handoff documentation",
    "The four guides exist; every link and #anchor in them, in the root markdown, in skills/** and in packages/mcp/README.md resolves; and only safe-read sh blocks are ever executed — those succeed.",
  );

  const present = [];
  for (const relPath of HANDOFF_DOCS) {
    const full = join(ctx.repoRoot, relPath);
    const exists = existsSync(full);
    c.expect(exists, `${relPath} exists`, full, `not found at ${full}`);
    if (exists) present.push(relPath);
  }

  const slugCache = new Map();
  const slugsOf = (fullPath) => {
    if (!slugCache.has(fullPath)) {
      const value = existsSync(fullPath) ? headingSlugs(readFileSync(fullPath, "utf8")) : null;
      slugCache.set(fullPath, value);
    }
    return slugCache.get(fullPath);
  };

  const extras = extraLinkSources(ctx.repoRoot);
  const absoluteToCheck = [];
  for (const relPath of [...present, ...extras]) {
    checkLinks(c, ctx, relPath, slugsOf, absoluteToCheck);
  }

  if (ctx.offline) {
    c.skip(
      "absolute links answer 2xx/3xx",
      `--offline: ${absoluteToCheck.length} absolute link(s) not requested`,
    );
  } else if (absoluteToCheck.length > 0) {
    const results = await mapLimit(absoluteToCheck, ctx.concurrency, async (entry) => ({
      ...entry,
      res: await requestPublished(entry.href, { timeoutMs: ctx.timeoutMs, follow: true }),
    }));
    for (const { relPath, href, res } of results) {
      c.expect(
        res.ok && res.status >= 200 && res.status < 400,
        `${relPath}: absolute link "${href}" answers 2xx/3xx`,
        `HTTP ${res.status}`,
        res.ok ? `HTTP ${res.status}` : `transport: ${res.error}`,
      );
    }
  } else {
    c.info("absolute links answer 2xx/3xx", "no absolute links found");
  }

  // `safe-read` blocks run in a FRESH, DISPOSABLE working directory, never `ctx.repoRoot` — a real
  // block does `curl ... -o dataset.json`, and `cwd: ctx.repoRoot` left that file in the caller's
  // own checkout after every run of a tool advertised as read-only.
  const scratchDir = await mkdtemp(join(tmpdir(), "compliance-docs-safe-read-"));
  try {
    for (const relPath of present) {
      await checkBlocks(c, ctx, relPath, { markersRequired: true, scratchDir });
    }
    for (const relPath of extras) {
      await checkBlocks(c, ctx, relPath, { markersRequired: false, scratchDir });
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }

  return c.finish();
}

export const meta = {
  key: "docs",
  requires: [],
  needs: ["api", "site", "repoRoot"],
  contract: { m4: "M4-6" },
};

export async function run(ctx) {
  return checkDocs(ctx.report, ctx);
}
