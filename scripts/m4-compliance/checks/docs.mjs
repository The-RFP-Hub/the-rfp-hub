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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { mapLimit, request } from "../../m2-compliance/http.mjs";
import { extractLinks, isAbsoluteHttpLink, isAnchorLink, resolveRelativeLink } from "../links.mjs";
import { MARKERS, shellBlocks } from "../markers.mjs";

const execFileAsync = promisify(execFile);

/**
 * The preamble every `safe-read` block runs after — and the two stronger designs that were tried
 * first, against the REAL docs (`brunodmsi/m4-handoff-docs`), and reverted because each one broke
 * a legitimate block that is actually in `docs/api-integration.md` today. This is not a
 * hypothetical concern; every case below was executed against production, not assumed.
 *
 *   1. `bash -o pipefail` + `set -euo pipefail`. Broke
 *      `curl -s "$API/v1/feeds/opportunities.atom" | head -40`: `head` closing its end of the pipe
 *      once it has its 40 lines makes curl's own write fail (curl ignores SIGPIPE and converts it
 *      to its own error code rather than dying by signal), and `pipefail` cannot tell that apart
 *      from a real network failure — it inspects every stage's exit code, not just the one that
 *      mattered here.
 *   2. Dropping `pipefail`, but shimming BOTH `curl() { command curl -f "$@"; }` (so an HTTP error
 *      makes curl itself fail and discard the body) AND `jq() { command jq -e "$@"; }` (so jq
 *      exits non-zero when there was nothing left to parse — verified: exit `4` on empty stdin).
 *      This closes the real gap (`jq '.'` on empty stdin exits **0**, so `curl | jq` on a 404
 *      silently "succeeds" by pretty-printing the API's error body) — but it ALSO broke
 *      `docs/publisher-onboarding.md`'s `curl ... | jq '.items[] | select(.slug=="example-
 *      foundation")'`: that example slug does not exist in production, `select` legitimately
 *      matches nothing, jq produces zero output for a perfectly healthy response, and `-e` cannot
 *      tell "upstream failed" apart from "my own filter matched nothing" — both are just "no
 *      output" to it. The doc's own author did not write `-e` there; forcing it on from outside
 *      second-guesses an intentional, correct use of `select`.
 *
 * What ships: `curl` alone is shadowed with `-f`, under plain `set -eu`, no `pipefail`, no `jq`
 * shim. This is a real, narrower improvement over doing nothing — a BARE (non-piped) failing
 * `curl -f ... -o file` is the last command on its line, so `set -e` catches it directly, which
 * matters for exactly the block that motivated this (`.../export/opportunities.json -o
 * dataset.json`) — while every piped block is unaffected, because without `pipefail` only the
 * pipe's LAST command's exit status is examined, and `-f` does not change what `head` or `jq`
 * themselves return. The one gap this leaves open, stated plainly: a `curl -f ... | jq` (no `-e`)
 * whose request fails still "succeeds", because plain `jq` on the empty body `-f` leaves behind
 * also exits 0. Closing that gap without reintroducing case 2's regression would need per-line
 * `PIPESTATUS` instrumentation of the doc's own text, which this checker does not do — it runs
 * documentation as written, it does not rewrite it.
 */
export const SAFE_READ_PREAMBLE = 'curl() { command curl -f "$@"; }\nset -eu\n';

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
    c.skipOptional(
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
  // `safe-read` blocks run with a FRESH, DISPOSABLE working directory, never `ctx.repoRoot` — a
  // real block in `docs/api-integration.md` does `curl ... -o dataset.json` /
  // `-o dataset.csv`, and running that with `cwd: ctx.repoRoot` left both files sitting in the
  // caller's own checkout after every run of this checker. One directory for the whole check
  // (not one per block): the blocks are independent — none of them reads a file an earlier block
  // wrote — so sharing it costs nothing and avoids a `mkdtemp` per block for no benefit.
  const scratchDir = await mkdtemp(join(tmpdir(), "m4-check-docs-safe-read-"));
  try {
    for (const relPath of present) {
      const full = join(ctx.repoRoot, relPath);
      const text = readFileSync(full, "utf8");
      const blocks = shellBlocks(text);

      for (const block of blocks) {
        if (!block.marker) {
          c.fail(
            `${relPath}:${block.line}: sh block carries a marker`,
            `no ${MARKERS.join("/")} marker found as the second word of the fence's info string (e.g. \`\`\`sh safe-read) — see scripts/m4-compliance/README.md for the convention`,
          );
          continue;
        }

        if (block.marker === "safe-read") {
          if (ctx.offline) {
            c.skipOptional(
              `${relPath}:${block.line}: safe-read block executes successfully`,
              "--offline",
            );
            continue;
          }
          try {
            await execFileAsync("bash", ["-c", SAFE_READ_PREAMBLE + block.source], {
              cwd: scratchDir,
              timeout: ctx.timeoutMs,
              // `docs/**` blocks reference the API as `$API`, never a literal URL.
              env: { ...process.env, API: ctx.api },
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
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }

  return c.finish();
}
