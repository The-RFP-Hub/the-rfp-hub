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

/**
 * Form → Standard document.
 *
 * EMPTY MEANS ABSENT, not empty string: sending `"summary": ""` would store an empty summary rather
 * than no summary, and the two are different claims about the programme.
 *
 * Nothing here sets a `source.*` attribution field. The server owns every one of them — publisher,
 * submittedBy, submittedAt, ingestedVia, originalId — and a client that sent them would either be
 * ignored or, worse, be believed.
 */
export function toDocument(form: OpportunityFormState): BuildResult {
  const problems: string[] = [];
  const document: Record<string, unknown> = {
    specVersion: "1.0.0",
    id: form.id.trim(),
    fundingType: form.fundingType,
    title: form.title.trim(),
    description: form.description,
    status: form.status,
    // The server fills this in; it is sent as an empty object because the Standard requires the
    // member to be present.
    source: {},
    operatingOrganizations: [{ name: form.orgName.trim(), slug: form.orgSlug.trim() }],
  };

  const optionalText: [keyof OpportunityFormState, string][] = [
    ["summary", "summary"],
    ["eligibility", "eligibility"],
    ["applicationUrl", "applicationUrl"],
    ["website", "website"],
  ];
  for (const [field, key] of optionalText) {
    const value = String(form[field]).trim();
    if (value !== "") document[key] = value;
  }

  const ecosystems = splitList(form.ecosystems);
  if (ecosystems.length > 0) document.ecosystems = ecosystems;
  const categories = splitList(form.categories);
  if (categories.length > 0) document.categories = categories;

  const fundingInfo: Record<string, unknown> = {};
  if (form.currency.trim() !== "") fundingInfo.currency = form.currency.trim();
  for (const [field, key] of [
    ["budget", "budget"],
    ["minAward", "minAward"],
    ["maxAward", "maxAward"],
  ] as const) {
    const parsed = numberOrUndefined(form[field]);
    if (parsed === undefined) continue;
    if (Number.isNaN(parsed)) {
      problems.push(`${key} is not a number.`);
      continue;
    }
    fundingInfo[key] = parsed;
  }
  if (Object.keys(fundingInfo).length > 0) document.fundingInfo = fundingInfo;

  const details = parseJson(form.fundingDetails, "fundingDetails");
  if (details.problem) problems.push(details.problem);
  document.fundingDetails = details.value ?? {};

  if (form.deadlines.trim() !== "") {
    const deadlines = parseJson(form.deadlines, "deadlines");
    if (deadlines.problem) problems.push(deadlines.problem);
    else document.deadlines = deadlines.value;
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
 * Anything this form does not model is preserved by `carriedFields`, not dropped: a `PUT` REPLACES
 * the stored record, so an edit screen that rebuilt the document from its own inputs alone would
 * delete every field it happens not to render. That is the single most damaging bug an edit form
 * of this shape can have.
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

  const modelled = new Set([
    "specVersion",
    "id",
    "fundingType",
    "title",
    "summary",
    "description",
    "status",
    "ecosystems",
    "categories",
    "eligibility",
    "applicationUrl",
    "website",
    "operatingOrganizations",
    "fundingInfo",
    "fundingDetails",
    "deadlines",
    // Server-owned. Sent back untouched so a replace does not look like an attempt to rewrite it.
    "source",
  ]);
  const carried: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!modelled.has(key)) carried[key] = value;
  }
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
