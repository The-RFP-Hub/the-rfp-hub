// The standard's own artifacts, checked here because this is the package that carries ajv.
// Three claims are under test: the schema file is itself well-formed against the metaschema
// that legalises our x- annotations; every registry file matches entry.schema.json; and the
// generated registry index agrees with the registry files it was generated from.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const standard = join(here, "..", "..", "standard");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const spec = readJson(join(standard, "spec.config.json"));
const schemaPath = join(standard, spec.schemaDir, "opportunity.schema.json");
const registryDir = join(standard, "registries");

/** A plain ajv for validating our own files AS DATA (not compiling them as schemas). */
function dataValidator(schema: object) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

describe("metaschema", () => {
  const validate = dataValidator(readJson(join(standard, "meta", "rfphub-schema.meta.json")));

  it("accepts opportunity.schema.json", () => {
    const ok = validate(readJson(schemaPath));
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });

  it("rejects an illegal x-stability value", () => {
    const schema = readJson(schemaPath);
    schema.properties.serviceAgreement["x-stability"] = "experimental";
    expect(validate(schema)).toBe(false);
  });

  it("rejects an x-deprecated with no since", () => {
    const schema = readJson(schemaPath);
    schema.properties.summary.deprecated = true;
    schema.properties.summary["x-deprecated"] = { note: "gone" };
    expect(validate(schema)).toBe(false);
  });

  // 2020-12 has a native `deprecated` annotation. x-deprecated exists only to carry the
  // metadata the native keyword cannot (since/replacedBy/note), so it may never appear
  // alone — generic tooling that knows nothing about this standard reads `deprecated`.
  it("rejects x-deprecated without the native deprecated flag", () => {
    const schema = readJson(schemaPath);
    schema.properties.summary["x-deprecated"] = { since: "1.0.0", replacedBy: null, note: "gone" };
    expect(validate(schema)).toBe(false);
  });

  it("accepts the native deprecated flag, with or without x-deprecated metadata", () => {
    const bare = readJson(schemaPath);
    bare.properties.summary.deprecated = true;
    expect(validate(bare)).toBe(true);

    const full = readJson(schemaPath);
    full.properties.summary.deprecated = true;
    full.properties.summary["x-deprecated"] = {
      since: "1.0.0",
      replacedBy: "description",
      note: "Folded into description.",
    };
    expect(validate(full)).toBe(true);
  });

  it("rejects a non-array examples annotation", () => {
    const schema = readJson(schemaPath);
    schema.properties.title.examples = "Example Grants";
    expect(validate(schema)).toBe(false);
  });
});

