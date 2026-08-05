# Revoke.cash — Builder Interview 2026-07-28

**Interviewee:** Rosco Kalis, founder, Revoke.cash (token-approval management; open source since 2019). Gitcoin-network contact, top grantee GG18 + GG20.

**Attendees:** Sov, Mahesh, Rosco. Live call, ~25 min.

**Category:** Infra / dev-tool maintainer (builder).

**Filed:** 2026-07-28. AI-assisted writeup (Claude organized the summary from the transcript; quotes are verbatim).

## Headline

The first interview where a builder says plainly that **RFPs structurally do not fit an existing product**. Rosco is a solo maintainer of a live, six-year-old public good whose grant funding has dried up, and the shape of available funding pushes him to bolt new tools onto the side rather than maintain and improve the core. This is a different failure mode from everything logged so far: not discovery, not scoping, not staleness, but **a mismatch between what funders will fund and what a maintainer actually needs to do**.

## Signal (report-relevant)

- **RFPs suit new projects, not existing products.** "We're building a product, we have a roadmap, we have things that we think will be good for the product... that's kind of separate from what these RFPs will look like." Matching an RFP would mean building a separate tool at `revoke.cash/thing`, adjacent to but not integrated with the core product.
- **Maintenance is unfundable, and this distorts roadmaps.** Same dynamic in ordinary grants: funders want milestones and new things to build, and "we're going to make these improvements to the performance of Revoke.cash, loading times or whatever, that doesn't really cut it." This is what drove the delegations dashboard (EIP-7702 and delegate.xyz) into existence: a separate tool inside the same tool, built because it was fundable. **New finding, no prior interview has named it.**
- **The fix he proposes is the priorities layer again, from the builder side.** Wants two-way: the builder publishes what they are building and the roads they could take, funders publish what they want, and the two "meet somewhere in the middle." Fourth independent ask for a profiles-and-priorities layer above individual RFPs (after CoBuilders, Argot, Cactus).
- **Discovery is passive for big programs, and brutal for everything else.** Octant, Optimism RetroPGF, Gitcoin arrived via Twitter and community chatter, "so big that it's hard to miss." No process at all.
- **The proactive push failed almost completely.** Over the past year he went through Revoke's entire list of supported chains, manually checked each website for a grants program, applied where one existed, and cold-emailed foundations where none did. Total yield: **roughly $20K across two chains**. His own word for the effort: "wildly unsuccessful." This is the cleanest quantified account of discovery-and-outreach cost in the sample.
- **80 to 90% of chains have no public grant program**, or never had one. The addressable universe is far smaller than the listing count suggests.
- **Most-wrong data: dead programs that still look alive.** Outdated websites, programs already wound down, "and the form is still open online." Fourth interview to name active/inactive as the field that breaks trust (with Cap, Cornaro, Cactus).
- **Contacts are the missing field.** Finding the right person at a foundation is the hardest part, and even when found the answer is usually no, not interested, or silence.
- **Alerts, tailored, not a dashboard.** He is already in Sov's Crypto Grant Wire Telegram: "it's cool to stay up to date... if there was a way to have alerts be more tailored to me and my company, my project, that would be valuable." Converges with Cap's digest-not-dashboard stance, but Rosco is alerts-first rather than API-first.
- **Agent use is rudimentary and manual.** Coding, plus research on security incidents. No automations, nothing watching for opportunities. "It's just me typing into a box." Useful counterweight to the agent-first framing from Cap and Cactus: the API-first builder is not universal.
- **Services pivot: considered, but the hub is not where he would go for it.** Asked directly whether he would sell expertise to keep the lights on, he said it is on his mind, but "that wouldn't be my main motivation for using a platform." He would use ordinary job and contract channels. **Counter-signal to the service-provider-hub thesis** that CoBuilders and Cactus pushed.

## Sustainability context

Revoke ran on grants and donations for roughly six years, at one point supporting part-time help alongside Rosco full time. That has ended. Since October 2025 there is a bounty fee, and premium and ultimate subscriptions launched recently with automated revoking; core functionality stays free and open source. Open question in his own framing: whether he can still sustain his own full-time work on the product. He is a public good going commercial under funding pressure, in real time.

## Convergence and divergence

**Converges with:** Argot (relationship-only discovery, post-grant sustainability crisis, priorities layer), Cactus and CoBuilders (relationships over transactions, profile matching), Cap and Cornaro (active/inactive is the most-wrong field), Cap (tailored push over dashboards).

**Diverges on:** agent and API readiness (rudimentary, not agent-first), and the service-provider hub (would not use it for that; traditional channels win).