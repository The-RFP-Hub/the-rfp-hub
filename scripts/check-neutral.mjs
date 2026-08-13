// Source-neutrality and identity lint, repo-wide, over TRACKED files.
//
// This repository is public and source-neutral. Two classes of string must never appear in it:
//
//   NEUTRALITY — an internal issue-tracker ID, or the NAME of the commissioning platform. The
//     standard is CC0 and designed to be embedded, forked and code-generated from, so a tracker ID
//     inside it travels into every downstream copy and points at a system nobody outside this
//     project can read; a source brand name turns a source-neutral standard into one vendor's
//     document. This rule previously matched tracker IDs only, so a brand name could enter the
//     schemas, the API, the docs or a workflow with every required check green.
//
//     Neutrality is a rule about the project's OWN VOICE. It does not reach the verbatim primary
//     sources the project has archived — see ARCHIVED_SOURCE below, the only path exemption here.
//
//   IDENTITY — a retired identifier, a URL on a domain the project does not own, or a plaintext
//     variant of the canonical domain. `packages/standard/scripts/check-spec.mjs` sweeps for these
//     too, but it walks the PACKAGE only (it has to: it also runs from an extracted tarball), so an
//     old schema URL reintroduced in an API test, a workflow or a root document was invisible to
//     every check the project runs. The package-local copy stays; this one covers everything else.
//
// TRACKED files, via `git ls-files`: an untracked local report or a scratch file must not be able
// to fail CI, and — more importantly — must not be able to hide a real violation behind noise. A
// tracked file this scanner cannot read as text is NAMED and COUNTED rather than dropped from the
// denominator — see `classifyTracked`, and the incident that rule exists for.
//
// The forbidden strings are assembled from parts throughout, so this file does not trip its own
// rules. There is no skip comment and no way for a file to silence a rule from the inside; the one
// exemption is the archived interview record, defined and bounded at ARCHIVED_SOURCE.
//
// Run with `pnpm check:neutral`. Exits non-zero on any hit.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(repoRoot, "packages/standard/spec.config.json"), "utf8"));

// --------------------------------------------------------------------------- neutrality ---

/** An internal issue-tracker ID. Unreadable to everyone downstream. */
const TRACKER_ID = /\bDEV-\d+\b/g;

/**
 * The commissioning platform's name and the identifiers derived from it.
 *
 * `kar`+`ma` is matched WITHOUT a word boundary: it is a distinctive token with no ordinary-English
 * use, so any occurrence — `…hq`, `show-…`, a possessive — is the brand. The other token is a
 * three-letter ordinary English word ("a gap in coverage") and appears in lockfile integrity hashes,
 * so a raw substring ban would be unusable; it is matched only in the shapes a NAME takes — a
 * product compound, an npm scope, or a hostname label. That distinction is the rule, not a
 * convenience: this check has to be something a contributor can satisfy by writing plain English.
 */
const BRAND = ["kar", "ma"].join("");
const OTHER = ["g", "ap"].join("");
const BRAND_PATTERNS = [
  [new RegExp(BRAND, "gi"), "the source platform's name"],
  [new RegExp(`\\b(?:show-)?${OTHER}(?:-|_)?(?:api|indexer|hq)\\b`, "gi"), "a source product name"],
  [new RegExp(`@${OTHER}/`, "gi"), "a source npm scope"],
];

/**
 * A hostname LABEL that is exactly the source token — the one place the three-letter word is
 * unambiguously a name rather than English, because a DNS label is a name by construction.
 */
const BRAND_HOST_LABEL = new RegExp(`^${OTHER}$`, "i");

// ------------------------------------------------------------------- archived source material ---

