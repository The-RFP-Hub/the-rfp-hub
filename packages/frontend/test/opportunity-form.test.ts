/**
 * The form's mapping, in both directions.
 *
 * The round trip is the part worth testing: `PUT` REPLACES a stored record, so anything the edit
 * form fails to carry through is data a publisher loses by pressing Save. The second thing worth
 * testing is the schema's CONDITIONALS — the six `fundingDetails` branches, the bounty's
 * exactly-one compensation rule and the payout models — because every one of them forbids the
 * members belonging to its siblings, which means a form that hides a field instead of clearing it
 * produces a document that does not validate on a field nobody can see.
 */
import {
  type OpportunityFormState,
  deriveId,
  describePublish,
  emptyForm,
  emptyOrganization,
  emptyPrize,
  emptyRewardTier,
  fieldAdvisories,
  fieldProblems,
  fromDocument,
  fromIsoUtc,
  idProblem,
  localTimeZoneDescription,
  moveRow,
  namespaceAuthority,
  namespaceOf,
  parseValidationIssueLine,
  slugifyTitle,
  splitLines,
  splitList,
  toDocument,
  toIsoUtc,
  utcPreview,
  validationPointerToFormPath,
} from "@/lib/opportunity-form";
import type { Opportunity } from "@/lib/types";
import { validateDocument } from "@/lib/validate-client";
import { describe, expect, it } from "vitest";

/** A form that is conformant on its own, so a test can add exactly one problem to it. */
function usable(over: Partial<OpportunityFormState> = {}): OpportunityFormState {
  const form = emptyForm();
  return {
    ...form,
    id: "acme:round-one",
    title: "Round One",
    description: "A description.",
    operatingOrganizations: [{ ...emptyOrganization(), name: "Acme Foundation", slug: "acme" }],
    ...over,
  };
}

describe("validation issue mapping", () => {
  it("maps root, array and funding envelope pointers to form controls", () => {
    expect(validationPointerToFormPath("(root)", "grant")).toBe("(root)");
    expect(validationPointerToFormPath("/operatingOrganizations/0/slug", "grant")).toBe(
      "operatingOrganizations.0.slug",
    );
    expect(validationPointerToFormPath("/fundingInfo/budget", "grant")).toBe("budget");
    expect(validationPointerToFormPath("/fundingDetails/programModel", "grant")).toBe(
      "details.grant.programModel",
    );
    expect(validationPointerToFormPath("/fundingDetails/checkSize/max", "vc_fund")).toBe(
      "details.vc_fund.checkMax",
    );
  });

  it("unescapes JSON Pointer tokens and leaves server-owned paths unlinked", () => {
    expect(validationPointerToFormPath("/fundingInfo/bud~1get", "grant")).toBeNull();
    expect(validationPointerToFormPath("/source/submittedBy", "grant")).toBeNull();
    expect(validationPointerToFormPath("/specVersion", "grant")).toBeNull();
  });

  it("parses every non-standard error line shape", () => {
    expect(parseValidationIssueLine("(root) must be an object")).toMatchObject({
      path: "(root)",
      message: "must be an object",
    });
    expect(
      parseValidationIssueLine(
        "/fundingDetails/programModel grant details: must be a registered value",
      ),
    ).toMatchObject({
      path: "/fundingDetails/programModel",
      message: "must be a registered value",
    });
    expect(
      parseValidationIssueLine(
        "fundingDetails.fundingType 'grant' does not match the opportunity's fundingType 'rfp'",
      ),
    ).toMatchObject({ path: "/fundingType" });
    expect(
      parseValidationIssueLine("`title` must be at most 256 characters (got 300)."),
    ).toMatchObject({ path: "/title", message: "must be at most 256 characters (got 300)." });
    expect(parseValidationIssueLine("An unclassified server validation failure")).toMatchObject({
      path: null,
      message: "An unclassified server validation failure",
    });
  });
});

describe("splitList", () => {
  it("trims, drops blanks and never produces an empty string entry", () => {
    expect(splitList(" ethereum , optimism ,, ")).toEqual(["ethereum", "optimism"]);
    expect(splitList("")).toEqual([]);
  });

  it("dedupes, because every array it feeds is uniqueItems in the schema", () => {
    expect(splitList("DeFi, defi, DeFi")).toEqual(["DeFi", "defi"]);
  });

  it("splits the line-shaped lists on lines, so an item may contain a comma", () => {
    expect(splitLines("One, with a comma\n\n  Two  \nOne, with a comma")).toEqual([
      "One, with a comma",
      "Two",
    ]);
  });
});

describe("idProblem", () => {
  it("requires the namespaced form the API derives the source system from", () => {
    expect(idProblem("")).toContain("required");
    expect(idProblem("no-namespace")).toContain("organization slug and a colon");
    expect(idProblem(":leading")).toContain("organization slug and a colon");
    expect(idProblem("trailing:")).toContain("organization slug and a colon");
    expect(idProblem("acme-foundation:2026-round-1")).toBeNull();
  });

  it("holds the id to the schema's own character set", () => {
    expect(idProblem("acme:round one")).toContain("letters, digits");
    expect(idProblem(`acme:${"x".repeat(200)}`)).toContain("128");
  });
});

