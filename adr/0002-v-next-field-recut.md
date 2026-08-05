# 0002. The v-next field re-cut — what changed in the data model and why

- **Status:** accepted — decisions #11 (sponsoring primacy/minItems), #14 (extensions asymmetry), #17's monetaryAmount def, #21 (eligibility map + registry) and #22 (resourceLinks) superseded by [0004](./0004-second-draft-revision-org-swap-and-closure.md); decision #3 (one sibling block per fundingType — the `opportunity[opportunity.fundingType]` access pattern) superseded by [0005](./0005-third-draft-revision-utc-timestamps-and-tagged-funding-details.md); decision #17 (the envelope-only scoping of the single-currency rule) superseded by [0006](./0006-document-wide-single-currency.md), which extends #16's rule document-wide
- **Deciders:** project leadership + standard maintainers
- **Date:** 2026-07-27
- **Supersedes:** —

## Context and problem statement

The first cut of the opportunity schema was designed from prior art and from one aggregator's
data shape. Before declaring it complete, the project ran a round of **structured interviews with
publishers (grant programs and foundations), aggregators (people who index funding opportunities
for a living), and builders (people who apply)** — private research, conducted on the
understanding that the input would shape the schema.

The interviews did not produce a wish list. They produced a consistent account of where the
existing shape mismatched how funding is actually published: a single close date where programs
publish several; one organisation where there are usually two with different roles; eligibility
buried in prose; a provenance model built around a canonical source URL that publishers often do
not have.

A second exercise ran alongside it: the proposed shape was **stress-tested against a real,
third-party request-for-proposals** — donor-crowdfunded, milestone-paid with acceptance
checklists, no application portal, and no absolute dates. That single document surfaced ten more
decidable questions that the interviews had not, because it broke assumptions rather than
expressing preferences.

This ADR records the resulting batch of decisions as one decision, because that is what it was:
one sitting, one set of forces, one coherent shape. The **versioning** of the change is
[ADR-0001](./0001-recut-v1.0.0-in-place.md). Two additions that were not part of the interview
batch are [ADR-0003](./0003-instance-self-identification-and-version-pattern.md).

## Decision drivers

- **Publish what publishers actually have.** Every place the schema demanded a value publishers
  cannot reliably produce, it was producing either empty fields or invented ones.
- **One model per concept.** Two date models, two organisation concepts, or two ways to say
  "this is a service engagement" cost more in consumer confusion than they buy in precision.
- **Free text beats a half-right structure.** Where the interviews showed the domain has no
  settled decomposition, the decision was consistently to take one free-text field rather than
  guess at sub-fields nobody agrees on.
- **Open vocabularies over closed enums**, with a registry to keep values comparable — because a
  closed enum in a domain this varied guarantees a `other` value carrying half the data.
- **The discriminator must be a guarantee.** Consumers were already writing
  `opportunity[opportunity.type]`; the schema only *expected* that to work.
- **Declining an ask is fine; declining it silently is not.** Every declined request has its cost
  recorded below.

## Considered options

At the level of the batch, three:

1. **Additive-only.** Add the new fields, leave everything existing in place.
2. **Full re-cut.** Rename, remove and restructure as the evidence indicates.
3. **Re-cut plus deeper modelling** — the richer organisation/lane/program modelling that some
   participants asked for.

### Option 1 — additive only

- Good, because nothing breaks and no versioning question arises.
- Bad, because the two most-cited problems (`closesAt` being a single scalar; `organization`
  being a single object) are *shape* problems. Adding `deadlines[]` beside `closesAt` and
  `sponsoringOrganizations[]` beside `organization` gives every consumer two sources of truth for
  the same fact and no rule for which wins.
- Bad, because it defers the break rather than avoiding it, to a point where it would cost more.

### Option 2 — full re-cut

- Good, because it produces one model per concept.
- Good, because with zero adopters the break is free (see ADR-0001).
- Bad, because it invalidates the existing example corpus and every mapping document, all of
  which had to be reissued.
