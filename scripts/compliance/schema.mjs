/**
 * Schema plumbing: the PUBLISHED OpenAPI document on one side, the Standard on the other.
 *
 * Two different authorities, deliberately kept apart:
 *
 *   - `OpenApiBundle` validates a live response against the schema the SERVED OpenAPI document
 *     declares for that operation. Nothing here is hand-written from the repo — the document the
 *     deployment publishes is the whole input, so this catches a service that has drifted from its
 *     own published contract. It is the same technique packages/api's
 *     test/integration/openapi.test.ts uses in-process, pointed at a live URL instead of
 *     `app.inject`.
 *
 *   - `loadStandardValidator` returns the repo's own validator (`rfphub-validate`), which validates
 *     a document against the Standard v1.0.0 JSON Schema. That one is the data contract, and it is
 *     NOT taken from the deployment: a service that served a subtly wrong schema would otherwise
 *     grade its own homework.
 */
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";

/** The synthetic identity the served components are registered under, so `$ref`s can be rebased. */
const OAS_ID = "https://rfphub.local/compliance/openapi.json";

/**
 * Deep-copy the served components, dropping any nested `$id`.
 *
 * The API names its components by their `$id` (see packages/api/src/plugins/swagger.ts), so the
 * served component objects still carry one. Left in place, ajv reads it as a schema identifier and
 * rebases every pointer inside that component onto it, and `#/components/schemas/...` stops
 * resolving. Same fix, same reason, as the in-process test's `componentsForAjv`.
 */
function componentsForAjv(schemas) {
  const out = {};
  for (const [name, schema] of Object.entries(schemas ?? {})) {
    const copy = {};
    for (const [k, v] of Object.entries(schema)) if (k !== "$id") copy[k] = v;
    out[name] = copy;
  }
  return out;
}

/**
 * The keywords whose VALUE is a map from a name to a schema, rather than a schema itself.
 *
 * They exist here for one reason: a document is free to declare a property literally called
 * `$id`, and under `properties` that string is a NAME. Walking it as a schema keyword would delete
 * the property from the copy and the checker would then accept a body missing it.
 */
const SCHEMA_MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

/**
 * Deep-copy a schema taken from the served document, rebasing every internal `$ref` onto the
 * registered bundle and dropping the `$id`s that would otherwise re-anchor them.
 *
 * A `$ref` in the served document is written against the DOCUMENT — `#/components/schemas/…` — and
 * ajv resolves `#` against whatever schema it is compiling. Compile that fragment on its own and
 * `#` is the fragment, so the pointer resolves to nothing. The components are registered under
 * `OAS_ID`, so prefixing the pointer with it points the reference back at the document it was
 * written against.
 *
 * Doing it at every depth rather than only at the root is what the 404 of
 * `GET /v1/opportunities/{id}` needs: it is declared as an INLINE
 * `oneOf: [ErrorResponse, MergedOpportunityErrorResponse]` — a merged id answers a 404 that names
 * the survivor, an ordinary miss answers the plain error — and a root-only rebase compiled that
 * object as-is, so the whole check failed with "can't resolve reference
 * #/components/schemas/ErrorResponse from id #" and took the nightly gate red with it.
 *
 * `$id` is dropped for the reason `componentsForAjv` gives at the root, applied at depth: ajv reads
 * one as a schema identity and rebases every pointer inside it onto that identity, which undoes the
 * rebase this function just performed.
 */
function schemaForAjv(node) {
  if (Array.isArray(node)) return node.map(schemaForAjv);
  if (node === null || typeof node !== "object") return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$id") continue;
    if (key === "$ref" && typeof value === "string" && value.startsWith("#")) {
      out[key] = OAS_ID + value;
      continue;
    }
    if (
      SCHEMA_MAPS.has(key) &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, schemaForAjv(sub)]),
      );
      continue;
    }
    out[key] = schemaForAjv(value);
  }
  return out;
}

export class OpenApiBundle {
  constructor(doc) {
    this.doc = doc;
    // `validateSchema:false` + `strict:false`: this is a document someone else published, and the
    // job is to hold RESPONSES to it, not to grade the document's own use of ajv's strict rules.
    this.ajv = new Ajv2020({ strict: false, validateSchema: false, allErrors: true });
    addFormats(this.ajv);
    this.ajv.addSchema({
      $id: OAS_ID,
      components: { schemas: componentsForAjv(doc?.components?.schemas) },
    });
    this.cache = new Map();
  }

  /** Compile (and memoize) a validator for a schema object taken from the served document. */
  #compile(schema) {
    const key = JSON.stringify(schema);
    let validate = this.cache.get(key);
    if (!validate) {
      // Every `$ref` is rebased onto the registered bundle, at every depth — a bare `$ref` and an
      // inline composition of component refs are the same case, and the published surface has both.
      validate = this.ajv.compile(schemaForAjv(schema));
      this.cache.set(key, validate);
    }
    return validate;
  }

  /** Validate `body` against a schema from the document. Returns `{ valid, errors }`. */
  validate(schema, body) {
    let validate;
    try {
      validate = this.#compile(schema);
    } catch (err) {
      return { valid: false, errors: [`schema could not be compiled: ${err.message}`] };
    }
    const valid = validate(body);
    return { valid, errors: valid ? [] : (validate.errors ?? []).map(formatAjvError) };
  }

  /** The named component, or undefined. */
  component(name) {
    return this.doc?.components?.schemas?.[name];
  }
}

/** One ajv error as a single readable line. */
export function formatAjvError(error) {
  if (typeof error === "string") return error;
  const where = error.instancePath || "(root)";
  const extra = error.params ? ` ${JSON.stringify(error.params)}` : "";
  return `${where} ${error.message}${extra}`;
}

/**
 * The repo's own Standard validator. Imported lazily and by name so the failure mode — running the
 * checker in a workspace that has not been built — is a sentence rather than a module-resolution
 * stack trace.
 */
export async function loadStandardValidator() {
  try {
    const mod = await import("rfphub-validate");
    return {
      specVersion: mod.SPEC_VERSION,
      validate(document) {
        // `checks:false` would drop the advisory tier; it is kept ON and reported separately,
        // because a warning is signal for a sign-off review even though it is not a failure.
        const { valid, errors, warnings } = mod.validateOpportunity(document);
        return {
          valid,
          errors: mod.humanizeErrors(errors, document),
          warnings: warnings.map((w) => `${w.code}: ${w.message}`),
        };
      },
    };
  } catch (err) {
    throw new Error(
      [
        `could not load rfphub-validate (${err.message}).`,
        "The checker validates documents with the repo's own validator, which is consumed from",
        "its build output — run `pnpm install && pnpm build` at the repo root first.",
      ].join("\n"),
    );
  }
}
