/**
 * `server.json` validated against the registry's OWN schema, not against our reading of it.
 *
 * The schema is vendored under `test/fixtures/` rather than fetched: a test that reaches the
 * network fails on an aeroplane, fails in a sandboxed CI runner, and — worse — starts passing or
 * failing for reasons that have nothing to do with the commit under test. Vendoring pins the
 * contract to the version this manifest declares in its own `$schema`, and the first assertion
 * below is that those two agree, so the copy cannot drift from the URL it claims to be.
 *
 * This is also what settles whether the publisher-defined `_meta` key is allowed: the schema
 * decides, and it is run here rather than argued about.
 */
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "server.json"), "utf8")) as Record<
  string,
  unknown
>;
const schema = JSON.parse(
  fs.readFileSync(path.join(ROOT, "test/fixtures/server.schema.json"), "utf8"),
) as Record<string, unknown>;

describe("server.json against the MCP Registry schema", () => {
  it("declares the schema version this repository actually vendored", () => {
    expect(manifest.$schema).toBe(schema.$id);
  });

  it("validates", () => {
    // draft-07: what the registry publishes. `strict: false` because the published schema carries
    // `example` keywords, which ajv's strict mode rejects as unknown — that is the schema author's
    // choice to make, not this test's.
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const valid = validate(manifest);
    expect(validate.errors ?? [], JSON.stringify(validate.errors, null, 2)).toEqual([]);
    expect(valid).toBe(true);
  });

  it("keeps the description inside the registry's 100-character limit", () => {
    // Called out separately because it is the constraint that is easiest to break by writing a
    // better sentence, and the schema error for it is easy to skim past.
    const cap = (
      schema as {
        definitions: { ServerDetail: { properties: { description: { maxLength: number } } } };
      }
    ).definitions.ServerDetail.properties.description.maxLength;
    expect(cap).toBe(100);
    expect(String(manifest.description).length).toBeLessThanOrEqual(cap);
  });

  it("keeps the publisher-defined _meta key the consistency check relies on", () => {
    // If a future schema version forbids it, the test above fails and this says what was lost.
    const meta = manifest._meta as Record<string, unknown> | undefined;
    expect(meta?.["io.github.the-rfp-hub/tool-descriptions"]).toBeDefined();
  });
});
