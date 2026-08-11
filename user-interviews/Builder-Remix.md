# Remix

**Category:** Infra/dev tool


## Working Summary
Andrew framed Remix as an infra and dev-tool maintainer trying to keep public-goods tooling alive while web3 funding surfaces shift underfoot. Remix has found funding through relationships, EF matching support, ecosystem funding rounds, ecosystem partners, and occasional traditional foundation searches. The current pain is that those channels are brittle: programs pause, scopes change, teams move from DAO to foundation control, pages stay live after the grant path is dead, and applicants often only learn the real status through private follow-up.
For builders like Remix, the RFP Hub is valuable if it becomes a live opportunity and readiness layer, not just a listing site. Andrew wants alerts, profiles, sector tagging, eligibility clarity, real deadlines, prerequisites, reusable application history, and status feedback from other applicants. The core product theme is legibility: builders need to know what is live, what they are eligible for, what evidence they need, and how prior funded work can be validated without re-explaining it every time.

## Agenda Discussed

### Remix Context
Andrew has a long background in grants, funding, and program development from traditional NGO work, including water and agriculture projects funded by multilaterals, bilateral agencies, and large private foundations. That background gives him a reference point for mature grant systems, audited financials, indirect costs, eligibility registries, consortium formation, and formal reporting requirements.
Remix is a web3 onboarding and education tool with a global user base, including strong usage in India, Kenya, Nigeria, and the United States. Andrew described Remix as education-first, with expanding work around ZK, AI-assisted building, Remix Pro, LMS integrations, credit top-ups, agentic tooling, MCP connectors, and an Encode Club AI boot camp focused on use cases such as global resilience and health care.

### How Remix Finds Funding
Remix has relied heavily on existing ecosystem relationships. After spinning out, EF offered a fixed grant and a matching grant, which Remix used in pitches to partners. Funding channels included EF-connected opportunities, ecosystem funding rounds, and a deep-funding pilot.
Remix also watches ecosystem grants surfaced through aggregators. In one case, the fit appeared promising at first, then the program shifted toward more specific project-building work and away from tooling. Andrew has also looked outside web3 at large AI and cloud-provider programs, development-sector networks, regional development-bank funding, government-backed AI initiatives, and traditional foundation opportunities.
The actual discovery process is a mix of known relationships, newsletters, grant databases, and personal prospecting. It is not a stable marketplace.

### Where the Process Breaks Down
The biggest breakdown is live status. Andrew described grant programs with public pages and forms where it is unclear whether the program is active, paused, deprioritized, or only nominally open. Applicants may fill out a form, get redirected to another team, or discover through follow-up that priorities changed.
Examples included ecosystem programs where token price, organizational structure, or grant ownership changed the path after the conversation started. Some teams moved grant authority from DAO processes to foundations. Others paused programs or narrowed scope. Builders lose time because the public listing does not keep pace with the actual decision path.
The second breakdown is communication. Without a personal relationship, it is hard to know whether an application will be reviewed, whether the program is still funded, whether a listed scope is current, or whether the team is redirecting the applicant because there is no real fit.

### Ideal Weekly-Use Product
Andrew said alerts would be valuable if tied to a real profile and sector preferences. The hub should help builders find opportunities they would otherwise miss or find too late. It should also expose hidden prerequisites early. A listing that looks relevant may require a government sponsor, a sanctioned research institution, audited financials, a nonprofit entity, or a formal consortium. Builders need that before they start the application.
The platform should make timing legible. If a program is rolling in name but actually reviews in cycles, the listing should say that. If there is an ideal submission window, a hard deadline, a soft deadline, or a multi-month lead time for partnership formation, that belongs in the opportunity record.
Andrew also raised consortium formation as a product need. Some traditional grants require a practitioner, operator, research institution, government partner, or multistakeholder group. The hub could help builders understand which grants require those structures and possibly help those groups form.

### Fields That Matter
The most valuable listing fields for Remix are:
- Deadline, review cycle, and ideal submission timing.
- Rolling status, if applicable, with what rolling actually means.
- Budget range and funding source.
- Technical requirements and required integrations.
- Eligible applicant types: individual, registered organization, nonprofit, for-profit, consortium, government partner, or research institution.
- Whether audited financials are required.
- Required sponsor, partner, geography, jurisdiction, or government relationship.
- Milestone expectations, reporting cadence, grant length, and deliverable model.
- Whether the grant is public-goods support, scoped project funding, or matched funding.
- Sector, use case, geography, target market, and public-benefit rationale.
- Validation requirements: what evidence the builder needs to provide and how the funder will verify it.

