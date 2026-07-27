// Generates every derived artifact of the standard from its two hand-written sources:
//   - spec.config.json          → the spec's identity (version, $id, vocabulary IRI)
//   - schemas/<dir>/*.json      → the normative schema, context and registries
//
// Outputs (all committed; `--check` verifies they are in sync and never writes):
//   - schemas/<dir>/opportunity.schema.json  identity stamped in ($id, specVersion const, description)
//   - schemas/<dir>/context.jsonld           identity stamped in (@vocab)
//   - meta/rfphub-schema.meta.json           identity stamped in ($id)
//   - registries/entry.schema.json           identity stamped in ($id)
//   - src/schema.ts                          identity stamped in (SPEC_VERSION)
//   - src/generated/opportunity.ts           TypeScript types compiled from the schema
//   - registries/index.json                  machine-readable index of the open vocabularies
//   - schemas/index.json                     machine-readable index of published spec versions
//   - schemas/<dir>/FIELDS.md                field tables spliced into the generated:fields block
//
// Nothing here is time- or environment-dependent: identical inputs produce identical bytes.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jsonSchemaToTypescript from "json-schema-to-typescript";

const { compile } = jsonSchemaToTypescript;

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const p = (...parts) => resolve(pkgRoot, ...parts);
const readText = (f) => readFileSync(f, "utf8");
const readJson = (f) => JSON.parse(readText(f));

const spec = readJson(p("spec.config.json"));

// `baseUrl` is the single hand-written base for every identifier the standard publishes.
// Everything below derives from it, so adopting a canonical domain is one edit + `pnpm codegen`.
const schemaBase = `${spec.baseUrl}/${spec.schemaDir}`;
const url = (...parts) => [spec.baseUrl, ...parts].join("/");

/** Replace exactly one occurrence of `re` in `src`, failing loudly if the anchor moved. */
function stamp(src, re, replacement, what) {
  const matches = src.match(new RegExp(re.source, `${re.flags.replace("g", "")}g`));
  if (!matches || matches.length !== 1) {
    const found = matches?.length ?? 0;
    throw new Error(
      `codegen: expected exactly one ${what} anchor, found ${found}. The file was edited in a way codegen cannot stamp — fix the anchor or the edit.`,
    );
  }
  return src.replace(re, replacement);
}

