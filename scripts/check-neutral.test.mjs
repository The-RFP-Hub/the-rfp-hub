/**
 * THE NEUTRALITY AND IDENTITY RULES.
 *
 * Three things have to be true of this checker and none is obvious from reading it: it must catch
 * the commissioning platform's name in the project's own voice — its source, schemas, workflows and
 * docs — where a tracker-ID-only rule could not see it; it must NOT fire on the archived interview
 * record, which quotes real organizations and is a historical document rather than the project
 * speaking; and it must not fire on the ordinary English, lockfile hashes and source-browsing links
 * that make up most of a repository. A rule that contributors have to work around gets worked
 * around, and a rule that pushes them to edit a primary source is worse than no rule.
 *
 * Every forbidden string below is assembled from parts, for the same reason the checker assembles
 * its own patterns: this file is tracked, so it is scanned by the rules it tests.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanText } from "./check-neutral.mjs";

const BRAND = ["kar", "ma"].join("");
const OTHER = ["g", "ap"].join("");
const RETIRED_BASE = [
  "https://raw.",
  "githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/packages/standard",
].join("");
const RETIRED_VOCAB = ["https://github.com/The-RFP-Hub/the-rfp-hub/ns/", "draft", "/rfp#"].join("");
const CANONICAL = "https://ethrfps.app";
const RETIRED_NS = `${CANONICAL}/ns/draft/rfp#`;
const OFF_DOMAIN = ["https://cdn.somewhere", ".net/schemas/v1.0.0/opportunity.schema.json"].join(
  "",
);
const PLAINTEXT_API = ["http", "://api.ethrfps.app"].join("");
const PLAINTEXT_APEX = ["http", "://ethrfps.app/schemas/index.json"].join("");
const TRACKER = ["DEV", "1234"].join("-");

const rules = (text) => scanText("f.md", text).map((f) => f.rule);
const clean = (text) => expect(scanText("f.md", text)).toEqual([]);

describe("source neutrality", () => {
  // Prose in the project's own voice — a README, a doc, an ADR — in any casing or possessive.
  it("catches the commissioning platform's name in prose, in any casing or possessive", () => {
    for (const line of [
      `It also uses an exploratory audit of ${BRAND} platform data.`,
      `A separate audit of ${BRAND}'s platform data produced one insight.`,
      `Participants were recruited through ${BRAND.toUpperCase()}, Ethereum Foundation, and others.`,
      `see the show-${BRAND} indexer`,
      `${BRAND}hq/somewhere`,
    ]) {
      expect(rules(line), line).toContain("source-neutral");
    }
  });

  it("catches the source's product names, npm scope and hostname", () => {
    for (const line of [
      `fetch("https://${OTHER}api.example.com/v1")`,
      `the ${OTHER}-indexer subgraph`,
      `"@${OTHER}/sdk": "^1.0.0"`,
      `https://${OTHER}.example.org/v1/attestations`,
    ]) {
      expect(rules(line), line).toContain("source-neutral");
    }
  });

  /**
   * The three-letter token is an ordinary English word and appears inside base64 integrity hashes.
   * A raw substring ban would be unusable, and an unusable rule is a rule that gets deleted — so
   * the boundary policy is part of the check, not an accident of implementation.
   */
  it("does not fire on ordinary English or on lockfile noise", () => {
    clean("There is a gap between what publishers write and what builders read.");
    clean("This gaps the two ranges; mind the gap, and the gapped rows.");
    clean("  resolution: {integrity: sha512-Xy0gapQzR7lkA1+B0h2Fg9pGaPQ==}");
    clean("The stopgap is documented in ARTIFACTS.md.");
  });
});

describe("tracker IDs", () => {
  it("catches an internal tracker ID and reports the line", () => {
    const [hit] = scanText("adr/0007.md", `line one\nrefs ${TRACKER} here\n`);
    expect(hit).toMatchObject({ file: "adr/0007.md", line: 2, rule: "tracker-id" });
  });

  it("does not fire on ordinary hyphenated capitals", () => {
    clean("RFC-9110 and DAOIP-5 and the DEV environment and ADR-0007.");
  });
});

describe("identity", () => {
  // The review's scenario: a new API README example advertising the retired raw schema URL, in a
  // package the standard's own package-local sweep never walks.
  it("catches a retired provisional identifier anywhere in the repository", () => {
    expect(rules(`curl ${RETIRED_BASE}/schemas/v1.0.0/opportunity.schema.json`)).toContain(
      "identity",
    );
    expect(rules(`"@vocab": "${RETIRED_VOCAB}"`)).toContain("identity");
  });

  it("catches an identifier-shaped URL on any other authority", () => {
    expect(rules(`$schema: ${OFF_DOMAIN}`)).toEqual(["identity"]);
    expect(rules(`@vocab is ${RETIRED_NS}`)).toEqual(["identity"]);
  });

  it("catches the retired placeholder domain and the retired npm scope", () => {
    expect(rules(`see https://${["rfphub", "org"].join(".")}/schemas`)).toContain("identity");
    expect(rules(`"@${["rfp", "hub"].join("-")}/standard": "workspace:*"`)).toContain("identity");
  });

  // `.app` is HSTS-preloaded, so a plaintext URL on this domain is broken rather than lenient.
  it("catches a plaintext URL on the canonical domain, apex or subdomain", () => {
    expect(rules(`PUBLIC_BASE_URL=${PLAINTEXT_API}`)).toEqual(["identity"]);
    expect(rules(PLAINTEXT_APEX)).toEqual(["identity"]);
    clean("https://api-staging.ethrfps.app is the staging API.");
  });

  it("leaves the canonical identifiers alone", () => {
    clean('"$id": "https://ethrfps.app/schemas/v1.0.0/opportunity.schema.json"');
    clean('"@vocab": "https://ethrfps.app/ns/rfp#"');
    clean("https://ethrfps.app/meta/rfphub-schema.meta.json");
  });

  /**
   * The two shapes that would otherwise make this rule unusable: a repository is browsed by URL,
   * and reserved names (RFC 2606) exist precisely so a fixture can name something that is not real.
   */
  it("does not fire on source-browsing links or on reserved-name fixtures", () => {
    clean(
      "https://github.com/The-RFP-Hub/the-rfp-hub/blob/main/packages/standard/schemas/v1.0.0/FIELDS.md",
    );
    clean("https://example.invalid/ns/draft/rfp#");
    clean("const OLD = 'https://elsewhere.invalid/schemas/v1.0.0/opportunity.schema.json';");
  });

  it("does not fire on foreign /ns/ IRIs the docs legitimately cite", () => {
    clean('rel="http://www.w3.org/ns/json-ld#context"');
    clean("https://www.w3.org/ns/prov#wasDerivedFrom");
  });
});

