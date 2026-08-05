// GENERATED from schemas/v1.0.0/opportunity.schema.json — do not edit by hand.
// Regenerate with `pnpm codegen`.
/* biome-ignore-all lint: generated */

/**
 * RFP Hub Standard v1.0.0 — the normative definition of a funding opportunity in the Ethereum ecosystem. A document conforms to this version of the standard when it validates against this file. Covers six funding types: grant, hackathon, bounty, accelerator, vc_fund, rfp. Aligns conceptually with DAOIP-5 (Grants Metadata) and schema.org/Grant. Published under CC0 1.0 Universal. The field reference is FIELDS.md, the normative/informative split is NORMATIVE.md, and both ship alongside this file in the @the-rfp-hub/standard package and at https://github.com/The-RFP-Hub/the-rfp-hub.
 */
export type RFPHubOpportunity = {
  [k: string]: unknown;
} & {
  /**
   * Optional self-identification: the URL of the RFP Hub schema this document claims to conform to. Permitted so a generic validator can discover the contract from the instance alone. Ignored by validation — naming a different schema here does not change which schema the document is validated against.
   */
  $schema?: string;
  /**
   * Optional JSON-LD context: a URL, an inline context object, or an array of either. Permitted so an instance can be consumed as linked data. Ignored by validation — the standard makes no claim about its contents.
   */
  "@context"?: string | {} | unknown[];
  /**
   * Optional JSON-LD type, or an array of types. Permitted so an instance can be consumed as linked data; ignored by validation.
   */
  "@type"?: string | unknown[];
  /**
   * The RFP Hub Standard version this entry conforms to. Fixed at 1.0.0 for this schema. Consumers use it to select the correct validator.
   */
  specVersion: "1.0.0";
  /**
   * Stable, unique identifier for the opportunity within the Hub. Immutable once assigned. A namespaced form is recommended but not required.
   */
  id: string;
  /**
   * The kind of funding opportunity, and the structural discriminator of the standard. Every entry carries its type-specific details in `fundingDetails`, whose own `fundingType` tag names that object's shape and always equals this field — the binding allOf below keeps the two in step — so consumers can dispatch on either tag. For grants the details may carry nothing beyond the tag.
   */
  fundingType: "grant" | "hackathon" | "bounty" | "accelerator" | "vc_fund" | "rfp";
  /**
   * Human-readable name of the opportunity.
   */
  title: string;
  /**
   * Full description of the opportunity. Markdown is permitted; consumers are advised to treat it as untrusted and sanitise before rendering.
   */
  description: string;
  /**
   * Optional short teaser (roughly one or two sentences) for list and card views.
   */
  summary?: string | null;
  /**
   * Lifecycle status of the opportunity. 'upcoming' = announced but not yet accepting applications, and also the value for a pre-open posting — there is no 'draft' status; 'open' = currently accepting; 'closed' = no longer accepting; 'archived' = withdrawn or retired. Editorial and review state (pending, rejected) is not represented here — it is server-side metadata.
   */
  status: "upcoming" | "open" | "closed" | "archived";
  /**
   * The organisations issuing or backing the opportunity — the issuer or backer, not necessarily the source of funds, because for donor-funded models the money's origin is deliberately not modelled. Optional, and may be absent or empty, when the operator is the only party to name or the backer is not published. The party running the process belongs in operatingOrganizations instead.
   */
  sponsoringOrganizations?: Organization[];
  /**
   * The organisations that actually run the opportunity — intake, process and the application funnel, whether on their own behalf or a sponsor's. Array order is semantic: entry 0 is the primary organisation and the one to display.
   *
   * @minItems 1
   */
  operatingOrganizations: [Organization, ...Organization[]];
  source: Provenance;
  /**
   * Ethereum-family ecosystems this opportunity targets. The RFP Hub is ETH-scoped, but this is an open, extensible list — not a closed enum, and deliberately not registry-governed either — so L2s and ETH-adjacent ecosystems are first-class and a newly launched one needs no process.
   */
  ecosystems?: string[];
  /**
   * Topical categories. Free text.
   */
  categories?: string[];
  /**
   * Free text describing who may apply — stage, geography, jurisdiction, entity requirements, compliance constraints — in the publisher's own words. Deliberately unstructured: eligibility criteria vary too much across publishers to be comparable as data, so this field is for reading, not faceting.
   */
  eligibility?: string | null;
  /**
   * Free text describing what a proposal must contain to be considered — track record, approach, milestone plan, disclosures. Distinct from rfp.requirements, which describes what the work must deliver.
   */
  prerequisites?: string | null;
  /**
   * A single free-form string of supporting links and references — guidelines, past rounds, forum threads, original postings. Deliberately one string rather than an array of URIs, because publishers paste what they have.
   */
  additionalReferences?: string | null;
  /**
   * Free text describing how a service-agreement arrangement works. Valid on any fundingType — an rfp or grant carrying it reads as a long-term service engagement. Presence of the field is the signal; duration and renewal live in the text if they matter. Not filterable or facetable, by design.
   */
  serviceAgreement?: string | null;
  /**
   * URL where applicants submit or apply — the only URL that points at the opportunity itself, and therefore the only link-back target. It may carry whatever the submission channel is, including a forum thread when no portal exists; the URL's kind is not typed. Clarifications go in description.
   */
  applicationUrl?: string | null;
  /**
   * Primary website for the opportunity or program.
   */
  website?: string | null;
  /**
   * URL of the program or organisation logo image.
   */
  logoUrl?: string | null;
  /**
   * URL of a banner or hero image.
   */
  bannerUrl?: string | null;
  /**
   * Social and community links for the opportunity or program, one entry per link. The same platform may appear in more than one entry when it has more than one URL; only whole-entry duplicates are rejected.
   */
  socialLinks?: SocialLink[];
  fundingInfo?: FundingEnvelope;
  /**
   * Optional milestone sequence, valid on any fundingType. Array order is the milestone sequence — there is no order or index field. Milestone-based payment is expressed by this array together with grant.milestoneBased; there is no separate payment-schedule concept.
   */
  milestones?: Milestone[];
  /**
   * RFC 3339 timestamp in UTC (trailing 'Z') for when applications open. null means unknown.
   */
  opensAt?: string | null;
  /**
   * All deadlines and event boundaries for the opportunity, each either a fixed date or rolling, distinguished by label. Consumers should select by label rather than by array position: the first entry may be a hackathon's start date rather than its application deadline. Conventional labels are published in registries/deadline-labels.json. (Selection-by-label is a consumer convention, not schema-enforceable; see FIELDS.md.)
   */
  deadlines?: Deadline[];
  /**
   * RFC 3339 timestamp in UTC (trailing 'Z') for when the opportunity was first publicly announced at the source. null means unknown.
   */
  postedAt?: string | null;
  /**
   * RFC 3339 timestamp in UTC (trailing 'Z') for when this entry was created in the Hub. null means unknown.
   */
  createdAt?: string | null;
  /**
   * RFC 3339 timestamp in UTC (trailing 'Z') for when this entry was last modified in the Hub. null means unknown.
   */
  updatedAt?: string | null;
  /**
   * The type-specific details for this opportunity: exactly one of the six detail shapes, self-described by its own required `fundingType` tag, which names the shape and equals the top-level `fundingType` (the binding allOf below keeps the two in step).
   */
  fundingDetails: GrantDetails | HackathonDetails | BountyDetails | AcceleratorDetails | VCFundDetails | RFPDetails;
};