describe("the derived id", () => {
  it("proposes the organization slug and the slugified title", () => {
    expect(deriveId("acme", "Round One: Public Goods!")).toBe("acme:round-one-public-goods");
  });

  it("strips accents rather than turning each one into a hyphen", () => {
    expect(slugifyTitle("Café Découverte")).toBe("cafe-decouverte");
  });

  it("proposes nothing at all rather than half an id", () => {
    expect(deriveId("", "Round One")).toBe("");
    expect(deriveId("acme", "")).toBe("");
  });

  it("is a proposal the schema accepts", () => {
    expect(idProblem(deriveId("acme", "Round One"))).toBeNull();
  });
});

describe("the id's namespace", () => {
  it("must be the primary operating organization — the namespace the API derives", () => {
    const problems = fieldProblems(usable({ id: "beta:round-one" }));
    expect(problems.id).toContain("acme");
  });

  it("names the fix when the namespace runs the programme but is not primary", () => {
    const form = usable({
      id: "beta:round-one",
      operatingOrganizations: [
        { ...emptyOrganization(), name: "Acme Foundation", slug: "acme" },
        { ...emptyOrganization(), name: "Beta Collective", slug: "beta" },
      ],
    });
    expect(fieldProblems(form).id).toContain("not the primary organization");
  });

  it("is happy when the two agree", () => {
    expect(fieldProblems(usable()).id).toBeUndefined();
  });
});

/**
 * A CREATE and a REPLACE are not authorised against the same namespace, and the form used to treat
 * them as if they were.
 *
 * On a create the API derives the namespace from `operatingOrganizations[0].slug` and requires the
 * id to start with it. On a REPLACE it never looks at the id — which is immutable — and authorises
 * against the row's STORED `source.publisher`, asking only that the publisher still appears among
 * the operating organizations. A claimed or imported listing carries an id from the system it came
 * from while being operated by the organization that claimed it, so holding the id to the primary
 * operator on edit refused a PUT the API would have accepted, and told the publisher to fix a field
 * they cannot change.
 */
describe("the namespace a write is authorised against", () => {
  /** A claimed listing: an imported id, published under and operated by the claimant. */
  const claimed = (over: Record<string, unknown> = {}) =>
    ({
      specVersion: "1.0.0",
      id: "host:123",
      fundingType: "grant",
      title: "Round One",
      description: "A description.",
      status: "open",
      operatingOrganizations: [{ name: "Acme Foundation", slug: "acme" }],
      source: { publisher: "acme", ingestedVia: "import" },
      fundingDetails: { fundingType: "grant" },
      ...over,
    }) as unknown as Opportunity;

  it("is the primary operator on a create", () => {
    const authority = namespaceAuthority("create", usable());
    expect(authority).toEqual({ mode: "create", namespace: "acme", requiresOperating: false });
  });

  it("is the STORED publisher on a replace, not the id", () => {
    const { form, carried } = fromDocument(claimed());
    const authority = namespaceAuthority("edit", form, carried);
    expect(authority.namespace).toBe("acme");
    expect(namespaceOf(form.id)).toBe("host");
  });

  it("lets a claimed listing be replaced without a local error", () => {
    const { form, carried } = fromDocument(claimed());
    const authority = namespaceAuthority("edit", form, carried);
    const built = toDocument(form, carried, authority);

    expect(built.fieldProblems.id).toBeUndefined();
    expect(built.problems).toEqual([]);
  });

  it("FALSIFIES the old behaviour: the same form is blocked on a create and allowed on a replace", () => {
    const { form, carried } = fromDocument(claimed());
    // Create — the id must start with the primary operator's slug, and `host` does not.
    expect(fieldProblems(form, namespaceAuthority("create", form)).id).toContain("acme");
    // Replace — the id is not the question at all.
    expect(fieldProblems(form, namespaceAuthority("edit", form, carried)).id).toBeUndefined();
  });

  it("asks the question the API actually asks on a replace: does the publisher survive?", () => {
    const { form, carried } = fromDocument(claimed());
    const dropped = {
      ...form,
      operatingOrganizations: [{ ...emptyOrganization(), name: "Beta Collective", slug: "beta" }],
    };
    const problems = fieldProblems(dropped, namespaceAuthority("edit", dropped, carried));
    expect(problems.operatingOrganizations).toContain("published under acme");
  });

  it("holds the publisher in place wherever it sits, not only at position 0", () => {
    const { form, carried } = fromDocument(claimed());
    const demoted = {
      ...form,
      operatingOrganizations: [
        { ...emptyOrganization(), name: "Beta Collective", slug: "beta" },
        ...form.operatingOrganizations,
      ],
    };
    // `acme` is no longer primary, and the API does not care — containment is the rule, not order.
    expect(
      fieldProblems(demoted, namespaceAuthority("edit", demoted, carried)).operatingOrganizations,
    ).toBeUndefined();
  });

  it("grandfathers a legacy import that never conformed, exactly as the API does", () => {
    // Published under `optimism`, operated by somebody else, and imported: never passed the
    // create-time gate, so enforcing containment on edit would only lock it out of corrections.
    const legacy = claimed({
      operatingOrganizations: [{ name: "A Foundation", slug: "a-foundation" }],
      source: { publisher: "optimism", ingestedVia: "import" },
    });
    const { form, carried } = fromDocument(legacy);
    const authority = namespaceAuthority("edit", form, carried);

    expect(authority.requiresOperating).toBe(false);
    expect(fieldProblems(form, authority).operatingOrganizations).toBeUndefined();
  });

  it("does NOT grandfather a row that came through the authenticated write path", () => {
    // The exemption is provenance-scoped, not merely "non-conforming".
    const authed = claimed({
      operatingOrganizations: [{ name: "A Foundation", slug: "a-foundation" }],
      source: { publisher: "optimism", ingestedVia: "submission" },
    });
    const { form, carried } = fromDocument(authed);
    const authority = namespaceAuthority("edit", form, carried);

    expect(authority.requiresOperating).toBe(true);
    expect(fieldProblems(form, authority).operatingOrganizations).toContain("optimism");
  });

  it("checks nothing when the stored record names no publisher", () => {
    const { form, carried } = fromDocument(claimed({ source: {} }));
    const authority = namespaceAuthority("edit", form, carried);
    expect(authority).toEqual({ mode: "edit", namespace: null, requiresOperating: false });
    expect(fieldProblems(form, authority)).toEqual({});
  });

  it("defaults to a create, which is the stricter reading", () => {
    const { form } = fromDocument(claimed());
    expect(fieldProblems(form).id).toContain("acme");
    expect(toDocument(form).fieldProblems.id).toContain("acme");
  });
});

