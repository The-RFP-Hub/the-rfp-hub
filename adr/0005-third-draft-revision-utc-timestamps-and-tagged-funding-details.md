# 0005. Revise draft v1.0.0 in place a third time — mandate UTC `Z` timestamps and collapse the six type blocks into a tagged `fundingDetails` union

- **Status:** accepted
- **Deciders:** standard maintainers
- **Date:** 2026-08-05
- **Supersedes:** [ADR-0002](./0002-v-next-field-recut.md) **in part** — decision #3, the
  one-sibling-block-per-`fundingType` construct and with it the
  `opportunity[opportunity.fundingType]` access-pattern guarantee, which is replaced by
  `opportunity.fundingDetails` (self-described by its own required `fundingType` tag).
  ADR-0002 #9 (no event-anchored or relative deadline forms — UTC-anchored instants only) is
  **not** superseded: this record relies on its reasoning and now enforces it. ADR-0002 is not
  edited; its status line points forward.

## Context and problem statement

Two structural questions about the draft were raised by the maintainer and answered by a
measured design memo (probe scripts run against the repository's own ajv 8.20 /
ajv-formats 3.0.1 / json-schema-to-typescript 15.0.4, over the real schema and the real
68-document corpus — 28 examples, 11 pass, 29 fail):

1. **Dates.** Every temporal field was independently declared
   `{"type": ["string","null"], "format": "date-time"}` at seven sites. Nothing enforced
   uniformity across the sites, and no timezone policy existed: `+05:30`, `-00:00`, lowercase
   `t`/`z` and even a space separator were all legal and unmentioned — while the corpus was
   182/182 trailing-`Z`. The maintainer asked whether a structured datetime *object* would be
   better, and whether there should be "one default for all".
2. **Type blocks.** The schema declared six sibling optional properties (`grant`, `hackathon`,
   `bounty`, `accelerator`, `vc_fund`, `rfp`) plus a 93-line, six-branch `allOf` enforcing
   exactly-one-block-matching-`fundingType` — the `opportunity[opportunity.fundingType]`
   guarantee of ADR-0002 #3. The maintainer's instinct was that the schema hardcodes too much
   per-type knowledge, and asked whether a single `fundingDetails` object could abstract it.

The memo's decisive observation on question 2: the computed-key access pattern was a guarantee
**no layer of the system could actually use**. Generated TypeScript cannot narrow on it (six
independent optional properties share no discriminant — the root `allOf` additionally polluted
the generated type with a `{[k: string]: unknown}` index signature); the API's OpenAPI
components declared all six blocks optional with a comment conceding the union is a runtime
fact; the database stores one opaque `typeData` jsonb slot; and ingest carried a hand-written
`assertSingleTypeBlock()` guard. Every layer already treated the details as one slot; the
schema was the only artifact insisting on six.

Constraints true on the day: v1.0.0's maturity is `draft`, the `FROZEN` marker is absent, and
zero external adopters are known. This revision lands in the **same draft-revision window as
ADR-0004**, same day — the in-place permission and its reconciliation with the "in-place
re-cuts end here" sentence are argued in ADR-0004 and are not re-litigated here; this record
rides that window rather than reopening it. The window closes at promotion to `stable`, when
the `FROZEN` marker lands: **both changes are cheap now and impossible afterwards**, which is
the timing rationale for doing them in the same batch rather than deferring either.

## Decision drivers

- **Every modern standard represents instants as RFC 3339 strings.** Survey: CloudEvents 1.0
  (`Timestamp`, "String encoding: RFC 3339"), Activity Streams 2.0 §2.3, RFC 8984 (JSCalendar)
  §1.4, schema.org `DateTime`, OpenAPI 3.1, DAOIP-5's `closeDate`. None uses an object. The one
  genuine structured counterexample, `google.type.DateTime`, models *civil time* and its own
  header says "Consider using `Timestamp` message for physical time instead" — and all seven
  RFP Hub fields are physical instants.
- **Consistent offsets are what make timestamp strings sortable** (RFC 3339 §5.1: sorted as
  strings, "a time-ordered sequence will result" — when timezone representations remain
  consistent). The API exposes five sortable temporal fields; downstream consumers sort
  published JSON without parsing it. Mixed offsets silently break that.
- **The UTC-`Z` rule is prior art, not invention:** RFC 8984 §1.4 (`UTCDateTime`: "any letters
  MUST be in uppercase, and the time offset MUST be the character `Z`") and AS2 §2.3 (uppercase
  `Z` MUST in the absence of a numeric offset) arrived at the identical rule independently.
