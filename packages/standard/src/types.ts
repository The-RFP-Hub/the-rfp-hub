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
  MonetaryAmount as GenMonetaryAmount,
  Organization as GenOrganization,
  Provenance as GenProvenance,
  SocialLinks as GenSocialLinks,
  HackathonPrize,
  RFPDetails,
  RFPHubOpportunity,
  TeamSizeRange,
  VCFundDetails,
} from "./generated/opportunity.js";

/** A funding opportunity conforming to the RFP Hub Standard. */
export type Opportunity = RFPHubOpportunity;

/** The six funding types. The value is also the key of the opportunity's type block. */
export type FundingType = Opportunity["fundingType"];
/** Public lifecycle status. */
export type OpportunityStatus = Opportunity["status"];
/** How an entry entered the Hub. */
export type IngestionMethod = NonNullable<GenProvenance["ingestedVia"]>;
/** Whether a deadline is a fixed point in time or an open-ended window. */
export type DeadlineType = GenDeadline["type"];

export type Organization = GenOrganization;
export type Contact = GenContact;
export type Provenance = GenProvenance;
export type Funding = FundingEnvelope;
export type SocialLinks = GenSocialLinks;
export type MonetaryAmount = GenMonetaryAmount;
export type AmountRange = GenAmountRange;
export type Deadline = GenDeadline;
export type Milestone = GenMilestone;

export type GrantDetails = GenGrantDetails;
export type HackathonDetails = GenHackathonDetails;
export type Prize = HackathonPrize;
export type TeamSize = TeamSizeRange;
export type BountyDetails = GenBountyDetails;
export type AcceleratorDetails = GenAcceleratorDetails;
export type VcFundDetails = VCFundDetails;
export type RfpDetails = RFPDetails;

/**
 * Map from a `fundingType` to the shape of `opportunity[fundingType]`.
 *
 * The re-cut makes this a guarantee rather than an expectation: the matching block is
 * required AND every non-matching block is forbidden, so a record can never carry two.
 */
export interface DetailsByFundingType {
  grant: GrantDetails;
  hackathon: HackathonDetails;
  bounty: BountyDetails;
  accelerator: AcceleratorDetails;
  vc_fund: VcFundDetails;
  rfp: RfpDetails;
}
