#!/usr/bin/env python3
"""What a restore from the mirror would do to each paper portfolio. Nothing is written.

Read-only. One POST per portfolio to the read-only 'restore-preview' operation, which
compares two sets of trade keys -- the published state's and the database's -- using the
same key function the mirror files rows under.

Two numbers come out of each portfolio and only one of them is the obvious one:

  wouldRestore            trades the database has and the published state lost
  publishedButNotStored   trades the published state has and the database does NOT

The second decides whether restoring is safe at all. A restore that overwrites a portfolio
from a source missing today's trades would trade one loss for another, and on 2026-09-12
one loss was already enough. Any portfolio with a non-zero count there must be merged
rather than overwritten, or not touched at all.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

HOST = os.environ.get("TRADING_HOST", "https://www.osobnizkusenosti.cz/trading").rstrip("/")
KEY = os.environ["TRADING_TRIGGER_KEY"]
ACCOUNT = os.environ.get("RESTORE_ACCOUNT", "paper").strip() or "paper"


def call(payload: dict, timeout: int = 90):
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
            return None, f"HTTP {error.code}: {error.read().decode('utf-8')[:300]}"
        except OSError:
            return None, f"HTTP {error.code}"
    except Exception as error:  # noqa: BLE001
        return None, str(error)


# Which portfolios to ask about: the ones the mirror actually holds rows for. Asking the
# database rather than the config is deliberate -- a portfolio the config forgot would still
# have history worth seeing, and a portfolio with no stored rows has nothing to preview.
summary, error = call({"operation": "trade-summary"})
if error or not (summary or {}).get("ok"):
    print(f"could not list stored portfolios: {error or json.dumps(summary)[:300]}")
    raise SystemExit(1)

portfolios = sorted({
    str(row.get("portfolioId") or "")
    for row in (summary.get("trades") or [])
    if str(row.get("account") or "") == ACCOUNT and str(row.get("portfolioId") or "")
})
print(f"== {len(portfolios)} {ACCOUNT} portfolios with stored trades")
print("")
print(f"{'portfolio':<24} {'published':>9} {'stored':>7} {'restores':>9} {'AT RISK':>8}  oldest restored")

total_restore = 0
at_risk = []
missing_segment = []
for portfolio in portfolios:
    preview, error = call({"operation": "restore-preview", "portfolio": portfolio, "account": ACCOUNT})
    if error or not (preview or {}).get("ok"):
        print(f"{portfolio:<24} FAILED: {error or json.dumps(preview)[:200]}")
        continue
    restores = int(preview.get("wouldRestore") or 0)
    risk = int(preview.get("publishedButNotStored") or 0)
    total_restore += restores
    if risk:
        at_risk.append((portfolio, risk))
    if not preview.get("segmentFound"):
        missing_segment.append(portfolio)
    print(f"{portfolio:<24} {preview.get('publishedTrades', 0):>9} {preview.get('storedTrades', 0):>7}"
          f" {restores:>9} {risk:>8}  {str(preview.get('oldestRestored') or '')}"
          f"{'' if preview.get('segmentFound') else '   (no published segment)'}")

print("")
print(f"trades a restore would bring back: {total_restore}")
if at_risk:
    print("")
    print("NOT SAFE TO OVERWRITE -- these portfolios hold published trades the database does not:")
    for portfolio, count in at_risk:
        print(f"   {portfolio}: {count}")
    print("A restore here has to MERGE the two sets, never replace one with the other.")
else:
    print("every published trade is also in the database, so no restore can lose one")
if missing_segment:
    print("")
    print(f"portfolios with stored history but no published segment: {', '.join(missing_segment)}")