/**
 * THE INTERVIEW ARCHIVE IS EXEMPT FROM THE NEUTRALITY RULE. This is a deliberate boundary, decided
 * by the maintainers, and not an oversight — do not "fix" the files listed below to make this
 * checker quieter.
 *
 * `user-interviews/` is a HISTORICAL RECORD: dated interview notes and the research synthesis built
 * from them, quoting real organizations and named interviewees who agreed to be quoted. Neutrality
 * governs the project's own voice — its code, schemas, documentation, workflows and commit messages
 * — because that is what travels downstream into every fork of a CC0 standard. It was never a rule
 * about what a third party said. Editing a primary source so that it reads as source-neutral
 * protects nothing: it falsifies the record. A research report whose audited dataset has been
 * quietly renamed to "an existing grants platform" is no longer evidence of anything, and a reader
 * cannot tell which of its other attributions were also rewritten.
 *
 * Three limits stop this from becoming a hole:
 *
 *   1. RULE — only `source-neutral` is waived, and only here. Every other rule still applies to
 *      these files: an internal tracker ID is not something a respondent said, and a retired or
 *      off-domain identifier in an archived file is still an identifier a reader may copy. Nothing
 *      about the brand rule itself is weakened for the rest of the repository.
 *   2. PATH — the waiver is an explicit list of the filed records, NOT the directory, so it FAILS
 *      CLOSED. A file added to `user-interviews/` later is checked like every other file until
 *      someone adds it here on purpose, in a reviewed diff. A project-voice document cannot acquire
 *      the waiver just by being moved into the folder.
 *   3. VOICE — `user-interviews/README.md` is deliberately absent from the list. It is the project
 *      describing its own archive, so it is the project's voice and is held to the project's rule.
 *
 * Adding an entry is a claim that the file is verbatim archived source material — a filed record of
 * what someone outside this project said, or a synthesis that quotes them — and that it is
 * published with the consent recorded in `user-interviews/README.md`.
 */
const ARCHIVE_WAIVED_RULES = new Set(["source-neutral"]);

const ARCHIVED_SOURCE = new Set([
  "user-interviews/Aggregator-Cornaro-Labs-2026-07-17.md",
  "user-interviews/Aggregator-Grant-Wire.md",
  "user-interviews/Builder-Adedalapo-BitGifty.md",
  "user-interviews/Builder-Argot-Collective-2026-07-16.md",
  "user-interviews/Builder-Cactus-ScopeLift-2026-07-15.md",
  "user-interviews/Builder-Climate-Collective-2026-07-28.md",
  "user-interviews/Builder-CoBuilders-2026-07-14.md",
  "user-interviews/Builder-Marco-Barbosa.md",
  "user-interviews/Builder-Namespace-2026-07-27.md",
  "user-interviews/Builder-Remix.md",
  "user-interviews/Builder-Revoke-cash-2026-07-28.md",
  "user-interviews/M1-Research-Report.md",
  "user-interviews/Publisher-CoW-DAO.md",
  "user-interviews/Publisher-DAO-Security-Fund-2026-07-23.md",
  "user-interviews/Publisher-EF-Grants.md",
  "user-interviews/Publisher-ENS-DAO.md",
  "user-interviews/Publisher-Uniswap.md",
  "user-interviews/Researcher-BlockchainGov-2026-07-30.md",
  "user-interviews/Researcher-Weizenbaum-Institute-2026-07-31.md",
]);

/** Whether `rule` is waived for `file`. The path must match a listed record exactly. */
const isWaived = (file, rule) => ARCHIVED_SOURCE.has(file) && ARCHIVE_WAIVED_RULES.has(rule);

// ----------------------------------------------------------------------------- identity ---

/**
 * The project does not own the domain this standard's identifiers used to be minted on. An
 * identifier on a domain nobody controls is worse than a provisional one: it looks final, it never
 * dereferences, and every downstream fork inherits it.
 */
const UNOWNED_DOMAIN = new RegExp(`\\b${["rfphub", "org"].join("\\.")}\\b`, "g");

/** The npm scope was renamed to match the org. `@the-rfp-hub/` does not match this. */
const RETIRED_SCOPE = new RegExp(`@${["rfp", "hub"].join("-")}/`, "g");

/**
 * The identifiers this package published while its domain was undecided (2026-07 → 2026-08-10).
 * Matched as the FULL live URL only, so the CHANGELOG's deliberately scheme-less historical prose
 * and the ADRs' references to the old HOST survive. Both are dead — see adr/0007.
 */
const RETIRED_IDENTIFIERS = [
  ["https://raw.", "githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/packages/standard"].join(""),
  ["https://github.com/The-RFP-Hub/the-rfp-hub/ns/", "draft", "/rfp"].join(""),
];

