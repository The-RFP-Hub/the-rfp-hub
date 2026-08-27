/**
 * Agent Skills frontmatter validation — pure, no I/O.
 *
 * Rules taken from the Agent Skills spec (agentskills.io, 2025-12-18) as summarized in the M4 plan:
 *
 *   - `name` is required, at most 64 characters, kebab-case, and must equal the skill's own
 *     directory name — a skill that renamed itself in its own frontmatter but not on disk (or vice
 *     versa) is exactly the kind of drift a human reviewer skims past.
 *   - `description` is required, at most 1024 characters.
 *   - `version` and `tags` are NOT top-level fields the spec allows. They belong under `metadata`
 *     (whose values must be strings), or they do not belong at all. This is the correction the plan
 *     calls out explicitly (rev. 4): an earlier revision of this plan itself got this wrong.
 *   - Optional fields the spec does allow: `license`, `compatibility`, `metadata`, `allowed-tools`.
 *
 * `parseFrontmatter` and `validateFrontmatter` are split so the checker can report a parse failure
 * distinctly from a validation failure, and so both are unit-testable without a filesystem.
 */

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Minimal YAML-frontmatter splitter: `---\n...\n---` at the top of the file, nothing fancier. */
export function splitFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { frontmatter: null, body: text };
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

/**
 * A deliberately narrow YAML subset: `key: value` pairs, block scalars via `>-` / `|-`, one level
 * of nested mapping (used by `metadata`), and nothing else. This is not a YAML parser — it exists
 * to read the handful of shapes SKILL.md frontmatter actually uses, and to fail loudly (returning
 * an object under `_errors`) rather than silently mis-parse something more exotic.
 */
export function parseFrontmatter(raw) {
  const errors = [];
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const result = {};
  let i = 0;

  const readBlockScalar = (indent) => {
    const parts = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        i++;
        continue;
      }
      const lineIndent = line.match(/^ */)[0].length;
      if (lineIndent <= indent) break;
      parts.push(line.trim());
      i++;
    }
    return parts.join(" ");
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const topMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!topMatch) {
      errors.push(`unparsable line: "${line}"`);
      i++;
      continue;
    }
    const [, key, rest] = topMatch;
    i++;
    if (rest === ">-" || rest === "|-" || rest === ">" || rest === "|") {
      result[key] = readBlockScalar(line.match(/^ */)[0].length);
      continue;
    }
    if (rest === "") {
      // Nested mapping (e.g. `metadata:`), one level deep.
      const nested = {};
      while (i < lines.length) {
        const nestedLine = lines[i];
        if (nestedLine.trim() === "") {
          i++;
          continue;
        }
        const indent = nestedLine.match(/^ */)[0].length;
        if (indent === 0) break;
        const nestedMatch = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(nestedLine);
        if (!nestedMatch) break;
        nested[nestedMatch[1]] = stripQuotes(nestedMatch[2]);
        i++;
      }
      result[key] = nested;
      continue;
    }
    result[key] = stripQuotes(rest);
  }

  return { fields: result, errors };
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

const ALLOWED_TOP_LEVEL = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

/**
 * Validate parsed frontmatter fields against the spec, plus the one repo-specific rule (`name`
 * equals the directory name). Returns `{ ok, errors }`; never throws.
 */
export function validateFrontmatter(fields, { dirName } = {}) {
  const errors = [];

  if (!fields.name) {
    errors.push("missing required field: name");
  } else {
    if (fields.name.length > 64) errors.push(`name exceeds 64 characters (${fields.name.length})`);
    if (!KEBAB.test(fields.name)) errors.push(`name "${fields.name}" is not kebab-case`);
    if (dirName && fields.name !== dirName) {
      errors.push(`name "${fields.name}" does not match its directory name "${dirName}"`);
    }
  }

  if (!fields.description) {
    errors.push("missing required field: description");
  } else if (fields.description.length > 1024) {
    errors.push(`description exceeds 1024 characters (${fields.description.length})`);
  }

  if ("version" in fields) {
    errors.push(
      "top-level `version` is not a field the Agent Skills spec allows — move it to metadata.version",
    );
  }
  if ("tags" in fields) {
    errors.push(
      "top-level `tags` is not a field the Agent Skills spec allows — move it to metadata.tags",
    );
  }

  if (fields.metadata && typeof fields.metadata === "object") {
    for (const [key, value] of Object.entries(fields.metadata)) {
      if (typeof value !== "string") {
        errors.push(`metadata.${key} must be a string, got ${typeof value}`);
      }
    }
  }

  for (const key of Object.keys(fields)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      errors.push(`unrecognized top-level field: "${key}"`);
    }
  }

  return { ok: errors.length === 0, errors };
}
