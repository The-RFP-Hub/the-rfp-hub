# Changelog — RFP Hub Standard

This file records changes to the **standard** (the schema, the context, and the artifacts
governed by them). It is not the npm package's release log: package version and spec version
are separate axes, and only the spec version is tracked here.

Entries are grouped **Schema / Context / Tooling / Docs**.

---

## Spec v1.0.0 fourth draft revision (2026-08-10)

Rides the same draft-window permission argued in
[`adr/0004`](../../adr/0004-second-draft-revision-org-swap-and-closure.md): `v1.0.0` is still
`draft` and no external consumer has adopted it, re-verified at merge. The structural record is
[`adr/0007`](../../adr/0007-security-bounty-payout-tiers.md).

The `bounty` type described "a single scoped task with a stated reward". Measured against a
public corpus of 247 live crypto bug bounty programs, **3 were representable** under that
shape. The rest publish a graded table — a median of four rows, keyed on severity and on the
class of in-scope asset — so a publisher forced into one `reward` number enters the maximum,
which is the budget-honesty failure the standard separates `budget` from `maxAward` to avoid.

### Schema

- **Breaking — tightening.** `bounty.bountyKind` is a **new required** property, enum
  `task | security`. Every bounty document valid under the previous shape is now invalid until
  it carries the tag. Migration: add `"bountyKind": "task"` — the previous shape *was* a task
  bounty in everything but name.
- **Breaking — loosening** (previously invalid documents now validate). `bounty.reward` is no
  longer unconditionally required. It is required when `bountyKind` is `task`, and a security
  bounty carries `rewardTiers` instead. Enforced by a bare `if`/`then`/`else` on `$defs/bounty`.
- **Breaking — loosenings.** New optional properties on `$defs/bounty`: `rewardTiers[]`,
  `severityScheme`, `rewardPoolStatus`. Every object in this schema is
  `additionalProperties: false`, so each addition turns previously-rejected documents into
  valid ones — breaking under the bidirectional rule in [`PROCESS.md`](./PROCESS.md), which
  governs over the "new optional fields" bullet in that file's Consequences list.
- **New `$defs`.** `rewardTier` (`severity`, `assetType`, `label`, and a required `payout`) and
  `payout` (a `model` tag over `fixed | range | up_to | percentage_of_value_at_risk |
  discretionary`, with the amounts each model requires bound by a nested `if`/`then`/`else`).
- `rewardTiers[]` is **required for `security` and permitted on either kind**. Requiring it on
  one kind is not a reason to forbid it on the other: a task bounty with a placement ladder is
  the same graded structure keyed on `label` instead of `severity`.
- `discretionary` is a **payout model, not absent data** — programs publish numeric and
  case-by-case tiers in one table.
- **The model is an exclusive discriminator.** Each branch both requires the amounts its model
  needs and forbids those belonging to the others, so `{"model": "discretionary", "amount": 1}`
  and `{"model": "fixed", "amount": 10, "max": 99}` do not validate. A first cut only required
  the applicable fields, which left the tag advisory and contradicted this entry — caught in
  review.
- **A security bounty may not carry the scalar `reward` at all.** Requiring `rewardTiers`
  without forbidding `reward` still permitted the misleading maximum headline the tier table
  exists to prevent.
- **Stability.** The whole surface lands `x-stability: provisional`. It has a measured
  publisher corpus and no shipped consumer, and the gate in `PROCESS.md` asks for both.
- **Not modelled, deliberately**: step functions over funds at risk, TVL-conditional tiers,
  conditional pool release, per-tier vesting and multipliers. See the design rule recorded in
  [`FIELDS.md`](./schemas/v1.0.0/FIELDS.md) and ADR-0007.
- **Authoring note.** Both new conditionals are written as bare `if`/`then`/`else` rather than
  an `allOf` of branches. An `allOf` at `$def` level defeats the type generator, which emits an
  index signature in place of the interface — caught in review, recorded here so it is not
  reintroduced.

### Context

- New terms: `rewardTiers` (`@set`), `bountyKind`, `severityScheme`, `rewardPoolStatus`. No
  existing term assignment moved. Neither schema.org nor DAOIP-5 offers a target for a tiered
  award, so these take IRIs in the standard's own vocabulary — see
  [`CROSSWALK.md`](./schemas/v1.0.0/CROSSWALK.md).

### Tooling

- Two new registries: `bounty-severities.json` (`critical | high | medium | low |
  informational`) and `bounty-asset-types.json` (`smart_contract | blockchain_dlt |
  websites_and_applications`). Both govern **open** string fields — an unregistered value is
  valid data and warns, as with every registry here. Closed enums were rejected: the observed
  vocabularies are one platform's, and a closed list would put that platform's labels in a
  source-agnostic standard.
- `codegen.mjs`: `DEF_ORDER` gains `rewardTier` and `payout`; `REGISTRY_FOR_FIELD` gains the
  two new registry bindings.
- Both registries are bundled by the package (`registries`, `isRegistered`, `activeValues`)
  and enforced by two new advisory checks, `unregistered-tier-severity` and
  `unregistered-tier-asset-type`. Registering a vocabulary without wiring the warning would
  have made this entry's "an unregistered value warns" claim false.
- `rfphub-validate`: the `amount-without-currency` advisory now traverses every
  `rewardTiers[].payout` bound (`amount`, `min`, `max`, `floor`, `cap`). A tier's `percent` is
  **not** a denominated site — it is a share, not an amount.
- New advisory check `payout-bounds-inverted`: `min` above `max`, or `floor` above `cap`,
  describes a tier nobody can be paid under. JSON Schema cannot compare sibling values, so the
  advisory tier is the only place the rule can live.
- The generated field tables now render `maximum`, so `percent` documents its 0–100 bound
  instead of appearing unbounded above.
- Conformance: 3 new `pass/` and 12 new `fail/` cases, one per rule changed. Each `fail/` case
  was verified to fail for its **named** rule alone — two of the first cut were rejected by a
  second, unrelated constraint, which would have let an implementation ignore the rule the
  filename advertises and still pass the suite.

### Docs

- `FIELDS.md` gains a hand section on the two kinds and on what the tier table deliberately
  cannot say; the single-currency narrative now enumerates **seven** denominated sites.
- `STATUS.md`, `PROCESS.md`: the `provisional` stage, emptied on 2026-08-05, is refilled.
- `NORMATIVE.md`, `ARTIFACTS.md`, `README.md`: two registries become four.

### Field mapping (old → new)