- **A tag inside each branch is what tooling can actually use.** OAS is explicit that
  `discriminator` "MUST NOT change the validation outcome" — the tag must be real data in each
  branch or nothing connects parent to children. FHIR's 158-way root `oneOf`, the GeoJSON
  community schema, Slack's hand-maintained Block Kit types and Smithy's `union`-to-`oneOf`
  compilation all converge on the same shape.
- **Measured, not argued:** 0 of 68 corpus documents change validity under either change;
  182/182 temporal values already end in `Z`; the generated TypeScript becomes a real
  discriminated union under the tagged `oneOf` and degrades to `{}` under `if`/`then`.
- **The JSON Schema org itself names the trade** in its `propertyDependencies` ADR: `oneOf`
  "tends to produce confusing error messages"; `if`/`then` is "verbose, error prone, and not
  particularly intuitive". There is no third option, and `propertyDependencies` ships in no
  published dialect. Choose `oneOf` and fix the errors in our own tooling.
- **The draft window is the last chance.** Promotion to `stable` lands `FROZEN` and the freeze
  workflow; a corpus-rewriting structural change becomes impossible, permanently.

## Considered options

### Question 1 — date/time representation

1. **1-A — status quo:** seven independent `format: "date-time"` declarations, no timezone
   policy.
2. **1-B — shared `$defs/timestamp`**, referenced from all seven sites (the "one default for
   all" ask taken literally).
3. **1-C — convention + constraint + guard:** keep the inline declarations, add
   `"pattern": "Z$"` at all seven sites, write the convention once in `FIELDS.md`, add a CI
   test that all `date-time` declarations are byte-identical, export one hand-written
   `Timestamp` alias.
4. **A structured date/time object** (fields for date, time, zone).

#### Option 1-A — status quo

- Good, because it costs nothing.
- Bad, because uniformity across the seven sites is enforced by nothing — a future edit to one
  is invisible to CI.
- Bad, because it takes no timezone position: a publisher may legally emit `+05:30` or
  lowercase `z`, and lexicographic sorting silently breaks.

#### Option 1-B — shared `$def`

- Good, because it looks like a single point of truth.
- Bad, because it was **measured and it makes things worse**: `json-schema-to-typescript`
  mints one alias per use site (`Timestamp` … `Timestamp6`) when sibling descriptions are
  present — and this repo's own convention test *requires* per-site descriptions. Dropping
  them would make every temporal row of the generated `FIELDS.md` tables read the shared
  def's generic description, erasing the distinction between `opensAt`, `postedAt` and
  `createdAt` — a documentation regression — and would still require codegen surgery
  (`typeExpr()` renders `$ref`s as links, `DEF_ORDER` needs an entry, `fieldTable()` emits an
  empty table for a non-object def).
- Bad, because it adds indirection at `deadlines[].date`, the single trickiest point in the
  schema. Seven byte-identical inline declarations already are one point of truth in every
  sense that matters; a `$ref` makes them indirect, not uniform.

#### Option 1-C — pattern + convention + guard (chosen)

- Good, because `"pattern": "Z$"` rejects `+02:00`, `-00:00` and lowercase `z`, accepts
  `null`, and breaks **0 of the 182** existing temporal values. It is verbatim the RFC 8984
  §1.4 / AS2 §2.3 rule.
- Good, because the CI equality test delivers the genuine single-point-of-truth benefit — an
  edit to one site fails CI — with zero indirection, and the `Timestamp` alias in the
  hand-curated `src/types.ts` gives consumers the one name the `$def` was supposed to provide.
- Good, because it makes lexicographic-sort-equals-chronological-sort a documented property.
- Bad, because a publisher whose deadline is genuinely "23:59 local" loses that intent — but
  that information was **already** being lost (every corpus value carries the `.000Z`
  signature of `Date.prototype.toISOString()`); the pattern makes the loss explicit instead
  of silent. If local semantics are ever demanded, JSCalendar's answer — a sibling `timeZone`
  string — remains available additively.

#### The structured object — rejected

- Bad, because the entire survey is against it: every modern standard on the list is a string.
  `google.type.DateTime` exists for civil time, which none of these seven fields is, and its
  own documentation redirects instants to `Timestamp` (an RFC 3339 string in proto3 JSON).
- Bad, because the typed-value construct the instinct reaches for **already exists in this
  repo at the right layer**: `context.jsonld` maps every temporal term to
  `schema:DateTime` — JSON-LD's design is precisely "type in the context, bare string on the
  wire".
- (Also considered and declined: `format: "date"` anywhere — zero date-only values in the
  corpus and no field wants one; RFC 9557 IXDTF suffixes — `ajv-formats` rejects them outright,
  so adopting them would break the reference validator. `FIELDS.md` names IXDTF as the forward
  path and adopts nothing.)

### Question 2 — the type blocks

1. **2-A — status quo:** six sibling properties + the 93-line exclusivity `allOf`.
2. **2-B — `fundingDetails` selected by bare `if`/`then`** (no `oneOf`).
3. **2-C1 — `fundingDetails` as a `oneOf` tagged union**, required `const` tag inside each
   `$def`, plus a compact binding `allOf` keeping the inner tag equal to the top-level
   `fundingType`.
4. **2-C2 — as 2-C1 but without the binding `allOf`.**
5. **2-D — open key-value bag** + per-type shapes in a registry.
6. **2-E — top-level `oneOf`** of six `allOf`-composed opportunity variants.

#### Option 2-A — status quo

- Good, because it is free, and it has the cleanest error of any option on a typo'd field
  (one error: `/grant must NOT have additional properties`).
- Good, because it is the industrial pattern — Stripe's `payment_method` (68 sibling
  properties), Kubernetes volumes (17 type-specific fields), FHIR `value[x]`.
