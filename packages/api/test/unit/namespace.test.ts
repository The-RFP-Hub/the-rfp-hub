/**
 * THE NAMESPACE RULE, which is what authorization is decided against on the write path.
 *
 * Two things have to hold and neither is obvious: the namespace is derived from the document the
 * same way every time (so authorization and storage cannot disagree about what was published), and
 * the public id's prefix is the same namespace (so `source_system`, which `scripts/seed.ts` derives
 * by splitting the id, files the row under the system it was actually authorized for).
 */
import { describe, expect, it } from "vitest";
import {
  checkPublicId,
  isNamespaceSlug,
  namespaceOfPublicId,
  parsePublicId,
  resolveNamespace,
} from "../../src/modules/shared/namespace.js";

describe("resolveNamespace", () => {
  it("prefers source.publisher, which the Standard defines as the namespace", () => {
    expect(
      resolveNamespace({
        source: { publisher: "example-foundation" },
        operatingOrganizations: [{ slug: "someone-else" }],
      }),
    ).toBe("example-foundation");
  });

  it("falls back to the PRIMARY operating organization's slug", () => {
    expect(
      resolveNamespace({ operatingOrganizations: [{ slug: "example-dao" }, { slug: "second" }] }),
    ).toBe("example-dao");
  });

  // Blank is not a namespace. An empty string would otherwise pass an `!== undefined` check and
  // authorize a write against "", which no membership can match but every id prefix could.
  it("treats blank and absent alike", () => {
    for (const record of [
      {},
      { source: { publisher: "   " } },
      { source: { publisher: null }, operatingOrganizations: [] },
      { operatingOrganizations: [{ slug: "" }] },
    ]) {
      expect(resolveNamespace(record), JSON.stringify(record)).toBeUndefined();
    }
  });
});

describe("parsePublicId", () => {
  it("splits on the FIRST colon, so a local part may contain colons", () => {
    expect(parsePublicId("example:round:2026")).toEqual({
      namespace: "example",
      local: "round:2026",
    });
  });

  it("rejects ids with no usable split", () => {
    for (const id of ["nocolon", ":leading", "trailing:", ":", ""]) {
      expect(parsePublicId(id), id).toBeUndefined();
    }
  });

  it("namespaceOfPublicId agrees with the seed loader's source_system derivation", () => {
    expect(namespaceOfPublicId("fundingmap:1459")).toBe("fundingmap");
    expect(namespaceOfPublicId("no-namespace")).toBeUndefined();
  });
});

describe("isNamespaceSlug", () => {
  it("accepts slug shape", () => {
    for (const value of ["example", "example-foundation", "eth2", "a1-b2-c3"]) {
      expect(isNamespaceSlug(value), value).toBe(true);
    }
  });

  // Narrower than "anything without a colon" on purpose: values differing only by normalization
  // produce ids that look like one entry and index as two.
  it("rejects anything that would normalize to a different string", () => {
    for (const value of [
      "Example",
      "with space",
      "trailing-",
      "-leading",
      "double--hyphen",
      "a",
      "under_score",
    ]) {
      expect(isNamespaceSlug(value), value).toBe(false);
    }
  });
});

describe("checkPublicId", () => {
  it("accepts an id prefixed with its own namespace", () => {
    expect(checkPublicId("example:spring-round", "example")).toBeUndefined();
  });

  it("names the required form rather than saying 'invalid'", () => {
    const message = checkPublicId("spring-round", "example");
    expect(message).toContain("<namespace>:<local>");
    expect(message).toContain("example:");
  });

  // The privilege case: an id claiming another namespace's prefix would be stored with that
  // system's `source_system` while having been authorized against this one.
  it("rejects an id whose prefix is a namespace the caller was not authorized for", () => {
    const message = checkPublicId("other:round", "example");
    expect(message).toContain("expected `example:…`");
    expect(message).toContain("got `other:…`");
  });

  it("rejects a missing or non-string id", () => {
    for (const id of [undefined, null, 42, "", "   "]) {
      expect(checkPublicId(id, "example"), JSON.stringify(id)).toContain("`id`");
    }
  });
});
