# API reference

Authoritative source: `packages/api/src/modules/routes/opportunities/types.ts` (`listQuerySchema`)
in [the-rfp-hub](https://github.com/The-RFP-Hub/the-rfp-hub) repository, and the live OpenAPI
document at `{RFPHUB_API_BASE}/v1/docs/json`. This file is a convenience summary — if it ever
disagrees with those two, they win.

Base URL: `https://api.ethrfps.app` (override with `RFPHUB_API_BASE`). Both endpoints below are
public and anonymous: no `Authorization` header, no key.

## `GET /v1/opportunities`

Filtered, sorted, paginated list. The schema is **closed**
(`additionalProperties: false`): a parameter name not in the table below is rejected with `400`,
never silently ignored.

| Param | Type | Notes |
|---|---|---|
| `q` | string | Free-text search over title, summary, and description |
| `fundingType` | list | See "fundingType values" below. Repeat the param and/or comma-separate; both OR together |
| `status` | list | See "status values" below. Same repeat/comma-separate rule |
| `ecosystem` | list | Open vocabulary, e.g. `Optimism`, `Base`, `Ethereum` — no fixed enum |
| `category` | list | Open vocabulary, e.g. `DeFi`, `Public Goods` — no fixed enum |
| `organization` | string | An organization **slug**. Matches ANY entry in `operatingOrganizations` OR `sponsoringOrganizations`, not only the primary one |
| `minAward` | number | Major units (e.g. `50000` for $50,000) |
| `maxAward` | number | Major units |
| `deadlineAfter` | RFC 3339 instant | Filters on the derived `nextDeadlineAt` — see "About `nextDeadlineAt`" below |
| `deadlineBefore` | RFC 3339 instant | Same derivation |
| `sort` | enum | `nextDeadlineAt` (default) \| `opensAt` \| `postedAt` \| `updatedAt` \| `createdAt` |
| `order` | enum | `asc` (default) \| `desc` |
| `page` | integer ≥ 1 | Default `1` |
| `limit` | integer, 1–100 | Default `20` on the API. **This skill's scripts cap it at 25** regardless of what's requested |

### `fundingType` values
`grant`, `hackathon`, `bounty`, `accelerator`, `vc_fund`, `rfp` — a closed enum on the Standard
schema (`packages/standard/schemas/v1.0.0/opportunity.schema.json`).

### `status` values
`upcoming` (announced, not yet accepting applications — there is no separate "draft" state),
`open`, `closed`, `archived`. Editorial review state (pending/rejected) is server-side metadata and
is never one of these values — every status here describes something publicly listed.

### About `nextDeadlineAt`
`nextDeadlineAt` is **not a field in the response body** — it's a derived sort/filter key, computed
from each record's `deadlines[]` array as "the earliest `fixed` deadline still in the future".
A record with only `rolling` deadlines, only past `fixed` deadlines, or no `deadlines` at all has a
`null` `nextDeadlineAt`: it sorts **last** and is **excluded** by `deadlineAfter`/`deadlineBefore`.
This skill's scripts recompute the same value client-side from the `deadlines[]` the response does
carry, for display (see `scripts/lib.mjs`'s `nextDeadlineAt()`).

### Response shape

```json
{
  "items": [ { "...": "an OpportunitySummary — a Standard document minus fundingDetails" } ],
  "page": 1,
  "limit": 20,
  "total": 0,
  "totalPages": 1
}
```

`totalPages` is **always ≥ 1**, even when `total` is `0` — an empty result is page 1 of 1, not page
1 of 0. Test emptiness with `total === 0`, never `totalPages === 0`.

Every item is a full RFP Hub Standard opportunity **minus `fundingDetails`** — which means it still
carries every free-text field the Standard defines (`description`, `summary`, `eligibility`,
`prerequisites`, `additionalReferences`, `serviceAgreement`, plus prose inside embedded
organizations). This skill's projection (§2 of SKILL.md) is what removes them before they reach an
agent — the API itself does not.

## `GET /v1/opportunities/{id}`

The full Standard document, including `fundingDetails` (which carries additional free-text fields
depending on `fundingType` — e.g. `rfp.scopeOfWork`, `vcFund.thesis`, `bounty.task.skills`).
`404` with `{ "error": "not_found" }`, or, for an id that used to be public and was merged into
another entry, `{ "error": "opportunity_merged", "mergedInto": { "id": "<id>", "title": "<title>" } }`
— `mergedInto` is an object (`OpportunityService#findMergedDestination`'s
`{ id: string; title: string }`), never a bare id string.

## Link-outs

- `GET /v1/r/{id}/apply` → `302` to the stored `applicationUrl`
- `GET /v1/r/{id}/source` → `302` to the stored `website`

Always prefer these over any raw URL read out of the record: they're the hop the publisher's
listing analytics count as a real "apply" or "source" click. `{id}` must be URL-encoded — public
ids are frequently namespaced (e.g. `fundingmap:1459`).

## Registries (open vocabularies)

`ecosystems` and `category` are deliberately open — no registry. The following ARE governed
vocabularies, published at these canonical URLs (also mirrored under
`packages/standard/registries/*.json` in the repository):

| Registry | Canonical URL | Governs |
|---|---|---|
| Deadline labels | `https://ethrfps.app/registries/deadline-labels.json` | `deadlines[].label` conventional values (`application`, `submission`, `registration`, `event start`, `event end`, `community feedback`) |
| Program models | `https://ethrfps.app/registries/program-models.json` | `grant.programModel` (`grant`, `incentives`, `infra`, `program`) |
| Bounty severities | `https://ethrfps.app/registries/bounty-severities.json` | `rewardTiers[].severity` (`critical`, `high`, `medium`, `low`, `informational`) |
| Bounty asset types | `https://ethrfps.app/registries/bounty-asset-types.json` | `rewardTiers[].assetType` (`smart_contract`, `blockchain_dlt`, `websites_and_applications`) |

None of these are search parameters — they describe values found inside `fundingDetails`, which
this skill's projection does not surface (see SKILL.md §2).

## Exit codes

Both `scripts/search.mjs` and `scripts/get.mjs` use the same exit codes:

| Code | Meaning |
|---|---|
| `0` | Success — including an empty result set |
| `1` | Usage error: bad or unknown flag, invalid `--limit`, missing `<id>` for `get.mjs` |
| `2` | Network error or timeout reaching the API |
| `3` | HTTP 4xx from the API (not 429) — e.g. a validation error, or 404 |
| `4` | HTTP 429 — rate limited; the message reports `Retry-After` when the API sends it |
| `5` | HTTP 5xx from the API |
| `6` | The API's response body was not valid JSON |

## Examples

See [examples.md](examples.md) for worked `search.mjs`/`get.mjs` invocations and sample output.
