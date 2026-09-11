#!/usr/bin/env python3
"""Why do stored live trades carry no portfolio?

Read-only. Fetches the published live state and the live-order-ownership record over HTTPS,
places no orders, writes nothing, uses no secrets.

Measured before this existed: 364 live trades stored, every one of them with no portfolio,
while the dashboard shows most live rows attributed. The dashboard resolves ownership at
render time from the execution state; the SYNC is what stamps the stored rows, and the stored
rows are what the database keeps. So the two can disagree, and only the stored side matters
for the long-term statistics this is all for.

Three failures look identical from outside and need different fixes, so this separates them:

  1. the ownership record is empty        -> nothing to match against
  2. the token is not in the record       -> that order was never logged
  3. the token is there but no price fits -> the tolerance is wrong, or the fill price moved

The third is the interesting one: an order logged at one price and filled at another is a
real thing, and the tolerance that decides "close enough" is a guess until it is measured.
"""
from __future__ import annotations

import json
import os
import urllib.request

HOST = os.environ.get("TRADING_HOST", "https://osobnizkusenosti.cz/trading").rstrip("/")
# How far a fill may sit from the logged order price and still be the same order. The sync
# uses 0.02; this reports the distances so that number can be checked rather than trusted.
TOLERANCE = float(os.environ.get("OWNERSHIP_PRICE_TOLERANCE") or 0.02)


def get(path: str) -> dict:
    request = urllib.request.Request(f"{HOST}/api.php?{path}", headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def rows(value) -> list:
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def price_of(row: dict):
    for field in ("entryPrice", "avgPrice"):
        try:
            value = float(row.get(field))
        except (TypeError, ValueError):
            continue
        if value == value:  # not NaN
            return value
    return None


def main() -> int:
    ownership = get("action=live-order-ownership")
    orders = rows(ownership.get("orders"))
    by_token: dict[str, list] = {}
    for order in orders:
        token = str(order.get("tokenId") or "")
        if token:
            by_token.setdefault(token, []).append(order)

    # The single most likely reason for an empty record, and the one that is not a defect:
    # the endpoint reads the event log out of MySQL and returns nothing at all while database
    # reads are switched off. Printed first so an empty result explains itself.
    active = ownership.get("storageActive")
    print(f"== database reads active: {active}")
    if active is not True:
        print("   The ownership record is read from the event log in MySQL and is empty by")
        print("   design until reads are activated. Stored live trades stay unattributed")
        print("   until then; this is the migration finishing, not a fault.")
    runs = ownership.get("runsPerMode")
    if isinstance(runs, dict):
        print(f"   runs read per live portfolio: {runs}")
    print(f"   oldest run in the record: {ownership.get('oldestRunAt')}")

    modes = sorted({str(order.get("mode") or "?") for order in orders})
    print(f"\n== ownership record: {len(orders)} order(s), {len(by_token)} distinct token(s)")
    print(f"   portfolios seen in it: {', '.join(modes) if modes else '(none)'}")
    priced = sum(1 for order in orders if order.get("price") is not None)
    print(f"   orders carrying a price: {priced} of {len(orders)}")

    state = get("action=state&target=live")
    for name in ("positions", "closedTrades"):
        group = rows(state.get(name))
        stamped = [row for row in group if str(row.get("portfolioId") or "").strip()]
        print(f"\n== {name}: {len(group)} row(s), {len(stamped)} already stamped")
        no_token = unknown_token = no_price = no_match = 0
        nearest = []
        for row in group:
            if str(row.get("portfolioId") or "").strip():
                continue
            token = str(row.get("tokenId") or row.get("assetId") or "")
            if not token:
                no_token += 1
                continue
            candidates = by_token.get(token)
            if not candidates:
                unknown_token += 1
                continue
            paid = price_of(row)
            if paid is None:
                no_price += 1
                continue
            gaps = [
                abs(paid - float(order["price"]))
                for order in candidates
                if order.get("price") is not None
            ]
            if not gaps or min(gaps) >= TOLERANCE:
                no_match += 1
                if gaps:
                    nearest.append(round(min(gaps), 4))
        print(f"   unstamped because the row has no token id:        {no_token}")
        print(f"   unstamped because the token was never logged:     {unknown_token}")
        print(f"   unstamped because the row has no buy price:       {no_price}")
        print(f"   unstamped because no logged price is within {TOLERANCE}: {no_match}")
        if nearest:
            nearest.sort()
            middle = nearest[len(nearest) // 2]
            print(f"      closest gaps: min {nearest[0]}, median {middle}, max {nearest[-1]}")
            print("      a tolerance above the median would attribute most of these")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
