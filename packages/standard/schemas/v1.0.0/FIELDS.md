# RFP Hub Standard v1.0.0 — Field Reference

The **RFP Hub Standard** is a canonical, ecosystem-neutral representation of a funding
opportunity in the Ethereum ecosystem. The normative artifact is
[`opportunity.schema.json`](./opportunity.schema.json) (JSON Schema, draft 2020-12). This
document is the human-readable companion: it explains every field, the lifecycle/status
semantics, and how the standard maps to Karma's internal `program_registry`.

- **License:** CC0 1.0 (the standard and its docs are public domain).
- **Spec version:** `1.0.0` (every entry carries `specVersion: "1.0.0"`).
- **Canonical `$id`:** `https://rfphub.org/standard/v1.0.0/opportunity.schema.json`
  — ⚠️ **placeholder host.** The final stable URL depends on the `rfp-hub` org / domain
  (we are creating the org; domain TBD). Update `$id` once decided; the path layout
  (`/standard/<version>/opportunity.schema.json`) is intended to be stable.

## Scope (per DEV-437)

The Hub is **ETH-scoped**, not a multi-ecosystem catch-all. It does not attempt to absorb
Solana/Cosmos/other non-ETH ecosystems. However, `ecosystems` is an **open, extensible
list — not a closed enum** — so the Ethereum L1 plus L2s and ETH-adjacent ecosystems
(Optimism, Base, Arbitrum, Polygon, Scroll, zkSync, Linea, OP Stack, Celo, …) are all
first-class. This keeps the standard from needing a rewrite if positioning is refined.

## Design principles

1. **Decoupled from Karma.** Karma-internal / on-chain-Allo fields (`chainID`, `profileId`,
   `offChain`, `anchorAddress`, `registryAddress`, `txHash`, `langfusePromptId`,
   `createdAtBlock`) are **deliberately excluded** from the public standard. Forkability
   dies if the neutral hub re-couples to Karma's schema. Such data, if needed, goes under
   `extensions` with namespaced keys (e.g. `karma.programId`).
2. **Provenance-first.** Every entry MUST carry a `source.url`. This is what the
   verification-assist job (M3) fetches to confirm the opportunity exists and diff fields.
3. **Closed core, open edges.** The top-level object and all type-specific blocks are
   `additionalProperties: false`. Arbitrary publisher/integrator data goes in the
   free-form `extensions` object. New standard fields arrive via minor-version bumps.
4. **Alignment.** Concepts align with DAOIP-5 (Grants Metadata) and schema.org/Grant where
   practical, without inheriting their full surface area.

---

## Top-level fields

