# My Answers: Uniswap Foundation (publisher)

_Part of: Sov's Answers for RFP_

Hat: Grants Manager at the Uniswap Foundation. I also watched this program from the outside first: I published an independent breakdown of the Uniswap Grants Program in June 2022, while running a grants tracking database, before I ever worked here. All figures on this page are published program data.
Sov's answers to the M1 publisher questions, from the UF seat.

## The program in brief, 2020 to now
- Dec 2020: Jesse Walden (Variant) and Ken Ng propose the Uniswap Grants Program, the first successful governance proposal on Uniswap. Applications open Jan 15, 2021. (UGP proposal, gov forum · Crypto Briefing)
- UGP era, 2021 to 2022: a six person committee (lead plus five reviewers) on a 4 of 6 multisig, six month terms renewed by governance, capped at $750K per quarter, deployed in waves. About $7M across 120+ grants; applications via unigrants.org and Discord; tracked publicly on Notion. (UGP proposal, gov forum · UF creation proposal, UGP addendum)
- Aug 2022: governance approves the creation of the Uniswap Foundation and UGP's work institutionalizes into it. The first Foundation year commits $5.6M across 99 grants, average award $20K to $50K. (UF creation proposal, gov forum · UF grants strategy post, Feb 2024)
- Feb 2024: strategy reset toward fewer, larger, longer term grants ($250K and up), with $30M to allocate over two years. (UF grants strategy post, Feb 2024 · Initial funding proposal, Agora)
- 2024 to 2025 buildout: Hook Incubator run by Atrium Academy ($600K, then a $1.2M expansion; 1,200+ applicants, 400+ developers onboarded), OpenZeppelin's v4 hooks library ($850K), the UF Security Fund operated by Areta ($1.2M, subsidizing up to 100% of v4 hook audits across 16 providers), Unichain builder programs (180+ teams onboarded), incentive research with Gauntlet, and a 7.59M UNI governance deposit to an Aera vault for Unichain and v4 liquidity. Governance approved a further $25.1M budget in Mar 2025. (UF blog: $1.2M Hook Incubator expansion · UF blog: Security Fund recipients · Uniswap Unleashed, gov forum)
- FY2025: $26M committed, $11M disbursed, $85.8M in assets at year end, $106.2M authorized as grants budget ($87.5M to commit, $18.7M reserved against prior commitments). (FY2025 financials, gov forum · CoinDesk)
- Dec 26, 2025, UNIfication: protocol fees on, UNI burns, ecosystem activities consolidate toward Uniswap Labs. The Foundation keeps a small dedicated grants team, honors every existing commitment, deploys the remaining ~$100M grants budget consistent with its mission, and requests no further funds from governance. Future ecosystem funding beyond that comes from a 20M UNI annual growth budget under Labs, vesting from Jan 1, 2026. (UNIfication proposal, gov forum · UF blog: UNIfication)