/**
 * THE ARCHIVE BOUNDARY — pinned in BOTH directions, because only one direction is a rule.
 *
 * The interview archive is a historical record of what people outside this project said. It is
 * exempt from the neutrality rule so that nobody is ever pushed to edit a primary source to make a
 * lint pass. That exemption is worth exactly as much as the other direction is worth: the same
 * sentence, in a file the project wrote, must still fail.
 */
describe("archived source material", () => {
  const ARCHIVED = "user-interviews/M1-Research-Report.md";
  // A second listed record, so the waiver is pinned as per-path rather than as one special file.
  const ALSO_ARCHIVED = "user-interviews/Publisher-EF-Grants.md";

  // Real sentences from the restored report. They name the platform because the research did.
  const QUOTED = [
    `It also uses an exploratory audit of ${BRAND} platform data and a review of adjacent standards.`,
    `Participants were recruited through ${BRAND}, Ethereum Foundation, and the research lead's network.`,
    `DAO Security Fund expects ${BRAND} to pull structured RFP data from its own platform.`,
    `The ${BRAND} audit found that milestone and update counts can remain impressive.`,
  ];

  it("does not fire on the platform's name inside an archived record", () => {
    for (const line of QUOTED) expect(scanText(ARCHIVED, line), line).toEqual([]);
    expect(scanText(ALSO_ARCHIVED, `Intro via ${BRAND}; follow-up scheduled.`)).toEqual([]);
  });

  // The other direction. Same string, project voice: source, schema, workflow, README, ADR.
  it("still fires on the same name in every project-voice file", () => {
    for (const file of [
      "packages/api/src/modules/shared/canonical-documents.ts",
      "packages/standard/schemas/v1.0.0/opportunity.schema.json",
      ".github/workflows/spec-freeze.yml",
      "README.md",
      "packages/standard/PROCESS.md",
      "adr/0007-canonical-domain-and-spec-identity.md",
    ]) {
      for (const line of QUOTED) {
        expect(
          scanText(file, line).map((f) => f.rule),
          `${file}: ${line}`,
        ).toContain("source-neutral");
      }
    }
  });

  // The folder is not a shelter. Only the listed records are archived source; the README in that
  // same directory is the project describing its own archive, so it is the project's voice.
  it("does not exempt project-voice documents that sit in the archive directory", () => {
    expect(rules(`This archive was assembled with ${BRAND}.`)).toContain("source-neutral");
    for (const file of [
      "user-interviews/README.md",
      "user-interviews/CONTRIBUTING.md",
      "user-interviews/2026-M2-research-plan.md",
      "user-interviews/subdir/M1-Research-Report.md",
    ]) {
      expect(
        scanText(file, `The hub is operated with ${BRAND}.`).map((f) => f.rule),
        file,
      ).toContain("source-neutral");
    }
  });

  // Only `source-neutral` is waived. Everything else applies to the archive like anywhere else.
  it("still applies every other rule inside the archive", () => {
    expect(scanText(ARCHIVED, `tracked as ${TRACKER}`).map((f) => f.rule)).toEqual(["tracker-id"]);
    expect(
      scanText(ARCHIVED, `see ${RETIRED_BASE}/schemas/v1.0.0/opportunity.schema.json`),
    ).not.toEqual([]);
    expect(scanText(ARCHIVED, PLAINTEXT_APEX).map((f) => f.rule)).toEqual(["identity"]);
    expect(scanText(ARCHIVED, `$schema: ${OFF_DOMAIN}`).map((f) => f.rule)).toEqual(["identity"]);
    expect(
      scanText(ARCHIVED, `see https://${["rfphub", "org"].join(".")}/schemas`).map((f) => f.rule),
    ).toContain("identity");
  });

  // The record itself, as filed. If a future edit scrubs it neutral, this says so out loud.
  it("scans the archive on disk clean, with its attributions intact", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const read = (rel) => readFileSync(join(dir, "..", rel), "utf8");

    for (const rel of [ARCHIVED, ALSO_ARCHIVED]) expect(scanText(rel, read(rel)), rel).toEqual([]);

    // The report audited a named platform's dataset and says so. If that ever reads as a generic
    // "an existing grants platform", the record has been rewritten to satisfy a lint — which is
    // exactly what this exemption exists to prevent.
    expect(read(ARCHIVED).toLowerCase()).toContain(BRAND);
  });
});
