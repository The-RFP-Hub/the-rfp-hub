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
   * ISO 4217 code or token symbol denominating every monetary amount in the document: the amounts below, plus milestones[].amount, bounty.reward, hackathon.prizes[].amount, accelerator.funding and vcFund.checkSize.
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
   * Payment for this milestone in major units of the document-wide fundingInfo.currency. That denomination rule is a requirement on publishers but crosses two objects, so it is not schema-enforceable; see FIELDS.md. The validator's advisory tier warns when this is present and fundingInfo.currency is absent.
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
   * The prize pool, one entry per prize, denominated in the document-wide fundingInfo.currency.
   */
  prizes?: HackathonPrize[];
  teamSize?: TeamSizeRange;
}
/**
 * A single hackathon prize, optionally attributed to a track. Denominated in the document-wide fundingInfo.currency, like every monetary amount in the document.
 */
export interface HackathonPrize {
  /**
   * Track this prize belongs to, where prizes are tracked separately.
   */
  track?: string | null;
  /**
   * Prize amount in major units of fundingInfo.currency.
   */
  amount: number;
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
 * The fundingDetails payload when fundingType is 'bounty': bounty-specific attributes. Two kinds share this block, named by bountyKind. A 'task' bounty is a single scoped piece of work with one stated reward. A 'security' bounty is a standing vulnerability-disclosure program whose payout is a table of tiers, normally graded by severity and by the class of asset in scope. The two kinds carry different required fields, bound by the allOf below.
 */
export interface BountyDetails {
  /**
   * Names this block's shape; equals the top-level fundingType.
   */
  fundingType: "bounty";
  /**
   * Which kind of bounty this is, and the discriminator for what the payout looks like. 'task' = one scoped piece of work paying a single reward; 'security' = a standing vulnerability-disclosure program paying against a tier table. This is about payout shape, not about how long the bounty stays open: intake duration lives in the top-level deadlines array, and either kind may be rolling.
   */
  bountyKind: "task" | "security";
  /**
   * The reward paid on completion, in major units of the document-wide fundingInfo.currency. The compensation for a bounty that pays one amount. Exactly one of this and rewardTiers is present on any bounty, enforced by the if/then/else below: they are alternative descriptions of the same money, so a document carrying both leaves a consumer no way to tell which is authoritative. A security bounty is forbidden from carrying it at all and states its amounts in rewardTiers, because a graded program has no single reward and collapsing the table to one number overstates what a typical report pays. That denomination rule is a requirement on publishers but crosses two objects, so it is not schema-enforceable; see FIELDS.md. The validator's advisory tier warns when this is present and fundingInfo.currency is absent.
   */
  reward?: number;
  /**
   * The payout table, one entry per tier. The payout table, one entry per tier. Required when bountyKind is 'security', and the alternative to reward on a task bounty that grades its payout — a placement ladder, for instance — rather than paying one flat amount. Exactly one of this and reward is present, enforced by the if/then/else below. Array order carries no meaning; select by the tier's own severity, assetType or label.
   *
   * @minItems 1
   */
  rewardTiers?: [RewardTier, ...RewardTier[]];
  /**
   * The published classification the tier severities are drawn from, named so a consumer can tell whose definition of 'critical' is in play. Free text, because these schemes are documents rather than a vocabulary worth governing.
   */
  severityScheme?: string | null;
  /**
   * Whether the money behind the advertised amounts is actually held. 'funded' = escrowed or otherwise verifiably reserved; 'unfunded' = advertised as an intent to pay, with nothing set aside; 'unknown' = not published, which is the honest value where the program says nothing and the reason absent does not read as 'unfunded'. Separate from fundingInfo.budget, which carries the amount: a program can name a large maximum and hold nothing against it.
   */
  rewardPoolStatus?: "funded" | "unfunded" | "unknown" | null;
  /**
   * Self-assessed difficulty, as a hint to applicants. Meaningful on a task bounty; a security program grades by severity in rewardTiers instead.
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
 * One row of a bounty's payout table: what is being paid for, and what it pays. The 'what for' is a selector — severity and assetType form a compound coordinate where a program grades on both, and label carries a grading axis neither describes. Each is individually optional so a program grading on one axis carries only that one, but at least one is required by the minProperties rule below: a row with no selector is an anonymous rule nothing can be matched against, not a tier. The payout is the other required part, because a tier that names no amount and no payout model is not a tier either.
 */
export interface RewardTier {
  /**
   * Severity band this row pays for. An open list rather than a closed enum — conventional values are published in registries/bounty-severities.json, and a program's own vocabulary is valid without a schema change. Name the scheme these are drawn from in severityScheme.
   */
  severity?: string;
  /**
   * Class of in-scope asset this row pays for, where a program grades the same severity differently by what was found. An open list rather than a closed enum — conventional values are published in registries/bounty-asset-types.json. Absent where a program grades on severity alone.
   */
  assetType?: string;
  /**
   * What this row pays for, in the publisher's own words, where severity and assetType do not describe it — a placement in a prize ladder, or a named category. This is a selector, not a caption: it is how a consumer picks the row out when the structured dimensions do not apply. Where it accompanies severity or assetType it reads as a caption, and a consumer that facets should prefer the structured dimensions. Free text.
   */
  label?: string;
  payout: Payout;
}
/**
 * What this tier pays, and on which model.
 */
export interface Payout {
  /**
   * How this tier's payout is determined. 'fixed' pays one amount; 'range' pays somewhere between two bounds; 'up_to' names a ceiling with no floor; 'percentage' pays a share of a quantity the basis field names, optionally bounded by floor and cap; 'discretionary' names no figure at all, because the payer decides case by case, and carries none of the amount fields. The last is a real published position, not missing data — programs run numeric tiers and discretionary tiers side by side in the same table.
   */
  model: "fixed" | "range" | "up_to" | "percentage" | "discretionary";
  /**
   * The amount paid, where the model is 'fixed'. Required and non-null for that model, enforced by the if/then/else below.
   */
  amount?: number | null;
  /**
   * Lower bound, where the model is 'range'. Required and non-null for that model, enforced by the if/then/else below.
   */
  min?: number | null;
  /**
   * Upper bound, where the model is 'range' or 'up_to'. Required and non-null for both, enforced by the if/then/else below.
   */
  max?: number | null;
  /**
   * Share this tier pays, as a percentage between 0 and 100 — a program paying 'up to 10% of funds affected' carries 10 here. What the share is *of* is named by basis, not assumed. Required and non-null where the model is 'percentage', enforced by the if/then/else below.
   */
  percent?: number | null;
  /**
   * What the percentage is a share of. Required where the model is 'percentage' and forbidden on every other model, enforced by the if/then/else below. 'value_at_risk' = the funds the finding could have taken, the construction most programs publish; 'economic_damage' = the loss actually caused, which some programs cap against instead. The two are not interchangeable and a program that states one is not stating the other, which is why the model tag no longer asserts a basis of its own. The list grows by spec release as programs attest a new one.
   */
  basis?: "value_at_risk" | "economic_damage";
  /**
   * Least the tier pays regardless of the computed figure, where a percentage model states a minimum. Optional; absent means the computation is unbounded below.
   */
  floor?: number | null;
  /**
   * Most the tier pays regardless of the computed figure, where a percentage model states a maximum. Optional; absent means the computation is unbounded above.
   */
  cap?: number | null;
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
   * Investment or stipend offered per team, in major units of the document-wide fundingInfo.currency. That denomination rule is a requirement on publishers but crosses two objects, so it is not schema-enforceable; see FIELDS.md. The validator's advisory tier warns when this is present and fundingInfo.currency is absent.
   */
  funding?: number | null;
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
 * Typical investment size, as a range denominated in the document-wide fundingInfo.currency.
 */
export interface AmountRange {
  /**
   * Lower bound in major units of fundingInfo.currency.
   */
  min?: number | null;
  /**
   * Upper bound in major units of fundingInfo.currency.
   */
  max?: number | null;
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