/**
 * An organisation sponsoring or operating the opportunity. Embedded on an opportunity as a descriptive summary; the same shape is the standalone Organization directory record.
 */
export interface Organization {
  /**
   * Display name of the organisation.
   */
  name: string;
  /**
   * Lowercase URL-safe identifier, and also the organisation's namespace.
   */
  slug: string;
  /**
   * Kind of entity.
   */
  orgType?: "foundation" | "dao" | "company" | "protocol" | "program" | "individual" | "other";
  /**
   * Short description of the organisation.
   */
  description?: string | null;
  /**
   * The organisation's primary website.
   */
  website?: string | null;
  /**
   * URL of the organisation's logo image.
   */
  logoUrl?: string | null;
  /**
   * URL of the organisation's banner or hero image.
   */
  bannerUrl?: string | null;
  /**
   * Social and community links for the organisation, one entry per link. The same platform may appear in more than one entry when it has more than one URL; only whole-entry duplicates are rejected.
   */
  socialLinks?: SocialLink[];
  /**
   * Ethereum-family ecosystems the organisation operates in. Same open list as the top-level field.
   */
  ecosystems?: string[];
  /**
   * Named contact routes into the organisation. Optional, and every field of every entry is optional too.
   */
  contacts?: Contact[];
}
/**
 * One social or community link: the platform it lives on and its full URL.
 */
