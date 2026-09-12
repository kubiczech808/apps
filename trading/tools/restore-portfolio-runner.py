#!/usr/bin/env python3
"""Put the lost trades back, one portfolio at a time, by merging.

THIS WRITES. Everything else built for this incident measures; this changes the published
state. It is deliberately narrow about it:

  * a preview runs first for every portfolio, and any portfolio holding a published trade
    the database does not have is skipped rather than merged
  * the merge is by trade key, so today's trades stay and the history joins them
  * the first refusal in ALL mode stops the run, because a restore that keeps going past
    something it did not understand is how one bad assumption becomes thirty-three

Only the trades are written. Equity, free capital, realized P/L and ROI are derived from
them by the paper bot on its next pass.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

HOST = os.environ.get("TRADING_HOST", "https://www.osobnizkusenosti.cz/trading").rstrip("/")
KEY = os.environ["TRADING_TRIGGER_KEY"]
TARGET = os.environ.get("RESTORE_PORTFOLIO", "").strip()
CONFIRM = os.environ.get("RESTORE_CONFIRM", "").strip()

if not TARGET:
    print("RESTORE_PORTFOLIO is required (a portfolio id, or ALL).")
    raise SystemExit(1)
if CONFIRM != TARGET:
    print(f"Refusing to run: confirm must repeat {TARGET!r} exactly, and it was {CONFIRM!r}.")
    raise SystemExit(1)


def call(payload: dict, timeout: int = 180):
    request = urllib.request.Request(
        f"{HOST}/api.php?action=storage-admin",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "X-Trading-Trigger-Key": KEY},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8")), None
    except urllib.error.HTTPError as error:
        try:
            body = error.read().decode("utf-8")
            return json.loads(body), None
        except Exception:  # noqa: BLE001
            return None, f"HTTP {error.code}"
    except Exception as error:  # noqa: BLE001
        return None, str(error)


if TARGET == "ALL":
    summary, error = call({"operation": "trade-summary"})
    if error or not (summary or {}).get("ok"):
        print(f"could not list stored portfolios: {error or json.dumps(summary)[:300]}")
        raise SystemExit(1)
    portfolios = sorted({
        str(row.get("portfolioId") or "")
        for row in (summary.get("trades") or [])
        if str(row.get("account") or "") == "paper" and str(row.get("portfolioId") or "")
    })
else:
    portfolios = [TARGET]

print(f"== restoring {len(portfolios)} portfolio(s)")
print("")

restored_total = 0
skipped = []
for portfolio in portfolios:
    preview, error = call({"operation": "restore-preview", "portfolio": portfolio, "account": "paper"})
    if error or not (preview or {}).get("ok"):
        print(f"{portfolio:<24} PREVIEW FAILED: {error or json.dumps(preview)[:200]}")
        raise SystemExit(1)
    at_risk = int(preview.get("publishedButNotStored") or 0)
    if at_risk:
        print(f"{portfolio:<24} SKIPPED: {at_risk} published trade(s) are not in the database")
        skipped.append(portfolio)
        continue
    if not preview.get("segmentFound"):
        print(f"{portfolio:<24} SKIPPED: no published segment to merge into")
        skipped.append(portfolio)
        continue

    result, error = call({
        "operation": "restore-portfolio",
        "portfolio": portfolio,
        "confirm": portfolio,
        "account": "paper",
    })
    if error or not (result or {}).get("ok"):
        print(f"{portfolio:<24} FAILED: {error or json.dumps(result)[:300]}")
        raise SystemExit(1)
    restored_total += int(result.get("restored") or 0)
    print(f"{portfolio:<24} restored {result.get('restored', 0):>5}"
          f"   {result.get('tradesBefore', 0)} -> {result.get('tradesAfter', 0)} trades")

print("")
print(f"trades restored: {restored_total}")
if skipped:
    print(f"skipped: {', '.join(skipped)}")
print("Equity, free capital and ROI are recomputed from these trades by the next paper bot pass.")