const URL_TOKEN = /https?:\/\/[^\s"'`<>\\)\]]+/g;
const trimUrl = (u) => u.replace(/[.,;:!?'"`]+$/, "");

/**
 * A vocabulary-namespace-shaped URL: an `/ns/…rfp` path on ANY authority. Deliberately not derived
 * from the current vocabIri's own path — the point is to catch a RETIRED namespace as well as a
 * typo in the current one. Foreign `/ns/` IRIs the docs legitimately cite, such as w3.org's
 * JSON-LD link relation, do not match.
 */
const VOCAB_SHAPED = /\/ns\/[a-z0-9/-]*rfp(?![a-z0-9-])/i;

/**
 * RFC 2606 / RFC 6761 reserved names. An identifier can never be minted under one of these, which
 * is exactly why a test fixture or a counterfactual uses them. Exempting them is not a hole: it is
 * the difference between "an identifier that is wrong" and "a name reserved for saying so".
 */
const RESERVED_HOST = /(^|\.)(invalid|test|example|localhost)$|^example\.(com|net|org)$/i;

const CANONICAL_HOST = new URL(spec.baseUrl).host;

// -------------------------------------------------------------------------------- scan ---

/**
 * Every failure in one file's text. Exported so the rules can be tested without a repository.
 *
 * `file` is the repo-relative path and is load-bearing, not just a label: it is what decides
 * whether a hit falls inside the archived-source waiver above. The same line of text is a
 * violation in a schema, a workflow or a README and is not one in a filed interview record.
 */
export function scanText(file, text) {
  const failures = [];
  const at = (line, rule, message) => {
    if (isWaived(file, rule)) return;
    failures.push({ file, line, rule, message });
  };
  const lines = text.split("\n");

  for (const [i, line] of lines.entries()) {
    const n = i + 1;

    const ids = line.match(TRACKER_ID);
    if (ids) at(n, "tracker-id", `internal tracker ID(s): ${[...new Set(ids)].join(", ")}`);

    for (const [pattern, what] of BRAND_PATTERNS) {
      const hits = line.match(pattern);
      if (hits) at(n, "source-neutral", `${what} ('${[...new Set(hits)].join("', '")}')`);
    }

    const unowned = line.match(UNOWNED_DOMAIN);
    if (unowned) {
      at(
        n,
        "identity",
        `the retired placeholder domain (${unowned[0]}) — the project does not own it. The canonical domain is ${CANONICAL_HOST}`,
      );
    }

    const scope = line.match(RETIRED_SCOPE);
    if (scope) at(n, "identity", `the retired npm scope (${scope[0]})`);

    for (const retired of RETIRED_IDENTIFIERS) {
      if (line.includes(retired)) {
        at(n, "identity", `a retired provisional identifier ('${retired}') — see adr/0007`);
      }
    }

    for (const raw of line.match(URL_TOKEN) ?? []) {
      const url = trimUrl(raw);
      let host = null;
      try {
        host = new URL(url).host;
      } catch {
        continue; // not a parseable URL — an ellipsis in prose, a template placeholder
      }
      const reserved = RESERVED_HOST.test(host);

      // Identifier-shaped: a versioned schema-directory URL naming a JSON artifact. Restricted to
      // `.json`/`.jsonld` because a repository is also browsed by URL, and a `blob/main/…/FIELDS.md`
      // link into this repo's own source tree is a link, not an identifier.
      if (
        !reserved &&
        /\/schemas\/v\d/.test(url) &&
        /\.jsonl?d?$/.test(new URL(url).pathname) &&
        !url.startsWith(`${spec.baseUrl}/schemas/v`)
      ) {
        at(n, "identity", `schema URL '${url}' is not under '${spec.baseUrl}/schemas/'`);
      }
      if (
        !reserved &&
        VOCAB_SHAPED.test(url) &&
        !url.startsWith(spec.vocabIri) &&
        `${url}#` !== spec.vocabIri
      ) {
        at(n, "identity", `vocab IRI '${url}', expected '${spec.vocabIri}'`);
      }
      // `.app` is HSTS-preloaded: a browser will not issue a plaintext request to it at all, so
      // an http:// URL here is not a lenient alternative, it is a broken one.
      if (
        url.startsWith("http://") &&
        (host === CANONICAL_HOST || host.endsWith(`.${CANONICAL_HOST}`))
      ) {
        at(n, "identity", `plaintext URL '${url}' — every URL on ${CANONICAL_HOST} is https`);
      }
      if (host.split(".").some((label) => BRAND_HOST_LABEL.test(label))) {
        at(n, "source-neutral", `a source-branded hostname ('${host}')`);
      }
    }
  }
  return failures;
}

/**
 * WHY A SKIP IS REPORTED RATHER THAN SUBTRACTED.
 *
 * This checker cannot scan a file it cannot read as text, and that is fine — what is not fine is
 * doing it quietly. A single NUL byte anywhere in the first 8 KiB makes Git treat a file as binary
 * and makes this scanner drop it, and that has already happened here: a 522-line script carried a
 * literal NUL as a delimiter, so it was excluded from `git diff` AND excluded from this scan, and
 * the summary line still said "N tracked files, zero violations". The denominator moved and nobody
 * could tell. One byte in one file is enough to make the most security-sensitive file in a change
 * invisible to review and to this rule at the same time.
 *
 * So a skipped file is a reported file: counted, named, printed on stderr with its reason, and
 * carried into the summary line as "X of Y" whether the run passes or fails. "Zero violations" is
 * only ever a statement about the files that were actually read, and now it says so out loud.
 *
 * A skip is loud rather than fatal, deliberately: a repository is allowed to track an image, and a
 * rule that fails on the first one added gets deleted rather than fixed. What it is not allowed to
 * do is track SOURCE this checker cannot read — and the "X of Y" on the green line is what makes
 * that visible without anyone having to go looking.
 *
 * @returns {{rel: string, skip: string|null}} the reason this file cannot be scanned, or null.
 */
export function classifyTracked(rel, buf) {
  if (buf === null) {
    return { rel, skip: "tracked but not present in the working tree" };
  }
  if (buf.subarray(0, 8192).includes(0)) {
    return { rel, skip: "not text — a NUL byte in the first 8 KiB, so Git treats it as binary" };
  }
  return { rel, skip: null };
}

/** Every tracked path, classified. `git ls-files` is the point: ignored scratch files cannot vote. */
function trackedFiles() {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "");
  if (listed.length === 0) throw new Error("check-neutral: `git ls-files` returned nothing");
  return listed.map((rel) => {
    let buf = null;
    try {
      buf = readFileSync(join(repoRoot, rel));
    } catch {
      buf = null; // deleted-but-tracked; the commit that removes it will settle this
    }
    return classifyTracked(rel, buf);
  });
}

function main() {
  const classified = trackedFiles();
  const skipped = classified.filter((c) => c.skip !== null);
  const files = classified.filter((c) => c.skip === null).map((c) => c.rel);

  if (skipped.length > 0) {
    console.error(
      `⚠ check-neutral: ${skipped.length} of ${classified.length} tracked file(s) could NOT be scanned.
  They are not covered by the result below — check each one by hand, and if it is source rather
  than an asset, make it text:`,
    );
    for (const { rel, skip } of skipped) console.error(`  ${rel}  — ${skip}`);
  }

  // A waiver for a path that no longer exists is a waiver nobody is reading. Renaming or deleting
  // an archived record must force the list to be revisited, so the exemption cannot quietly
  // outlive the record it was granted for.
  const tracked = new Set(files);
  const stale = [...ARCHIVED_SOURCE].filter((rel) => !tracked.has(rel));
  if (stale.length > 0) {
    console.error(
      "✗ check-neutral: ARCHIVED_SOURCE lists path(s) that are not tracked text files — a moved or\n" +
        "  deleted archived record leaves a waiver behind. Update the list in this script:",
    );
    for (const rel of stale) console.error(`  ${rel}`);
    process.exit(1);
  }

  const failures = files.flatMap((rel) => scanText(rel, readFileSync(join(repoRoot, rel), "utf8")));

  const skippedNote = skipped.length > 0 ? `, ${skipped.length} NOT scanned (listed above)` : "";
  const scanned = `${files.length} of ${classified.length} tracked files scanned${skippedNote}`;

  if (failures.length > 0) {
    console.error(
      `✗ check-neutral: ${failures.length} violation(s) in a public, source-neutral repo (${scanned})`,
    );
    for (const f of failures) console.error(`  [${f.rule}] ${f.file}:${f.line}  ${f.message}`);
    console.error(
      "\n  Neutrality: describe the decision in plain language, or link a public artifact (an ADR,\n" +
        "  an issue in this repo). Internal tracker IDs and the commissioning platform's name are\n" +
        "  unreadable or misleading to everyone downstream — the standard is CC0 and vendor-neutral.\n" +
        "  Identity: every identifier comes from packages/standard/spec.config.json, is https, and\n" +
        "  lives on the canonical domain. Retired ones are dead — see adr/0007.\n" +
        "  Archived source: if the hit is inside user-interviews/, do NOT rewrite the record to\n" +
        "  satisfy this rule — neutrality governs the project's voice, not what a respondent said.\n" +
        "  Add the file to ARCHIVED_SOURCE in scripts/check-neutral.mjs instead, and say why.",
    );
    process.exit(1);
  }

  console.log(
    `✓ check-neutral: ${scanned} — no tracker IDs, no source branding, ` +
      `no retired or off-domain identifiers, no plaintext ${CANONICAL_HOST} URLs ` +
      `(${ARCHIVED_SOURCE.size} archived primary sources exempt from the neutrality rule only)`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
