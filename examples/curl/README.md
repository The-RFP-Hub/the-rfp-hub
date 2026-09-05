# curl examples

Copy-pastable `curl` commands for every `/v1/` endpoint. Every command below defaults to a local
API, so it works pasted as-is; export the variable to point them all somewhere else:

```bash
export RFPHUB_API_BASE=https://api.ethrfps.app   # optional; default is http://localhost:3001
```

You need a running API to try these against — see
[`packages/api/README.md`](../../packages/api/README.md) for bringing up Postgres, running
migrations, and seeding data locally.

## Service info

The root document names the API, the Standard version it serves (`standard`), the docs path, and
the endpoints below — ask the deployment rather than trusting a version pasted here:

```bash
curl -s "${RFPHUB_API_BASE:-http://localhost:3001}/" | jq
```

## List opportunities

Plain list (defaults: `sort=nextDeadlineAt`, `order=asc`, `page=1`, `limit=20`):

```bash
curl -s "${RFPHUB_API_BASE:-http://localhost:3001}/v1/opportunities" | jq
```

Filter by funding type, status and ecosystem (all comma-separated, ANY-of match):

```bash
curl -s "${RFPHUB_API_BASE:-http://localhost:3001}/v1/opportunities?fundingType=grant,hackathon&status=open&ecosystem=Optimism" | jq
```

Full-text-ish search over title/summary/description with `q`:

```bash
curl -s "${RFPHUB_API_BASE:-http://localhost:3001}/v1/opportunities?q=public%20goods" | jq
```

Only opportunities with an upcoming fixed deadline after a given instant, sorted by that
deadline (records with no upcoming fixed deadline — rolling-only, all past, or none at all —
are excluded by `deadlineAfter`/`deadlineBefore` and always sort last):

```bash
curl -s "${RFPHUB_API_BASE:-http://localhost:3001}/v1/opportunities?deadlineAfter=2026-08-01T00:00:00Z&sort=nextDeadlineAt&order=asc" | jq
```

Pagination:

```bash
curl -s "${RFPHUB_API_BASE:-http://localhost:3001}/v1/opportunities?page=2&limit=10" | jq
```

Every list filter the API accepts, combined — this is the complete set:

```bash
curl -s "${RFPHUB_API_BASE:-http://localhost:3001}/v1/opportunities" \
  --get \
  --data-urlencode "fundingType=grant" \
  --data-urlencode "status=open" \
  --data-urlencode "ecosystem=Optimism,Base" \
  --data-urlencode "category=Infrastructure" \
  --data-urlencode "organization=ecosystem-grants-collective" \
  --data-urlencode "minAward=1000" \
  --data-urlencode "maxAward=50000" \
  --data-urlencode "deadlineAfter=2026-08-01T00:00:00Z" \
  --data-urlencode "deadlineBefore=2026-12-31T00:00:00Z" \
  --data-urlencode "q=grants" \
  --data-urlencode "sort=nextDeadlineAt" \
  --data-urlencode "order=asc" \
  --data-urlencode "page=1" \
  --data-urlencode "limit=20" \
  | jq
```

`organization` takes an **organization slug**, and matches **any** entry in either role —
`operatingOrganizations` (who runs the intake) *or* `sponsoringOrganizations` (who backs it) — not
only the primary `operatingOrganizations[0]`. Slugs are derived from the organization's own name
(`Ecosystem Grants Collective` → `ecosystem-grants-collective`), not from the ecosystem that lists
the program. List a page and read the `slug` values a given deployment serves.

### A mistyped filter is a 400, never a silent full result set

The query contract is **strict**. A parameter the API does not define — a typo, or a filter from
an older version of the API — is **rejected**, and so is an out-of-enum `fundingType`, `status`,
`sort` or `order` value:

```bash
curl -s "${RFPHUB_API_BASE:-http://localhost:3001}/v1/opportunities?fundingtype=grant" | jq
```

```json
{ "error": "bad_request", "message": "querystring must NOT have additional properties" }
```

That is the property worth relying on: the worst failure mode for a discovery API is a filter
that quietly does nothing, because the response still looks like a valid 200 — it is just the
*entire* dataset. Here a wrong parameter name, a wrong case, or a stale value fails loudly at the
first request instead of silently widening every result set that follows.

The one input that is accepted and ignored is an **explicitly empty value**
(`?fundingType=&status=`), so a client that always emits every key does not have to strip the
blank ones. List filters also accept both wire forms interchangeably: repeat the parameter
(`?ecosystem=Optimism&ecosystem=Base`) or comma-separate it (`?ecosystem=Optimism,Base`).

### The list envelope

`{items, page, limit, total, totalPages}` — list items are the thin projection, which omits
`fundingDetails`. Abbreviated (one item, most fields elided):

```json
{
  "items": [
    {
      "specVersion": "1.0.0",
      "id": "fundingmap:1502",
      "fundingType": "hackathon",
      "title": "Onchain Summer Hackathon",
      "status": "open",
      "operatingOrganizations": [
        { "name": "Base Builders", "slug": "base-builders", "orgType": "program" }
      ],
      "ecosystems": ["Base"],
      "fundingInfo": { "currency": "USDC", "budget": 250000 },
      "deadlines": [
        { "date": "2026-08-20T23:59:00.000Z", "label": "registration", "deadlineType": "fixed" }
      ]
    }
  ],
  "page": 1,
  "limit": 1,
  "total": 3,
  "totalPages": 3
}
```

