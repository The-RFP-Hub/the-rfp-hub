/**
 * The Agent Skills frontmatter validator — the M4 plan's rev. 4 correction is that `version` and
 * `tags` are NOT top-level fields the spec allows, so that is tested explicitly rather than only
 * asserting the happy path.
 */
import { describe, expect, it } from "vitest";
import { parseFrontmatter, splitFrontmatter, validateFrontmatter } from "../frontmatter.mjs";

const VALID = `name: rfp-hub-funding-search
description: Search open Ethereum-ecosystem funding opportunities. Use when someone asks to find grants or bounties.
license: MIT
compatibility: >-
  Runs anywhere Node 20+ is available. The bundled helper does the fetching and the projection.
metadata:
  version: "0.1.0"
  category: discovery
  tags: "funding, grants, discovery"
`;

describe("splitFrontmatter", () => {
  it("extracts the block between the two --- fences", () => {
    const { frontmatter, body } = splitFrontmatter("---\nname: x\n---\n# Body\n");
    expect(frontmatter).toBe("name: x");
    expect(body).toBe("# Body\n");
  });

  it("returns null frontmatter when there is no leading fence", () => {
    const { frontmatter, body } = splitFrontmatter("# Just a body\n");
    expect(frontmatter).toBeNull();
    expect(body).toBe("# Just a body\n");
  });
});

describe("parseFrontmatter", () => {
  it("reads scalars, a block scalar, and one level of nested mapping", () => {
    const { fields, errors } = parseFrontmatter(VALID);
    expect(errors).toEqual([]);
    expect(fields.name).toBe("rfp-hub-funding-search");
    expect(fields.license).toBe("MIT");
    expect(fields.compatibility).toContain("Runs anywhere Node 20+");
    expect(fields.metadata).toEqual({
      version: "0.1.0",
      category: "discovery",
      tags: "funding, grants, discovery",
    });
  });

  it("reports an unparsable line rather than silently dropping it", () => {
    const { errors } = parseFrontmatter("not a key value pair at all {{{\n");
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("validateFrontmatter", () => {
  it("accepts a spec-conformant document whose name matches its directory", () => {
    const { fields } = parseFrontmatter(VALID);
    const { ok, errors } = validateFrontmatter(fields, { dirName: "rfp-hub-funding-search" });
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it("rejects a name that does not match the skill's directory", () => {
    const { fields } = parseFrontmatter(VALID);
    const { ok, errors } = validateFrontmatter(fields, { dirName: "some-other-dir" });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("does not match its directory name"))).toBe(true);
  });

  it("rejects a name over 64 characters", () => {
    const { ok, errors } = validateFrontmatter({ name: "a".repeat(65), description: "d" }, {});
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("64 characters"))).toBe(true);
  });

  it("rejects a name that is not kebab-case", () => {
    const { ok, errors } = validateFrontmatter(
      { name: "RFP_Hub Funding Search", description: "d" },
      {},
    );
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("kebab-case"))).toBe(true);
  });

  it("requires name and description", () => {
    const { ok, errors } = validateFrontmatter({}, {});
    expect(ok).toBe(false);
    expect(errors).toContain("missing required field: name");
    expect(errors).toContain("missing required field: description");
  });

  it("rejects a description over 1024 characters", () => {
    const { ok, errors } = validateFrontmatter({ name: "x", description: "d".repeat(1025) }, {});
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("1024 characters"))).toBe(true);
  });

  // The rev. 4 correction the plan calls out by name: version/tags are not top-level fields.
  it("rejects a top-level `version` field", () => {
    const { ok, errors } = validateFrontmatter(
      { name: "x", description: "d", version: "0.1.0" },
      {},
    );
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("top-level `version`"))).toBe(true);
  });

  it("rejects a top-level `tags` field", () => {
    const { ok, errors } = validateFrontmatter({ name: "x", description: "d", tags: "a, b" }, {});
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("top-level `tags`"))).toBe(true);
  });

  it("accepts version and tags when they are under metadata, as strings", () => {
    const { ok } = validateFrontmatter(
      { name: "x", description: "d", metadata: { version: "0.1.0", tags: "a, b" } },
      {},
    );
    expect(ok).toBe(true);
  });

  it("rejects a non-string metadata value", () => {
    const { ok, errors } = validateFrontmatter(
      { name: "x", description: "d", metadata: { count: 3 } },
      {},
    );
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("metadata.count must be a string"))).toBe(true);
  });

  it("rejects an unrecognized top-level field", () => {
    const { ok, errors } = validateFrontmatter(
      { name: "x", description: "d", author: "someone" },
      {},
    );
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes('"author"'))).toBe(true);
  });
});