describe("describePublish", () => {
  it("says immediately for a verified namespace", () => {
    const said = describePublish("acme:x", { verifiedNamespaces: ["acme"], directCreate: false });
    expect(said?.immediate).toBe(true);
    expect(said?.because).toContain("verified member of acme");
  });

  it("says pending, and names the namespaces that would not be", () => {
    const said = describePublish("beta:x", { verifiedNamespaces: ["acme"], directCreate: false });
    expect(said?.immediate).toBe(false);
    expect(said?.because).toContain("acme");
  });

  it("says pending for an account with no verified membership at all", () => {
    const said = describePublish("beta:x", { verifiedNamespaces: [], directCreate: false });
    expect(said?.immediate).toBe(false);
    expect(said?.because).toContain("not a member of a verified organization");
  });

  it("honours the account-level direct-create grant whatever the namespace", () => {
    const said = describePublish("beta:x", { verifiedNamespaces: [], directCreate: true });
    expect(said?.immediate).toBe(true);
  });

  it("states the rule rather than guessing the outcome when it has not been told", () => {
    expect(describePublish("acme:x", undefined)?.immediate).toBeNull();
  });

  it("says nothing at all about an id with no namespace yet", () => {
    expect(describePublish("half-typed", undefined)).toBeNull();
  });

  it("keys a REPLACE to the stored publisher rather than to the immutable id", () => {
    const said = describePublish(
      "host:123",
      { verifiedNamespaces: ["acme"], directCreate: false },
      "acme",
    );
    expect(said?.immediate).toBe(true);
    expect(said?.because).toContain("verified member of acme");
    // …and does not send the publisher off to edit a field they cannot change.
    expect(said?.because).not.toContain("part before the colon");
    expect(said?.because).toContain("not the id");
  });

  it("still blames the colon when the stored publisher IS the id's prefix", () => {
    const said = describePublish(
      "acme:x",
      { verifiedNamespaces: ["acme"], directCreate: false },
      "acme",
    );
    expect(said?.because).toContain("part before the colon");
  });

  it("predicts pending from the stored publisher, not from a prefix that says otherwise", () => {
    const said = describePublish(
      "acme:x",
      { verifiedNamespaces: ["acme"], directCreate: false },
      "host",
    );
    expect(said?.immediate).toBe(false);
  });
});

describe("timestamps", () => {
  it("converts the publisher's local wall time to the trailing-Z instant the schema pins", () => {
    expect(toIsoUtc("2026-09-30T23:59")).toBe("2026-10-01T02:59:00.000Z");
    expect(toIsoUtc("2026-09-30T23:59:59")).toBe("2026-10-01T02:59:59.000Z");
  });

  it("round-trips a stored instant through the widget unchanged", () => {
    const stored = "2026-12-01T00:00:00.000Z";
    expect(toIsoUtc(fromIsoUtc(stored))).toBe(stored);
  });

  it("uses the suite's pinned non-UTC browser zone", () => {
    expect(toIsoUtc("2026-01-01T00:00")).toBe("2026-01-01T03:00:00.000Z");
    expect(localTimeZoneDescription("2026-01-01T00:00")).toBe("America/Sao_Paulo, UTC−03:00");
  });

  it("previews the UTC clock and includes its date when conversion crosses midnight", () => {
    expect(utcPreview("2026-01-01T10:00")).toBe("= 13:00 UTC");
    expect(utcPreview("2026-09-30T23:59")).toBe("= 2026-10-01 02:59 UTC");
  });

  it("chooses the earlier instant in a repeated fall-back hour", () => {
    // São Paulo repeated 23:00–23:59 when DST ended in 2018. JavaScript chooses the first copy,
    // still at UTC−02:00; the later instant would have been 02:30Z at UTC−03:00.
    expect(toIsoUtc("2018-02-17T23:30")).toBe("2018-02-18T01:30:00.000Z");
  });

  it("treats an empty box as absence, and a half-typed one as no value yet", () => {
    expect(toIsoUtc("")).toBeUndefined();
    expect(toIsoUtc("2026-09")).toBeUndefined();
    expect(toIsoUtc("not a date")).toBeUndefined();
  });
});