export interface SocialLink {
  /**
   * Which service the link points at. 'twitter' covers X/Twitter; 'forum' is the governance or community forum; 'blog' is the blog or announcements feed.
   */
  platform: "twitter" | "discord" | "github" | "telegram" | "farcaster" | "forum" | "blog";
  /**
   * Full URL of the profile, server, group or feed — a link, not a handle.
   */
  url: string;
}
/**
 * A named contact route into the organisation. Every property is optional and there is no minimum-one-identifier constraint, so `{}` validates — deliberately, because not every publisher can or will name a person.
 */
export interface Contact {
  /**
   * The person's name.
   */
  name?: string | null;
  /**
   * Role in the program.
   */
  role?: string | null;
  /**
   * Telegram handle. A handle rather than a URL — unlike a socialLinks entry with platform 'telegram', which is a link.
   */
  telegram?: string | null;
  /**
   * Email address.
   */
  email?: string | null;
}
/**
 * Provenance of this entry. Required as an object, but every field inside it is optional, so `"source": {}` validates. Provenance completeness is a data-quality and ingestion-policy concern rather than a schema constraint.
 */
export interface Provenance {
  /**
   * Namespace — an organisation slug — this entry was published under. Auto-approval requires the publishing account to be a member of this verified org. May differ from the sponsoring organisation.
   */
  publisher?: string | null;
  /**
   * Who submitted or published this entry: a public handle, an organisation slug, or 'community' for anonymous community submissions. The internal account identity is never exposed. This is the attribution carrier for data-partner credit.
   */
  submittedBy?: string | null;
  /**
   * RFC 3339 timestamp in UTC (trailing 'Z') for when the entry was submitted or published to the Hub. Pairs with submittedBy. null means unknown.
   */
  submittedAt?: string | null;
  /**
   * How this entry entered the Hub. 'outbox' is a one-way push from an upstream source system's outbox; 'import' is a backfill or seed import. Always set server-side by the ingestion layer.
   */
  ingestedVia?: "publisher_api" | "submission" | "scrape" | "import" | "outbox" | null;
  /**
   * Identifier of this opportunity in the source system.
   */
  originalId?: string | null;
  /**
   * Whether the entry's fields were verified against the live opportunity by the verification-assist job. null means not yet checked.
   */
  verifiedAgainstSource?: boolean | null;
  /**
   * RFC 3339 timestamp in UTC (trailing 'Z') for the last verification. Record-level only — there is no per-field freshness. null means unknown.
   */
  verifiedAt?: string | null;
  /**
   * IPFS or archived snapshot of the opportunity taken at verification time.
   */
  snapshotUrl?: string | null;
}
/**
 * Program-level funding envelope: single currency, total budget, amount committed to date, and the per-award range.
 */
export interface FundingEnvelope {
  /**
   * ISO 4217 code or token symbol for the amounts below, and for milestones[].amount.
   */
  currency?: string | null;
  /**
   * Total program budget in major units.
   */
  budget?: number | null;
  /**
   * Amount committed to date in major units — committed, not necessarily disbursed. Disbursement and delivery are not modelled.
   */
  allocated?: number | null;
  /**
   * Minimum individual award in major units.
   */
  minAward?: number | null;
  /**
   * Maximum individual award in major units.
   */
  maxAward?: number | null;
}
/**
 * One milestone in an opportunity's milestone sequence. Every property is optional — a publisher may list titles with no amounts, or amounts with no criteria. There is no date field: where a publisher has a due date, it goes into `criteria` as free text.
 */