### Builder Profile and Reusable Data
Andrew reacted positively to a persistent builder profile. He wants a clearinghouse where Remix can keep reusable history, qualifications, prior funded work, organizational details, and standard application material, then choose what to include in a specific application.
He described current platforms as repetitive. Builders often re-enter the same project, marketing, payout, and application details across multiple systems. A reusable profile could reduce burden if the builder controls what gets shared.
He was also open to contributing feedback back to the hub, such as whether a team responded, whether an opportunity appears dead, or whether an application path has changed. That feedback would be useful to other builders, especially when publisher teams are separate from one another inside the same brand family.

### Validation and Metrics
Andrew flagged a concrete risk with algorithmic or AI-mediated evaluation. Remix was hurt in a public-goods funding round because the metrics emphasized package downloads or repository activity, while Remix is primarily an online tool. That made its usage harder to validate through standard open-source metrics.
The lesson for RFP Hub is that validation rules need to handle different project shapes. Online tools, education platforms, infrastructure services, and integrations may not produce the same signals as packages or repos. If the hub supports validated builder profiles or funder attestations, it should be explicit about how each claim is verified and what proof path applies.
Andrew said Remix is now trying to make itself more discoverable and verifiable across registries and related systems. That could inform the hub's own approach to proofs, attestations, and external validation sources.

## Decisions / Tracker Read
- This is a builder interview for Remix.
- Archetype: infra/dev-tool maintainer, with a secondary nonprofit education and public-goods funding profile.
- Remix should be treated as a strong example of a builder whose value may be undercounted by repo-download or package-download metrics.
- Builder-side hub value is strongest around live status, eligibility clarity, timing, prerequisites, reusable profile data, and validation.
- Applicant contributed feedback is worth exploring, especially no response, program appears paused, scope changed, and wrong team signals.
- The hub should distinguish public grant pages from real current application paths.

## Research Implications
- Opportunity status needs more than open or closed. The data model should support active, paused, stale, shifted, rolling, cycle-based, and unclear states.
- Rolling opportunities need cycle metadata. Builders need to know when review actually happens.
- Eligibility should be structured enough to filter early: entity type, geography, nonprofit status, for-profit status, audited financials, sponsor needs, and consortium needs.
- Prerequisites deserve first-class fields. A builder should not discover a government sponsor requirement after starting the form.
- Builder profiles should be permissioned and reusable. Builders should be able to store standard qualifications and decide what travels with each application.
- The hub can collect applicant-side telemetry, but it needs careful framing. It should capture useful status signals without turning private rejections or one-off frustrations into public claims.
- Validation needs project-type awareness. Metrics for online tools, education platforms, and public-goods infrastructure must not assume package downloads are the main proof of use.
- Publisher and brand relationships need modeling. Parent-brand vs subsidiary splits, DAOs vs foundations, and other internal structures matter for routing.
- Matching grants and cofunding mechanisms should be represented. Remix found the EF match useful in partner pitches.
- Consortium-oriented grants may need a discovery workflow, not just a listing.

## Next Steps By Owner
- Mahesh: incorporate builder-profile reuse, opportunity status, review-cycle timing, and prerequisite fields into the schema pass.
- Mahesh: consider applicant-contributed status flags for no response, paused programs, scope changes, and wrong-team routing.
- Mahesh: design validation so online tools and education platforms are not penalized by package-download-centric metrics.
- Sov + Mahesh: include Remix in the infra/dev-tool maintainer archetype for the Milestone 1 research synthesis.
- Sov + Mahesh: share the August or September MVP with Andrew / Remix for reaction once there is a testable product surface.

## Open Questions
- What is the right public/private boundary for applicant-contributed feedback about stale or nonresponsive opportunities?
- Should the hub expose confidence levels for opportunity status based on publisher verification, applicant reports, and freshness?
- Can builder profiles support multiple affiliated organizations, such as a nonprofit education entity and a product or services entity?
- Which validation sources should count for online web tools where package downloads are not a good signal?
- How should the platform represent matching grants, partner cofunding, and informal ecosystem funding asks?
- Can consortium formation be supported in v1, or should v1 only expose consortium requirements?

## Sources
- Live call, 2026-07-09.