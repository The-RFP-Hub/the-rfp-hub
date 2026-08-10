/**
 * THE FREEZE GATE'S OWN CLAIMS, CHECKED.
 *
 * A gate is a security control, and a security control nobody attacks is a comment. Every `it`
 * below that begins "rejects" is an attempt to land a change the gate says it prevents — including
 * the two that a review DEMONSTRATED against the previous, text-matching gate in an isolated
 * clone: widening the published v1.0.0 `status` enum inside the adoption PR, and riding a second
 * JSON member on the `$id` line so the "$id-line-only" grep filtered the whole line away.
 *
 * `evaluate()` takes its repository as a parameter, so these run against an in-memory tree in
 * microseconds and need no clone, no fixtures on disk and no network.
 */
import { describe, expect, it } from "vitest";
import {
  STANDARD,
  adoptionRule,
  bytesBeyondIdentifiers,
  canonicalUrl,
  diffPointers,
  evaluate,
} from "./spec-freeze.mjs";

// The identifiers this standard published before it owned a domain, and the ones it owns now.
const OLD_BASE = "https://example.invalid/provisional/packages/standard";
const OLD_VOCAB = "https://example.invalid/ns/draft/rfp#";
const NEW_BASE = "https://ethrfps.app";
const NEW_VOCAB = "https://ethrfps.app/ns/rfp#";

const ADR = "adr/0007-canonical-domain-and-spec-identity.md";
const adrText = `# 0007. Adopt the canonical domain

- **Status:** accepted
- **Date:** 2026-08-10

Identifiers move to ${NEW_BASE} and the vocabulary namespace to ${NEW_VOCAB}.
`;

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const specConfig = (base, vocab, extra) =>
  json({
    specVersion: "1.0.0",
    schemaDir: "schemas/v1.0.0",
    baseUrl: base,
    vocabIri: vocab,
    status: extra?.status ?? "draft",
    ...(extra?.identity ?? {}),
  });

const schemaDoc = (base, extra) =>
  json({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${base}/schemas/v1.0.0/opportunity.schema.json`,
    title: "RFP Hub Opportunity",
    type: "object",
    properties: {
      $schema: { type: "string", examples: [`${base}/schemas/v1.0.0/opportunity.schema.json`] },
      "@context": { examples: [`${base}/schemas/v1.0.0/context.jsonld`] },
      status: {
        type: "string",
        enum: ["upcoming", "open", "closed", "archived", ...(extra ?? [])],
      },
    },
    additionalProperties: false,
  });

const contextDoc = (vocab) =>
  json({ "@context": { "@version": 1.1, "@vocab": vocab, schema: "https://schema.org/" } });

const metaDoc = (base, extra) =>
  json({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${base}/meta/rfphub-schema.meta.json`,
    title: "RFP Hub schema metaschema",
    type: "object",
    ...(extra ?? {}),
  });

