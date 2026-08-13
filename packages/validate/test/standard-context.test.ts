/**
 * THE JSON-LD CONTEXT'S `@vocab` SURFACE.
 *
 * `@vocab` is the highest-leverage single string in the standard. It does two things, and the
 * second one is invisible: it resolves every RELATIVE `@id` in a term definition, and it is the
 * fallback IRI for any key with no term definition at all. So changing `@vocab` silently
 * re-points every term that is not explicitly mapped to `schema:` or `daoip5:` — which is
 * exactly what the 2026-08-10 canonical-domain adoption did (`adr/0007`).
 *
 * That swap was safe, and this file is what makes the reasoning checkable rather than
 * remembered. It pins the PARTITION of the context: which terms borrow an external vocabulary,
 * which ones are the RFP Hub's own, and which ones are deliberately dropped. A future edit that
 * moves a term across that line — mapping one of our terms onto `schema:` or, worse, letting a
 * borrowed term fall back into our namespace — fails here with the term named.
 *
 * It intentionally does not run a JSON-LD processor. Compaction/expansion round-tripping over
 * the corpus was verified with jsonld.js during the M1 compatibility audit; what rots between
 * audits is the mapping table, and that is checkable from the document itself.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const standard = join(here, "..", "..", "standard");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const spec = readJson(join(standard, "spec.config.json"));
const contextDoc = readJson(join(standard, spec.schemaDir, "context.jsonld"));
const context: Record<string, unknown> = contextDoc["@context"];
const schema = readJson(join(standard, spec.schemaDir, "opportunity.schema.json"));

/** Prefix declarations — a term whose value is an absolute IRI string. */
const PREFIXES = Object.entries(context)
  .filter(
    ([term, value]) => term !== "@vocab" && typeof value === "string" && /^https?:/.test(value),
  )
  .map(([term]) => term);

type TermClass = "vocab" | "prefixed" | "absolute" | "dropped";

interface TermDef {
  /** Dotted path: bare for the top-level context, `deadlines.label` for a scoped one. */
  path: string;
  id: string | null;
  cls: TermClass;
  protectedTerm: boolean;
  /** True when the definition lives in a property-scoped `@context`, not the root context. */
  scoped: boolean;
}

function classify(id: string | null): TermClass {
  if (id === null) return "dropped";
  if (/^https?:/.test(id)) return "absolute";
  const prefix = id.split(":")[0] as string;
  if (id.includes(":") && PREFIXES.includes(prefix)) return "prefixed";
  return "vocab";
}

/** Every term definition in the document, root context and property-scoped contexts alike. */
function collect(node: Record<string, unknown>, scope = "", into: TermDef[] = []): TermDef[] {
  for (const [term, definition] of Object.entries(node)) {
    if (term.startsWith("@")) continue;
    if (scope === "" && PREFIXES.includes(term)) continue; // a prefix declaration, not a term
    const expanded =
      definition === null
        ? null
        : typeof definition === "string"
          ? definition
          : (((definition as Record<string, unknown>)["@id"] as string | undefined) ?? term);
    into.push({
      path: scope ? `${scope}.${term}` : term,
      id: expanded,
      cls: classify(expanded),
      protectedTerm: Boolean(
        definition && typeof definition === "object"
          ? (definition as Record<string, unknown>)["@protected"]
          : false,
      ),
      scoped: scope !== "",
    });
    const nested =
      definition && typeof definition === "object"
        ? ((definition as Record<string, unknown>)["@context"] as Record<string, unknown>)
        : undefined;
    if (nested) collect(nested, scope ? `${scope}.${term}` : term, into);
  }
  return into;
}

const terms = collect(context);
const pathsOf = (cls: TermClass) =>
  terms
    .filter((t) => t.cls === cls)
    .map((t) => t.path)
    .sort();