describe("toDocument", () => {
  it("omits empty optional fields rather than storing an empty string", () => {
    const { document, problems } = toDocument(usable());

    expect(problems).toEqual([]);
    expect(document.summary).toBeUndefined();
    expect(document.website).toBeUndefined();
    expect(document.ecosystems).toBeUndefined();
    expect(document.fundingInfo).toBeUndefined();
    expect(document.deadlines).toBeUndefined();
    expect(document.specVersion).toBe("1.0.0");
    expect(document.operatingOrganizations).toEqual([{ name: "Acme Foundation", slug: "acme" }]);
  });

  it("never sets an attribution field — the server owns every one of them", () => {
    expect(toDocument(usable()).document.source).toEqual({});
  });

  it("reports a non-numeric amount, and does not put it in the document", () => {
    const built = toDocument(usable({ budget: "a lot" }));
    expect(built.fieldProblems.budget).toContain("not a number");
    expect(built.document.fundingInfo).toBeUndefined();
  });

  it("rejects a negative amount, which the schema bounds at zero", () => {
    expect(toDocument(usable({ minAward: "-5" })).fieldProblems.minAward).toContain("negative");
  });

  it("keeps numeric amounts numeric", () => {
    const { document } = toDocument(usable({ currency: "USD", budget: "50000" }));
    expect(document.fundingInfo).toEqual({ currency: "USD", budget: 50000 });
  });

  it("rejects a URL with no scheme, which is what publishers actually type", () => {
    expect(toDocument(usable({ website: "example.org" })).fieldProblems.website).toContain(
      "full URL",
    );
    expect(
      toDocument(usable({ website: "https://example.org" })).fieldProblems.website,
    ).toBeUndefined();
  });

  it("produces a document the Standard's own validator accepts", () => {
    const result = validateDocument(toDocument(usable()).document);
    expect(result.available).toBe(true);
    if (result.available) expect(result.errors).toEqual([]);
  });
});

describe("the deadline conditional", () => {
  const withDeadline = (deadlineType: "fixed" | "rolling", date: string) =>
    usable({
      deadlines: [{ key: "d1", deadlineType, date, label: "application", base: {} }],
    });

  it("requires a date on a fixed deadline", () => {
    const built = toDocument(withDeadline("fixed", ""));
    expect(built.fieldProblems["deadlines.0.date"]).toContain("needs a date");
  });

  it("writes the date on a fixed deadline as a trailing-Z instant", () => {
    const built = toDocument(withDeadline("fixed", "2026-09-30T23:59"));
    expect(built.problems).toEqual([]);
    expect(built.document.deadlines).toEqual([
      { deadlineType: "fixed", date: "2026-10-01T02:59:00.000Z", label: "application" },
    ]);
  });

  it("DROPS the date when the deadline turns rolling, rather than carrying a dead one", () => {
    const built = toDocument(withDeadline("rolling", "2026-09-30T23:59"));
    expect(built.document.deadlines).toEqual([{ deadlineType: "rolling", label: "application" }]);
    expect(built.problems).toEqual([]);
  });

  it("refuses two identical deadlines, which the schema calls a uniqueItems failure", () => {
    const one = {
      key: "d1",
      deadlineType: "fixed" as const,
      date: "2026-09-30T23:59",
      label: "application",
      base: {},
    };
    const built = toDocument(usable({ deadlines: [one, { ...one, key: "d2" }] }));
    expect(built.fieldProblems["deadlines.1.label"]).toContain("already listed");
  });
});

describe("switching funding type", () => {
  it("clears the previous branch's fields rather than carrying them into a closed object", () => {
    const stored = {
      specVersion: "1.0.0",
      id: "acme:hack",
      fundingType: "hackathon",
      title: "A Hackathon",
      description: "Build things.",
      status: "open",
      operatingOrganizations: [{ name: "Acme Foundation", slug: "acme" }],
      source: {},
      fundingDetails: {
        fundingType: "hackathon",
        tracks: ["DeFi"],
        prizes: [{ amount: 1000 }],
      },
    } as unknown as Opportunity;

    const { form, carried } = fromDocument(stored);
    expect(form.details.hackathon.tracks).toBe("DeFi");

    const { document } = toDocument({ ...form, fundingType: "grant" }, carried);
    // Not "hidden" — GONE. Every branch is `additionalProperties: false`, so a leftover `tracks`
    // is a hard validation failure on a field the publisher can no longer see.
    expect(document.fundingDetails).toEqual({ fundingType: "grant" });

    const result = validateDocument(document);
    if (result.available) expect(result.errors).toEqual([]);
  });

  it("keeps the branch's own state so switching back does not lose the typing", () => {
    const form = usable({ fundingType: "hackathon" });
    form.details.hackathon.tracks = "DeFi, Infra";
    const grant = toDocument({ ...form, fundingType: "grant" }).document;
    expect(grant.fundingDetails).toEqual({ fundingType: "grant" });
    const back = toDocument(form).document;
    expect(back.fundingDetails).toEqual({ fundingType: "hackathon", tracks: ["DeFi", "Infra"] });
  });
});