| Field | Type | Req. | Notes |
|---|---|:--:|---|
| `specVersion` | const `"1.0.0"` | ✅ | Standard version the entry conforms to. |
| `id` | string | ✅ | Stable, immutable, unique within the Hub. `^[A-Za-z0-9._:-]+$`, ≤128. Namespaced form (`filecoin:propgf-batch-3`) recommended. |
| `type` | enum | ✅ | One of `grant`, `hackathon`, `bounty`, `accelerator`, `vc_fund`, `rfp`. Matches Karma's `OpportunityType`. |
| `title` | string | ✅ | ≤300 chars. |
| `description` | string | ✅ | Full description. Markdown allowed; treat as untrusted, sanitise on render. |
| `summary` | string\|null | | Short teaser (≤500) for cards/lists. ← Karma `metadata.shortDescription`. |
| `status` | enum | ✅ | Lifecycle: `upcoming` \| `open` \| `closed` \| `archived`. See [Status](#status-semantics). |
| `organization` | object | ✅ | Issuing org; `name` required. |
| `source` | object | ✅ | Provenance; `url` required. See [Provenance](#provenance-source). |
| `ecosystems` | string[] | | ETH-family ecosystems. Open list, unique items. |
| `networks` | string[] | | Specific chains/networks. Open list. |
| `categories` | string[] | | Topical categories. Open list. |
| `tags` | string[] | | Free-form tags. |
| `applicationUrl` | string(uri)\|null | | Where to apply/submit. ← Karma `submissionUrl`. |
| `website` | string(uri)\|null | | Primary website. |
| `logoUrl` | string(uri)\|null | | Logo image. |
| `bannerUrl` | string(uri)\|null | | Banner/hero image. |
| `socialLinks` | object | | `twitter`, `discord`, `github`, `telegram`, `farcaster`, `forum`, `blog`. |
| `funding` | object | | Funding envelope (see below). |
| `opensAt` | date-time\|null | | When applications open. ← Karma `metadata.startsAt`. |
| `closesAt` | date-time\|null | | Application deadline. ← Karma `deadline` / `metadata.endsAt`. Drives auto-`closed`. |
| `postedAt` | date-time\|null | | First public announcement at source. |
| `createdAt` | date-time\|null | | When created in the Hub. |
| `updatedAt` | date-time\|null | | When last modified in the Hub. |
| `grant` | object | cond. | Present (may be `{}`) iff `type=grant`. |
| `hackathon` | object | cond. | Present iff `type=hackathon`. |
| `bounty` | object | cond. | Present iff `type=bounty`. |
| `accelerator` | object | cond. | Present iff `type=accelerator`. |
| `vc_fund` | object | cond. | Present iff `type=vc_fund`. |
| `rfp` | object | cond. | Present iff `type=rfp`. |
| `extensions` | object | | Free-form, namespaced. Not validated by the schema. |

All date-time fields are **RFC 3339 / ISO 8601** strings.

### `organization` (the funder / issuer)
`name` (req.), `slug` (`^[a-z0-9-]+$`, = namespace), `type` (foundation/dao/company/protocol/program/individual/other), `description`, `website` (uri), `logoUrl` (uri), `bannerUrl` (uri), `socialLinks`, `ecosystems[]`. Embedded as a summary on each opportunity; the same shape is the standalone Organization directory record. **No `verified` flag** — verification belongs to the *publishing relationship* (a user permissioned on a verified org), not to the issuer.

### `provenance` (`source`)
| Field | Type | Req. | Notes |
|---|---|:--:|---|
| `url` | string(uri) | ✅ | Canonical URL of the original posting. |
| `publisher` | string\|null | | Namespace (org slug) the entry was published under. T2 auto-approval requires the publishing account to be a member of this verified org. May differ from the issuing org. |
| `submittedBy` | string\|null | | Who submitted/published — public handle, org slug, or `community`. Internal account identity not exposed. |
| `ingestedVia` | enum\|null | | `publisher_api` \| `submission` \| `scrape` \| `import` \| `karma_outbox`. |
| `originalId` | string\|null | | ID in the source system (e.g. Karma `programId`). |
| `verifiedAgainstSource` | bool\|null | | Set by the verification-assist job. `null` = not yet checked. |
| `verifiedAt` | date-time\|null | | Last source verification time. |
| `snapshotUrl` | string(uri)\|null | | IPFS/archived snapshot at verification time. |

### `funding`
`currency` (ISO 4217 or token symbol), `minAward`, `maxAward`, `totalBudget`,
`amountDistributed` (all numbers ≥0, major units), `awardsToDate` (integer ≥0).

### Type-specific blocks (discriminated by `type`)

Every entry carries exactly one type-specific object under a key **equal to its `type`
value**, so a consumer can always read `opportunity[opportunity.type]` to get the type
payload — a `hackathon` entry has a `hackathon` object, a `vc_fund` entry has a `vc_fund`
object, and so on. The matching block is **required for all six types**; for grants it MAY
be an empty object (`{}`). The full type payload is omitted from list responses — see
[Delivery](#delivery-api-list-vs-detail).

- **`grant`** — `fundingMechanism` (`retroactive`/`proactive`/`streaming`/`quadratic`/`other`),
  `milestoneBased`, `recurring`. May be `{}`; core funding/date fields live at the top level.
- **`hackathon`** — `startDate`, `endDate`, `location`, `online`, `tracks[]`, `prizes[]`
  (`{track?, amount, currency}`), `registrationDeadline`, `submissionDeadline`,
  `teamSize {min,max}`.
- **`bounty`** — `reward {amount,currency}` (req.), `difficulty`
  (`beginner`/`intermediate`/`advanced`), `skills[]`, `platform`.
- **`accelerator`** — `applicationDeadline`, `programDurationWeeks`, `batchSize`, `equity`,
  `funding {amount,currency}`, `stage` (`pre-seed`/`seed`/`series-a`), `location`, `online`.
- **`vc_fund`** — `checkSize {min,max,currency}`, `stages[]`
  (`pre-seed`/`seed`/`series-a`/`series-b+`/`growth`), `thesis`, `portfolio[]`,
  `contactMethod` (`email`/`form`/`intro-only`), `activelyInvesting`.
- **`rfp`** — `issuingOrganization`, `budget {amount,currency}`, `scope`, `requirements[]`,
  `proposalDeadline`.

## Delivery (API list vs detail)

The schema defines the **canonical, full** opportunity object — used for the detail endpoint,
exports, IPFS snapshots, and agent payloads. For bandwidth, **list/search responses return a
lighter projection**: core fields only, **omitting the type-specific block**
(`opportunity[type]`) and `extensions`. Clients fetch the full object from the detail endpoint
(`GET /v1/opportunities/:id`). This is an API-delivery concern (specified in the M2 OpenAPI) —
it does not change the object's canonical schema.

---

## Status semantics

`status` describes the **public lifecycle** of the opportunity, not editorial/review state:

| Value | Meaning |
|---|---|
| `upcoming` | Announced but not yet accepting applications. |
| `open` | Currently accepting applications. |
| `closed` | Deadline passed or no longer accepting. Auto-set when `closesAt` passes (M3 staleness job). |
| `archived` | Withdrawn or retired. |

Review state (`pending`, `rejected`) and the verified/auto-approved distinction are
**server-side metadata**, not part of the public object. (Karma's `isValid: null/true/false`
is editorial state and does NOT map to `status`.)

---

## Karma `program_registry` → Standard mapping

Reference for the M2 seed dataset and the DEV-439 Karma→Hub outbox contract.

| Karma field | Standard field | Transform |
|---|---|---|
| `programId` | `source.originalId` + `extensions["karma.programId"]` | also basis for `id` (`karma:<programId>`) |
| `type` | `type` | identity (enum values already match) |
| `name` / `metadata.title` | `title` | prefer `metadata.title`, fall back to `name` |
| `metadata.description` | `description` | identity |
| `metadata.shortDescription` | `summary` | identity |
| `metadata.startsAt` | `opensAt` | normalise to RFC 3339 (Karma allows unix or ISO) |
| `deadline` / `metadata.endsAt` | `closesAt` | prefer `deadline`; normalise |
| `isActive` + `metadata.status` + `closesAt` | `status` | derive: inactive→`archived`; deadline passed→`closed`; future `startsAt`→`upcoming`; else→`open` |
| `submissionUrl` | `applicationUrl` | identity |
| `metadata.website` | `website` | identity |
| `metadata.logoUrl` / `logoImg` | `logoUrl` | identity |
| `metadata.ecosystems[]` | `ecosystems[]` | identity (free-text both sides) |
| `metadata.networks[]` | `networks[]` | identity |
| `metadata.categories[]` | `categories[]` | identity |
| `metadata.minGrantSize` | `funding.minAward` | identity |
| `metadata.maxGrantSize` | `funding.maxAward` | identity |
| `metadata.programBudget` | `funding.totalBudget` | coerce string→number |
| `metadata.amountDistributedToDate` | `funding.amountDistributed` | coerce |
| `metadata.grantsToDate` | `funding.awardsToDate` | identity |
| `metadata.currency` | `funding.currency` | identity |
| `metadata.socialLinks{}` | `socialLinks{}` | field-by-field |
| `type` (grant) | `grant` | block always present (may be `{}`); `fundingMechanism`/`recurring` inferred where possible |
| `hackathonMetadata` | `hackathon` | restructure to typed block |
| `bountyMetadata` | `bounty` | restructure |
| `acceleratorMetadata` | `accelerator` | restructure |
| `vcFundMetadata` | `vc_fund` | restructure |
| `rfpMetadata` | `rfp` | restructure |
| `source` (ingestion source) | `source.ingestedVia` | map values; Karma edits→`karma_outbox` |
| `createdAt` / `updatedAt` | `createdAt` / `updatedAt` | identity |
| `chainID`, `profileId`, `offChain`, `anchorAddress`, `registryAddress`, `txHash`, `createdAtBlock`, `langfusePromptId` | `extensions["karma.*"]` (if retained at all) | **NOT** part of the standard |

---

## Open items

- **Canonical host / `$id`** — pending `rfp-hub` org + domain decision.
- **≥20 real-entry validation** (DEV-441) — ✅ **done.** 311/311 live Funding Map entries map
  and validate; 28 curated fixtures live in [`examples/`](./examples). See
  [BENCHMARK.md](./BENCHMARK.md). Gap: **`vc_fund` has 0 real entries** in the registry, so
  that block is only unit-tested — add real VC-fund data during M5 seeding.
- **`networks`/`ecosystems` controlled vocabulary** — free-text in v1.0.0; a curated ETH-family
  vocabulary could land in a v1.x minor.
- **Cross-system dedup** (Hub vs Karma registry) — deferred (DEV-437), surfaces at the M2
  read/aggregation layer.