describe("@vocab itself", () => {
  it("is the IRI spec.config.json mints, and nothing else may write one", () => {
    expect(context["@vocab"]).toBe(spec.vocabIri);
  });

  // Term IRIs are versioned by the context DOCUMENT, never by the term. A namespace that moves
  // when the spec cuts a version invalidates every triple ever minted under it.
  it("is versionless and carries no maturity segment", () => {
    const vocab = context["@vocab"] as string;
    expect(vocab).not.toMatch(/\d+\.\d+\.\d+/);
    expect(vocab).not.toMatch(/\/(draft|alpha|beta|rc|unstable|wip)\//i);
  });

  // Terms are CONCATENATED onto @vocab, not resolved against it as a relative reference.
  // Without a trailing delimiter every vocabulary term IRI is silently fused and wrong.
  it("ends in a delimiter and is https", () => {
    const vocab = context["@vocab"] as string;
    expect(vocab.startsWith("https://")).toBe(true);
    expect(vocab).toMatch(/[#/]$/);
  });

  // The two external vocabularies are absolute prefixes, so they are structurally immune to an
  // @vocab change. This is the load-bearing half of "the swap was safe".
  it("cannot affect the borrowed vocabularies", () => {
    expect(PREFIXES.sort()).toEqual(["daoip5", "schema"]);
    for (const prefix of PREFIXES) {
      expect(String(context[prefix])).toMatch(/^https:\/\//);
    }
  });
});

describe("the @vocab surface — which terms move when the namespace moves", () => {
  /**
   * The RFP Hub's own vocabulary: terms with no schema.org or DAOIP-5 equivalent. Every one of
   * these moved with the namespace on 2026-08-10 and every one of them SHOULD have. Adding a
   * row here is a deliberate act — it means the standard is defining a term rather than
   * borrowing one, which is the decision `CROSSWALK.md` documents.
   *
   * The four bounty-split terms (`bountyKind`, `rewardTiers`, `severityScheme`,
   * `rewardPoolStatus`) are here for that reason and not by omission: neither schema.org nor
   * DAOIP-5 models a graded award table, so `CROSSWALK.md` records them as coined rather than
   * borrowed.
   */
  const RFPHUB_TERMS = [
    "allocated",
    "bountyKind",
    "criteria",
    "deadlines",
    "ecosystems",
    "fundingDetails",
    "ingestedVia",
    "maxAward",
    "milestoneBased",
    "milestones",
    "minAward",
    "portfolio",
    "prizes",
    "programModel",
    "recurring",
    "requirements",
    "rewardPoolStatus",
    "rewardTiers",
    "scope",
    "serviceAgreement",
    "severityScheme",
    "skills",
    "socialLinks",
    "socialLinks.platform",
    "source",
    "stages",
    "tracks",
    "verifiedAgainstSource",
    "verifiedAt",
  ];

  it("is exactly the RFP Hub's own vocabulary", () => {
    expect(pathsOf("vocab")).toEqual([...RFPHUB_TERMS].sort());
  });

  /**
   * The borrowed half of the partition, pinned as a TABLE rather than a count.
   *
   * A count plus a prefix regex is not a check on semantics: re-pointing `contacts` from
   * `schema:contactPoint` to some `daoip5:` IRI keeps the total at 40, keeps every entry matching
   * `^(schema|daoip5):`, and leaves the moved-set counterfactual reporting the same 25 paths —
   * while the standard now says something different about an external vocabulary. What a reader
   * of `CROSSWALK.md` is entitled to rely on is which external term each field means, so that is
   * what is written down here. Every row is a claim about someone else's vocabulary; changing one
   * is a crosswalk decision, and it should cost a deliberate edit to this table.
   */
  const BORROWED: Record<string, string> = {
    additionalReferences: "schema:citation",
    amount: "schema:value",
    applicationUrl: "schema:url",
    bannerUrl: "schema:image",
    budget: "daoip5:totalGrantPoolSize",
    categories: "schema:about",
    contacts: "schema:contactPoint",
    createdAt: "schema:dateCreated",
    currency: "schema:currency",
    date: "daoip5:closeDate",
    "deadlines.label": "schema:name",
    description: "schema:description",
    eligibility: "schema:eligibleCustomerType",
    email: "schema:email",
    "fundingDetails.funding": "schema:amount",
    fundingInfo: "schema:amount",
    fundingMechanisms: "daoip5:grantFundingMechanism",
    fundingType: "schema:additionalType",
    id: "schema:identifier",
    logoUrl: "schema:logo",
    opensAt: "schema:startDate",
    operatingOrganizations: "schema:sponsor",
    "operatingOrganizations.name": "schema:name",
    postedAt: "schema:datePublished",
    prerequisites: "schema:competencyRequired",
    publisher: "schema:publisher",
    role: "schema:roleName",
    snapshotUrl: "schema:archivedAt",
    "socialLinks.url": "schema:url",
    "source.originalId": "schema:identifier",
    "source.submittedAt": "schema:dateCreated",
    specVersion: "schema:schemaVersion",
    sponsoringOrganizations: "schema:funder",
    "sponsoringOrganizations.name": "schema:name",
    status: "daoip5:isOpen",
    submittedBy: "schema:contributor",
    summary: "schema:disambiguatingDescription",
    title: "schema:name",
    updatedAt: "schema:dateModified",
    website: "schema:sameAs",
  };

  it("borrows every other mapped term from schema.org or DAOIP-5, exactly as written", () => {
    const borrowed = Object.fromEntries(
      terms.filter((t) => t.cls === "prefixed").map((t) => [t.path, t.id as string]),
    );
    expect(borrowed).toEqual(BORROWED);
    expect(pathsOf("absolute")).toEqual([]); // nothing bypasses the prefixes
  });

  // The split the CHANGELOG states as "36 schema.org, 4 DAOIP-5" — derived from the table above,
  // so the two can never disagree, and asserted so the prose number stays checkable.
  it("splits 36 schema.org / 4 DAOIP-5", () => {
    const byPrefix = (prefix: string) =>
      Object.values(BORROWED).filter((id) => id.startsWith(`${prefix}:`)).length;
    expect([byPrefix("schema"), byPrefix("daoip5")]).toEqual([36, 4]);
    expect(Object.keys(BORROWED)).toHaveLength(40);
  });

  /**
   * Property-scoped `null` definitions. These exist so a term that means one thing at the top
   * level does not leak its meaning into a nested object (`title` is the opportunity's name; an
   * organisation's is `name`). They drop regardless of `@vocab`.
   */
  it("drops exactly the terms the scoped contexts null out", () => {
    expect(pathsOf("dropped")).toEqual([
      "deadlines.title",
      "operatingOrganizations.title",
      "source.createdAt",
      "source.id",
      "sponsoringOrganizations.title",
    ]);
  });

  /**
   * The counterfactual, stated as a property rather than a fixture: re-stamping `@vocab` with
   * ANY other IRI changes exactly the RFP Hub terms' IRIs and leaves every borrowed term
   * byte-identical. This is what "the swap is semantically safe" means, and it holds for the
   * next swap too — if there ever is one, which `adr/0007` says there will not be.
   */
  it("moves only the RFP Hub terms when @vocab is re-stamped", () => {
    const iris = (vocab: string) =>
      Object.fromEntries(
        terms
          .filter((t) => t.id !== null)
          .map((t) => [t.path, t.cls === "vocab" ? vocab + t.id : (t.id as string)]),
      );
    const before = iris(spec.vocabIri);
    const after = iris("https://elsewhere.invalid/ns/other#");
    const moved = Object.keys(before).filter((path) => before[path] !== after[path]);
    expect(moved.sort()).toEqual([...RFPHUB_TERMS].sort());
  });
});

describe("@protected terms", () => {
  const protectedTerms = terms.filter((t) => t.protectedTerm);

  it("protects the terms a consumer keys off, and only those", () => {
    expect(protectedTerms.map((t) => t.path).sort()).toEqual([
      "applicationUrl",
      "budget",
      "deadlines",
      "description",
      "eligibility",
      "fundingInfo",
      "fundingType",
      "id",
      "operatingOrganizations",
      "specVersion",
      "sponsoringOrganizations",
      "status",
      "summary",
      "title",
    ]);
  });

  /**
   * The one interaction worth naming: `deadlines` is BOTH `@protected` and `@vocab`-relative, so
   * its IRI moved with the namespace while the term stayed protected. That is coherent —
   * `@protected` forbids REDEFINITION during one document's processing, it says nothing about
   * the IRI a given context version maps a term to — but it is precisely the pairing a careless
   * edit gets wrong, so it is pinned rather than left to be re-derived.
   *
   * It is also the exact set that makes "`@protected` is unaffected" true only ONE CONTEXT
   * VERSION AT A TIME. A consumer who composes a pinned copy of a pre-2026-08-10 context with
   * this one in a single `@context` array gets a protected-term-redefinition error on precisely
   * these terms — the thirteen protected terms with absolute IRIs are identical across the two
   * and identical redefinition is permitted, so this list IS the collision set. Keeping it at
   * one is what keeps that caveat to one sentence in the CHANGELOG.
   */
  it("has exactly one protected term in the RFP Hub namespace", () => {
    expect(protectedTerms.filter((t) => t.cls === "vocab").map((t) => t.path)).toEqual([
      "deadlines",
    ]);
    // The other thirteen borrow an absolute IRI, so they are byte-identical across any @vocab.
    expect(protectedTerms.filter((t) => t.cls === "prefixed")).toHaveLength(13);
  });

  it("declares every protected term in the root context, never a scoped one", () => {
    expect(protectedTerms.filter((t) => t.scoped)).toEqual([]);
  });

  /**
   * JSON-LD 1.1 permits a PROPERTY-SCOPED context to override a protected term (§ protected
   * term definitions); an embedded or remote context may not. Every override here nulls `title`
   * inside a scoped context, which is legal — and would become an error if the same override
   * were ever hoisted to the root.
   */
  it("overrides protected terms only from property-scoped contexts", () => {
    const protectedNames = new Set(protectedTerms.map((t) => t.path));
    const overrides = terms.filter(
      (t) => t.scoped && protectedNames.has(t.path.split(".").pop() as string),
    );
    expect(overrides.map((t) => t.path).sort()).toEqual([
      "deadlines.title",
      "operatingOrganizations.title",
      "source.id",
      "sponsoringOrganizations.title",
    ]);
    for (const override of overrides) expect(override.cls).toBe("dropped");
  });
});

describe("keyword expansion — the invisible half of @vocab", () => {
  /** Every property name anywhere in the schema. */
  function schemaPropertyNames(node: unknown, into = new Set<string>()): Set<string> {
    if (!node || typeof node !== "object") return into;
    if (Array.isArray(node)) {
      for (const item of node) schemaPropertyNames(item, into);
      return into;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "properties" && value && typeof value === "object") {
        for (const name of Object.keys(value)) into.add(name);
      }
      schemaPropertyNames(value, into);
    }
    return into;
  }

  const SELF_ID = new Set(["$schema", "@context", "@type"]);
  const defined = new Set(terms.map((t) => t.path.split(".").pop() as string));
  const unmapped = [...schemaPropertyNames(schema)]
    .filter((name) => !defined.has(name) && !SELF_ID.has(name))
    .sort();

  /**
   * `check-spec.mjs` requires a context term for every TOP-LEVEL schema property. Nested
   * properties are deliberately left to `@vocab`'s keyword-expansion fallback — a field inside
   * `bounty` or `vc_fund` with no external equivalent is an RFP Hub term either way, and
   * declaring 28 more one-line mappings would add drift surface for no meaning. Pinning the
   * list is what keeps that a decision: a nested field that DOES have a schema.org equivalent
   * shows up here as a new entry and has to be mapped or consciously left alone.
   *
   * The eight added by the bounty split (`payout`, `model`, `percent`, `basis`, `floor`, `cap`,
   * `severity`, `assetType`) sit inside `$defs/rewardTier` and `$defs/payout` and take the same
   * treatment: `rewardTiers` is declared at the top of the context so the container semantics
   * are stated, and the tier's own interior expands by keyword.
   */
  it("leaves exactly these nested properties to the @vocab fallback", () => {
    expect(unmapped).toEqual([
      "activelyInvesting",
      "assetType",
      "basis",
      "batchSize",
      "cap",
      "checkSize",
      "contactMethod",
      "deadlineType",
      "difficulty",
      "equity",
      "floor",
      "location",
      "max",
      "min",
      "model",
      "online",
      "orgType",
      "payout",
      "percent",
      "programDurationWeeks",
      "reward",
      "severity",
      "slug",
      "stage",
      "teamSize",
      "telegram",
      "thesis",
      "track",
    ]);
  });

  // The top level is closed (`additionalProperties: false`), so a VALID document can never
  // carry a key the context has not accounted for one way or the other.
  it("cannot be reached by an undeclared top-level key", () => {
    expect(schema.additionalProperties).toBe(false);
  });
});