describe("the bounty's exactly-one compensation rule", () => {
  const bounty = (over: Partial<OpportunityFormState["details"]["bounty"]>) => {
    const form = usable({ fundingType: "bounty" });
    form.details.bounty = { ...form.details.bounty, ...over };
    return form;
  };

  it("a task bounty with a single reward carries no table", () => {
    const built = toDocument(bounty({ bountyKind: "task", rewardMode: "single", reward: "500" }));
    expect(built.document.fundingDetails).toEqual({
      fundingType: "bounty",
      bountyKind: "task",
      reward: 500,
    });
    expect(built.problems).toEqual([]);
  });

  it("a task bounty switched to a table DROPS the single reward it had", () => {
    const tier = {
      ...emptyRewardTier(),
      severity: "high",
      payout: { ...emptyRewardTier().payout, model: "fixed" as const, amount: "500" },
    };
    const built = toDocument(
      bounty({ bountyKind: "task", rewardMode: "tiers", reward: "500", rewardTiers: [tier] }),
    );
    const details = built.document.fundingDetails as Record<string, unknown>;
    expect("reward" in details).toBe(false);
    expect(details.rewardTiers).toEqual([
      { severity: "high", payout: { model: "fixed", amount: 500 } },
    ]);
  });

  it("a security bounty is forbidden the single reward outright, whatever the mode says", () => {
    const tier = {
      ...emptyRewardTier(),
      severity: "critical",
      payout: { ...emptyRewardTier().payout, model: "fixed" as const, amount: "100000" },
    };
    const built = toDocument(
      bounty({ bountyKind: "security", rewardMode: "single", reward: "500", rewardTiers: [tier] }),
    );
    const details = built.document.fundingDetails as Record<string, unknown>;
    expect("reward" in details).toBe(false);
    expect(built.problems).toEqual([]);
    const result = validateDocument(built.document);
    if (result.available) expect(result.errors).toEqual([]);
  });

  it("says so when a task bounty states neither", () => {
    const built = toDocument(bounty({ bountyKind: "task", rewardMode: "single", reward: "" }));
    expect(built.fieldProblems["details.bounty.reward"]).toContain("neither");
  });

  it("says so when a security bounty has an empty table", () => {
    const built = toDocument(bounty({ bountyKind: "security", rewardTiers: [] }));
    expect(built.fieldProblems["details.bounty.rewardTiers"]).toContain("at least one tier");
  });

  it("requires a tier to carry a selector, not only a payout", () => {
    const built = toDocument(
      bounty({
        bountyKind: "security",
        rewardTiers: [
          {
            ...emptyRewardTier(),
            payout: { ...emptyRewardTier().payout, model: "fixed", amount: "1" },
          },
        ],
      }),
    );
    expect(built.fieldProblems["details.bounty.rewardTiers.0.severity"]).toContain(
      "severity, an asset type or a label",
    );
  });
});

describe("switching a tier's payout model", () => {
  const tierWith = (payout: Partial<ReturnType<typeof emptyRewardTier>["payout"]>) => {
    const form = usable({ fundingType: "bounty" });
    form.details.bounty = {
      ...form.details.bounty,
      bountyKind: "security",
      rewardTiers: [
        {
          ...emptyRewardTier(),
          severity: "critical",
          payout: { ...emptyRewardTier().payout, ...payout },
        },
      ],
    };
    return form;
  };
  const payoutOf = (form: OpportunityFormState) =>
    (
      (toDocument(form).document.fundingDetails as Record<string, unknown>).rewardTiers as Record<
        string,
        unknown
      >[]
    )[0]?.payout;

  it("keeps only the amount on a fixed tier", () => {
    // Every other box still holds what the publisher typed before switching; none of it is sent.
    const form = tierWith({
      model: "fixed",
      amount: "1000",
      min: "1",
      max: "2",
      percent: "3",
      floor: "4",
      cap: "5",
    });
    expect(payoutOf(form)).toEqual({ model: "fixed", amount: 1000 });
  });

  it("keeps min and max on a range", () => {
    const form = tierWith({ model: "range", amount: "9", min: "10", max: "20" });
    expect(payoutOf(form)).toEqual({ model: "range", min: 10, max: 20 });
  });

  it("keeps only the ceiling on an up-to", () => {
    const form = tierWith({ model: "up_to", min: "1", max: "20" });
    expect(payoutOf(form)).toEqual({ model: "up_to", max: 20 });
  });

  it("keeps percent, basis and the optional bounds on a percentage", () => {
    const form = tierWith({
      model: "percentage",
      amount: "9",
      percent: "10",
      basis: "value_at_risk",
      floor: "1000",
      cap: "50000",
    });
    expect(payoutOf(form)).toEqual({
      model: "percentage",
      percent: 10,
      basis: "value_at_risk",
      floor: 1000,
      cap: 50000,
    });
  });

  it("keeps nothing at all on a discretionary tier", () => {
    const form = tierWith({ model: "discretionary", amount: "9", percent: "10", cap: "5" });
    expect(payoutOf(form)).toEqual({ model: "discretionary" });
  });

  it("bounds a percentage at 100", () => {
    const form = tierWith({ model: "percentage", percent: "150", basis: "value_at_risk" });
    expect(toDocument(form).fieldProblems["details.bounty.rewardTiers.0.payout.percent"]).toContain(
      "at most 100",
    );
  });

  it("produces a table the Standard's own validator accepts", () => {
    const form = tierWith({ model: "range", min: "10000", max: "100000" });
    const result = validateDocument(toDocument(form).document);
    if (result.available) expect(result.errors).toEqual([]);
  });
});

