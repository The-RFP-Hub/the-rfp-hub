// GENERATED from schemas/v1.0.0/opportunity.schema.json — do not edit by hand.
// Regenerate with `pnpm codegen`.
/* biome-ignore-all lint: generated */

/**
 * RFP Hub Standard v1.0.0 — a canonical, ecosystem-neutral representation of an Ethereum-ecosystem funding opportunity. Covers six opportunity types: grant, hackathon, bounty, accelerator, vc_fund, rfp. Released as CC0 1.0. Informed by, but deliberately decoupled from, Karma's internal program_registry schema; aligns conceptually with DAOIP-5 (Grants Metadata) and schema.org/Grant. See FIELDS.md for the full field reference and the Karma program_registry mapping.
 */
export type RFPHubOpportunity = {
  [k: string]: unknown;
} & {
  /**
   * The RFP Hub Standard version this entry conforms to. Fixed at 1.0.0 for this schema. Consumers use it to select the correct validator.
   */
  specVersion: "1.0.0";
  /**
   * Stable, unique identifier for the opportunity within the Hub. Immutable once assigned. A namespaced form (e.g. 'filecoin:propgf-batch-3') is recommended but not required.
   */
  id: string;
  /**
   * The kind of funding opportunity. Values match Karma's OpportunityType enum to minimise mapping friction. Every entry carries a type-specific object under a key EQUAL to this value (type 'hackathon' → a 'hackathon' object, 'vc_fund' → a 'vc_fund' object), so consumers can always read `opportunity[opportunity.type]`. The matching block is required for all six types (see allOf); for grants it may be an empty object.
   */
  type: "grant" | "hackathon" | "bounty" | "accelerator" | "vc_fund" | "rfp";
  /**
   * Human-readable name of the opportunity.
   */
  title: string;
  /**
   * Full description of the opportunity. Markdown is permitted; consumers should treat it as untrusted and sanitise before rendering.
   */
  description: string;
  /**
   * Optional short teaser (≈1–2 sentences) for list/card views. Maps from Karma metadata.shortDescription.
   */
  summary?: string | null;
  /**
   * Lifecycle status of the opportunity. 'upcoming' = announced but not yet accepting applications; 'open' = currently accepting; 'closed' = deadline passed or no longer accepting (auto-set when closesAt passes); 'archived' = withdrawn or retired. Editorial/review state (pending, rejected) is NOT represented here — it is server-side metadata.
   */
  status: "upcoming" | "open" | "closed" | "archived";
  organization: Organization;
  source: Provenance;
  /**
   * Ethereum-family ecosystems this opportunity targets. The RFP Hub is ETH-scoped (per DEV-437), but this is an open, extensible list — NOT a closed enum — so L2s and ETH-adjacent ecosystems are first-class. Examples (non-normative): 'Ethereum', 'Optimism', 'Base', 'Arbitrum', 'Polygon', 'Scroll', 'zkSync', 'Linea', 'OP Stack', 'Celo'.
   */
  ecosystems?: string[];
  /**
   * Specific networks/chains the funding is denominated on or deployed to (e.g. 'optimism', 'base', 'ethereum-mainnet'). Free-text; not constrained to a closed set in v1.0.0.
   */
  networks?: string[];
  /**
   * Topical categories (e.g. 'DeFi', 'Public Goods', 'Infrastructure', 'Developer Tooling'). Free-text in v1.0.0.
   */
  categories?: string[];
  /**
   * Free-form tags for search and faceting.
   */
  tags?: string[];
  /**
   * URL where applicants submit or apply. Maps from Karma submissionUrl.
   */
  applicationUrl?: string | null;
  /**
   * Primary website for the opportunity or program.
   */
  website?: string | null;
  /**
   * URL of the program/organisation logo image.
   */
  logoUrl?: string | null;
  /**
   * URL of a banner/hero image.
   */
  bannerUrl?: string | null;
  socialLinks?: SocialLinks1;
  funding?: FundingEnvelope;
  /**
   * RFC 3339 timestamp when applications open. Maps from Karma metadata.startsAt.
   */
  opensAt?: string | null;
  /**
   * RFC 3339 application deadline. Maps from Karma deadline / metadata.endsAt. When this passes, status should transition to 'closed'.
   */
  closesAt?: string | null;
  /**
   * RFC 3339 timestamp when the opportunity was first publicly announced at the source.
   */
  postedAt?: string | null;
  /**
   * RFC 3339 timestamp when this entry was created in the Hub.
   */
  createdAt?: string | null;
  /**
   * RFC 3339 timestamp when this entry was last modified in the Hub.
   */
  updatedAt?: string | null;
  grant?: GrantDetails;
  hackathon?: HackathonDetails;
  bounty?: BountyDetails;
  accelerator?: AcceleratorDetails;
  vc_fund?: VCFundDetails;
  rfp?: RFPDetails;
  /**
   * Namespace for publisher- or integrator-specific data not covered by the standard. Keys SHOULD be namespaced (e.g. 'karma.programId'). Contents are not validated by this schema.
   */
  extensions?: {
    [k: string]: unknown;
  };
};

