# curl examples

Copy-pastable `curl` commands for every `/v1/` endpoint. Set the base URL once:

```bash
export RFPHUB_API_BASE=http://localhost:3001   # default; override for a hosted instance
```

You need a running API to try these against — see
[`packages/api/README.md`](../../packages/api/README.md) for bringing up Postgres, running
migrations, and seeding data locally.

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
curl -s "$RFPHUB_API_BASE/v1/opportunities?q=zero-knowledge" | jq
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

Every list filter, combined:

```bash
curl -s "$RFPHUB_API_BASE/v1/opportunities" \
  --get \
  --data-urlencode "fundingType=grant" \
  --data-urlencode "status=open" \
  --data-urlencode "ecosystem=Optimism,Base" \
  --data-urlencode "network=OP Mainnet" \
  --data-urlencode "category=DeFi" \
  --data-urlencode "tag=infrastructure" \
  --data-urlencode "organization=celo" \
  --data-urlencode "minAward=1000" \
  --data-urlencode "maxAward=50000" \
  --data-urlencode "deadlineAfter=2026-08-01T00:00:00Z" \
  --data-urlencode "q=grants" \
  --data-urlencode "sort=nextDeadlineAt" \
  --data-urlencode "order=asc" \
  --data-urlencode "page=1" \
  --data-urlencode "limit=20" \
  | jq
```

`organization` takes a **sponsoring-organization slug**, and those slugs are derived from the
organisation's own name (`Celo` → `celo`), not from the ecosystem/community that lists the program.
List a page and read `sponsoringOrganizations[].slug` to see the values a given deployment serves.
Every list filter also accepts an empty value (`?fundingType=&status=`), which is simply ignored —
so a client that always emits every key does not have to strip the blank ones.

Abbreviated real response envelope (`{items, page, limit, total, totalPages}` — list items are
the thin projection: no `opportunity[fundingType]` block, no `extensions`):

```json
{
  "items": [
    {
      "specVersion": "1.0.0",
      "id": "fundingmap:1459",
      "fundingType": "grant",
      "title": "Prezenti Boost Pool S2",
      "summary": "Fast-track funding for proven projects launching on Celo, run by Prezenti with CF DevRel team.",
      "status": "open",
      "sponsoringOrganizations": [
        {
          "name": "Celo",
          "slug": "celo",
          "website": "https://prezenti.xyz/",
          "ecosystems": ["Celo"]
        }
      ],
      "ecosystems": ["Celo"],
      "funding": { "minAward": 5000, "maxAward": 5000, "budget": 70000 },
      "deadlines": [
        { "type": "fixed", "date": "2026-06-30T23:59:00.000Z", "label": "application" }
      ]
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 128,
  "totalPages": 7
}
```

## Get one opportunity

Full Standard object (includes the `grant`/`hackathon`/... block for its `fundingType`),
by its public id — the colon-form `<sourceSystem>:<originalId>`, e.g. `fundingmap:1459`:

```bash
curl -s "$RFPHUB_API_BASE/v1/opportunities/fundingmap:1459" | jq
```

A missing id returns `404`:

```bash
curl -si "$RFPHUB_API_BASE/v1/opportunities/fundingmap:does-not-exist"
```

## The Standard's JSON Schema

Served verbatim (self-identifying `$id`/`$schema`) as `application/schema+json`, so a generic
validator can point at the URL directly:

```bash
curl -s "$RFPHUB_API_BASE/v1/opportunities/schema" | jq
```

## Dataset stats

Totals and breakdowns by funding type, status and top ecosystems:

```bash
curl -s "$RFPHUB_API_BASE/v1/stats" | jq
```

## Health check

Liveness + DB readiness (`200` when up, `503` when the DB is unreachable):

```bash
curl -si "$RFPHUB_API_BASE/v1/health"
```

## OpenAPI document

The full OpenAPI 3.1 document (also browsable as Swagger UI at `/v1/docs`):

```bash
curl -s "$RFPHUB_API_BASE/v1/docs/json" | jq
```
