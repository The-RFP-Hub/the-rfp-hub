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
| **Second draft revision (in place)** | **2026-08-05** — see [`adr/0004`](../../../../adr/0004-second-draft-revision-org-swap-and-closure.md) |
| **Third draft revision (in place)** | **2026-08-05**, same day, applied after the second — see [`adr/0005`](../../../../adr/0005-third-draft-revision-utc-timestamps-and-tagged-funding-details.md) |
| **Supersedes** | none — this is the first version |
| **Superseded by** | none — this is the current version |
| **Feedback** | GitHub issues on [`The-RFP-Hub/the-rfp-hub`](https://github.com/The-RFP-Hub/the-rfp-hub/issues) |
| **License** | CC0 1.0 |

## Maturity: `draft`

`draft` means the shape is **usable and stable enough to publish against, but not frozen**. It
may still change without a new version directory while this maturity holds. Promotion to
`stable` freezes this directory: a `FROZEN` marker file lands in it and CI rejects any PR that
edits it thereafter — see [`PROCESS.md`](../../PROCESS.md).

Feature-level maturity is finer-grained than document-level maturity. No field in this version
is currently annotated `x-stability: provisional`: the three fields that carried the marker
(`serviceAgreement`, `milestones[]`, `programModel`) were promoted to `stable` on 2026-08-05 —
each traces to the M1 research round (the decision interviews, and for `milestones[]` a real
third-party RFP that required it), which the maintainers accepted as the verification the
promotion gate asks for. The `provisional` stage itself remains available for future additions.

## The honest paragraph

**Spec v1.0.0 was re-cut in place on 2026-07-27.** The contents published under this version
string **differ from the contents published under the same version string before that date**.
Documents that validated against the earlier bytes do **not** validate against these: fields were
renamed (`type` → `fundingType`), removed (`organization`, `source.url`, `closesAt`) and added,
and one-block-per-funding-type became a validation rule.

This is the thing semantic versioning exists to prevent. It was done deliberately, once at that
time, and on a narrow basis: the standard had never been published to a package registry, no
external consumer had adopted it, and the milestone that would have declared it complete had
not closed. A version bump would have invented a migration story with nobody on the other end
of it.

**The draft was then revised in place a second time, on 2026-08-05.** The organisation arrays
swapped roles (`operatingOrganizations` is now the required primary array), `networks`, `tags`
and `extensions` were removed (the top level is fully closed, with no extension mechanism),
`eligibility` became free text and its registry was retired, and `resourceLinks`, `funding`,
`organization.type`, `deadline.type` and the `socialLinks` shape were renamed or restructured.
This sits in tension with the earlier record's "in-place re-cuts end here", and the tension is
resolved on the record, not waved away: the standing `PROCESS.md` rule permits in-place edits
**while maturity is `draft` and no external consumer has adopted the version** — both true —
while the once-only sentence governed re-cutting bytes published as final. One honest weakening
since 2026-07-27: the npm package **is** published now (1.0.x), so the basis is draft maturity
plus zero known adopters, no longer unpublishedness. See
[`adr/0004`](../../../../adr/0004-second-draft-revision-org-swap-and-closure.md).

**A third in-place revision landed the same day, after the second.** Every temporal field now
requires UTC with a trailing `Z` (`pattern: "Z$"` beside `format: "date-time"` at all seven
sites), and the six sibling type-block properties plus their 93-line exclusivity `allOf` were
replaced by one required `fundingDetails` object — a `oneOf` over the six unchanged detail
shapes, each self-described by a required `fundingType` tag that a binding `allOf` keeps equal
to the top-level discriminator. The `opportunity[opportunity.fundingType]` access pattern is
superseded. The 39 valid corpus documents were rewritten by script with zero validity changes,
and zero temporal values needed converting. This batch rides the same draft-window permission
as the second revision and adds no new reconciliation argument; its structural record is
[`adr/0005`](../../../../adr/0005-third-draft-revision-utc-timestamps-and-tagged-funding-details.md),
which supersedes ADR-0002 #3.

- **Full rationale and the alternatives considered:**
  [`adr/0001-recut-v1.0.0-in-place.md`](../../../../adr/0001-recut-v1.0.0-in-place.md) (the
  re-cut) and
  [`adr/0004-second-draft-revision-org-swap-and-closure.md`](../../../../adr/0004-second-draft-revision-org-swap-and-closure.md)
  (the second revision)
- **The field decisions themselves:** [`adr/0002-v-next-field-recut.md`](../../../../adr/0002-v-next-field-recut.md),
  superseded in part by `adr/0004`
- **Field-by-field mapping:** the two [field mapping tables](../../CHANGELOG.md#field-mapping-old--new)
  in `CHANGELOG.md`. No row is ever removed from them.
- **The pre-re-cut bytes are preserved** at the git tag
  **`standard/spec-v1.0.0-precut-2026-07`**, created before the first re-cut commit; the
  2026-07-27-shaped bytes, and the intermediate second-revision bytes, are recoverable from
  the history before the respective 2026-08-05 revision commits.

**In-place edits end at promotion to `stable`, permanently.** [`PROCESS.md`](../../PROCESS.md)
states the rule, and the `FROZEN` marker plus the freeze workflow mechanise it so the policy
does not depend on memory. If an external adopter appears before promotion, the next breaking
change is a version bump regardless of maturity.

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
- **Anyone holding pre-2026-08-05 documents holds an invalid shape with no automated signal** —
  `specVersion` reads `1.0.0` on every side of every in-place change, exactly as it did
  across the re-cut. That now includes documents shaped by the *second* 2026-08-05 revision
  but not the third: a document carrying a sibling type block (`"grant": {…}`) or a non-`Z`
  timestamp fails against the current bytes. The three field-mapping tables in `CHANGELOG.md`
  are the remedy. The `eligibility-keys` registry no longer exists; its retired key
  definitions live in the CHANGELOG record and git history only.
- **Raw `oneOf` errors are verbose by construction.** A wrong field inside `fundingDetails`
  makes a plain ajv run report every non-matching branch plus the `oneOf` summary. The
  reference validator filters by the instance's `fundingType` tag (`rfphub-validate`'s
  `explainOneOf`), but implementations reading raw validator output inherit the fan-out — an
  accepted cost recorded in
  [`adr/0005`](../../../../adr/0005-third-draft-revision-utc-timestamps-and-tagged-funding-details.md).
  Conformance is unaffected — the suite asserts nothing about error texts.

## How to comment

Open a GitHub issue. Substantive changes stay open for a minimum comment window before merge;
editorial corrections to informative documents do not need one. Both rules, and the errata
labels used to triage them, are in [`PROCESS.md`](../../PROCESS.md).