- Bad, because that industrial pattern is exactly what those systems' own tooling shows
  failing: Stripe's generated SDK is a flat all-optional interface that does not narrow;
  FHIR's official JSON Schema carries 13 optional `value*` siblings with no exclusivity
  construct at all; Kubernetes enforces exclusivity in the **server**, not the schema. The
  measured local evidence matches: `if (o.fundingType === "grant")` narrows nothing, and the
  exclusivity `allOf` is why the generated root type carries a `{[k: string]: unknown}` index
  signature (deleting it from a copy removes the signature — proven causation), which is why
  the API carries a hand-written `RemoveIndex<T>`.
- Bad, because it preserves a 93-line construct whose only job is enforcing an access pattern
  the system's own TypeScript, OpenAPI, database and ingest guard all refuse to model.

#### Option 2-B — `if`/`then` selection — rejected

- Bad, decisively: **codegen blindness.** `json-schema-to-typescript` does not read
  `if`/`then` at all (issue #426, open since 2021; the conditional subschema is discarded
  before inspection) — measured output: `fundingDetails: {}`, total loss of type information.
  `openapi-typescript` and `quicktype` do not implement it either, and `dependentSchemas`
  fails identically. Validation itself is fine; the tooling outcome disqualifies it.

#### Option 2-C1 — tagged `oneOf` with binding `allOf` (chosen)

- Good, because the inner tag is **structurally mandatory, not stylistic**: the six blocks are
  all-optional objects that overlap, so without a tag `{}` (26 exist in the corpus as empty
  grant blocks) matches five branches and `oneOf` fails. The `const` tag is what makes the
  branches disjoint — the same fact behind OAS's rule that `discriminator` cannot do
  validation work.
- Good, because it is measured-lossless: **0 of 68 documents change validity**; the 39
  valid documents were rewritten by a ~15-line script
  (`o.fundingDetails = {fundingType: t, ...o[t]}; delete o[t]`).
- Good, because the generated TypeScript becomes a real discriminated union —
  `fundingDetails: GrantDetails | … | RFPDetails`, each branch carrying its literal
  `fundingType` — which narrows on `fundingDetails.fundingType`. `openapi-typescript`'s own
  documentation uses exactly this before/after pair as its ❌/✅ example.
- Good, because the 93-line exclusivity `allOf` collapses to a compact binding (279 → 122
  normalised lines), and "two type blocks at once" stops being a rule the schema enforces and
  becomes **a shape the schema cannot represent** — the strictly better kind of guarantee.
- Good, because form derivability improves: `schema.properties.fundingDetails.oneOf[i].$ref`
  plus each `$def`'s `properties.fundingType.const` is self-describing, and per-branch `const`
  tags are the fast path RJSF and JSONForms render natively (`if`/`then` is the one shape
  neither handles reliably).
- Bad — **the one genuine regression**: error quality on a typo'd detail field drops from one
  clean message to a `oneOf` error explosion (with `allErrors`, one failure per non-matching
  branch plus the `oneOf` summary) — precisely the cost the JSON Schema org's
  `propertyDependencies` ADR names for this pattern. The fix belongs in the reference
  validator's own error layer (`packages/validate/src/errors.ts`): an `explainOneOf()` that
  reads `fundingDetails.fundingType` and keeps only the matching branch's errors, replacing
  the now-dead `explainNot()`. Ajv's opt-in `discriminator` keyword would also fix it but is
  an OpenAPI keyword, not JSON Schema — adding it would put a foreign vocabulary term in a
  normative artifact and violate the repo's only-`x-`-prefixed-extensions rule. Keep the
  schema pure; fix errors in our own tooling.