| Old | New | Kind | Notes |
|---|---|---|---|
| `bounty.reward` (always required) | `bounty.reward` (required when `bountyKind` is `task`) | reshaped | Migrate a task bounty by adding `"bountyKind": "task"`; the value is untouched. |
| — | `bounty.bountyKind` | added, **required** | No default. A document without it does not validate. |
| — | `bounty.rewardTiers[]` | added | Required when `bountyKind` is `security`; permitted on either kind. |
| `bounty.reward` (valid on any bounty) | `bounty.reward` (forbidden when `bountyKind` is `security`) | tightened | A graded program states its amounts in the table only. |
| — | `bounty.severityScheme`, `bounty.rewardPoolStatus` | added | Optional on either kind. |

---

## Spec v1.0.0 third draft revision (2026-08-05)

**Same day as the second draft revision, applied after it** — two revision batches landed on
2026-08-05, and this entry sits above the second because entries are ordered
newest-change-first, not because the date differs. Both ride the same draft-window permission
argued in [`adr/0004`](../../adr/0004-second-draft-revision-org-swap-and-closure.md); the
structural records for **this** batch are
[`adr/0005`](../../adr/0005-third-draft-revision-utc-timestamps-and-tagged-funding-details.md),
which supersedes ADR-0002 #3 (the `opportunity[opportunity.fundingType]` access pattern), and
[`adr/0006`](../../adr/0006-document-wide-single-currency.md), which supersedes ADR-0002 #17
(the envelope-only scoping of the single-currency rule — every monetary amount is now
denominated in the document-wide `fundingInfo.currency`). A
document valid against this morning's second-revision bytes is **not** necessarily valid
against these.

Every change below is listed under the bidirectional definition in `PROCESS.md`.

### Schema

**Breaking — tightenings** (previously valid documents now fail):

- **All seven `date-time` sites gain `"pattern": "Z$"`** (`opensAt`, `postedAt`, `createdAt`,
  `updatedAt`, `deadlines[].date`, `source.submittedAt`, `source.verifiedAt`): every temporal
  value must be an RFC 3339 `date-time` in UTC with a trailing uppercase `Z`. A previously
  valid document carrying `+02:00`, the `-00:00` unknown-offset convention, or lowercase
  `t`/`z` now fails. Zero committed documents were affected — all 182 temporal values in the
  corpus already complied.
- **`fundingDetails` is required**, joining the required set after `source`. A document
  without it — including every document in the old six-sibling-block shape — now fails.
- **Each detail shape requires its `fundingType` tag** (`const`, first property): a details
  object without the tag, or with a tag naming a different shape than the top-level
  `fundingType`, now fails. (For a `bounty`, `reward` remains required alongside the tag.)
- **The per-type currency keys are removed** ([`adr/0006`](../../adr/0006-document-wide-single-currency.md)):
  `hackathon.prizes[].currency` and `vc_fund.checkSize.currency` no longer exist, and because
  the objects that carried them are closed, a document still carrying one now fails on
  `additionalProperties`. `fundingInfo.currency` denominates **every** monetary amount in the
  document — the envelope amounts, `milestones[].amount`, the bounty `reward`, each
  `prizes[].amount`, the accelerator `funding` and the `checkSize` bounds. The denomination
  rule still crosses objects, so it remains schema-unenforceable; the advisory tier warns
  (see Tooling).

**Breaking — structural** (the shape itself moves; breaking for instances in both directions):

- **The six top-level type-block properties (`grant`, `hackathon`, `bounty`, `accelerator`,
  `vc_fund`, `rfp`) are removed**, together with the 93-line six-branch exclusivity `allOf`
  that enforced one-matching-block. They are replaced by **`fundingDetails`**: a `oneOf` over
  the six unchanged detail `$defs`, each now self-described by its required `fundingType`
  `const` tag, with a compact binding `allOf` keeping the inner tag equal to the top-level
  `fundingType`. An old-shape document fails on **`additionalProperties`** (its sibling block
  is an unknown key) **and** the missing required `fundingDetails`. Carrying two type blocks
  stops being a rule the schema enforces and becomes a shape it cannot represent.
- The `opportunity[opportunity.fundingType]` guarantee is **superseded**: the details now live
  at `opportunity.fundingDetails`, and `fundingDetails.fundingType` names the shape.
  Consumers may dispatch on either tag; the binding `allOf` guarantees they agree.
- **`bounty.reward` and `accelerator.funding` change shape** with the currency unification:
  the inlined `{amount, currency}` objects (both properties required) become a **plain
  required number** (`reward`) and a **plain nullable number** (`funding`), denominated in
  `fundingInfo.currency`. Breaking in both directions: the old object shape no longer
  validates, and the new number shape was previously invalid. Bounty's required-reward
  guarantee is unchanged.

### Context

- The six type-block terms are removed with their properties (the orphan-term drift check
  forces it); **`fundingDetails`** is added, resolving in the RFP Hub vocabulary. The
  `accelerator`-scoped `funding → schema:amount` mapping (introduced in the second revision)
  is re-homed under `fundingDetails`'s property-scoped context, where the accelerator payload
  now lives. All other nested terms (`fundingMechanisms → daoip5:grantFundingMechanism`,
  `tracks`, `prizes`, …) are top-level context terms and keep working at the new depth
  unchanged.
- The currency unification needs no context change: the `currency → schema:currency` term now
  has exactly one instantiation site (`fundingInfo.currency`), and the `amount → schema:value`
  term continues to cover milestone and prize amounts. The removed per-type currency keys
  simply stop instantiating the shared term.

### Tooling

- **Generated TypeScript**: `fundingDetails` is a **real discriminated union**
  (`GrantDetails | HackathonDetails | BountyDetails | AcceleratorDetails | VCFundDetails |
  RFPDetails`, each carrying its literal `fundingType`), so
  `if (o.fundingDetails.fundingType === "grant")` finally narrows — the ADR-0002 #3 promise,
  upgraded from runtime to compile time. Honest caveat from `adr/0005`: the root
  `{[k: string]: unknown}` index signature **persists** (the binding `allOf` trips
  `json-schema-to-typescript` as the old `allOf` did), so consumers keeping an index-free
  view still need a `RemoveIndex`-style helper.
- Package API (npm axis, semver-major for `@the-rfp-hub/standard`): new `Timestamp`
  (`string | null`) and `FundingDetails` (`Opportunity["fundingDetails"]`) type exports;
  `DetailsByFundingType` survives with its docs rewritten for the tagged shape; the generated
  `Opportunity` type follows every schema change above, including the currency unification —
  `reward` and `funding` become plain number types, and the generated `Prize` and `AmountRange`
  shapes lose their `currency` members.
- `codegen.mjs`: `typeExpr()` gains a `oneOf` branch (renders the union in the `FIELDS.md`
  tables); the conditionally-required annotation machinery stays but currently marks nothing —
  `fundingDetails` is unconditionally required.
