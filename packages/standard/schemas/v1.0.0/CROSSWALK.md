# RFP Hub Standard ↔ DAOIP-5 ↔ schema.org/Grant

The project's brief is to **build on** the **DAOIP-5 Grants Metadata Standard** and
**schema.org/Grant** rather than start from scratch. This crosswalk documents how the RFP Hub
Standard v1.0.0 maps onto both, so a consumer can translate between them.

**This document is informative** — the schema is normative
([`NORMATIVE.md`](../../NORMATIVE.md)). It is also corrigible: a wrong mapping row can be fixed
outside the release cycle.

- **schema.org/Grant** is intentionally minimal (a handful of properties on `Thing` + `funder`,
  `sponsor`, `amount`, `fundedItem`). Every one of its fields has a clean RFP Hub equivalent
  except `fundedItem`: a Grant links to the thing it funded, and an opportunity predates its
  awards, so there is deliberately nothing to map it to.
- **DAOIP-5** is a JSON-LD family of objects: **Grant System** (the administering body),
  **Grant Pool** (an open funding opportunity), **Project**, **Application**. The RFP Hub
  **Opportunity** is closest to a **Grant Pool**; our **Organization** ≈ a **Grant System**.
  DAOIP-5 is grant-centric, so our non-grant types (hackathon/bounty/accelerator/vc_fund) and
  several fields extend beyond it.

