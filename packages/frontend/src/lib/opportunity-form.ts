/**
 * The submission form's model: typed form state in, a Standard document out.
 *
 * WHAT THIS FORM COVERS. Every field of the Standard a publisher can meaningfully type, including
 * all six `fundingDetails` shapes and the repeating groups inside them. The raw-JSON escape hatches
 * this module used to carry for `fundingDetails` and `deadlines` are gone: a discriminated union is
 * exactly the thing a form is good at, and asking a publisher to hand-write the standard's
 * structural discriminator was asking them to do the schema's job.
 *
 * Pure, and separate from the component, so the mapping in both directions is unit-testable — the
 * round trip is where a form silently drops somebody's data.
 *
 * THREE RULES GOVERN THIS FILE, and every branch below is an application of one of them.
 *
 * 1. BASE LAYERING. `toDocument` never rebuilds a document; it starts from the stored one and
 *    writes the modelled fields over it. That extends to every repeating group: each row carries
 *    the object it was loaded from (`base`), so a row keeps its unmodelled members even after the
 *    publisher reorders the list. See `toDocument`.
 * 2. EMPTY MEANS ABSENT — except where null is a positive assertion. A cleared input removes the
 *    member rather than storing `""`. `hackathon.location` and `accelerator.location` are the two
 *    exceptions: the Standard reads a null there as "fully online / fully remote", which is a claim
 *    a publisher makes on purpose, so it gets its own checkbox and writes an explicit null.
 * 3. THE SCHEMA'S CONDITIONALS ARE ENFORCED BY CONSTRUCTION. Every `fundingDetails` branch is
 *    closed (`additionalProperties: false`) and several of them false-forbid the members belonging
 *    to a sibling shape, so a stray field is a hard validation failure rather than a harmless
 *    extra. Switching funding type, bounty compensation shape or payout model therefore CLEARS what
 *    the new shape forbids, in `buildDetails` and `buildPayout`.
 */
import type { Opportunity } from "@the-rfp-hub/standard";

type Rec = Record<string, unknown>;

/**
 * Row identity for the repeating groups.
 *
 * React needs a key that survives a reorder, and array index does not: moving a milestone up with
 * index keys remounts both inputs and moves the caret out from under the publisher. A counter is
 * enough — these keys never leave the browser and never reach the document.
 */
let rowCounter = 0;
function nextKey(prefix: string): string {
  rowCounter += 1;
  return `${prefix}-${rowCounter}`;
}

// ── enums, verbatim from the schema ─────────────────────────────────────────────

export const FUNDING_TYPES = [
  "grant",
  "hackathon",
  "bounty",
  "accelerator",
  "vc_fund",
  "rfp",
] as const;
export type FundingType = (typeof FUNDING_TYPES)[number];

export const STATUSES = ["upcoming", "open", "closed", "archived"] as const;

export const ORG_TYPES = [
  "foundation",
  "dao",
  "company",
  "protocol",
  "program",
  "individual",
  "other",
] as const;

export const SOCIAL_PLATFORMS = [
  "twitter",
  "discord",
  "github",
  "telegram",
  "farcaster",
  "forum",
  "blog",
] as const;

export const DEADLINE_TYPES = ["fixed", "rolling"] as const;

/** registries/deadline-labels.json — conventional, not enforced, so the input stays free text. */
export const DEADLINE_LABELS = [
  "application",
  "community feedback",
  "registration",
  "submission",
  "event start",
  "event end",
] as const;

export const FUNDING_MECHANISMS = [
  "retroactive",
  "proactive",
  "streaming",
  "quadratic",
  "matching",
  "other",
] as const;

/** registries/program-models.json — an open list; a publisher's own vocabulary is valid. */
export const PROGRAM_MODELS = ["grant", "program", "infra", "incentives"] as const;

export const BOUNTY_KINDS = ["task", "security"] as const;
export const REWARD_POOL_STATUSES = ["funded", "unfunded", "unknown"] as const;
export const DIFFICULTIES = ["beginner", "intermediate", "advanced"] as const;

/** registries/bounty-severities.json — an open list. */
export const BOUNTY_SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;

/** registries/bounty-asset-types.json — an open list. */
export const BOUNTY_ASSET_TYPES = [
  "smart_contract",
  "blockchain_dlt",
  "websites_and_applications",
] as const;

export const PAYOUT_MODELS = ["fixed", "range", "up_to", "percentage", "discretionary"] as const;
export type PayoutModel = (typeof PAYOUT_MODELS)[number];

export const PAYOUT_BASES = ["value_at_risk", "economic_damage"] as const;

export const ACCELERATOR_STAGES = ["pre-seed", "seed", "series-a"] as const;
export const VC_STAGES = ["pre-seed", "seed", "series-a", "series-b+", "growth"] as const;
export const CONTACT_METHODS = ["email", "form", "intro-only"] as const;

/**
 * A nullable boolean, as three radio-shaped states.
 *
 * `""` is "not stated" and omits the member. The Standard's booleans are all `["boolean", "null"]`
 * and a form that defaulted them to `false` would have every publisher asserting "this program is
 * not recurring" without being asked.
 */
export type Tri = "" | "yes" | "no";

// ── row shapes ──────────────────────────────────────────────────────────────────

export interface OrganizationRow {
  key: string;
  name: string;
  slug: string;
  orgType: string;
  website: string;
  /** The stored organisation this row was loaded from. Its unmodelled members ride along. */
  base: Rec;
}

export interface DeadlineRow {
  key: string;
  deadlineType: "fixed" | "rolling";
  /** Local-shaped `YYYY-MM-DDTHH:mm(:ss)`, read as UTC. Meaningless when rolling. */
  date: string;
  label: string;
  base: Rec;
}

export interface SocialLinkRow {
  key: string;
  platform: string;
  url: string;
  base: Rec;
}

export interface MilestoneRow {
  key: string;
  title: string;
  amount: string;
  criteria: string;
  base: Rec;
}

export interface PrizeRow {
  key: string;
  track: string;
  amount: string;
  base: Rec;
}

export interface PayoutState {
  model: PayoutModel;
  amount: string;
  min: string;
  max: string;
  percent: string;
  basis: string;
  floor: string;
  cap: string;
  base: Rec;
}

export interface RewardTierRow {
  key: string;
  severity: string;
  assetType: string;
  label: string;
  payout: PayoutState;
  base: Rec;
}

// ── the six fundingDetails branches ─────────────────────────────────────────────

export interface GrantDetailsState {
  fundingMechanisms: string[];
  programModel: string;
  milestoneBased: Tri;
  recurring: Tri;
}

export interface HackathonDetailsState {
  /** Writes an explicit `location: null` — the Standard's way of saying "fully online". */
  fullyOnline: boolean;
  location: string;
  online: Tri;
  tracks: string;
  prizes: PrizeRow[];
  teamMin: string;
  teamMax: string;
  teamBase: Rec;
}

export interface BountyDetailsState {
  bountyKind: "task" | "security";
  /** Which compensation shape a TASK bounty uses. A security bounty is always `tiers`. */
  rewardMode: "single" | "tiers";
  reward: string;
  rewardTiers: RewardTierRow[];
  severityScheme: string;
  rewardPoolStatus: string;
  difficulty: string;
  skills: string;
  platform: string;
}

