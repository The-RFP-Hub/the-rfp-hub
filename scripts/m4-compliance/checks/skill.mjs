/**
 * M4-5 — the agent skill is published correctly.
 *
 * Four independent facts, none of which substitutes for the others:
 *
 *   1. `SKILL.md`'s frontmatter is valid against the Agent Skills spec (name == directory, kebab,
 *      length limits, no stray top-level `version`/`tags`) — see `frontmatter.mjs`, unit tested.
 *   2. The file is under 500 lines.
 *   3. `scripts/search.mjs` actually runs against a live API and its output carries no
 *      `description` field anywhere — the mitigation the plan requires is that the field never
 *      arrives, and only running the real script proves that; a lint of the source cannot.
 *   4. The skill is actually PUBLISHED: `.claude-plugin/marketplace.json` and the skill's own
 *      `SKILL.md`, fetched from GitHub raw on `main` — never the local checkout, which is exactly
 *      what an earlier revision of this criterion tested instead, letting "Agent skill published
 *      correctly" PASS without a single byte having ever left this checker's own filesystem.
 *      These FAIL (not skip, not info) until the skill is actually merged to `main`.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { request } from "../../m2-compliance/http.mjs";
import { parseFrontmatter, splitFrontmatter, validateFrontmatter } from "../frontmatter.mjs";

const execFileAsync = promisify(execFile);

export const SKILL_DIR = "skills/rfp-hub-funding-search";
const SKILL_NAME = "rfp-hub-funding-search";
const RAW_BASE = "https://raw.githubusercontent.com/The-RFP-Hub/the-rfp-hub/main";

/** Recursively check whether any object in a JSON value carries a `description` key. */
function findDescriptionField(value, path = "$") {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findDescriptionField(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    if ("description" in value) return `${path}.description`;
    for (const [key, v] of Object.entries(value)) {
      const found = findDescriptionField(v, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

export async function checkSkill(report, ctx) {
  const c = report.criterion(
    "M4-5",
    "Agent skill published correctly",
    "The marketplace manifest and SKILL.md are published on GitHub (main); the local SKILL.md's frontmatter is valid and the file is under 500 lines; scripts/search.mjs runs against the live API and never emits a description field.",
  );

  if (ctx.skip.has("skill")) {
    c.skip("skill", "--skip skill");
    return c.finish();
  }

  // ── publication, checked against GitHub raw on `main` — never the local checkout ──────────
  const marketplaceUrl = `${RAW_BASE}/.claude-plugin/marketplace.json`;
  const marketplaceRes = await request(marketplaceUrl, { timeoutMs: ctx.timeoutMs, follow: true });
  c.expect(
    marketplaceRes.ok && marketplaceRes.status === 200,
    `${marketplaceUrl} responds 200`,
    `HTTP ${marketplaceRes.status}`,
    marketplaceRes.ok
      ? `HTTP ${marketplaceRes.status} — .claude-plugin/marketplace.json is not on \`main\` yet`
      : `transport: ${marketplaceRes.error}`,
  );

  const skillRawUrl = `${RAW_BASE}/skills/${SKILL_NAME}/SKILL.md`;
  const skillRawRes = await request(skillRawUrl, { timeoutMs: ctx.timeoutMs, follow: true });
  c.expect(
    skillRawRes.ok && skillRawRes.status === 200,
    `${skillRawUrl} responds 200`,
    `HTTP ${skillRawRes.status}`,
    skillRawRes.ok
      ? `HTTP ${skillRawRes.status} — skills/${SKILL_NAME}/SKILL.md is not on \`main\` yet`
      : `transport: ${skillRawRes.error}`,
  );

  const skillPath = join(ctx.repoRoot, SKILL_DIR, "SKILL.md");
  if (!existsSync(skillPath)) {
    c.fail("SKILL.md exists", `not found at ${skillPath}`);
    return c.finish();
  }

  const raw = readFileSync(skillPath, "utf8");
  const lineCount = raw.split("\n").length;
  c.expect(
    lineCount < 500,
    "SKILL.md is under 500 lines",
    `${lineCount} lines`,
    `${lineCount} lines — over the 500-line limit`,
  );

  const { frontmatter } = splitFrontmatter(raw);
  if (!frontmatter) {
    c.fail("SKILL.md has a --- frontmatter block", "no leading --- ... --- block found");
  } else {
    const { fields, errors: parseErrors } = parseFrontmatter(frontmatter);
    if (parseErrors.length > 0) {
      c.fail("SKILL.md frontmatter parses", parseErrors.join("; "));
    } else {
      const dirName = basename(join(ctx.repoRoot, SKILL_DIR));
      const { ok, errors } = validateFrontmatter(fields, { dirName });
      c.expect(
        ok,
        "SKILL.md frontmatter is valid",
        `name=${fields.name}, description length=${fields.description?.length ?? 0}`,
        errors.join("; "),
      );
    }
  }

  const searchScript = join(ctx.repoRoot, SKILL_DIR, "scripts/search.mjs");
  if (!existsSync(searchScript)) {
    c.fail("scripts/search.mjs exists", `not found at ${searchScript}`);
    return c.finish();
  }

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [searchScript, "--status", "open", "--limit", "5"],
      {
        cwd: ctx.repoRoot,
        timeout: ctx.timeoutMs,
        env: { ...process.env, RFPHUB_API_BASE: ctx.api },
      },
    );
    let output;
    try {
      output = JSON.parse(stdout);
    } catch (err) {
      c.fail(
        "scripts/search.mjs executes against the live API",
        `stdout is not valid JSON: ${err.message}\n${stdout.slice(0, 500)}`,
      );
      return c.finish();
    }
    c.pass(
      "scripts/search.mjs executes against the live API",
      `${JSON.stringify(output).length} bytes of JSON returned`,
    );

    const found = findDescriptionField(output);
    c.expect(
      !found,
      "output carries no description field",
      "clean",
      found ? `a description field was found at ${found}` : "",
    );
  } catch (err) {
    c.fail(
      "scripts/search.mjs executes against the live API",
      `${err.message}${err.stderr ? `\nstderr: ${err.stderr}` : ""}`,
    );
  }

  return c.finish();
}