> If you are holding an older copy of this crosswalk — one that maps `organization`,
> `closesAt`, `networks`, `tags`, `extensions`, a `funding` envelope, or six sibling type
> blocks instead of a tagged `fundingDetails` object — it predates the current draft; the
> field mapping tables in [`CHANGELOG.md`](../../CHANGELOG.md#field-mapping-old--new) record
> what moved where.

## Field mapping (Opportunity)

"—" means **no equivalent exists** in that standard. It is not shorthand for "not yet mapped".

### Identity and description

| RFP Hub v1.0.0 | schema.org/Grant | DAOIP-5 (Grant Pool unless noted) |
|---|---|---|
| `id` | `identifier` | `id` |
| `title` | `name` | `name` |
| `description` | `description` | `description` |
| `summary` | `disambiguatingDescription` | — |
| `fundingType` (6 values) | — (`Grant` is the only type) | — (a Grant Pool is a grant by definition) |
| `status` (4 values) | — | `isOpen` (boolean) — **lossy both ways**: four lifecycle values collapse to one boolean, and `upcoming` vs `open` is unrecoverable |
| `specVersion` | `schemaVersion` | — |

### Organisations

| RFP Hub v1.0.0 | schema.org/Grant | DAOIP-5 |
|---|---|---|
| `operatingOrganizations[]` — **required, `[0]` is the primary/display org** | `sponsor` — **loose**: schema.org's `sponsor` is another funding-side role, not an operator. The JSON-LD context uses it as the nearest available term; a consumer that needs "who runs intake" must read the RFP Hub field | — |
| `sponsoringOrganizations[]` — **optional** since the 2026-08-05 revision | `funder` (Organization) — **clean and repeatable** | **Grant System** (the administering body) |
| `sponsoringOrganizations[].name` (when the array is present) | `funder.name` | grant system `name` |
| `organization.contacts[]` | `contactPoint` | — |
| `organization.logoUrl` / `bannerUrl` | `logo` / `image` | — |

**The honest asymmetry, stated as an accepted cost** (per
[`adr/0004`](../../../../adr/0004-second-draft-revision-org-swap-and-closure.md)): the 2026-08-05
role swap made the **required, primary** array the one with the **loose** mapping
(`operatingOrganizations → schema:sponsor`), while the clean `schema:funder` / Grant System
mapping hangs off an array that is now **optional** — a funder-seeking external consumer may
find `sponsoringOrganizations` absent entirely. The terms were not reassigned because doing so
would be semantically false: an operator is not a funder. The swap's reasoning is the RFP Hub's
own: operating = who actually runs the process = the entity consumers need first.

### Money

| RFP Hub v1.0.0 | schema.org/Grant | DAOIP-5 |
|---|---|---|
| `fundingInfo.budget` | `amount` (MonetaryAmount) | `totalGrantPoolSize[].amount` |
| `fundingInfo.currency` | `amount.currency` | `totalGrantPoolSize[].denomination` |
| `fundingInfo.allocated` (committed to date) | — | — |
| `fundingInfo.minAward` / `maxAward` | — | — |
| `milestones[]` | — | — (no Grant Pool equivalent) |
| `fundingDetails.reward` (bounty), `fundingDetails.prizes[]` (hackathon), `fundingDetails.funding` (accelerator) | `amount` (loosely) | — |

**Cardinality divergence.** DAOIP-5's `totalGrantPoolSize` is an **array** of
`{amount, denomination}`; the RFP Hub envelope is **single-currency by design**. Exporting to
DAOIP-5 emits a one-element array. Importing from DAOIP-5 takes the primary amount and must put
any further denominations in `description` prose — since the 2026-08-05 revision there is no
`extensions` overflow slot, so the import **drops** what prose does not carry. That direction
is lossy, deliberately, and lossier than before.

### Dates

| RFP Hub v1.0.0 | schema.org/Grant | DAOIP-5 |
|---|---|---|
| `deadlines[]` where `label = "application"` | — | `closeDate` |
| `deadlines[]` — every other label (`registration`, `submission`, `event start`, `event end`, `community feedback`) | — | — |
| `deadlines[].deadlineType = "rolling"` | — | — (DAOIP-5 has no rolling form; `isOpen` carries what it can) |
| `opensAt` | `startDate` | — |
| `postedAt` | `datePublished` | — |
| `createdAt` / `updatedAt` | `dateCreated` / `dateModified` | — |

**Cardinality divergence.** DAOIP-5 has one scalar `closeDate`; the RFP Hub has an array of
labelled deadlines. Exporting takes the earliest future `application` deadline. Importing yields
a single `{deadlineType: "fixed", date, label: "application"}` entry — every other deadline the source
had, if it had any, was already lost before it reached us.

**Value profile.** Since the third 2026-08-05 revision, every RFP Hub temporal value is an
RFC 3339 `date-time` **in UTC with a trailing `Z`** (schema-enforced). Importing a value that
carries a numeric offset means converting it to UTC first; schema.org's `DateTime` and
DAOIP-5's `closeDate` both accept the UTC form on export, so that direction is unaffected.

### Eligibility, requirements, links

| RFP Hub v1.0.0 | schema.org/Grant | DAOIP-5 |
|---|---|---|
| `applicationUrl` | `url` | `applicationsURI` |
| `website` | `sameAs` | — (`governanceURI` is a different thing) |
| `socialLinks[]` (entries of `{platform, url}`) | — as a whole (still not a `sameAs` list — the entries are typed pairs, not bare URLs). **Per entry**, `url` maps to `schema:url` via a scoped context; `platform` is RFP Hub vocabulary | — |
| `additionalReferences` | `citation` (loose) | — |
| `eligibility` (free text) | `eligibleCustomerType` (loose — arguably less loose than before: its schema.org range was always Text-friendly, never a key→value map) | — |
| `prerequisites` | `competencyRequired` (loose) | — |
| `serviceAgreement` | — | — |
| `fundingDetails.scope` / `fundingDetails.requirements` (rfp) | — | — |
| `categories` | `about` (loose) — the `keywords` mapping died with `tags` in the 2026-08-05 revision; nothing maps to `schema:keywords` now | — |
| `ecosystems` | — | — (RFP Hub-specific; `networks` was removed 2026-08-05) |

### Grant mechanics and provenance

| RFP Hub v1.0.0 | schema.org/Grant | DAOIP-5 |
|---|---|---|
| `fundingDetails.fundingType` (the tag; equals top-level `fundingType`) | — | — |
| `fundingDetails.fundingMechanisms[]` (grant) | — | `grantFundingMechanism` — **singular there, array here** |
| `fundingDetails.programModel` (grant) | — | — |
| `fundingDetails.milestoneBased` / `fundingDetails.recurring` (grant) | — | — |
| `source.publisher` | `publisher` | — |
| `source.submittedBy` | `contributor` | — |
| `source.submittedAt` | `dateCreated` | — |
| `source.snapshotUrl` | `archivedAt` | — |
| `source.originalId` | `identifier` (scoped to the provenance object in the context) | — |
| `source.ingestedVia` / `verifiedAgainstSource` / `verifiedAt` | — | — (RFP Hub provenance extension) |
| ~~`extensions`~~ — **removed 2026-08-05** | — | ~~`extensions`~~ — this was the standard's only 1:1 same-name DAOIP-5 mapping, and the alignment point is lost with the field. `daoip5:extensions` content in an import now has **no destination and is dropped** |

**Cardinality divergence.** The grant payload's `fundingMechanisms` is an array (mechanisms co-occur — a fixed
grant plus a matching grant in the same program); DAOIP-5's `grantFundingMechanism` is a scalar.
Export takes the first element or joins them; either choice loses information, so the export
adapter should pick one and document it. Value-level alignment is partial, not one-to-one:
`retroactive` → `"Retro Funding"`, `quadratic` → `"Quadratic Funding"`,
`streaming` → `"Streaming Quadratic Funding"` (nearest), `proactive` → `"Direct Grants"`
(nearest) — while `matching` and `other` have **no counterpart** in DAOIP-5's
`grantFundingMechanism` enum and an export adapter **must drop them**: the `extensions`
overflow slot that used to carry them was removed on 2026-08-05, so that loss is now total
rather than optional. Quote DAOIP-5's values exactly as its spec spells them; the enum is
theirs, not ours.

