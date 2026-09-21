/**
 * The ingest URL policy — pure, no DB.
 *
 * The premise this file exists to pin down: the standard types these fields as `format: uri`, and
 * `uri` is RFC 3986, so `javascript:`, `data:`, `vbscript:`, `file:` and `ftp:` are all well-formed
 * and all pass schema validation. Every value in `REFUSED` below is one the validator calls
 * conformant. If a change ever makes this suite pass for the wrong reason, the assertion in
 * "the schema alone does not catch these" is what fails first.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Opportunity } from "@the-rfp-hub/standard";
import { validateOpportunity } from "rfphub-validate";
import { describe, expect, it } from "vitest";
import { documentsFromCorpus } from "../../scripts/seed.js";
import { isPublishableUrl, urlPolicyProblems } from "../../src/modules/shared/url-policy.js";

const CORPUS_PATH = fileURLToPath(new URL("../../data/seed-corpus.json", import.meta.url));
const DOCUMENTS = documentsFromCorpus(JSON.parse(readFileSync(CORPUS_PATH, "utf8")), CORPUS_PATH);
/** One real document of each shape the corpus carries — the policy must be silent on all of them. */
const SAMPLES: Opportunity[] = [...new Map(DOCUMENTS.map((d) => [d.fundingType, d])).values()];

/** Schemes a publisher may not put behind this hub's name. */
const REFUSED = [
  "javascript:alert(document.cookie)",
  "JavaScript:alert(1)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "ftp://example.org/apply",
  "http://example.org/apply",
  // The right scheme, but a RELATIVE reference: `new URL` resolves it to the same href, and the raw
  // string is what ships in the feeds and the export, where a consumer resolves it against a
  // different base entirely.
  "https:example.org/apply",
  "https:/example.org/apply",
];

const ACCEPTED = [
  "https://example.org/apply",
  "https://example.org/apply?a=1&b=2#frag",
  "https://sub.example.org:8443/a/b",
  "HTTPS://example.org",
  // Plaintext that crosses no network segment. The same exemption `config.ts` states for
  // PUBLIC_BASE_URL, through the same predicate — and the e2e stands up a real fixture web server
  // on 127.0.0.1 and points records at it.
  "http://localhost:3001/apply",
  "http://127.0.0.1:8080/apply",
  "http://127.0.0.2/apply",
  "http://api.localhost:3001/apply",
  "http://[::1]:3001/apply",
  // The ROOT-ANCHORED form of the same names: a resolver treats these identically, and the
  // compliance runner accepts `--api http://localhost.:3001`.
  "http://localhost.:3001/apply",
  "http://api.localhost.:3001/apply",
];

/** A minimal object shell — the walk reads by shape and never needs a valid document. */
function doc(patch: Record<string, unknown>): Record<string, unknown> {
  return { id: "test:1", title: "t", ...patch };
}

describe("isPublishableUrl", () => {
  it.each(ACCEPTED)("accepts %s", (url) => {
    expect(isPublishableUrl(url)).toBe(true);
  });

  it.each(REFUSED)("refuses %s", (url) => {
    expect(isPublishableUrl(url)).toBe(false);
  });

  it("refuses a value that is not an absolute URL at all", () => {
    for (const value of ["/apply", "example.org", "", "   "]) {
      expect(isPublishableUrl(value)).toBe(false);
    }
  });
});