- **Conformance suite: 29 fail cases become 27.** The six `missing-matching-type-block-*`
  cases collapse into one `missing-fundingdetails`; `one-block-per-fundingtype` is **retired
  as unrepresentable** (there is no second slot to fill); new cases pin the tag rules
  (`fundingdetails-tag-mismatch`, `fundingdetails-missing-tag`), the UTC mandate
  (`opensat-non-utc-offset` — a valid RFC 3339 offset form that must now be rejected), and the
  document-wide currency rule (`prize-with-currency` — a prize carrying its own `currency` key
  fails on `additionalProperties`).
  The 11 pass cases are unchanged in count and filename; every document in `pass/` and
  `examples/` was rewritten to the `fundingDetails` shape by script
  (`o.fundingDetails = {fundingType: t, ...o[t]}`), losslessly — **0 of the 39 changed
  validity**, and no temporal value needed touching. The currency unification then rewrote the
  25 documents carrying per-type currency keys: each held exactly **one** distinct currency
  value, so it was hoisted into `fundingInfo.currency` (24 hoists — one document already named
  it there) and 97 per-type currency keys were stripped. **Zero conflicts existed** in the
  corpus; the conversion is lossless.
- `rfphub-validate`: the failure texture changes — old-shape documents now report
  `additionalProperties` + missing `fundingDetails` instead of the retired one-block rule.
  `humanizeErrors` gains tag-aware `oneOf` filtering (`explainOneOf()`: the instance's
  `fundingDetails.fundingType` tag selects the one branch whose errors are reported, and a
  missing or mismatched tag is one line); `explainNot()` is deleted with the `not` construct
  it explained — no `not` remains anywhere in the schema. A new CI test pins all seven
  `date-time` declarations byte-identical, the equality guard that makes the inline
  declarations a single point of truth without a shared `$ref`. Consumers reading **raw** ajv
  errors still see the full `oneOf` branch fan-out — an accepted cost recorded in `adr/0005`.
  The **milestone-amount advisory check generalises** with the currency unification: it now
  warns on *any* monetary amount present without a `fundingInfo.currency` to denominate it —
  the envelope's own amounts, milestone amounts, and the `fundingDetails` amounts (reward,
  prize amounts, accelerator funding, checkSize bounds) — since the document-wide rule crosses
  objects at every site and warning remains its only enforcement. Consumers filtering on the
  old milestone-scoped warning code should switch to the generalised one.

### Docs

- `FIELDS.md` hand sections: the one-line "RFC 3339 / ISO 8601" claim is replaced by a real
  **Dates and times** convention section (RFC 3339 is a *profile* of ISO 8601; UTC-`Z`
  mandatory; lexicographic sort is chronological; local time deliberately unrepresentable;
  IXDTF named as future work, not adopted), the type-block narrative is rewritten for
  `fundingDetails` self-description, and the "single currency — envelope only" section becomes
  the **document-wide** rule, naming all six denominated sites. `CROSSWALK.md` re-keys the
  detail-payload rows and its JSON-LD worked example, and re-words its money rows for the
  plain-number amounts; `BENCHMARK.md` records the third (scripted, lossless) conversion and
  the currency hoist; `STATUS.md` gains the third-revision row and paragraph; both package
  READMEs move their examples to the new shape.
- The structural records are
  [`adr/0005`](../../adr/0005-third-draft-revision-utc-timestamps-and-tagged-funding-details.md):
  the survey evidence (every modern standard uses RFC 3339 strings; RFC 8984 §1.4 and AS2 §2.3
  state the identical `Z` rule), the rejected options (structured date object, shared
  timestamp `$def`, `if`/`then` selection, open bag, top-level `oneOf`), and the accepted
  costs — `oneOf` error verbosity, a fourth corpus touch in ten days, no narrowing gain for
  quicktype consumers — and
  [`adr/0006`](../../adr/0006-document-wide-single-currency.md): the corpus evidence for the
  document-wide currency (zero mismatches, 24 hoists), the rejected options (keep the
  envelope-only scoping; per-amount currency objects), and the accepted cost — a prize pool or
  reward can no longer be denominated differently from the programme budget.

#### Field mapping (old → new) — third draft revision

Continues the two tables below; the same rule applies — **no row is ever removed.** A reader
holding older data chains the earlier tables' rows through these.

| Old | New | Kind | Note |
|---|---|---|---|
| `grant` (sibling block) | `fundingDetails` with `fundingType: "grant"` | reshaped | Same fields, one new required tag. Migrate: `fundingDetails = {fundingType: "grant", ...grant}`, delete the sibling. |
| `hackathon` (sibling block) | `fundingDetails` with `fundingType: "hackathon"` | reshaped | Same recipe. Nested paths move (`hackathon.prizes` → `fundingDetails.prizes`, …). |
| `bounty` (sibling block) | `fundingDetails` with `fundingType: "bounty"` | reshaped | Same recipe; `reward` stays required (`fundingDetails.reward`). |
| `accelerator` (sibling block) | `fundingDetails` with `fundingType: "accelerator"` | reshaped | Same recipe; `accelerator.funding` → `fundingDetails.funding`, its JSON-LD mapping re-homed with it. |
| `vc_fund` (sibling block) | `fundingDetails` with `fundingType: "vc_fund"` | reshaped | Same recipe. |
| `rfp` (sibling block) | `fundingDetails` with `fundingType: "rfp"` | reshaped | Same recipe (`rfp.scope` → `fundingDetails.scope`, `rfp.requirements` → `fundingDetails.requirements`). |
| `opensAt` / `postedAt` / `createdAt` / `updatedAt` / `deadlines[].date` / `source.submittedAt` / `source.verifiedAt` (any RFC 3339 offset) | same fields, **UTC `Z` mandatory** (`pattern: "Z$"`) | tightened | A value with a numeric offset must be converted to UTC (`2026-08-15T23:59:59+02:00` → `2026-08-15T21:59:59Z`); lowercase `z` must be uppercased. `null` semantics unchanged. |
| `bounty.reward` (`{amount, currency}`, both required) | `fundingDetails.reward` (plain required number) | reshaped | [`adr/0006`](../../adr/0006-document-wide-single-currency.md). Migrate: `reward = reward.amount`, hoist the currency into `fundingInfo.currency`. Denominated in the document-wide currency; the old object shape no longer validates. |
| `hackathon.prizes[].currency` | — (hoisted into `fundingInfo.currency`) | removed | Entries become `{track, amount}`; a stray `currency` key fails on `additionalProperties` (`fail/prize-with-currency.json`). Prizes denominated differently from the envelope are inexpressible — split into per-currency documents or convert. |
| `accelerator.funding` (`{amount, currency}`, both required) | `fundingDetails.funding` (plain nullable number) | reshaped | Same recipe as `reward`: `funding = funding.amount`, hoist the currency. The JSON-LD `funding → schema:amount` scoped mapping is unchanged. |
| `vc_fund.checkSize.currency` | — (hoisted into `fundingInfo.currency`) | removed | `checkSize` becomes `{min, max}`; a stray `currency` key fails on `additionalProperties`. |

