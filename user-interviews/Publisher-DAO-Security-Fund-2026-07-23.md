# DAO Security Fund — Publisher Interview 2026-07-23

**Date:** 2026-07-23

**Participants:** Griff (lead, DAO Security Fund) · Mahesh Murthy · Sov

**Category:** Publisher (EF referral slate)

**Format:** Ran as a two-way partnership exploration rather than a scripted interview. Griff came to show what DAO Security Fund is building; Sov and Mahesh reframed on the call and jammed on where the two systems fit together. Strong publisher-side signal came out of it anyway.

## What DAO Security Fund is building

Griff is standing up his own RFP platform to crowdfund security work for the Ethereum ecosystem, security-scoped only. It mixes RFPs and grants. Example RFP: an off-cycle ratings coalition to build and maintain an "L2BEAT for OPSEC," a rating agency for operational security that gives OPSEC auditors leverage to make teams actually implement recommendations (buy team laptops, run EDR like CrowdStrike). Example grant: end-to-end formal verification of the Vyper compiler, routed to the Vyper Foundation as the natural home for the work.

Approved at the curator meeting on 2026-07-22 to go this route; fundraising starts now. The site is not yet live; it stays gated until a few RFPs are validated and partially funded. Funds sent in are treated as donations to the DAO Security Fund. Allocation is voted by ~200 Ethereum security badge holders; Devcon India (Oct/Nov) is the intended launch pad.

## Publisher signal

**How they publish / co-funding model.** The distinctive mechanic is crowdfunding by pledge, not upfront donation. ~95% of money comes from pledges: a cornerstone funder commits, then co-funders sign a letter of intent to kick in $X if the RFP reaches full funding, with their logo shown as sponsor. Sov mapped this to the ESP pattern used to fund Argot, Remix, and others (conditional match confirmed by an LOI on the ES forum). A community-donation layer sits on top for matching. Griff only wants to complete RFPs that already show partial market funding.

**What would make them publish and keep listings current.** Griff was blunt that the motivation is practical: (1) sourcing co-funders — if the hub actually finds funders for his RFPs he will keep it current — and (2) marketing and awareness: DAO Security Fund needs reach, so if the hub has real traction and inherent value they use it, and if the value is not there they will not. He floated a novel maintenance mechanism: platform free, but publishers post a refundable deposit and bleed it slowly if they let listings go stale. "Fear of loss is a hell of a motivator." Directly relevant to the freshness-kills-trust finding and Cornaro's maintenance concern.

**Integration / API.** Landed on the hub pulling security RFPs from DAO Security Fund once the platform is live, rather than DSF adopting the team's grants-management software (Griff was straight that he can build custom and coordination cost is the deciding factor). Griff is fully open to exposing whatever endpoints the hub specs, "tell my Fireflies notetaker what you want in an API and my agent will make it happen." He sent his OPSEC RFP template on Telegram to inform the spec. Constraint he raised: pulling qualitative co-funded RFPs only works if both sides align tightly on the data format. Resolution: Mahesh finalizes the RFP spec this week, reconciles it against Griff's template, and sends Griff the one shared standard to follow. Single source of truth is the ideal.

**RFP-as-signal + the scale-up thesis.** Sov raised the recurring services-firm finding that an RFP you did not help write is a weak signal (you become "quote fodder"; an over-specified RFP means the funder should just pick the team). Griff's most valuable use of the hub is the inverse: find projects already doing siloed security work (e.g. a major protocol's security initiative) and broaden the scope so the whole ecosystem co-funds and benefits. His framing is Ethereum as an apartment building, cameras in the whole building cost little more than one unit and make everyone, including that protocol, safer. Finding those scale-up candidates through the hub would be a major win for him; he conceded it is a rare situation.

**Public-goods framing.** Griff deliberately avoids the term "public goods" (reads as charity, kills buy-in) and reframes as shared security and the apartment building. Sov aligned on funding cross-ecosystem alliances that share burden and reward over siloed per-team grants, noting the decline in public-goods funding across the ecosystem.

## Cross-interview convergence

Third-plus signal that co-funding is a real publisher need; Mahesh noted he has now heard it from several people and the team may build a co-funding feature in V1. Nuance from earlier publisher conversations: co-funding is mostly behind-the-scenes shepherding, not website donations, which matches Griff's pledge/LOI model. Reinforces freshness-and-trust (the deposit-to-maintain idea) and relationships-over-transactions (scale-up-existing-work over cold RFPs).