- Bad, because it spends the project's one free breaking change; anything missed here is
  expensive later.

### Option 3 — re-cut plus deeper modelling

- Good, because one publisher's adoption condition was explicitly that a hub capturing only
  title/description/amount/deadline "will recreate the same confusion that already exists".
- Bad, because the deeper modelling asked for — governance seasons, decision paths, parent
  organisation linkage, historical programme lanes — is specific to a small number of
  sophisticated programmes and would be empty for the overwhelming majority.
- Bad, because it is unfalsifiable at this stage: there is no consumer to validate it against,
  so it would be modelling on speculation, which is what produced the mismatch in the first
  place.

## Decision outcome

**Chosen: Option 2 — a full re-cut, with the deeper modelling explicitly declined.**

The decisions, grouped. Each is a settled ruling, not a proposal.

### Structure and discrimination

| # | Decision |
|---|---|
| 1 | **Drop the proposed `wishlist` opportunity type.** Wishlist-style postings are internal to one publisher's workflow. No enum value, and no requirements split driven by it. |
| 2 | **Rename `type` → `fundingType`.** Same six-value discriminator (`grant`, `hackathon`, `bounty`, `accelerator`, `vc_fund`, `rfp`), clearer name. Breaking, and accepted as such. |
| 3 | **One block per funding type is now enforced.** The schema previously required the *matching* type block but permitted others alongside it — a `grant` record could carry a `hackathon` object and validate. Each conditional branch now forbids every non-matching block, so `opportunity[opportunity.fundingType]` is a guarantee. |
| 4 | **No seventh type block.** Service engagements became a field, not a type — see below. |

### Dates

| # | Decision |
|---|---|
| 5 | **`closesAt` becomes `deadlines[]`** — an array of `{type: "fixed" \| "rolling", date?, label?}`. Programs publish several deadlines; one nullable scalar could carry one of them. |
| 6 | **`date` is required and non-null when `type` is `"fixed"`** — schema-enforced, not a SHOULD. |
| 7 | **Every per-type date folds in, literally** — registration, submission, proposal, application *and* event start/end — distinguished by `label`. One date model in the standard, not two. |
| 8 | **Labels are free text with a registry**, not an enum. Conventional values are published and the validator warns on unregistered ones. |
| 9 | **No event-anchored or relative deadline form.** *"Opens on X, then 30 days"* stays unexpressible by design: an unanchored window does not represent anything a consumer can act on. The publisher posts a fixed date when the window opens. |
| 10 | **No `recurring` deadline type.** `grant.recurring` is the only carrier of a recurring-round concept. |

### Organisations

| # | Decision |
|---|---|
| 11 | **`organization` → `sponsoringOrganizations[]`** (required, at least one; `[0]` is the primary/display entity) **plus `operatingOrganizations[]`** (who actually runs intake and process). The single-org model could not express the common case where a funder and an operator are different parties. |
| 12 | **`sponsoringOrganizations` is the issuer/backer, not necessarily the source of funds.** For donor-funded models the money's actual origin is **deliberately not modelled**; the party running the process goes in `operatingOrganizations`. Documentation convention, no field. |
| 13 | **Organisation contacts become an array** — `{name?, role?, telegram?, email?}`, every field optional, `{}` valid. Some publishers have a named steward; some deliberately have none. |
| 14 | **No `extensions` on the organisation object.** Extensions stay top-level only. |
| 15 | **No lane/programme modelling** — no parent-organisation linkage, no governance term/season, no decision path. |

### Money

