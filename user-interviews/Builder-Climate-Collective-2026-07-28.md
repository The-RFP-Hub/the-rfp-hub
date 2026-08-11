# Climate Collective — Builder Interview 2026-07-28

**Interviewee:** Jon Ruth. Climate Collective network; currently building an AI agents company with the ex-Atlantis team (agent trust protocols, targeting SMBs); also still running Solar Foundation with a co-founder, mid-process on 501(c)(3).

**Attendees:** Sov solo. Mahesh could not make it. Live call, ~25 min, conversational rather than scripted.

**Category:** 0-to-1 builder (per the 7/22 reclassification from publisher).

**Filed:** 2026-07-28. AI-assisted writeup (Claude organized the summary from the transcript; quotes lightly edited for publication).

## Headline

The most **agent-native** respondent in the sample, and the only one who thinks past the human interface entirely. Jon does not look for funding himself anymore: "there's no way I would do any of it myself anymore." He hands it to an agent. That makes his answers less about listing UX and more about **whether the hub is machine-legible and machine-trustworthy**. He is also the first to raise **agent credentialing and gated access** as a design question, which is a build decision the spec does not currently address.

## Signal (report-relevant)

- **Discovery is fully delegated to agents.** Recent example: needed to expedite the Solar Foundation 501(c)(3), so he sent his agent out with rough parameters to find any grant they could plausibly fit. That is the whole process now.
- **Agents fail on data, not reasoning.** "The agents don't have all the right data because everybody's not running MCPs on their sites." Sites are not agent-friendly, so agents return closed rounds and mismatched eligibility: "I click on it, I'm like, dude, this is not it. This closed a month ago." Same staleness finding as Cap, Cornaro, Cactus and Revoke, but reframed as an **agent-readability failure** rather than a human-trust one. That reframe is new.
- **His vision of the endgame: agents talking to agents.** A shared hub where funder agents and builder agents both sit; an RFP posts and pings out; the agents that fit gravitate to it and pull it in. "You just get an email in the morning and you're like, hey, we applied for this." He does not think this is far off.
- **Trust and identity as an access-control layer. NEW, no prior interview raises this.** "Do you let all agents in to look at the RFPs, or maybe that is a gated hub and you have to have a credential as your agent?" Two distinct concerns: keeping rogue agents from reading and applying at all, and giving a publisher enough signal that an applying agent is not a scammer. Open question he poses directly at the project: whether this belongs in scope now or later.
- **The application-flood problem, confirmed from the funder-adjacent side.** The barrier to writing a plausible application has collapsed, and quality of writing no longer predicts ability to deliver. "Our ability to combat the noise is diminishing quickly because there's so much of it and it's so good." He expects permissioning as the response, same as open-source maintainers gating PRs. Directly parallels Argot's AI PR and security-report flood.
- **Knowledge graph as the hub's second product.** Beyond matching, the value is in what everyone shares into the shared space: who did what, how a piece of work actually happened, learning from outcomes you were not party to. "There begins to be a certain amount of knowledge that has its own value even beyond the money flowing." Supports the layer-not-destination framing with a different justification: institutional memory.
- **He names the failure mode of his own idea.** If agents mine the graph and conclude "this is how it was done last time, just do it," RFPs converge and visionary thinking dies. Homogenization risk. He has no fix beyond keeping a human in the loop, and is not confident that lasts.
- **Budget honesty, second independent hit.** On the Crypto Grant Wire: "sometimes it's this big blast, ten million dollars they are giving away... but they're giving away 5,000 at a time." What he actually needs: "is this a ten thousand dollar opportunity or is this a two hundred dollar opportunity?" **This is Cap's complaint almost verbatim** (headline 100k that caps at 2k), from a completely different seat. Per-award size versus program budget should be a required field, not an optional one.
- **Telegram is a bad agent interface.** He reads the Wire manually in batches and would rather plug agents into something structured: "I don't really want my agents joining a public Telegram... something like this to be able to plug into instead." Argues for the registry/API surface over channel distribution.

## Market context he volunteered

Grants have "certainly dwindled," and in ReFi and regen specifically there is close to nothing left, with one program (name unclear in transcript) as the only one funding with any regularity. He is skeptical of the incentive-to-migrate grants that remain: money to go build on a new chain, "been there done that," not compelling. He no longer expects crypto grants to fund Solar Foundation and is moving toward traditional philanthropic grants instead, which is a **second data point on builders exiting crypto funding entirely** (with Revoke going commercial).

## Convergence and divergence

**Converges with:** Cap (budget honesty; API/agent-first; won't visit a dashboard), Revoke and Cornaro and Cactus (staleness as the trust-killer), Argot (AI-generated submission flood, gating as the response), CoBuilders and Cactus and Revoke (relationship or matching layer above RFPs).

**Extends the sample:** the only respondent whose stated requirements are for a machine consumer rather than himself, and the only one to raise agent credentialing and gated read access.

**Caveat on weight:** he is not currently an active grant applicant in crypto, and answered largely from the Solar Foundation and new-company seats rather than Climate Collective. Treat as a forward-looking interface interview, not a current-workflow one.