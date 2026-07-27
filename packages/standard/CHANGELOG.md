# Changelog — RFP Hub Standard

This file records changes to the **standard** (the schema, the context, and the artifacts
governed by them). It is not the npm package's release log: package version and spec version
are separate axes, and only the spec version is tracked here.

Entries are grouped **Schema / Context / Tooling / Docs**.

---

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
  tables alongside the TypeScript types. `codegen:check` covers all seven artifacts.
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