export interface AcceleratorDetailsState {
  programDurationWeeks: string;
  batchSize: string;
  equity: string;
  funding: string;
  stage: string;
  /** Writes an explicit `location: null` — "fully remote". */
  fullyRemote: boolean;
  location: string;
  online: Tri;
}

export interface VcFundDetailsState {
  checkMin: string;
  checkMax: string;
  checkBase: Rec;
  stages: string[];
  thesis: string;
  portfolio: string;
  contactMethod: string;
  activelyInvesting: Tri;
}

export interface RfpDetailsState {
  scope: string;
  /** One requirement per line. */
  requirements: string;
}

export interface DetailsState {
  grant: GrantDetailsState;
  hackathon: HackathonDetailsState;
  bounty: BountyDetailsState;
  accelerator: AcceleratorDetailsState;
  vc_fund: VcFundDetailsState;
  rfp: RfpDetailsState;
}

export interface OpportunityFormState {
  id: string;
  /**
   * Whether the publisher has typed over the derived id. Purely a UI fact — it is never written to
   * the document — but it has to live in the form state, because it is the difference between
   * "keep the id in step with the title" and "stop overwriting what I typed".
   */
  idDirty: boolean;
  fundingType: FundingType;
  title: string;
  summary: string;
  description: string;
  status: string;
  ecosystems: string;
  categories: string;
  eligibility: string;
  prerequisites: string;
  additionalReferences: string;
  serviceAgreement: string;
  applicationUrl: string;
  website: string;
  logoUrl: string;
  bannerUrl: string;
  socialLinks: SocialLinkRow[];
  operatingOrganizations: OrganizationRow[];
  sponsoringOrganizations: OrganizationRow[];
  currency: string;
  budget: string;
  allocated: string;
  minAward: string;
  maxAward: string;
  milestones: MilestoneRow[];
  opensAt: string;
  postedAt: string;
  deadlines: DeadlineRow[];
  details: DetailsState;
}

// ── constructors ────────────────────────────────────────────────────────────────

export function emptyOrganization(): OrganizationRow {
  return { key: nextKey("org"), name: "", slug: "", orgType: "", website: "", base: {} };
}

export function emptyDeadline(): DeadlineRow {
  return {
    key: nextKey("deadline"),
    deadlineType: "fixed",
    date: "",
    label: "application",
    base: {},
  };
}

export function emptySocialLink(): SocialLinkRow {
  return { key: nextKey("social"), platform: "twitter", url: "", base: {} };
}

export function emptyMilestone(): MilestoneRow {
  return { key: nextKey("milestone"), title: "", amount: "", criteria: "", base: {} };
}

export function emptyPrize(): PrizeRow {
  return { key: nextKey("prize"), track: "", amount: "", base: {} };
}

export function emptyPayout(): PayoutState {
  return {
    model: "fixed",
    amount: "",
    min: "",
    max: "",
    percent: "",
    basis: "value_at_risk",
    floor: "",
    cap: "",
    base: {},
  };
}

export function emptyRewardTier(): RewardTierRow {
  return {
    key: nextKey("tier"),
    severity: "",
    assetType: "",
    label: "",
    payout: emptyPayout(),
    base: {},
  };
}

export function emptyDetails(): DetailsState {
  return {
    grant: { fundingMechanisms: [], programModel: "", milestoneBased: "", recurring: "" },
    hackathon: {
      fullyOnline: false,
      location: "",
      online: "",
      tracks: "",
      prizes: [],
      teamMin: "",
      teamMax: "",
      teamBase: {},
    },
    bounty: {
      bountyKind: "task",
      rewardMode: "single",
      reward: "",
      rewardTiers: [],
      severityScheme: "",
      rewardPoolStatus: "",
      difficulty: "",
      skills: "",
      platform: "",
    },
    accelerator: {
      programDurationWeeks: "",
      batchSize: "",
      equity: "",
      funding: "",
      stage: "",
      fullyRemote: false,
      location: "",
      online: "",
    },
    vc_fund: {
      checkMin: "",
      checkMax: "",
      checkBase: {},
      stages: [],
      thesis: "",
      portfolio: "",
      contactMethod: "",
      activelyInvesting: "",
    },
    rfp: { scope: "", requirements: "" },
  };
}

export function emptyForm(): OpportunityFormState {
  return {
    id: "",
    idDirty: false,
    fundingType: "grant",
    title: "",
    summary: "",
    description: "",
    status: "open",
    ecosystems: "",
    categories: "",
    eligibility: "",
    prerequisites: "",
    additionalReferences: "",
    serviceAgreement: "",
    applicationUrl: "",
    website: "",
    logoUrl: "",
    bannerUrl: "",
    socialLinks: [],
    operatingOrganizations: [emptyOrganization()],
    sponsoringOrganizations: [],
    currency: "",
    budget: "",
    allocated: "",
    minAward: "",
    maxAward: "",
    milestones: [],
    opensAt: "",
    postedAt: "",
    deadlines: [],
    details: emptyDetails(),
  };
}

// ── small pure helpers ──────────────────────────────────────────────────────────

/**
 * `a, b ,c` → `["a","b","c"]`. Empty in, empty out — never `[""]`.
 *
 * DEDUPED, because every array this feeds is `uniqueItems: true` in the schema. A publisher who
 * pastes a list with a repeat in it has made a typo, not a claim, and the alternative is a
 * conformance failure phrased as a JSON pointer.
 */
export function splitList(value: string): string[] {
  const seen = new Set<string>();
  for (const item of value.split(",")) {
    const trimmed = item.trim();
    if (trimmed !== "") seen.add(trimmed);
  }
  return [...seen];
}

/** The same, one item per LINE — for the fields whose items routinely contain commas. */
export function splitLines(value: string): string[] {
  const seen = new Set<string>();
  for (const item of value.split("\n")) {
    const trimmed = item.trim();
    if (trimmed !== "") seen.add(trimmed);
  }
  return [...seen];
}

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Write a member, or REMOVE it.
 *
 * `undefined` means the publisher cleared the field, which is not the same as leaving it alone —
 * and it has to be an actual removal rather than an `undefined` assignment: `Object.keys()` counts
 * a key whose value is `undefined`, which is what decides whether `fundingInfo` is sent at all.
 */
function put(target: Rec, key: string, value: unknown): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

