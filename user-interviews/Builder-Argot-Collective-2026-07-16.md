# Argot Collective — Interview Summary — 2026-07-16

_Last edited: 2026-07-16T18:24:00.000Z_

Interviewee: Lea (Argot Collective). Mahesh attended. Category: Infra/dev-tool maintainer. Interviewed 2026-07-16.

## Context: funding position
Argot finalized its core funding agreement: multi-year committed runway, with earlier years paid out and later years gated on progress reviews. Standing this up consumed months; Lea is now back at full force on funding diversification. The backdrop: public-goods funding across the ecosystem has deteriorated significantly, and Argot must find sustainable paths before the committed runway ends.

## How they find opportunities today
Not automated at all. Relationship-based: conferences, referrals, peer-to-peer conversations, with a few large funders acting as de facto hubs because everyone wants to work with them. No websites, feeds, or tooling in the loop.

## The RFP-style pilot
Argot is piloting scoped, timeboxed work bundles it shops to co-funders, starting with EthDebug (a debugging format making debugging cheaper and faster, implemented in the Solidity compiler). Demand was validated by the annual Solidity developer survey and by tooling teams sitting in the design calls from the start; one is now in conversation about involvement or name-backing. Argot has pitched an ecosystem security fund as a co-funder (Argot is on the applicant side of that same fund). If the pilot works, the model extends to other teams' work packages.
On becoming a services business: a cautious yes. Their primary funder's neutrality mandate constrains it; the closest viable line is security-audit/verification work, likely pursued by non-Solidity teams so Solidity stays public-goods-funded. Internal reshuffling is already happening across the six projects as effort concentrates on core Solidity.

## What the hub would need for weekly use
Her main ask sits a layer above RFPs: surface the top priorities and roadmaps of funders and major ecosystem stakeholders, e.g. where institutional adoption is heading and what security requests are being made, so teams like Argot can crystallize what work packages to scope next. This directly echoes the service-agreement/priorities layer heard from CoBuilders and Cactus. Notifications matter, especially deadlines; Telegram is too cluttered to rely on.

## Neutrality and access tension
Direct-paid feature requests risk sidelining community-requested roadmap items, and access tends to flow through personal relationships. She recalled prior ecosystem precedents for how contentious paid influence over core tooling can get. Publisher RFPs partially solve the access problem but can create bias of their own. She floated a bounty-marketplace idea where a requesting team funds or attaches an engineering resource, but Solidity's onboarding cost (convoluted codebase, improving with the new compiler work) makes that hard without a long-term committed engineer.

## Profile and data contribution
Argot already publishes a transparency report and roadmap/milestone reviews, and holds quantifiable data: Sourcify usage, user behavior, and the annual Solidity developer survey. Some of it is publicly verifiable (GitHub). The Sourcify team is interested in exploring what its dataset could enable for builder profiles and qualification.

## AI flood
Starting roughly four to five months ago, AI-generated PRs and security reports have flooded in; most are empty but all require review, which has net slowed the team down. No filtering tooling identified; Lea will ask the team how they triage. Mahesh's take: AI generates decent code but cannot yet review for architectural fit or unnecessary complexity.

## Follow-ups
Telegram group created on the call. Lea adds a Sourcify teammate to the group Monday 7/21 to explore surfacing metrics into builder profiles. Lea is dropping the EthDebug co-funding one-pager into the group for Sov's feedback (already shared with prospective co-funders). Keep Argot's funder-side thread (publishing RFPs) separate from this builder interview.