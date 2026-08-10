# What is normative in the RFP Hub Standard

Nobody infers this. It has to be written down, so this is the document that says which artifacts
carry authority and which ones merely describe it.

## Normative

These define the standard. A claim of conformance is a claim about these files.

| Artifact | What it governs |
|---|---|
| [`schemas/v1.0.0/opportunity.schema.json`](./schemas/v1.0.0/opportunity.schema.json) | **The definition.** A document conforms to v1.0.0 when it validates against this file. |
| [`registries/`](./registries) — the **registered values** | The conventional values of the four open vocabularies the standard governs by registry: `deadlines[].label`, `fundingDetails.programModel` (the grant payload), and `severity` and `assetType` on a bounty reward tier. See the important qualification below. |
| [`conformance/v1.0.0/`](./conformance/v1.0.0) | The published pass/fail cases. An implementation is conformant with respect to the suite when it accepts everything in `pass/` and rejects everything in `fail/`. |
| [`spec.config.json`](./spec.config.json) | The spec's identity — version, `$id`, vocabulary IRI, maturity. |
| [`schemas/v1.0.0/context.jsonld`](./schemas/v1.0.0/context.jsonld) | The term IRIs a document expands to when read as linked data. |

**The qualification on registries.** A registry is normative about **what a value means**, not
about **which values are allowed**. The schema deliberately keeps these fields open: an
unregistered deadline label or program model is **valid data** and produces a *warning*, never
a validation error. Registering a value fixes its meaning so two publishers using it mean the
same thing. Entries are never deleted — see [`PROCESS.md`](./PROCESS.md), which also records
the one narrow exception at the registry level: a whole registry may be retired only while its
governing spec version is `draft`, which is how the former `eligibility-keys` registry left
when `eligibility` became free text (2026-08-05, ADR-0004).

**Why not more.** `ecosystems` is an open list too, and deliberately has **no** registry. That
distinction above is a fine one, and a registry over a list of chain names would be read as an
allowed-values list no matter how this document words it — while also putting a review step in
front of a newly launched chain for no interoperability gain. The vocabularies that *are*
registry-governed are the ones where two publishers writing different strings for the same
concept produce genuinely uncomparable data.

**The qualification on the conformance suite.** Passing the suite is **evidence of conformance,
not the definition of it**. The schema is the definition. The suite asserts nothing about which
error an implementation reports, how many, or in what order.

## Informative

These explain the standard. They are corrigible, and correcting them is not a spec change.

| Artifact | What it is |
|---|---|
| [`schemas/v1.0.0/FIELDS.md`](./schemas/v1.0.0/FIELDS.md) — the **prose** | Field explanations, documentation conventions, status semantics, consumer guidance. Its generated field tables are derived from the schema and cannot disagree with it; the narrative around them is human-written and can. |
| [`schemas/v1.0.0/CROSSWALK.md`](./schemas/v1.0.0/CROSSWALK.md) | Mappings to DAOIP-5 and schema.org/Grant. |
| [`schemas/v1.0.0/BENCHMARK.md`](./schemas/v1.0.0/BENCHMARK.md) | A measurement against real data. |
| [`schemas/v1.0.0/examples/`](./schemas/v1.0.0/examples) | Curated real-world documents. Illustrations, **not** conformance cases. |
| [`CHANGELOG.md`](./CHANGELOG.md) (including its field-mapping table), [`ARTIFACTS.md`](./ARTIFACTS.md), [`schemas/v1.0.0/STATUS.md`](./schemas/v1.0.0/STATUS.md) | The record of what changed, what ships, and where this version stands. |
| READMEs, [`adr/`](../../adr) | Orientation and decision history. |
| [`PROCESS.md`](./PROCESS.md), [`GOVERNANCE.md`](../../GOVERNANCE.md) | Normative about **the project's process**, not about the data format. A document does not conform or fail to conform to them. |

## The two rules that follow

1. **The schema takes precedence over conflicting prose.** If [`FIELDS.md`](./schemas/v1.0.0/FIELDS.md)
   describes a constraint the schema does not enforce, or describes it differently, **the schema
   is right and the prose is a defect**. Report it as an erratum; do not implement the prose.

   One deliberate exception, stated in both places: a handful of rules in FIELDS.md are
   **normative in intent but not schema-expressible** — the clearest is that
   `milestones[].amount` must be denominated in `fundingInfo.currency`, a dependency that crosses two
   objects. Those are enforced by the validator's advisory tier and by ingestion policy, and each
   one is labelled as such at the point it is stated. They are requirements on *publishers*, not
   conditions of schema validity.

2. **Informative content may be corrected outside the release cycle.** A wrong crosswalk row, a
   stale benchmark number, an unclear sentence in FIELDS.md, a broken link — all of these can be
   fixed by an ordinary PR at any time, without a spec version, without a comment window, and
   without a changelog entry beyond the commit. This is the whole point of drawing the line: it
   keeps documentation improvable at the speed documentation needs to be improvable, while the
   schema stays under change control.

   **This survives the freeze, and the gate knows it.** A frozen version directory
   ([`PROCESS.md`](./PROCESS.md), "In-place re-cuts") keeps its four informative documents —
   `FIELDS.md`, `CROSSWALK.md`, `BENCHMARK.md`, `STATUS.md` — correctable by name, while the
   schema, the context, the examples and the conformance suite become immutable bytes.
   `examples/` is informative in the sense of this table (an illustration is not a conformance
   case) but it is still shipped *data*: a consumer may have hashed it, so correcting one takes
   a new version like any other byte in the publication.

   The inverse also holds. A change to any artifact in the normative table — **including adding,
   deprecating or re-describing a registry value** — is a spec change and follows
   [`PROCESS.md`](./PROCESS.md).

## What this does not decide

Whether a *field* is stable is a separate axis from whether a *document* is normative. Per-field
maturity is carried by the `x-stability` annotation inside the schema and governed by the feature
stages in [`PROCESS.md`](./PROCESS.md).
