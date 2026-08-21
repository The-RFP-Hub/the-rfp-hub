/**
 * THE REGRESSION THIS FILE EXISTS FOR: with the precompiled validator, `createValidator()` for the
 * standard's own schema no longer compiles a fresh function per call — and returning the shared
 * generated singleton directly would share its mutable `.errors` slot between every consumer. ajv
 * reports errors by MUTATION, so caller A validating an invalid document and then reading
 * `A.errors` must not see the null that caller B's valid document just wrote. Each call must hand
 * back a validator whose `.errors` reflects ITS last call, exactly as the per-call compilation on
 * the old path did.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const conformance = join(here, "..", "..", "standard", "conformance", "v1.0.0");

/** A document the conformance suite REQUIRES every implementation to accept. */
const VALID = JSON.parse(
  readFileSync(join(conformance, "pass", "minimal-required-only.json"), "utf8"),
);

/** The smallest invalid document: the schema requires far more than an id. */
const INVALID = { id: "curated:not-enough" };

describe("createValidator error-state isolation", () => {
  it("two validators do not share one .errors slot", () => {
    const a = createValidator();
    const b = createValidator();
    expect(a).not.toBe(b);

    expect(a(INVALID)).toBe(false);
    // b's VALID call mutates the shared engine's slot to null AFTER a's call — a distinct-wrapper
    // contract means a still holds the errors of ITS call, not the null b's just wrote.
    expect(b(VALID)).toBe(true);

    expect(a.errors ?? []).not.toHaveLength(0);
    expect(b.errors ?? []).toHaveLength(0);
  });

  it("a validator's .errors tracks its own latest call", () => {
    const v = createValidator();
    expect(v(INVALID)).toBe(false);
    expect(v.errors ?? []).not.toHaveLength(0);
    expect(v(VALID)).toBe(true);
    expect(v.errors ?? []).toHaveLength(0);
    expect(v(INVALID)).toBe(false);
    expect(v.errors ?? []).not.toHaveLength(0);
  });
});
