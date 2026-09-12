#!/usr/bin/env python3
"""Does the dashboard still answer, now that its data comes from the database.

Read-only: public GETs, no writes, no switch is touched.

The first cutover was rolled back inside five minutes because nobody was measuring the
thing that actually broke -- the hosting answered `storage status` in 58 seconds and reset
the connection on everything else. A comparison of query shapes cannot see that. This asks
every view the browser asks for, in the order a page load asks for them, and reports the
status, the seconds and the size of each.

What to look for: any FAILED line, any view over ~5 seconds (the dashboard gives its
requests ten), and an execution view that comes back with no markets at all -- the last one
is the silent failure, because an empty shortlist looks exactly like a quiet market.
"""
from __future__ import annotations

import json
import os
import time
import urllib.request

HOST = os.environ.get("TRADING_HOST", "https://osobnizkusenosti.cz/trading").rstrip("/")
STRATEGY = os.environ.get("STRATEGY_ID", "highReward").strip()

# The order a page load asks in: the cheap summary first, then the heavier views.
VIEWS = [
    ("storage status", "api.php?action=storage-status"),
    ("dashboard", "api.php?action=state&target=paper&summary=dashboard"),
    ("portfolio overview", "api.php?action=state&target=paper&summary=portfolio-overview"),
    ("execution shortlist", f"api.php?action=state&target=paper&summary=execution&strategy_id={STRATEGY}"),
    ("scraped page 1", "api.php?action=state&target=paper&summary=scraped"),
    ("scraped resolved", "api.php?action=state&target=paper&summary=scraped&scope=resolved"),
    ("live state", "api.php?action=state&target=live&summary=dashboard"),
]


def probe(label: str, path: str) -> dict:
    started = time.time()
    try:
        request = urllib.request.Request(f"{HOST}/{path}", headers={"Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read()
            seconds = time.time() - started
            payload = json.loads(body.decode("utf-8") or "{}")
    except Exception as error:  # noqa: BLE001
        seconds = time.time() - started
        print(f"   {label:<20} FAILED after {seconds:6.2f}s -- {error}")
        return {"ok": False, "seconds": seconds}

    markets = payload.get("marketObservations")
    counts = f" markets={len(markets)}" if isinstance(markets, list) else ""
    scope = ""
    if payload.get("executionScopeTotal") is not None:
        scope = f" scopeTotal={payload.get('executionScopeTotal')}"
    portfolios = payload.get("paperPortfolios")
    if isinstance(portfolios, dict):
        counts += f" portfolios={len(portfolios)}"
    print(f"   {label:<20} {response.status} in {seconds:6.2f}s  {len(body) / 1024:8.1f} KB{counts}{scope}")
    return {"ok": True, "seconds": seconds, "bytes": len(body), "payload": payload}


def main() -> int:
    print(f"== every view the browser asks for, against {HOST}")
    results = {}
    for label, path in VIEWS:
        results[label] = probe(label, path)

    status = results.get("storage status", {}).get("payload") or {}
    print("\n== the switch")
    print(f"   reads served by SQL: {status.get('active')}")
    print(f"   last ingest: {status.get('lastIngestAt')}")
    print(f"   rows: {json.dumps(status.get('counts'), sort_keys=True)}")

    print("\n== how to read this")
    print("   Any FAILED line, or a view past about five seconds, is a rollback: the")
    print("   dashboard gives its requests ten and the first cutover died at 58.")
    print("   An execution view with markets=0 is the silent one -- an empty shortlist")
    print("   looks exactly like a quiet market, and nothing errors either way.")
    slowest = max((r.get("seconds", 0) for r in results.values()), default=0)
    failed = [label for label, r in results.items() if not r.get("ok")]
    print(f"\n   slowest view {slowest:.2f}s, failed views: {failed or 'none'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
