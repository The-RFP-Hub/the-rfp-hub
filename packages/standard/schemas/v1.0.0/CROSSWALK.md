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

> ⚠️ **v1.0.0 was re-cut in place on 2026-07-27** and this crosswalk was reissued with it. If you
> are holding a copy of this file that maps `organization`, `source.url`, `closesAt`,
> `funding.totalBudget` or `grant.fundingMechanism`, it predates the re-cut — see
> the [field mapping table](../../CHANGELOG.md#field-mapping-old--new) in `CHANGELOG.md`.

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
| `sponsoringOrganizations[]` | `funder` (Organization) — **repeatable, so the array maps cleanly** | **Grant System** (the administering body) |
| `sponsoringOrganizations[0].name` | `funder.name` | grant system `name` |
| `operatingOrganizations[]` | `sponsor` — **loose**: schema.org's `sponsor` is another funding-side role, not an operator. The JSON-LD context uses it as the nearest available term; a consumer that needs "who runs intake" must read the RFP Hub field | — |
| `organization.contacts[]` | `contactPoint` | — |
| `organization.logoUrl` / `bannerUrl` | `logo` / `image` | — |

### Money

| RFP Hub v1.0.0 | schema.org/Grant | DAOIP-5 |
|---|---|---|
| `funding.budget` | `amount` (MonetaryAmount) | `totalGrantPoolSize[].amount` |
| `funding.currency` | `amount.currency` | `totalGrantPoolSize[].denomination` |
| `funding.allocated` (committed to date) | — | — |
| `funding.minAward` / `maxAward` | — | — |
| `milestones[]` | — | — (no Grant Pool equivalent) |
| `bounty.reward`, `hackathon.prizes[]`, `accelerator.funding` | `amount` (loosely) | — |

**Cardinality divergence.** DAOIP-5's `totalGrantPoolSize` is an **array** of
`{amount, denomination}`; the RFP Hub envelope is **single-currency by design**. Exporting to
DAOIP-5 emits a one-element array. Importing from DAOIP-5 takes the primary amount and must put
any further denominations in `description` or `extensions` — that direction is lossy, and
deliberately so.

### Dates

| RFP Hub v1.0.0 | schema.org/Grant | DAOIP-5 |
|---|---|---|
| `deadlines[]` where `label = "application"` | — | `closeDate` |
| `deadlines[]` — every other label (`registration`, `submission`, `event start`, `event end`, `community feedback`) | — | — |
| `deadlines[].type = "rolling"` | — | — (DAOIP-5 has no rolling form; `isOpen` carries what it can) |
| `opensAt` | `startDate` | — |
| `postedAt` | `datePublished` | — |
| `createdAt` / `updatedAt` | `dateCreated` / `dateModified` | — |

**Cardinality divergence.** DAOIP-5 has one scalar `closeDate`; the RFP Hub has an array of
labelled deadlines. Exporting takes the earliest future `application` deadline. Importing yields
a single `{type: "fixed", date, label: "application"}` entry — every other deadline the source
had, if it had any, was already lost before it reached us.

### Eligibility, requirements, links

| RFP Hub v1.0.0 | schema.org/Grant | DAOIP-5 |
|---|---|---|
| `applicationUrl` | `url` | `applicationsURI` |
| `website` | `sameAs` | — (`governanceURI` is a different thing) |
| `socialLinks` | — (a platform-keyed object, not a list of `sameAs` URLs; resolves under the RFP Hub vocabulary) | — |
| `resourceLinks` | `citation` (loose) | — |
| `eligibility` (open key→value map) | `eligibleCustomerType` (loose) | — |
| `prerequisites` | `competencyRequired` (loose) | — |
| `serviceAgreement` | — | — |
| `rfp.scope` / `rfp.requirements` | — | — |
| `categories` / `tags` | `about` / `keywords` (loose) | — |
| `ecosystems` / `networks` | — | — (RFP Hub extension) |

### Grant mechanics and provenance

| RFP Hub v1.0.0 | schema.org/Grant | DAOIP-5 |
|---|---|---|
| `grant.fundingMechanisms[]` | — | `grantFundingMechanism` — **singular there, array here** |
| `grant.programModel` | — | — |
| `grant.milestoneBased` / `grant.recurring` | — | — |
| `source.publisher` | `publisher` | — |
| `source.submittedBy` | `contributor` | — |
| `source.submittedAt` | `dateCreated` | — |
| `source.snapshotUrl` | `archivedAt` | — |
| `source.originalId` | `identifier` (scoped to the provenance object in the context) | — |
| `source.ingestedVia` / `verifiedAgainstSource` / `verifiedAt` | — | — (RFP Hub provenance extension) |
| `extensions` | — | `extensions` |

**Cardinality divergence.** `grant.fundingMechanisms` is an array (mechanisms co-occur — a fixed
grant plus a matching grant in the same program); DAOIP-5's `grantFundingMechanism` is a scalar.
Export takes the first element or joins them; either choice loses information, so the export
adapter should pick one and document it. Value-level alignment is partial, not one-to-one:
`retroactive` → `"Retro Funding"`, `quadratic` → `"Quadratic Funding"`,
`streaming` → `"Streaming Quadratic Funding"` (nearest), `proactive` → `"Direct Grants"`
(nearest) — while `matching` and `other` have **no counterpart** in DAOIP-5's
`grantFundingMechanism` enum and an export adapter must drop them or carry them in
`extensions`. Quote DAOIP-5's values exactly as its spec spells them; the enum is theirs,
not ours.

### Type blocks beyond both standards

`hackathon`, `bounty`, `accelerator` and `vc_fund` have **no equivalent** in either standard.
DAOIP-5 models grants; schema.org models `Grant`. Everything inside those four blocks —
tracks, prizes, team sizes, check sizes, investment stages, equity, batch size — is an RFP Hub
extension and does not round-trip.

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
  | `governanceURI` | — (no governance-document slot; a publisher can use `resourceLinks`) |
  | `attestationIssuersURI` | — (attestations are out of scope for v1.0.0) |
  | `requiredCredentials` | — (nearest is the open `eligibility` map, and only loosely) |
  | `totalGrantPoolSizeInUSD` | — (derivable at export when `funding.currency` is USD; never stored) |
  | `email` | `organization.contacts[].email` (loose — theirs is pool-level) |
  | `image` / `coverImage` | `logoUrl` / `bannerUrl` (loose — theirs are pool-level, ours program-level) |
- ⚠️ **The earlier claim that "no v1.0.0 field had to change to align" no longer holds, and
  should not be repeated.** Fields *did* change — not to chase alignment, but because the
  2026-07-27 design decisions re-cut the shape. Three mappings were reissued as a direct
  consequence:
  - `source.url` → the `sameAs` sense **has no successor**. `applicationUrl` carries the
    `schema:url` / `applicationsURI` sense alone; a publisher who needs the original posting
    on the record puts it in `resourceLinks`, which maps only loosely to `schema:citation`.
  - `organization` → `sponsoringOrganizations[]`, which maps *better* than before: schema.org
    carries `funder` **and** `sponsor`, and both are repeatable.
  - `closesAt` → `deadlines[]`, which maps *worse* than before: one scalar became a labelled
    array and only the `application` label round-trips to `closeDate`.

  See the [field mapping table](../../CHANGELOG.md#field-mapping-old--new) for the full
  field-by-field record and
  [`adr/0002`](../../../../adr/0002-v-next-field-recut.md) for why.
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
  "sponsoringOrganizations": [{ "name": "Example Foundation" }],
  "source": { "publisher": "example", "ingestedVia": "publisher_api" },
  "applicationUrl": "https://example.org/grants/apply",
  "deadlines": [
    { "type": "fixed", "date": "2026-12-31T23:59:59.000Z", "label": "application" }
  ],
  "funding": { "currency": "USD", "budget": 250000 },
  "grant": { "fundingMechanisms": ["retroactive", "matching"] }
}
```

A JSON-LD processor expands this to a `schema:Grant` with `schema:identifier` / `schema:name` /
`schema:description` / `schema:funder` / `schema:url`, with `budget` under
`daoip5:totalGrantPoolSize` and `fundingMechanisms` under `daoip5:grantFundingMechanism`.

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
  JSON document, not the expanded form.

Verify it yourself:

```bash
npx rfphub-validate that-document.json
```

*(The `$id` and `@context` hosts are placeholders pending the project domain decision — the
documents they name are in this directory.)*