// ---------------------------------------------------------------- identity --
const schemaPath = p(spec.schemaDir, "opportunity.schema.json");
let schemaText = readText(schemaPath);
schemaText = stamp(
  schemaText,
  /("\$id":\s*")[^"]*(")/,
  `$1${schemaBase}/opportunity.schema.json$2`,
  "schema $id",
);
// The self-identification examples must show the identifiers this cut actually publishes,
// or the schema teaches a URL that does not exist.
schemaText = stamp(
  schemaText,
  /("\$schema": \{\n(?:.*\n)*?\s*"examples": \[")[^"]*("\])/,
  `$1${schemaBase}/opportunity.schema.json$2`,
  "$schema example",
);
schemaText = stamp(
  schemaText,
  /("@context": \{\n(?:.*\n)*?\s*"examples": \[")[^"]*("\])/,
  `$1${schemaBase}/context.jsonld$2`,
  "@context example",
);
schemaText = stamp(
  schemaText,
  /("description":\s*"RFP Hub Standard v)\d+\.\d+\.\d+( —)/,
  `$1${spec.specVersion}$2`,
  "schema description version",
);
schemaText = stamp(
  schemaText,
  /("const":\s*")\d+\.\d+\.\d+(")/,
  `$1${spec.specVersion}$2`,
  "specVersion const",
);

const contextPath = p(spec.schemaDir, "context.jsonld");
const contextText = stamp(
  readText(contextPath),
  /("@vocab":\s*")[^"]*(")/,
  `$1${spec.vocabIri}$2`,
  "@vocab",
);

const metaPath = p("meta", "rfphub-schema.meta.json");
const metaText = stamp(
  readText(metaPath),
  /("\$id":\s*")[^"]*(")/,
  `$1${url("meta", "rfphub-schema.meta.json")}$2`,
  "metaschema $id",
);

const entrySchemaPath = p("registries", "entry.schema.json");
const entrySchemaText = stamp(
  readText(entrySchemaPath),
  /("\$id":\s*")[^"]*(")/,
  `$1${url("registries", "entry.schema.json")}$2`,
  "registry entry.schema.json $id",
);

const schemaTsPath = p("src", "schema.ts");
const schemaTsText = stamp(
  readText(schemaTsPath),
  /(export const SPEC_VERSION = ")[^"]*(" as const;)/,
  `$1${spec.specVersion}$2`,
  "SPEC_VERSION",
);

// ------------------------------------------------------------------- types --
const banner = [
  `// GENERATED from ${spec.schemaDir}/opportunity.schema.json — do not edit by hand.`,
  "// Regenerate with `pnpm codegen`.",
  "/* biome-ignore-all lint: generated */",
].join("\n");

const typesText = await compile(JSON.parse(schemaText), "opportunity.schema", {
  bannerComment: banner,
  additionalProperties: false,
  declareExternallyReferenced: true,
  enableConstEnums: false,
  cwd: p(spec.schemaDir),
  style: { singleQuote: false },
});

// -------------------------------------------------------------- registries --
const registryDir = p("registries");
const registryFiles = readdirSync(registryDir)
  .filter((f) => f.endsWith(".json") && f !== "entry.schema.json" && f !== "index.json")
  .sort();

const registryIndex = {
  $comment:
    "GENERATED by scripts/codegen.mjs from the sibling registry files — do not edit by hand. " +
    "Each registry governs one open vocabulary: the schema keeps the field free-text, the registry keeps the values interoperable.",
  specVersion: spec.specVersion,
  entrySchema: "entry.schema.json",
  registries: Object.fromEntries(
    registryFiles.map((file) => {
      const entries = readJson(join(registryDir, file));
      const keys = Object.keys(entries);
      return [
        file.replace(/\.json$/, ""),
        {
          file,
          count: keys.length,
          active: keys.filter((k) => entries[k].status === "active").sort(),
          deprecated: keys.filter((k) => entries[k].status === "deprecated").sort(),
        },
      ];
    }),
  ),
};
const registryIndexText = `${JSON.stringify(registryIndex, null, 2)}\n`;

// --------------------------------------------------------- versions index --
// The half OAS has never been able to retrofit: a machine-readable pointer at what versions
// exist and which one is current. Free while there is one version, impossible to add cleanly
// later. `recut` is present only on versions whose bytes were replaced in place.
const versionsIndex = {
  $comment:
    "GENERATED by scripts/codegen.mjs from spec.config.json — do not edit by hand. " +
    "Index of published RFP Hub Standard versions. Each entry's `path` is a sibling directory " +
    "of this file; `latest` names the current version.",
  versions: [
    {
      version: spec.specVersion,
      path: spec.schemaDir.replace(/^schemas\//, ""),
      status: spec.status,
      ...(spec.recutDate ? { recut: spec.recutDate } : {}),
    },
  ],
  latest: spec.specVersion,
};
const versionsIndexText = `${JSON.stringify(versionsIndex, null, 2)}\n`;

// ------------------------------------------------------------ field tables --
// FIELDS.md is half generated: the field reference below is rendered from the schema, the
// narrative around it is hand-written. A hand-maintained field table drifts from the schema
// inside one release — every comparable project has learned this the same way.
const FIELDS_BEGIN = "<!-- BEGIN generated:fields -->";
const FIELDS_END = "<!-- END generated:fields -->";

/** Fields whose *values* are governed by an open vocabulary in registries/. */
const REGISTRY_FOR_FIELD = {
  eligibility: "eligibility-keys",
  "deadline.label": "deadline-labels",
  "grant.programModel": "program-models",
};

// Fail loudly if a registry exists that no field points at, or vice versa — a registry nothing
// references is documentation nobody reads.
{
  const known = new Set(registryFiles.map((f) => f.replace(/\.json$/, "")));
  const referenced = new Set(Object.values(REGISTRY_FOR_FIELD));
  for (const name of referenced) {
    if (!known.has(name)) {
      throw new Error(`codegen: REGISTRY_FOR_FIELD points at unknown registry '${name}'`);
    }
  }
  for (const name of known) {
    if (!referenced.has(name)) {
      throw new Error(
        `codegen: registry '${name}' governs no field — add it to REGISTRY_FOR_FIELD or remove it`,
      );
    }
  }
}

/** The order field-reference sections appear in. Every $def must be listed. */
const DEF_ORDER = [
  "organization",
  "contact",
  "provenance",
  "socialLinks",
  "funding",
  "monetaryAmount",
  "amountRange",
  "deadline",
  "milestone",
  "grant",
  "hackathon",
  "prize",
  "teamSize",
  "bounty",
  "accelerator",
  "vcFund",
  "rfp",
];

const schemaObj = JSON.parse(schemaText);
const md = (s) =>
  String(s)
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ")
    .trim();
const refName = (ref) => ref.replace("#/$defs/", "");
const anchor = (name) => `#${name.toLowerCase()}`;

function scalarExpr(node) {
  if (node.enum) {
    return node.enum
      .filter((v) => v !== null)
      .map((v) => `\`${v}\``)
      .join(" \\| ");
  }
  if (node.const !== undefined) return `\`${node.const}\``;
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  const base = types.filter((t) => t !== "null")[0];
  if (base === "string" && node.format) return `string(${node.format})`;
  return base ?? "any";
}

function typeExpr(node) {
  if (node.$ref) {
    const name = refName(node.$ref);
    return `[\`${name}\`](${anchor(name)})`;
  }
  if (node.anyOf) return node.anyOf.map(typeExpr).join(" \\| ");
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  const nullable = types.includes("null");
  const base = types.filter((t) => t !== "null");
  let out;
  if (base.includes("array")) {
    const items = node.items ?? {};
    const inner = items.$ref ? typeExpr(items) : scalarExpr(items);
    out = items.enum ? `(${inner})[]` : `${inner}[]`;
  } else if (base.includes("object")) {
    const ap = node.additionalProperties;
    out = ap && typeof ap === "object" ? `object<string, ${scalarExpr(ap)}>` : "object";
  } else {
    out = scalarExpr(node);
  }
  return nullable ? `${out}\\|null` : out;
}

function constraintsExpr(node) {
  const c = [];
  if (node.minItems !== undefined) c.push(`min ${node.minItems}`);
  if (node.uniqueItems) c.push("unique");
  if (node.maxLength !== undefined) c.push(`≤${node.maxLength}`);
  if (node.minimum !== undefined) c.push(`≥${node.minimum}`);
  if (node.pattern) c.push(`\`${node.pattern}\``);
  return c.length > 0 ? `, ${c.join(", ")}` : "";
}

/** Property names the six if/then branches make conditionally required. */
const conditionalProps = new Set(
  (schemaObj.allOf ?? []).flatMap((branch) => branch.then?.required ?? []),
);

function requiredCell(name, required, conditional) {
  if (required.includes(name)) return "✅";
  if (conditional?.has(name)) return "cond.";
  return "";
}

function registryCell(path) {
  const name = REGISTRY_FOR_FIELD[path];
  return name ? `[\`${name}\`](../../registries/${name}.json)` : "—";
}

function fieldTable(node, { pathPrefix = "", conditional } = {}) {
  const required = node.required ?? [];
  const rows = Object.entries(node.properties ?? {}).map(([name, prop]) => {
    const resolved = prop.$ref ? { ...schemaObj.$defs[refName(prop.$ref)], ...prop } : prop;
    const stability =
      prop["x-stability"] === "provisional" || resolved["x-stability"] === "provisional"
        ? " **(provisional)**"
        : "";
    const description = md(prop.description ?? resolved.description ?? "");
    return [
      `\`${name}\``,
      `${typeExpr(prop)}${constraintsExpr(prop)}`,
      requiredCell(name, required, conditional),
      `${description}${stability}`,
      registryCell(pathPrefix ? `${pathPrefix}.${name}` : name),
    ];
  });
  return [
    "| Field | Type | Req. | Description | Registry |",
    "|---|---|:--:|---|---|",
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

const missingDefs = Object.keys(schemaObj.$defs).filter((k) => !DEF_ORDER.includes(k));
if (missingDefs.length > 0) {
  throw new Error(`codegen: $defs missing from DEF_ORDER: ${missingDefs.join(", ")}`);
}

const fieldsBlock = [
  "### Top-level fields",
  "",
  fieldTable(schemaObj, { conditional: conditionalProps }),
  "",
  ...DEF_ORDER.flatMap((key) => {
    const def = schemaObj.$defs[key];
    return [
      `### \`${key}\``,
      "",
      ...(def.description ? [md(def.description), ""] : []),
      fieldTable(def, { pathPrefix: key }),
      "",
    ];
  }),
]
  .join("\n")
  .trimEnd();

const fieldsPath = p(spec.schemaDir, "FIELDS.md");
const fieldsSource = readText(fieldsPath);
const begin = fieldsSource.indexOf(FIELDS_BEGIN);
const end = fieldsSource.indexOf(FIELDS_END);
if (begin === -1 || end === -1 || end < begin) {
  throw new Error(
    `codegen: ${spec.schemaDir}/FIELDS.md is missing the '${FIELDS_BEGIN}' / '${FIELDS_END}' marker pair`,
  );
}
const fieldsText = `${fieldsSource.slice(0, begin + FIELDS_BEGIN.length)}\n\n${fieldsBlock}\n\n${fieldsSource.slice(end)}`;

// ------------------------------------------------------------------- emit ---
const outputs = [
  [schemaPath, schemaText],
  [contextPath, contextText],
  [metaPath, metaText],
  [entrySchemaPath, entrySchemaText],
  [schemaTsPath, schemaTsText],
  [p("src", "generated", "opportunity.ts"), typesText],
  [join(registryDir, "index.json"), registryIndexText],
  [p("schemas", "index.json"), versionsIndexText],
  [fieldsPath, fieldsText],
];

if (process.argv.includes("--check")) {
  const stale = outputs.filter(([file, want]) => (existsSync(file) ? readText(file) : "") !== want);
  if (stale.length > 0) {
    const list = stale.map(([f]) => `  - ${f.slice(pkgRoot.length + 1)}`).join("\n");
    console.error(
      `✗ ${stale.length} generated artifact(s) out of sync with spec.config.json + the schema:\n${list}\n  Run \`pnpm codegen\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(`✓ ${outputs.length} generated artifacts are in sync`);
} else {
  for (const [file, content] of outputs) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    console.log(`wrote ${file.slice(pkgRoot.length + 1)}`);
  }
}
