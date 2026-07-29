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
        raise RuntimeError(f"{err.code} {err.reason} from {path}: {body}") from err
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
    network: str | Iterable[str] | None = None,
    category: str | Iterable[str] | None = None,
    tag: str | Iterable[str] | None = None,
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

    Returns the envelope: {"items": [...], "page", "limit", "total", "totalPages"}.
    """
    params = {
        "fundingType": _csv(funding_type),
        "status": _csv(status),
        "ecosystem": _csv(ecosystem),
        "network": _csv(network),
        "category": _csv(category),
        "tag": _csv(tag),
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

    `opportunity_id` is the colon-form public id, e.g. "fundingmap:1459".
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
    print(f"{result['total']} total match, showing {len(items)} (page {result['page']}/{result['totalPages']})")
    for o in items:
        print(f"  {o['id']}  {o['title']}")

    if items:
        first_id = items[0]["id"]
        print(f"\n-- detail: {first_id} --")
        detail = get_opportunity(first_id)
        print(f"  title:  {detail['title']}")
        print(f"  status: {detail['status']}")
        print(f"  applicationUrl: {detail.get('applicationUrl') or '(none)'}")

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