| # | Decision |
|---|---|
| 16 | **Single currency at the envelope.** `funding` carries one `currency` scalar governing `budget`, `allocated`, `minAward`, `maxAward` and `milestones[].amount`. |
| 17 | **The single-currency rule is scoped to the envelope only.** `bounty.reward`, each `hackathon.prizes[].currency` and `accelerator.funding` keep their own currency — a prize pool can legitimately be denominated differently from the programme budget, and collapsing them would lose information rather than simplify. |
| 18 | **`totalBudget` → `budget`; `amountDistributed` → `allocated`,** where `allocated` means **committed to date**, not paid out. A semantics change, not a rename. `remaining` is derived (`budget − allocated`) and never stored. Disbursement and delivery are not modelled. |
| 19 | **`awardsToDate` removed** — a per-award count in an otherwise programme-level envelope. |
| 20 | **No `raised` field.** It was proposed and dropped: the raised-versus-allocated interplay is more complexity than the field is worth, and dropping it keeps `remaining` unambiguous. |

### Eligibility and free text

| # | Decision |
|---|---|
| 21 | **`eligibility` is an open key→value map of plain strings** — publishers choose their own keys. Not the fixed decomposition (stage/geography/sector as named sub-fields) that was asked for. Conventional keys are registry-published. |
| 22 | **Add `prerequisites`** (free text: what a *proposal* must contain) and **`resourceLinks`** (one free-form string of supporting links, deliberately not an array of URIs — publishers paste what they have). |
| 23 | **`rfp.requirements` stays free text and RFP-only**, with no hard/soft split; **`rfp.scope` stays one field**, with in-scope and out-of-scope prose both inside it. |
| 24 | **Reporting cadence is not in the schema.** |

### New capabilities

| # | Decision |
|---|---|
| 25 | **`serviceAgreement`** — a new optional top-level free-text string, valid on **any** `fundingType`, describing how a long-term service engagement works. **Presence of the field is the signal.** Not a seventh type, and not a structured block with term length and renewal flags: duration and renewal go in the prose if they matter. Marked provisional. |
| 26 | **`milestones[]`** — a new optional top-level array of `{title?, amount?, criteria?}`, valid on any `fundingType`. **Array order is the sequence**; there is no order field and **no date field** — due dates go into `criteria` as free text. `amount` must follow `funding.currency`; the dependency crosses objects so JSON Schema cannot enforce it and ingest warns instead. Milestone-based payment *is* this array plus `grant.milestoneBased`; no separate payment-schedule concept. Marked provisional. |
| 27 | **`grant.fundingMechanism` → `fundingMechanisms[]`**, an array, with `matching` added to the value set. Mechanisms co-occur — a funder can offer a fixed grant and a matching grant in the same programme, and a scalar recorded that case wrongly. |
| 28 | **`grant.programModel`** — a new open string for the programme's operating model (conventional values `grant`/`program`/`infra`/`incentives`), as distinct from the funding instrument. Deliberately not a closed enum and deliberately not a `fundingType` value. Marked provisional. |

### Provenance

| # | Decision |
|---|---|
| 29 | **`source.url` is removed, and the rest of the provenance block is kept.** `publisher`, `submittedBy`, `submittedAt`, `ingestedVia`, `originalId`, `verifiedAgainstSource`, `verifiedAt` and `snapshotUrl` all survive. Link-back to the opportunity now runs through **`applicationUrl` alone**. The proposed set of source *aliases* (several URLs describing the same opportunity) is declined. |
| 30 | **The provenance block has no required property at all.** `source` stays a required top-level object with every field inside it optional — `"source": {}` validates. Requiring `ingestedVia` in the removed URL's place was considered and declined. |
| 31 | **`applicationUrl` may carry whatever the submission channel is** — including a forum thread when no portal exists. The URL's *kind* is not typed and there is no submission-channel field; clarifications go in `description`. |
| 32 | **Per-field freshness is declined.** Verification stays record-level, and `verifiedAt` stays inside `source` rather than being promoted to the top level. |

### Status

| # | Decision |
|---|---|
| 33 | **No `draft` or pre-open status value.** A publisher wanting pre-open visibility uses `upcoming`. The enum stays at four values. This does **not** resolve the broader question of status granularity, which remains open on its own terms. |

## Consequences

