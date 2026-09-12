#!/usr/bin/env python3
"""Whether a per-portfolio SQL query can replace reading the whole catalogue.

Read-only: public GETs, no writes, no switch is flipped.

The first cutover to database reads was activated and rolled back within five minutes: the
hosting answered `storage status` in 58 seconds and reset the connection on everything else.
The cause was the shape of the read, not the database -- every request decoded the entire
active catalogue, which is now 36k rows.

The replacement is a query bounded by the portfolio's own rules. This compares the two, per
portfolio, and the number that decides it is `missedByQuery`: anything above zero means the
query's bounds are tighter than the rules, and it would silently hide markets the portfolio
would have traded. That is worse than a slow read, so it gates the switch.
"""
from __future__ import annotations

import json
import os
import time
import urllib.request

HOST = os.environ.get("TRADING_HOST", "https://osobnizkusenosti.cz/trading").rstrip("/")
STRATEGIES = [s.strip() for s in (os.environ.get("STRATEGY_IDS") or "").split(",") if s.strip()]


def get(path: str, attempts: int = 3) -> dict:
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(f"{HOST}/{path}", headers={"Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=180) as response:
                return json.loads(response.read().decode("utf-8") or "{}")
        except Exception as error:  # noqa: BLE001
            last = error
            if attempt + 1 < attempts:
                time.sleep(2 ** attempt * 3)
    raise RuntimeError(f"GET {path} failed: {last}")


def probe(strategy: str | None) -> None:
    label = strategy or "(no portfolio: the plain active catalogue)"
    path = "api.php?action=execution-scope-probe"
    if strategy:
        path += f"&strategy_id={urllib.request.quote(strategy)}"
    try:
        payload = get(path)
    except Exception as error:  # noqa: BLE001
        print(f"   {label}: FAILED -- {error}")
        return
    if not payload.get("ok"):
        print(f"   {label}: refused -- {payload.get('error')}")
        return

    catalogue = payload.get("catalogue") or {}
    query = payload.get("scopedQuery") or {}
    missed = int(payload.get("missedByQuery") or 0)
    verdict = "SAFE" if missed == 0 else f"UNSAFE ({missed} hidden)"
    print(f"\n   {label}")
    print(f"      whole catalogue  read {catalogue.get('read'):>6}  kept {catalogue.get('kept'):>5}  {catalogue.get('seconds')}s")
    truncated = " (page full -- the scope did not end here)" if query.get("truncated") else ""
    print(f"      scoped query     read {query.get('read'):>6}  kept {query.get('kept'):>5}  {query.get('seconds')}s{truncated}")
    speedup = None
    try:
        if float(query.get("seconds") or 0) > 0:
            speedup = float(catalogue.get("seconds") or 0) / float(query.get("seconds"))
    except (TypeError, ValueError, ZeroDivisionError):
        speedup = None
    if speedup:
        print(f"      the query is {speedup:.1f}x faster and decodes {catalogue.get('read', 0) - query.get('read', 0)} fewer rows")
    print(f"      -> {verdict}")
    print(f"      criteria: {json.dumps(payload.get('criteria'), sort_keys=True)}")
    for reason in payload.get("missedReasons") or []:
        stored = reason.get("stored") or {}
        payload_values = reason.get("payload") or {}
        print(f"      missed {str(reason.get('key'))[:16]}...: {'; '.join(reason.get('why') or [])}")
        print(f"         stored  probability={stored.get('probability')} endAt={stored.get('endAt')}"
              f" volume={stored.get('volume')} ageMinutes={stored.get('ageMinutes')}")
        print(f"         payload probability={payload_values.get('marketProbability')}"
              f" volumeUsdc={payload_values.get('volumeUsdc')} liquidity={payload_values.get('liquidity')}"
              f" resolutionEndDate={payload_values.get('resolutionEndDate')}"
              f" endDate={payload_values.get('endDate')}"
              f" daysToResolution={payload_values.get('daysToResolution')}")


def main() -> int:
    status = {}
    try:
        status = get("api.php?action=storage-status")
    except Exception as error:  # noqa: BLE001
        print(f"storage-status unavailable: {error}")

    print("== the switch right now")
    print(f"   reads served by SQL: {status.get('active', status.get('storageActive'))}")
    print("   (this probe reads only; it does not flip anything)")

    print("\n== whole-catalogue read against the per-portfolio query")
    probe(None)
    for strategy in STRATEGIES:
        probe(strategy)

    print("\n== how to read this")
    print("   missedByQuery must be 0 everywhere before reads are switched to SQL.")
    print("   Above zero means the query hides markets the portfolio would have traded,")
    print("   which is a worse failure than a slow page: nothing errors, it just stops")
    print("   finding candidates and there is no symptom to notice.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