describe("urlPolicyProblems", () => {
  it("the schema alone does not catch these", () => {
    // The whole reason the policy is not a `pattern` in the schema: these validate today.
    for (const url of REFUSED) {
      const record = { ...SAMPLES[0], applicationUrl: url } as unknown;
      expect(validateOpportunity(record, { checks: false }).valid).toBe(true);
    }
  });

  it("is silent on a conformant document", () => {
    for (const sample of SAMPLES) {
      expect(urlPolicyProblems(sample as unknown as Record<string, unknown>)).toEqual([]);
    }
  });

  it.each(["applicationUrl", "website", "logoUrl", "bannerUrl"])(
    "refuses a non-https `%s` and points at the field",
    (field) => {
      const problems = urlPolicyProblems(doc({ [field]: "javascript:alert(1)" }));
      expect(problems).toEqual([
        {
          path: `/${field}`,
          message: "must be an `https://` URL — the javascript: scheme is not published.",
        },
      ]);
    },
  );

  it("names `http:` as its own mistake rather than an unpublishable scheme", () => {
    expect(urlPolicyProblems(doc({ applicationUrl: "http://example.org/apply" }))).toEqual([
      {
        path: "/applicationUrl",
        message: "must use `https:`, not `http:` (which is accepted only on loopback).",
      },
    ]);
  });

  /**
   * `https:example.org` names the RIGHT scheme and is still refused, so a message about schemes
   * would send its author looking in the wrong place.
   */
  it("tells a relative reference apart from a wrong scheme", () => {
    expect(urlPolicyProblems(doc({ applicationUrl: "https:example.org/apply" }))).toEqual([
      {
        path: "/applicationUrl",
        message:
          "must be written in full, as `https://host/path` — this form is a relative reference.",
      },
    ]);
  });

  it("treats a root-anchored loopback name as loopback", () => {
    expect(urlPolicyProblems(doc({ applicationUrl: "http://localhost.:3001/apply" }))).toEqual([]);
    // Not a name any resolver accepts, so it is not quietly collapsed into one that is.
    expect(
      urlPolicyProblems(doc({ applicationUrl: "http://localhost..:3001/apply" })),
    ).toHaveLength(1);
    expect(urlPolicyProblems(doc({ applicationUrl: "http://example.com./apply" }))).toHaveLength(1);
  });

  it("allows plaintext on loopback, and only there", () => {
    expect(urlPolicyProblems(doc({ applicationUrl: "http://127.0.0.1:8080/apply" }))).toEqual([]);
    // A private LAN address is not loopback: that traffic crosses a real network.
    expect(urlPolicyProblems(doc({ applicationUrl: "http://192.168.1.10/apply" }))).toHaveLength(1);
    expect(urlPolicyProblems(doc({ applicationUrl: "http://10.0.0.1/apply" }))).toHaveLength(1);
  });

  it("reaches organization URLs on both sides of the funding relationship", () => {
    const problems = urlPolicyProblems(
      doc({
        operatingOrganizations: [{ slug: "a", name: "A", website: "javascript:alert(1)" }],
        sponsoringOrganizations: [{ slug: "b", name: "B", logoUrl: "http://b.example/logo.png" }],
      }),
    );
    expect(problems.map((p) => p.path)).toEqual([
      "/operatingOrganizations/0/website",
      "/sponsoringOrganizations/0/logoUrl",
    ]);
  });

  it("reaches social links on the document and on an organization", () => {
    const problems = urlPolicyProblems(
      doc({
        socialLinks: [
          { platform: "twitter", url: "https://x.example/a" },
          { platform: "discord", url: "javascript:alert(1)" },
        ],
        operatingOrganizations: [
          { slug: "a", name: "A", socialLinks: [{ platform: "github", url: "data:text/html,x" }] },
        ],
      }),
    );
    expect(problems.map((p) => p.path)).toEqual([
      "/socialLinks/1/url",
      "/operatingOrganizations/0/socialLinks/0/url",
    ]);
  });

  it("reaches the provenance snapshot, which the seed path takes from the document", () => {
    const problems = urlPolicyProblems(doc({ source: { snapshotUrl: "ftp://archive.example/x" } }));
    expect(problems.map((p) => p.path)).toEqual(["/source/snapshotUrl"]);
  });

  it("stays silent on absent, null and empty values — optionality is the schema's business", () => {
    expect(
      urlPolicyProblems(doc({ applicationUrl: null, website: undefined, logoUrl: "" })),
    ).toEqual([]);
  });

  it("ignores `$schema`, which names a contract rather than a destination we republish", () => {
    expect(urlPolicyProblems(doc({ $schema: "http://example.org/schema.json" }))).toEqual([]);
  });

  it("reports every offending field at once rather than the first", () => {
    const problems = urlPolicyProblems(
      doc({ applicationUrl: "javascript:alert(1)", website: "http://example.org" }),
    );
    expect(problems).toHaveLength(2);
  });
});
