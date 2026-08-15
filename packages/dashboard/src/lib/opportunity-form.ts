/**
 * The submission form's model: flat form fields in, a Standard document out.
 *
 * WHAT THIS FORM COVERS, stated honestly rather than implied. Typed inputs for the common top-level
 * fields, plus a JSON editor for `fundingDetails` and one for `deadlines`. A fully typed form per
 * funding type — six shapes, each with its own nested arrays — is not in this cut. The JSON editor
 * is not a cop-out for those two: `fundingDetails` is the standard's structural discriminator and
 * gets a different shape for each of the six types, and a half-typed version of it would quietly
 * drop fields a publisher had entered.
 *
 * Pure, and separate from the component, so the mapping in both directions is unit-testable — the
 * round trip is where a form silently drops somebody's data.
 */
import type { Opportunity } from "@the-rfp-hub/standard";

export interface OpportunityFormState {
  id: string;
  fundingType: string;
  title: string;
  summary: string;
  description: string;
  status: string;
  ecosystems: string;
  categories: string;
  eligibility: string;
  applicationUrl: string;
  website: string;
  orgName: string;
  orgSlug: string;
  currency: string;
  budget: string;
  minAward: string;
  maxAward: string;
  /** JSON. Required by the Standard — every entry carries its type-specific object. */
  fundingDetails: string;
  /** JSON array, optional. */
  deadlines: string;
}

export const FUNDING_TYPES = [
  "grant",
  "hackathon",
  "bounty",
  "accelerator",
  "vc_fund",
  "rfp",
] as const;

export const STATUSES = ["upcoming", "open", "closed", "archived"] as const;

export function emptyForm(): OpportunityFormState {
  return {
    id: "",
    fundingType: "grant",
    title: "",
    summary: "",
    description: "",
    status: "open",
    ecosystems: "",
    categories: "",
    eligibility: "",
    applicationUrl: "",
    website: "",
    orgName: "",
    orgSlug: "",
    currency: "",
    budget: "",
    minAward: "",
    maxAward: "",
    fundingDetails: '{\n  "fundingType": "grant"\n}',
    deadlines: "",
  };
}

/** `a, b ,c` → `["a","b","c"]`. Empty in, empty out — never `[""]`. */
export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function numberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export interface BuildResult {
  /** The document to submit. Present even when `problems` is non-empty, minus the unparseable bits. */
  document: Record<string, unknown>;
  /** Problems this module can see on its own — malformed JSON, a non-numeric amount. */
  problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Write a member, or REMOVE it.
 *
 * `undefined` means the publisher cleared the field, which is not the same as leaving it alone —
 * and it has to be an actual removal rather than an `undefined` assignment: `Object.keys()` counts
 * a key whose value is `undefined`, which is what decides whether `fundingInfo` is sent at all.
 */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

/**
 * Form → Standard document, laid over the record it was loaded from.
 *
 * EMPTY MEANS ABSENT, not empty string: sending `"summary": ""` would store an empty summary rather
 * than no summary, and the two are different claims about the programme.
 *
 * Nothing here sets a `source.*` attribution field. The server owns every one of them — publisher,
 * submittedBy, submittedAt, ingestedVia, originalId — and a client that sent them would either be
 * ignored or, worse, be believed.
 *
 * `base` IS WHAT MAKES A REPLACE SAFE, and it goes deeper than the top level. `PUT` replaces the
 * stored record, so anything this form does not rebuild has to arrive unchanged — and the form
 * only PARTIALLY models two containers. It renders the first operating organisation's name and
 * slug, and four members of `fundingInfo`. Rebuilding those containers from the inputs alone
 * deleted every additional organisation, every organisation contact and website, and
 * `fundingInfo.allocated`, from an entry whose publisher only came to fix a typo in the title.
 *
 * So the document STARTS as the stored one and each edited field is written back over it, per
 * container and per array entry. Untouched members keep their values and their positions, which is
 * also what makes "the payload is byte-identical except the fields I changed" a testable claim
 * rather than an aspiration.
 */
export function toDocument(
  form: OpportunityFormState,
  base: Record<string, unknown> = {},
): BuildResult {
  const problems: string[] = [];
  const document: Record<string, unknown> = { ...base };

  const set = (key: string, value: unknown): void => put(document, key, value);

  set("specVersion", "1.0.0");
  set("id", form.id.trim());
  set("fundingType", form.fundingType);
  set("title", form.title.trim());
  set("description", form.description);
  set("status", form.status);
  // The server fills this in; it is sent as an empty object because the Standard requires the
  // member to be present.
  set("source", {});

  // Only the FIRST organisation is rendered, and only its name and slug. Every other member of it,
  // and every organisation after it, is carried through this spread untouched.
  const baseOrgs = Array.isArray(base.operatingOrganizations) ? base.operatingOrganizations : [];
  const first: Record<string, unknown> = isRecord(baseOrgs[0]) ? { ...baseOrgs[0] } : {};
  first.name = form.orgName.trim();
  first.slug = form.orgSlug.trim();
  set("operatingOrganizations", [first, ...baseOrgs.slice(1)]);

  const optionalText: [keyof OpportunityFormState, string][] = [
    ["summary", "summary"],
    ["eligibility", "eligibility"],
    ["applicationUrl", "applicationUrl"],
    ["website", "website"],
  ];
  for (const [field, key] of optionalText) {
    const value = String(form[field]).trim();
    set(key, value === "" ? undefined : value);
  }

  const ecosystems = splitList(form.ecosystems);
  set("ecosystems", ecosystems.length > 0 ? ecosystems : undefined);
  const categories = splitList(form.categories);
  set("categories", categories.length > 0 ? categories : undefined);

  // Same rule one level down: `allocated`, and anything else a publisher set through the API,
  // survives an edit that only touched the budget.
  const fundingInfo: Record<string, unknown> = isRecord(base.fundingInfo)
    ? { ...base.fundingInfo }
    : {};
  const currency = form.currency.trim();
  put(fundingInfo, "currency", currency === "" ? undefined : currency);
  for (const [field, key] of [
    ["budget", "budget"],
    ["minAward", "minAward"],
    ["maxAward", "maxAward"],
  ] as const) {
    const parsed = numberOrUndefined(form[field]);
    if (Number.isNaN(parsed)) {
      // Left as it was: the submission is blocked on this problem anyway, and clearing a stored
      // amount because somebody mistyped over it is the destructive reading of a typo.
      problems.push(`${key} is not a number.`);
      continue;
    }
    put(fundingInfo, key, parsed);
  }
  set("fundingInfo", Object.keys(fundingInfo).length > 0 ? fundingInfo : undefined);

  const details = parseJson(form.fundingDetails, "fundingDetails");
  if (details.problem) {
    problems.push(details.problem);
    // The Standard requires the member, so a create still has to carry one; an edit keeps what was
    // stored rather than blanking it over a half-typed brace.
    if (document.fundingDetails === undefined) set("fundingDetails", {});
  } else {
    set("fundingDetails", details.value ?? {});
  }

  if (form.deadlines.trim() === "") {
    set("deadlines", undefined);
  } else {
    const deadlines = parseJson(form.deadlines, "deadlines");
    if (deadlines.problem) problems.push(deadlines.problem);
    else set("deadlines", deadlines.value);
  }

  return { document, problems };
}

function parseJson(text: string, field: string): { value?: unknown; problem?: string } {
  if (text.trim() === "") return { value: undefined };
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { problem: `${field} is not valid JSON: ${(error as Error).message}` };
  }
}

