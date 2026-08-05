# 0004. Revise draft v1.0.0 in place a second time — swap the organisation roles, close the top level, retire the eligibility registry

- **Status:** accepted — decision #15's two inlined `{amount, currency}` shapes, and its note that ADR-0002 #17's single-currency scoping "survives verbatim", overtaken by [0006](./0006-document-wide-single-currency.md) (every monetary amount is now denominated in the document-wide `fundingInfo.currency`)
- **Deciders:** standard maintainers
- **Date:** 2026-08-05
- **Supersedes:** [ADR-0002](./0002-v-next-field-recut.md) **in part** — decisions #11
  (sponsoring-primary, `minItems: 1`), #14 (extensions stay top-level), #21 (eligibility as an
  open key→value map with a registry), #22 (the `resourceLinks` name), and the shared
  `monetaryAmount` `$def` that expressed #17. Every other ADR-0002 ruling stands. ADR-0002 is
  not edited; this record points backward, and its status line should point forward.

## Context and problem statement

The 2026-07-27 re-cut ([ADR-0002](./0002-v-next-field-recut.md)) settled the data model from
interview evidence. Five weeks of building against it — the API derivation, the seed-mapping
pipeline, the compatibility audit of 2026-08-05 — surfaced a batch of defects that are cheap to
fix now and expensive after promotion to `stable`:

- **The organisation arrays had the roles backwards for the consumer.** ADR-0002 #11 made
  `sponsoringOrganizations` the required, primary array and `operatingOrganizations` optional.
  But the entity a consumer needs — who to display, whose intake this is, who answers questions,
  which organisation an `rfp` is issued by — is the **operator**. Requiring the backer and
  making the operator optional required publishers to invent a sponsor when only an operator is
  public, and left the display slot hanging off an array that models a different concept.
- **`extensions` was an escape hatch nothing used and everything leaked through.** One fixture
  in the entire corpus used it, to carry one value from a field the re-cut had deliberately
  removed (`awardsToDate`). An open bag on a closed core is where removed fields go to survive
  their own removal, and it made "the top level is closed" a half-truth the meta-schema had to
  explain away. `networks` and `tags` were the same problem in list form: open free-text lists
  overlapping `ecosystems` and `categories`, carrying uncurated source-system noise.
- **The eligibility map got structure without comparability.** ADR-0002 #21 already recorded
  the cost: two publishers writing `stage` and `projectStage` produce uncomparable facets, and
  the registry "recovers most of the interoperability and none of the type safety". In practice
  it recovered neither — no fixture carried the field, no consumer faceted on it, and the
  registry governed six keys nobody used. The half-structure was worse than either endpoint.
- **A tail of shape and naming defects**: `socialLinks` as a platform-keyed object could not
  carry two links on one platform and mapped to nothing in JSON-LD; `funding` the property
  collided with `accelerator.funding` and with the `$defs/funding` envelope in every
  conversation; two properties were still literally named `type` (`organization.type`,
  `deadline.type`) after the discriminator rename; `organization.slug` was optional-nullable on
  a field that is also the organisation's namespace; the `monetaryAmount` `$def` was one shared
  definition for two sites that gained nothing from sharing it; and `resourceLinks` said "links"
  about a field that is deliberately one pasted string.

Every fix is breaking under the project's bidirectional definition. So the forcing question is
the same one ADR-0001 answered, one revision later: **new version directory, or edit the draft
in place a second time?** — this time against the standing sentence "in-place re-cuts end here —
a second one would not be defensible" (`CHANGELOG.md`, 2026-07-27).

Constraints true on the day: v1.0.0's maturity is `draft` and the `FROZEN` marker is not
present; **zero external adopters** are known — no third party publishes or consumes the shape;
the npm package **is now published** (`@the-rfp-hub/standard` 1.0.1), so one leg of ADR-0001's
"unpublished, unadopted, undereferenceable" basis has expired and only the adoption leg remains.

## Decision drivers

- The entity consumers need first is **who actually runs the process** — intake, review,
  answers. That is the operator, and the schema's one guaranteed organisation should be it.
- A closed core with an open bag attached is not a closed core. Fields removed by decision were
  re-entering through `extensions`; the only extension mechanism that keeps a standard coherent
  is a spec release.
