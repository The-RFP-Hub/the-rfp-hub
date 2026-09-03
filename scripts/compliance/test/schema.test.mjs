/**
 * `OpenApiBundle` against the schema shapes the published document actually declares.
 *
 * THE DEFECT THESE EXIST FOR. `#compile` rebased a `$ref` only when the `$ref` was the whole
 * schema, and compiled anything else as-is. Then `GET /v1/opportunities/{id}` started declaring its
 * 404 as an inline
 * `oneOf: [ErrorResponse, MergedOpportunityErrorResponse]` — a merged id answers a 404 that names
 * the survivor, an ordinary miss answers the plain error — and ajv, compiling that fragment on its
 * own, resolved `#` to the fragment rather than to the document. The check failed with
 * "schema could not be compiled: can't resolve reference #/components/schemas/ErrorResponse from
 * id #", and the nightly open-data gate went red against an API that was serving exactly what it
 * documented.
 *
 * A compile failure is reported as an invalid BODY, so the cases below assert the verdict on real
 * bodies rather than on the error string: a checker that cannot compile a schema and a checker
 * that read the body and found it wrong are the same red line, and only one of them is a finding
 * about the deployment.
 */
import { describe, expect, it } from "vitest";
import { OpenApiBundle } from "../schema.mjs";

const ERROR_RESPONSE = {
  $id: "ErrorResponse",
  type: "object",
  additionalProperties: false,
  required: ["error", "message"],
  properties: { error: { type: "string" }, message: { type: "string" } },
};

/** The component the merged-id 404 names, with a nested object of its own. */
const MERGED = {
  $id: "MergedOpportunityErrorResponse",
  type: "object",
  additionalProperties: false,
  required: ["error", "mergedInto"],
  properties: {
    error: { type: "string", enum: ["opportunity_merged"] },
    mergedInto: {
      type: "object",
      additionalProperties: false,
      required: ["id", "title"],
      properties: { id: { type: "string" }, title: { type: "string" } },
    },
  },
};

/** The API's components carry their own `$id`, exactly as `plugins/swagger.ts` emits them. */
const bundle = () =>
  new OpenApiBundle({
    openapi: "3.1.0",
    components: {
      schemas: { ErrorResponse: ERROR_RESPONSE, MergedOpportunityErrorResponse: MERGED },
    },
  });

/** The 404 of `GET /v1/opportunities/{id}`, verbatim from the served document. */
const INLINE_ONE_OF = {
  oneOf: [
    { $ref: "#/components/schemas/ErrorResponse" },
    { $ref: "#/components/schemas/MergedOpportunityErrorResponse" },
  ],
};

describe("an inline schema composed of component refs", () => {
  it("compiles, and accepts a body matching one of its branches", () => {
    // THE REGRESSION. Against the root-only rebase this is
    // `{ valid: false, errors: ["schema could not be compiled: can't resolve reference …"] }`.
    const result = bundle().validate(INLINE_ONE_OF, {
      error: "not_found",
      message: 'no opportunity "example:missing".',
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("accepts the other branch too, nested objects and all", () => {
    const result = bundle().validate(INLINE_ONE_OF, {
      error: "opportunity_merged",
      mergedInto: { id: "example:survivor", title: "The surviving entry" },
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("still rejects a body that matches neither branch", () => {
    // The half that makes the fix worth having: resolving the refs must not turn the check into a
    // rubber stamp. This body is a plausible near-miss — the merged branch's shape with the
    // survivor's `title` missing, and an `error` the plain branch's `enum` does not admit.
    const result = bundle().validate(INLINE_ONE_OF, {
      error: "opportunity_merged",
      mergedInto: { id: "example:survivor" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).not.toMatch(/could not be compiled/);
    expect(result.errors.join("\n")).toMatch(/oneOf|required/);
  });

  it("rejects a body that satisfies BOTH branches, because `oneOf` says exactly one", () => {
    // `additionalProperties: false` on both components makes this unreachable in practice, and the
    // case is here to prove the composition keyword is being honoured rather than flattened away.
    const either = { oneOf: [{ type: "object" }, { type: "object", required: ["error"] }] };
    expect(bundle().validate(either, { error: "not_found" }).valid).toBe(false);
  });
});

describe("the shapes that already worked keep working", () => {
  it("resolves a bare `$ref` to a component", () => {
    const result = bundle().validate(
      { $ref: "#/components/schemas/ErrorResponse" },
      { error: "unauthorized", message: "Missing bearer token." },
    );
    expect(result.valid).toBe(true);
  });

  it("holds a bare `$ref` to the component's own rules", () => {
    const result = bundle().validate(
      { $ref: "#/components/schemas/ErrorResponse" },
      {
        error: "unauthorized",
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).not.toMatch(/could not be compiled/);
  });

  it("compiles an inline schema that refers to nothing", () => {
    const inline = {
      type: "object",
      required: ["status"],
      properties: { status: { type: "string" } },
      additionalProperties: false,
    };
    expect(bundle().validate(inline, { status: "ok" }).valid).toBe(true);
    expect(bundle().validate(inline, { status: 3 }).valid).toBe(false);
  });

  it("keeps a property NAMED `$id` rather than mistaking it for a schema identity", () => {
    // The trap in stripping `$id` at depth: under `properties` it is a property NAME, and dropping
    // it would leave the checker accepting a body missing a field the document requires.
    const inline = {
      type: "object",
      required: ["$id"],
      properties: { $id: { type: "string" } },
      additionalProperties: false,
    };
    expect(bundle().validate(inline, { $id: "urn:example" }).valid).toBe(true);
    expect(bundle().validate(inline, {}).valid).toBe(false);
  });

  it("reports an unresolvable reference as a compile failure rather than throwing", () => {
    const result = bundle().validate({ $ref: "#/components/schemas/NoSuchComponent" }, {});
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/schema could not be compiled/);
  });
});