## Spec v1.0.0 second draft revision (2026-08-05)

*(Ordering note: a third draft revision landed later the same day — it is the entry above.
This entry describes the state between the two.)*

**Draft v1.0.0 was revised in place a second time.** The 2026-07-27 entry below says
"in-place re-cuts end here"; that sentence is not edited and is not quietly ignored — it is
superseded, on the record, by [`adr/0004`](../../adr/0004-second-draft-revision-org-swap-and-closure.md).
The short form: the vow governed re-cutting bytes that had been published as final; this
revision exercises the standing `PROCESS.md` rule that a version directory may be edited in
place **only while its maturity is `draft` and no external consumer has adopted it**. Both
conditions hold (maturity `draft`, zero known adopters), one leg of the original basis does
not (the npm package is published now, at 1.0.x), and the whole permission ends at promotion
to `stable`, when the `FROZEN` marker lands. A document valid against the 2026-07-27 bytes is
**not** valid against these.

Every change below is listed under the bidirectional definition in `PROCESS.md` — removals
**and** loosenings both count as breaking.

### Schema

**Breaking — tightenings** (previously valid documents now fail):

- `operatingOrganizations` is now **required, `minItems: 1`, and the primary array**: `[0]` is
  the primary/display organisation, including the issuing organisation of an `rfp`. A document
  without it — every document under the previous shape's common case — no longer validates.
- `networks` **removed**. The top level is closed, so a document carrying it now fails rather
  than being ignored. No successor; `ecosystems` is the nearest concept.
- `tags` **removed**. Same mechanics. No successor; `categories` is the nearest concept.
- `extensions` **removed, and nothing replaces it**. The top level is now fully closed with
  **no extension mechanism** — a new field requires a spec release. This retracts the
  2026-07-27 promise that the one non-zero `funding.awardsToDate` was "rehomed rather than
  lost" under `extensions`: **that value is now lost.**
- `eligibility` no longer accepts an object — the open key→value map is gone (see also the
  loosening half below).
- `socialLinks` reshaped: the platform-keyed object (`{twitter?, discord?, …}`) becomes an
  **array of `{platform, url}` entries** (`$defs/socialLink`; `platform` a required seven-value
  enum, `url` a required URI, `uniqueItems` on whole entries). Old-shape objects fail; the new
  shape can express what the old could not — several URLs on one platform.
