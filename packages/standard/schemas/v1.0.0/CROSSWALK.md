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

Notes:
- schema.org has no native "status / deadline / mechanism" for grants — RFP Hub adds these
  (they're first-class in DAOIP-5 via `isOpen`/`closeDate`/`grantFundingMechanism`).
- `grant.fundingMechanism` values (`retroactive`/`proactive`/`streaming`/`quadratic`/`other`)
  should be documented against DAOIP-5's `grantFundingMechanism` vocabulary
  (e.g. "Direct Grants", "Retroactive…") in the alignment work.
- DAOIP-5 field names here are from the spec's object model; verify against the
  `daostar/DAOIPs` JSON examples before publishing a normative mapping.

## What "looking fine" needs (status)

- ✅ **This crosswalk** — demonstrates we built on prior art (ships with v1.0.0).
- ⬜ **JSON-LD `@context`** so RFP Hub objects are also `schema.org/Grant`-interpretable
  (`@type: "Grant"`, `name`/`description`/`url`/`funder`/`amount`). Low effort; planned.
- ⬜ **DAOIP-5 `grantPools` export** for grant-type opportunities (an export-format adapter,
  alongside the M2 JSON/CSV exports).

The JSON-LD context and DAOIP-5 export are tracked as a follow-up (non-blocking for v1.0.0,
which already maps cleanly — no field had to change to align).