### Detail payloads beyond both standards

The `hackathon`, `bounty`, `accelerator` and `vc_fund` payloads of `fundingDetails` have
**no equivalent** in either standard.
DAOIP-5 models grants; schema.org models `Grant`. Everything inside those four shapes —
tracks, prizes, team sizes, check sizes, investment stages, equity, batch size — is an RFP Hub
extension and does not round-trip. (The shapes themselves are unchanged by the third
2026-08-05 revision: they moved under the single tagged `fundingDetails` key, they did not
change fields.)

Self-identification keys (`$schema`, `@context`, `@type`) are JSON Schema and JSON-LD machinery,
not domain fields; they have no crosswalk row.

## Alignment status

- ✅ **Crosswalk verified** against the published DAOIP-5 spec (Grant System + Grant Pool
  objects) and schema.org/Grant. Every schema.org/Grant property except `fundedItem` has an
  RFP Hub equivalent (see above). **The reverse direction is not complete and this document
  does not claim it is** — the DAOIP-5 Grant Pool fields with no RFP Hub field are listed
  below, each a deliberate absence rather than an oversight:

  | DAOIP-5 Grant Pool field | RFP Hub disposition |
  |---|---|
  | `governanceURI` | — (no governance-document slot; a publisher can use `additionalReferences`) |
  | `attestationIssuersURI` | — (attestations are out of scope for v1.0.0) |
  | `requiredCredentials` | — (nearest is the free-text `eligibility` field, and only loosely — looser than before: since 2026-08-05 a credential list cannot even land under a conventional key, only in prose) |
  | `totalGrantPoolSizeInUSD` | — (derivable at export when `fundingInfo.currency` is USD; never stored) |
  | `email` | `organization.contacts[].email` (loose — theirs is pool-level) |
  | `image` / `coverImage` | `logoUrl` / `bannerUrl` (loose — theirs are pool-level, ours program-level) |
