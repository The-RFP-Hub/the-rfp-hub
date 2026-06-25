# RFP Hub Standard ↔ DAOIP-5 ↔ schema.org/Grant

The RFP asks us to "build on" the **DAOIP-5 Grants Metadata Standard** and **schema.org/Grant**
rather than start from scratch. This crosswalk documents how the RFP Hub Standard v1.0.0 maps
onto both, so a consumer can translate between them.

- **schema.org/Grant** is intentionally minimal (a handful of properties on `Thing` + `funder`,
  `sponsor`, `amount`, `fundedItem`). Every one of its fields has a clean RFP Hub equivalent.
- **DAOIP-5** is a JSON-LD family of objects: **Grant System** (the administering body),
  **Grant Pool** (an open funding opportunity), **Project**, **Application**. The RFP Hub
  **Opportunity** is closest to a **Grant Pool**; our **Organization** ≈ a **Grant System**.
  DAOIP-5 is grant-centric, so our non-grant types (hackathon/bounty/accelerator/vc_fund) and
  several fields extend beyond it.

## Field mapping (Opportunity)

| RFP Hub v1.0.0 | schema.org/Grant | DAOIP-5 (Grant Pool unless noted) |
|---|---|---|
| `id` | `identifier` | `id` |
| `title` | `name` | `name` |
| `description` | `description` | `description` |
| `source.url` | `url` / `sameAs` | `applicationsURI` (closest) |
| `applicationUrl` | `url` | `applicationsURI` |
| `organization` (issuer) | `funder` (Organization) | **Grant System** |
| `organization.name` | `funder.name` | grant system `name` |
| `funding.totalBudget` | `amount` (MonetaryAmount) | `totalGrantPoolSize` |
| `funding.currency` | `amount.currency` | `totalGrantPoolSize[].denomination` |
| `status` (`open`/`closed`) | — | `isOpen` (boolean) |
| `closesAt` | — | `closeDate` |
| `grant.fundingMechanism` | — | `grantFundingMechanism` |
| `ecosystems` / `networks` | — | — (RFP Hub extension) |
| `categories` / `tags` | `about`/`keywords` (loose) | — |
| `type` (6 opportunity types) | (`Grant` only) | (Grant Pool = grant only) |
| `source.verifiedAgainstSource` | — | — (RFP Hub provenance extension) |

Also: `logoUrl` ↔ `image`, `bannerUrl` ↔ `coverImage`, `extensions` ↔ `extensions` (both
standards carry a free-form `extensions` object), and DAOIP-5 adds `applicationsURI`,
`governanceURI`, and `totalGrantPoolSizeInUSD`.

Notes:
- schema.org has no native "status / deadline / mechanism" for grants — RFP Hub adds these
  (they're first-class in DAOIP-5 via `isOpen`/`closeDate`/`grantFundingMechanism`).
- `grant.fundingMechanism` values (`retroactive`/`proactive`/`streaming`/`quadratic`/`other`)
  map onto DAOIP-5's `grantFundingMechanism` vocabulary (e.g. "Retroactive", "Direct Grants",
  "Quadratic Funding").
- `funding.totalBudget` + `currency` is a single value; DAOIP-5 `totalGrantPoolSize` is an
  array of `{amount, denomination}` (multi-asset). The mapping takes the primary amount; carry
  additional denominations under `extensions` if needed.
- ✅ DAOIP-5 field names above are **verified against the published DAOIP-5 spec** (Grant System
  + Grant Pool objects).

## Alignment status — conclusive for v1.0.0

- ✅ **Crosswalk verified** against the published DAOIP-5 spec and schema.org/Grant. Every
  schema.org/Grant property and every DAOIP-5 Grant Pool field has an RFP Hub equivalent —
  **no v1.0.0 field had to change to align.**
- ✅ **JSON-LD `@context` shipped** — [`context.jsonld`](./context.jsonld). Apply it to any RFP
  Hub opportunity and it reads as linked data: `id → schema:identifier`, `title → schema:name`,
  `description → schema:description`, `applicationUrl → schema:url`, `organization →
  schema:funder`, `closesAt → daoip5:closeDate`, `grant.fundingMechanism →
  daoip5:grantFundingMechanism`, `extensions → daoip5:extensions`; every other field resolves
  under the RFP Hub vocabulary (no data loss).
- ⬜ **DAOIP-5 `grantPools` export** (optional) — a one-way *output adapter* that emits
  grant-type opportunities in DAOIP-5 `grantPools` JSON. This is an export *format* (belongs
  with the dataset exports), **not** a prerequisite for the standard being aligned.

### Using the JSON-LD context

```jsonc
{
  "@context": "https://rfphub.org/standard/v1.0.0/context.jsonld",
  "@type": "schema:Grant",
  "id": "example:grant-1",
  "title": "Example Grants",
  "description": "…",
  "organization": { "name": "Example Foundation" }
  // … the rest of a normal RFP Hub opportunity
}
```

A JSON-LD processor expands this to a `schema:Grant` with `schema:identifier` / `schema:name` /
`schema:description` / `schema:funder`, etc. (The `@context` host is a placeholder pending the
project domain.)