/**
 * The organisation issuing or hosting the opportunity.
 */
export interface Organization {
  /**
   * Display name of the organisation.
   */
  name: string;
  /**
   * Lowercase URL-safe identifier; also the organisation's namespace.
   */
  slug?: string | null;
  /**
   * Kind of issuing entity.
   */
  type?: "foundation" | "dao" | "company" | "protocol" | "program" | "individual" | "other" | null;
  /**
   * Short description of the organisation.
   */
  description?: string | null;
  website?: string | null;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  socialLinks?: SocialLinks;
  /**
   * Ethereum-family ecosystems the organisation operates in.
   */
  ecosystems?: string[];
}
export interface SocialLinks {
  twitter?: string | null;
  discord?: string | null;
  github?: string | null;
  telegram?: string | null;
  farcaster?: string | null;
  forum?: string | null;
  blog?: string | null;
}
/**
 * Provenance of this entry, including the canonical source URL and verification status. Required so every entry is traceable to an original posting.
 */
export interface Provenance {
  /**
   * Canonical URL of the original posting at the source. Anti-spam and verification jobs fetch this.
   */
  url: string;
  /**
   * Namespace (organisation slug) this entry was published under (e.g. 'filecoin'). T2 auto-approval requires the publishing account to be a member of this verified org. May differ from the issuing organization.
   */
  publisher?: string | null;
  /**
   * Who submitted or published this entry — a public handle, organisation slug, or 'community' for anonymous community submissions. The internal account identity is never exposed.
   */
  submittedBy?: string | null;
  /**
   * How this entry entered the Hub. 'karma_outbox' = pushed one-way from Karma program-manager edits (see DEV-439).
   */
  ingestedVia?: "publisher_api" | "submission" | "scrape" | "import" | "karma_outbox" | null;
  /**
   * Identifier of this opportunity in the source system (e.g. Karma programId).
   */
  originalId?: string | null;
  /**
   * Whether the entry's fields were verified against the source URL by the verification-assist job. null = not yet checked.
   */
  verifiedAgainstSource?: boolean | null;
  /**
   * RFC 3339 timestamp of the last source verification.
   */
  verifiedAt?: string | null;
  /**
   * IPFS or archived snapshot of the source at verification time.
   */
  snapshotUrl?: string | null;
}
/**
 * Social and community links.
 */
export interface SocialLinks1 {
  twitter?: string | null;
  discord?: string | null;
  github?: string | null;
  telegram?: string | null;
  farcaster?: string | null;
  forum?: string | null;
  blog?: string | null;
}
/**
 * Funding envelope for the opportunity (award sizes, total budget, currency).
 */