describe("null as a positive assertion", () => {
  it("writes an explicit null location for a fully online hackathon", () => {
    const form = usable({ fundingType: "hackathon" });
    form.details.hackathon.fullyOnline = true;
    const details = toDocument(form).document.fundingDetails as Record<string, unknown>;
    expect("location" in details).toBe(true);
    expect(details.location).toBeNull();
  });

  it("OMITS the location when the question was simply not answered", () => {
    const form = usable({ fundingType: "hackathon" });
    const details = toDocument(form).document.fundingDetails as Record<string, unknown>;
    expect("location" in details).toBe(false);
  });

  it("reads a stored null back as the claim, not as an empty box", () => {
    const stored = {
      specVersion: "1.0.0",
      id: "acme:hack",
      fundingType: "hackathon",
      title: "A Hackathon",
      description: "Build things.",
      status: "open",
      operatingOrganizations: [{ name: "Acme Foundation", slug: "acme" }],
      source: {},
      fundingDetails: { fundingType: "hackathon", location: null },
    } as unknown as Opportunity;

    const { form, carried } = fromDocument(stored);
    expect(form.details.hackathon.fullyOnline).toBe(true);
    // …and an untouched save keeps saying it.
    const details = toDocument(form, carried).document.fundingDetails as Record<string, unknown>;
    expect(details.location).toBeNull();
  });

  it("does the same for an accelerator, whose null location reads 'fully remote'", () => {
    const form = usable({ fundingType: "accelerator" });
    form.details.accelerator.fullyRemote = true;
    const details = toDocument(form).document.fundingDetails as Record<string, unknown>;
    expect(details.location).toBeNull();
  });
});

describe("the nullable booleans", () => {
  it("omit the member when nobody said, rather than asserting false", () => {
    const form = usable();
    const details = toDocument(form).document.fundingDetails as Record<string, unknown>;
    expect("recurring" in details).toBe(false);
  });

  it("write a real false when somebody actually said no", () => {
    const form = usable();
    form.details.grant.recurring = "no";
    const details = toDocument(form).document.fundingDetails as Record<string, unknown>;
    expect(details.recurring).toBe(false);
  });
});

