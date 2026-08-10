// Publication rules for the standard — the thing that has to be true before a cut ships.
//
// Three classes of failure, all of which have bitten comparable projects:
//   1. CONTEXT DRIFT   — the JSON-LD context and the schema describe different vocabularies.
//                        Hand-maintained contexts drift within one release; there is no
//                        runtime that would notice, so CI has to.
//   2. VERSION DRIFT   — a version string hand-written somewhere disagrees with
//                        spec.config.json. Everything derivable is stamped by codegen; this
//                        catches the places a human can still type one.
//   2b. IDENTITY SWEEP — a hand-written copy of a spec identifier (a schemas/v* URL in a
//                        conformance fixture, an example, or doc prose; the vocab IRI in a
//                        status note) that codegen does not own and would survive a domain
//                        swap unchanged. Every identity-shaped URL anywhere in the package
//                        must agree with spec.config.json, however it got there.
//   2c. MATURITY       — `status` and the FROZEN marker are two halves of one fact, written
//                        in two places. If they disagree, either a stable version is quietly
//                        editable or a frozen one still advertises itself as a draft. This
//                        rule existed only in PROCESS.md prose until 2026-08-10; it is
//                        mechanised here because that is the release checklist item most
//                        likely to be forgotten in the one release that performs it.
//   3. NEUTRALITY      — an internal issue-tracker ID inside a CC0 artifact that is
//                        designed to be embedded, forked and code-generated from. One leak
//                        in a normative field description travels into every downstream copy.
//                        Also: an identifier on a domain the project does not own, and any
//                        reappearance of a RETIRED identifier — the placeholder domain, the
//                        old npm scope, or the provisional base/vocab URLs this package
//                        published before it adopted its canonical domain.
//
// Run with `pnpm --filter @the-rfp-hub/standard check`. Exits non-zero on any failure.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const p = (...parts) => resolve(pkgRoot, ...parts);
const readText = (f) => readFileSync(f, "utf8");
const readJson = (f) => JSON.parse(readText(f));

const failures = [];
const fail = (rule, message) => failures.push(`[${rule}] ${message}`);

const spec = readJson(p("spec.config.json"));
const schema = readJson(p(spec.schemaDir, "opportunity.schema.json"));
const context = readJson(p(spec.schemaDir, "context.jsonld"))["@context"];

// ------------------------------------------------------- 1. context drift ---
// Every top-level schema property must have a context term, or an instance loses meaning
// when it is read as linked data. Self-identification keys are JSON-LD keywords already.
const SELF_ID = new Set(["$schema", "@context", "@type"]);
// Terms that are JSON-LD machinery or prefix declarations rather than schema fields.
const CONTEXT_MACHINERY = new Set(["@version", "@vocab", "schema", "daoip5"]);

/** Every property name anywhere in the schema — top level, $defs, nested objects. */
function collectPropertyNames(node, into = new Set()) {
  if (!node || typeof node !== "object") return into;
  if (Array.isArray(node)) {
    for (const item of node) collectPropertyNames(item, into);
    return into;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && value && typeof value === "object") {
      for (const name of Object.keys(value)) into.add(name);
    }
    collectPropertyNames(value, into);
  }
  return into;
}

const allSchemaProperties = collectPropertyNames(schema);
const topLevelProperties = Object.keys(schema.properties).filter((k) => !SELF_ID.has(k));
const contextTerms = Object.keys(context).filter((t) => !CONTEXT_MACHINERY.has(t));

for (const prop of topLevelProperties) {
  if (!contextTerms.includes(prop)) {
    fail("context-drift", `schema top-level property '${prop}' has no term in context.jsonld`);
  }
}
for (const term of contextTerms) {
  if (!allSchemaProperties.has(term)) {
    fail(
      "context-drift",
      `context.jsonld defines term '${term}', which is not a property anywhere in the schema`,
    );
  }
}

// ------------------------------------------------------- 2. version drift ---
const want = spec.specVersion;
const schemaBase = `${spec.baseUrl}/${spec.schemaDir}`;
const expectedId = `${schemaBase}/opportunity.schema.json`;
if (schema.$id !== expectedId) {
  fail("version-drift", `schema $id is '${schema.$id}', expected '${expectedId}'`);
}

