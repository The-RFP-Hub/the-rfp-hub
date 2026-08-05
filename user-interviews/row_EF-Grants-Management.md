# EF Grants Management

**Category:** Publisher


## Working Summary
Boris framed the RFP Hub's value for EF around distribution, quality, and ecosystem visibility. EF already has mature Salesforce-backed grants infrastructure, so the hub is most useful if it becomes a low-maintenance syndication and discovery layer. EF keeps its internal source of truth, but its RFPs and wishlists automatically reach more qualified builders in a neutral place.
The biggest publisher-side need is not another intake system. It is better reach to the right applicants, a clearer view of what other funders are trying to support, and a way to notice where open opportunities are missing relevant communities before the application window closes.

## Agenda Discussed

### Project Context
Sov opened with the RFP Hub origin story: the work grew out of prior grant registry work and ongoing EF conversations about funding discoverability. Mahesh positioned the interview as part of Milestone 1 research, with interviews across publishers, builders, services teams, and aggregators feeding the schema, data model, and implementation plan.

### EF's Current Publishing Model
EF moved from a reactive open-grants program toward a proactive RFP and wishlist model after open intake became too noisy. Boris said EF was seeing dozens of applications per week in 2025, with AI lowering the barrier for shallow or internally inconsistent proposals.
RFPs and wishlists live in Salesforce. The EF website pulls opportunity data from Salesforce, and submitted applications become Salesforce opportunities tied back to the relevant RFP or wishlist item. Internal EF teams surface needs, grants management helps write the item, and applications route through grants management plus domain experts.

### Application Lifecycle
EF separates applications from grants. Applications start as new submissions, then pass through grants-management screening and domain-expert review. Grants management often removes at least half of submissions as poor fits, then prepares a smaller list, often 10 to 15 promising applications, for domain experts.
After domain review, EF may pick one awardee or multiple awardees depending on the item. Once an application becomes a grant, it moves into finance, admin, and legal workflows: cost center, budget owner, grant evaluator, approvals, KYC/KYB, documentation, and then active grant execution.

### RFPs, Wishlists, and Fields
Boris described RFPs as tightly scoped opportunities where EF knows the desired project and requirements. Wishlists are looser conversation starters. RFPs use hard requirements and soft requirements. Wishlists may rely more on title, description, and out-of-scope or negative-filtering text.
On the backend, RFPs and wishlists share common properties such as title and application window dates, but they differ in some fields. Hard requirements and soft requirements are separate free-text fields. Boris said the item properties have been stable since launch, though the requirements format can be awkward for community or less technical initiatives. EF uses resource links as a fallback when the field structure cannot carry enough context.

### Where the Process Costs Time
The proactive model creates review batching. EF needs to leave applications open long enough for people to understand the opportunity and apply, but many strong applicants, especially academic applicants, may submit near the deadline. That means early submitters wait, and real evaluation often cannot happen until the window closes.
EF also lacks a clean view of which audiences an RFP reached before submission. Boris said EF does not analyze visitor-level website traffic for values-alignment reasons. Once someone submits, EF tracks application volume, stage, rejection, award, spend, and status, but pre-submission reach is harder to see.
The operational gap is active monitoring during the application window. If an RFP is not getting applicants from a target geography or community, EF may need to manually route it to the right groups. Boris gave Latin America as an example of a region where EF might notice low response and then push the opportunity through relevant communities.

### What Would Make the Hub Useful
For EF, the hub would be valuable if it sends RFPs and wishlists to relevant builders without creating a new manual publishing burden. Boris said EF would still use a manual process if necessary, but would be much happier with a setup that takes one to two weeks and then runs automatically.
The ideal outcome is set it and forget it: EF continues operating in Salesforce, and all eligible funding opportunities flow into the RFP Hub where builders, contributors, and aggregators already look.

## Decisions / Tracker Read
- This is a publisher interview for EF Grants Management.
- EF should be treated as a mature publisher with its own source of truth, not as a team looking for an end-to-end grants management product.
- The schema needs to represent at least two EF listing types: tightly scoped RFPs and looser wishlists.
- The schema should support hard requirements, soft requirements, out-of-scope filters, application windows, resource links, and listing-level provenance.
- EF can share item-level schema or field structure, but not applications or applicant PII.
- RFP Hub adoption for EF depends on low-lift integration and distribution value, not replacing Salesforce.
- A prospective follow-on RFP source is in early conversation; Boris expected to have more input after an upcoming call.

## Research Implications
- Publisher onboarding should support bring your own system of record. The hub should ingest or sync from Salesforce-like systems instead of forcing mature publishers to use a new dashboard.
- The hub's core publisher promise should be distribution to qualified applicants, not just cleaner public listings.
- Field design should allow structured enough comparison without forcing every opportunity into a rigid template.
- Wishlists deserve first-class support. They are different from RFPs because they invite conversation, not only execution against a defined spec.
- Analytics should respect publishers that avoid visitor-level tracking. Useful feedback can come from submissions, stages, source tags, and community coverage rather than personal tracking.
- Builder alerts need relevance without creepy segmentation. Skill tags, ecosystems, geography, and self-selected interests may be safer than publisher-side profiling.

## Next Steps By Owner
- Boris: send Mahesh a screenshot or field view of the Salesforce properties for RFP and wishlist items by end of day, excluding applications and PII.
- Sov: follow up on the prospective RFP-source conversation and schedule a deeper discussion if there is a real fit.
- Mahesh: fold EF's RFP-vs-wishlist split, hard/soft requirements, and resource-link fallback into the schema/data-model pass.
- Sov + Mahesh: include EF's set-it-and-forget-it adoption requirement in the Milestone 1 research synthesis.

## Open Questions
- What is EF's exact current field list for RFP and wishlist items?
- Can RFP Hub ingest from Salesforce directly, or should v1 start with a lighter export/sync path?
- What is the cleanest privacy-aligned way to show publishers whether an opportunity reached the right audiences?

## Sources
- Local note: call-notes/2026-07-09-ef-grants-management-boris.md
- Work Tracker row: EF Grants Management