- `organization.slug` is **required and non-null** (it is the organisation's namespace). Every
  organisation object without one — most of the previous corpus — now fails.
- `organization.type` → `orgType`, and `null` is dropped from both the type union and the
  enum. An org carrying the old key, or `"type": null`, now fails; absence remains valid.
- `deadlines[].type` → `deadlineType` (property, `required`, `if`/`then` and examples). Old
  deadline entries fail on the unknown key **and** the missing required one.
- `resourceLinks` → `additionalReferences` (pure rename; still one free-form string).
- `funding` → `fundingInfo` (pure rename; nested paths follow — `fundingInfo.currency`, etc.
  `accelerator.funding` keeps its name and is not this field).

**Breaking — loosenings** (previously invalid documents now validate):

- `sponsoringOrganizations` is now **optional** (was required, `minItems: 1`, `[0]` primary).
  A document that omits it — previously a hard failure — now validates. Its `[0]`-is-primary
  semantics move to `operatingOrganizations`; it remains the issuer/backer, not necessarily
  the source of funds.
- `eligibility` **accepts free text** (`string | null`) — a string here used to be rejected.
  Deliberately unstructured: for reading, not faceting. The `eligibility-keys` registry is
  retired with the shape (see Tooling).

**Not breaking for instances** (validation is byte-identical; package-axis only):

- `$defs/monetaryAmount` removed; its `{amount, currency}` shape (both required) is **inlined**
  at its two use sites, `bounty.reward` and `accelerator.funding`. Bounty's required-reward
  guarantee and the envelope-only single-currency scoping are unchanged.
- `$defs/socialLinks` → `$defs/socialLink` — the def rename half of the socialLinks change;
  instances never reference `$defs` names.

**Stability promotions (not breaking — annotations only, validation byte-identical):**
`serviceAgreement`, `milestones[]` and `programModel` lose their `x-stability: provisional`
markers and become `stable` — the last provisional fields in the schema. The promotion gate
asks that the field be verified beyond its original narrow evidence; the maintainers accepted
the M1 research round as that verification: all three trace to the decision interviews, and
`milestones[]` additionally to the real third-party RFP that motivated it. From this date the
three carry the full stable warranty — changing or removing them takes a new spec version.

**Also:** with `organization.type` → `orgType` and `deadline.type` → `deadlineType`, the
rename family that began with `type` → `fundingType` is complete — **no property named `type`
remains anywhere in the schema.** And `specVersion` stays `const: "1.0.0"`: the spec axis does
not move for a draft revision (that is what this entry's title records).

### Context

- Terms for the removed fields deleted: `networks`, `tags`, and `extensions` — the latter was
  the standard's only 1:1 same-name DAOIP-5 mapping (`daoip5:extensions`), and that alignment
  point is lost with it.
- `resourceLinks` → `additionalReferences` (still `schema:citation`); `funding` → `fundingInfo`
  (still `schema:amount`). The stale `funding` term was removed by hand: the context-drift
  check cannot catch it because `accelerator.funding` keeps that property name alive in the
  schema. `accelerator` gains a property-scoped context preserving its `funding → schema:amount`
  mapping, which previously rode on the shared top-level term.
- `socialLinks` gains a property-scoped context for the new entry shape: each entry's `url`
  maps to `schema:url` (typed `@id`); `platform` resolves in the RFP Hub vocabulary. The old
  keyed object mapped to nothing per-link.
- The organisation terms **do not move**: `sponsoringOrganizations → schema:funder` (clean),
  `operatingOrganizations → schema:sponsor` (loose). The role swap therefore puts the loose
  mapping on the required primary array and the clean `funder` mapping on an optional one — an
  accepted cost, argued in `CROSSWALK.md` and `adr/0004`.

### Tooling

- **`registries/eligibility-keys.json` is deleted — the registry is retired**, not
  entry-deprecated: its governed field no longer exists, no successor values can exist for
  `replacedBy` to point at, and codegen rejects a registry that governs no field. The
  never-delete rule governs *entries*; a new `PROCESS.md` rule records the precedent: **a
  registry may be retired only while its governing spec version is `draft`.** The six retired
  key definitions (`stage`, `geography`, `jurisdiction`, `sector`, `entityType`, `compliance`)
  remain recoverable from git history and this record. `registries/index.json` regenerated to
  the two remaining vocabularies.
- Package API (npm axis, semver-major for `@the-rfp-hub/standard`): `RegistryName` narrows to
  `"deadline-labels" | "program-models"`; the `MonetaryAmount` type export is removed; the
  `SocialLinks` type becomes `SocialLink` (one entry); `DeadlineType` re-derives from
  `deadlineType`; the generated `Opportunity` type follows every schema change above.
- `codegen.mjs`: `REGISTRY_FOR_FIELD` drops `eligibility`; `DEF_ORDER` follows the def
  rename/removal. The meta-schema's stated rationale for `additionalProperties: false` is
  rewritten — it used to say instances extend through `extensions`; it now says there is no
  extension mechanism.
- `rfphub-validate`: the `unregistered-eligibility-key` advisory check is deleted (its subject
  is gone — external consumers filtering on that warning code lose it); the
  milestone-amount-without-currency check reads `fundingInfo.currency`.
- Conformance and examples move in lockstep in the same PR: the
  `empty-sponsoring-organizations` and `missing-sponsoring-organizations` fail cases are
  retired (those documents are now valid) and the guards move to new
  `empty-operating-organizations` / `missing-operating-organizations` cases; the eligibility
  fixture is re-cut for the string type (`eligibility-not-string`); new fail cases pin the
  slug requirement, the non-null `orgType` enum, the `deadlineType` enum and the
  `socialLink` entry shape; every fixture and example organisation gains a slug and every
  deadline entry the `deadlineType` key.

### Docs

- `FIELDS.md` hand sections, `CROSSWALK.md`, `BENCHMARK.md`, `STATUS.md`, `NORMATIVE.md`,
  `PROCESS.md` and both package READMEs updated for the new shape; `PROCESS.md` additionally
  gains the registry-retirement rule and loses the "belongs in `extensions`" remedy from the
  registration criteria (platform-specific values now simply do not belong in the standard —
  propose a field instead).
- The structural record is [`adr/0004`](../../adr/0004-second-draft-revision-org-swap-and-closure.md),
  which supersedes ADR-0002 decisions #11, #14, #21, #22 and the `monetaryAmount` def in part,
  and reconciles this revision with the once-only language on the record.

#### Field mapping (old → new) — second draft revision

Continues the 2026-07-27 table below; the same rule applies — **no row is ever removed.** A
reader holding 2026-07-27-shaped data chains that table's rows through these.

| Old | New | Kind | Note |
|---|---|---|---|
| `sponsoringOrganizations` (required, `minItems: 1`, `[0]` primary) | `sponsoringOrganizations` (optional) | reshaped | Role demoted: still the issuer/backer, no longer the primary array and no longer required. A loosening — breaking under the bidirectional rule. |
| `operatingOrganizations` (optional) | `operatingOrganizations` (required, `minItems: 1`, `[0]` primary/display) | reshaped | Role promoted: who runs the process is the entity consumers need. Migrating 2026-07-27 data: copy `sponsoringOrganizations[0]` here when no distinct operator is known. |
| `networks` | — | removed | No successor. Nearest concept is `ecosystems`; values were not folded. |
| `tags` | — | removed | No successor. Nearest concept is `categories`; fixture tag values were dropped, not folded. |
| `extensions` | — | removed | **No successor and no extension mechanism** — a new field requires a spec release. Retracts the 2026-07-27 note that `awardsToDate` was "rehomed rather than lost": it is lost. |
| `eligibility` (open key→value map) | `eligibility` (free text) | reshaped | **Semantics change.** A converter must flatten pairs into prose — lossy and one-way. The `eligibility-keys` registry is retired. |
| `resourceLinks` | `additionalReferences` | renamed | Pure rename; still deliberately one free-form string. |
| `funding` | `fundingInfo` | renamed | Pure rename; all nested paths follow (`funding.currency` → `fundingInfo.currency`, …). `accelerator.funding` is unaffected. |
| `socialLinks` (platform-keyed object) | `socialLinks[]` of `{platform, url}` | reshaped | One entry per link; `platform` is a closed enum, `url` required. Migrate each old key→value pair to one entry. |
| `organization.type` | `organization.orgType` | reshaped | Rename **and** `null` dropped from union and enum; still optional — absence is the unknown state. |
| `organization.slug` (optional, nullable) | `organization.slug` (required, non-null) | reshaped | Tightening: the slug is the organisation's namespace. |
| `deadlines[].type` | `deadlines[].deadlineType` | renamed | Completes the `type` rename family. The 2026-07-27 `closesAt` row's migration recipe now lands here: `[{deadlineType: "fixed", date, label: "application"}]`. |
| `$defs/monetaryAmount` | inlined at `bounty.reward`, `accelerator.funding` | removed (def) | Instance-invisible; `{amount, currency}` both stay required at both sites. Package-axis: the `MonetaryAmount` type export is gone. |

## v1.0.0 corrections while draft (2026-08-05)

The schema is byte-for-byte unchanged. Everything below is a correction to the artifacts
around it, made under the draft-maturity rule in `PROCESS.md` after a full compatibility
audit of the standard against its own claims.

- **Context** — `context.jsonld` de-aliased so that every target IRI has exactly one term per
  scope: organisation/contact `name`, deadline `label`, `source.originalId` and
  `source.submittedAt` moved into property-scoped contexts (JSON-LD 1.1); `amount` now maps to
  `schema:value` instead of colliding with `funding` on `schema:amount`; `socialLinks` (a
  platform-keyed object, never a valid `sameAs` value) and contact `telegram` (a handle, not a
  URL) moved to the RFP Hub vocabulary. Every array-valued field now carries `@container`
  (`tracks`, `prizes`, `skills`, `stages`, `portfolio` were missing theirs, so one-element
  arrays collapsed on compaction). Result, verified with jsonld.js over the full corpus:
  `expand` → `compact` reproduces every document's original shape and the output still
  validates against the schema. Previously compaction rewrote `title`→`name` and
  `funding`→`amount`, producing documents that violated the standard's own schema.
- **Conformance** — suite grown from 8 pass / 13 fail to **11 pass / 24 fail**. New pass
  cases exercise the previously untouched `vc_fund` block and the single-instance `bounty` and
  `accelerator` blocks. New fail cases assert `format` (`uri`, `date-time`, `email`) as a
  constraint, both `pattern` constraints (`id`, `organization.slug`), a `$defs` enum
  (`deadline.type`), and the missing-type-block rule for all five previously untested
  discriminator branches.
- **Tooling** — `check-spec` gains an **identity sweep**: any URL shaped like a spec
  identifier, anywhere in the package (fixtures, examples, doc prose), must agree with
  `spec.config.json`, closing the hand-written-copy gap a domain swap would have missed.
  The **spec-freeze gate** now covers a frozen version's `conformance/v*/` directory, the
  meta-schema, `registries/entry.schema.json`, and the identity fields of `spec.config.json`,
  and runs on pushes to `main` as a tripwire as well as on PRs.
- **Docs** — `CROSSWALK.md`: the reverse-direction completeness claim was false and is
  replaced by an explicit table of DAOIP-5 Grant Pool fields with no RFP Hub equivalent;
  DAOIP-5 mechanism values are now quoted as that spec spells them (`"Retro Funding"`, not
  `"Retroactive"`); documented that JSON-LD processing erases `null` (null-vs-absent is a
  JSON-Schema-layer distinction only). `BENCHMARK.md`: corrected the `deadlines[0]` statistic
  and the stale "future deadline" fixture note. `conformance/README.md`: corrected the
  reference-run path and documented the format-assertion requirement. ADR 0001 carries an
  erratum on its `$id`-path claim, and its follow-ups now record that `$id`/`@context`
  dereference.

## Spec v1.0.0 re-cut in place (2026-07-27)

**v1.0.0 was re-cut in place: the contents published under this version string differ from
those published before this date.** This is the one thing semantic versioning exists to
prevent, and it was done deliberately and once. The standard's initial milestone was never
declared complete and no external consumer had adopted the earlier shape, so a version bump
would have invented a migration story
nobody needed. **In-place re-cuts end here** — a second one would not be defensible.

- **Pre-re-cut bytes:** git tag `standard/spec-v1.0.0-precut-2026-07`, created before the first
  re-cut commit. That tag is the only way to recover the earlier shape.
- **Rationale and alternatives considered:** [`adr/0001-recut-v1.0.0-in-place.md`](../../adr/0001-recut-v1.0.0-in-place.md)
- **The field decisions themselves:** [`adr/0002-v-next-field-recut.md`](../../adr/0002-v-next-field-recut.md)
- **Field-by-field mapping:** the [Field mapping (old → new)](#field-mapping-old--new) table
  below. Rows are never removed from it — a field that disappeared from the schema keeps its
  row here permanently, because that row is what tells a reader holding pre-re-cut data what
  happened to it.

A document valid against the pre-re-cut schema is **not** valid against this one.

### Schema

**Renamed**

- `type` → `fundingType`. Same six-value structural discriminator; the invariant is now
  `opportunity[opportunity.fundingType]`.
- `funding.totalBudget` → `funding.budget`.
- `funding.amountDistributed` → `funding.allocated`. **Semantics change**, not just a rename:
  *distributed* → *committed to date*. `remaining` is derived as `budget − allocated` and never
  stored.
- `grant.fundingMechanism` (scalar enum) → `grant.fundingMechanisms` (array, `uniqueItems`),
  with `matching` added to the value set — mechanisms co-occur, and a single-valued enum
  recorded the fixed-grant-plus-matching-grant case wrongly.

**Removed**

- `organization` (superseded by `sponsoringOrganizations[]`).
- `source.url`, and the provenance `$def`'s `required: ["url"]`, not replaced. Link-back now
  runs through `applicationUrl` alone. Consequence, stated plainly: "every entry is traceable
  to an original posting" is now asserted by ingestion policy, not by validation.
- `closesAt` (superseded by `deadlines[]`).
- `funding.awardsToDate`.
- `rfp.issuingOrganization`, `rfp.budget`, `rfp.proposalDeadline`.
- `hackathon.registrationDeadline`, `hackathon.submissionDeadline`, `hackathon.startDate`,
  `hackathon.endDate`.
- `accelerator.applicationDeadline`.

**Added**

- `sponsoringOrganizations[]` (required, `minItems: 1`; `[0]` is the primary/display org) and
  `operatingOrganizations[]` (who runs intake/process).
- `organization.contacts[]` — `{name?, role?, telegram?, email?}`, every field optional, `{}`
  validates deliberately.
- `deadlines[]` — `{type: "fixed"|"rolling", date?, label?}`. **Every** per-type-block date
  folds in, event boundaries included, distinguished by `label`. `date` is required and
  non-null when `type` is `"fixed"`, enforced by `if`/`then`.
- `milestones[]` and `$defs/milestone` — `{title?, amount?, criteria?}`, valid on any
  `fundingType`, array order is the sequence, no date field. Marked `x-stability: provisional`.
- `eligibility` — an open key→value map of plain strings.
- `prerequisites`, `resourceLinks`, `serviceAgreement` — three optional top-level free-text
  strings. `serviceAgreement` is marked `x-stability: provisional`.
- `grant.programModel` — an open string, marked `x-stability: provisional`.
- Optional top-level `$schema`, `@context` and `@type`, so an instance can identify itself
  against `additionalProperties: false` and be consumed as linked data.
- `x-stability` / `x-since` / `x-deprecated` annotations, legalised by a new metaschema. They
  extend the 2020-12 vocabulary rather than duplicating it: deprecation is signalled by the
  **native** `deprecated` keyword, and `x-deprecated` may only accompany it to carry the
  since/replacedBy/note metadata JSON Schema has no keyword for.

**Newly enforced**

- **One block per funding type.** Each of the six `if`/`then` branches now also forbids every
  non-matching type block. A `grant` record carrying an `rfp` object used to validate; it now
  fails. `opportunity[opportunity.fundingType]` is a guarantee rather than an expectation.
- `specVersion` stays `const "1.0.0"`. It was briefly loosened to a `^1\.0\.\d+$` patch-line
  pattern during this release and **reverted the same day**: a loosening is a breaking change
  under this project's own bidirectional definition, and there is no patch process in existence
  for it to serve. Revisit at the first real editorial patch. See
  [`adr/0003`](../../adr/0003-instance-self-identification-and-version-pattern.md).

**Schema-file hygiene**, from an audit of the file itself against JSON Schema, OpenAPI and
OCDS/360Giving practice rather than against the field plan:

- **Descriptions are informative prose only.** Every all-caps BCP 14 keyword was removed from a
  description and either keyword-enforced or reworded. `NORMATIVE.md` says the schema's
  *keywords* are the constraints; a MUST in a description that no keyword backs is a prose
  constraint hiding in the schema. The one genuinely unenforceable rule — `milestones[].amount`
  following `funding.currency`, a dependency that crosses two objects — now says so at the point
  it is stated and points at FIELDS.md.
- **Editorial notes moved to `$comment`.** Design rationale, deliberate omissions, and traps a
  future editor might "fix" (why `hackathon.prizes` is not `uniqueItems`, why there is no
  `rfp.outOfScope`, why `organization` has no `extensions`) are maintainer notes, not consumer
  documentation, and they no longer leak into the generated field reference.
- **`examples` added** to the fields whose shape is not obvious from their type: `eligibility`,
  `deadlines`, `milestones`, `serviceAgreement`, `grant.fundingMechanisms`, `grant.programModel`,
  and a dozen others.
- **Descriptions completed** — every declared property and every `$def` now carries one, checked
  in CI. Twenty-eight were previously bare (`socialLinks.*`, `teamSize.*`, most of `accelerator`
  and `vcFund`, and the roots of `monetaryAmount`, `amountRange`, `teamSize`, `socialLinks`,
  `prize`, `bounty`, `vcFund`).
- **Constraints tightened where they were merely absent:** `format: "uri"` on all seven
  `socialLinks` values (they are links, not handles — `contact.telegram` remains a handle and is
  documented as the exception); `uniqueItems` on `deadlines` and `rfp.requirements`;
  `minLength: 1` on the items of `hackathon.tracks`, `bounty.skills`, `vcFund.portfolio` and
  `rfp.requirements`, matching the other free-text arrays. No committed example changed.
- **`$defs` reordered** to match the order the generated field reference renders them in, and a
  root `$comment` now records the property-ordering convention, the `x-stability` default, and
  why `additionalProperties: false` is safe alongside `allOf` here.

**Also cleaned:** an internal issue-tracker ID that had leaked into the normative `ecosystems`
description (and from there into every generated type file). A CI lint now fails on any
recurrence — the standard is CC0 and designed to be embedded and forked, so a leak travels.

#### Field mapping (old → new)

Every field that changed name, shape or existence in the re-cut. **No row is ever removed from
this table.** Two rows carry a semantics change rather than a mechanical move — those are the
ones a converter cannot get right by renaming keys, and they are called out in the notes.

| Old | New | Kind | Note |
|---|---|---|---|
| `type` | `fundingType` | renamed | Same six values; the invariant becomes `opportunity[opportunity.fundingType]`. |
| `organization` | `sponsoringOrganizations[0]` | reshaped | Single required object → required array, `minItems: 1`. Wrap to migrate; `[0]` is primary/display. |
| — | `operatingOrganizations` | added | Who runs intake/process, as distinct from who backs it. |
| — | `sponsoringOrganizations[].contacts` | added | `{name?, role?, telegram?, email?}`, all optional. |
| `source.url` | `applicationUrl` | removed | Partial carry-over only. `applicationUrl` is an intake channel, not necessarily the original posting; the `sameAs` sense has no successor. Put a load-bearing original posting in `resourceLinks`. |
| `source` `required: ["url"]` | — | removed | The provenance `$def` now has no required property. `"source": {}` validates. |
| `closesAt` | `deadlines[]` | reshaped | **Semantics change.** A single scalar becomes an array of `{type, date?, label?}`. Migrate a non-null value to `[{type:"fixed", date, label:"application"}]`; null migrates to no entry. Sorting/filtering must derive a next-deadline value at the consumer layer, and **selection is by `label`, never by array position** — the head of the array may be a hackathon's start date. |
| `funding.totalBudget` | `funding.budget` | renamed | Pure rename. |
| `funding.amountDistributed` | `funding.allocated` | reshaped | **Semantics change.** *Distributed* → *committed to date*. Copying the old value across asserts something different from what the source said. `remaining` is derived as `budget − allocated` and never stored; `disbursed`/`delivered` are not modelled. |
| `funding.awardsToDate` | — | removed | A per-award count in an otherwise program-level envelope. No successor. |
| `grant.fundingMechanism` | `grant.fundingMechanisms` | reshaped | Scalar enum → array (`uniqueItems`), plus a new `matching` value. Wrap to migrate. DAOIP-5's field stays singular, so that mapping becomes first-element-or-join. |
| — | `grant.programModel` | added | Open string; conventional values in `registries/program-models.json`. Provisional. |
| `rfp.issuingOrganization` | `sponsoringOrganizations[0].name` | reshaped | Free-text issuer superseded by the structured organisation. |
| `rfp.budget` | `funding` | reshaped | RFP-local `{amount, currency}` → the top-level envelope. |
| `rfp.proposalDeadline` | `deadlines[]` | reshaped | Label `application`. |
| `hackathon.registrationDeadline` | `deadlines[]` | reshaped | Label `registration`. |
| `hackathon.submissionDeadline` | `deadlines[]` | reshaped | Label `submission`. |
| `hackathon.startDate` | `deadlines[]` | reshaped | Label `event start`. Event boundaries fold in literally — one date model, not two. |
| `hackathon.endDate` | `deadlines[]` | reshaped | Label `event end`. |
| `accelerator.applicationDeadline` | `deadlines[]` | reshaped | Label `application`. |
| — | `eligibility` | added | Open key→value map of plain strings. |
| — | `prerequisites` | added | Free text: what a *proposal* must contain. Distinct from `rfp.requirements`, which is what the *work* must deliver. |
| — | `resourceLinks` | added | One free-form string, deliberately not an array of URIs. |
| — | `serviceAgreement` | added | Free text; presence is the signal. Valid on any `fundingType`. Provisional. |
| — | `milestones[]` | added | `{title?, amount?, criteria?}`; array order is the sequence; no date field. Provisional. |
| — | `$schema` / `@context` / `@type` | added | Optional self-identification, permitted against `additionalProperties: false` and ignored by validation. |
| `allOf` (matching block required) | `allOf` (matching required, others forbidden) | reshaped | One block per funding type is now enforced. A `grant` carrying an `rfp` object used to validate and now fails. |

#### Identifiers

**No identifier is minted on a domain the project does not own.** The earlier `$id` and `@vocab`
pointed at a domain nobody controls — a URL that looks final, never dereferences, and is inherited
by every downstream fork of a CC0 artifact.

- **`$id`** — for the schema, the metaschema and the registry entry schema — is now a
  `raw.githubusercontent.com` URL that **dereferences to exactly the bytes shipped here**. Known
  limitation: GitHub serves it as `text/plain`, not `application/schema+json`. A URL resolving to
  the real document with the wrong Content-Type beats one resolving to a parking page.
- **`@vocab`** carries a `draft` path segment mirroring this version's maturity, so it reads as
  provisional on sight. It does not dereference, and `STATUS.md` says so rather than hiding it.
- **`spec.config.json` is the only place a base URL is written.** All three `$id`s, the `@vocab`
  and the schema's own self-identification examples are stamped from it, so adopting a canonical
  domain is a one-line edit plus `pnpm codegen`. `pnpm check` fails if an identifier is
  hand-written or points at the retired placeholder domain, so the swap cannot be done halfway.

### Context

- `@vocab` moved off the version-scoped IRI to a versionless one. Under
  an in-place re-cut, `…/v1.0.0#organization` would have denoted two different things at two
  different times. Version the context *document*, never the term IRIs.
- `@protected: true` added to the stable core terms.
- Coverage extended from 13 terms to every top-level property of the new shape, with
  schema.org and DAOIP-5 mappings where they exist — `sponsoringOrganizations → schema:funder`,
  `operatingOrganizations → schema:sponsor`, `budget → daoip5:totalGrantPoolSize`,
  `fundingMechanisms → daoip5:grantFundingMechanism`. Terms for deleted fields removed.
- A CI check now fails on context↔schema drift in either direction, which was previously
  invisible.

### Tooling

- **`spec.config.json`** — one metadata block holding the spec's identity (`specVersion`,
  `schemaDir`, `id`, `vocabIri`, `status`, `recutDate`). The version string used to be
  hand-written in seven places; it is now hand-written in one.
- **`scripts/codegen.mjs`** extended to stamp that identity into the schema `$id`, the
  `specVersion` constant, the schema description, the context's `@vocab` and `SPEC_VERSION` —
  and to generate `registries/index.json`, `schemas/index.json` and the `FIELDS.md` field
  tables alongside the TypeScript types. `codegen:check` covers every generated artifact.
- **`scripts/check-spec.mjs`** (`pnpm check`) — publication rules: context↔schema drift,
  version-string agreement against `spec.config.json`, and the source-neutrality lint.
- **`registries/`** — `eligibility-keys`, `deadline-labels` and `program-models`, plus
  `entry.schema.json` and a generated `index.json`. Entries are never deleted; they are
  deprecated with a `replacedBy` pointer. `ecosystems` and `networks` deliberately have **no**
  registry: they stay plain open lists, because a registry there reads as an allowed-values list
  despite what `NORMATIVE.md` says, and no decision required one.
- **`conformance/v1.0.0/{pass,fail}/`** — whole documents, one file per rule, named after the
  rule, shipped in the package `files` array so external implementers can run them. Replaces
  the 2 valid + 4 invalid fixtures that lived inside `packages/validate/test/` where nobody
  outside the repo could reach them.
- **`meta/rfphub-schema.meta.json`** — metaschema constraining our schema file's shape and
  legalising the three `x-` annotation keywords, validated in CI.
- **`rfphub-validate` gains an advisory tier** (`src/checks/`): warnings reported separately
  from schema errors, count-phrased in text output, promoted to a failing exit code by
  `--strict`. Seed checks cover unregistered eligibility keys, deadline labels and program
  models, plus the milestone-amount-without-envelope-currency rule that JSON Schema cannot
  express because it crosses two objects. The registries and this tier are a pair: either one
  alone is worth less than neither.

### Docs

- **`FIELDS.md` rewritten for the new shape**, and half of it is now generated: the field
  reference tables — type, requiredness, description and governing registry for every property —
  are rendered from the schema into a marker block by `pnpm codegen` and gated by
  `codegen:check`. A hand-maintained field table drifts from the schema inside one release. The
  narrative around them carries the BCP 14 keyword boilerplate, the documentation conventions the
  schema cannot enforce (sponsor ≠ source of funds, `applicationUrl` = whatever the submission
  channel is, `prerequisites` vs `rfp.requirements`, the three free-text siblings,
  select-deadlines-by-label, milestone currency and due dates, single-currency-at-the-envelope),
  and a conformance section.
- **Design principle #2 reworded.** It used to read "every entry MUST carry a `source.url`" — a
  MUST on a field this release deletes. It now says what is actually true: provenance
  completeness is asserted by ingestion policy, not by schema validation.
- **`CROSSWALK.md` remapped** for every renamed, removed and added field, with "no equivalent"
  stated honestly rather than left blank, and the three cardinality divergences from DAOIP-5
  (single vs. multi-currency, one close date vs. labelled deadline array, scalar vs. array
  funding mechanism) written out. The claim that "no v1.0.0 field had to change to align" is
  retired. **Its JSON-LD usage example now validates** — it previously carried `@context` and
  `@type` against `additionalProperties: false`, so the project's own published example failed
  against the project's own schema.
- **`BENCHMARK.md` corrected** to distinguish the pre-re-cut corpus measurement (311 pulled,
  289 validated — not re-run) from the current claim (28 committed examples, converted and
  re-validated against the re-cut schema).
- **New governance and process set:** `PROCESS.md` (feature stages; the operational, bidirectional
  definition of breaking with JSON Schema's indeterminate-state carve-out; deprecation;
  registry registration criteria; errata triage labels; release checklist), `NORMATIVE.md`
  (normative vs. informative, and the rule that informative content may be corrected outside the
  release cycle), `ARTIFACTS.md` (every artifact shipped/planned/declined, with its generator and
  its trigger), `schemas/v1.0.0/STATUS.md` (maturity, the honest re-cut paragraph, feedback
  channel), and `GOVERNANCE.md` at the repo root (editors, decision rule, review windows, appeal
  path, and an explicit list of what this project deliberately does not have).
- **`adr/`** added at the repo root with a MADR template, an index, and three records: the
  in-place re-cut, the field re-cut with its accepted costs, and the two tooling-driven additions
  (instance self-identification accepted; the `specVersion` patch-line pattern proposed and
  reverted the same day).
- **`schemas/index.json`** (generated) — a machine-readable index of published spec versions with
  a `latest` pointer. Free while there is one version and impossible to retrofit cleanly.
- Root `README.md` link-back language corrected to describe the application link, and
  `CONTRIBUTING.md`'s versioning section rewritten — it previously promised "additive → minor,
  breaking → new major at a new URL", the exact policy this release breaks, and forward-referenced
  governance documents that did not exist. They exist now and it links them.
- All 28 curated examples converted to the new shape. Where the conversion would have dropped
  a real value, it was rehomed rather than lost: `source.url` became `applicationUrl` on the
  seven records that had none and `resourceLinks` on the six where `applicationUrl` already
  pointed elsewhere; the one non-zero `funding.awardsToDate` was preserved under `extensions`.
