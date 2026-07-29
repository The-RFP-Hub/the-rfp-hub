# Python example

A stdlib-only client for the RFP Hub public `/v1/` API — `urllib.request` + `json`, nothing to
install. No `requirements.txt`; works on any Python 3.9+.

## Prerequisites

A running RFP Hub API. Bring one up locally (Postgres + migrate + seed) — see
[`packages/api/README.md`](../../packages/api/README.md) — or point at a hosted instance via
`RFPHUB_API_BASE` (default `http://localhost:3001`).

## Run

```bash
python3 rfphub_client.py
```

Point at a different API:

```bash
RFPHUB_API_BASE=https://api.example.org python3 rfphub_client.py
```

## What it exercises

`rfphub_client.py` exposes five functions you can import directly:

- `list_opportunities(...)` — the list endpoint, with every filter (`funding_type`, `status`,
  `ecosystem`, `network`, `category`, `tag`, `organization`, `min_award`/`max_award`,
  `deadline_after`/`deadline_before`, `q`), `sort`/`order`, and `page`/`limit`.
- `get_opportunity(opportunity_id)` — the full Standard object by public id (e.g.
  `"fundingmap:1459"`).
- `get_schema()` — the canonical RFP Hub Standard JSON Schema.
- `get_stats()` — dataset totals and breakdowns.
- `get_health()` — liveness + DB readiness.

Running the file directly (`__main__`) drives a small demo: list open grants on Optimism sorted
by next deadline, fetch the first result's detail, and print dataset stats.

If the API isn't reachable, the client prints a clear "could not reach the API" message and exits
`1`, instead of an unhandled `urllib.error.URLError` traceback.

## Use as a library

```python
from rfphub_client import list_opportunities, get_opportunity

page = list_opportunities(funding_type=["grant"], status=["open"], limit=10)
for o in page["items"]:
    print(o["id"], o["title"])

full = get_opportunity("fundingmap:1459")
```
