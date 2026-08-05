# BlockchainGov — Researcher Interview 2026-07-30

**Date:** 2026-07-30

**Format:** Async written answers, duplicate-and-return path (same route as Cornaro and Cap)

**Turnaround:** sent 13:10 UTC, returned 22:31 UTC. Same day.

**Respondent:** Sofia Cossar, PhD candidate in legal theory and legal tech, Université Paris-Panthéon-Assas (Paris II); core researcher, BlockchainGov (ERC-funded, CERSA/CNRS, dir. Primavera De Filippi)

**Source:** EF referral. Same lab as Tara Merk, frequent co-author.

**Archetype:** Researcher — first completed in the archetype. Code/governance intersection, not tokenomics.

**Attendees:** async, none. Mahesh cc'd on both messages.

---

## Headline: the first respondent for whom discovery is actually broken

Every builder in the sample said discovery is not the bottleneck. Cactus and CoBuilders said scoping is. Revoke said big programs arrive passively via Twitter and are "hard to miss." Cap said verification and fit beat discovery. Argot said discovery is pure relationships and works fine because a couple of large funders act as a de facto hub.

Sofia is the counterexample, and she is the first:

> "I do not use a dedicated tool, network, or channel to search systematically for funded research opportunities. Most opportunities are shared with me directly by colleagues or other people in my academic network. Consequently, my search is relatively informal and occasional."
> 

She names the failure mode directly: reliance on personal contacts makes discovery unsystematic, and she "may not learn about relevant opportunities in time to apply."

This does not overturn finding #1 of the report. It sharpens it. The finding is that **discovery is not the bottleneck for people already inside the network the funding flows through.** Every prior respondent was a crypto-native builder sitting inside that network. Sofia sits outside it, in an academic one, and for her the network does not deliver. The report should carry both halves; right now it only carries the insider half, and the sample composition explains why: the interviews found people the system had already found.

Argot's answer is the bridge. Argot also described discovery as pure relationships with zero tooling, but was fine, because large funders function as their hub. Same mechanism, opposite outcome, depending on whether you are inside the relevant network.

## Second headline: she inverts the interface consensus

Asked to rank website, alerts, and agent/API:

1. **Website first.** "A central place to search, filter, verify, and compare opportunities."
2. **Customizable alerts second**, matched to research interests and eligibility.
3. **Agent/API third**, for automating searches or integrating into other research workflows.

Direct inversion of Cap (API/agent first, alerts second, website last, "won't visit a dashboard"), and it cuts against Cactus (agent/API plus alerts) and Jon Ruth (structured registry for agents, Telegram a bad agent interface).

The reason she gives matters more than the ranking. She wants to **compare** opportunities against each other before committing, which is a surface task, not a feed task. Alerts and agents push one item at a time; a website lets you hold six side by side and rank them. That is what her application decision actually requires, because she is choosing where to spend months of research time rather than scanning for a fit.

Combined with Revoke ("just me typing into a box," no automations), the agent-first thesis now has two dissenters among respondents asked directly. Worth flagging that the API-first consensus came disproportionately from infra and services people whose work is already programmatic.

## Third: an entire evaluation axis no builder raised

Publication terms, open data, IP, attribution, academic independence. No builder mentioned any of these. For her they are go/no-go:

- Prefers opportunities supporting open research with openly publishable findings
- Clear attribution and preserved academic independence both material
- **Restrictive IP provisions or publication limits reduce interest to the point of not applying**
- Supports open data in principle, but sharing requirements must stay compatible with research ethics, privacy, confidentiality, and legal obligations

For a CC0-data, MIT-code hub this is mostly good news, but the schema needs fields for it. A researcher cannot assess an RFP without knowing publication and IP terms, and today they are usually absent from listings entirely.

## Fields: what she ranked, and where it agrees

Asked which fields actually matter, in order:

1. Eligibility
2. Evaluation criteria
3. Budget
4. Research question
5. Scope
6. Deadline
7. Deliverables
8. Methodology constraints
9. Selection timetable
10. Publication requirements
11. IP / licensing terms
12. Contact information

