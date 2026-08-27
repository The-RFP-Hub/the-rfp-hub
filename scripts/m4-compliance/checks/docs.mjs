/**
 * M4-6 — the handoff docs exist, every link resolves, and the marked `sh` blocks behave.
 *
 * Three separate facts:
 *
 *   1. The four guides exist under `docs/`.
 *   2. Every link they make resolves: a relative link to a file in the repo, an absolute link to
 *      something that answers 2xx/3xx (skipped, not failed, in `--offline`).
 *   3. Every `sh` block carries one of the three markers (`markers.mjs`), `safe-read` blocks are
 *      the ONLY ones this checker executes and must succeed, and `no-run`/`staging-write` blocks
 *      are asserted never to have been executed.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { mapLimit, request } from "../../m2-compliance/http.mjs";
import { extractLinks, isAbsoluteHttpLink, isAnchorLink, resolveRelativeLink } from "../links.mjs";
import { MARKERS, shellBlocks } from "../markers.mjs";

const execFileAsync = promisify(execFile);

export const HANDOFF_DOCS = [
  "docs/deployment.md",
  "docs/api-integration.md",
  "docs/publisher-onboarding.md",
  "docs/external-deploy-test.md",
];

export async function checkDocs(report, ctx) {
  const c = report.criterion(
    "M4-6",
    "Handoff documentation",
    "The four guides exist, every link resolves, and only safe-read sh blocks are ever executed — and those succeed.",
  );

  if (ctx.skip.has("docs")) {
    c.skip("docs", "--skip docs");
    return c.finish();
  }

  const present = [];
  for (const relPath of HANDOFF_DOCS) {
    const full = join(ctx.repoRoot, relPath);
    const exists = existsSync(full);
    c.expect(exists, `${relPath} exists`, full, `not found at ${full}`);
    if (exists) present.push(relPath);
  }
  if (present.length === 0) return c.finish();

  // ── links ────────────────────────────────────────────────────────────────
  const absoluteToCheck = [];
  for (const relPath of present) {
    const full = join(ctx.repoRoot, relPath);
    const text = readFileSync(full, "utf8");
    const fileDir = dirname(full);
    const links = extractLinks(text);

    for (const { href } of links) {
      if (isAnchorLink(href)) continue;
      if (isAbsoluteHttpLink(href)) {
        absoluteToCheck.push({ relPath, href });
        continue;
      }
      const resolved = resolveRelativeLink(href, {
        fileDir,
        repoRoot: ctx.repoRoot,
        path: nodePath,
      });
      if (resolved === null) continue;
      const targetFull = join(ctx.repoRoot, resolved.split("#")[0]);
      c.expect(
        existsSync(targetFull),
        `${relPath}: relative link "${href}" resolves`,
        targetFull,
        `${relPath} links to "${href}", which does not exist at ${targetFull}`,
      );
    }
  }

  if (ctx.offline) {
    c.skip(
      "absolute links answer 2xx/3xx",
      `--offline: ${absoluteToCheck.length} absolute link(s) not requested`,
    );
  } else if (absoluteToCheck.length > 0) {
    const results = await mapLimit(absoluteToCheck, ctx.concurrency, async (entry) => ({
      ...entry,
      res: await request(entry.href, { timeoutMs: ctx.timeoutMs, follow: true }),
    }));
    for (const { relPath, href, res } of results) {
      const ok = res.ok && res.status >= 200 && res.status < 400;
      c.expect(
        ok,
        `${relPath}: absolute link "${href}" answers 2xx/3xx`,
        `HTTP ${res.status}`,
        res.ok ? `HTTP ${res.status}` : `transport: ${res.error}`,
      );
    }
  } else {
    c.info("absolute links answer 2xx/3xx", "no absolute links found");
  }

  // ── marked sh blocks ─────────────────────────────────────────────────────
  for (const relPath of present) {
    const full = join(ctx.repoRoot, relPath);
    const text = readFileSync(full, "utf8");
    const blocks = shellBlocks(text);

    for (const block of blocks) {
      if (!block.marker) {
        c.fail(
          `${relPath}:${block.line}: sh block carries a marker`,
          `no ${MARKERS.join("/")} marker found on the fence's info string or the preceding line — see scripts/m4-compliance/README.md for the convention`,
        );
        continue;
      }

      if (block.marker === "safe-read") {
        if (ctx.offline) {
          c.skip(`${relPath}:${block.line}: safe-read block executes successfully`, "--offline");
          continue;
        }
        try {
          await execFileAsync("/bin/sh", ["-c", block.source], {
            cwd: ctx.repoRoot,
            timeout: ctx.timeoutMs,
            env: process.env,
          });
          c.pass(
            `${relPath}:${block.line}: safe-read block executes successfully`,
            block.source.trim().slice(0, 200),
          );
        } catch (err) {
          c.fail(
            `${relPath}:${block.line}: safe-read block executes successfully`,
            `${err.message}${err.stderr ? `\nstderr: ${err.stderr}` : ""}`,
          );
        }
        continue;
      }

      // no-run / staging-write: never executed by this checker, by design.
      c.pass(
        `${relPath}:${block.line}: ${block.marker} block is never executed by this checker`,
        "not run (by design)",
      );
    }
  }

  return c.finish();
}
