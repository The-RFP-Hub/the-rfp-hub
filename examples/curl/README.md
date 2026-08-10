# curl examples

Copy-pastable `curl` commands for every `/v1/` endpoint. Set the base URL once:

```bash
export RFPHUB_API_BASE=http://localhost:3001   # default; override for a hosted instance
```

You need a running API to try these against — see
[`packages/api/README.md`](../../packages/api/README.md) for bringing up Postgres, running
migrations, and seeding data locally.

## Service info

The root document names the API, the Standard version it serves, and the endpoints below:

```bash
curl -s "$RFPHUB_API_BASE/" | jq
```

```json
{
  "name": "RFP Hub API",
  "version": "v1",
  "standard": "1.0.0",
  "docs": "/v1/docs",
  "endpoints": [
    "/v1/opportunities",
    "/v1/opportunities/:id",
    "/v1/opportunities/schema",
    "/v1/stats",
    "/v1/health"
  ]
}
```

## List opportunities

Plain list (defaults: `sort=nextDeadlineAt`, `order=asc`, `page=1`, `limit=20`):

```bash
curl -s "$RFPHUB_API_BASE/v1/opportunities" | jq
```

Filter by funding type, status and ecosystem (all comma-separated, ANY-of match):

```bash
curl -s "$RFPHUB_API_BASE/v1/opportunities?fundingType=grant,hackathon&status=open&ecosystem=Optimism" | jq
```

Full-text-ish search over title/summary/description with `q`:

```bash
curl -s "$RFPHUB_API_BASE/v1/opportunities?q=public%20goods" | jq
```

Only opportunities with an upcoming fixed deadline after a given instant, sorted by that
deadline (records with no upcoming fixed deadline — rolling-only, all past, or none at all —
are excluded by `deadlineAfter`/`deadlineBefore` and always sort last):

```bash
curl -s "$RFPHUB_API_BASE/v1/opportunities?deadlineAfter=2026-08-01T00:00:00Z&sort=nextDeadlineAt&order=asc" | jq
```

Pagination:

```bash
curl -s "$RFPHUB_API_BASE/v1/opportunities?page=2&limit=10" | jq
```

Every list filter the API accepts, combined — this is the complete set:

```bash
curl -s "$RFPHUB_API_BASE/v1/opportunities" \
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
only the primary `operatingOrganizations[0]`. Slugs are derived from the organisation's own name
(`Ecosystem Grants Collective` → `ecosystem-grants-collective`), not from the ecosystem that lists
the program. List a page and read the `slug` values a given deployment serves.

Every list filter also accepts an empty value (`?fundingType=&status=`), which is simply ignored —
so a client that always emits every key does not have to strip the blank ones. Parameters the API
does not define are **stripped**, not rejected: a stale `?network=`/`?tag=` from before the closed
core silently does nothing rather than 400-ing, so check your filter actually narrowed the result.

Abbreviated real response envelope (`{items, page, limit, total, totalPages}` — list items are
the thin projection, which omits `fundingDetails`):

```json
{
  "items": [
    {
      "specVersion": "1.0.0",
      "id": "fundingmap:1502",
      "fundingType": "hackathon",
      "title": "Onchain Summer Hackathon",
      "description": "A four-week hackathon for consumer onchain applications.",
      "status": "open",
      "operatingOrganizations": [
        { "name": "Base Builders", "slug": "base-builders", "orgType": "program" }
      ],
      "source": { "ingestedVia": "import", "verifiedAgainstSource": null },
      "ecosystems": ["Base"],
      "categories": ["Consumer"],
      "applicationUrl": "https://hack.example.org/register",
      "fundingInfo": { "currency": "USDC", "budget": 250000 },
      "deadlines": [
        { "date": "2026-08-20T23:59:00.000Z", "label": "registration", "deadlineType": "fixed" },
        { "date": "2026-09-05T00:00:00.000Z", "label": "event start", "deadlineType": "fixed" }
      ],
      "createdAt": "2026-08-10T16:23:08.126Z",
      "updatedAt": "2026-08-10T16:23:08.126Z"
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
amounts inside `fundingDetails` or `milestones`).

## Get one opportunity

The full Standard object — the list fields **plus `fundingDetails`**, the tagged union whose own
`fundingType` names its shape — by public id, the colon-form `<sourceSystem>:<originalId>`:

```bash
curl -s "$RFPHUB_API_BASE/v1/opportunities/fundingmap:1459" | jq
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

A missing id returns `404` with the standard error envelope:

```bash
curl -si "$RFPHUB_API_BASE/v1/opportunities/fundingmap:does-not-exist"
```

```json
{ "error": "not_found", "message": "opportunity 'fundingmap:does-not-exist' not found" }
```

Every error (400/404/500) has that `{error, message}` shape, with a stable machine-readable
`error` code. An out-of-enum `sort` is a `400`:

```bash
curl -si "$RFPHUB_API_BASE/v1/opportunities?sort=bogus"
```

```json
{ "error": "bad_request", "message": "querystring/sort must be equal to one of the allowed values" }
```

## The Standard's JSON Schema

Served as `application/schema+json` and self-identifying through its own `$id`/`$schema`, so a
generic validator can point at the URL directly:

```bash
curl -s "$RFPHUB_API_BASE/v1/opportunities/schema" | jq '{title, $id: .["$id"]}'
```

## Dataset stats

Totals and breakdowns by funding type, status and top ecosystems:

```bash
curl -s "$RFPHUB_API_BASE/v1/stats" | jq
```

```json
{
  "total": 3,
  "byFundingType": { "grant": 1, "hackathon": 1, "bounty": 1 },
  "byStatus": { "open": 3 },
  "topEcosystems": [
    { "ecosystem": "Base", "count": 2 },
    { "ecosystem": "Ethereum", "count": 1 },
    { "ecosystem": "Optimism", "count": 1 }
  ],
  "lastUpdatedAt": "2026-08-10T16:23:08.128Z"
}
```

## Health check

Liveness + DB readiness (`200` when up, `503` when the DB is unreachable):

```bash
curl -si "$RFPHUB_API_BASE/v1/health"
```

```json
{ "status": "ok", "db": "up" }
```

## OpenAPI document

The full OpenAPI 3.1 document (also browsable as Swagger UI at `/v1/docs`):

```bash
curl -s "$RFPHUB_API_BASE/v1/docs/json" | jq
```

It is derived from the Standard's JSON Schema at startup, so it is the authoritative list of
parameters and response fields — including which ones exist at all:

```bash
curl -s "$RFPHUB_API_BASE/v1/docs/json" \
  | jq '.paths["/v1/opportunities"].get.parameters | map(.name)'
```

## Hosted instances

The same commands work against a deployment — point `RFPHUB_API_BASE` at it (always `https`):

```bash
export RFPHUB_API_BASE=https://api.ethrfps.app           # production
export RFPHUB_API_BASE=https://api-staging.ethrfps.app   # staging
```
