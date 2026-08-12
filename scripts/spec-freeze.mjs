// THE FREEZE GATE, as a semantic comparison rather than a textual one.
//
// A published spec version is frozen: once it is declared stable, the artifacts that define it
// must never be edited again. `.github/workflows/spec-freeze.yml` is the trigger; this file is
// the rule. It lives here, in the tree, because a gate written as thirty lines of `grep` in YAML
// is a gate nobody can test — and the two ways the previous one could be walked past were both
// consequences of matching TEXT instead of parsing JSON:
//
//   1. "the `$id` LINE only" dropped every added/removed line beginning `"$id":`. JSON is free to
//      put a second member on that line, so `"$id": "…", "minProperties": 1` was filtered out
//      whole and reported as an `$id`-only change. Both bypasses below were demonstrated against
//      the previous gate in an isolated clone before this file existed.
//   2. "the first freeze may finish the directory" let the adoption PR carry ANY edit under
//      schemas/v*/ and conformance/v*/, because frozen-ness was read from the base ref and the
//      base had no marker. Widening a status enum in the same commit as the FROZEN marker passed.
//
// So: every permitted change to a normative JSON artifact is checked by parsing BOTH revisions and
// diffing them structurally. A change is permitted only when the set of differing JSON pointers is
// a subset of the pointers named below AND each new value equals the identifier derived from
// spec.config.json. No regex, no line filters, nothing that depends on formatting.
//
// Structure is necessary but not sufficient, so it is not the last word: a permitted change is then
// held to the BYTES (`bytesBeyondIdentifiers`). Parsing alone cannot see a reflowed document or a
// re-escaped string — both parse equal, and both change what a consumer who hashed the published
// file receives. Since "immutable bytes" is the promise PROCESS.md and NORMATIVE.md make, the gate
// checks bytes, and the structural pass is what makes a byte check safe to state as a rule.
//
// THE THREE READINGS OF "FROZEN", ON PURPOSE:
//
//   VERSIONED directories (schemas/v*/, conformance/v*/) are judged from the BASE ref. A version's
//   marker necessarily lands in the same commit that finishes its directory, so judging them from
//   base ∪ head would make declaring any version stable impossible. Once the base carries the
//   marker the directory is immutable except for the four INFORMATIVE documents named in
//   packages/standard/NORMATIVE.md — which PROCESS.md says are corrigible at any time, and which
//   the previous gate rejected, leaving those two policies in direct contradiction.
//
//   VERSIONLESS artifacts (meta/, registries/entry.schema.json) and spec.config.json's identity
//   fields are judged from base ∪ head. They are not part of the directory being declared, so the
//   commit that freezes a version is held to the frozen rules for them. Without this, a change
//   could rewrite every $id in a spec version and be permitted by nothing more than the ORDER of
//   two edits in one commit.
//
//   THE ADOPTION. The identifiers this standard published before it owned a domain were marked
//   PROVISIONAL in the artifact itself, and swapping them for canonical ones was a planned event
//   with a declared trigger. That exemption is expressed here, not assumed — and it is NARROW:
//   during the adoption the versioned directories are held to the allowlist in
//   `adoptionRule()`, file by file, JSON pointer by JSON pointer, and then byte by byte. "First
//   freeze may finish anything" is not a rule this gate has, and neither is "reformat it while
//   the door is open": a file under the exemption must come out of it as its own base bytes with
//   the identifier strings substituted, and nothing else moved.
//
// The adoption is self-extinguishing: afterwards the base always reads `canonical`, so the
// transition cannot recur, and canonical -> provisional is rejected outright so it cannot be
// re-armed.
//
// What this cannot defend against is repo configuration: it must be a required status check, main
// must require PRs, and .github/ plus this file should be CODEOWNERS-protected — none of which is
// expressible from inside the tree. The workflow's push trigger is the tripwire for direct pushes.
//
// Usage:  node scripts/spec-freeze.mjs <BASE_SHA> <HEAD_SHA>
// See packages/standard/PROCESS.md, packages/standard/NORMATIVE.md, adr/0001 and adr/0007.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The package the standard lives in. Every path below is relative to the repository root. */
export const STANDARD = "packages/standard";

