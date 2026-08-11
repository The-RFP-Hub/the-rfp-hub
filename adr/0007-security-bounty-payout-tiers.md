# 0007 — Split `bounty` into task and security kinds, and give the security kind a payout table

- **Status:** accepted
- **Date:** 2026-08-10
- **Supersedes:** nothing. Extends the `fundingDetails` union established in
  [`0005`](./0005-third-draft-revision-utc-timestamps-and-tagged-funding-details.md) and
  respects the single-currency rule set in [`0006`](./0006-document-wide-single-currency.md).

## Context

The `bounty` payload described "a single scoped task with a stated reward", with `reward` a
required plain number and `difficulty`, `skills` and `platform` alongside it. Those are
gig-work fields; the shape was designed from bounty-board listings.

A reviewer of the M1 research deliverable observed that most protocols run open-ended bug
bounty programs, that the existing type looked aimed at one-off task bounties, and that
open-ended programs tend to pay at panel discretion.

We measured it rather than argue it. Against the public Immunefi API — 247 live programs,
unauthenticated, pulled 2026-08-10:

| Measurement | Value |
|---|---|
| Programs representable by a single required `reward` | **3 of 247** |
| Median reward rows per program | **4** |
| Payout shapes observed | `range` (374 rows), `fixed` (350), `up_to` (87) |
| Programs grading on more than one asset class | **80 of 247 (32%)** |
| Programs carrying a percentage-of-value-at-risk rule | **169 of 247 (68%)** |
| Programs with no end date | **188 of 247** |
| Programs advertising a maximum with no funded pool | **190 of 247** ($130.9M advertised, $18.9M in pools) |

The corpus also splits cleanly. 59 of the 247 are audit *competitions* — pool-based, no
severity tiers — and the remaining 188 are bug bounty programs. Those two sets are exactly
complementary, and **all 188 are representable** by `{severity, assetType, payout}`.

A hand-read of ~45 programs across five platforms plus Ethereum Foundation and Solana put the
percentage-of-value-at-risk construction at ~30 of ~45 (67%), independently matching the 68%
measured on Immunefi.

## Decision

1. **Add a required `bountyKind`, enum `task | security`.** The two things called a bounty do
   not share a payout shape, and the discriminator is what lets each carry the right required
   field. Not "open-ended" as the axis: intake duration already lives in `deadlines[]`, and
   either kind may be rolling.
2. **Add `rewardTiers[]`**, entries of `{severity?, assetType?, label?, payout}`. Required when
   `bountyKind` is `security`; **permitted on either kind**.
3. **Add `$defs/payout`**, a `model` tag over `fixed | range | up_to |
   percentage_of_value_at_risk | discretionary`, bound by a nested `if`/`then`/`else`. Each
   branch **both requires the amounts its model needs and forbids those belonging to the
   others**, so the tag is an exclusive discriminator rather than a hint: a `discretionary`
   payout carrying an amount does not validate.
4. **`reward` becomes conditional** — required for `task`, and **forbidden** for `security`.
   Requiring the table without forbidding the scalar would still permit the misleading maximum
   headline this decision exists to prevent.
5. **Add `severityScheme` and `rewardPoolStatus`.**
6. **Govern `severity` and `assetType` by registry**, not by closed enum.
7. **Land the whole surface `x-stability: provisional`.**

### The boundary: what is structured and what stays prose

Structure a thing if omitting it changes the answer to *"which programs pay more than $X for a
critical, and can I still submit?"* Otherwise it is for reading, not faceting — the call
`eligibility` already makes.

So `percentage_of_value_at_risk` is structured: it is the most repeated construction in the
corpus, and "what share of what I recover do I keep" is filterable. Step functions over funds
at risk (one client), TVL-conditional tiers (one program), conditional pool release
(competitions only), per-tier vesting and multipliers are **not** structured. Every program
carrying them still publishes a severity tier and a ceiling the table captures exactly, so the
arithmetic can live in `description` without costing a consumer an answer.

## Consequences

- **Breaking in both directions.** Requiring `bountyKind` invalidates previously valid
  documents; relaxing `reward` and adding optional properties to a closed object validates
  previously invalid ones. Both are breaking under the bidirectional rule in `PROCESS.md`.
- **No new version directory.** `v1.0.0` is `draft` and no external consumer has adopted it —
  the two conditions `PROCESS.md` sets for editing a version in place. Re-verified immediately
  before merge, as the policy requires; **the first external adopter closes this door**.
