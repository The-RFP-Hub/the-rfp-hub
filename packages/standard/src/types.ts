// Curated public type surface for the RFP Hub Standard.
// The names below are the stable public API; the underlying interfaces are GENERATED
// from the JSON Schema in ./generated/opportunity.ts (never edit that file by hand).
import type {
  FundingEnvelope,
  AcceleratorDetails as GenAcceleratorDetails,
  AmountRange as GenAmountRange,
  BountyDetails as GenBountyDetails,
  Contact as GenContact,
  Deadline as GenDeadline,
  GrantDetails as GenGrantDetails,
  HackathonDetails as GenHackathonDetails,
  Milestone as GenMilestone,
  Organization as GenOrganization,
  Payout as GenPayout,
  Provenance as GenProvenance,
  RewardTier as GenRewardTier,
  SocialLink as GenSocialLink,
  HackathonPrize,
  RFPDetails,
  RFPHubOpportunity,
  TeamSizeRange,
  VCFundDetails,
} from "./generated/opportunity.js";

/** A funding opportunity conforming to the RFP Hub Standard. */
export type Opportunity = RFPHubOpportunity;

/** An RFC 3339 date-time in UTC, or null when unknown. */
export type Timestamp = string | null;

/** The six funding types. The same value appears as `fundingDetails.fundingType`, the tag of the details payload. */
export type FundingType = Opportunity["fundingType"];

/** The type-specific details payload: a discriminated union over the six detail shapes, tagged by `fundingType`. */
export type FundingDetails = Opportunity["fundingDetails"];
/** Public lifecycle status. */
export type OpportunityStatus = Opportunity["status"];
/** How an entry entered the Hub. */
export type IngestionMethod = NonNullable<GenProvenance["ingestedVia"]>;
/** Whether a deadline is a fixed point in time or an open-ended window. */
export type DeadlineType = GenDeadline["deadlineType"];

export type Organization = GenOrganization;
export type Contact = GenContact;
export type Provenance = GenProvenance;
export type Funding = FundingEnvelope;
export type SocialLink = GenSocialLink;
export type AmountRange = GenAmountRange;
export type Deadline = GenDeadline;
export type Milestone = GenMilestone;

export type GrantDetails = GenGrantDetails;
export type HackathonDetails = GenHackathonDetails;
/** One row of a bounty's payout table. */
export type RewardTier = GenRewardTier;

/** What a reward tier pays, tagged by the model that decides which amounts apply. */
export type Payout = GenPayout;

export type Prize = HackathonPrize;
export type TeamSize = TeamSizeRange;
export type BountyDetails = GenBountyDetails;
export type AcceleratorDetails = GenAcceleratorDetails;
export type VcFundDetails = VCFundDetails;
export type RfpDetails = RFPDetails;

/**
 * Map from a `fundingType` to the shape of `fundingDetails` on an opportunity of that type.
 *
 * The binding allOf makes this a guarantee rather than an expectation: `fundingDetails`
 * always carries the shape the top-level `fundingType` names, and its own tag agrees.
 */
export interface DetailsByFundingType {
  grant: GrantDetails;
  hackathon: HackathonDetails;
  bounty: BountyDetails;
  accelerator: AcceleratorDetails;
  vc_fund: VcFundDetails;
  rfp: RfpDetails;
}