/** Everything this gate watches. The workflow's `paths:` filters must stay in step with these. */
export const WATCHED = [
  `${STANDARD}/schemas/v*`,
  `${STANDARD}/conformance/v*`,
  `${STANDARD}/meta`,
  `${STANDARD}/registries/entry.schema.json`,
  `${STANDARD}/spec.config.json`,
];

/**
 * The informative documents of a version directory, per packages/standard/NORMATIVE.md.
 * PROCESS.md: "Informative documents may be corrected at any time." They carry no conformance
 * weight, so freezing them would freeze typo corrections and broken links into a published
 * version forever. Everything ELSE in the directory — the schema, the context, the examples the
 * cut shipped, and the whole conformance suite — is immutable bytes.
 */
export const INFORMATIVE = ["FIELDS.md", "CROSSWALK.md", "BENCHMARK.md", "STATUS.md"];

/** A decision record: `adr/NNNN-slug.md`, and nothing else. */
const ADR_PATH = /^adr\/\d{4}-[a-z0-9-]+\.md$/;

// ---------------------------------------------------------------- structural JSON diff ---

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** RFC 6901 escaping, so a pointer is unambiguous even for a key containing `/` or `~`. */
const escapeToken = (k) => String(k).replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * Every JSON pointer at which two parsed documents differ.
 *
 * Object key ORDER counts as a difference. These files are published bytes that consumers hash;
 * a re-ordered document is a different publication even where it is the same data, and under an
 * exemption this narrow "we only touched the identifier" should mean exactly that.
 */