// Every $id the package publishes is stamped from the same base, so a future domain
// decision is one edit in spec.config.json. Assert all three, not just the schema's.
for (const [file, expected] of [
  ["meta/rfphub-schema.meta.json", `${spec.baseUrl}/meta/rfphub-schema.meta.json`],
  ["registries/entry.schema.json", `${spec.baseUrl}/registries/entry.schema.json`],
]) {
  const actual = readJson(p(file)).$id;
  if (actual !== expected) {
    fail("version-drift", `${file} $id is '${actual}', expected '${expected}'`);
  }
}

// The self-identification examples teach a URL; it had better be one this cut publishes.
const schemaExample = schema.properties.$schema.examples?.[0];
if (schemaExample !== expectedId) {
  fail("version-drift", `$schema example is '${schemaExample}', expected '${expectedId}'`);
}
const contextExample = schema.properties["@context"].examples?.[0];
if (contextExample !== `${schemaBase}/context.jsonld`) {
  fail(
    "version-drift",
    `@context example is '${contextExample}', expected '${schemaBase}/context.jsonld'`,
  );
}

if (schema.properties.specVersion.const !== want) {
  fail(
    "version-drift",
    `specVersion const is '${schema.properties.specVersion.const}', expected '${want}'`,
  );
}
if (!schema.description.startsWith(`RFP Hub Standard v${want} —`)) {
  fail("version-drift", `schema description does not open with 'RFP Hub Standard v${want} —'`);
}
if (!new RegExp(`^${want.replace(/\./g, "\\.")}$`).test(want)) {
  fail("version-drift", `spec.config.json specVersion '${want}' is not a three-part version`);
}
if (context["@vocab"] !== spec.vocabIri) {
  fail("version-drift", `context @vocab is '${context["@vocab"]}', expected '${spec.vocabIri}'`);
}
if (/\d+\.\d+\.\d+/.test(spec.vocabIri)) {
  fail(
    "version-drift",
    `@vocab '${spec.vocabIri}' carries a version. Term IRIs must be versionless — version the context DOCUMENT, never the terms`,
  );
}
// A term IRI is @vocab CONCATENATED with the term, not resolved against it. Without a trailing
// '#' or '/', `@vocab` + `tracks` yields one fused string and every vocabulary term is wrong.
if (!/[#/]$/.test(spec.vocabIri)) {
  fail(
    "version-drift",
    `@vocab '${spec.vocabIri}' does not end in '#' or '/'. Terms are concatenated onto it, so without a delimiter every vocabulary term IRI is malformed`,
  );
}

const schemaTs = readText(p("src", "schema.ts"));
const specVersionConst = schemaTs.match(/export const SPEC_VERSION = "([^"]*)"/)?.[1];
if (specVersionConst !== want) {
  fail("version-drift", `src/schema.ts SPEC_VERSION is '${specVersionConst}', expected '${want}'`);
}

const registryIndex = readJson(p("registries", "index.json"));
if (registryIndex.specVersion !== want) {
  fail(
    "version-drift",
    `registries/index.json declares specVersion '${registryIndex.specVersion}'`,
  );
}

