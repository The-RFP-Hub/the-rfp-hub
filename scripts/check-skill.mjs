#!/usr/bin/env node
// Agent Skills validation over `skills/*/SKILL.md`, run by `pnpm check:skill`.
//
// What a markdown linter can't check: the frontmatter the Agent Skills spec (agentskills.io,
// 2025-12-18) requires and forbids, and the plugin/marketplace wiring, so a renamed skill
// directory can't silently leave a marketplace entry pointing at nothing.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(repoRoot, "skills");

const ALLOWED_TOP_LEVEL = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);
const FORBIDDEN_TOP_LEVEL = new Set(["version", "tags"]); // the specific rev-4 mistake this guards against
const MAX_NAME_LEN = 64;
const MAX_DESCRIPTION_LEN = 1024;
const MAX_COMPATIBILITY_LEN = 500;
const MAX_SKILL_MD_LINES = 500;
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Required SKILL.md sections, matched case-insensitively against markdown headings. */
const REQUIRED_SECTIONS = [
  "what this is",
  "content safety",
  "key handling",
  "choosing the path",
  "workflow",
  "tracking headers",
  "error handling",
  "formatting results",
  "limits",
];

const errors = [];
const warnings = [];

function fail(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

// Not a general YAML parser: flat scalars, one level of nesting (`metadata:`) and a block scalar
// (`compatibility:`) is all a SKILL.md frontmatter block holds.
function stripQuotes(v) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function indentOf(line) {
  return line.match(/^ */)[0].length;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;
  const lines = match[1].split("\n");
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || indentOf(line) !== 0) {
      i++;
      continue;
    }
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!top) {
      i++;
      continue;
    }
    const key = top[1];
    const value = top[2];
    i++;
    if (/^[>|][-+]?$/.test(value.trim())) {
      const folded = value.trim().startsWith(">");
      const collected = [];
      while (i < lines.length && (lines[i].trim() === "" || indentOf(lines[i]) > 0)) {
        if (lines[i].trim() !== "") collected.push(lines[i].trim());
        i++;
      }
      data[key] = collected.join(folded ? " " : "\n");
    } else if (value.trim() === "") {
      const nested = {};
      while (i < lines.length && indentOf(lines[i]) > 0) {
        const nestedMatch = lines[i].trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (nestedMatch) nested[nestedMatch[1]] = stripQuotes(nestedMatch[2]);
        i++;
      }
      data[key] = nested;
    } else {
      data[key] = stripQuotes(value);
    }
  }
  return { data, raw: match[1], bodyStart: match[0].length };
}

