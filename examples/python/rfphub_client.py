"""Stdlib-only client for the RFP Hub public /v1/ API.

No third-party dependencies: uses only `urllib.request` and `json` from the standard library.
Base URL is read from the RFPHUB_API_BASE environment variable (default http://localhost:3001).

Run the demo:

    python3 rfphub_client.py

See ./README.md for prerequisites (a running API — Postgres + migrate + seed).
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterable

BASE_URL = os.environ.get("RFPHUB_API_BASE", "http://localhost:3001")


def _get_json(path: str) -> Any:
    url = f"{BASE_URL}{path}"
    try:
        with urllib.request.urlopen(url) as res:  # noqa: S310 - fixed http(s) base, not user input
            return json.load(res)
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        # Every 400/404/500 carries the API's {"error", "message"} envelope; surface the stable
        # machine-readable code rather than the raw body when it is there.
        try:
            payload = json.loads(body)
            detail = f"{payload['error']}: {payload['message']}"
        except (ValueError, KeyError, TypeError):
            detail = body
        raise RuntimeError(f"{err.code} {err.reason} from {path} -- {detail}") from err
    except urllib.error.URLError as err:
        raise RuntimeError(
            f"Could not reach the RFP Hub API at {url}. Is it running? "
            "See ../../packages/api/README.md to start it locally (Postgres + migrate + seed)."
        ) from err


def _csv(value: str | Iterable[str] | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return ",".join(value)


def list_opportunities(
    *,
    funding_type: str | Iterable[str] | None = None,
    status: str | Iterable[str] | None = None,
    ecosystem: str | Iterable[str] | None = None,
    category: str | Iterable[str] | None = None,
    organization: str | None = None,
    min_award: float | None = None,
    max_award: float | None = None,
    deadline_after: str | None = None,
    deadline_before: str | None = None,
    q: str | None = None,
    sort: str | None = None,  # nextDeadlineAt | opensAt | postedAt | updatedAt | createdAt
    order: str | None = None,  # asc | desc
    page: int | None = None,
    limit: int | None = None,
) -> dict:
    """GET /v1/opportunities -- filtered, sorted, paginated thin list.

    Returns the envelope: {"items": [...], "page", "limit", "total", "totalPages"}. Each item is
    the thin projection: a full Standard object minus "fundingDetails" (fetch the detail endpoint
    for that).

    The keyword arguments above are the COMPLETE filter set the API defines. Parameters it does
    not define are silently stripped rather than rejected, so a stale filter (the closed core
    removed `network` and `tag`) fails quietly instead of erroring -- check that your filter
    actually narrowed the result.

    `organization` takes an org slug and matches ANY entry in either role: operatingOrganizations
    (who runs the intake) or sponsoringOrganizations (who backs it).
    """
    params = {
        "fundingType": _csv(funding_type),
        "status": _csv(status),
        "ecosystem": _csv(ecosystem),
        "category": _csv(category),
        "organization": organization,
        "minAward": min_award,
        "maxAward": max_award,
        "deadlineAfter": deadline_after,
        "deadlineBefore": deadline_before,
        "q": q,
        "sort": sort,
        "order": order,
        "page": page,
        "limit": limit,
    }
    query = {k: v for k, v in params.items() if v is not None}
    qs = f"?{urllib.parse.urlencode(query)}" if query else ""
    return _get_json(f"/v1/opportunities{qs}")


def get_opportunity(opportunity_id: str) -> dict:
    """GET /v1/opportunities/:id -- the full Standard object, or raises on 404.

    `opportunity_id` is the colon-form public id, e.g. "fundingmap:1459". The full object adds
    "fundingDetails" to the list fields: a tagged union whose own "fundingType" names its shape
    and equals the top-level one, so you can dispatch on either.
    """
    return _get_json(f"/v1/opportunities/{urllib.parse.quote(opportunity_id, safe='')}")


def get_schema() -> dict:
    """GET /v1/opportunities/schema -- the canonical RFP Hub Standard JSON Schema."""
    return _get_json("/v1/opportunities/schema")


def get_stats() -> dict:
    """GET /v1/stats -- dataset totals and breakdowns."""
    return _get_json("/v1/stats")


def get_health() -> dict:
    """GET /v1/health -- liveness + DB readiness."""
    return _get_json("/v1/health")


def display_org(opportunity: dict) -> str:
    """The organisation to show: operatingOrganizations[0].

    Array order is semantic and the schema requires at least one entry, so index 0 is always
    there. Sponsors are a SEPARATE, optional role and are never the one to display.
    """
    return opportunity["operatingOrganizations"][0]["name"]


def money(opportunity: dict) -> str:
    """Format the amounts. One currency per document denominates every amount in it."""
    funding = opportunity.get("fundingInfo") or {}
    if not funding:
        return "(no funding info)"
    currency = funding.get("currency", "?")
    low, high = funding.get("minAward"), funding.get("maxAward")
    if low is not None and high is not None:
        return f"{low}-{high} {currency}"
    if funding.get("budget") is not None:
        return f"{funding['budget']} {currency} budget"
    return f"({currency})"


def _main() -> None:
    print(f"Talking to {BASE_URL} ...\n")

    print("-- list: open grants on Optimism, soonest deadline first --")
    result = list_opportunities(
        funding_type=["grant"],
        status=["open"],
        ecosystem=["Optimism"],
        sort="nextDeadlineAt",
        order="asc",
        limit=5,
    )
    items = result["items"]
    print(
        f"{result['total']} total match, showing {len(items)} "
        f"(page {result['page']}/{result['totalPages']})"
    )
    for o in items:
        print(f"  {o['id']}  {o['title']}  [{display_org(o)}]  {money(o)}")

    if items:
        first_id = items[0]["id"]
        print(f"\n-- detail: {first_id} --")
        detail = get_opportunity(first_id)
        print(f"  title:  {detail['title']}")
        print(f"  status: {detail['status']}")
        print(f"  applicationUrl: {detail.get('applicationUrl') or '(none)'}")
        # fundingDetails is the one field the list projection omits.
        details = detail["fundingDetails"]
        print(f"  fundingDetails ({details['fundingType']}): {details}")

    print("\n-- stats --")
    stats = get_stats()
    print(f"  total: {stats['total']}")
    print(f"  byFundingType: {stats['byFundingType']}")


if __name__ == "__main__":
    import sys

    try:
        _main()
    except RuntimeError as err:
        print(str(err), file=sys.stderr)
        sys.exit(1)