// ----------------------------------------------------- 2b. identity sweep ---
// Rule 2 checks the places codegen stamps. This sweeps everything else: any URL that is
// shaped like a spec identifier — a schema-directory URL or the vocabulary IRI — must be
// derived from spec.config.json, wherever it appears (fixtures, examples, doc prose).
// A domain swap that misses one of these is exactly the halfway state ARTIFACTS.md rules out.
const URL_TOKEN = /https?:\/\/[^\s"'`<>\\)\]]+/g;
const trimUrl = (u) => u.replace(/[.,;:!?'"`]+$/, "");

// A vocabulary-namespace-shaped URL: an `/ns/…rfp` path on ANY authority. Deliberately not
// derived from the current vocabIri's own path — the point is to catch a RETIRED namespace
// (which by definition has a different path) as well as a typo in the current one. Foreign
// `/ns/` IRIs the docs legitimately cite, such as w3.org's JSON-LD link relation, do not match.
const VOCAB_SHAPED = /\/ns\/[a-z0-9/-]*rfp(?![a-z0-9-])/i;

function sweepIdentityUrls(file, text) {
  for (const raw of text.match(URL_TOKEN) ?? []) {
    const url = trimUrl(raw);
    if (/\/schemas\/v\d/.test(url) && !url.startsWith(`${spec.baseUrl}/schemas/v`)) {
      fail(
        "identity-sweep",
        `${relative(pkgRoot, file)} carries schema URL '${url}', which is not under '${spec.baseUrl}/schemas/'`,
      );
    }
    if (VOCAB_SHAPED.test(url) && !url.startsWith(spec.vocabIri) && `${url}#` !== spec.vocabIri) {
      fail(
        "identity-sweep",
        `${relative(pkgRoot, file)} carries vocab IRI '${url}', expected '${spec.vocabIri}'`,
      );
    }
  }
}

// ---------------------------------------------------------- 2c. maturity ----
// `status` is the version's maturity on the spec axis and the vocabulary is closed: a version
// is being drafted or it is published and immutable. There is no third state, and `stable`
// without the FROZEN marker is the dangerous half — it reads as published while CI still lets
// the directory be edited.
const MATURITIES = ["draft", "stable"];
const frozenMarker = p(spec.schemaDir, "FROZEN");
const isFrozen = existsSync(frozenMarker);

if (!MATURITIES.includes(spec.status)) {
  fail(
    "maturity",
    `spec.config.json status is '${spec.status}', expected one of ${MATURITIES.map((s) => `'${s}'`).join(", ")} (PROCESS.md, "In-place re-cuts")`,
  );
} else if (spec.status === "stable" && !isFrozen) {
  fail(
    "maturity",
    `status is 'stable' but ${spec.schemaDir}/FROZEN is missing. Declaring a version stable is what freezes it — without the marker the freeze workflow lets the directory be edited`,
  );
} else if (spec.status === "draft" && isFrozen) {
  fail(
    "maturity",
    `${spec.schemaDir}/FROZEN exists but status is 'draft'. A frozen version is published; drop the marker or declare the version stable`,
  );
}

// The field reference opens with a maturity banner, and prose is where the two halves of this
// fact drift apart: FIELDS.md announced `draft` for the whole window in which spec.config.json
// already said `stable`. A reader reaches the banner before any machine-readable source, so the
// banner is checked against `status` rather than trusted to be updated by hand.
{
  const banner = readText(p(spec.schemaDir, "FIELDS.md")).split(/\r?\n/, 12).join("\n");
  const declared = banner.match(/\*\*Maturity:\s*`([a-z]+)`/)?.[1];
  if (!declared) {
    fail(
      "maturity",
      `${spec.schemaDir}/FIELDS.md has no '**Maturity: \`<status>\`' banner in its first 12 lines`,
    );
  } else if (declared !== spec.status) {
    fail(
      "maturity",
      `${spec.schemaDir}/FIELDS.md announces maturity '${declared}' but spec.config.json status is '${spec.status}'`,
    );
  }
}

// ---------------------------------------------- 2d. identity provenance -----
// Identifiers are provisional exactly once. `identityStatus` is the machine-readable record of
// which side of that line this package is on, and .github/workflows/spec-freeze.yml reads the
// same field: it permits an identity-field change ONLY on a provisional -> canonical transition
// naming an existing ADR. The checks below are what keep that field honest.
const IDENTITY_STATES = ["provisional", "canonical"];
if (!IDENTITY_STATES.includes(spec.identityStatus)) {
  fail(
    "identity-provenance",
    `spec.config.json identityStatus is '${spec.identityStatus}', expected one of ${IDENTITY_STATES.map((s) => `'${s}'`).join(", ")}`,
  );
}

for (const [field, value] of [
  ["baseUrl", spec.baseUrl],
  ["vocabIri", spec.vocabIri],
]) {
  // The canonical domain is an HSTS-preloaded TLD: browsers force HTTPS, so a plaintext
  // identifier is unreachable as well as wrong. There is deliberately no http:// variant of
  // this namespace — see ARTIFACTS.md's decline of dual http/https namespace IRIs.
  if (!value.startsWith("https://")) {
    fail("identity-provenance", `${field} '${value}' is not https://. Identifiers are https-only`);
  }
}

if (spec.identityStatus === "canonical") {
  const host = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return null;
    }
  };
  // One authority, or the vocabulary and the schemas are two different projects' identifiers.
  if (host(spec.baseUrl) !== host(spec.vocabIri)) {
    fail(
      "identity-provenance",
      `baseUrl host '${host(spec.baseUrl)}' and vocabIri host '${host(spec.vocabIri)}' differ — canonical identifiers share one authority`,
    );
  }
  // "Sanctioned" means there is a decision record, not that someone remembered a conversation.
  const repoRoot = resolve(pkgRoot, "..", "..");
  const adr = spec.identityAdoption?.adr;
  if (!adr) {
    fail(
      "identity-provenance",
      "identityStatus is 'canonical' but identityAdoption.adr names no decision record",
    );
  } else if (existsSync(join(repoRoot, "adr")) && !existsSync(join(repoRoot, adr))) {
    // Guarded on the decision log being present at all: this script also runs from an
    // extracted package tarball, which ships the spec but not the repository around it.
    fail("identity-provenance", `identityAdoption.adr points at '${adr}', which does not exist`);
  }
}

// --------------------------------------------------------- 3. neutrality ----
const TRACKER_ID = /\bDEV-\d+\b/g;
// The project does not own the domain this standard's identifiers used to be minted on. An
// identifier on a domain nobody controls is worse than a provisional one: it looks final, it
// never dereferences, and every downstream fork inherits it. Identifiers live in
// spec.config.json and nowhere else. Assembled from parts so this rule does not trip itself.
const UNOWNED_DOMAIN = new RegExp(`\\b${["rfphub", "org"].join("\\.")}\\b`, "g");
// The npm scope was renamed to match the org (@the-rfp-hub). The retired scope must never
// reappear — a stale build once shipped it inside a published tarball. Assembled from parts
// so this rule does not trip itself; "@the-rfp-hub/" does not match it.
const RETIRED_SCOPE = new RegExp(`@${["rfp", "hub"].join("-")}/`, "g");
// The identifiers this package published while its domain was undecided (2026-07 → 2026-08-10):
// a raw-repository base URL, and a vocabulary IRI with a `draft` maturity segment. The identity
// sweep above only catches copies that still LOOK like identifiers; a retired base URL can also
// survive in prose, a link, or a fixture path the sweep's shapes do not match. Both are dead —
// see adr/0007. Assembled from parts so this rule does not trip itself, and matching the full
// base only, so the CHANGELOG's historical prose about the host survives.
const RETIRED_IDENTIFIERS = [
  ["https://raw.", "githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/packages/standard"].join(""),
  ["https://github.com/The-RFP-Hub/the-rfp-hub/ns/", "draft", "/rfp"].join(""),
];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".turbo"]);
const TEXT_EXT = /\.(json|jsonld|ts|mjs|js|md|yml|yaml)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (TEXT_EXT.test(name)) out.push(full);
  }
  return out;
}

