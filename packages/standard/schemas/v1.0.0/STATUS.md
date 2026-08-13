# Status of this version — RFP Hub Standard v1.0.0

*This section describes the status of this version of the standard at the time of publication.
Other documents may supersede it. A machine-readable index of all versions is at
[`schemas/index.json`](../index.json).*

| | |
|---|---|
| **Version** | `1.0.0` |
| **Maturity** | **`stable`** — declared 2026-08-10; this directory is frozen (`FROZEN`) |
| **Identifiers** | **Canonical**, on `ethrfps.app`. Stamped from [`spec.config.json`](../../spec.config.json) — see [`adr/0007`](../../../../adr/0007-canonical-domain-and-spec-identity.md) |
| **Re-cut in place** | **2026-07-27** |
| **Second draft revision (in place)** | **2026-08-05** — see [`adr/0004`](../../../../adr/0004-second-draft-revision-org-swap-and-closure.md) |
| **Third draft revision (in place)** | **2026-08-05**, same day, applied after the second — see [`adr/0005`](../../../../adr/0005-third-draft-revision-utc-timestamps-and-tagged-funding-details.md) |
| **Fourth draft revision (in place)** | **2026-08-10, amended through 2026-08-11 in review** — the bounty type splits into task and security kinds — see [`adr/0008`](../../../../adr/0008-security-bounty-payout-tiers.md) |
| **Canonical identity adopted** | **2026-08-10**, in the same change that declared this version stable — see [`adr/0007`](../../../../adr/0007-canonical-domain-and-spec-identity.md) |
| **Supersedes** | none — this is the first version |
| **Superseded by** | none — this is the current version |
| **Feedback** | GitHub issues on [`The-RFP-Hub/the-rfp-hub`](https://github.com/The-RFP-Hub/the-rfp-hub/issues) |
| **License** | CC0 1.0 |

## Maturity: `stable`

**This version is frozen.** `stable` means the bytes in this directory, and the conformance
suite that defines what conformance to them observably is, will never change again. The
`FROZEN` marker file sits beside this document and
[`.github/workflows/spec-freeze.yml`](../../../../.github/workflows/spec-freeze.yml) fails any
PR that edits this directory, the conformance suite, the meta-schema, the registry entry schema,
or the identity fields of `spec.config.json` — see [`PROCESS.md`](../../PROCESS.md). A breaking
change from here takes a **new version directory**; this one stays published and unedited.

The four in-place draft revisions recorded in the table above — the last of them the bounty
split of 2026-08-10 — happened while the maturity was `draft`, which is the only window
`PROCESS.md` ever permitted them in. That window is now closed permanently.

Feature-level maturity is finer-grained than document-level maturity. The three fields that
once carried `x-stability: provisional` (`serviceAgreement`, `milestones[]`, `programModel`)
were promoted to `stable` on 2026-08-05 — each traces to the M1 research round (the decision
interviews, and for `milestones[]` a real third-party RFP that required it), which the
maintainers accepted as the verification the promotion gate asks for.

The stage refilled on 2026-08-10. The security-bounty payout surface — `bountyKind`,
`rewardTiers[]` and everything inside `$defs/rewardTier` and `$defs/payout`, plus
`severityScheme` and `rewardPoolStatus` — is annotated `provisional`. It rests on a measured
corpus of 247 real programs on the publisher side, but no consumer has shipped against it, and
the gate asks for both. Expect the shape to move.

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
since 2026-07-27: the npm package **is** published now, so the basis is draft maturity
plus zero known adopters, no longer unpublishedness. See
[`adr/0004`](../../../../adr/0004-second-draft-revision-org-swap-and-closure.md).

**A third in-place revision landed the same day, after the second.** Every temporal field now
requires UTC with a trailing `Z` (`pattern: "Z$"` beside `format: "date-time"` at all seven
sites), and the six sibling type-block properties plus their 93-line exclusivity `allOf` were
replaced by one required `fundingDetails` object — a `oneOf` over the six detail
shapes, each self-described by a required `fundingType` tag that a binding `allOf` keeps equal
to the top-level discriminator. The `opportunity[opportunity.fundingType]` access pattern is
superseded. In the same batch the single-currency rule became **document-wide**:
`fundingInfo.currency` denominates every monetary amount, and the per-type currency fields are
gone — `bounty.reward` and `accelerator.funding` are plain numbers, `prizes[]` entries and
`checkSize` lost their `currency` keys. The 39 valid corpus documents were rewritten by script
with zero validity changes, zero temporal values needed converting, and the currency hoist was
conflict-free (no document used a second currency). This batch rides the same draft-window
permission as the second revision and adds no new reconciliation argument; its structural
records are
[`adr/0005`](../../../../adr/0005-third-draft-revision-utc-timestamps-and-tagged-funding-details.md),
which supersedes ADR-0002 #3, and
[`adr/0006`](../../../../adr/0006-document-wide-single-currency.md), which supersedes
ADR-0002 #17.

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

- **The identifiers are canonical; HTTP resolution is not live yet.** This is the honest
  successor to the "no canonical domain" caveat this section carried until 2026-08-10. The
  project owns `ethrfps.app`, its apex is reserved for the spec, and every identifier this
  version publishes is now minted there and is **final** — the freeze covers them.
  - **`$id`** — for the schema, the metaschema and the registry entry schema — is
    `https://ethrfps.app/…`, mirroring this package's own directory layout
    (`/schemas/v1.0.0/opportunity.schema.json`, `/meta/rfphub-schema.meta.json`,
    `/registries/entry.schema.json`).
  - **`@vocab`** is `https://ethrfps.app/ns/rfp#`, versionless by rule: term IRIs are versioned
    by the context *document*, never by the term, so the namespace carries neither a version nor
    a maturity segment. The `draft` segment the provisional IRI used to carry is gone with the
    maturity it mirrored.
  - **What is not true yet:** these URLs **do not resolve to these documents today.**
    `ethrfps.app` is registered and delegated, but it currently points at registrar URL
    forwarding rather than at this service, and nothing answers on `https://`: a consumer that
    dereferences an `$id` or an advertised `@context` gets a connection failure over `https://`
    — the form a browser is forced onto, `.app` being HSTS-preloaded — and, over plain `http://`,
    a redirect to a parking page. Either way it is never one of these documents, and a client
    that follows the redirect gets HTML rather than the hard failure this note used to promise.
    Nothing in this package depends on resolution: the schema is self-contained (local
    `#/$defs` pointers only), the context ships beside it, and `rfphub-validate` reads both from
    disk. Resolution goes live when the apex is routed to the serving path the API already
    implements — it serves every canonical document at its canonical path (`packages/api`, see
    [`ARTIFACTS.md`](../../ARTIFACTS.md)), so the remaining work is operational, not editorial.
  - **The identifiers cannot be swapped again.** They were provisional exactly once, by design;
    the one-time provisional→canonical adoption is recorded in
    [`adr/0007`](../../../../adr/0007-canonical-domain-and-spec-identity.md), machine-recorded as
    `identityStatus: "canonical"` in [`spec.config.json`](../../spec.config.json), and the
    freeze workflow rejects any further identity change — including a revert to `provisional`.
- **Status granularity** — the four-value `status` enum is the most-questioned part of the
  standard. It is unresolved, not settled.
- **`vc_fund` has no benchmark-fixture coverage** — none of the 30 fixtures in
  [`BENCHMARK.md`](./BENCHMARK.md) is a VC fund, so within this repository the type is exercised
  by one hand-researched entry in the Hub's seed corpus and no benchmark fixture.
- **Anyone holding pre-2026-08-05 documents holds an invalid shape with no automated signal** —
  `specVersion` reads `1.0.0` on every side of every in-place change, exactly as it did
  across the re-cut. That now includes documents shaped by the *second* 2026-08-05 revision
  but not the third: a document carrying a sibling type block (`"grant": {…}`), a non-`Z`
  timestamp, or a per-type currency key (a prize's own `currency`, a `{amount, currency}`
  reward) fails against the current bytes. The three field-mapping tables in `CHANGELOG.md`
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
