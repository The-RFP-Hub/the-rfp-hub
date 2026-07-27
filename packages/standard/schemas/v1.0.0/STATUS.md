# Status of this version — RFP Hub Standard v1.0.0

*This section describes the status of this version of the standard at the time of publication.
Other documents may supersede it. A machine-readable index of all versions is at
[`schemas/index.json`](../index.json).*

| | |
|---|---|
| **Version** | `1.0.0` |
| **Maturity** | **`draft`** |
| **Identifiers** | Stamped from [`spec.config.json`](../../spec.config.json) — **no canonical domain yet**, see Known issues |
| **Re-cut in place** | **2026-07-27** |
| **Supersedes** | none — this is the first version |
| **Superseded by** | none — this is the current version |
| **Feedback** | GitHub issues on [`The-RFP-Hub/the-rfp-hub`](https://github.com/The-RFP-Hub/the-rfp-hub/issues) |
| **License** | CC0 1.0 |

## Maturity: `draft`

`draft` means the shape is **usable and stable enough to publish against, but not frozen**. It
may still change without a new version directory while this maturity holds. Promotion to
`stable` freezes this directory: a `FROZEN` marker file lands in it and CI rejects any PR that
edits it thereafter — see [`PROCESS.md`](../../PROCESS.md).

Feature-level maturity is finer-grained than document-level maturity. Several fields in this
version are annotated `x-stability: provisional` in the schema (`serviceAgreement`,
`milestones[]`, `grant.programModel`) — they rest on narrower evidence than the rest and are the
most likely to change. Everything else is `x-stability: stable`.

## The honest paragraph

**Spec v1.0.0 was re-cut in place on 2026-07-27.** The contents published under this version
string **differ from the contents published under the same version string before that date**.
Documents that validated against the earlier bytes do **not** validate against these: fields were
renamed (`type` → `fundingType`), removed (`organization`, `source.url`, `closesAt`) and added,
and one-block-per-funding-type became a validation rule.

This is the thing semantic versioning exists to prevent. It was done deliberately, once, and on
a narrow basis: the standard had never been published to a package registry, no external
consumer had adopted it, and the milestone that would have declared it complete had not closed.
A version bump would have invented a migration story with nobody on the other end of it.

- **Full rationale and the alternatives considered:**
  [`adr/0001-recut-v1.0.0-in-place.md`](../../../../adr/0001-recut-v1.0.0-in-place.md)
- **The field decisions themselves:** [`adr/0002-v-next-field-recut.md`](../../../../adr/0002-v-next-field-recut.md)
- **Field-by-field mapping:** the [field mapping table](../../CHANGELOG.md#field-mapping-old--new)
  in `CHANGELOG.md`. No row is ever removed from it.
- **The pre-re-cut bytes are preserved** at the git tag
  **`standard/spec-v1.0.0-precut-2026-07`**, created before the first re-cut commit. That tag is
  the only way to recover the earlier shape.

**In-place re-cuts end here.** [`PROCESS.md`](../../PROCESS.md) states the rule that forbids a
second one, and the freeze workflow mechanises it so the policy does not depend on memory.

## Known issues in this version

- **There is no canonical domain yet, and the identifiers say so.** The project does not own a
  domain, so nothing is minted on one. Instead:
  - **`$id`** — for the schema, the metaschema and the registry entry schema — is a
    `raw.githubusercontent.com` URL on the default branch. It **does dereference**, to exactly
    the bytes shipped here. *Known limitation:* GitHub serves it as `text/plain`, not
    `application/schema+json`. A URL that resolves to the real document with the wrong
    Content-Type is strictly better than one that resolves to a parking page or to nothing.
  - **`@vocab`** is `https://github.com/The-RFP-Hub/the-rfp-hub/ns/draft/rfp#` and **does not
    dereference**. A vocabulary namespace must be versionless, so it cannot live under
    `schemas/<version>/`, and no versionless document exists to point it at. The `draft` segment
    mirrors this version's maturity so the IRI reads as provisional on sight, and the authority
    is one the project demonstrably controls.
  - **Swapping in the real domain is a one-line edit** to `baseUrl`/`vocabIri` in
    [`spec.config.json`](../../spec.config.json) followed by `pnpm codegen`. Every identifier in
    the package is stamped from that file; none is hand-written, and `pnpm check` fails if one
    ever is.
- **Status granularity** — the four-value `status` enum is the most-questioned part of the
  standard. It is unresolved, not settled.
- **`vc_fund` has no real-data coverage** — see [`BENCHMARK.md`](./BENCHMARK.md).

## How to comment

Open a GitHub issue. Substantive changes stay open for a minimum comment window before merge;
editorial corrections to informative documents do not need one. Both rules, and the errata
labels used to triage them, are in [`PROCESS.md`](../../PROCESS.md).