// The schema file's own conventions, checked so they cannot rot silently.
describe("schema file conventions", () => {
  const schema = readJson(schemaPath);

  const walk = (
    node: unknown,
    path: string,
    visit: (n: Record<string, unknown>, p: string) => void,
  ) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${path}[${i}]`, visit));
      return;
    }
    const rec = node as Record<string, unknown>;
    visit(rec, path);
    for (const [k, v] of Object.entries(rec)) walk(v, `${path}/${k}`, visit);
  };

  it("declares the 2020-12 dialect and an absolute, fragmentless $id", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toMatch(/^https:\/\/[^#]+$/);
    expect(schema.title.length).toBeGreaterThan(0);
    expect(schema.description).toContain("CC0 1.0");
  });

  it("gives every declared property and $def a non-empty description", () => {
    const missing: string[] = [];
    // `if`/`then` subschemas re-reference already-declared properties as constraint
    // machinery; they are not declarations and carry no description by design.
    const isApplicator = (p: string) => /\/(if|then|else|not|allOf|anyOf|oneOf)(\/|\[|$)/.test(p);
    walk(schema, "", (node, path) => {
      if (isApplicator(path)) return;
      const props = node.properties as Record<string, Record<string, unknown>> | undefined;
      if (!props) return;
      for (const [name, prop] of Object.entries(props)) {
        const d = prop.description;
        if (typeof d !== "string" || d.trim() === "") missing.push(`${path}/properties/${name}`);
      }
    });
    for (const [name, def] of Object.entries<Record<string, unknown>>(schema.$defs)) {
      if (typeof def.description !== "string" || def.description.trim() === "") {
        missing.push(`$defs/${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // NORMATIVE.md: the schema's KEYWORDS are the constraints. An all-caps BCP 14 keyword in a
  // description is a prose constraint hiding in the schema — keyword-enforce it or reword it.
  it("keeps BCP 14 keywords out of descriptions", () => {
    const offenders: string[] = [];
    walk(schema, "", (node, path) => {
      const d = node.description;
      if (typeof d === "string" && /\b(MUST|SHALL|REQUIRED|RECOMMENDED)\b/.test(d)) {
        offenders.push(path);
      }
    });
    expect(offenders).toEqual([]);
  });

  it("orders `required` to follow property order", () => {
    walk(schema, "", (node, path) => {
      const required = node.required as string[] | undefined;
      const props = node.properties as Record<string, unknown> | undefined;
      if (!Array.isArray(required) || !props) return;
      const order = Object.keys(props);
      const declared = required.filter((r) => order.includes(r));
      expect(
        [...declared].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
        path,
      ).toEqual(declared);
    });
  });

  // Decision 1-C(iii): the temporal declarations are a convention, not a shared $ref — this
  // equality guard is what makes the seven inline sites a single point of truth.
  it("declares every date-time field identically", () => {
    const decls = new Set<string>();
    walk(schema, "", (n) => {
      if (n.format !== "date-time") return;
      decls.add(JSON.stringify({ type: n.type, format: n.format, pattern: n.pattern }));
    });
    expect([...decls]).toHaveLength(1);
  });

  it("declares additionalProperties on every object $def", () => {
    for (const [name, def] of Object.entries<Record<string, unknown>>(schema.$defs)) {
      if (def.type !== "object") continue;
      expect(def, `$defs/${name}`).toHaveProperty("additionalProperties");
    }
    expect(schema.additionalProperties).toBe(false);
  });

  // The classic 2020-12 trap: additionalProperties:false at the root does not see properties
  // introduced inside allOf. Safe here only because no branch introduces one.
  it("keeps allOf branches free of property declarations", () => {
    for (const branch of schema.allOf) {
      for (const sub of [branch.if, branch.then, branch.else]) {
        if (!sub) continue;
        for (const name of Object.keys(sub.properties ?? {})) {
          expect(Object.keys(schema.properties), "allOf branch property").toContain(name);
        }
      }
    }
  });

  it("uses only x- prefixed non-standard keywords", () => {
    const STANDARD = new Set([
      "$schema",
      "$id",
      "$ref",
      "$defs",
      "$comment",
      "title",
      "description",
      "type",
      "enum",
      "const",
      "properties",
      "additionalProperties",
      "required",
      "items",
      "uniqueItems",
      "minItems",
      "minLength",
      "maxLength",
      "minimum",
      "pattern",
      "format",
      "examples",
      "allOf",
      "anyOf",
      "oneOf",
      "not",
      "if",
      "then",
      "else",
      "deprecated",
      "default",
      "readOnly",
      "writeOnly",
      "dependentRequired",
    ]);
    const unknown = new Set<string>();
    walk(schema, "", (node, path) => {
      // Values under `properties` and `$defs` are names, and everything below `examples`
      // is instance data — none of them are keyword positions.
      if (/\/(properties|\$defs)$/.test(path) || path.includes("/examples")) return;
      for (const k of Object.keys(node)) {
        if (!STANDARD.has(k) && !k.startsWith("x-") && !k.startsWith("@")) unknown.add(k);
      }
    });
    expect([...unknown]).toEqual([]);
  });
});

describe("stability annotations", () => {
  const schema = readJson(schemaPath);

  it("marks the single-source-evidenced additions provisional", () => {
    expect(schema.properties.serviceAgreement["x-stability"]).toBe("provisional");
    expect(schema.properties.milestones["x-stability"]).toBe("provisional");
    expect(schema.$defs.grant.properties.programModel["x-stability"]).toBe("provisional");
  });

  it("treats everything else as stable", () => {
    const provisional: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== "object") return;
      const rec = node as Record<string, unknown>;
      if (rec["x-stability"] === "provisional") provisional.push(path);
      for (const [k, v] of Object.entries(rec)) walk(v, `${path}/${k}`);
    };
    walk(schema, "");
    expect(provisional).toHaveLength(3);
  });
});

describe("registries", () => {
  const validate = dataValidator(readJson(join(registryDir, "entry.schema.json")));
  const files = readdirSync(registryDir)
    .filter((f) => f.endsWith(".json") && f !== "entry.schema.json" && f !== "index.json")
    .sort();

  // `ecosystems` is an open list too, and deliberately has no registry: a registry over
  // chain names reads as an allowed-values list whatever NORMATIVE.md says.
  it("ships the two vocabularies the standard governs by registry", () => {
    expect(files).toEqual(["deadline-labels.json", "program-models.json"]);
  });

  for (const file of files) {
    it(`validates ${file} against entry.schema.json`, () => {
      const ok = validate(readJson(join(registryDir, file)));
      if (!ok) console.error(file, validate.errors);
      expect(ok).toBe(true);
    });
  }

  it("registers the starter deadline labels from the field plan", () => {
    const labels = Object.keys(readJson(join(registryDir, "deadline-labels.json")));
    for (const l of [
      "application",
      "community feedback",
      "registration",
      "submission",
      "event start",
      "event end",
    ]) {
      expect(labels).toContain(l);
    }
  });

  it("points every deprecated entry at a live successor", () => {
    for (const file of files) {
      const entries = readJson(join(registryDir, file));
      for (const [key, entry] of Object.entries<Record<string, unknown>>(entries)) {
        if (entry.status !== "deprecated") continue;
        expect(entry.replacedBy, `${file}#${key}`).toBeTruthy();
        expect(Object.keys(entries), `${file}#${key}`).toContain(entry.replacedBy);
      }
    }
  });

  it("has a generated index that agrees with the files", () => {
    const index = readJson(join(registryDir, "index.json"));
    expect(index.specVersion).toBe(spec.specVersion);
    expect(Object.keys(index.registries).sort()).toEqual(
      files.map((f) => f.replace(/\.json$/, "")).sort(),
    );
    for (const [name, meta] of Object.entries<Record<string, unknown>>(index.registries)) {
      const entries = readJson(join(registryDir, meta.file as string));
      expect(meta.count, name).toBe(Object.keys(entries).length);
    }
  });
});
