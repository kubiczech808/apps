#!/usr/bin/env python3
"""How far ahead the retained active catalogue actually reaches.

Read-only: public GETs, no secrets, no writes.

Reported: a scan ran and the scraped count did not move. It is pinned to the retention cap
-- 8000 retained plus the rows a live portfolio protects from eviction -- so every new market
evicts an old one and intake cancels out. That is the cap working, not the scrape failing.

The question the cap raises is whether it is evicting markets the portfolios would trade. It
was raised from 5000 to 8000 for exactly that reason: at 5000 the retained set reached only
6.44 days ahead while the resolution horizon is 168 hours, so the catalogue was discarding
markets inside the window and re-scraping them next pass to discard them again.

This measures the same thing at 8000: how far ahead the furthest retained market resolves,
and how the set is distributed across that span. If the reach is comfortably past the horizon
the cap is fine and the flat number is nothing to fix. If it is back under it, the cap is
cutting into tradable markets again and the answer is a bigger one.
"""
from __future__ import annotations

import json
import os
import urllib.request
from datetime import datetime, timezone

HOST = os.environ.get("TRADING_HOST", "https://osobnizkusenosti.cz/trading").rstrip("/")
# What the portfolios actually trade within, from DEFAULT_MAX_RESOLUTION_HOURS.
HORIZON_HOURS = float(os.environ.get("RESOLUTION_HORIZON_HOURS") or 168)
PAGE_LIMIT = 1200
MAX_PAGES = 24


def get(query: str) -> dict:
    request = urllib.request.Request(f"{HOST}/api.php?{query}", headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def days_ahead(row: dict, now: datetime):
    for field in ("resolutionEndDate", "endDate", "scheduledEventDate"):
        raw = row.get(field)
        if not isinstance(raw, str) or len(raw) < 10:
            continue
        text = raw.replace("Z", "+00:00")
        try:
            moment = datetime.fromisoformat(text)
        except ValueError:
            continue
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return (moment - now).total_seconds() / 86400
    return None


def main() -> int:
    now = datetime.now(timezone.utc)
    rows: list[dict] = []
    seen: set[str] = set()
    totals = {}
    for page in range(MAX_PAGES):
        payload = get(f"action=state&target=paper&summary=scraped&offset={page * PAGE_LIMIT}")
        totals = payload.get("observationTotals") or totals
        batch = payload.get("marketObservations")
        if not isinstance(batch, list) or not batch:
            break
        for row in batch:
            if not isinstance(row, dict):
                continue
            key = str(row.get("tokenId") or row.get("id") or row.get("marketKey") or "")
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            rows.append(row)
        if payload.get("scrapedScopeTruncated") is not True:
            break

    print(f"== retained active catalogue: {len(rows)} rows walked")
    print(f"   server totals: scraped={totals.get('scraped')} resolved={totals.get('resolved')}")

    ahead = [value for value in (days_ahead(row, now) for row in rows) if value is not None]
    undated = len(rows) - len(ahead)
    future = sorted(value for value in ahead if value >= 0)
    past = [value for value in ahead if value < 0]
    horizon_days = HORIZON_HOURS / 24

    print(f"\n== how far ahead they resolve (horizon is {horizon_days:.1f} days)")
    print(f"   no readable date: {undated}")
    print(f"   already past their date: {len(past)}")
    if not future:
        print("   nothing resolves in the future -- the catalogue is entirely stale")
        return 0
    print(f"   furthest ahead: {future[-1]:.2f} days")
    print(f"   median: {future[len(future) // 2]:.2f} days")
    for bound in (1, 2, 3, 5, 7, 14, 30):
        print(f"   within {bound:>2} day(s): {sum(1 for value in future if value <= bound)}")

    print("\n== what this means")
    if future[-1] < horizon_days:
        print(f"   The cap is cutting INSIDE the horizon: the catalogue reaches"
              f" {future[-1]:.2f} days and the portfolios trade out to {horizon_days:.1f}.")
        print("   Markets inside the tradable window are being evicted and re-scraped next")
        print("   pass to be evicted again. Raising PAPER_MARKET_OBSERVATION_RETAIN_LIMIT is")
        print("   what fixes that; the response is paged, so size is no longer the blocker.")
    else:
        print(f"   The catalogue reaches {future[-1]:.2f} days, past the {horizon_days:.1f} day")
        print("   horizon, so the cap is not evicting anything the portfolios would trade.")
        print("   A flat scraped count is then the cap holding a full working set, not a")
        print("   scrape that failed to store its results.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