Note `fundingInfo.currency`: the Standard permits **one currency per document**, and it
denominates every amount in that entry (`budget`, `allocated`, `minAward`, `maxAward`, and any
amounts inside `fundingDetails` or `milestones`). It is nullable — an entry may state amounts
without naming a currency — so read it defensively.

## Get one opportunity

The full Standard object — the list fields **plus `fundingDetails`**, the tagged union whose own
`fundingType` names its shape — by public id, the colon-form `<sourceSystem>:<originalId>`:

```bash
curl -s "${RFPHUB_API_BASE:-http://localhost:3001}/v1/opportunities/fundingmap:1459" | jq
```

```json
{
  "specVersion": "1.0.0",
  "id": "fundingmap:1459",
  "fundingType": "grant",
  "title": "Ecosystem Builders Grant Round 4",
  "summary": "Milestone-based grants for public-goods infrastructure teams building on Optimism.",
  "status": "open",
  "sponsoringOrganizations": [
    { "name": "Optimism Foundation", "slug": "optimism-foundation", "orgType": "foundation" }
  ],
  "operatingOrganizations": [
    {
      "name": "Ecosystem Grants Collective",
      "slug": "ecosystem-grants-collective",
      "orgType": "program",
      "website": "https://grants.example.org",
      "ecosystems": ["Optimism"]
    }
  ],
  "source": { "ingestedVia": "import", "verifiedAgainstSource": null },
  "ecosystems": ["Optimism", "Base"],
  "categories": ["Infrastructure", "Public Goods"],
  "applicationUrl": "https://grants.example.org/apply/round-4",
  "fundingInfo": {
    "currency": "USD",
    "budget": 750000,
    "allocated": 210000,
    "minAward": 5000,
    "maxAward": 50000
  },
  "deadlines": [
    { "date": "2026-09-30T23:59:00.000Z", "label": "application", "deadlineType": "fixed" }
  ],
  "fundingDetails": { "fundingType": "grant", "milestoneBased": true }
}
```

The two organization roles are distinct and both optional to read: `operatingOrganizations` is
required on every entry and its **entry 0 is the one to display**; `sponsoringOrganizations` names
the backer and may be absent.

A missing id returns `404` with the standard error envelope, and every error (400/404/500) has
that same `{error, message}` shape with a stable machine-readable `error` code:

```bash
curl -si "${RFPHUB_API_BASE:-http://localhost:3001}/v1/opportunities/fundingmap:does-not-exist"
```

```json
{ "error": "not_found", "message": "opportunity 'fundingmap:does-not-exist' not found" }
```

## The Standard's JSON Schema

Served as `application/schema+json` and self-identifying through its own `$id`/`$schema`, so a
generic validator can point at the URL directly:

```bash
curl -s "${RFPHUB_API_BASE:-http://localhost:3001}/v1/opportunities/schema" \
  | jq '{title, "$id": .["$id"], "$schema": .["$schema"]}'
```

## Download the whole dataset

Every public record in one call — no pagination, no parameters (any query string at all is a `400`).
`-OJ` saves it under the filename the server offers, `opportunities-<UTC date>.json`:

```bash
curl -sOJ "${RFPHUB_API_BASE:-http://localhost:3001}/v1/export/opportunities.json"
```

The same dataset as a flat CSV, one row per opportunity:

```bash
curl -sOJ "${RFPHUB_API_BASE:-http://localhost:3001}/v1/export/opportunities.csv"
```

The response carries an `ETag` that moves only when the dataset does, so a scheduled sync should
send back the one it saw last and get a `304` with no body instead of the whole dataset again:

```bash
etag=$(curl -sI "${RFPHUB_API_BASE:-http://localhost:3001}/v1/export/opportunities.csv" \
  | awk -F': ' 'tolower($1)=="etag" {print $2}' | tr -d '\r')
curl -si -H "If-None-Match: ${etag}" \
  "${RFPHUB_API_BASE:-http://localhost:3001}/v1/export/opportunities.csv" | head -1
```

This is a **live** download: it reflects the database at the moment of the request. The nightly
snapshot published in the repository is the same bytes per record, at most a day old, and — unlike
this response — immutable and digest-verifiable. See
[`exports/README.md`](../../exports/README.md) for which one to build on.

## Dataset stats

Totals and breakdowns by funding type, status and top ecosystems
(`{total, byFundingType, byStatus, topEcosystems, lastUpdatedAt}`):

```bash
curl -s "${RFPHUB_API_BASE:-http://localhost:3001}/v1/stats" | jq
```

## Health check

Liveness + DB readiness — `{"status":"ok","db":"up"}` with `200` when up, `503` when the DB is
unreachable:

```bash
curl -si "${RFPHUB_API_BASE:-http://localhost:3001}/v1/health"
```

## OpenAPI document

The full OpenAPI 3.1 document (also browsable as Swagger UI at `/v1/docs`):

```bash
curl -s "${RFPHUB_API_BASE:-http://localhost:3001}/v1/docs/json" | jq
```

It is derived from the Standard's JSON Schema at startup, so it is the authoritative list of
parameters and response fields — including which ones exist at all. Since an undefined parameter
is a 400, this list is exactly what the API will accept:

```bash
curl -s "${RFPHUB_API_BASE:-http://localhost:3001}/v1/docs/json" \
  | jq '.paths["/v1/opportunities"].get.parameters | map(.name)'
```

## Hosted instances

The same commands work against a deployment — point `RFPHUB_API_BASE` at it (always `https`):

```bash
export RFPHUB_API_BASE=https://api.ethrfps.app           # production
export RFPHUB_API_BASE=https://api-staging.ethrfps.app   # staging
```