/**
 * Document → form, for the edit screen.
 *
 * `carried` is THE WHOLE STORED RECORD, not the leftovers. A `PUT` replaces it, so the safe base
 * for the next one is the last one — `toDocument(form, carried)` then writes the edited fields back
 * over it and removes the ones the publisher cleared. An earlier version passed only the fields
 * this form does not name and rebuilt the rest; that carried the top level and silently dropped
 * everything INSIDE the two containers it half-models — additional operating organisations, their
 * contacts and websites, `fundingInfo.allocated`.
 *
 * Carrying the whole record also keeps key order, which is what lets the round-trip test assert
 * that an untouched edit produces a byte-identical payload rather than merely an equivalent one.
 */
export function fromDocument(entry: Opportunity): {
  form: OpportunityFormState;
  carried: Record<string, unknown>;
} {
  const record = entry as unknown as Record<string, unknown>;
  const org = Array.isArray(record.operatingOrganizations)
    ? (record.operatingOrganizations[0] as Record<string, unknown> | undefined)
    : undefined;
  const funding = (record.fundingInfo ?? {}) as Record<string, unknown>;

  const carried: Record<string, unknown> = { ...record };
  // Server-owned, and sent back empty rather than echoed: attribution is set on every write, and a
  // client restating it is either ignored or, worse, believed.
  carried.source = record.source ?? {};

  return {
    form: {
      id: String(record.id ?? ""),
      fundingType: String(record.fundingType ?? "grant"),
      title: String(record.title ?? ""),
      summary: record.summary ? String(record.summary) : "",
      description: String(record.description ?? ""),
      status: String(record.status ?? "open"),
      ecosystems: Array.isArray(record.ecosystems) ? record.ecosystems.join(", ") : "",
      categories: Array.isArray(record.categories) ? record.categories.join(", ") : "",
      eligibility: record.eligibility ? String(record.eligibility) : "",
      applicationUrl: record.applicationUrl ? String(record.applicationUrl) : "",
      website: record.website ? String(record.website) : "",
      orgName: org?.name ? String(org.name) : "",
      orgSlug: org?.slug ? String(org.slug) : "",
      currency: funding.currency ? String(funding.currency) : "",
      budget: funding.budget === undefined || funding.budget === null ? "" : String(funding.budget),
      minAward:
        funding.minAward === undefined || funding.minAward === null ? "" : String(funding.minAward),
      maxAward:
        funding.maxAward === undefined || funding.maxAward === null ? "" : String(funding.maxAward),
      fundingDetails: JSON.stringify(record.fundingDetails ?? {}, null, 2),
      deadlines: record.deadlines ? JSON.stringify(record.deadlines, null, 2) : "",
    },
    carried,
  };
}

/**
 * The id rule, checked in the browser so the form can say it before a round trip.
 *
 * The API requires `<namespace>:<local>`; it derives the source system from the prefix, so an id
 * without one is rejected there. Re-stating the rule here is duplication, and worth it: the
 * alternative is a publisher filling in a long form and learning about a colon at the end of it.
 */
export function idProblem(id: string): string | null {
  const trimmed = id.trim();
  if (trimmed === "") return "An id is required.";
  const colon = trimmed.indexOf(":");
  if (colon <= 0 || colon === trimmed.length - 1) {
    return "An id must be <namespace>:<local>, for example acme-foundation:2026-round-1.";
  }
  return null;
}
