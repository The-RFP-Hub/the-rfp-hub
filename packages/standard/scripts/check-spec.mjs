// Publication rules for the standard — the thing that has to be true before a cut ships.
//
// Three classes of failure, all of which have bitten comparable projects:
//   1. CONTEXT DRIFT   — the JSON-LD context and the schema describe different vocabularies.
//                        Hand-maintained contexts drift within one release; there is no
//                        runtime that would notice, so CI has to.
//   2. VERSION DRIFT   — a version string hand-written somewhere disagrees with
//                        spec.config.json. Everything derivable is stamped by codegen; this
//                        catches the places a human can still type one.
//   3. NEUTRALITY      — an internal issue-tracker ID inside a CC0 artifact that is
//                        designed to be embedded, forked and code-generated from. One leak
//                        in a normative field description travels into every downstream copy.
//                        Also: an identifier on a domain the project does not own. Every
//                        published identifier must dereference or be visibly provisional;
//                        a URL pointing at an unowned domain is neither.
//
// Run with `pnpm --filter @the-rfp-hub/standard check`. Exits non-zero on any failure.
import { readFileSync, readdirSync, statSync } from "node:fs";
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

// --------------------------------------------------------- 3. neutrality ----
const TRACKER_ID = /\bDEV-\d+\b/g;
// The project does not own the domain this standard's identifiers used to be minted on. An
// identifier on a domain nobody controls is worse than a provisional one: it looks final, it
// never dereferences, and every downstream fork inherits it. Identifiers live in
// spec.config.json and nowhere else. Assembled from parts so this rule does not trip itself.
const UNOWNED_DOMAIN = new RegExp(`\\b${["rfphub", "org"].join("\\.")}\\b`, "g");
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
      `${relative(pkgRoot, file)} references the retired placeholder domain (${hits2[0]}) — the project does not own it. Identifiers come from spec.config.json; there is no canonical domain yet`,
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
  `✓ check-spec: context covers ${topLevelProperties.length} top-level terms, ` +
    `identifiers all stamped from spec.config.json (${spec.baseUrl}), ` +
    `version strings agree on ${want}, no tracker IDs or unowned-domain URLs`,
);