**Eligibility first matches Cap exactly** (his #1 of four fields that matter). Two archetypes, same top field, arrived at independently.

**Evaluation criteria at #2 is new.** No builder ranked it at all. Researchers are asking how proposals get judged, a question builders either do not ask or answer through relationships instead. Publisher-side implication: publishing the rubric is cheap and would materially change who applies.

**Contact information ranked last**, contradicting Revoke (contacts = hardest missing field) and Cap (wants a human or AI contact to ping). Not a conflict to resolve, a real archetype difference: builders want to open a conversation, academics want to read the terms and decide alone.

## Selection timetable: a genuinely new required field

Raised three separate times, unprompted by any single question. She needs to know **when the decision lands and when the funded work starts**, not just when applications close.

> "It may also be difficult to determine when applicants will receive a decision and when the funded work is expected to begin."
> 

No builder asked for this. The reason is structural: an academic coordinates against teaching loads, existing grants, and fixed institutional calendars, so an unknown start date makes the opportunity unplannable even if everything else fits. Deadline is the only temporal field the current schema treats as first-class. Decision date and start date should join it.

## Status lifecycle: second independent hit, most granular version yet

Asked what a neutral hub would need for her to use it regularly, she led with status and gave the fullest taxonomy anyone has:

> "forthcoming, open, closed, extended, under review, or already awarded"
> 

Cornaro named dedup plus status-lifecycle as their top pain. Cap named "is it active" as the most-wrong field. Revoke named dead programs with forms still open. Jon Ruth reframed it as agents returning closed rounds. Sofia is the fifth hit on staleness and the first to name **forthcoming**, **extended**, **under review**, and **awarded** as distinct states.

Forthcoming and awarded are the two the hub does not currently model. Forthcoming lets people plan toward a call. Awarded is the input to the knowledge-graph product Jon Ruth proposed, since who won is what makes institutional memory possible.

## Budget proportionality: third independent hit

What immediately kills interest includes "the funding were disproportionate to the work required."

Third independent arrival at budget honesty, after Cap (headline 100k that caps at 2k, wants the true range) and Jon Ruth ("$10 million, they're giving away 5,000 at a time"). Three archetypes, three framings, same requirement: **per-award size, stated honestly, separate from program budget.** Now the most cross-validated schema recommendation in the sample; should be required, not optional.

## Listings score 4 out of 10

First numeric rating anyone has given. On how well listings define the research question, expected outputs, review process, and standards of evidence:

> "Around 4. Listings often provide a general description of the topic and expected outputs, but the precise research question, review process, evaluation criteria, and expected standards of evidence are frequently underdeveloped or unclear."
> 

Mirror image of Cactus's complaint. Cactus flagged **overspecified** RFPs as a failure mode alongside underspecified ones; Sofia sees only underspecification. Plausible read: publishers overspecify engineering work they think they understand and underspecify research they do not.

## Cross-border eligibility

> "I have applied only within the EU while holding an EU passport. I believe problems would arise when applying abroad."
> 

Has applied both as an individual and through a research group with no coordination problems, but flags jurisdiction as the expected break. For a global hub this is a schema question: eligibility is not one field, it is jurisdiction, entity type, and institutional affiliation, and the hub will misinform people if it flattens them.

## Contribution back

Willing to submit opportunities, suggest corrections, and flag stale listings, conditional on:

- The process being **very quick**
- Confidence the platform genuinely benefits the research community
- **Contributions actually being reviewed and used**

Sits between Cap (contributes freely, no incentive needed) and Cornaro (contributes only as a named, credited data partner). Sofia wants neither payment nor credit, she wants evidence the correction landed. Same acknowledgement requirement Cornaro specified in API terms (correction write path with ack), arriving from a different direction.

## What she funds-hunts for

Academic research on emerging technologies, law, political science, institutional theory. Interdisciplinary. Funders: universities, public research agencies, research foundations, civil-society organizations, and institutions working on emerging tech and its social, legal, and political implications.

Worth noting for hub scope: **most of her funding universe is not crypto.** A researcher-serving hub that only indexes web3 RFPs covers a fraction of where she actually looks, which caps how regularly she would use it. Cornaro's unique EU CORDIS coverage is the adjacent datapoint. If researchers are a real user segment, the coverage question extends past crypto.

## Decision criteria, verbatim structure

Assesses in this order: alignment with research interests and expertise → eligibility → feasibility → time required to prepare the application → funding available → expected outputs → degree of academic independence.

Immediate kills: scope unrelated to expertise, eligibility excludes her, unrealistic timetable or deliverables, funding disproportionate to work, unclear publication/IP/independence conditions.

**Application preparation cost appears as a first-class filter**, fourth in her sequence. Cap named unnecessarily long applications and milestone-based budget breakdowns as his biggest turn-offs. Second hit on application-side friction as a determinant of whether people apply at all, not just whether they win.

---

## Report implications

1. **Qualify finding #1.** Discovery is not the bottleneck *for insiders*. Sofia is the inside-vs-outside control case and makes the sample-composition bias explicit rather than a caveat.
2. **Per-award budget honesty is now the strongest schema rec in the sample.** Three independent archetypes. Make it required.
3. **Add decision date and start date** to the temporal fields. Researcher-specific, structurally motivated, currently invisible.
4. **Extend the status enum** to forthcoming and awarded. Fifth staleness hit, first to model pre-open and post-award.
5. **Add publication, IP, licensing, and independence fields.** Entire axis, go/no-go for an archetype, absent from listings today.
6. **Publish evaluation criteria.** Ranked #2 by a researcher, ranked by no builder. Cheap for publishers.
7. **The API-first consensus is not universal.** Two dissenters now (Revoke, Sofia). Comparison is a surface task and feeds do not serve it.
8. **Eligibility is not one field.** Jurisdiction, entity type, affiliation.

## Caveats for weighting

- **Not a crypto-native applicant.** Her funding universe is largely academic and EU public. She engages the crypto world through BlockchainGov and an EF-co-organized residency, but is not applying to chain grant programs. Her answers describe academic research funding with web3 as one venue among several.
- Async written, so no follow-up probing and no ability to push on the interface ranking, which is the answer most worth interrogating.
- She won a JUST Open Source Stiftung grant (April 2026, €20k, full competitive RFP process), so the application mechanics she describes are recent and lived, not hypothetical.