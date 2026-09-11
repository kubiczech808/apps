#!/usr/bin/env python3
"""How long the hosting takes to answer the requests the dashboard actually makes.

Read-only: public GETs, no secrets, no writes.

Reported from a phone: the Scraping log tab showed "0 RECORDED SCRAPING RUNS" over the error
"data/paper-state.json timed out after 10 seconds". The dashboard gives that request ten
seconds; the market scans themselves were running normally every ten minutes, so the scrape
was working and only the READ of its result was failing.

A timeout is the one failure that says nothing about its own cause -- slow host, big payload,
a query that got expensive -- so this times each request the view depends on and prints the
size with it. Two passes, because a single slow answer can be one unlucky moment and a pair
of them is a state.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

HOST = os.environ.get("TRADING_HOST", "https://osobnizkusenosti.cz/trading").rstrip("/")
# What the dashboard allows before it gives up on the scraped views.
DASHBOARD_TIMEOUT_SECONDS = float(os.environ.get("DASHBOARD_TIMEOUT_SECONDS") or 10)
PASSES = int(os.environ.get("PROBE_PASSES") or 2)

# Exactly what the views ask for. The scraped summary is the one that timed out; the others
# are here so a slow host can be told apart from one query having become expensive.
REQUESTS = [
    ("scraping log / scraped tab", "action=state&target=paper&summary=scraped&offset=0"),
    ("scraped, second page", "action=state&target=paper&summary=scraped&offset=1200"),
    ("resolved archive, first page", "action=state&target=paper&summary=scraped&scope=resolved&offset=0"),
    ("resolved archive, second page", "action=state&target=paper&summary=scraped&scope=resolved&offset=1200"),
    ("dashboard", "action=state&target=paper&summary=dashboard"),
    ("portfolio overview", "action=state&target=paper&summary=portfolio-overview"),
    ("live account", "action=state&target=live"),
    ("storage status", "action=storage-status"),
]


def probe(label: str, query: str) -> None:
    url = f"{HOST}/api.php?{query}"
    # Generous compared with the dashboard, so a request that would merely have timed out in
    # the browser still reports its real duration instead of failing here too.
    budget = max(DASHBOARD_TIMEOUT_SECONDS * 6, 60)
    started = time.monotonic()
    try:
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=budget) as response:
            body = response.read()
            elapsed = time.monotonic() - started
            size = len(body)
            note = ""
            try:
                payload = json.loads(body.decode("utf-8"))
                rows = payload.get("marketObservations")
                if isinstance(rows, list):
                    note = f", {len(rows)} observation(s)"
                history = payload.get("marketScanHistory")
                if isinstance(history, list):
                    note += f", {len(history)} scan(s) in history"
                if payload.get("scrapedScopeTruncated") is True:
                    note += ", more pages follow"
                scope = payload.get("scrapedScope")
                if scope:
                    note += f", scope={scope}"
                # The totals are what tells a complete migration from a partial one: the
                # file path reports the manifest counts and the database reports its own
                # COUNT, so running this before and after the cutover compares them.
                totals = payload.get("observationTotals")
                if isinstance(totals, dict):
                    note += (
                        f", totals scraped={totals.get('scraped')}"
                        f" resolved={totals.get('resolved')}"
                    )
            except (ValueError, AttributeError):
                note = ", response was not JSON"
            verdict = "OK" if elapsed < DASHBOARD_TIMEOUT_SECONDS else "TOO SLOW FOR THE DASHBOARD"
            print(f"   {label}: {elapsed:.2f}s, {round(size / 1048576, 2)} MB{note}  [{verdict}]")
    except urllib.error.HTTPError as error:
        print(f"   {label}: HTTP {error.code} after {time.monotonic() - started:.2f}s")
    except Exception as error:  # noqa: BLE001 - a probe must report every failure, not raise
        print(f"   {label}: failed after {time.monotonic() - started:.2f}s -- {error}")


def main() -> int:
    print(f"== {HOST}, dashboard allows {DASHBOARD_TIMEOUT_SECONDS:.0f}s per request")
    for attempt in range(1, PASSES + 1):
        print(f"\n== pass {attempt}")
        for label, query in REQUESTS:
            probe(label, query)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