- Bad, because quicktype consumers get no narrowing benefit — quicktype collapses `oneOf`
  into a single all-optional interface (open issues since 2019). They degrade to the shape
  they had, no worse, but the union's benefit is not universal.

#### Option 2-C2 — no binding `allOf` — rejected

- Bad, because it opens a hole the status quo did not have:
  `{"fundingType": "grant", "fundingDetails": {"fundingType": "hackathon", …}}` would
  validate, and because the API filters on a column derived from the top-level tag while
  serving `fundingDetails` from stored `typeData`, a consumer querying `?fundingType=grant`
  could receive a hackathon-shaped payload. RFC 3339 §5.4's warning generalises: redundant
  information introduces the possibility that it will not correlate. Pay the 122 lines.

#### Option 2-D — open bag + registry — rejected, on four independent grounds

- Bad, because the meta-schema — itself normative — pins the top level closed with the stated
  note that there is no extension mechanism; 2-D requires rewriting it.
- Bad, because the registry format structurally cannot carry shapes: `entry.schema.json` is a
  flat value vocabulary with no way to express types, enums or required-ness. 2-D means
  inventing a second registry format that is a schema language — relocating the complexity,
  not removing it.
- Bad, because **this experiment already ran here and was reversed**: ADR-0004 removed
  `extensions` and retired the eligibility registry with the finding "the half-structure was
  worse than either endpoint" and "an open bag on a closed core is where removed fields go to
  survive their own removal". 2-D is that decision, reversed on no new evidence. (DAOIP-5,
  the named peer, is pattern (d) without even a registry — a 31-value mechanism enum with
  zero mechanism-specific fields — and this standard is deliberately ahead of it here.)
- Bad, because it discards real data description: 24 of 28 example detail blocks carry at
  least one non-null value. Measured generated type: `fundingDetails?: {[k: string]: unknown}`
  — zero validation, zero form derivation, zero static typing.

#### Option 2-E — top-level `oneOf` of composed variants — rejected

- Bad, measured worst on every axis: per-branch properties vanish from the generated types
  entirely (`GrantOpportunity = OpportunityCore`), five errors on a simple failure, and it
  requires `unevaluatedProperties`, which is outside the repo's allowed-keyword set and which
  the schema's own root `$comment` explicitly declines.

*(Also noted, not chosen: 2-F, a closed union plus an open `extensions` sidecar — the
legitimate industrial complement (FHIR `Extension`, DAOIP-5 `extensions`) — is out of scope
because ADR-0004 removed `extensions` deliberately, in this same revision window, on reasoning
this record has no new evidence against; reversing that is a separate decision. And the free
fallback if 2-C1 had been declined — a hand-written `TypedOpportunity` mapped type in
`src/types.ts` — is subsumed by the union.)*

## Decision outcome

**Chosen: Option 1-C and Option 2-C1, in one batch, in the ADR-0004 draft-revision window.**