## Core questions
1. How do you currently publish / find / index funding opportunities? Tools, cadence.
Two motions, and the split matters. Most UF funding is sourced from ecosystem priorities: we identify gaps, then find teams through relationships, referrals, current grantees, and prior execution across the wider Ethereum ecosystem. Open applications exist, but mostly through specific programs and operators.
UF currently runs five lanes: Ecosystem, Governance, Community and Events, Security, and Research and Implementation. It also operates parallel but overlapping pipelines for Foundation grants and Unichain-related grants. They have separate tracking surfaces and eligibility paths, but applicants often experience them as one Uniswap funding surface.
For incoming grants through the open form, publishing is fragmented across the Foundation site, blog posts, governance forum updates, and operator-specific forms like Atrium for hooks or Areta for security. The operational cadence for that inbound surface is rolling intake, daily first-pass review, quarterly financial reporting, and quarterly KPI / impact collection.
Most sourced grants work differently: we reach out directly to qualified builders from a pipeline of teams we already prefer to work with, based on fit, prior execution, and demonstrated success in adjacent areas across Ethereum. That keeps review time focused and quality high. For a hub, the key issue is that the public surface only shows the inbound part of a broader funding system.
2. Where does that process break down? What costs the most time?
There are two different failure modes: sourced grants depend on finding enough qualified builders before we need them, while open-form grants create review drag through bad fit, duplication, and verification.
The first constraint is sourcing quality. For the grants UF wants to make, the hard part is finding grantees with the right fit, proof of execution, and a track record in adjacent areas across Ethereum. We need a pipeline of teams that have already shown they can ship in comparable contexts.
Bad intake is the next cost. Many open-form applications are ineligible on arrival: retroactive asks, standalone audits, incentive campaigns, or consulting work. Each one still takes time to review and redirect.
Deduplication is a parallel drain. The same team may apply across UF and Unichain with different project names, different ask amounts, and overlapping scopes. We currently catch cross-pipeline duplicates manually, often only after both reviews have already run.
Verification is the last sink. We still have to confirm traction across the repo, site, team, and on-chain activity. Some of this is already automated on our side: deployment checks, event activity, cross-chain address checks, and GitHub validation all run before human review. The inefficiency is that we still do this per application. A hub could move part of that diligence upstream, so applicants and listings arrive pre-verified.
3. What information is most often missing or wrong?
There are two categories: application-side gaps and listing-side drift.
On the application side, the missing pieces are usually basic but material: named team or verifiable team history, milestone-tied budget, realistic timeline, evidence of traction, and proof that the ask fits the scope.
The execution-risk problem is bigger than anonymity. A pseudonymous team with a track record can be diligenceable; a team with no prior deployments, no GitHub trail, no on-chain footprint, and no reputation signal is not. A hub should require at least one verifiable proof of execution.
The most misleading fields are vanity metrics: pool counts, raw swap counts, inflated TVL, and self-priced token liquidity. We have seen this pattern repeatedly, including reported TVL inflated roughly 750x versus quote-asset reality. A hub that accepts unqualified TVL will inherit that distortion.
On the listing side, the common failure is drift. Third-party mirrors keep advertising small open grants, retroactive routes, or old intake paths after the program has changed. That stale shape creates ineligible applications before the applicant ever reaches us.
4. What would a neutral, open hub need to do for us to use it weekly?
It would need to reduce triage, not just publish opportunities.
First: structured eligibility and exclusions, including redirect routes. Builders should know before applying whether something belongs in UF grants, the Security Fund, incentives, or nowhere.
Second: duplicate-application signals across programs. If a team has already applied to UF, Unichain, or an operator program, reviewers should see that.
Third: lifecycle status. "Active" is not enough. A hub needs to show whether a program is open, sourced-only, restructured, winding down, or replaced by a successor.
Fourth: stable intake routes. Forms move and operators change. The hub should own the canonical pointer while publishers update the destination.
Fifth: structured application routing. A builder should be able to submit once, and the hub should route them to the right program, operator, or redirect path based on structured eligibility and exclusions. For UF, that would make the hub a triage layer, not a directory.
The concrete version of what UF does not fund, with redirect routes baked in — and most of these are redirects, not rejections:
5. Which fields actually matter in a listing?
The listing should be a routing object, not just a description.
Eligibility comes first: who should apply, who should not, and where excluded applicants should go instead. The exclusions table above should be schema, not supporting prose. If a builder is asking for retroactive funding, a standalone audit, incentives, consulting, or infra / SaaS support, the listing should route them before they enter the wrong intake path.
Then the basic operating fields: category, budget range, milestone expectations, decision timeline, contact route, lifecycle status, and expected reporting cadence. Cadence can be monthly, quarterly, or ad hoc; it sets expectations and helps the hub surface stale programs or grants.
Grant type should be structured too: Grant, Program, Infra (mostly Unichain Partnerships), Incentives (again mostly on Unichain). These are different operating models with different lifecycles, tracking needs, and closeout criteria. A hub that collapses them all into "grant" will misrepresent how UF funds work.
Two distinctions matter for accuracy. Separate funder from operator: UF may fund a program while Atrium or Areta runs intake. Separate committed, disbursed, and delivered: a signed grant is not the same as money paid or work completed.
Verification fields should be structured: contract addresses, deployed chain, repo URL, team identities, and proof of prior execution. Those are what let downstream reviewers verify quickly instead of rebuilding diligence every time.
6. Would you contribute data back?
Yes, especially status, corrections, closeout state, verification fields, and quarterly outcomes. We already maintain much of this internally and publish financials externally, so the right integration would be a push, not a new reporting workflow.
Our pipeline status lives in Notion, milestone tracking in Airtable, and deals in HubSpot. A hub that accepts API pushes or webhooks from those systems would get live data without creating another manual reporting surface.
Duplicate-application flags would be valuable in both directions. We would treat this as an integration, not a listing, and contribute schema feedback from real pipeline operations.

## Publisher tail
What would make you publish directly to the hub?
A listing format that encodes the rules and redirects, so misrouted applicants never land in intake. One API push beats maintaining another page — our data already lives in a pipeline, our milestones in Airtable, and our deals in a CRM, so an integration pushes from systems we keep current anyway rather than a hand-maintained listing. Post-UNIfication there is an extra reason: as programs consolidate, a neutral hub is where continuity of record should live. That is not abstract: the program is explicitly winding toward a small team deploying a finite remaining budget, so where the authoritative record lives as functions consolidate is a real, dated question.
What would a verified publisher need to include?
Governance and financial proof, all public today: the creation and budget votes on chain, quarterly financials on the governance forum, the foundation entity. Plus category owners and published criteria. Verification should also capture operator relationships, so builders know an Atrium or Areta intake form is legitimate UF funded infrastructure. The verified badge should certify the exclusions too, that is where the time savings live.

---

## The spec these answers imply
If it is useful, the one-screen version of what everything above asks a hub to build:
- A listing status model with at least three lifecycle states: open, sourced-only, restructured, winding-down, successor. "Active" is too blunt.
- Structured exclusions and redirect targets as first-class enums, not prose.
- A structured grant type taxonomy: Grant, Program, Infra, Incentives.
- A structured reporting cadence field, so stale grants and programs can surface as signals.
- Separate funder and operator entities (UF funds; Atrium and Areta operate).
- Distinct committed / disbursed / delivered fields, not one "funded" amount.
- A cross-program duplication signal for applicants.
- A verified-publisher proof that certifies the exclusions, not just the entity.
- Stable canonical intake routes: the hub owns the pointer, the publisher updates the destination.
- Structured verification fields (contract, chain, repo, team) so a listing arrives pre-verified, not re-verified by every funder downstream.
Underneath all of it: both sides of this market are going agent-assisted. Our review already is; applicants increasingly are. If the hub is designed for human readability first and machine-readability as a bonus, it will be behind on day one.