function checkSkill(dir) {
  const name = dir; // directory basename, already
  const skillPath = join(skillsDir, dir, "SKILL.md");
  if (!existsSync(skillPath)) {
    fail(`skills/${dir}: no SKILL.md`);
    return;
  }
  const content = readFileSync(skillPath, "utf8");
  const lineCount = content.split("\n").length;
  if (lineCount > MAX_SKILL_MD_LINES) {
    fail(`skills/${dir}/SKILL.md: ${lineCount} lines, must stay under ${MAX_SKILL_MD_LINES}`);
  }

  const parsed = parseFrontmatter(content);
  if (!parsed) {
    fail(`skills/${dir}/SKILL.md: no YAML frontmatter found (expected a leading --- block)`);
    return;
  }
  const { data } = parsed;

  for (const forbidden of FORBIDDEN_TOP_LEVEL) {
    if (forbidden in data) {
      fail(
        `skills/${dir}/SKILL.md: top-level '${forbidden}:' is not part of the Agent Skills spec — move it under 'metadata:' (metadata values must be strings)`,
      );
    }
  }
  for (const key of Object.keys(data)) {
    if (!ALLOWED_TOP_LEVEL.has(key) && !FORBIDDEN_TOP_LEVEL.has(key)) {
      warn(`skills/${dir}/SKILL.md: unrecognized top-level frontmatter key '${key}'`);
    }
  }

  if (!data.name) {
    fail(`skills/${dir}/SKILL.md: missing required 'name'`);
  } else {
    if (data.name !== name) {
      fail(`skills/${dir}/SKILL.md: name '${data.name}' must equal its directory name '${name}'`);
    }
    if (data.name.length > MAX_NAME_LEN) {
      fail(`skills/${dir}/SKILL.md: name is ${data.name.length} chars, max ${MAX_NAME_LEN}`);
    }
    if (!NAME_PATTERN.test(data.name)) {
      fail(
        `skills/${dir}/SKILL.md: name '${data.name}' must be lowercase alphanumeric with single hyphens, no leading/trailing/consecutive hyphens`,
      );
    }
  }

  if (!data.description) {
    fail(`skills/${dir}/SKILL.md: missing required 'description'`);
  } else if (data.description.length > MAX_DESCRIPTION_LEN) {
    fail(
      `skills/${dir}/SKILL.md: description is ${data.description.length} chars, max ${MAX_DESCRIPTION_LEN}`,
    );
  }

  if (data.compatibility && data.compatibility.length > MAX_COMPATIBILITY_LEN) {
    fail(
      `skills/${dir}/SKILL.md: compatibility is ${data.compatibility.length} chars, max ${MAX_COMPATIBILITY_LEN}`,
    );
  }

  if (data.metadata && typeof data.metadata === "object") {
    for (const [k, v] of Object.entries(data.metadata)) {
      if (typeof v !== "string") {
        fail(`skills/${dir}/SKILL.md: metadata.${k} must be a string, got ${typeof v}`);
      }
    }
  }

  const bodyLower = content.slice(parsed.bodyStart).toLowerCase();
  for (const section of REQUIRED_SECTIONS) {
    if (!bodyLower.includes(section)) {
      fail(`skills/${dir}/SKILL.md: missing required section heading containing "${section}"`);
    }
  }

  // Cross-check the skill's own plugin.json, if present.
  const pluginPath = join(skillsDir, dir, ".claude-plugin", "plugin.json");
  if (existsSync(pluginPath)) {
    try {
      const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
      // A plugin is a distribution unit, not a skill: it may carry the skill's own name or the
      // marketplace's, but not a third name nothing else in the repo knows about.
      const allowedPluginNames = [data.name, marketplaceName()].filter(Boolean);
      if (!allowedPluginNames.includes(plugin.name)) {
        fail(
          `skills/${dir}/.claude-plugin/plugin.json: name '${plugin.name}' must be the skill's name or the marketplace's (${allowedPluginNames.join(" | ")})`,
        );
      }
    } catch (err) {
      fail(`skills/${dir}/.claude-plugin/plugin.json: invalid JSON (${err.message})`);
    }
  }
}

function marketplaceName() {
  const marketplacePath = join(repoRoot, ".claude-plugin", "marketplace.json");
  if (!existsSync(marketplacePath)) return null;
  try {
    return JSON.parse(readFileSync(marketplacePath, "utf8")).name ?? null;
  } catch {
    return null;
  }
}

function checkMarketplace() {
  const marketplacePath = join(repoRoot, ".claude-plugin", "marketplace.json");
  if (!existsSync(marketplacePath)) {
    warn(
      "No .claude-plugin/marketplace.json at repo root — skills are not marketplace-installable",
    );
    return;
  }
  let marketplace;
  try {
    marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"));
  } catch (err) {
    fail(`.claude-plugin/marketplace.json: invalid JSON (${err.message})`);
    return;
  }
  if (!marketplace.name) fail(".claude-plugin/marketplace.json: missing required 'name'");
  if (!marketplace.owner?.name)
    fail(".claude-plugin/marketplace.json: missing required 'owner.name'");
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    fail(".claude-plugin/marketplace.json: 'plugins' must be a non-empty array");
    return;
  }
  for (const plugin of marketplace.plugins) {
    if (!plugin.name || !plugin.source) {
      fail(
        `.claude-plugin/marketplace.json: plugin entry ${JSON.stringify(plugin.name ?? plugin)} missing 'name' or 'source'`,
      );
      continue;
    }
    if (typeof plugin.source === "string") {
      const sourcePath = resolve(repoRoot, plugin.source);
      if (!existsSync(sourcePath)) {
        fail(
          `.claude-plugin/marketplace.json: plugin '${plugin.name}' source '${plugin.source}' does not exist`,
        );
      } else if (!existsSync(join(sourcePath, "SKILL.md"))) {
        fail(
          `.claude-plugin/marketplace.json: plugin '${plugin.name}' source '${plugin.source}' has no SKILL.md at its root`,
        );
      }
    }
  }
}