export interface FundingEnvelope {
  /**
   * ISO 4217 code or token symbol for the amounts below.
   */
  currency?: string | null;
  /**
   * Minimum individual award in major units.
   */
  minAward?: number | null;
  /**
   * Maximum individual award in major units.
   */
  maxAward?: number | null;
  /**
   * Total program budget in major units.
   */
  totalBudget?: number | null;
  /**
   * Amount distributed to date in major units.
   */
  amountDistributed?: number | null;
  /**
   * Number of awards/grants made to date.
   */
  awardsToDate?: number | null;
}
/**
 * Grant-specific fields. Present (possibly an empty object) when type is 'grant'.
 */
export interface GrantDetails {
  /**
   * How funds are allocated (e.g. retroactive public goods, proactive application, streaming, quadratic).
   */
  fundingMechanism?: "retroactive" | "proactive" | "streaming" | "quadratic" | "other" | null;
  /**
   * Whether disbursement is tied to milestones.
   */
  milestoneBased?: boolean | null;
  /**
   * Whether the program runs in recurring rounds/seasons.
   */
  recurring?: boolean | null;
}
/**
 * Hackathon-specific fields. Present when type is 'hackathon'.
 */
export interface HackathonDetails {
  startDate?: string | null;
  endDate?: string | null;
  /**
   * Physical location, or null for fully online.
   */
  location?: string | null;
  /**
   * Whether the event is (also) held online.
   */
  online?: boolean | null;
  tracks?: string[];
  prizes?: HackathonPrize[];
  registrationDeadline?: string | null;
  submissionDeadline?: string | null;
  teamSize?: TeamSizeRange;
}
export interface HackathonPrize {
  /**
   * Track this prize belongs to, if tracked.
   */
  track?: string | null;
  amount: number;
  currency: string;
}
export interface TeamSizeRange {
  min?: number | null;
  max?: number | null;
}
/**
 * Bounty-specific fields. Present when type is 'bounty'.
 */
export interface BountyDetails {
  reward: MonetaryAmount;
  difficulty?: "beginner" | "intermediate" | "advanced" | null;
  skills?: string[];
  /**
   * Platform hosting the bounty (e.g. 'Gitcoin', 'Layer3').
   */
  platform?: string | null;
}
export interface MonetaryAmount {
  /**
   * Amount in major units of the currency (e.g. 2000000 = 2,000,000 USD).
   */
  amount: number;
  /**
   * ISO 4217 fiat code (USD, EUR) or a token symbol (ETH, OP, USDC).
   */
  currency: string;
}
/**
 * Accelerator-specific fields. Present when type is 'accelerator'.
 */
export interface AcceleratorDetails {
  applicationDeadline?: string | null;
  programDurationWeeks?: number | null;
  batchSize?: number | null;
  /**
   * Equity taken, expressed as a string (e.g. '5%', 'none').
   */
  equity?: string | null;
  funding?: MonetaryAmount;
  stage?: "pre-seed" | "seed" | "series-a" | null;
  location?: string | null;
  online?: boolean | null;
}
/**
 * VC-fund-specific fields. Present when type is 'vc_fund'.
 */
export interface VCFundDetails {
  checkSize?: AmountRange;
  /**
   * Investment stages the fund participates in.
   */
  stages?: ("pre-seed" | "seed" | "series-a" | "series-b+" | "growth")[];
  /**
   * Investment thesis.
   */
  thesis?: string | null;
  portfolio?: string[];
  contactMethod?: "email" | "form" | "intro-only" | null;
  activelyInvesting?: boolean | null;
}
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
   * ISO 4217 code or token symbol.
   */
  currency?: string | null;
}
/**
 * RFP-specific fields. Present when type is 'rfp'.
 */
export interface RFPDetails {
  /**
   * Organisation issuing the RFP, if distinct from organization.name.
   */
  issuingOrganization?: string | null;
  budget?: MonetaryAmount;
  /**
   * Scope of work.
   */
  scope?: string | null;
  requirements?: string[];
  proposalDeadline?: string | null;
}