for (const file of walk(pkgRoot)) {
  const text = readText(file);
  sweepIdentityUrls(file, text);
  const hits = text.match(TRACKER_ID);
  if (hits) {
    fail(
      "neutrality",
      `${relative(pkgRoot, file)} contains internal tracker ID(s): ${[...new Set(hits)].join(", ")}`,
    );
  }
  const hits2 = text.match(UNOWNED_DOMAIN);
  if (hits2) {
    fail(
      "neutrality",
      `${relative(pkgRoot, file)} references the retired placeholder domain (${hits2[0]}) — the project does not own it. The canonical domain is ${new URL(spec.baseUrl).host}, and every identifier comes from spec.config.json`,
    );
  }
  for (const retired of RETIRED_IDENTIFIERS) {
    if (text.includes(retired)) {
      fail(
        "neutrality",
        `${relative(pkgRoot, file)} carries a retired provisional identifier ('${retired}'). Those were superseded by the canonical identity on ${new URL(spec.baseUrl).host} — see adr/0007`,
      );
    }
  }
  const hits3 = text.match(RETIRED_SCOPE);
  if (hits3) {
    fail(
      "neutrality",
      `${relative(pkgRoot, file)} references the retired npm scope (${hits3[0]}) — the package publishes as @the-rfp-hub/standard`,
    );
  }
}

// ------------------------------------------------------------------ report --
if (failures.length > 0) {
  console.error(`✗ check-spec: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `✓ check-spec: context covers ${topLevelProperties.length} top-level terms, identifiers all ${spec.identityStatus} and stamped from spec.config.json (${spec.baseUrl}), identity sweep found no stray schema/vocab URLs, maturity '${spec.status}' agrees with ${isFrozen ? "a present" : "no"} FROZEN marker, version strings agree on ${want}, no tracker IDs, unowned-domain URLs or retired identifiers`,
);