export function diffPointers(base, head, at = "", out = []) {
  if (isObject(base) && isObject(head)) {
    const bk = Object.keys(base);
    const hk = Object.keys(head);
    for (const key of bk) if (!(key in head)) out.push(`${at}/${escapeToken(key)}`);
    for (const key of hk) if (!(key in base)) out.push(`${at}/${escapeToken(key)}`);
    if (bk.length === hk.length && bk.every((k, i) => k === hk[i])) {
      for (const key of bk) diffPointers(base[key], head[key], `${at}/${escapeToken(key)}`, out);
    } else {
      for (const key of bk) {
        if (key in head) diffPointers(base[key], head[key], `${at}/${escapeToken(key)}`, out);
      }
      if (bk.filter((k) => k in head).join("\0") !== hk.filter((k) => k in base).join("\0"))
        out.push(`${at || "/"} (key order)`);
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(head)) {
    const n = Math.max(base.length, head.length);
    for (let i = 0; i < n; i++) {
      if (i >= base.length || i >= head.length) out.push(`${at}/${i}`);
      else diffPointers(base[i], head[i], `${at}/${i}`, out);
    }
    return out;
  }
  if (base !== head) out.push(at || "/");
  return out;
}

/**
 * THE BYTE CHECK. Is `headText` exactly `baseText` with the given identifier strings substituted?
 *
 * `diffPointers` compares two PARSED documents, so two things it cannot see are a whitespace-only
 * reflow and a re-escaped string (`"https://…"`): both parse identical, both produce no
 * differing pointer, and both change the bytes a consumer hashed. Under an exemption whose whole
 * claim is "only the identifier moved", that gap is the exemption quietly widening to "anything
 * that parses the same" — so the adoption path ends here, on the bytes themselves.
 *
 * `substitutions` are pairs of JSON-ENCODED values (`["\"https://old/x\"", "\"https://new/x\""]`),
 * quotes included. The quotes are what make substitution safe: one encoded string value can never
 * be a prefix of another, so the pairs cannot interfere. Replacement is a single left-to-right
 * pass, so a new value that happens to contain an old one cannot be rewritten twice.
 *
 * Every substitution must be USED. A published identifier the base file does not actually contain
 * verbatim means the parsed value and the bytes disagree — an escape trick, or a stale spelling the
 * adoption is leaving behind — and either way this is not the narrow change it claims to be.
 *
 * @returns {string|null} why the bytes are not accounted for, or null when they are.
 */
export function bytesBeyondIdentifiers(baseText, headText, substitutions) {
  const byFrom = new Map();
  for (const [from, to] of substitutions) {
    const seen = byFrom.get(from);
    if (seen !== undefined && seen !== to) {
      return `the published value ${from} would have to become both ${seen} and ${to}`;
    }
    byFrom.set(from, to);
  }

  let rebuilt = "";
  let cursor = 0;
  const used = new Set();
  for (;;) {
    let hit = null;
    for (const [from, to] of byFrom) {
      const at = baseText.indexOf(from, cursor);
      if (at !== -1 && (hit === null || at < hit.at)) hit = { at, from, to };
    }
    if (hit === null) break;
    rebuilt += baseText.slice(cursor, hit.at) + hit.to;
    cursor = hit.at + hit.from.length;
    used.add(hit.from);
  }
  rebuilt += baseText.slice(cursor);

  for (const from of byFrom.keys()) {
    if (!used.has(from)) {
      return `${from} is the published value at a changed pointer, but does not appear verbatim in the base file's bytes`;
    }
  }
  if (rebuilt === headText) return null;

  let i = 0;
  while (i < rebuilt.length && i < headText.length && rebuilt[i] === headText[i]) i++;
  const line = headText.slice(0, i).split("\n").length;
  return `bytes diverge at line ${line} — the file was re-formatted, re-escaped or otherwise edited beyond the identifier substitution`;
}

/** Resolve an RFC 6901 pointer, returning `undefined` when any step is absent. */
export function atPointer(doc, pointer) {
  let node = doc;
  for (const raw of pointer.split("/").slice(1)) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") return undefined;
    node = Array.isArray(node) ? node[Number(token)] : node[token];
  }
  return node;
}

// ------------------------------------------------------------------- identifier rules ---

/**
 * The canonical URL of a file the standard publishes.
 *
 * The publication tree mirrors `packages/standard/` byte-for-byte (adr/0007), so a file's
 * identifier is its own path under `baseUrl`. Deriving it here rather than writing URLs into the
 * gate is what makes the gate correct for the next version directory without an edit.
 */
export const canonicalUrl = (spec, repoPath) =>
  `${spec.baseUrl}/${repoPath.slice(`${STANDARD}/`.length)}`;