export interface Milestone {
  /**
   * Short name of the milestone.
   */
  title?: string | null;
  /**
   * Payment for this milestone in major units, denominated in the top-level fundingInfo.currency. That denomination rule is a requirement on publishers but crosses two objects, so it is not schema-enforceable; see FIELDS.md. The validator's advisory tier warns when this is present and fundingInfo.currency is absent.
   */
  amount?: number | null;
  /**
   * Free-text acceptance criteria, including any due date.
   */
  criteria?: string | null;
}
/**
 * A single deadline or event boundary. A 'fixed' entry carries a date; 'rolling' means applications are accepted continuously.
 */
export interface Deadline {
  /**
   * Whether this deadline is a fixed point in time or an open-ended rolling window.
   */
  deadlineType: "fixed" | "rolling";
  /**
   * RFC 3339 timestamp in UTC (trailing 'Z'). Required and non-null when deadlineType is 'fixed', enforced by the if/then below; meaningless, and normally omitted, when deadlineType is 'rolling'.
   */
  date?: string | null;
  /**
   * What this deadline is for. Free text; conventional values are published in registries/deadline-labels.json. This is how a consumer tells an application deadline from an event boundary.
   */
  label?: string | null;
}
/**
 * The fundingDetails payload when fundingType is 'grant': grant-specific attributes not covered by the core fields. May carry nothing beyond its fundingType tag, because core funding and date fields live at the top level.
 */
export interface GrantDetails {
  /**
   * Names this block's shape; equals the top-level fundingType.
   */
  fundingType: "grant";
  /**
   * How funds are allocated. An array because mechanisms co-occur: a funder can offer a fixed grant and a matching grant in the same program.
   */
  fundingMechanisms?: ("retroactive" | "proactive" | "streaming" | "quadratic" | "matching" | "other")[];
  /**
   * The operating model of the program, as distinct from the funding instrument. An open list rather than a closed enum — conventional values are published in registries/program-models.json, and a publisher's own vocabulary is valid without a schema change.
   */
  programModel?: string | null;
  /**
   * Whether disbursement is tied to milestones. Pairs with the top-level milestones array.
   */
  milestoneBased?: boolean | null;
  /**
   * Whether the program runs in recurring rounds or seasons.
   */
  recurring?: boolean | null;
}
/**
 * The fundingDetails payload when fundingType is 'hackathon': hackathon-specific attributes. All dates — registration, submission, event start and event end — live in the shared top-level deadlines array, distinguished by label.
 */
export interface HackathonDetails {
  /**
   * Names this block's shape; equals the top-level fundingType.
   */
  fundingType: "hackathon";
  /**
   * Physical location, or null for a fully online event.
   */
  location?: string | null;
  /**
   * Whether the event is also, or only, held online.
   */
  online?: boolean | null;
  /**
   * Named tracks or themes participants can build against.
   */
  tracks?: string[];
  /**
   * The prize pool, one entry per prize. Each prize carries its own currency.
   */
  prizes?: HackathonPrize[];
  teamSize?: TeamSizeRange;
}
/**
 * A single hackathon prize, optionally attributed to a track.
 */
export interface HackathonPrize {
  /**
   * Track this prize belongs to, where prizes are tracked separately.
   */
  track?: string | null;
  /**
   * Prize amount in major units.
   */
  amount: number;
  /**
   * ISO 4217 code or token symbol for this prize.
   */
  currency: string;
}
/**
 * Permitted team size range.
 */
export interface TeamSizeRange {
  /**
   * Minimum number of team members.
   */
  min?: number | null;
  /**
   * Maximum number of team members.
   */
  max?: number | null;
}
/**
 * The fundingDetails payload when fundingType is 'bounty': bounty-specific attributes. A bounty is a single scoped task with a stated reward, so the reward is the one required field beyond the fundingType tag.
 */
