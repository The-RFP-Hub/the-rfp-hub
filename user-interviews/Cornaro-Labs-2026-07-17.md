# Cornaro Labs (web3grants.co) — Aggregator Responses — 2026-07-17

_Last edited: 2026-07-17T16:35:00.000Z_

> ✅ Async written responses, received 2026-07-17 via the duplicate-and-return path. Respondent: Marianna Charalambous, Cornaro Labs (CL Web3 Grants Hub, web3grants.co). Source page: RFP Hub Research: For Aggregators (Cornaro copy). Covers the full question set, core + aggregator-specific. The 7/22 call slot is now an optional deep-dive.

## Summary
Sourcing. Daily blended pipeline: a dedicated X timeline for foundation announcements, Telegram groups, Google Alerts, blog subscriptions, direct relationships with grant program managers, plus a trained AI agent that scrapes and flags candidates. Distinctive coverage: EU institutional blockchain funding pulled directly from the EU Funding & Tenders Portal / CORDIS (likely the only web3 grant list doing this). Split roughly 65% automated / 35% manual; automation finds candidates, humans make listings trustworthy. Most time goes to the manual normalization layer.
Pain points. Two dominate: (1) dedup, telling new from reposted across channels before treating it as new; (2) status/lifecycle tracking, programs die silently, extend deadlines without announcing, or leave application forms live after effectively ending. Rolling removal of expired listings is the single biggest time cost. Deadlines and status are the most-often-wrong fields, and that frustration is why web3grants.co exists.
Hub adoption bar. Be an input, not a competitor: something they can pull and merge into their own pipeline, not a destination duplicating their browse experience. And stay maintained long-term, not well-kept only while a grant funds it. Explicit openness to collaborating on "the most updated registry for web3 funding opportunities."
Field priority (their order). Status (open/closed/paused) > deadline > ecosystem/chain scope > funding type and range (grant vs RFP vs equity vs retroactive; min/max or pool) > eligibility decomposed into structured sub-fields (stage, geography, sector), not one free-text blob > direct URL.
Contributing back. Yes, conditional on a win-win: named recognition as a data partner (sourced-from field, credit on hub listings), attribution/traffic back to web3grants.co, and genuine shared-source-of-truth economics that reduce their duplicate maintenance. They want early-collaborator status, not to be a submission pipe.
API asks. Structured machine-readable listings on the priority fields; a stable unique ID persisting across edits for dedup against their DB; per-field freshness/last-verified metadata (status and deadline go stale fastest); filtering + delta queries (ecosystem, status, updated-since) instead of full re-downloads; a write/correction path with acknowledgment; rate-limit and pagination headroom for a full daily sync.
Report signal. Third respondent converging on freshness/trust over features (echoes Cactus's "comprehensive, visibly active data" and the publisher-disorganization thread). The stable-ID + per-field last-verified + delta-sync asks are the most concrete API requirements any interviewee has given; the attribution/partnership condition is the aggregator-side mirror of publisher neutrality concerns.

## Verbatim responses

### Core
1. Walk me through how you currently find and index funding opportunities. What tools, what cadence?
We run a blended, daily approach using:
- Discovery/monitoring: X for foundation announcements (we've built a dedicated timeline for this), Telegram groups, Google Alerts for keyword-based catches, foundation blog subscriptions, and direct outreach to grant program managers when we can build a relationship.
- Structured sources: we're likely the only Web3 grant list that also includes EU institutional blockchain funding opportunities, so we pull directly from the EU Funding & Tenders Portal / CORDIS for EU-side programs.
- AI agent: we've trained an AI agent that scrapes available internet sources and flags new grant program opportunities for review.
- Manual layer on top: every source above still gets a human pass to normalize eligibility language, categorize by ecosystem/vertical, and catch anything an automated feed mis-tagged or missed entirely.
So it's automation for finding candidate listings, but a persistent manual layer for cleaning and structuring them and that second part is where most of the actual time goes.
2. Where does that process break down? What costs you the most time?
- Telling new from reposted. The same grant program can resurface across new posts, new Telegram messages, etc., so it might already be in web3grants.co and we just have to catch that before treating it as new. We're also strict about only surfacing active and upcoming opportunities, so expired listings get removed on a rolling basis; keeping that current is what actually eats the most time.
- Status/lifecycle tracking. Programs go quiet without formally closing, extend deadlines without announcing it clearly, or pause indefinitely. Detecting "this is actually dead" versus "this is just slow" requires ongoing manual monitoring, including reaching out directly to foundations, who sometimes just don't reply.
3. What information is most often missing or wrong in opportunity listings?
- Deadlines: extensions aren't consistently announced, or a program has effectively ended but the application form is still live and accepting submissions.
- Status: So many listings out there are for programs that are no longer active, and honestly that frustration is a big part of why we built web3grants.co in the first place. We put a lot of effort into surfacing real, live opportunities and never showing outdated information.
4. If a neutral, open hub existed, what would it need to do for you to use it weekly?
- Be an input, not a competitor, something we can pull from and merge into our own pipeline, not a destination that duplicates the "browse grants" experience we already offer our users. It would simply be awesome if we could collaborate and build the most updated registry for web3 funding opportunities!!
- Actually stay updated, with real long-term commitment, built and maintained for the long haul, not something that's well-maintained only as long as a grant is funding it and then goes stale.
5. Which fields actually matter to you in a listing?
In rough priority order: status (open / closed / paused), deadline, ecosystem/chain scope, funding type and range (grant vs. RFP vs. equity vs. retroactive; min/max or total pool), eligibility criteria, ideally decomposed into structured sub-fields (stage, geography, sector) rather than one free-text blob, and direct URL.
6. Would you contribute data back (submissions, corrections, flags)? What would make that worth doing?
We'd love to but this only makes sense as a win-win, since we've spent a significant amount of time developing our own hub as a public good. Specifically, what that looks like for us:
- Recognition as a data partner/source, not an anonymous contributor, if listings that originated from us are visible as such (e.g. sourced-from field, credit on the hub), that's worth something to our own credibility and reach.
- Traffic/attribution flowing back to web3grants.co: a link or credit on hub-side listings that points back to us (maybe for the EU opportunities), the same way we'd credit the hub as a source on ours.
- It actually saves us work rather than adding to it: if contributing back means less duplicate maintenance on our end (e.g. the hub becomes a shared source of truth we both draw from), that's the real incentive, more than any one-off integration.
- A real partnership, web3grants.co as a named, credited source and an early collaborator on RFP Hub, not just a submission pipe.

### Aggregator specific
1. How do you source opportunities today? What share is automated vs. manual?
See Q1. It's hard to give an exact split, but roughly 35% manual / 65% automated. The automation gets us candidates; almost everything that makes a listing trustworthy and usable is still human-verified.
2. What do you need from the API?
- Structured, machine-readable listings covering the fields in Q5: status, deadline, ecosystem, funding type/range, structured eligibility, direct URL
- A stable unique ID per listing that persists across edits, so we can de-dupe against our own database instead of re-matching by name or URL every time we sync.
- Freshness/last-verified info per listing, ideally per field, since "status" and "deadline" go stale faster than everything else, and we need to know how much to trust each one.
- Filtering and delta queries (by ecosystem, status, updated-since) so we can pull what's changed on our own cadence instead of re-downloading the full dataset every time.
- A write/submission path for corrections, since we're already catching status and deadline errors ourselves, being able to push those back (with some confirmation that they were received/accepted) is what would make this a two-way relationship instead of one more feed to babysit.
- Enough rate limit/pagination headroom to actually run a full daily sync without hitting a wall.