describe("moveRow", () => {
  it("moves a row and leaves the rest in order", () => {
    expect(moveRow(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveRow(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  });

  it("does nothing at the ends", () => {
    const rows = ["a", "b"];
    expect(moveRow(rows, 0, -1)).toBe(rows);
    expect(moveRow(rows, 1, 1)).toBe(rows);
  });
});

describe("fromDocument", () => {
  const stored = {
    specVersion: "1.0.0",
    id: "acme:1",
    fundingType: "grant",
    title: "Round One",
    description: "A description.",
    status: "open",
    ecosystems: ["ethereum", "optimism"],
    operatingOrganizations: [{ name: "Acme Foundation", slug: "acme" }],
    source: { publisher: "acme", submittedBy: "acme", submittedAt: "2026-08-01T00:00:00Z" },
    fundingDetails: { fundingType: "grant" },
    milestones: [{ title: "Ship it" }],
    socialLinks: [{ platform: "farcaster", url: "https://example.com/acme" }],
  } as unknown as Opportunity;

  it("fills the form from the stored record", () => {
    const { form } = fromDocument(stored);
    expect(form.id).toBe("acme:1");
    expect(form.ecosystems).toBe("ethereum, optimism");
    expect(form.operatingOrganizations[0]?.slug).toBe("acme");
    expect(form.milestones[0]?.title).toBe("Ship it");
    expect(form.socialLinks[0]?.url).toBe("https://example.com/acme");
  });

  it("never re-derives an id that already exists", () => {
    expect(fromDocument(stored).form.idDirty).toBe(true);
  });

  it("carries every unmodelled field through, so a replace does not delete them", () => {
    const { carried } = fromDocument(stored);
    expect(carried.milestones).toEqual([{ title: "Ship it" }]);
    expect(carried.source).toEqual(stored.source);
  });

  it("round-trips: rebuilding from the form plus the carried fields loses nothing", () => {
    const { form, carried } = fromDocument(stored);
    const rebuilt = toDocument(form, carried).document;

    expect(rebuilt.milestones).toEqual([{ title: "Ship it" }]);
    expect(rebuilt.title).toBe("Round One");
    expect(rebuilt.ecosystems).toEqual(["ethereum", "optimism"]);
    // The form's own `source` wins, and it is empty: the server sets attribution on every write.
    expect(rebuilt.source).toEqual({});
  });
});

/**
 * The round trip against an entry that uses EVERY optional member — including the ones INSIDE the
 * containers the form only half models, and every branch of the funding-details union it does.
 *
 * A `PUT` replaces the stored record, so the question this answers is not "did the top level
 * survive" but "did anything at all change that the publisher did not change". The assertion is
 * therefore on the serialized bytes: an edit that touches one field must produce a payload
 * identical to the stored record except that field (and `source`, which the server owns).
 */
describe("the maximal round trip", () => {
  const maximal = {
    specVersion: "1.0.0",
    id: "acme:maximal",
    fundingType: "grant",
    title: "Round One",
    summary: "A short summary.",
    description: "A description.",
    status: "open",
    ecosystems: ["ethereum", "optimism"],
    categories: ["infrastructure", "tooling"],
    eligibility: "Teams shipping on a public network.",
    prerequisites: "A public repository and a milestone plan.",
    additionalReferences: "Guidelines: https://example.org/guidelines",
    serviceAgreement: "Runs as a rolling twelve-month engagement.",
    applicationUrl: "https://example.org/apply",
    website: "https://example.org",
    logoUrl: "https://example.org/logo.png",
    bannerUrl: "https://example.org/banner.png",
    socialLinks: [{ platform: "farcaster", url: "https://example.com/acme" }],
    operatingOrganizations: [
      {
        name: "Acme Foundation",
        slug: "acme",
        website: "https://acme.example",
        logoUrl: "https://acme.example/logo.png",
        // Members of an organization the form does not render at all.
        contacts: [{ name: "A Steward", email: "grants@acme.example" }],
        ecosystems: ["ethereum"],
      },
      // A SECOND operating organization. Rebuilding the array from one pair of inputs deleted it.
      { name: "Beta Collective", slug: "beta", website: "https://beta.example" },
    ],
    sponsoringOrganizations: [{ name: "Gamma DAO", slug: "gamma" }],
    fundingInfo: {
      currency: "USD",
      budget: 500000,
      allocated: 125000,
      minAward: 10000,
      maxAward: 50000,
    },
    fundingDetails: {
      fundingType: "grant",
      fundingMechanisms: ["proactive", "matching"],
      programModel: "program",
      milestoneBased: true,
      recurring: false,
    },
    milestones: [
      { title: "Ship it", amount: 50000, criteria: "A working prototype." },
      { title: "Report", amount: 10000, criteria: "A public write-up." },
    ],
    opensAt: "2026-09-01T00:00:00.000Z",
    deadlines: [{ deadlineType: "fixed", date: "2026-12-01T00:00:00.000Z", label: "application" }],
    postedAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    source: { publisher: "acme", submittedBy: "acme", submittedAt: "2026-08-01T00:00:00.000Z" },
  } as unknown as Opportunity;

  /** What the server would receive, as the client would serialize it. */
  const payload = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ ...(maximal as unknown as Record<string, unknown>), ...over });

  it("is a conformant document to begin with", () => {
    const result = validateDocument(maximal);
    expect(result.available).toBe(true);
    if (result.available) expect(result.errors).toEqual([]);
  });

  it("produces a byte-identical payload when nothing is edited", () => {
    const { form, carried } = fromDocument(maximal);
    const rebuilt = toDocument(form, carried);

    expect(rebuilt.problems).toEqual([]);
    // `source` is the ONE deliberate difference: the server owns attribution and the client sends
    // an empty object rather than echoing what it was told.
    expect(JSON.stringify(rebuilt.document)).toBe(payload({ source: {} }));
  });

  it("changes exactly the edited field and nothing else", () => {
    const { form, carried } = fromDocument(maximal);
    const rebuilt = toDocument({ ...form, title: "Round Two" }, carried);

    expect(JSON.stringify(rebuilt.document)).toBe(payload({ title: "Round Two", source: {} }));
  });

  it("keeps every member of a container it only partly renders", () => {
    const { form, carried } = fromDocument(maximal);
    const rebuilt = toDocument(
      {
        ...form,
        budget: "600000",
        operatingOrganizations: form.operatingOrganizations.map((org, index) =>
          index === 0 ? { ...org, name: "Acme" } : org,
        ),
      },
      carried,
    );
    const document = rebuilt.document as Record<string, unknown>;

    // The first organization's OTHER members survive an edit to its name…
    expect(document.operatingOrganizations).toEqual([
      {
        name: "Acme",
        slug: "acme",
        website: "https://acme.example",
        logoUrl: "https://acme.example/logo.png",
        contacts: [{ name: "A Steward", email: "grants@acme.example" }],
        ecosystems: ["ethereum"],
      },
      { name: "Beta Collective", slug: "beta", website: "https://beta.example" },
    ]);
    // …and `allocated` survives an edit to the budget.
    expect(document.fundingInfo).toEqual({
      currency: "USD",
      budget: 600000,
      allocated: 125000,
      minAward: 10000,
      maxAward: 50000,
    });
  });

  it("carries an organization's unmodelled members with the ROW when the order changes", () => {
    const { form, carried } = fromDocument(maximal);
    const rebuilt = toDocument(
      { ...form, operatingOrganizations: moveRow(form.operatingOrganizations, 0, 1) },
      carried,
    );
    const orgs = (rebuilt.document as Record<string, unknown>).operatingOrganizations as Record<
      string,
      unknown
    >[];

    // Beta is primary now, and Acme's contacts followed Acme rather than staying at index 0.
    expect(orgs.map((org) => org.slug)).toEqual(["beta", "acme"]);
    expect(orgs[0]?.contacts).toBeUndefined();
    expect(orgs[1]?.contacts).toEqual([{ name: "A Steward", email: "grants@acme.example" }]);
  });

  it("removes a field the publisher actually cleared", () => {
    const { form, carried } = fromDocument(maximal);
    const rebuilt = toDocument({ ...form, summary: "", maxAward: "" }, carried);
    const document = rebuilt.document as Record<string, unknown>;

    expect("summary" in document).toBe(false);
    expect(document.fundingInfo).toEqual({
      currency: "USD",
      budget: 500000,
      allocated: 125000,
      minAward: 10000,
    });
  });

  it("removes a whole repeating group the publisher emptied", () => {
    const { form, carried } = fromDocument(maximal);
    const document = toDocument({ ...form, milestones: [], socialLinks: [] }, carried).document;
    expect("milestones" in document).toBe(false);
    expect("socialLinks" in document).toBe(false);
  });
});

/** The other four branches, each round-tripped through the form and back. */
describe("every funding-details branch survives a round trip", () => {
  const base = {
    specVersion: "1.0.0",
    id: "acme:x",
    title: "A programme",
    description: "A description.",
    status: "open",
    operatingOrganizations: [{ name: "Acme Foundation", slug: "acme" }],
    fundingInfo: { currency: "USD" },
    source: {},
  };

  const cases: Record<string, Record<string, unknown>> = {
    hackathon: {
      fundingType: "hackathon",
      location: "Berlin",
      online: true,
      tracks: ["DeFi", "Infra"],
      prizes: [{ track: "DeFi", amount: 10000 }, { amount: 5000 }],
      teamSize: { min: 1, max: 5 },
    },
    bounty: {
      fundingType: "bounty",
      bountyKind: "security",
      rewardTiers: [
        {
          severity: "critical",
          assetType: "smart_contract",
          payout: { model: "percentage", percent: 10, basis: "value_at_risk", cap: 1000000 },
        },
        { label: "1st place", payout: { model: "discretionary" } },
      ],
      severityScheme: "A published scheme v2.3",
      rewardPoolStatus: "funded",
      platform: "A platform",
    },
    accelerator: {
      fundingType: "accelerator",
      programDurationWeeks: 12,
      batchSize: 20,
      equity: "up to 7% SAFE",
      funding: 100000,
      stage: "seed",
      location: "Lisbon",
      online: false,
    },
    vc_fund: {
      fundingType: "vc_fund",
      checkSize: { min: 100000, max: 2000000 },
      stages: ["pre-seed", "seed"],
      thesis: "Infrastructure first.",
      portfolio: ["One", "Two"],
      contactMethod: "intro-only",
      activelyInvesting: true,
    },
    rfp: {
      fundingType: "rfp",
      scope: "In scope: the thing. Out of scope: the other thing.",
      requirements: ["Reproducible from public evidence.", "Published under an open licence."],
    },
  };

  for (const [name, fundingDetails] of Object.entries(cases)) {
    it(`${name} comes back byte-identical`, () => {
      const stored = {
        ...base,
        fundingType: name,
        fundingDetails,
      } as unknown as Opportunity;

      const conformant = validateDocument(stored);
      expect(conformant.available).toBe(true);
      if (conformant.available) expect(conformant.errors).toEqual([]);

      const { form, carried } = fromDocument(stored);
      const rebuilt = toDocument(form, carried);
      expect(rebuilt.problems).toEqual([]);
      expect(JSON.stringify(rebuilt.document)).toBe(
        JSON.stringify({ ...(stored as unknown as Record<string, unknown>), source: {} }),
      );
    });
  }
});

describe("fieldAdvisories", () => {
  it("says the consequence of an absent application link on the types you apply to", () => {
    for (const fundingType of ["grant", "hackathon", "bounty", "rfp"] as const) {
      const advice = fieldAdvisories(usable({ fundingType, applicationUrl: "" }));
      expect(advice.applicationUrl).toContain("no way to apply");
    }
  });

  it("says nothing where the standard makes an absent link normal", () => {
    for (const fundingType of ["accelerator", "vc_fund"] as const) {
      expect(fieldAdvisories(usable({ fundingType, applicationUrl: "" }))).toEqual({});
    }
  });

  it("says nothing once there is a link", () => {
    const form = usable({ applicationUrl: "https://example.org/apply" });
    expect(fieldAdvisories(form)).toEqual({});
  });

  it("NEVER blocks: the advice is not a problem and the field stays optional", () => {
    const built = toDocument(usable({ applicationUrl: "" }));
    expect(built.problems).toEqual([]);
    expect(built.fieldProblems.applicationUrl).toBeUndefined();
    expect(built.advisories).toHaveLength(1);
    const result = validateDocument(built.document);
    if (result.available) expect(result.errors).toEqual([]);
  });
});

describe("fieldProblems", () => {
  it("addresses each problem to the input that holds it", () => {
    const form = usable({
      title: "",
      summary: "x".repeat(501),
      applicationUrl: "not a url",
      operatingOrganizations: [{ ...emptyOrganization(), name: "Acme", slug: "Not A Slug" }],
    });
    const problems = fieldProblems(form);

    expect(problems.title).toContain("required");
    expect(problems.summary).toContain("500");
    expect(problems.applicationUrl).toContain("full URL");
    expect(problems["operatingOrganizations.0.slug"]).toContain("lowercase");
  });

  it("says nothing about a form that has nothing wrong with it", () => {
    expect(fieldProblems(usable())).toEqual({});
  });

  it("requires an amount on a prize, which the schema makes the one required member", () => {
    const form = usable({ fundingType: "hackathon" });
    form.details.hackathon.prizes = [emptyPrize()];
    expect(fieldProblems(form)["details.hackathon.prizes.0.amount"]).toContain("needs an amount");
  });
});