/**
 * `skills-ref validate` is the spec's reference implementation, pinned as a root devDependency and
 * run through `pnpm exec` so this never invokes whatever version `npx -y` would fetch that day.
 * Best-effort in one direction: absent (a partial or offline install) is a warning, but a real
 * violation from an installed copy is a hard failure, like any other check here.
 */
function skillsRefInstalled() {
  const bin = process.platform === "win32" ? "skills-ref.cmd" : "skills-ref";
  return existsSync(join(repoRoot, "node_modules", ".bin", bin));
}

function runSkillsRefValidate() {
  if (!skillsRefInstalled()) {
    warn(
      "skills-ref is not installed (expected node_modules/.bin/skills-ref from the pinned root devDependency after `pnpm install`) — skipping it, relying on this script's own checks only",
    );
    return;
  }
  for (const dir of skillDirs()) {
    const target = join(skillsDir, dir);
    try {
      execFileSync("pnpm", ["exec", "skills-ref", "validate", target], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 60_000,
      });
    } catch (err) {
      const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      fail(`skills-ref validate skills/${dir}: ${output.trim() || err.message}`);
    }
  }
}

/** The plugin host's own manifest check, in the `--strict` mode it recommends for CI. Best-effort
 * the same way `skills-ref` is: absent CLI warns, an installed CLI's violation fails. Probes the
 * subcommand rather than the binary, so a CLI too old to have it warns instead of failing. */
function claudePluginValidateAvailable() {
  try {
    execFileSync("claude", ["plugin", "validate", "--help"], {
      stdio: "ignore",
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

function runClaudePluginValidate() {
  const targets = skillDirs()
    .filter((dir) => existsSync(join(skillsDir, dir, ".claude-plugin", "plugin.json")))
    .map((dir) => join(skillsDir, dir));
  const marketplacePath = join(repoRoot, ".claude-plugin", "marketplace.json");
  if (existsSync(marketplacePath)) targets.push(marketplacePath);
  if (targets.length === 0) return;
  if (!claudePluginValidateAvailable()) {
    warn(
      "`claude plugin validate` is unavailable (no claude CLI on PATH, or one without that command) — skipping the strict manifest validation",
    );
    return;
  }
  for (const target of targets) {
    try {
      execFileSync("claude", ["plugin", "validate", target, "--strict"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 60_000,
      });
    } catch (err) {
      const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      fail(`claude plugin validate --strict ${target}: ${output.trim() || err.message}`);
    }
  }
}

function skillDirs() {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir).filter((entry) => {
    const full = join(skillsDir, entry);
    return statSync(full).isDirectory() && existsSync(join(full, "SKILL.md"));
  });
}

const dirs = skillDirs();
if (dirs.length === 0) {
  console.log("No skills/*/SKILL.md found — nothing to check.");
  process.exit(0);
}

for (const dir of dirs) checkSkill(dir);
checkMarketplace();
runSkillsRefValidate();
runClaudePluginValidate();

for (const w of warnings) console.warn(`⚠ ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error(`\n${errors.length} skill check failure(s).`);
  process.exit(1);
}
console.log(`✓ ${dirs.length} skill(s) checked: ${dirs.join(", ")}`);