const entryDoc = (base) =>
  json({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${base}/registries/entry.schema.json`,
    title: "RFP Hub registry file",
  });

const selfIdFixture = (base) =>
  json({
    $schema: `${base}/schemas/v1.0.0/opportunity.schema.json`,
    "@context": `${base}/schemas/v1.0.0/context.jsonld`,
    specVersion: "1.0.0",
    id: "conformance:self-id",
  });

const fullFixture = (base, extra) =>
  json({
    $schema: `${base}/schemas/v1.0.0/opportunity.schema.json`,
    specVersion: "1.0.0",
    id: "conformance:full",
    status: extra ?? "open",
  });

const s = (p) => `${STANDARD}/${p}`;

/** The repository as `origin/main` had it: v1.0.0 published, draft, provisional identifiers. */
const baseTree = () => ({
  [s("spec.config.json")]: specConfig(OLD_BASE, OLD_VOCAB),
  [s("schemas/v1.0.0/opportunity.schema.json")]: schemaDoc(OLD_BASE),
  [s("schemas/v1.0.0/context.jsonld")]: contextDoc(OLD_VOCAB),
  [s("schemas/v1.0.0/FIELDS.md")]: "# Field Reference\n\n> **Maturity: `draft`.**\n",
  [s("schemas/v1.0.0/examples/grant.json")]: json({ id: "example:1" }),
  [s("conformance/v1.0.0/pass/self-identification.json")]: selfIdFixture(OLD_BASE),
  [s("conformance/v1.0.0/pass/full-featured.json")]: fullFixture(OLD_BASE),
  [s("conformance/v1.0.0/fail/status-not-in-enum.json")]: json({ status: "paused" }),
  [s("meta/rfphub-schema.meta.json")]: metaDoc(OLD_BASE),
  [s("registries/entry.schema.json")]: entryDoc(OLD_BASE),
  [ADR]: adrText,
});

/** The adoption as this branch actually performs it: identifiers swapped, marker landed. */
const adoptionHead = (over = {}) => ({
  ...baseTree(),
  [s("spec.config.json")]: specConfig(NEW_BASE, NEW_VOCAB, {
    status: "stable",
    identity: { identityStatus: "canonical", identityAdoption: { date: "2026-08-10", adr: ADR } },
  }),
  [s("schemas/v1.0.0/opportunity.schema.json")]: schemaDoc(NEW_BASE),
  [s("schemas/v1.0.0/context.jsonld")]: contextDoc(NEW_VOCAB),
  [s("schemas/v1.0.0/FROZEN")]: "RFP Hub Standard v1.0.0 — FROZEN 2026-08-10.\n",
  [s("conformance/v1.0.0/pass/self-identification.json")]: selfIdFixture(NEW_BASE),
  [s("conformance/v1.0.0/pass/full-featured.json")]: fullFixture(NEW_BASE),
  [s("meta/rfphub-schema.meta.json")]: metaDoc(NEW_BASE),
  [s("registries/entry.schema.json")]: entryDoc(NEW_BASE),
  ...over,
});

/** The repository AFTER the adoption merged — the state every later PR is judged against. */
const frozenTree = () => adoptionHead();

const WATCHED_RE = new RegExp(
  `^${STANDARD}/(schemas/v[^/]+/|conformance/v[^/]+/|meta/|registries/entry\\.schema\\.json$|spec\\.config\\.json$)`,
);

/** An in-memory stand-in for the three git reads `evaluate()` performs. */
function fakeRepo(trees) {
  return {
    changed(base, head) {
      const a = trees[base];
      const b = trees[head];
      const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) =>
        WATCHED_RE.test(p),
      );
      return paths
        .filter((p) => a[p] !== b[p])
        .map((p) => ({ status: !(p in a) ? "A" : !(p in b) ? "D" : "M", path: p }))
        .sort((x, y) => x.path.localeCompare(y.path));
    },
    read: (rev, path) => trees[rev][path] ?? null,
    frozenVersions: (rev) =>
      Object.keys(trees[rev])
        .map((p) => p.match(/^packages\/standard\/schemas\/(v[^/]+)\/FROZEN$/)?.[1])
        .filter((v) => v !== undefined),
  };
}

const run = (base, head) => evaluate(fakeRepo({ base, head }), "base", "head");
const messages = (result) => result.violations.join("\n");

// ---------------------------------------------------------------- structural JSON diff ---

describe("structural JSON diff", () => {
  it("names the pointer of a changed scalar, however the file is formatted", () => {
    expect(diffPointers({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } })).toEqual(["/b/c"]);
  });

  it("names an added or removed member", () => {
    expect(diffPointers({ a: 1 }, { a: 1, b: 2 })).toEqual(["/b"]);
    expect(diffPointers({ a: 1, b: 2 }, { a: 1 })).toEqual(["/b"]);
  });

  it("treats re-ordered members as a difference — these are published bytes", () => {
    expect(diffPointers({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual(["/ (key order)"]);
  });

  it("walks arrays by index and reports a length change", () => {
    expect(diffPointers({ e: [1, 2] }, { e: [1, 2, 3] })).toEqual(["/e/2"]);
    expect(diffPointers({ e: ["x"] }, { e: ["y"] })).toEqual(["/e/0"]);
  });

  it("distinguishes types that compare equal loosely", () => {
    expect(diffPointers({ a: 1 }, { a: "1" })).toEqual(["/a"]);
    expect(diffPointers({ a: null }, { a: {} })).toEqual(["/a"]);
  });

  it("escapes pointer tokens per RFC 6901", () => {
    expect(diffPointers({ "a/b": 1 }, { "a/b": 2 })).toEqual(["/a~1b"]);
    expect(diffPointers({ "a~b": 1 }, { "a~b": 2 })).toEqual(["/a~0b"]);
  });
});

describe("the adoption allowlist", () => {
  const spec = { baseUrl: NEW_BASE, vocabIri: NEW_VOCAB, schemaDir: "schemas/v1.0.0" };

  it("derives each identifier from the file's own path under baseUrl", () => {
    expect(canonicalUrl(spec, s("meta/rfphub-schema.meta.json"))).toBe(
      `${NEW_BASE}/meta/rfphub-schema.meta.json`,
    );
    expect(adoptionRule(s("registries/entry.schema.json"), spec).pointers["/$id"]).toBe(
      `${NEW_BASE}/registries/entry.schema.json`,
    );
    // A future version directory needs no edit to this gate.
    expect(adoptionRule(s("schemas/v2.0.0/opportunity.schema.json"), spec).pointers["/$id"]).toBe(
      `${NEW_BASE}/schemas/v2.0.0/opportunity.schema.json`,
    );
  });

  it("covers nothing outside the enumerated files", () => {
    expect(adoptionRule(s("conformance/v1.0.0/pass/accelerator.json"), spec)).toBeNull();
    expect(adoptionRule(s("conformance/v1.0.0/fail/status-not-in-enum.json"), spec)).toBeNull();
    expect(adoptionRule(s("schemas/v1.0.0/examples/grant.json"), spec)).toBeNull();
    expect(adoptionRule(s("registries/deadline-labels.json"), spec)).toBeNull();
  });
});

// ------------------------------------------------------------------- the adoption PR ---

describe("the one-time identity adoption", () => {
  it("accepts the swap this branch actually performs", () => {
    const result = run(baseTree(), adoptionHead());
    expect(messages(result)).toBe("");
    expect(result.ok).toBe(true);
    expect(result.notes.join("\n")).toContain("one-time identity adoption");
  });

  /**
   * BYPASS 1, reproduced. Demonstrated against the previous gate: the versioned-directory rule
   * read FROZEN from the base ref, the base had no marker, so the PR that declared v1.0.0 stable
   * could also rewrite what v1.0.0 MEANS. "The first freeze may finish the directory" is not a
   * rule this gate has.
   */
  it("rejects widening the published status enum inside the adoption PR", () => {
    const head = adoptionHead({
      [s("schemas/v1.0.0/opportunity.schema.json")]: schemaDoc(NEW_BASE, ["paused"]),
    });
    const result = run(baseTree(), head);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("unexpected change at /properties/status/enum/4");
  });

  /**
   * BYPASS 2, reproduced. Also demonstrated: the previous gate dropped every diff line matching
   * `^[+-]\s*"\$id":`, and JSON is free to put a second member on that line, so a real
   * meta-schema constraint rode along and was reported as an `$id`-only change.
   */
  it("rejects a second JSON member riding on the $id line", () => {
    // The reproduction verbatim: one diff line, two members, still valid JSON.
    const rider = metaDoc(NEW_BASE).replace(
      `"$id": "${NEW_BASE}/meta/rfphub-schema.meta.json",`,
      `"$id": "${NEW_BASE}/meta/rfphub-schema.meta.json", "minProperties": 1,`,
    );
    expect(rider.split("\n").filter((l) => l.includes("minProperties"))).toHaveLength(1);
    expect(JSON.parse(rider).minProperties).toBe(1);
    const head = adoptionHead({ [s("meta/rfphub-schema.meta.json")]: rider });
    const result = run(baseTree(), head);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("unexpected change at /minProperties");
  });

  it("rejects re-ordering a versionless artifact's members while the door is open", () => {
    const reordered = json({
      $id: `${NEW_BASE}/meta/rfphub-schema.meta.json`,
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "RFP Hub schema metaschema",
      type: "object",
    });
    const result = run(
      baseTree(),
      adoptionHead({ [s("meta/rfphub-schema.meta.json")]: reordered }),
    );
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("key order");
  });

  it("rejects an identifier that is not the one spec.config.json derives", () => {
    const head = adoptionHead({
      [s("registries/entry.schema.json")]: entryDoc("https://attacker.invalid"),
    });
    const result = run(baseTree(), head);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("does not adopt the identifier spec.config.json derives");
  });

  it("rejects editing a conformance case that is not a self-identification fixture", () => {
    const head = adoptionHead({
      [s("conformance/v1.0.0/fail/status-not-in-enum.json")]: json({ status: "open" }),
    });
    const result = run(baseTree(), head);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("may not touch this file");
  });

  it("rejects a self-identification fixture that changes more than its identifiers", () => {
    const head = adoptionHead({
      [s("conformance/v1.0.0/pass/full-featured.json")]: fullFixture(NEW_BASE, "archived"),
    });
    const result = run(baseTree(), head);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("unexpected change at /status");
  });

  it("rejects adding a new file to the version directory under cover of the adoption", () => {
    const head = adoptionHead({ [s("conformance/v1.0.0/pass/extra.json")]: json({ id: "x" }) });
    const result = run(baseTree(), head);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("may not touch this file");
  });

  /**
   * BYPASS 3. Structure is not bytes, and "immutable bytes" is the promise PROCESS.md and
   * NORMATIVE.md make. A reflowed document and a re-escaped identifier both PARSE identical to the
   * permitted result, so a pointer diff alone reports nothing at all — while a consumer who hashed
   * the published file receives something else. The exemption is meant to be maximally narrow, so
   * the adoption path ends on the bytes.
   */
  it("rejects re-formatting a published file while the adoption door is open", () => {
    const head = adoptionHead({
      // Same document, same key order, same values — compact instead of indented.
      [s("meta/rfphub-schema.meta.json")]: JSON.stringify(JSON.parse(metaDoc(NEW_BASE))),
    });
    const result = run(baseTree(), head);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("changes published bytes");
    expect(messages(result)).toContain("bytes diverge at line");
  });

  it("rejects an identifier that parses correctly but is escaped differently", () => {
    const escaped = schemaDoc(NEW_BASE).replace(
      `"${NEW_BASE}/schemas/v1.0.0/opportunity.schema.json"`,
      `"${NEW_BASE.replace(/\//g, "\\/")}\\/schemas\\/v1.0.0\\/opportunity.schema.json"`,
    );
    // It really does parse to the right identifier — that is the whole point of the attempt.
    expect(JSON.parse(escaped).$id).toBe(`${NEW_BASE}/schemas/v1.0.0/opportunity.schema.json`);

    const result = run(
      baseTree(),
      adoptionHead({ [s("schemas/v1.0.0/opportunity.schema.json")]: escaped }),
    );
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("changes published bytes");
  });

  // A file listed as modified whose parse is identical on both sides: there is no differing
  // pointer, so the allowlist and the value check both pass vacuously and report nothing. Only the
  // byte check has anything to say about it at all.
  it("rejects a whitespace-only rewrite that produces no differing pointer", () => {
    const head = adoptionHead({ [s("meta/rfphub-schema.meta.json")]: `${metaDoc(OLD_BASE)}\n` });
    const result = run(baseTree(), head);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("changes published bytes");
  });
});

// ------------------------------------------------------------------------- the byte check ---

describe("bytes beyond the identifier substitution", () => {
  const sub = (from, to) => [JSON.stringify(from), JSON.stringify(to)];

  it("accepts the base bytes with every occurrence of the identifier substituted", () => {
    expect(
      bytesBeyondIdentifiers(schemaDoc(OLD_BASE), schemaDoc(NEW_BASE), [
        sub(
          `${OLD_BASE}/schemas/v1.0.0/opportunity.schema.json`,
          `${NEW_BASE}/schemas/v1.0.0/opportunity.schema.json`,
        ),
        sub(
          `${OLD_BASE}/schemas/v1.0.0/context.jsonld`,
          `${NEW_BASE}/schemas/v1.0.0/context.jsonld`,
        ),
      ]),
    ).toBeNull();
  });

  it("accepts an untouched file and rejects one whitespace character", () => {
    expect(bytesBeyondIdentifiers("{}\n", "{}\n", [])).toBeNull();
    expect(bytesBeyondIdentifiers("{}\n", "{} \n", [])).toMatch(/bytes diverge/);
  });

  /**
   * The substitution must be REAL. A published value the base file does not contain verbatim means
   * the parse and the bytes disagree, which is the condition this check exists to detect — so an
   * unused substitution fails rather than degrading to a plain equality test.
   */
  it("rejects a substitution the base file's bytes never contained", () => {
    expect(bytesBeyondIdentifiers('{"a":"x"}', '{"a":"y"}', [sub("q", "y")])).toMatch(
      /does not appear verbatim/,
    );
  });

  it("refuses to map one published value onto two different identifiers", () => {
    expect(
      bytesBeyondIdentifiers('{"a":"x","b":"x"}', '{"a":"y","b":"z"}', [
        sub("x", "y"),
        sub("x", "z"),
      ]),
    ).toMatch(/would have to become both/);
  });

  // Substituted text is never re-scanned, so a new value containing an old one is not rewritten
  // a second time. Quoting is what keeps the pairs from interfering at all.
  it("substitutes in a single left-to-right pass", () => {
    expect(bytesBeyondIdentifiers('["a","b"]', '["ab","b"]', [sub("a", "ab")])).toBeNull();
  });
});

// --------------------------------------------------------------- the governance record ---

describe("identityAdoption.adr must name a decision record that records THIS adoption", () => {
  const withAdr = (adr) =>
    adoptionHead({
      [s("spec.config.json")]: specConfig(NEW_BASE, NEW_VOCAB, {
        status: "stable",
        identity: { identityStatus: "canonical", identityAdoption: { adr } },
      }),
    });

  it("rejects a path that is not a decision record", () => {
    for (const adr of ["package.json", "adr", "adr/README.md", "docs/0007-thing.md"]) {
      const result = run(baseTree(), withAdr(adr));
      expect(result.ok, adr).toBe(false);
      expect(messages(result)).toContain("not a decision record path");
    }
  });

  it("rejects a record that is not accepted", () => {
    const head = withAdr(ADR);
    head[ADR] = adrText.replace("accepted", "proposed");
    const result = run(baseTree(), head);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("**Status:** accepted");
  });

  it("rejects a record that never names the identity it sanctions", () => {
    const head = withAdr(ADR);
    head[ADR] = adrText.replace(NEW_VOCAB, "some other namespace");
    const result = run(baseTree(), head);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("never names the vocabIri");
  });

  it("rejects a missing record", () => {
    const head = withAdr("adr/0099-does-not-exist.md");
    const result = run(baseTree(), head);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("is not a file at HEAD");
  });
});

// ------------------------------------------------------------ life after the adoption ---

describe("once a version is frozen at the base ref", () => {
  it("rejects an edit to the schema", () => {
    const head = { ...frozenTree() };
    head[s("schemas/v1.0.0/opportunity.schema.json")] = schemaDoc(NEW_BASE, ["paused"]);
    const result = run(frozenTree(), head);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("v1.0.0 is FROZEN");
  });

  it("rejects an edit to the context, a conformance case, or a shipped example", () => {
    for (const [path, content] of [
      [s("schemas/v1.0.0/context.jsonld"), contextDoc("https://elsewhere.invalid/ns/rfp#")],
      [s("conformance/v1.0.0/pass/full-featured.json"), fullFixture(NEW_BASE, "archived")],
      [s("schemas/v1.0.0/examples/grant.json"), json({ id: "example:2" })],
    ]) {
      const head = { ...frozenTree(), [path]: content };
      const result = run(frozenTree(), head);
      expect(result.ok, path).toBe(false);
      expect(messages(result)).toContain("v1.0.0 is FROZEN");
    }
  });

  /**
   * PROCESS.md: "Informative documents may be corrected at any time." The previous gate rejected
   * every path below schemas/v1.0.0/, which left the project unable to fix the stale maturity
   * banner in FIELDS.md without violating one of its own two written policies.
   */
  it("permits correcting the informative documents NORMATIVE.md names", () => {
    const head = { ...frozenTree() };
    head[s("schemas/v1.0.0/FIELDS.md")] = "# Field Reference\n\n> **Maturity: `stable`.**\n";
    const result = run(frozenTree(), head);
    expect(messages(result)).toBe("");
    expect(result.ok).toBe(true);
  });

  it("does not let 'informative' cover adding to or deleting from a published directory", () => {
    const added = { ...frozenTree(), [s("schemas/v1.0.0/ERRATA.md")]: "# Errata\n" };
    expect(run(frozenTree(), added).ok).toBe(false);
    const removed = { ...frozenTree() };
    delete removed[s("schemas/v1.0.0/CROSSWALK.md")];
    delete removed[s("schemas/v1.0.0/FIELDS.md")];
    expect(run(frozenTree(), removed).ok).toBe(false);
  });

  it("rejects deleting the FROZEN marker to land a change", () => {
    const head = { ...frozenTree() };
    delete head[s("schemas/v1.0.0/FROZEN")];
    head[s("schemas/v1.0.0/opportunity.schema.json")] = schemaDoc(NEW_BASE, ["paused"]);
    const result = run(frozenTree(), head);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("v1.0.0 is FROZEN");
  });

  it("rejects editing the versionless artifacts and the identity fields", () => {
    const meta = {
      ...frozenTree(),
      [s("meta/rfphub-schema.meta.json")]: metaDoc(NEW_BASE, { minProperties: 1 }),
    };
    expect(messages(run(frozenTree(), meta))).toContain("versionless normative artifacts");

    const identity = { ...frozenTree() };
    identity[s("spec.config.json")] = specConfig("https://elsewhere.invalid", NEW_VOCAB, {
      status: "stable",
      identity: { identityStatus: "canonical", identityAdoption: { adr: ADR } },
    });
    expect(messages(run(frozenTree(), identity))).toContain("spec.config.json identity fields");
  });

  it("rejects re-arming the exemption by reverting to provisional", () => {
    const head = { ...frozenTree() };
    head[s("spec.config.json")] = specConfig(OLD_BASE, OLD_VOCAB, {
      status: "stable",
      identity: { identityStatus: "provisional" },
    });
    const result = run(frozenTree(), head);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("Adoption is irreversible");
  });

  it("rejects dropping identityStatus entirely", () => {
    const head = { ...frozenTree() };
    head[s("spec.config.json")] = specConfig(OLD_BASE, OLD_VOCAB, { status: "stable" });
    expect(messages(run(frozenTree(), head))).toContain("Adoption is irreversible");
  });

  it("still permits cutting — and freezing — a NEW version directory", () => {
    const head = { ...frozenTree() };
    head[s("schemas/v2.0.0/opportunity.schema.json")] = schemaDoc(NEW_BASE).replace(
      /v1\.0\.0/g,
      "v2.0.0",
    );
    head[s("schemas/v2.0.0/context.jsonld")] = contextDoc(NEW_VOCAB);
    head[s("schemas/v2.0.0/FROZEN")] = "RFP Hub Standard v2.0.0 — FROZEN.\n";
    head[s("conformance/v2.0.0/pass/full-featured.json")] = fullFixture(NEW_BASE);
    const result = run(frozenTree(), head);
    expect(messages(result)).toBe("");
    expect(result.ok).toBe(true);
  });

  it("passes when nothing normative is touched", () => {
    const result = run(frozenTree(), frozenTree());
    expect(result.ok).toBe(true);
    expect(result.notes).toEqual(["no normative spec artifact touched"]);
  });
});
