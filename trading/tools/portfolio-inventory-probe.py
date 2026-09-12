#!/usr/bin/env python3
"""What does each paper portfolio actually hold, according to the server.

Read-only: public GETs against the published API. No writes, no switch is touched.

Reported: every paper row in the overview table shows equity $100.00, in-positions $0.00 and
no ROI, while the two live rows show real numbers. "Wiped" is what that looks like from the
table. It is also what a portfolio with no trades looks like, and what a summary that failed
to load looks like, and those three call for completely different responses -- so this asks
the server for the numbers behind every row instead of reading the table.

Three things are printed per portfolio, because they come from three different places and
any one of them can be the empty one:

  portfolio.*        the published paper state: equity, free capital, what is at risk
  historySummary.*   the per-portfolio trade history segment, read separately
  trades             what the dashboard view returns when that portfolio is selected

A portfolio that was reset reads 100/0 in ALL THREE. A portfolio whose history simply is
not being loaded reads 100/0 in the first two and has trades in the third. A portfolio that
never traded reads 100/0 everywhere and has no closed trades in its history either -- and is
telling the truth.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

HOST = os.environ.get("TRADING_HOST", "https://osobnizkusenosti.cz/trading").rstrip("/")
# Portfolios to open individually. The overview is asked about all of them; these are the
# ones whose trade lists are pulled too, because that is the expensive half.
DEEP = [item.strip() for item in os.environ.get("DEEP_PORTFOLIOS", "").split(",") if item.strip()]


def get(path: str, timeout: int = 90):
    started = time.time()
    request = urllib.request.Request(f"{HOST}/{path}", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
        return json.loads(body.decode("utf-8") or "{}"), time.time() - started, None
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            detail = error.read().decode("utf-8")[:500]
        except OSError:
            pass
        return None, time.time() - started, f"HTTP {error.code} {detail}"
    except Exception as error:  # noqa: BLE001
        return None, time.time() - started, str(error)


def number(value):
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def money(value):
    parsed = number(value)
    return "     -" if parsed is None else f"{parsed:10.2f}"


status, seconds, error = get("api.php?action=storage-status")
print(f"== storage switch ({seconds:.2f}s)")
if error:
    print(f"   FAILED: {error}")
else:
    # Which read path served everything below. The same numbers mean different things
    # depending on this line: a stale mirror and a wiped file are not the same incident.
    print(f"   active={json.dumps(status.get('active'))}"
          f"  mode={json.dumps(status.get('mode'))}"
          f"  readsFrom={json.dumps(status.get('readsFrom') or status.get('reads'))}")
    counts = status.get("counts") or status.get("tables") or {}
    if counts:
        print(f"   rows: {json.dumps(counts)[:400]}")

# Display names live in the config, not in the state, so a row printed by id alone cannot
# be matched against the table the user is actually looking at.
config, seconds, error = get("api.php?action=portfolio-config")
names = {}
if error:
    print(f"\n== portfolio config FAILED: {error}")
else:
    for key, entry in (((config or {}).get("config") or config or {}).get("paper") or {}).items():
        if isinstance(entry, dict):
            names[key] = str(entry.get("displayName") or entry.get("name") or "")
    print(f"\n== portfolio config ({seconds:.2f}s)   named paper portfolios={len(names)}")

overview, seconds, error = get("api.php?action=state&target=paper&summary=portfolio-overview")
print("")
print(f"== portfolio overview ({seconds:.2f}s)")
if error:
    print(f"   FAILED: {error}")
    raise SystemExit(1)

portfolios = overview.get("paperPortfolios") or {}
print(f"   generatedAt={json.dumps(overview.get('generatedAt'))}   portfolios={len(portfolios)}")
print("")
print(f"   {'id':<26} {'equity':>10} {'free':>10} {'positions':>10} {'orders':>10}"
      f" {'closed':>7} {'realized':>10}  name")

# Ordered so the ones that look wiped are easy to count, not hunted for.
for key in sorted(portfolios):
    row = portfolios[key]
    if not isinstance(row, dict):
        continue
    portfolio = row.get("portfolio") or {}
    history = row.get("historySummary") or {}
    positions = number(portfolio.get("positionRiskUsdc"))
    if positions is None:
        open_risk = number(portfolio.get("openRiskUsdc")) or 0.0
        resting = number(portfolio.get("restingLimitOrderUsdc")) or 0.0
        positions = open_risk - resting
    print(f"   {key:<26} {money(portfolio.get('equityUsdc'))} {money(portfolio.get('freeCapitalUsdc'))}"
          f" {money(positions)} {money(portfolio.get('restingLimitOrderUsdc'))}"
          f" {str(history.get('closedFilledCount', '-')):>7} {money(history.get('closedRealizedPnlUsdc'))}"
          f"  {(names.get(key) or row.get('displayName') or '')[:40]}")

# The history segment is a separate read from the state, so a portfolio can have a full
# trade history and still publish a reset-looking state -- and vice versa. Print what the
# dashboard view actually returns for a named portfolio, which is the third source.
for strategy in DEEP:
    print("")
    detail, seconds, error = get(
        f"api.php?action=state&target=paper&summary=dashboard&strategy_id={urllib.parse.quote(strategy)}")
    print(f"== dashboard view for {strategy!r} {names.get(strategy, '')!r} ({seconds:.2f}s)")
    if error:
        print(f"   FAILED: {error}")
        continue
    row = (detail.get("paperPortfolios") or {}).get(strategy)
    if not isinstance(row, dict):
        print(f"   not present in the dashboard payload; keys: {sorted((detail.get('paperPortfolios') or {}).keys())[:20]}")
        continue
    trades = row.get("trades")
    trades = trades if isinstance(trades, list) else []
    statuses = {}
    for trade in trades:
        statuses[str(trade.get("status"))] = statuses.get(str(trade.get("status")), 0) + 1
    portfolio = row.get("portfolio") or {}
    print(f"   equity={money(portfolio.get('equityUsdc'))}  free={money(portfolio.get('freeCapitalUsdc'))}"
          f"  trades={len(trades)}  byStatus={json.dumps(statuses)}")
    if trades:
        newest = max(trades, key=lambda item: str(item.get("openedAt") or ""))
        oldest = min(trades, key=lambda item: str(item.get("openedAt") or ""))
        print(f"   oldest openedAt={json.dumps(oldest.get('openedAt'))}  newest openedAt={json.dumps(newest.get('openedAt'))}")
        # By month, because "wiped" usually means a gap rather than an empty list: a history
        # that stops dead in July while the portfolio kept trading looks fine from a count.
        months = {}
        for trade in trades:
            month = str(trade.get("openedAt") or "")[:7] or "unknown"
            months[month] = months.get(month, 0) + 1
        print(f"   by month: {json.dumps(dict(sorted(months.items())))}")

print("")
print("Read this as: 100.00 / 0.00 in every column AND no closed trades means the portfolio")
print("holds nothing and has no history -- either it never traded, or its history is gone.")
print("Numbers in historySummary with a 100.00 equity means the history is intact and only")
print("the published state was reset.")