/** `packages/standard/conformance/v1.0.0/pass/x.json` -> `v1.0.0`. */
const versionOf = (repoPath) =>
  repoPath.match(/^packages\/standard\/(?:schemas|conformance)\/(v[^/]+)\//)?.[1] ?? null;

const schemaUrl = (spec, ver) => `${spec.baseUrl}/schemas/${ver}/opportunity.schema.json`;
const contextUrl = (spec, ver) => `${spec.baseUrl}/schemas/${ver}/context.jsonld`;

/**
 * THE ADOPTION ALLOWLIST. Exactly which files inside a version directory the one-time
 * provisional -> canonical swap may touch, and — for each — exactly which JSON pointers may
 * differ and what the new value must be. A file absent from this table may not change at all;
 * a pointer absent from a file's entry may not change at all.
 *
 * Returns `null` for a path the adoption does not cover.
 */
export function adoptionRule(repoPath, spec) {
  const ver = versionOf(repoPath);
  const rel = ver ? repoPath.split(`/${ver}/`)[1] : null;

  if (ver && repoPath.startsWith(`${STANDARD}/schemas/`)) {
    if (rel === "opportunity.schema.json") {
      return {
        kind: "json",
        // $id, and the two self-identification examples the schema teaches. Nothing else: the
        // constraints are the contract and this exemption is about spelling, not meaning.
        pointers: {
          "/$id": schemaUrl(spec, ver),
          "/properties/$schema/examples/0": schemaUrl(spec, ver),
          "/properties/@context/examples/0": contextUrl(spec, ver),
        },
      };
    }
    if (rel === "context.jsonld") {
      return { kind: "json", pointers: { "/@context/@vocab": spec.vocabIri } };
    }
    if (rel === "FROZEN") return { kind: "marker" };
    if (INFORMATIVE.includes(rel)) return { kind: "informative" };
    return null;
  }

  if (ver && repoPath.startsWith(`${STANDARD}/conformance/`)) {
    // The two fixtures that exist to demonstrate self-identification, and therefore quote the
    // identifiers. Every other conformance case is data and may not move.
    if (rel === "pass/self-identification.json") {
      return {
        kind: "json",
        pointers: { "/$schema": schemaUrl(spec, ver), "/@context": contextUrl(spec, ver) },
      };
    }
    if (rel === "pass/full-featured.json") {
      return { kind: "json", pointers: { "/$schema": schemaUrl(spec, ver) } };
    }
    return null;
  }

  // The versionless normative artifacts. codegen re-stamps these two `$id`s from `baseUrl`, and
  // that is the entire permitted change — proven by parsing, not by filtering the `$id` line.
  if (
    repoPath.startsWith(`${STANDARD}/meta/`) ||
    repoPath === `${STANDARD}/registries/entry.schema.json`
  ) {
    return { kind: "json", pointers: { "/$id": canonicalUrl(spec, repoPath) } };
  }

  return null;
}

// ------------------------------------------------------------------------ git plumbing ---

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** The repository reads this gate needs, isolated so the rules can be tested without a clone. */
export function gitRepo(cwd = process.cwd()) {
  return {
    changed(base, head) {
      const out = git(cwd, ["diff", "--name-status", "-z", base, head, "--", ...WATCHED]);
      const fields = out.split("\0").filter((s) => s !== "");
      const entries = [];
      for (let i = 0; i < fields.length; i++) {
        const status = fields[i][0];
        // Rename/copy entries carry two paths; the destination is what the rules judge.
        const span = status === "R" || status === "C" ? 2 : 1;
        i += span;
        entries.push({ status, path: fields[i] });
      }
      return entries;
    },
    read(rev, path) {
      try {
        if (git(cwd, ["cat-file", "-t", `${rev}:${path}`]).trim() !== "blob") return null;
        return git(cwd, ["show", `${rev}:${path}`]);
      } catch {
        return null;
      }
    },
    frozenVersions(rev) {
      const out = git(cwd, ["ls-tree", "-r", "--name-only", rev, "--", `${STANDARD}/schemas`]);
      return out
        .split("\n")
        .map((line) => line.match(/^packages\/standard\/schemas\/(v[^/]+)\/FROZEN$/)?.[1])
        .filter((v) => v !== undefined);
    },
  };
}

// ------------------------------------------------------------------------- the gate ---

/**
 * Evaluate one base..head pair. Pure with respect to `repo`, so the tests drive it with an
 * in-memory repository and the bypass attempts are reproducible without a clone.
 *
 * @returns {{ok: boolean, notes: string[], violations: string[]}}
 */
export function evaluate(repo, baseSha, headSha) {
  const notes = [];
  const violations = [];
  const fail = (msg, detail = []) =>
    violations.push([msg, ...detail.map((d) => `    ${d}`)].join("\n"));

  const changed = repo.changed(baseSha, headSha);
  if (changed.length === 0)
    return { ok: true, notes: ["no normative spec artifact touched"], violations };

  const specAt = (rev) => {
    const text = repo.read(rev, `${STANDARD}/spec.config.json`);
    return text === null ? null : JSON.parse(text);
  };
  const baseSpec = specAt(baseSha);
  const headSpec = specAt(headSha);
  if (headSpec === null) {
    fail(`${STANDARD}/spec.config.json is absent at HEAD — the spec has no identity to check`);
    return { ok: false, notes, violations };
  }

  const specTouched = changed.some((c) => c.path === `${STANDARD}/spec.config.json`);
  const frozenAtBase = new Set(repo.frozenVersions(baseSha));
  const anyFrozen = frozenAtBase.size + repo.frozenVersions(headSha).length > 0;

  // ---------------- the one sanctioned identity change: provisional -> canonical, once ----
  let adoption = false;
  if (specTouched) {
    const baseStatus = baseSpec?.identityStatus ?? "provisional";
    const headStatus = headSpec.identityStatus ?? "provisional";
    if (baseStatus === "canonical" && headStatus !== "canonical") {
      fail(`identityStatus moves canonical -> ${headStatus}. Adoption is irreversible:`, [
        "reverting it would re-arm the one-time exemption for a later change.",
      ]);
    } else if (baseStatus === "provisional" && headStatus === "canonical") {
      const problem = adrProblem(repo, headSha, headSpec);
      if (problem === null) {
        adoption = true;
        notes.push(
          `one-time identity adoption (provisional -> canonical), recorded in ${headSpec.identityAdoption.adr}`,
        );
      } else {
        fail("identityStatus moves provisional -> canonical, but identityAdoption.adr is not a", [
          `usable decision record: ${problem}`,
        ]);
      }
    }
  }

  // ---------------- versioned directories -------------------------------------------------
  const versionedViolations = violations.length;
  for (const { status, path } of changed) {
    const ver = versionOf(path);
    if (ver === null) continue;
    if (frozenAtBase.has(ver)) {
      // Frozen at base. Only the informative documents named in NORMATIVE.md may be corrected,
      // and only by modification: adding to or deleting from a published directory is not a
      // correction. PROCESS.md keeps its promise; the schema, context, examples and the whole
      // conformance suite stay immutable.
      const rel = path.split(`/${ver}/`)[1];
      const informative =
        path.startsWith(`${STANDARD}/schemas/`) && INFORMATIVE.includes(rel) && status === "M";
      if (!informative) {
        fail(`${ver} is FROZEN and this change edits a document that is not a corrigible one:`, [
          `${status}  ${path}`,
          `corrigible in a frozen version: ${INFORMATIVE.join(", ")} (modification only)`,
        ]);
      }
    } else if (adoption) {
      // The adoption window. NOT "the first freeze may finish anything" — every changed path
      // must be on the allowlist and every changed value must be a derived identifier.
      checkAgainstAdoption(repo, baseSha, headSha, headSpec, { status, path }, fail);
    }
  }
  if (violations.length === versionedViolations) {
    for (const ver of new Set(changed.map((c) => versionOf(c.path)).filter((v) => v !== null))) {
      if (frozenAtBase.has(ver)) {
        notes.push(`${ver} is FROZEN, and only its informative documents were corrected`);
      } else {
        notes.push(
          adoption
            ? `${ver} is not frozen at base, and every change to it is a derived identifier (adoption)`
            : `${ver} is not frozen`,
        );
      }
    }
  }

  // ---------------- versionless normative artifacts ---------------------------------------
  const versionless = changed.filter(
    (c) =>
      c.path.startsWith(`${STANDARD}/meta/`) ||
      c.path === `${STANDARD}/registries/entry.schema.json`,
  );
  if (anyFrozen && versionless.length > 0) {
    if (adoption) {
      const before = violations.length;
      for (const entry of versionless) {
        checkAgainstAdoption(repo, baseSha, headSha, headSpec, entry, fail);
      }
      if (violations.length === before) {
        notes.push(
          "versionless normative artifacts re-stamp their $id and nothing else (adoption)",
        );
      }
    } else {
      fail("a frozen version exists and this change edits versionless normative artifacts:", [
        ...versionless.map((c) => `${c.status}  ${c.path}`),
      ]);
    }
  }

  // ---------------- spec.config.json identity fields --------------------------------------
  if (anyFrozen && specTouched) {
    const identity = (s) => (s === null ? "<absent>" : `${s.baseUrl} ${s.vocabIri}`);
    if (identity(baseSpec) === identity(headSpec)) {
      notes.push("spec.config.json touched, but identity fields (baseUrl, vocabIri) are unchanged");
    } else if (adoption) {
      notes.push("spec.config.json identity fields adopted under the one-time exemption:");
      notes.push(`  base: ${identity(baseSpec)}`);
      notes.push(`  head: ${identity(headSpec)}`);
    } else {
      fail("a frozen version exists and this change edits spec.config.json identity fields:", [
        `base: ${identity(baseSpec)}`,
        `head: ${identity(headSpec)}`,
      ]);
    }
  }

  return { ok: violations.length === 0, notes, violations };
}

/**
 * Is `identityAdoption.adr` a decision record that actually records THIS adoption?
 *
 * The previous gate proved only that the configured path resolved to something — `git cat-file -e`
 * succeeds for a tree, so `"adr"` or an unrelated blob opened the exemption. A governance gate
 * that accepts `package.json` as its own justification is not a governance gate.
 *
 * @returns {string|null} the reason it is not, or null when it is.
 */
function adrProblem(repo, headSha, headSpec) {
  const adr = headSpec.identityAdoption?.adr;
  if (!adr) return "no path is configured";
  if (!ADR_PATH.test(adr)) return `'${adr}' is not a decision record path (adr/NNNN-slug.md)`;
  const text = repo.read(headSha, adr);
  if (text === null) return `'${adr}' is not a file at HEAD`;
  if (!/^-\s+\*\*Status:\*\*\s*accepted\s*$/im.test(text)) {
    return `'${adr}' does not carry '- **Status:** accepted'`;
  }
  // It must describe the identity being adopted, not merely exist.
  for (const [field, value] of [
    ["baseUrl", headSpec.baseUrl],
    ["vocabIri", headSpec.vocabIri],
  ]) {
    if (!text.includes(value)) return `'${adr}' never names the ${field} it sanctions ('${value}')`;
  }
  return null;
}

/** One changed path, judged against the adoption allowlist. */
function checkAgainstAdoption(repo, baseSha, headSha, headSpec, { status, path }, fail) {
  const rule = adoptionRule(path, headSpec);
  if (rule === null) {
    return fail("the identity adoption may not touch this file:", [
      `${status}  ${path}`,
      "the exemption covers identifier fields in the schema, the context, the two",
      "self-identification fixtures and the versionless $ids — nothing else.",
    ]);
  }
  if (rule.kind === "informative") return;
  if (rule.kind === "marker") {
    if (status !== "A") {
      return fail("the FROZEN marker may only be ADDED by the change that freezes a version:", [
        `${status}  ${path}`,
      ]);
    }
    return;
  }
  if (status !== "M") {
    return fail("the identity adoption may only MODIFY an existing normative artifact:", [
      `${status}  ${path}`,
    ]);
  }

  const baseText = repo.read(baseSha, path);
  const headText = repo.read(headSha, path);
  let baseDoc;
  let headDoc;
  try {
    baseDoc = JSON.parse(baseText);
    headDoc = JSON.parse(headText);
  } catch (error) {
    return fail(`${path} is not parseable JSON on both sides of the change:`, [String(error)]);
  }

  const differing = diffPointers(baseDoc, headDoc);
  const allowed = Object.keys(rule.pointers);
  const stray = differing.filter((ptr) => !allowed.includes(ptr));
  if (stray.length > 0) {
    return fail(`${path} changes more than its identifiers under the adoption exemption:`, [
      ...stray.map((ptr) => `unexpected change at ${ptr}`),
      `permitted here: ${allowed.join(", ")}`,
    ]);
  }
  const substitutions = [];
  for (const ptr of differing) {
    const was = atPointer(baseDoc, ptr);
    const got = atPointer(headDoc, ptr);
    const want = rule.pointers[ptr];
    if (got !== want) {
      return fail(`${path} does not adopt the identifier spec.config.json derives:`, [
        `at ${ptr}`,
        `expected: ${want}`,
        `found:    ${got}`,
      ]);
    }
    if (typeof was !== "string") {
      return fail(`${path} does not REPLACE a published identifier under the exemption:`, [
        `at ${ptr}, the base document has ${was === undefined ? "no value" : JSON.stringify(was)}`,
        "the adoption re-spells identifiers that were already published; it does not add them.",
      ]);
    }
    substitutions.push([JSON.stringify(was), JSON.stringify(got)]);
  }

  // Structure agreed. Now the bytes, because "immutable bytes" is the promise being kept.
  const drift = bytesBeyondIdentifiers(baseText, headText, substitutions);
  if (drift !== null) {
    fail(`${path} changes published bytes the adoption exemption does not cover:`, [
      drift,
      "under the exemption a file must be its own base bytes with the identifier strings",
      "substituted — no reflow, no re-escaping, no incidental edit.",
    ]);
  }
}

// ------------------------------------------------------------------------------- CLI ---

export const FAILURE_MESSAGE = `
A published spec version is immutable once frozen — the schema, its context, the examples it
shipped, its conformance suite, and the versionless artifacts it rests on. Breaking changes take
a NEW version directory; the previous one stays published and unedited, forever.

The INFORMATIVE documents of a frozen version (${INFORMATIVE.join(", ")})
stay corrigible, because packages/standard/NORMATIVE.md says they carry no conformance weight and
PROCESS.md says they may be corrected at any time. Everything else in the directory is bytes a
consumer may have hashed.

If you believe the freeze itself is wrong, that is a governance question: open an issue
(GOVERNANCE.md). Do not remove the marker to land a change.

On identifiers specifically: the provisional -> canonical adoption was a one-time, pre-declared
event and it has been spent (adr/0007). identityStatus reads \`canonical\` and there is no second
transition. An identifier on a frozen version is frozen bytes; changing one takes a NEW spec
version like any other breaking change.
`;

export function main(argv) {
  const [baseSha, headSha] = argv;
  if (!baseSha || !headSha) {
    console.error("usage: node scripts/spec-freeze.mjs <BASE_SHA> <HEAD_SHA>");
    return 2;
  }
  if (/^0+$/.test(baseSha)) {
    console.log("✓ no base to compare against (branch creation) — nothing to check");
    return 0;
  }
  const { ok, notes, violations } = evaluate(gitRepo(), baseSha, headSha);
  for (const note of notes) console.log(`✓ ${note}`);
  for (const violation of violations) console.error(`✗ ${violation}`);
  if (!ok) {
    console.error(FAILURE_MESSAGE);
    return 1;
  }
  console.log("✓ no frozen spec artifact was modified");
  return 0;
}

// Both sides are resolved through realpath before they are compared. `import.meta.url` is ALWAYS
// the resolved path; `process.argv[1]` is whatever the caller typed. Compare them raw and a run
// through a symlink — `/tmp` -> `/private/tmp` on macOS, any symlinked `$RUNNER_TEMP`, a symlinked
// checkout — makes them differ, `main()` never runs, and the gate exits 0 having graded nothing.
// A gate whose failure mode is a silent pass is worse than no gate, and the workflow's own recipe
// (`git show BASE:… > "$RUNNER_TEMP/base-gate/spec-freeze.mjs"; node "$gate" …`) is exactly that
// shape. `scripts/spec-freeze.test.mjs` runs the gate through a symlinked directory to pin this.
if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  process.exitCode = main(process.argv.slice(2));
}