export interface BountyDetails {
  /**
   * Names this block's shape; equals the top-level fundingType.
   */
  fundingType: "bounty";
  /**
   * The reward paid on completion. Carries its own currency.
   */
  reward: {
    /**
     * Amount in major units of the currency, so 2000000 means 2,000,000 USD rather than cents.
     */
    amount: number;
    /**
     * ISO 4217 fiat code such as USD or EUR, or a token symbol such as ETH, OP or USDC.
     */
    currency: string;
  };
  /**
   * Self-assessed difficulty, as a hint to applicants.
   */
  difficulty?: "beginner" | "intermediate" | "advanced" | null;
  /**
   * Skills the task calls for. Free text.
   */
  skills?: string[];
  /**
   * Platform hosting the bounty.
   */
  platform?: string | null;
}
/**
 * The fundingDetails payload when fundingType is 'accelerator': accelerator-specific attributes. The application deadline lives in the shared top-level deadlines array with label 'application'.
 */
export interface AcceleratorDetails {
  /**
   * Names this block's shape; equals the top-level fundingType.
   */
  fundingType: "accelerator";
  /**
   * Length of the program in weeks.
   */
  programDurationWeeks?: number | null;
  /**
   * Number of teams accepted per cohort.
   */
  batchSize?: number | null;
  /**
   * Equity taken, expressed as a string because programs state it in incomparable ways.
   */
  equity?: string | null;
  /**
   * Investment or stipend offered per team. Carries its own currency.
   */
  funding?: {
    /**
     * Amount in major units of the currency, so 2000000 means 2,000,000 USD rather than cents.
     */
    amount: number;
    /**
     * ISO 4217 fiat code such as USD or EUR, or a token symbol such as ETH, OP or USDC.
     */
    currency: string;
  };
  /**
   * Company stage the program targets.
   */
  stage?: "pre-seed" | "seed" | "series-a" | null;
  /**
   * Physical location, or null for a fully remote program.
   */
  location?: string | null;
  /**
   * Whether the program is also, or only, run remotely.
   */
  online?: boolean | null;
}
/**
 * The fundingDetails payload when fundingType is 'vc_fund': venture-fund-specific attributes. A fund is an ongoing source of capital rather than a round, so it carries no deadline of its own.
 */
export interface VCFundDetails {
  /**
   * Names this block's shape; equals the top-level fundingType.
   */
  fundingType: "vc_fund";
  checkSize?: AmountRange;
  /**
   * Investment stages the fund participates in.
   */
  stages?: ("pre-seed" | "seed" | "series-a" | "series-b+" | "growth")[];
  /**
   * Investment thesis, in the fund's own words.
   */
  thesis?: string | null;
  /**
   * Named portfolio companies, where the fund publishes them.
   */
  portfolio?: string[];
  /**
   * How the fund prefers to be approached. 'intro-only' means a warm introduction is required.
   */
  contactMethod?: "email" | "form" | "intro-only" | null;
  /**
   * Whether the fund is currently deploying capital.
   */
  activelyInvesting?: boolean | null;
}
/**
 * Typical investment size, as a range.
 */
export interface AmountRange {
  /**
   * Lower bound in major units.
   */
  min?: number | null;
  /**
   * Upper bound in major units.
   */
  max?: number | null;
  /**
   * ISO 4217 code or token symbol for both bounds.
   */
  currency?: string | null;
}
/**
 * The fundingDetails payload when fundingType is 'rfp': RFP-specific attributes. The issuing organisation is operatingOrganizations[0], the budget is the top-level fundingInfo envelope, and the proposal deadline is a deadlines entry labelled 'application'.
 */
export interface RFPDetails {
  /**
   * Names this block's shape; equals the top-level fundingType.
   */
  fundingType: "rfp";
  /**
   * Scope of work, as one free-text field. In-scope and out-of-scope prose both live here.
   */
  scope?: string | null;
  /**
   * Free-text statements of what the work must deliver. RFP-only, and deliberately not split into hard and soft. What a proposal must contain goes in the top-level prerequisites instead.
   */
  requirements?: string[];
}