/** Trimmed, or absent. Never the empty string — see rule 2 in the file header. */
function text(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function tri(value: Tri): boolean | undefined {
  if (value === "yes") return true;
  if (value === "no") return false;
  return undefined;
}

function fromTri(value: unknown): Tri {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "";
}

/** `NaN` is the caller's cue that the publisher typed something that is not a number. */
function numberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** A number, or absent. `NaN` is dropped from the document — `fieldProblems` reports it instead. */
function cleanNumber(value: string): number | undefined {
  const parsed = numberOrUndefined(value);
  return parsed === undefined || Number.isNaN(parsed) ? undefined : parsed;
}

function showNumber(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function showText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

// ── date-times ──────────────────────────────────────────────────────────────────

/**
 * The widget format and the wire format, and why they differ.
 *
 * `<input type="datetime-local">` hands back a naive `YYYY-MM-DDTHH:mm[:ss]` with no zone. Every
 * timestamp in the Standard is UTC with a literal trailing `Z` (the schema pins `pattern: "Z$"`),
 * so the value is read AS UTC rather than converted from the browser's zone: converting would make
 * the same document round-trip differently in two cities, and a deadline that moves when you open
 * the form in a different country is worse than one you have to enter in UTC on purpose. Every
 * date input on the form is labelled UTC for that reason.
 *
 * NORMALISATION IS DELIBERATE and slightly lossy: a stored `…:59.500Z` comes back as `…:59.000Z`,
 * because the widget has no field for a fraction of a second. Nothing in the Standard gives
 * sub-second precision a meaning, and the alternative — keeping an invisible fraction alive across
 * an edit — hides state from the person editing it.
 */
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function toIsoUtc(local: string): string | undefined {
  const trimmed = local.trim();
  if (trimmed === "") return undefined;
  const match = LOCAL_DATE_TIME.exec(trimmed);
  if (!match) return undefined;
  const [, date, hours, minutes, seconds] = match;
  return `${date}T${hours}:${minutes}:${seconds ?? "00"}.000Z`;
}

export function fromIsoUtc(iso: unknown): string {
  if (typeof iso !== "string") return "";
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso.trim());
  if (!match) return "";
  const [, date, hours, minutes, seconds] = match;
  return `${date}T${hours}:${minutes}:${seconds}`;
}

function isDateTimeShaped(local: string): boolean {
  return local.trim() === "" || LOCAL_DATE_TIME.test(local.trim());
}

// ── the id, derived ─────────────────────────────────────────────────────────────

/**
 * The combining marks NFKD leaves behind, which would otherwise each become a hyphen of their own.
 * `\p{M}` rather than a literal range: a range whose endpoints are combining characters is itself
 * a source of the confusion it is trying to remove.
 */
const COMBINING = /\p{M}/gu;

/** Title → the local half of an id: lowercase, alphanumerics and single hyphens. */
export function slugifyTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(COMBINING, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

/**
 * The id the form proposes: the primary operating organisation's slug, then the slugified title.
 *
 * A proposal rather than a rule — the field stays editable, because the local half is the
 * publisher's own key and they may already have one. Empty when either half is missing, so the
 * form never proposes a half-formed id like `acme:`.
 */
export function deriveId(orgSlug: string, title: string): string {
  const namespace = orgSlug.trim();
  const local = slugifyTitle(title);
  if (namespace === "" || local === "") return "";
  return `${namespace}:${local}`.slice(0, 128);
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

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
  if (!ID_PATTERN.test(trimmed)) {
    return "An id may use letters, digits and . _ : - only, up to 128 characters.";
  }
  const colon = trimmed.indexOf(":");
  if (colon <= 0 || colon === trimmed.length - 1) {
    return "Start the id with the organisation slug and a colon, for example acme-foundation:2026-round-1.";
  }
  return null;
}

/** The namespace half of an id — the same first-colon split the API derives it with. */
export function namespaceOf(id: string): string | null {
  const trimmed = id.trim();
  const colon = trimmed.indexOf(":");
  if (colon <= 0 || colon === trimmed.length - 1) return null;
  return trimmed.slice(0, colon);
}

// ── what happens when this is submitted ─────────────────────────────────────────

/** What the API says this account may publish. Absent when the form has not been told. */
export interface PublishAuthority {
  /** Slugs of the verified organisations this account belongs to. */
  verifiedNamespaces: string[];
  /** An account-level grant that publishes immediately whatever the namespace. */
  directCreate: boolean;
}

export interface PublishConsequence {
  id: string;
  /** `true` = straight into the public directory. `false` = stored pending. `null` = not knowable. */
  immediate: boolean | null;
  /** The reason, in the publisher's terms, for the sentence next to the id field. */
  because: string;
}

/**
 * "Publishes as X — immediately / pending review, because …".
 *
 * The single most misread thing on this form: "Submit" means two different things depending on the
 * namespace before the colon, and a publisher who thinks their programme is live when it is sitting
 * in a queue has been misled by the button, not by the API.
 */
export function describePublish(
  id: string,
  authority: PublishAuthority | undefined,
  /**
   * The namespace a REPLACE is authorised against: the record's STORED `source.publisher`.
   *
   * Absent on a create, where the namespace is the id's own prefix. On a replace the id is
   * immutable and says nothing about authority — a claimed listing keeps the id it was imported
   * with (`host:123`) while being published under the organisation that claimed it — so predicting
   * the outcome from the prefix predicts the wrong one.
   */
  storedNamespace?: string | null,
): PublishConsequence | null {
  const stored = storedNamespace?.trim() ?? "";
  const namespace = stored !== "" ? stored : namespaceOf(id);
  if (namespace === null || namespace === "") return null;
  const shown = id.trim();
  // Where authority came from the stored publisher, "the part before the colon" is not what decided
  // it, and saying so would send a publisher off to edit an immutable field.
  const how =
    stored !== "" && stored !== namespaceOf(id)
      ? `This listing is published under the organisation prefix ${namespace}, which decides replacement access — not the id.`
      : "The part before the colon decides this.";

  if (!authority) {
    return {
      id: shown,
      immediate: null,
      because:
        stored !== ""
          ? `${namespace} is the organisation prefix this listing is published under, and membership of that organisation decides whether a replacement publishes immediately or waits for a Hub reviewer.`
          : "the part before the colon decides whether it publishes immediately or waits for a Hub reviewer.",
    };
  }
  if (authority.directCreate) {
    return {
      id: shown,
      immediate: true,
      because: "this account publishes directly, whichever organisation prefix it uses.",
    };
  }
  if (authority.verifiedNamespaces.includes(namespace)) {
    return {
      id: shown,
      immediate: true,
      because: `you are a verified member of ${namespace}. ${how}`,
    };
  }
  if (authority.verifiedNamespaces.length > 0) {
    return {
      id: shown,
      immediate: false,
      because: `${namespace} is not one of your verified organisations (${authority.verifiedNamespaces.join(", ")}). ${how}`,
    };
  }
  return {
    id: shown,
    immediate: false,
    because:
      "this account is not a member of a verified organisation, which is the normal path for a community submission.",
  };
}

// ── which namespace a write is authorised against ───────────────────────────────

/**
 * The ingest routes whose rows predate the create-time operating-org gate, mirroring the API's own
 * set. A row that entered through one of these AND never conformed is grandfathered on replace.
 */
const LEGACY_INGEST_ORIGINS: ReadonlySet<string> = new Set(["import", "scrape", "outbox"]);

/**
 * Which namespace this write is authorised against, and what that implies for the form.
 *
 * A CREATE and a REPLACE do not ask the same question, and conflating them is how the form came to
 * block a legitimate edit. On a create the API derives the namespace from the document — this
 * client never sends `source.publisher`, so it is `operatingOrganizations[0].slug` — and requires
 * the id to start with it. On a REPLACE the id is immutable and is not checked at all; the API
 * authorises against the row's STORED publisher and asks one different question instead: that the
 * stored publisher still appears somewhere in `operatingOrganizations`.
 *
 * That distinction is not academic. A claimed or imported listing legitimately carries an id from
 * the system it came from (`host:123`) while being published under the organisation that operates
 * it (`acme`). Holding the id to the primary operator on edit refused a PUT the API would have
 * accepted, and — worse — told the publisher to fix a field they cannot change.
 */
export interface NamespaceAuthority {
  mode: "create" | "edit";
  /** The namespace this write is authorised against, or null when the record does not name one. */
  namespace: string | null;
  /** Edit only: whether the stored publisher must survive in `operatingOrganizations`. */
  requiresOperating: boolean;
}

export function namespaceAuthority(
  mode: "create" | "edit",
  form: OpportunityFormState,
  base: Rec = {},
): NamespaceAuthority {
  if (mode === "create") {
    return {
      mode,
      namespace: form.operatingOrganizations[0]?.slug.trim() || null,
      requiresOperating: false,
    };
  }

  const source = isRecord(base.source) ? base.source : {};
  const publisher = typeof source.publisher === "string" ? source.publisher.trim() : "";
  if (publisher === "") return { mode, namespace: null, requiresOperating: false };

  const storedSlugs = (
    Array.isArray(base.operatingOrganizations) ? base.operatingOrganizations : []
  )
    .filter(isRecord)
    .map((org) => (typeof org.slug === "string" ? org.slug.trim() : ""));
  // The API's exemption is PROVENANCE-SCOPED, not merely "non-conforming": a row is grandfathered
  // only when it both came in through a legacy ingest route and never conformed. A row created
  // through the authenticated write path went through the create-time gate and must stay conforming.
  const neverConformed = !storedSlugs.includes(publisher);
  const legacyIngest = LEGACY_INGEST_ORIGINS.has(
    typeof source.ingestedVia === "string" ? source.ingestedVia : "",
  );
  return { mode, namespace: publisher, requiresOperating: !(legacyIngest && neverConformed) };
}

// ── form → document ─────────────────────────────────────────────────────────────

export interface BuildResult {
  /** The document to submit. Present even when `problems` is non-empty, minus the unusable bits. */
  document: Rec;
  /** Problems this module can see on its own, keyed by field path. BLOCKING. */
  fieldProblems: Record<string, string>;
  /** The same problems, in field order, for the summary panel. */
  problems: string[];
  /** Advice, keyed by field path. NEVER blocking — see `fieldAdvisories`. */
  fieldAdvisories: Record<string, string>;
  /** The same advice, for the advisory list beside the validator's own warnings. */
  advisories: string[];
}

/** Layer a row's modelled members over the object it was loaded from. Empty object → absent. */
function layer(base: Rec, write: (target: Rec) => void): Rec | undefined {
  const target: Rec = { ...base };
  write(target);
  return Object.keys(target).length > 0 ? target : undefined;
}

function buildOrganization(row: OrganizationRow): Rec {
  const target: Rec = { ...row.base };
  target.name = row.name.trim();
  target.slug = row.slug.trim();
  put(target, "orgType", text(row.orgType));
  put(target, "website", text(row.website));
  return target;
}

function buildDeadline(row: DeadlineRow): Rec {
  const target: Rec = { ...row.base };
  target.deadlineType = row.deadlineType;
  // A rolling deadline has no date. The Standard permits a null there, but absence is the
  // convention its own examples use and the one this form writes.
  put(target, "date", row.deadlineType === "fixed" ? toIsoUtc(row.date) : undefined);
  put(target, "label", text(row.label));
  return target;
}

function buildSocialLink(row: SocialLinkRow): Rec {
  const target: Rec = { ...row.base };
  target.platform = row.platform;
  target.url = row.url.trim();
  return target;
}

function buildMilestone(row: MilestoneRow): Rec {
  const target: Rec = { ...row.base };
  put(target, "title", text(row.title));
  put(target, "amount", cleanNumber(row.amount));
  put(target, "criteria", text(row.criteria));
  return target;
}

function buildPrize(row: PrizeRow): Rec {
  const target: Rec = { ...row.base };
  put(target, "track", text(row.track));
  // `amount` is the one required member of a prize, so a blank one still has to serialize as a
  // number; `fieldProblems` is what tells the publisher to fill it in.
  target.amount = cleanNumber(row.amount) ?? 0;
  return target;
}

/**
 * A tier's payout, with EVERY member the stated model does not use removed.
 *
 * The schema false-forbids them: a `discretionary` payout carrying an amount, or a `fixed` one
 * carrying a range, does not validate. So switching the model has to clear, not hide — a form that
 * merely stopped rendering the old inputs would keep submitting their values.
 */
function buildPayout(state: PayoutState): Rec {
  type Amount = "amount" | "min" | "max" | "percent" | "floor" | "cap";
  const allowed: Record<PayoutModel, Amount[]> = {
    fixed: ["amount"],
    range: ["min", "max"],
    up_to: ["max"],
    percentage: ["percent", "floor", "cap"],
    discretionary: [],
  };
  const applies = (member: Amount): number | undefined =>
    allowed[state.model].includes(member) ? cleanNumber(state[member]) : undefined;

  const target: Rec = { ...state.base };
  target.model = state.model;
  put(target, "amount", applies("amount"));
  put(target, "min", applies("min"));
  put(target, "max", applies("max"));
  put(target, "percent", applies("percent"));
  // `basis` is required on a percentage and forbidden on every other model — the only non-numeric
  // member the model tag governs.
  put(target, "basis", state.model === "percentage" ? text(state.basis) : undefined);
  put(target, "floor", applies("floor"));
  put(target, "cap", applies("cap"));
  return target;
}

function buildRewardTier(row: RewardTierRow): Rec {
  const target: Rec = { ...row.base };
  put(target, "severity", text(row.severity));
  put(target, "assetType", text(row.assetType));
  put(target, "label", text(row.label));
  target.payout = buildPayout(row.payout);
  return target;
}

/**
 * The type-specific object.
 *
 * The stored one is the base ONLY when it describes the same funding type. Switching type has to
 * start from nothing: every branch is closed, so carrying `hackathon.prizes` into a `grant` block
 * is not a harmless leftover but a document that fails validation on a field the publisher can no
 * longer see.
 */
function buildDetails(form: OpportunityFormState, base: unknown): Rec {
  const type = form.fundingType;
  const stored = isRecord(base) && base.fundingType === type ? base : {};
  const target: Rec = { ...stored };
  target.fundingType = type;
  const write = (key: string, value: unknown) => put(target, key, value);

  if (type === "grant") {
    const grant = form.details.grant;
    write(
      "fundingMechanisms",
      grant.fundingMechanisms.length > 0 ? [...grant.fundingMechanisms] : undefined,
    );
    write("programModel", text(grant.programModel));
    write("milestoneBased", tri(grant.milestoneBased));
    write("recurring", tri(grant.recurring));
  } else if (type === "hackathon") {
    const hackathon = form.details.hackathon;
    // The one place a null is written on purpose: `location: null` IS the claim "fully online".
    write("location", hackathon.fullyOnline ? null : text(hackathon.location));
    write("online", tri(hackathon.online));
    const tracks = splitList(hackathon.tracks);
    write("tracks", tracks.length > 0 ? tracks : undefined);
    write("prizes", hackathon.prizes.length > 0 ? hackathon.prizes.map(buildPrize) : undefined);
    write(
      "teamSize",
      layer(hackathon.teamBase, (size) => {
        put(size, "min", cleanNumber(hackathon.teamMin));
        put(size, "max", cleanNumber(hackathon.teamMax));
      }),
    );
  } else if (type === "bounty") {
    const bounty = form.details.bounty;
    write("bountyKind", bounty.bountyKind);
    // Exactly one of the two, and a security bounty is forbidden the single reward outright.
    const tiers = bounty.bountyKind === "security" || bounty.rewardMode === "tiers";
    write("reward", tiers ? undefined : cleanNumber(bounty.reward));
    write(
      "rewardTiers",
      tiers && bounty.rewardTiers.length > 0 ? bounty.rewardTiers.map(buildRewardTier) : undefined,
    );
    write("severityScheme", text(bounty.severityScheme));
    write("rewardPoolStatus", text(bounty.rewardPoolStatus));
    write("difficulty", text(bounty.difficulty));
    const skills = splitList(bounty.skills);
    write("skills", skills.length > 0 ? skills : undefined);
    write("platform", text(bounty.platform));
  } else if (type === "accelerator") {
    const accelerator = form.details.accelerator;
    write("programDurationWeeks", cleanNumber(accelerator.programDurationWeeks));
    write("batchSize", cleanNumber(accelerator.batchSize));
    write("equity", text(accelerator.equity));
    write("funding", cleanNumber(accelerator.funding));
    write("stage", text(accelerator.stage));
    // Same positive assertion as a hackathon's: null here reads "fully remote".
    write("location", accelerator.fullyRemote ? null : text(accelerator.location));
    write("online", tri(accelerator.online));
  } else if (type === "vc_fund") {
    const fund = form.details.vc_fund;
    write(
      "checkSize",
      layer(fund.checkBase, (size) => {
        put(size, "min", cleanNumber(fund.checkMin));
        put(size, "max", cleanNumber(fund.checkMax));
      }),
    );
    write("stages", fund.stages.length > 0 ? [...fund.stages] : undefined);
    write("thesis", text(fund.thesis));
    const portfolio = splitLines(fund.portfolio);
    write("portfolio", portfolio.length > 0 ? portfolio : undefined);
    write("contactMethod", text(fund.contactMethod));
    write("activelyInvesting", tri(fund.activelyInvesting));
  } else {
    const rfp = form.details.rfp;
    write("scope", text(rfp.scope));
    const requirements = splitLines(rfp.requirements);
    write("requirements", requirements.length > 0 ? requirements : undefined);
  }

  return target;
}

/**
 * Form → Standard document, laid over the record it was loaded from.
 *
 * `base` IS WHAT MAKES A REPLACE SAFE, and it goes deeper than the top level. `PUT` replaces the
 * stored record, so anything this form does not rebuild has to arrive unchanged. The form now
 * models far more than it did, but "models" still is not "owns": an organisation carries contacts,
 * a description, a logo and social links this form never renders, and `source` carries attribution
 * the server owns outright.
 *
 * So the document STARTS as the stored one, and each edited field is written back over it — per
 * container, and per array row via the `base` each row carries from `fromDocument`. That last part
 * is what makes reordering safe: the extra members follow the row, not the index.
 *
 * Nothing here sets a `source.*` attribution field. The server owns every one of them — publisher,
 * submittedBy, submittedAt, ingestedVia, originalId — and a client that sent them would either be
 * ignored or, worse, be believed.
 */
export function toDocument(
  form: OpportunityFormState,
  base: Rec = {},
  /**
   * Which namespace this write is authorised against. Defaults to a create derived from the form —
   * the stricter reading, and the right one for every caller that is not the edit screen.
   */
  authority: NamespaceAuthority = namespaceAuthority("create", form),
): BuildResult {
  const document: Rec = { ...base };
  const set = (key: string, value: unknown): void => put(document, key, value);

  set("specVersion", "1.0.0");
  set("id", form.id.trim());
  set("fundingType", form.fundingType);
  set("title", form.title.trim());
  set("description", form.description);
  set("summary", text(form.summary));
  set("status", form.status);
  set(
    "sponsoringOrganizations",
    form.sponsoringOrganizations.length > 0
      ? form.sponsoringOrganizations.map(buildOrganization)
      : undefined,
  );
  set("operatingOrganizations", form.operatingOrganizations.map(buildOrganization));
  // The server fills this in; it is sent as an empty object because the Standard requires the
  // member to be present.
  set("source", {});

  const ecosystems = splitList(form.ecosystems);
  set("ecosystems", ecosystems.length > 0 ? ecosystems : undefined);
  const categories = splitList(form.categories);
  set("categories", categories.length > 0 ? categories : undefined);

  set("eligibility", text(form.eligibility));
  set("prerequisites", text(form.prerequisites));
  set("additionalReferences", text(form.additionalReferences));
  set("serviceAgreement", text(form.serviceAgreement));
  set("applicationUrl", text(form.applicationUrl));
  set("website", text(form.website));
  set("logoUrl", text(form.logoUrl));
  set("bannerUrl", text(form.bannerUrl));
  set(
    "socialLinks",
    form.socialLinks.length > 0 ? form.socialLinks.map(buildSocialLink) : undefined,
  );

  // Same layering rule one level down: anything a publisher set through the API survives an edit
  // that only touched the budget.
  const fundingInfo: Rec = isRecord(base.fundingInfo) ? { ...base.fundingInfo } : {};
  put(fundingInfo, "currency", text(form.currency));
  put(fundingInfo, "budget", cleanNumber(form.budget));
  put(fundingInfo, "allocated", cleanNumber(form.allocated));
  put(fundingInfo, "minAward", cleanNumber(form.minAward));
  put(fundingInfo, "maxAward", cleanNumber(form.maxAward));
  set("fundingInfo", Object.keys(fundingInfo).length > 0 ? fundingInfo : undefined);

  set("milestones", form.milestones.length > 0 ? form.milestones.map(buildMilestone) : undefined);
  set("opensAt", toIsoUtc(form.opensAt));
  set("deadlines", form.deadlines.length > 0 ? form.deadlines.map(buildDeadline) : undefined);
  set("postedAt", toIsoUtc(form.postedAt));
  set("fundingDetails", buildDetails(form, base.fundingDetails));

  const problemsByField = fieldProblems(form, authority);
  const adviceByField = fieldAdvisories(form);
  return {
    document,
    fieldProblems: problemsByField,
    problems: Object.values(problemsByField),
    fieldAdvisories: adviceByField,
    advisories: Object.values(adviceByField),
  };
}

/**
 * The funding types on which an absent `applicationUrl` is worth mentioning.
 *
 * A grant, hackathon, bounty or RFP is a thing you APPLY TO, and the Standard calls this field "the
 * only URL that points at the opportunity itself, and therefore the only link-back target" — it is
 * also what the verification job fetches. An accelerator or a fund is not on this list because
 * neither reliably has one: a fund whose `contactMethod` is `intro-only` legitimately publishes no
 * application link at all, and nagging about it would be the form disagreeing with the standard.
 */
const APPLICATION_URL_EXPECTED: readonly FundingType[] = ["grant", "hackathon", "bounty", "rfp"];

export const APPLICATION_URL_ADVISORY =
  "Without an application link, readers have no way to apply and source verification never runs. Leave it empty only if applications truly happen elsewhere.";

/**
 * Advice, as distinct from a problem.
 *
 * The schema makes `applicationUrl` optional and this form does not overrule it — nothing here ever
 * blocks a submission. What it does is say the consequence out loud, in the same tier the
 * validator's own advisory checks use, because "optional" and "nobody will miss it" are different
 * claims and only the first one is the schema's.
 */
export function fieldAdvisories(form: OpportunityFormState): Record<string, string> {
  const advice: Record<string, string> = {};
  if (form.applicationUrl.trim() === "" && APPLICATION_URL_EXPECTED.includes(form.fundingType)) {
    advice.applicationUrl = APPLICATION_URL_ADVISORY;
  }
  return advice;
}

// ── per-field validation, mirroring the schema's rules ──────────────────────────

function isUri(value: string): boolean {
  try {
    // The `uri` format is an ABSOLUTE reference: `new URL` with no base rejects `/apply` and
    // `example.org` on its own, which is exactly the pair a publisher gets wrong.
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

const ORG_SLUG = /^[a-z0-9-]+$/;

type Fail = (path: string, message: string) => void;

function amountCheck(fail: Fail) {
  return (path: string, value: string, label: string, max?: number): void => {
    const parsed = numberOrUndefined(value);
    if (parsed === undefined) return;
    if (Number.isNaN(parsed)) fail(path, `${label} is not a number.`);
    else if (parsed < 0) fail(path, `${label} cannot be negative.`);
    else if (max !== undefined && parsed > max) fail(path, `${label} is at most ${max}.`);
  };
}

function countCheck(fail: Fail) {
  return (path: string, value: string, label: string, min: number): void => {
    const parsed = numberOrUndefined(value);
    if (parsed === undefined) return;
    if (Number.isNaN(parsed)) fail(path, `${label} is not a number.`);
    else if (!Number.isInteger(parsed)) fail(path, `${label} must be a whole number.`);
    else if (parsed < min) fail(path, `${label} cannot be below ${min}.`);
  };
}

/**
 * Every rule the schema states about a value a publisher typed, addressed to the field that holds
 * it. The authoritative pass is still `rfphub-validate` in the component; this exists so the answer
 * arrives NEXT TO the input rather than as a JSON pointer at the bottom of a long page.
 */
export function fieldProblems(
  form: OpportunityFormState,
  /** Defaults to a create, which is the stricter of the two and the safe default for a caller. */
  authority: NamespaceAuthority = namespaceAuthority("create", form),
): Record<string, string> {
  const found: { path: string; message: string }[] = [];
  const fail: Fail = (path, message) => found.push({ path, message });

  const amount = amountCheck(fail);
  const requireText = (path: string, value: string, label: string, max?: number) => {
    if (value.trim() === "") fail(path, `${label} is required.`);
    else if (max !== undefined && value.trim().length > max) {
      fail(path, `${label} is at most ${max} characters.`);
    }
  };
  const limit = (path: string, value: string, label: string, max: number) => {
    if (value.trim().length > max) fail(path, `${label} is at most ${max} characters.`);
  };
  const uri = (path: string, value: string, label: string) => {
    if (value.trim() !== "" && !isUri(value.trim())) {
      fail(
        path,
        `${label} must be a full URL including the scheme, for example https://example.org.`,
      );
    }
  };
  const moment = (path: string, value: string, label: string) => {
    if (!isDateTimeShaped(value)) fail(path, `${label} must be a date and a time.`);
  };

  const shape = idProblem(form.id);
  if (shape) fail("id", shape);
  else if (authority.mode === "create") {
    // ON A CREATE the API derives the publishing namespace from `operatingOrganizations[0].slug`
    // (this client never sends `source.publisher`) and rejects an id that does not start with it.
    // Saying so here is the difference between a fixable field and a 400 after a long form.
    const namespace = namespaceOf(form.id);
    const primary = authority.namespace ?? "";
    if (namespace !== null && primary !== "" && namespace !== primary) {
      const elsewhere = form.operatingOrganizations.some((org) => org.slug.trim() === namespace);
      fail(
        "id",
        elsewhere
          ? `${namespace} runs this opportunity but is not the primary organisation. Move it to the top of Who runs it, or start the id with ${primary}.`
          : `The part before the colon must be the primary operating organisation's slug — ${primary}.`,
      );
    }
  }

  // ON A REPLACE the id is immutable and the API does not look at it. The question it does ask is
  // whether the STORED publisher survives the edit — see `namespaceAuthority`.
  if (authority.mode === "edit" && authority.requiresOperating && authority.namespace) {
    const kept = form.operatingOrganizations.some((org) => org.slug.trim() === authority.namespace);
    if (!kept) {
      fail(
        "operatingOrganizations",
        `This listing is published under ${authority.namespace}. A replacement must keep that organisation in the list — removing it would leave the listing published under an organisation that no longer operates it.`,
      );
    }
  }

  requireText("title", form.title, "A title", 300);
  requireText("description", form.description, "A description");
  limit("summary", form.summary, "The summary", 500);
  limit("currency", form.currency, "The currency", 16);

  if (form.operatingOrganizations.length === 0) {
    fail("operatingOrganizations", "At least one operating organisation is required.");
  }
  const organizations = (rows: OrganizationRow[], prefix: string) => {
    rows.forEach((row, index) => {
      requireText(`${prefix}.${index}.name`, row.name, "The organisation name", 256);
      const slug = row.slug.trim();
      if (slug === "") fail(`${prefix}.${index}.slug`, "The organisation slug is required.");
      else if (!ORG_SLUG.test(slug)) {
        fail(`${prefix}.${index}.slug`, "A slug is lowercase letters, digits and hyphens only.");
      }
      uri(`${prefix}.${index}.website`, row.website, "The organisation website");
    });
  };
  organizations(form.operatingOrganizations, "operatingOrganizations");
  organizations(form.sponsoringOrganizations, "sponsoringOrganizations");

  uri("applicationUrl", form.applicationUrl, "The application URL");
  uri("website", form.website, "The website");
  uri("logoUrl", form.logoUrl, "The logo URL");
  uri("bannerUrl", form.bannerUrl, "The banner URL");

  const socialSeen = new Set<string>();
  form.socialLinks.forEach((row, index) => {
    const path = `socialLinks.${index}.url`;
    if (row.url.trim() === "") fail(path, "A social link needs a URL.");
    else uri(path, row.url, "The link");
    const fingerprint = `${row.platform} ${row.url.trim()}`;
    if (socialSeen.has(fingerprint)) fail(path, "This link is already listed.");
    socialSeen.add(fingerprint);
  });

  amount("budget", form.budget, "The total budget");
  amount("allocated", form.allocated, "The allocated amount");
  amount("minAward", form.minAward, "The minimum award");
  amount("maxAward", form.maxAward, "The maximum award");

  form.milestones.forEach((row, index) => {
    amount(`milestones.${index}.amount`, row.amount, "The milestone amount");
  });

  moment("opensAt", form.opensAt, "The opening time");
  moment("postedAt", form.postedAt, "The posting time");

  const deadlineSeen = new Set<string>();
  form.deadlines.forEach((row, index) => {
    const path = `deadlines.${index}.date`;
    if (row.deadlineType === "fixed") {
      if (row.date.trim() === "") fail(path, "A fixed deadline needs a date.");
      else moment(path, row.date, "The deadline");
    }
    limit(`deadlines.${index}.label`, row.label, "The label", 120);
    const fingerprint = `${row.deadlineType} ${row.date.trim()} ${row.label.trim()}`;
    if (deadlineSeen.has(fingerprint)) {
      fail(`deadlines.${index}.label`, "This deadline is already listed.");
    }
    deadlineSeen.add(fingerprint);
  });

  detailProblems(form, fail);

  const byField: Record<string, string> = {};
  for (const check of found) {
    // First problem per field wins: two sentences under one input is noise, and the second is
    // usually a consequence of the first.
    if (!(check.path in byField)) byField[check.path] = check.message;
  }
  return byField;
}

function detailProblems(form: OpportunityFormState, fail: Fail): void {
  const amount = amountCheck(fail);
  const count = countCheck(fail);

  if (form.fundingType === "hackathon") {
    const hackathon = form.details.hackathon;
    count("details.hackathon.teamMin", hackathon.teamMin, "The smallest team", 1);
    count("details.hackathon.teamMax", hackathon.teamMax, "The largest team", 1);
    hackathon.prizes.forEach((row, index) => {
      const path = `details.hackathon.prizes.${index}.amount`;
      if (row.amount.trim() === "") fail(path, "A prize needs an amount.");
      else amount(path, row.amount, "The prize");
    });
    return;
  }

  if (form.fundingType === "bounty") {
    const bounty = form.details.bounty;
    const tiers = bounty.bountyKind === "security" || bounty.rewardMode === "tiers";
    if (!tiers) {
      if (bounty.reward.trim() === "") {
        fail(
          "details.bounty.reward",
          "A task bounty states either a single reward or a reward table — this one states neither.",
        );
      } else amount("details.bounty.reward", bounty.reward, "The reward");
    } else if (bounty.rewardTiers.length === 0) {
      fail(
        "details.bounty.rewardTiers",
        bounty.bountyKind === "security"
          ? "A security bounty pays against a reward table. Add at least one tier."
          : "This bounty is set to pay against a table. Add at least one tier, or switch it back to a single reward.",
      );
    }
    bounty.rewardTiers.forEach((row, index) => {
      const at = `details.bounty.rewardTiers.${index}`;
      if (row.severity.trim() === "" && row.assetType.trim() === "" && row.label.trim() === "") {
        fail(`${at}.severity`, "A tier needs a severity, an asset type or a label.");
      }
      if (row.label.trim().length > 120) {
        fail(`${at}.label`, "The label is at most 120 characters.");
      }
      const payout = row.payout;
      if (payout.model === "fixed") {
        if (payout.amount.trim() === "") {
          fail(`${at}.payout.amount`, "A fixed tier needs an amount.");
        } else amount(`${at}.payout.amount`, payout.amount, "The amount");
      } else if (payout.model === "range") {
        if (payout.min.trim() === "") fail(`${at}.payout.min`, "A range needs a lower bound.");
        else amount(`${at}.payout.min`, payout.min, "The lower bound");
        if (payout.max.trim() === "") fail(`${at}.payout.max`, "A range needs an upper bound.");
        else amount(`${at}.payout.max`, payout.max, "The upper bound");
      } else if (payout.model === "up_to") {
        if (payout.max.trim() === "") fail(`${at}.payout.max`, "An up-to tier needs a ceiling.");
        else amount(`${at}.payout.max`, payout.max, "The ceiling");
      } else if (payout.model === "percentage") {
        if (payout.percent.trim() === "") {
          fail(`${at}.payout.percent`, "A percentage tier needs a percentage.");
        } else amount(`${at}.payout.percent`, payout.percent, "The percentage", 100);
        if (payout.basis.trim() === "") {
          fail(`${at}.payout.basis`, "Name what the percentage is a share of.");
        }
        amount(`${at}.payout.floor`, payout.floor, "The floor");
        amount(`${at}.payout.cap`, payout.cap, "The cap");
      }
    });
    return;
  }

  if (form.fundingType === "accelerator") {
    const accelerator = form.details.accelerator;
    count(
      "details.accelerator.programDurationWeeks",
      accelerator.programDurationWeeks,
      "The duration",
      0,
    );
    count("details.accelerator.batchSize", accelerator.batchSize, "The batch size", 0);
    amount("details.accelerator.funding", accelerator.funding, "The per-team funding");
    return;
  }

  if (form.fundingType === "vc_fund") {
    const fund = form.details.vc_fund;
    amount("details.vc_fund.checkMin", fund.checkMin, "The smallest cheque");
    amount("details.vc_fund.checkMax", fund.checkMax, "The largest cheque");
  }
}

// ── document → form ─────────────────────────────────────────────────────────────

function readOrganizations(value: unknown): OrganizationRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((org) => ({
    key: nextKey("org"),
    name: showText(org.name),
    slug: showText(org.slug),
    orgType: showText(org.orgType),
    website: showText(org.website),
    base: org,
  }));
}

function readDetails(record: Rec): DetailsState {
  const details = emptyDetails();
  const stored = isRecord(record.fundingDetails) ? record.fundingDetails : {};
  const type = showText(stored.fundingType);

  if (type === "grant") {
    details.grant = {
      fundingMechanisms: Array.isArray(stored.fundingMechanisms)
        ? stored.fundingMechanisms.map(String)
        : [],
      programModel: showText(stored.programModel),
      milestoneBased: fromTri(stored.milestoneBased),
      recurring: fromTri(stored.recurring),
    };
  } else if (type === "hackathon") {
    const teamSize = isRecord(stored.teamSize) ? stored.teamSize : {};
    details.hackathon = {
      // `location: null` is the stored form of "fully online" — read back as the checkbox, not as
      // an empty text box, or the next save would silently drop the claim.
      fullyOnline: "location" in stored && stored.location === null,
      location: showText(stored.location),
      online: fromTri(stored.online),
      tracks: Array.isArray(stored.tracks) ? stored.tracks.map(String).join(", ") : "",
      prizes: (Array.isArray(stored.prizes) ? stored.prizes : []).filter(isRecord).map((prize) => ({
        key: nextKey("prize"),
        track: showText(prize.track),
        amount: showNumber(prize.amount),
        base: prize,
      })),
      teamMin: showNumber(teamSize.min),
      teamMax: showNumber(teamSize.max),
      teamBase: teamSize,
    };
  } else if (type === "bounty") {
    const kind = stored.bountyKind === "security" ? "security" : "task";
    const storedTiers = (Array.isArray(stored.rewardTiers) ? stored.rewardTiers : []).filter(
      isRecord,
    );
    details.bounty = {
      bountyKind: kind,
      rewardMode: storedTiers.length > 0 || kind === "security" ? "tiers" : "single",
      reward: showNumber(stored.reward),
      rewardTiers: storedTiers.map((tier) => {
        const stage = isRecord(tier.payout) ? tier.payout : {};
        const model = PAYOUT_MODELS.includes(stage.model as PayoutModel)
          ? (stage.model as PayoutModel)
          : "fixed";
        return {
          key: nextKey("tier"),
          severity: showText(tier.severity),
          assetType: showText(tier.assetType),
          label: showText(tier.label),
          payout: {
            model,
            amount: showNumber(stage.amount),
            min: showNumber(stage.min),
            max: showNumber(stage.max),
            percent: showNumber(stage.percent),
            basis: showText(stage.basis) || "value_at_risk",
            floor: showNumber(stage.floor),
            cap: showNumber(stage.cap),
            base: stage,
          },
          base: tier,
        };
      }),
      severityScheme: showText(stored.severityScheme),
      rewardPoolStatus: showText(stored.rewardPoolStatus),
      difficulty: showText(stored.difficulty),
      skills: Array.isArray(stored.skills) ? stored.skills.map(String).join(", ") : "",
      platform: showText(stored.platform),
    };
  } else if (type === "accelerator") {
    details.accelerator = {
      programDurationWeeks: showNumber(stored.programDurationWeeks),
      batchSize: showNumber(stored.batchSize),
      equity: showText(stored.equity),
      funding: showNumber(stored.funding),
      stage: showText(stored.stage),
      fullyRemote: "location" in stored && stored.location === null,
      location: showText(stored.location),
      online: fromTri(stored.online),
    };
  } else if (type === "vc_fund") {
    const checkSize = isRecord(stored.checkSize) ? stored.checkSize : {};
    details.vc_fund = {
      checkMin: showNumber(checkSize.min),
      checkMax: showNumber(checkSize.max),
      checkBase: checkSize,
      stages: Array.isArray(stored.stages) ? stored.stages.map(String) : [],
      thesis: showText(stored.thesis),
      portfolio: Array.isArray(stored.portfolio) ? stored.portfolio.map(String).join("\n") : "",
      contactMethod: showText(stored.contactMethod),
      activelyInvesting: fromTri(stored.activelyInvesting),
    };
  } else if (type === "rfp") {
    details.rfp = {
      scope: showText(stored.scope),
      requirements: Array.isArray(stored.requirements)
        ? stored.requirements.map(String).join("\n")
        : "",
    };
  }

  return details;
}

/**
 * Document → form, for the edit screen.
 *
 * `carried` is THE WHOLE STORED RECORD, not the leftovers. A `PUT` replaces it, so the safe base
 * for the next one is the last one — `toDocument(form, carried)` then writes the edited fields back
 * over it and removes the ones the publisher cleared.
 *
 * Carrying the whole record also keeps key order, which is what lets the round-trip test assert
 * that an untouched edit produces a byte-identical payload rather than merely an equivalent one.
 */
export function fromDocument(entry: Opportunity): {
  form: OpportunityFormState;
  carried: Rec;
} {
  const record = entry as unknown as Rec;
  const funding = isRecord(record.fundingInfo) ? record.fundingInfo : {};
  const type = FUNDING_TYPES.includes(record.fundingType as FundingType)
    ? (record.fundingType as FundingType)
    : "grant";

  const carried: Rec = { ...record };
  // Server-owned, and sent back empty rather than echoed: attribution is set on every write, and a
  // client restating it is either ignored or, worse, believed.
  carried.source = record.source ?? {};

  const operating = readOrganizations(record.operatingOrganizations);

  return {
    form: {
      id: showText(record.id),
      // An id that already exists was chosen, not derived; never retitle somebody's key for them.
      idDirty: true,
      fundingType: type,
      title: showText(record.title),
      summary: showText(record.summary),
      description: showText(record.description),
      status: showText(record.status) || "open",
      ecosystems: Array.isArray(record.ecosystems) ? record.ecosystems.map(String).join(", ") : "",
      categories: Array.isArray(record.categories) ? record.categories.map(String).join(", ") : "",
      eligibility: showText(record.eligibility),
      prerequisites: showText(record.prerequisites),
      additionalReferences: showText(record.additionalReferences),
      serviceAgreement: showText(record.serviceAgreement),
      applicationUrl: showText(record.applicationUrl),
      website: showText(record.website),
      logoUrl: showText(record.logoUrl),
      bannerUrl: showText(record.bannerUrl),
      socialLinks: (Array.isArray(record.socialLinks) ? record.socialLinks : [])
        .filter(isRecord)
        .map((link) => ({
          key: nextKey("social"),
          platform: showText(link.platform) || "twitter",
          url: showText(link.url),
          base: link,
        })),
      operatingOrganizations: operating.length > 0 ? operating : [emptyOrganization()],
      sponsoringOrganizations: readOrganizations(record.sponsoringOrganizations),
      currency: showText(funding.currency),
      budget: showNumber(funding.budget),
      allocated: showNumber(funding.allocated),
      minAward: showNumber(funding.minAward),
      maxAward: showNumber(funding.maxAward),
      milestones: (Array.isArray(record.milestones) ? record.milestones : [])
        .filter(isRecord)
        .map((milestone) => ({
          key: nextKey("milestone"),
          title: showText(milestone.title),
          amount: showNumber(milestone.amount),
          criteria: showText(milestone.criteria),
          base: milestone,
        })),
      opensAt: fromIsoUtc(record.opensAt),
      postedAt: fromIsoUtc(record.postedAt),
      deadlines: (Array.isArray(record.deadlines) ? record.deadlines : [])
        .filter(isRecord)
        .map((deadline) => ({
          key: nextKey("deadline"),
          deadlineType: deadline.deadlineType === "rolling" ? "rolling" : "fixed",
          date: fromIsoUtc(deadline.date),
          label: showText(deadline.label),
          base: deadline,
        })),
      details: readDetails(record),
    },
    carried,
  };
}

// ── list editing, shared by every repeating group ───────────────────────────────

export function removeRow<T>(rows: T[], index: number): T[] {
  return rows.filter((_, position) => position !== index);
}

export function replaceRow<T>(rows: T[], index: number, row: T): T[] {
  return rows.map((current, position) => (position === index ? row : current));
}

/**
 * Move a row one place, for the two lists whose ORDER IS SEMANTIC: `operatingOrganizations[0]` is
 * the primary organisation and the one displayed, and `milestones` is a sequence with no index
 * field of its own. Everywhere else order is presentational and there are no arrows.
 */
export function moveRow<T>(rows: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= rows.length) return rows;
  const next = [...rows];
  const [row] = next.splice(index, 1);
  if (row === undefined) return rows;
  next.splice(target, 0, row);
  return next;
}
