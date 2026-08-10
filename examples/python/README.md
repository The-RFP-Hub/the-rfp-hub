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

Point at a different API (always `https` for a hosted instance):

```bash
RFPHUB_API_BASE=https://api.ethrfps.app python3 rfphub_client.py           # production
RFPHUB_API_BASE=https://api-staging.ethrfps.app python3 rfphub_client.py   # staging
```

## What it exercises

`rfphub_client.py` exposes five functions you can import directly:

- `list_opportunities(...)` — the list endpoint, with the complete filter set (`funding_type`,
  `status`, `ecosystem`, `category`, `organization`, `min_award`/`max_award`,
  `deadline_after`/`deadline_before`, `q`), `sort`/`order`, and `page`/`limit`.
- `get_opportunity(opportunity_id)` — the full Standard object by public id (e.g.
  `"fundingmap:1459"`).
- `get_schema()` — the canonical RFP Hub Standard JSON Schema.
- `get_stats()` — dataset totals and breakdowns.
- `get_health()` — liveness + DB readiness.

Running the file directly (`__main__`) drives a small demo: list open grants on Optimism sorted
by next deadline, fetch the first result's detail, and print dataset stats.

If the API isn't reachable, the client prints a clear "could not reach the API" message and exits
`1`, instead of an unhandled `urllib.error.URLError` traceback. HTTP errors are unwrapped from the
API's `{"error", "message"}` envelope, so a failure names the stable error code.

## Use as a library

```python
from rfphub_client import list_opportunities, get_opportunity, display_org

page = list_opportunities(funding_type=["grant"], status=["open"], limit=10)
for o in page["items"]:
    print(o["id"], o["title"], display_org(o))

full = get_opportunity("fundingmap:1459")
print(full["fundingDetails"])   # the one field the list projection omits
```

## Reading the shape

Three things worth knowing before you index into a response:

- **Two organization roles.** `operatingOrganizations` (who runs the intake) is required and
  **entry 0 is the one to display** — `display_org()` does exactly that. `sponsoringOrganizations`
  (who backs it) is optional and is never the display org. The `organization` filter matches
  either role.
- **One currency per document.** `fundingInfo.currency` denominates every amount in that entry —
  `budget`, `allocated`, `minAward`, `maxAward`, and any amounts inside `fundingDetails` or
  `milestones`. There is no per-amount currency to reconcile.
- **`fundingDetails` is a tagged union.** Its own `fundingType` names its shape and equals the
  top-level `fundingType`, so dispatch on either. It is the single slot that replaced the six
  per-type blocks, and the only field the list projection leaves out.