The costs, recorded so that when a participant asks why their request was declined, the answer is
on file and honest. Interviewees are described by role, not by name — the underlying research is
private.

- **The verification job's fetch target got weaker.** With no source URL, the only URL to fetch
  and snapshot is `applicationUrl` — an intake form, often owned by an operator rather than the
  funder. An intake form staying up says little about whether the *programme* is live, which is
  exactly the "dead versus slow" signal that verification exists to produce. Compounding it, no
  provenance field is required, so the job cannot assume any of them is populated. This is the
  single largest accepted cost in the batch.
- **One aggregator loses cross-source deduplication.** Their stated workflow used several URLs
  describing the same opportunity — a post, a blog entry, a forum thread, an application page —
  to make deduplication a lookup rather than a judgement call. Both the aliases and the single
  source URL are gone, so it reverts to a judgement call. They keep stable identifiers and
  record-level timestamps, their two other stated retention conditions.
- **Eligibility is filterable only by convention.** An open key→value map means two publishers
  using `stage` and `projectStage` produce two uncomparable facets. One aggregator asked for a
  structured decomposition and gets structure without comparability; one publisher asked for
  exclusions and redirect targets as first-class enumerated values, which an open string map
  cannot provide. The registry recovers most of the interoperability and none of the type safety.
- **One publisher's adoption condition is declined outright.** Their position was that a hub
  capturing only title/description/amount/deadline recreates the confusion that already exists;
  the lane and programme modelling that would have addressed it is out of scope. The two
  organisation arrays serve the display half (who funds, who runs it) and nothing more.
- **Simultaneous caps in two assets cannot be expressed.** A programme funding in a stablecoin
  *and* a governance token with separate caps must pick a primary currency and put the second in
  prose or `extensions`. Both are lossy and unfilterable.
- **The crowdfund state is unmodelled.** With no `raised` field, a donor-funded opportunity
  asserts its `budget` regardless of how much has been raised — a consumer cannot tell a fully
  funded round from one that has raised nothing.
- **Deadline expressiveness is lost at the edges.** `fixed`/`rolling` cannot express
  "recurring rounds" (only `grant.recurring` gestures at it) or the hard-versus-soft distinction
  one builder raised. Their specific complaint — programmes "rolling in name but actually
  reviewed in cycles" — is now representable only as `{type: "rolling", label: "reviewed
  quarterly"}`: free text, unfilterable.
- **Milestone acceptance checklists lose their structure.** `criteria` is one free-text field;
  the real document that motivated milestones presents acceptance criteria as checklists. A real,
  small loss, traded for consistency with every other free-text ruling.
- **Service engagements are not filterable.** A consumer can test for the presence of
  `serviceAgreement` but cannot query "engagements of twelve months or more". Presence-as-signal
  is a partial answer to the ask, not a complete one.
- **Two smaller declines**, both of which the participants rated as nice-to-have: per-programme
  reporting cadence (which would have been one more input to staleness detection), and
  organisation-level `extensions` (which leaves offered usage and survey data with no home on the
  organisation object).
- **Neutral:** one publisher's second listing type is not representable and must be published as
  an `rfp` or not at all. They did not frame this as an adoption blocker, and the decision rests
  on a scope judgement rather than on a contradiction of their account.

**On the benefit side:** the discriminator is now a guarantee rather than a convention; there is
one date model instead of two; the funder/operator distinction is expressible; and every open
vocabulary in the standard is served by one registry mechanism instead of none.

## Follow-ups

- Consumers must derive a sortable `nextDeadlineAt` (earliest future fixed deadline) at the API
  layer, and must document that records carrying only rolling entries are excluded from
  deadline-window filters. A staleness job must not auto-close a rolling programme.
- The three provisional fields (`serviceAgreement`, `milestones[]`, `grant.programModel`) need one
  real publisher and one real consumer each before promotion to stable.
- **Still open, and not closed by this batch:** status granularity, a level-of-effort or
  scope-complexity signal, and the attribution policy that CC0 cannot provide.