- ⚠️ **The earlier claim that "no v1.0.0 field had to change to align" no longer holds, and
  should not be repeated.** Fields *did* change — not to chase alignment, but because the
  2026-07-27 design decisions re-cut the shape. Three mappings were reissued as a direct
  consequence:
  - `source.url` → the `sameAs` sense **has no successor**. `applicationUrl` carries the
    `schema:url` / `applicationsURI` sense alone; a publisher who needs the original posting
    on the record puts it in `additionalReferences` (named `resourceLinks` until 2026-08-05),
    which maps only loosely to `schema:citation`.
  - `organization` → `sponsoringOrganizations[]`, which mapped *better* than before: schema.org
    carries `funder` **and** `sponsor`, and both are repeatable.
  - `closesAt` → `deadlines[]`, which maps *worse* than before: one scalar became a labelled
    array and only the `application` label round-trips to `closeDate`.

  The **2026-08-05 second draft revision** reissued mappings again:
  - the organisation role swap put the loose `schema:sponsor` mapping on the required primary
    array and the clean `schema:funder` / Grant System mapping on an optional one (see the
    Organisations section above — an accepted cost, `adr/0004`);
  - `extensions` (and with it `daoip5:extensions`, the only 1:1 DAOIP-5 mapping) and the
    `tags → schema:keywords` mapping were removed with their fields, and lossy imports lost
    their overflow slot — they now drop data;
  - `resourceLinks → additionalReferences` and `funding → fundingInfo` renamed their rows;
    `eligibility`'s loose `eligibleCustomerType` mapping now covers free text; `socialLinks`
    gained a real per-entry `url → schema:url` mapping the keyed object never had.

  The **2026-08-05 third draft revision** re-keyed rather than re-targeted: the six sibling
  type blocks became payloads of one tagged `fundingDetails` object, so this document's
  detail-payload rows now read `fundingDetails.…`. No schema.org or DAOIP-5 term assignment
  moved — the payload fields kept their IRIs (`fundingMechanisms` still maps to
  `daoip5:grantFundingMechanism` at its new depth), the accelerator `funding → schema:amount`
  scoped mapping re-homed under `fundingDetails`, and the new `fundingType` tag inside the
  payload expands under `schema:additionalType`, exactly like the top-level discriminator
  whose value it repeats. Temporal values are additionally UTC-`Z` only.

  See the [field mapping tables](../../CHANGELOG.md#field-mapping-old--new) for the full
  field-by-field record, and
  [`adr/0002`](../../../../adr/0002-v-next-field-recut.md) /
  [`adr/0004`](../../../../adr/0004-second-draft-revision-org-swap-and-closure.md) /
  [`adr/0005`](../../../../adr/0005-third-draft-revision-utc-timestamps-and-tagged-funding-details.md)
  for why.
- ✅ **JSON-LD `@context` shipped** — [`context.jsonld`](./context.jsonld), covering every
  top-level property of the re-cut shape (CI fails on context↔schema drift in either direction).
  Term IRIs are **versionless** (`https://github.com/The-RFP-Hub/the-rfp-hub/ns/draft/rfp#`, provisional
  pending a canonical domain); the context *document* is what
  gets versioned. Every field with no schema.org or DAOIP-5 equivalent resolves under the RFP Hub
  vocabulary, so nothing is dropped when a document is read as linked data.
- ⬜ **DAOIP-5 `grantPools` export** (optional, planned) — a one-way *output adapter* that emits
  grant-type opportunities as DAOIP-5 `grantPools` JSON, applying the three cardinality
  reductions above. This is an export *format*, **not** a prerequisite for the standard being
  aligned. See [`ARTIFACTS.md`](../../ARTIFACTS.md).

## Using the JSON-LD context

A document may carry `@context` and `@type` at the top level and **still validate** — the
three self-identification keys are permitted against `additionalProperties: false` for exactly
this reason ([`adr/0003`](../../../../adr/0003-instance-self-identification-and-version-pattern.md)).
The example below is a conforming RFP Hub opportunity:

```json
{
  "$schema": "https://raw.githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/packages/standard/schemas/v1.0.0/opportunity.schema.json",
  "@context": "https://raw.githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/packages/standard/schemas/v1.0.0/context.jsonld",
  "@type": "schema:Grant",
  "specVersion": "1.0.0",
  "id": "example:grant-1",
  "fundingType": "grant",
  "title": "Example Grants",
  "description": "An example grant program, published as both plain JSON and linked data.",
  "status": "open",
  "sponsoringOrganizations": [{ "name": "Example Foundation", "slug": "example-foundation" }],
  "operatingOrganizations": [{ "name": "Example Operations Co", "slug": "example-operations" }],
  "source": { "publisher": "example", "ingestedVia": "publisher_api" },
  "applicationUrl": "https://example.org/grants/apply",
  "socialLinks": [{ "platform": "twitter", "url": "https://x.com/example" }],
  "deadlines": [
    { "deadlineType": "fixed", "date": "2026-12-31T23:59:59.000Z", "label": "application" }
  ],
  "fundingInfo": { "currency": "USD", "budget": 250000 },
  "fundingDetails": { "fundingType": "grant", "fundingMechanisms": ["retroactive", "matching"] }
}
```

A JSON-LD processor expands this to a `schema:Grant` with `schema:identifier` / `schema:name` /
`schema:description` / `schema:funder` (the sponsoring org) / `schema:sponsor` (the operating
org) / `schema:url`, with `budget` under `daoip5:totalGrantPoolSize`, the details object under
the RFP Hub `fundingDetails` term (its `fundingMechanisms` still lands under
`daoip5:grantFundingMechanism`, and its `fundingType` tag under `schema:additionalType`, same
as the top-level discriminator), and each social link's `url` under `schema:url` in its scoped
context.

Two processing guarantees and one caveat, all verified against jsonld.js:

- **One term per IRI, per scope.** Keys that share a target IRI (`title` and organisation
  `name` both mean `schema:name`; `id` and `source.originalId` both mean `schema:identifier`;
  `source.submittedAt` and `createdAt` both mean `schema:dateCreated`) are disambiguated with
  property-scoped contexts, so `expand` → `compact` with this context reproduces the original
  document shape and the result still validates against the schema.
- **Arrays stay arrays.** Every array-valued field carries `@container` (`@set`, or `@list`
  for `milestones`), so a one-element array does not collapse to a bare object on compaction.
- **`null` does not survive JSON-LD processing.** The JSON-LD spec defines a `null` value as
  property removal, so the schema's distinction between *explicitly unknown* (`null`) and
  *absent* exists at the JSON Schema layer only. A consumer that needs it must read the plain
  JSON document, not the expanded form. **Empty arrays do not survive either** — an explicit
  `"sponsoringOrganizations": []` compacts away to absence. Since the 2026-08-05 revision every
  *required* array carries `minItems: 1` and every possibly-empty array is optional, so the
  round-tripped document still validates; only the empty-vs-absent nuance is lost, same as
  `null`.

Verify it yourself:

```bash
npx rfphub-validate that-document.json
```

*(The `$id` and `@context` hosts are placeholders pending the project domain decision — the
documents they name are in this directory.)*