- Free text beats a half-right structure (ADR-0002's own driver) — applied to `eligibility`
  honestly this time: the interviews showed no settled decomposition, and the key→value map was
  a structure guess wearing a free-text costume.
- A typed pair beats an open map where the value space is known: social links have a knowable
  platform set and a URL; an open object had neither uniqueness semantics nor a JSON-LD story.
- `PROCESS.md`'s written rule permits draft-period in-place edits as a class; the once-only
  sentence was written about a specific event. Where a rule and a vow conflict, the rule wins —
  but only if the reconciliation is recorded, which is this document.
- Renames are nearly free while the fixture corpus is the only data; after one adopter they are
  never free again.

## Considered options

1. **Cut a new version directory** (`v1.1.0` or `v2.0.0`) and leave v1.0.0 as published.
2. **Edit draft v1.0.0 in place a second time**, keeping `specVersion` at `1.0.0`.
3. **Defer the batch to the first post-stable revision** and promote the current shape.

### Option 1 — new version directory

- Good, because it honours the once-only sentence literally and sets no further precedent.
- Bad, because it repeats ADR-0001's rejected bookkeeping one version later: a migration story
  from a shape zero publishers emit to a shape zero publishers consume, and a permanently
  maintained directory documenting five weeks of internal iteration.
- Bad, because `draft` maturity exists precisely so this is not necessary — if a draft cannot
  change in place, `draft` and `stable` are the same state with different labels.

### Option 2 — second in-place draft edit

- Good, because it matches the written rule (`PROCESS.md`: a version directory may be edited in
  place only while its maturity is `draft` and no external consumer has adopted it) and the
  actual state of the world (draft, no adopters).
- Good, because the standard reaches its first adopter with the operator-primary shape, the
  fully closed top level, and no property named `type` — instead of deprecation baggage at v1.
- Bad, because it does the thing a published sentence said would not be defensible. The
  reconciliation must be argued, not waved at — see the decision outcome.
- Bad, because the npm package is published at 1.0.1: anyone who installed it holds types that
  no longer match the schema, with only the package-axis semver (a major-worthy change to the
  exported types) as signal.

### Option 3 — promote now, revise after

- Good, because it ends the in-place era immediately.
- Bad, because it knowingly freezes defects — a backwards role assignment on the standard's one
  required organisational fact — and converts every fix into a v2 migration for real adopters.
  Promoting a shape while holding a list of decided reversals is not stability, it is deferral
  with a stability label.

## Decision outcome

**Chosen: Option 2 — revise draft v1.0.0 in place a second time.** `specVersion` stays
`1.0.0`; the changes are recorded in the CHANGELOG's second field-mapping table; this ADR is
the structural record.

### Reconciling with "in-place re-cuts end here"

The tension is real and is resolved by reading the two texts at their own scope, honestly:

- **The rule** (`PROCESS.md`, In-place re-cuts): *"A version directory may be edited in place
  only while its maturity is `draft` and no external consumer has adopted it."* That is a
  standing permission class. Both conditions hold today.
- **The vow** (`CHANGELOG.md` 2026-07-27, ADR-0001's "once, and only once") governed the event
  it sat beside: **re-cutting bytes that had been published as the finished v1.0.0** — the
  semver-betraying act of replacing a version's content after presenting it as final. That
  event class stays closed. What this revision does is exercise the draft rule the same
  release wrote down; the vow's own paragraph in ADR-0001 cites that rule as its mitigation,
  so the two were never independent.

Reading the vow as forbidding all draft-period edits would make `draft` meaningless and would
have forbidden the 2026-08-05 corrections batch too. Reading it as scoped to the published-
re-cut event keeps both texts true. That is the reading adopted — **and it ends**: promotion
to `stable` lands the `FROZEN` marker, the freeze workflow enforces it, and no in-place edit
of any kind is possible afterwards, permanently. The one honest weakening since ADR-0001 is
named above: the package is published now, so the basis is *draft maturity plus zero external
adopters*, not *unpublished*. If even one external adopter appears before promotion, the next
breaking change is a version bump regardless of maturity.

### The decisions

#### Organisations — the role swap (supersedes ADR-0002 #11)

| # | Decision |
|---|---|
| 1 | **`operatingOrganizations[]` is now required, `minItems: 1`, and is the primary array.** `[0]` is the primary/display organisation — including the issuing organisation of an `rfp`. |
| 2 | **`sponsoringOrganizations[]` is now optional** — the issuer/backer where one is published, absent where none is. ADR-0002 #12's semantics (backer ≠ source of funds; money's origin unmodelled) survive unchanged; only the requiredness and primacy move. |

The reasoning, quotable: **operating = who actually runs the process = the entity consumers
need.** Every consumer question the primary slot answers — whose intake, whose logo, who to
contact, who issued this RFP — is about the operator. A publisher always knows who runs the
process (often it is themselves); they do not always have a publishable backer. The required
array should be the one that can always be filled truthfully.

**The JSON-LD cost, accepted with eyes open.** The crosswalk's term assignments do not move:
`sponsoringOrganizations → schema:funder` (clean, repeatable) and
`operatingOrganizations → schema:sponsor` (loose — schema.org's `sponsor` is a funding-side
role, not an operator, and the crosswalk itself says so). After the swap, the **required,
primary array carries the loose mapping**, and the clean `schema:funder` / DAOIP-5 Grant System
mapping hangs off an **optional** array — an external funder-seeking consumer may find it
absent. The alternative — reassigning terms so the required array gets `funder` — would be
semantically false (an operator is not a funder). Honest-but-loose beats clean-but-wrong;
recorded as an accepted cost in the crosswalk.

#### Closure — no extension mechanism (supersedes ADR-0002 #14; removes `networks`, `tags`)

| # | Decision |
|---|---|
| 3 | **`extensions` is removed and nothing replaces it.** The top level is fully closed. A new field requires a spec release — there is no other extension mechanism, by design. ADR-0002 #14 ("extensions stay top-level only") is superseded by there being no extensions anywhere. |
| 4 | **`networks` is removed.** No successor; `ecosystems` is the nearest concept and already carries the ETH-family scoping. |
| 5 | **`tags` is removed.** No successor; `categories` is the nearest concept. Fixture tag values are dropped, not folded — they were uncurated source-system noise, which is the point. |

Cost, stated plainly: the one real datum living under `extensions` — the preserved
`funding.awardsToDate` value the 2026-07-27 conversion promised was "rehomed rather than lost"
— **is now lost**. The CHANGELOG entry retracts that promise explicitly rather than letting the
old sentence stand as false. The `daoip5:extensions` alignment point (the standard's only 1:1
same-name DAOIP-5 mapping) is also gone, and both lossy crosswalk directions lose their
documented overflow slot: lossy imports now **drop** data they cannot place.

#### Eligibility — free text, registry retired (supersedes ADR-0002 #21)

| # | Decision |
|---|---|
| 6 | **`eligibility` becomes free text** (`string \| null`): who may apply, in the publisher's own words. Deliberately unstructured — for reading, not faceting. |
| 7 | **The `eligibility-keys` registry is retired: the file is deleted.** Its six key definitions survive in the git history and the CHANGELOG record. |

On the never-delete rule: `PROCESS.md`'s *"nothing in a registry is ever deleted"* governs
**entries within a registry** — it protects published data from losing its interpretation. It
does not contemplate a registry whose governed field ceased to exist; deprecating all six
entries is impossible under the project's own invariants (every deprecated entry needs a live
`replacedBy` successor in the same registry, and codegen rejects a registry governing no
field). The precedent is therefore set narrowly and written into `PROCESS.md`:

> **A registry may be retired — deleted whole — only while its governing spec version is
> `draft`.** Once the version is stable, a registry with a removed subject is deprecated
> entry-by-entry and kept forever, like any other published vocabulary.

#### Social links — typed entries (restructure; supersedes the object shape)

| # | Decision |
|---|---|
| 8 | **`socialLinks` becomes an array of `{platform, url}` objects** (`$defs/socialLink`): `platform` a closed seven-value enum (`twitter`, `discord`, `github`, `telegram`, `farcaster`, `forum`, `blog`), `url` a required URI. `uniqueItems` rejects whole-entry duplicates only, so one platform may carry several URLs — which the keyed object could not express at all. |
| 9 | **The `$def` is singular — `socialLink` —** closing the sole violation of the singular-def convention (`$defs/socialLinks` was the one plural among seventeen). Defs name the entity an item is; properties name the collection. |

A typed pair beats an open key→value object here for the same reason `eligibility` goes the
other way: the platform vocabulary **is** settled and finite, so structure pays; eligibility's
decomposition is not, so it doesn't. It also gives JSON-LD something true to say — each
entry's `url` maps to `schema:url` in scope, `platform` is RFP Hub vocabulary — where the
keyed object mapped to nothing.

#### Naming and shape hygiene

| # | Decision |
|---|---|
| 10 | **`resourceLinks` → `additionalReferences`** (supersedes ADR-0002 #22's name, keeps its shape decision: still one free-form string, deliberately not an array of URIs). The old name said "links" and read as a URI array; publishers paste prose. |
| 11 | **`funding` → `fundingInfo`.** Ends the three-way collision between the top-level property, `accelerator.funding`, and the `$defs/funding` envelope. Nested paths follow (`fundingInfo.currency`, …); `accelerator.funding` keeps its name (it *is* funding offered per team). |
| 12 | **`organization.slug` is required and non-null.** It is the organisation's namespace and the publisher-verification anchor; an optional namespace is not a namespace. Fixture slugs are invented data, and the benchmark says so. |
| 13 | **`organization.type` → `orgType`**, non-null enum (`null` dropped from union and enum; the field stays optional — absence is the "unknown" state, and one unknown-marker is enough). |
| 14 | **`deadline.type` → `deadlineType`.** With #13 this completes the rename family started by `type` → `fundingType`: **no property named `type` remains anywhere in the schema.** |
| 15 | **`$defs/monetaryAmount` is removed; its `{amount, currency}` shape (both required) is inlined** at its two use sites, `bounty.reward` and `accelerator.funding`. Instance-invisible: validation is byte-identical, bounty's required-reward guarantee is untouched, and ADR-0002 #17's single-currency scoping survives verbatim. The cost is two copies of a two-field shape (drift risk) and the loss of the generated `MonetaryAmount` type — package-axis, not spec-axis. Pointing both sites at the funding envelope was rejected: it would have made `"reward": {}` valid and put program-pool fields (`budget`, `allocated`) on a per-completion reward. |

## Consequences

- **Good:** the one guaranteed organisation is the one consumers need; the top level is closed
  for real; no property is named `type`; every name says what its field is; the standard
  reaches its first adopter without deprecation baggage.
- **Bad — data loss, named:** `awardsToDate` (via `extensions`) is finally lost and a published
  promise about it is retracted; fixture `tags`/`networks` values are dropped; lossy crosswalk
  imports have no overflow slot and now drop what they cannot place.
- **Bad — the versioning asterisk grows:** the project has now edited a draft in place twice
  under a sentence that said once. The reconciliation above is the honest answer, and it is
  narrower than ADR-0001's ("draft + zero adopters", no longer "unpublished"). npm consumers of
  `@the-rfp-hub/standard` 1.0.x hold stale types with only package-axis semver as signal.
- **Bad — the JSON-LD asymmetry:** the required primary array maps loosely
  (`operatingOrganizations → schema:sponsor`); the clean `schema:funder` mapping is on an
  optional array a funder-seeking consumer may find absent. Accepted; recorded in the
  crosswalk.
- **Bad:** every existing fixture organisation needed an invented slug — new data not carried
  from source, disclosed in `BENCHMARK.md`.
- **Neutral:** `eligibility` moves from unfaceted-structure to unfaceted-prose — nothing
  faceted on it before; converters must flatten key→value pairs into sentences (lossy, and
  said so in the mapping table). `specVersion` stays `1.0.0`; the spec axis does not move for
  a draft revision.

## Follow-ups

- **Promotion to `stable` lands the `FROZEN` marker and ends in-place edits permanently** —
  the freeze workflow already enforces it. That promotion is the event that retires this ADR's
  entire permission basis.
- The registry-retirement rule is added to `PROCESS.md` (done in this batch); the registry
  count references in `NORMATIVE.md`, `PROCESS.md` and the READMEs drop to two (done).
- `adr/README.md`'s index gains a 0004 row, and ADR-0002's status line gains a
  "superseded in part by ADR-0004" pointer — per the amendment rule, only the status line
  moves.
- Fixture, conformance and validator lockstep (slugs, `deadlineType`, `fundingInfo`, the
  inverted empty-array fixture moving from `sponsoringOrganizations` to
  `operatingOrganizations`, the retired eligibility check) lands in the same PR as the schema.
- Before promotion: verify against npm that no external consumer has adopted 1.0.x — the
  zero-adopters premise is now an assumption about a published package, not a fact about an
  unpublished one.