- **npm `@the-rfp-hub/standard` ships this as a minor, not a major, by explicit decision.**
  `BountyDetails.reward` becomes optional and the interface gains members, so a TypeScript
  consumer reading `.reward` without narrowing breaks — technically a major under semver. The
  maintainers judged the package to have no real dependants (its download counts are automated
  traffic) and preferred not to spend a second major inside one release cycle. Recorded here
  because the deviation is deliberate and the reasoning expires: **once the package has a real
  dependant, a change of this shape is a major**, and the next one should be.
- **The API's ingest mapper infers `bountyKind`** from payout shape, defaulting to `task`, and
  **no longer synthesizes a `reward` from the program budget for a security bounty** —
  synthesizing one there would manufacture exactly the misleading headline this ADR exists to
  prevent.
- **The generated TypeScript cannot express either discriminator.** `json-schema-to-typescript`
  does not read `if`/`then`/`else`, so `BountyDetails.reward` and `Payout.amount` emit as
  optional and narrowing on the tag does not restore requiredness. The types are a shape hint;
  the schema is the contract, and a consumer that needs the guarantee validates. Encoding the
  union by hand in `types.ts` was considered and rejected — a hand-maintained mirror of a
  generated file drifts silently, which is worse than a known-loose type.
- **`hackathon.prizes[]` is now an inconsistent sibling.** It is the same graded-payout shape
  — `{track, amount}` — with a plain number where `rewardTiers[]` has a payout union, so it
  cannot express "up to" or a discretionary pool. Worse, `track` is null in every row of all
  19 hackathon fixtures, so the existing structure is already producing an unlabelled bag of
  numbers. `payout` was deliberately defined as a standalone `$def` so `prizes[]` can adopt it
  later as a swap rather than a redesign. **Not done here** — it is a separate defect and
  belongs in its own decision.

## Options rejected

**A seventh `fundingType`, `security_bounty`.** Considered seriously: a security program shares
almost no fields with a task bounty. Rejected because it widens the root `oneOf`, the API filter
enum, the database enum and every exhaustive consumer switch, and makes "all bounties" harder to
query — for a distinction the existing tagged-union architecture already expresses one level
down. Revisit if the two shapes diverge further.

**Closed enums for `severity` and `assetType`.** The observed vocabularies are one platform's.
FIELDS.md design principle #1 is source-agnostic, and freezing `smart_contract |
blockchain_dlt | websites_and_applications` writes one vendor's taxonomy into the standard.
Registries keep the values interoperable while leaving the fields open.

**A program-level `rewardFormula`.** The first draft put percentage-of-value-at-risk on the
bounty rather than the tier. The data rejects it: **164 of 247 programs carry the rule on some
severity rows and not others**, so a program-level field would assert the formula applies to
every tier. It is tier-local.

**A boolean `discretionary` beside optional numbers.** Does not enforce what it claims — a
document could set the flag and an amount. `discretionary` is a payout model instead, and the
model branches forbid the amounts they do not use, so the objection that killed the boolean
does not resurface against its replacement. The first cut of this ADR shipped a model tag that
only *required* the applicable fields and forbade nothing; review caught that it had inherited
the same defect, and the branches were tightened.

**A separate `rewardNotes` free-text field.** `description` is already the standard's prose
carrier. A second one invites drift over which holds what.

**Keeping `rewardTiers` exclusive to `security`.** Requiring a field on one branch is not a
reason to forbid it on the other, and placement-graded task bounties are common.

**Reopening ADR-0006 for a settlement currency.** Programs that denominate in USD and settle in
a token are real but rare — 6 of 247. Logged as a known limitation; the document-wide currency
rule stands.

## Known limitations

- **Cross-field numeric rules are advisory, not schema-enforced.** `min` above `max`, or `floor`
  above `cap`, validates: portable JSON Schema cannot compare two sibling values. The
  `payout-bounds-inverted` check in `rfphub-validate` is the only enforcement, the same
  arrangement the document-wide currency rule has.
- Reward tiers cannot express a payout denominated differently from the document currency.
- `percent` has no companion field naming what the percentage is *of*; "value at risk" is fixed
  by the model name, and programs defining it differently (funds directly affected, TVL at the
  moment of report, economic damage) are not distinguished.
- Nothing models the **damage window** — the "assume a 1-hour exploit period" clause that
  materially bounds the computed payout across several platforms.
- No `safeHarbor` field, despite `full | partial | none` being an available vocabulary from
  disclose.io. Deferred for want of frequency data, alongside `pocRequired` and
  `duplicatePolicy`, which were in an earlier draft and cut for the same reason: KYC appears in
  132 of 247 programs and still lives in free-text `eligibility`, so structuring rarer policy
  fields ahead of it would be inconsistent.
