// Curated public type surface for the RFP Hub Standard.
// The names below are the stable public API; the underlying interfaces are GENERATED
// from the JSON Schema in ./generated/opportunity.ts (never edit that file by hand).
import type {
  FundingEnvelope,
  AcceleratorDetails as GenAcceleratorDetails,
  AmountRange as GenAmountRange,
  BountyDetails as GenBountyDetails,
  GrantDetails as GenGrantDetails,
  HackathonDetails as GenHackathonDetails,
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

/** The six opportunity types. */
export type OpportunityType = Opportunity["type"];
/** Public lifecycle status. */
export type OpportunityStatus = Opportunity["status"];
/** How an entry entered the Hub. */
export type IngestionMethod = NonNullable<GenProvenance["ingestedVia"]>;

export type Organization = GenOrganization;
export type Provenance = GenProvenance;
export type Funding = FundingEnvelope;
export type SocialLinks = GenSocialLinks;
export type MonetaryAmount = GenMonetaryAmount;
export type AmountRange = GenAmountRange;

export type GrantDetails = GenGrantDetails;
export type HackathonDetails = GenHackathonDetails;
export type Prize = HackathonPrize;
export type TeamSize = TeamSizeRange;
export type BountyDetails = GenBountyDetails;
export type AcceleratorDetails = GenAcceleratorDetails;
export type VcFundDetails = VCFundDetails;
export type RfpDetails = RFPDetails;

/** Map from an opportunity `type` to the shape of `opportunity[type]`. */
export interface DetailsByType {
  grant: GrantDetails;
  hackathon: HackathonDetails;
  bounty: BountyDetails;
  accelerator: AcceleratorDetails;
  vc_fund: VcFundDetails;
  rfp: RfpDetails;
}
