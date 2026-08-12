# Process — how the RFP Hub Standard changes

This document governs **the standard**: the schema, the registries, the conformance suite and
the JSON-LD context. It does not govern the npm packages that ship it — see
[Two version axes](#two-version-axes).

Who decides, and in what forum, is in [`GOVERNANCE.md`](../../GOVERNANCE.md). What is normative
in the first place is in [`NORMATIVE.md`](./NORMATIVE.md). This file is about *what counts as a
change* and *what has to be true before one ships*.

---

## Two version axes

They are different numbers and they move independently. Conflating them is the most common way a
schema project loses the ability to explain itself.

| Axis | Where it lives | What it means | Who bumps it |
|---|---|---|---|
| **Spec version** | `spec.config.json` → the schema `$id`, `specVersion`, the `schemas/<version>/` directory | The version of **the data contract**. A document declares which one it conforms to. | This document. |
| **Package version** | `package.json` of `@the-rfp-hub/standard`, `rfphub-validate`, … | The version of **the npm distribution**. Bumped for any shipped change — new generated types, a fixed export map, a doc file added to the `files` array. | Changesets, ordinary semver. |

A publisher pins a **spec version**. A build pins a **package version**. The package version may
run far ahead of the spec version and that is not a problem — it is the point of separating them.
`specVersion` in a document always names the spec axis.

`specVersion` is `const: "1.0.0"` — a document names the exact spec version it conforms to. A
patch line (`pattern: ^1\.0\.\d+$`) was tried during the re-cut and reverted the same day; see
the worked example below, and [`adr/0003`](../../adr/0003-instance-self-identification-and-version-pattern.md).
The rule the pattern would have depended on still stands and is worth stating now, because it is
the precondition for ever reintroducing it: **a patch release of the spec is editorial by
definition** — it may correct prose, add registry entries or fix a description, and it may never
change what validates. If a proposed patch would change what validates, it is not a patch.

---

## Feature stages

Every field carries a stage, recorded in the schema as `x-stability`. Four stages, no more:

| Stage | Annotation | What it means | How it moves on |
|---|---|---|---|
| **proposed** | not in the schema yet | An issue or PR describing a field, with a use case and at least one real document that needs it. Lives in the issue tracker, and may have conformance fixtures before it has a schema. | Editor accepts → merged as `experimental`. |
| **experimental** | `x-stability: provisional` | In the schema and valid to use, but resting on narrow evidence. **May change shape or be removed** without the ceremony a stable field gets. Consumers should tolerate its absence and its change. | **≥1 real publisher and ≥1 real consumer have shipped it.** Then it becomes `stable`. |
| **stable** | `x-stability: stable` | The default. Changes to it are changes to the standard and follow the breaking-change rules below. | Only to `deprecated`. |
| **deprecated** | `deprecated: true` (+ optional `x-deprecated: {since, replacedBy, note}`) | Still valid, still accepted, no longer recommended. Consumers must keep reading it. | Removal, no earlier than the next release. |

The promotion gate is deliberately **one publisher and one consumer**, not the five-implementation
bar larger projects use. At this size, five implementations is a gate nothing ever passes, and an
unpassable gate means everything stays experimental forever, which tells a reader nothing.

Fields currently at `provisional`: the security-bounty payout surface added 2026-08-10 —
`bounty.bountyKind`, `bounty.rewardTiers[]`, `bounty.severityScheme`,
`bounty.rewardPoolStatus`, and every property of `$defs/rewardTier` and `$defs/payout`. It has
publisher evidence and no consumer implementation, so it sits at `experimental` until one ships
(see [`adr/0008`](../../adr/0008-security-bounty-payout-tiers.md)).

An earlier three (`serviceAgreement`, `milestones[]`, `programModel`) were promoted to `stable`
on 2026-08-05, the maintainers accepting the M1 research round — the decision interviews, plus
the real third-party RFP that motivated `milestones[]` — as the verification the gate asks for
(recorded in `CHANGELOG.md`).

---

## What "breaking" means

Operationally, and in one sentence:

> **A change is breaking if a document that was valid under version N is invalid under version
> N+1 — or if a document that was invalid under N is valid under N+1.**

### It is bidirectional

The second half is the half most schema policies get wrong. **Loosening a constraint is breaking
too.** If a field's enum gains a value, or a `const` becomes a `pattern`, or a required property
becomes optional, then data that used to be rejected now validates — and every consumer that
relied on the rejection has silently changed behaviour. A validator is a contract in both
directions.

Worked example from this project's own history — **and note how it ended.** During the
2026-07-27 re-cut, `specVersion` was moved from `const: "1.0.0"` to `pattern: ^1\.0\.\d+$`.
Every previously valid document stayed valid; `{"specVersion": "1.0.7"}` used to fail and now
passed. Under this definition that is a **breaking change**, even though nothing was
invalidated and it reads to most people as a harmless relaxation.

Classifying it correctly is what made the next question askable: *what is this loosening buying
us right now?* The answer was nothing — there was no patch process, no editorial patch pending,
and no document anywhere carrying a `1.0.x` value other than `1.0.0`. **It was reverted the same
day** and `specVersion` is `const: "1.0.0"` again. The rule to reintroduce it is written above:
a patch release must be editorial by definition. Revisit at the first real editorial patch.

This example is kept because the revert is the more useful half of it. A definition of
"breaking" that only ever produces a note in a changelog is decoration; this one produced a
decision. See [`adr/0003`](../../adr/0003-instance-self-identification-and-version-pattern.md)
and [`CHANGELOG.md`](./CHANGELOG.md).

### The indeterminate-state carve-out

There is a third state between valid and invalid: **indeterminate** — behaviour the schema never
defined. If version N said nothing about a case, and version N+1 defines it, that is **not
breaking**, because there was no contract to break.

This matters here because much of the 2026-07-27 re-cut is exactly this shape. Enforcing
one-block-per-funding-type made previously-valid documents invalid — that is straightforwardly
breaking. But permitting `$schema`, `@context` and `@type` at the top level defined behaviour that
`additionalProperties: false` had left as a flat rejection with no stated intent; the schema had
never taken a position on self-identification. The carve-out is narrow and it is easy to abuse:
**"we never thought about it" is not the same as "the schema left it undefined."** If the previous
version's validator produced a definite answer, the state was not indeterminate.

### Consequences

- **Breaking changes require a new spec version** and a new `schemas/<version>/` directory. The
  previous directory stays published, unedited, forever.
- **Non-breaking changes** — new optional fields, new registry entries, corrections to
  descriptions — go into the current version on the current patch line.
- **Informative documents** may be corrected at any time without any of this
  ([`NORMATIVE.md`](./NORMATIVE.md)).

### In-place re-cuts

`v1.0.0` was re-cut in place on 2026-07-27: same version string, different bytes
([`adr/0001`](../../adr/0001-recut-v1.0.0-in-place.md)). That was defensible **only** because the
standard was unpublished and unadopted, and it is **the only re-cut of bytes that had been
published as final**.

The rule, stated so a future maintainer cannot reason their way around it:

> **A version directory may be edited in place only while its maturity is `draft` and no external
> consumer has adopted it. It may never be edited in place after it is declared `stable`.**

The draft `v1.0.0` was revised in place a second time under this rule on 2026-08-05
([`adr/0004`](../../adr/0004-second-draft-revision-org-swap-and-closure.md), which reconciles
the revision with the once-only language above — the vow governed the published-re-cut event
class, the rule governs draft-period edits, and both end at promotion). Note the basis has
narrowed since ADR-0001: the npm package is published now, so the permission rests on draft
maturity plus zero external adopters alone. If an adopter appears, the next breaking change is
a version bump regardless of maturity.

The mechanism, so the rule does not depend on memory: declaring a version stable adds a `FROZEN`
marker file to its directory, and
[`.github/workflows/spec-freeze.yml`](../../.github/workflows/spec-freeze.yml) fails any PR that
touches a version directory containing one. The marker is not present yet — it lands with the
promotion to `stable`.

---

## Deprecation

1. **Nothing in a registry is ever deleted.** A value that turns out to be wrong, redundant or
   superseded gets `"status": "deprecated"` and a `replacedBy` pointer to its successor. Data
   already published using it stays valid and stays interpretable. The registry file is an
   append-and-annotate log, not a list of currently-good values — that list is the `active` array
   in the generated [`registries/index.json`](./registries/index.json).

   This rule governs **entries**, not registries. For the registry as a whole, the rule — set
   as precedent when `eligibility-keys` was retired with the `eligibility` field's move to free
   text (2026-08-05, [`adr/0004`](../../adr/0004-second-draft-revision-org-swap-and-closure.md)):
   **a registry may be retired — deleted whole — only while its governing spec version is
   `draft`.** Entry-level deprecation cannot express a registry losing its subject (there is no
   successor for `replacedBy` to name, and tooling rejects a registry that governs no field).
   Once the governing version is `stable`, a registry whose field is removed is deprecated
   entry-by-entry and kept forever, like any other published vocabulary. A retired registry's
   definitions stay recoverable through the CHANGELOG record and git history.
2. **A deprecated field stays valid and stays accepted** for at least one full release after the
   release that deprecated it. A field deprecated in release N may be removed no earlier than
   N+1. Consumers get a release cycle's notice, at minimum.
3. **Deprecation is announced, not discovered — and it is announced in the standard keyword
   first.** JSON Schema 2020-12 has a native `deprecated` annotation, so **a deprecated element
   sets `deprecated: true`**. That is the machine-readable signal, and it is the one a generic
   validator or documentation generator already understands without knowing anything about this
   standard. Our `x-deprecated: {since, replacedBy, note}` is a **supplement, not a substitute**:
   it carries only the metadata the native keyword cannot express, and the metaschema rejects it
   when `deprecated: true` is absent. Never invent an `x-` keyword for something 2020-12 already
   says.

   The announcement also goes in `CHANGELOG.md` — and for a field that disappears, in that
   release's **field mapping table** (the v1.0.0 one is
   [here](./CHANGELOG.md#field-mapping-old--new)). No row is ever removed from a mapping table:
   a field that vanished from the schema keeps its row forever, because that row is what tells a
   consumer holding old data what happened to it.
4. **Removal is a breaking change** and takes a new spec version, like any other.

---

## Registering a value in a registry

The registries are how the standard keeps open fields comparable without closing them. Adding to
one is the cheapest possible contribution and it is designed to be.

There are **two**: `deadline-labels` and `program-models`. Those are the vocabularies where two
publishers writing different strings for the same concept produce uncomparable data. (A third,
`eligibility-keys`, was retired on 2026-08-05 when `eligibility` became free text — see the
registry-retirement rule above.) `ecosystems` is an open list too and deliberately has **no**
registry — a registry over chain names is read as an allowed-values list however carefully
[`NORMATIVE.md`](./NORMATIVE.md) words the distinction, and it would put this review process in
front of a newly launched chain for no interoperability gain.

### Criteria

A value is registered when it meets all three:

1. **In use by at least one real publisher.** Not hypothetical, not "we might need it". A link to
   a live listing, a program's own documentation, or an export that carries the value.
2. **Clearly described.** One paragraph saying what the value means and when a publisher should
   choose it *over its nearest neighbour*. If the description cannot distinguish it from an
   existing entry, the existing entry is the answer.
3. **No vendor lock.** A value that only makes sense inside one platform's product does not
   belong in the standard at all — there is no `extensions` escape hatch to park it in; if the
   concept is real beyond one vendor, propose a field through a spec release instead.
   Registered values must be meaningful to a publisher who has never heard of whoever proposed
   them.

The registration policy is deliberately the **least strict one that works**: an editor reviews,
and the bar is the three criteria above, not consensus.

### Steps

1. **Open a GitHub issue** — which registry, the proposed key, the description, the evidence of
   real use, and the nearest existing entry and why it does not fit.
2. **Editor review.** An editor either accepts, asks for a better distinction from an existing
   entry, or declines with a reason on the issue. Registry proposals get a **shorter review
   window** than schema changes — see [`GOVERNANCE.md`](../../GOVERNANCE.md) — because they add
   documentation about values that are already valid data.
3. **PR** adding the entry to the registry file with `description`, `status: "active"`, `since`
   (the spec version registering it), and `examples`. Run `pnpm codegen` so
   `registries/index.json` regenerates, and `pnpm check`.

Registering a value **never changes what validates**. Unregistered values were valid before and
stay valid after; what changes is that the validator stops warning about this one.

---

## Errata

An erratum is a defect in something already published. Triage every reported one into exactly one
of four labels — the point of the fourth is to notice when a series of small clarifications is
quietly redesigning the standard.

| Label | What it is | How it is fixed |
|---|---|---|
| `erratum-editorial` | Typo, broken link, unclear sentence, stale number in an informative document. Changes no behaviour. | Ordinary PR, any time, no window, no version. |
| `erratum-technical` | The normative artifacts are internally inconsistent, or a description says something the schema does not do. A correct implementation could be misled. | Fix in the current version if the fix does not change what validates; otherwise it is a change, not an erratum. Record in `CHANGELOG.md`. |
| `held-for-next-cut` | Real defect, but fixing it would change what validates. Cannot ship inside the current version. | Stays open, labelled, and is picked up when the next spec version opens. Say so on the issue — a defect parked without a label reads as ignored. |
| `redesign` | The report is not a defect at all: it asks the standard to mean something different. | Not an erratum. Becomes a `proposed` feature, and if accepted an ADR. |

---

## Release checklist

Before a spec release — a new version directory, or a patch line on the current one:

- [ ] `pnpm codegen && pnpm codegen:check` — every generated artifact in sync (types, registry
      index, versions index, the generated FIELDS tables).
- [ ] `pnpm check` — publication rules: context↔schema drift, version-string agreement across
      `spec.config.json` and everything stamped from it, source neutrality.
- [ ] `pnpm build && pnpm typecheck && pnpm test && pnpm lint` green.
- [ ] Conformance suite passes, and **every rule changed in this release has a case** in
      `conformance/<version>/pass/` or `fail/` named after the rule.
- [ ] Examples re-validated against the released schema.
- [ ] `CHANGELOG.md` entry, grouped Schema / Context / Tooling / Docs, and explicitly listing any
      **breaking** change under the bidirectional definition above — including loosenings.
- [ ] The release's field mapping table updated for anything renamed or removed; no row ever
      deleted.
- [ ] `STATUS.md` for the version: maturity, supersedes/superseded-by, known issues.
- [ ] `schemas/index.json` lists the version and `latest` points at the right one.
- [ ] An ADR exists for any structural decision in the release.
- [ ] A changeset for the npm distribution — the **other** version axis.
- [ ] If the release declares a version `stable`: add its `FROZEN` marker and confirm the freeze
      workflow rejects a test edit to that directory.