| # | Decision |
|---|---|
| 1 | **All seven `date-time` sites gain `"pattern": "Z$"`** — UTC with trailing uppercase `Z` is mandatory. Descriptions name RFC 3339 + UTC precisely; `FIELDS.md` states the profile once ("RFC 3339, not 'ISO 8601'"), including the sortability consequence and the deliberate non-representability of local time (per ADR-0002 #9, whose reasoning is now enforced rather than merely documented). |
| 2 | **No structured date object, no shared `$def`, no `format: "date"`, no IXDTF.** One hand-written `Timestamp` alias (`string \| null`) is exported from the curated `src/types.ts`; a CI test asserts every `date-time` declaration in the schema is byte-identical. New conformance case `fail/opensat-non-utc-offset.json` pins the `Z` mandate. |
| 3 | **The six sibling type-block properties and the 93-line exclusivity `allOf` are removed.** A required **`fundingDetails`** property replaces them: a `oneOf` over the six unchanged detail `$defs`. |
| 4 | **Each detail `$def` gains a required `fundingType` `const` tag** as its first property — the branches are disjoint and self-describing. A compact six-branch binding `allOf` keeps the inner tag equal to the top-level `fundingType`, so the two can never disagree. |
| 5 | **The `opportunity[opportunity.fundingType]` guarantee (ADR-0002 #3) is superseded** by `opportunity.fundingDetails`, self-described by its tag. Consumers dispatch on either tag; the two are schema-bound to agree. |
| 6 | **Corpus and suite move in lockstep:** 39 valid documents script-rewritten (lossless, 0 validity changes); the six `missing-matching-type-block-*` fail cases collapse to one `missing-fundingdetails`; `one-block-per-fundingtype` is retired as unrepresentable; `fundingdetails-tag-mismatch` and `fundingdetails-missing-tag` are added. Fail suite 29 → 26. |

## Consequences

- **Good:** the discriminator promise is upgraded from runtime-only to compile-time — the
  generated `fundingDetails` is a real discriminated union; carrying two type blocks is now
  unrepresentable rather than forbidden; the schema sheds 157 normalised lines of `allOf`; the
  timestamp profile is exact, CI-guarded, and matches what 100% of the corpus already did;
  string sort order is chronological by construction.
- **Good:** downstream simplifications become possible: `assertSingleTypeBlock()` and the
  API summary projection's six-key `Omit` lose their reason to exist, and the OpenAPI
  components can model one `fundingDetails` property instead of six optional blocks.
- **Bad — error verbosity, named honestly:** the `oneOf` error explosion is real (a typo'd
  detail field yields a dozen-plus raw ajv errors under `allErrors` where the old shape yielded
  one) and is the accepted price of the pattern. It is paid down in the same batch in
  `packages/validate/src/errors.ts` — `explainOneOf()` reads the instance's
  `fundingDetails.fundingType` tag and keeps only the matching branch's errors, replacing the
  retired `explainNot()` — in the reference validator, where error taste belongs, not in the
  schema. The cost that remains: any consumer reading **raw** ajv output, or validating with
  another implementation, sees the full branch fan-out; the suite asserts nothing about error
  texts, so conformance is unaffected.
- **Bad — fourth corpus touch in roughly ten days** (re-cut 2026-07-27, corrections
  2026-08-05, second revision 2026-08-05, this). That churn is a real cost, it was the
  strongest argument for doing nothing, and it is bounded: the window that permits it closes
  at `FROZEN`, permanently.
- **Bad:** quicktype-based consumers get no narrowing benefit — `oneOf` collapses to an
  all-optional interface there. No worse than before, but the headline type-safety gain is
  toolchain-dependent.
- **Bad — a memo prediction that did not materialise, recorded rather than repeated:** the
  root `{[k: string]: unknown}` index signature on the generated type **persists**, because
  the compact binding `allOf` trips `json-schema-to-typescript` the same way the old
  exclusivity `allOf` did. The API's `RemoveIndex<T>` workaround therefore stays. The union
  gain is real; the index-signature removal is not.
- **Bad:** breaking for instances, both ways of the bidirectional rule: previously-valid
  documents with sibling blocks or non-`Z` offsets now fail; the old shape cannot be emitted
  at all. `specVersion` stays `1.0.0`; the field-mapping table in `CHANGELOG.md` is the
  migration record.
- **Neutral:** the per-type knowledge itself — 421 lines of detail `$defs` — moves nowhere,
  because nothing safe can move it: the registries structurally cannot carry shapes and the
  open bag was rejected. The instinct that motivated question 2 is answered at the `allOf`,
  not at the `$defs`.

## Follow-ups

- **Validator lockstep (done in this batch):** `explainOneOf()` replaces `explainNot()` in
  `packages/validate/src/errors.ts` (the old `#/allOf/*/then/not` path can never match again —
  no `not` remains anywhere in the schema), the error tests move with it, and the date-time
  uniformity CI test ("every `format: date-time` declaration is byte-identical") lands in
  `standard-artifacts.test.ts` — that test, not a shared `$ref`, is what makes the seven
  inline sites a single point of truth.
- **API lockstep (done in this batch):** `opportunity.mapper.ts` emits
  `out.fundingDetails = {fundingType: row.fundingType, ...row.typeData}` and the summary
  projection's `Omit` drops to the one `fundingDetails` key; `openapi/schemas.ts` derives one
  `fundingDetails` property instead of six optional blocks. No database migration: `typeData`
  jsonb was already exactly this shape.
- `adr/README.md` gains a 0005 index row; ADR-0002's status line gains "#3 superseded by
  ADR-0005" — per the amendment rule, only the status line moves.
- **Open question for the first external consumer:** whether anyone downstream generates
  types with quicktype (which collapses the union). If so, the narrowing benefit needs a
  documented alternative (the published `DetailsByFundingType` map in `src/types.ts`).
- Promotion to `stable` lands `FROZEN` and ends the in-place era this ADR's permission rests
  on — unchanged from ADR-0004's follow-up, restated because this record extends the same
  window.
