#!/usr/bin/env python3
"""Two portfolios side by side: their rules, and then every trade they actually made.

Read-only: public GETs, no writes.

Asked: one portfolio did far worse than its twin over a handful of trades. Bad luck, a
fault in the application, or the way it was set up? Those three look identical in a P/L
figure and are told apart only by comparing the trades themselves -- the same markets or
different ones, the same entry prices or worse ones, the same exits or earlier ones.

So this prints, for the period both were running:
  * every parameter that DIFFERS, because a difference in rules explains a difference in
    results and is not bad luck at all;
  * each portfolio's closed trades, and the markets they have in common;
  * on the shared markets, what each paid and what each got back -- which is where an
    execution fault would show and a run of bad luck would not.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

HOST = os.environ.get("TRADING_HOST", "https://osobnizkusenosti.cz/trading").rstrip("/")
LEFT = os.environ.get("LEFT_PORTFOLIO", "").strip()
RIGHT = os.environ.get("RIGHT_PORTFOLIO", "").strip()


def get(path: str) -> dict:
    request = urllib.request.Request(f"{HOST}/{path}", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        body = ""
        try:
            body = error.read().decode("utf-8")[:300]
        except OSError:
            pass
        raise RuntimeError(f"HTTP {error.code} for {path}: {body}") from error


def portfolio_rows(config: dict) -> dict:
    """Every portfolio in the config, keyed by id, with its account type."""
    rows = {}
    for key in ("paper",):
        for pid, row in (config.get(key) or {}).items():
            if isinstance(row, dict):
                rows[f"paper:{pid}"] = row
    for pid in ("live", "live5050"):
        if isinstance(config.get(pid), dict):
            rows[f"live:{pid}"] = config[pid]
    for pid, row in (config.get("livePortfolios") or {}).items():
        if isinstance(row, dict):
            rows[f"live:live-custom-{pid}"] = row
    return rows


def renamed_from(wanted: str) -> str | None:
    """Which portfolio USED to be called this.

    A name that is not in the config today is usually not a wrong name -- it is a portfolio
    that has since been renamed, and the trades it made are still its own. Every displayName
    change is recorded, so the id can be recovered instead of guessed at from whichever
    current name looks closest.
    """
    wanted_lower = wanted.strip().lower()
    try:
        records = get("api.php?action=portfolio-config-history").get("records") or []
    except RuntimeError:
        return None
    for record in records:
        for change in record.get("changes") or []:
            fields = change.get("fields") or change.get("changed") or {}
            values = list(fields.values()) if isinstance(fields, dict) else []
            for value in values + [change.get("before"), change.get("after")]:
                if isinstance(value, dict):
                    for candidate in (value.get("from"), value.get("to"), value.get("displayName")):
                        if isinstance(candidate, str) and candidate.strip().lower() == wanted_lower:
                            return str(change.get("strategyId") or "")
                elif isinstance(value, str) and value.strip().lower() == wanted_lower:
                    return str(change.get("strategyId") or "")
    return None


def find_by_name(rows: dict, wanted: str) -> tuple[str, dict] | tuple[None, None]:
    wanted_lower = wanted.strip().lower()
    for key, row in rows.items():
        name = str(row.get("displayName") or "").strip().lower()
        if name == wanted_lower or key.split(":", 1)[1].lower() == wanted_lower:
            return key, row
    # Then a contains match, so a name typed slightly differently still lands.
    for key, row in rows.items():
        if wanted_lower and wanted_lower in str(row.get("displayName") or "").lower():
            return key, row
    # Then the name it USED to have. A renamed portfolio keeps its trades.
    previous = renamed_from(wanted)
    if previous:
        for key, row in rows.items():
            if key.split(":", 1)[1].replace("live-custom-", "") == previous:
                print(f"   (\"{wanted}\" is now \"{row.get('displayName')}\" -- matched through the rename history)")
                return key, row
    # Finally the closest by words, so a near-miss names its candidate instead of failing.
    words = {word for word in wanted_lower.replace("+", " ").split() if len(word) > 2}
    best, best_score = None, 0
    for key, row in rows.items():
        name_words = {w for w in str(row.get("displayName") or "").lower().replace("+", " ").split() if len(w) > 2}
        score = len(words & name_words)
        if score > best_score:
            best, best_score = (key, row), score
    if best and best_score >= 2:
        print(f"   (no portfolio is called \"{wanted}\"; closest by name is \"{best[1].get('displayName')}\")")
        return best
    return None, None


PARAMETERS = [
    "minProbability", "maxProbability", "stakeUsdc", "maxResolutionHours", "liveEventMode",
    "requireEventStarted", "settlementCloseBid", "stopLossRiskMultiplier", "stopLossEnabled",
    "stopLossProbabilityFloor", "reverseOnStopLoss", "selectionOrder", "marketType",
    "excludedMarketShapes", "minLiquidityUsdc", "minNetYield", "useLimitOrders",
    "autoRotatePositions", "executionTrigger", "executionCronMinutes", "automationEnabled",
    "includeOnlyMarketTags", "excludedMarketTags", "dipEntryEnabled", "probabilitySource",
    "fixedEntryPrice",
]


def show(value: object) -> str:
    if isinstance(value, list):
        return "[" + ", ".join(str(item) for item in value) + "]" if value else "[]"
    if value is None:
        return "-"
    return str(value)


def trades_of(strategy_id: str, account: str) -> list[dict]:
    if account != "live":
        # The dashboard summary carries the SELECTED portfolio's trades in full and every
        # other portfolio's row with an empty list -- which is what makes switching cheap.
        payload = get(f"api.php?action=state&target=paper&summary=dashboard&strategy_id={strategy_id}")
        portfolio = ((payload.get("paperPortfolios") or {}).get(strategy_id) or {})
        rows = portfolio.get("trades")
        return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []
    payload = get("api.php?action=state&target=live&summary=dashboard")
    rows = (payload.get("closedTrades") or []) + (payload.get("positions") or [])
    wanted = {strategy_id, f"live-custom-{strategy_id}"}

    # Live rows are not reliably stamped with the portfolio that ordered them: on this
    # account 281 of 416 carry no portfolio at all. Ownership is established from the run
    # logs instead, and the exit-policy endpoint already does exactly that server-side --
    # it is how the stop-loss worker knows whose rule to apply to which token. Reading the
    # stamp alone reported a portfolio that had traded as having made no trades.
    owner_of = {}
    try:
        policy = get("api.php?action=live-exit-policy")
        for token, entry in (policy.get("policies") or {}).items():
            if isinstance(entry, dict) and entry.get("portfolioId"):
                owner_of[str(token)] = str(entry["portfolioId"])
    except RuntimeError:
        owner_of = {}

    def owns(row: dict) -> bool:
        stamped = str(row.get("portfolioId") or "")
        if stamped:
            return stamped in wanted
        token = str(row.get("tokenId") or row.get("assetId") or "")
        return bool(token) and owner_of.get(token, "") in wanted

    return [row for row in rows if isinstance(row, dict) and owns(row)]


CLOSED = {"WON", "LOST", "CLOSED", "REDEEMED", "SOLD", "RESOLVED", "STOP_LOSS", "STOP_GAP",
          "LIMIT_ORDER_EXPIRED", "REDEEM_REQUIRED", "FINALIZED", "SETTLED", "EXPIRED"}


def number(row: dict, *keys: str) -> float | None:
    for key in keys:
        value = row.get(key)
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value)
            except ValueError:
                continue
    return None


def summarise(rows: list[dict]) -> dict:
    closed = [row for row in rows if str(row.get("status") or "").upper() in CLOSED]
    realized = sum(number(row, "realizedPnlUsdc", "pnlUsdc") or 0.0 for row in closed)
    invested = sum(number(row, "totalCostUsdc", "stakeUsdc") or 0.0 for row in closed)
    wins = [row for row in closed if (number(row, "realizedPnlUsdc", "pnlUsdc") or 0.0) > 0]
    stops = [row for row in closed if "STOP" in str(row.get("status") or "").upper()
             or "stop" in str(row.get("closeReason") or row.get("exitReason") or "").lower()]
    certainty = [row for row in closed
                 if str(row.get("closeReason") or row.get("exitReason") or "").lower() in ("certainty", "settlement")]
    return {
        "all": len(rows),
        "closed": len(closed),
        "open": len(rows) - len(closed),
        "realized": realized,
        "invested": invested,
        "roi": (realized / invested) if invested > 0 else None,
        "wins": len(wins),
        "winRate": (len(wins) / len(closed)) if closed else None,
        "stops": len(stops),
        "certainty": len(certainty),
        "rows": closed,
    }


def market_key(row: dict) -> str:
    return str(row.get("tokenId") or row.get("conditionId") or row.get("question") or "")


def main() -> int:
    config = get("api.php?action=portfolio-config").get("config") or {}
    rows = portfolio_rows(config)
    left_key, left = find_by_name(rows, LEFT)
    right_key, right = find_by_name(rows, RIGHT)
    if not left or not right:
        print(f"Could not find both portfolios. Looked for {LEFT!r} and {RIGHT!r}.")
        print("Known portfolios:")
        for key, row in sorted(rows.items()):
            print(f"   {key:<44} {row.get('displayName')}")
        return 1

    print(f"== {left.get('displayName')}  [{left_key}]")
    print(f"== {right.get('displayName')} [{right_key}]")

    print("\n== parameters that differ")
    differing = 0
    for name in PARAMETERS:
        a, b = left.get(name), right.get(name)
        if show(a) == show(b):
            continue
        differing += 1
        print(f"   {name:<28} {show(a):<28} {show(b)}")
    if not differing:
        print("   none -- every compared parameter is identical")

    left_account = left_key.split(":", 1)[0]
    right_account = right_key.split(":", 1)[0]
    left_id = left_key.split(":", 1)[1].replace("live-custom-", "")
    right_id = right_key.split(":", 1)[1].replace("live-custom-", "")
    left_trades = trades_of(left_id, left_account)
    right_trades = trades_of(right_id, right_account)

    a, b = summarise(left_trades), summarise(right_trades)
    print("\n== trades")
    print(f"   {'':<22} {'left':>14} {'right':>14}")
    for label, key, fmt in [
        ("trades", "all", "{:d}"), ("closed", "closed", "{:d}"), ("still open", "open", "{:d}"),
        ("realized USDC", "realized", "{:+.2f}"), ("invested USDC", "invested", "{:.2f}"),
        ("wins", "wins", "{:d}"), ("stop losses", "stops", "{:d}"),
        ("closed at certainty", "certainty", "{:d}"),
    ]:
        print(f"   {label:<22} {fmt.format(a[key]):>14} {fmt.format(b[key]):>14}")
    for label, key in [("ROI", "roi"), ("win rate", "winRate")]:
        left_value = "-" if a[key] is None else f"{a[key] * 100:+.1f}%"
        right_value = "-" if b[key] is None else f"{b[key] * 100:+.1f}%"
        print(f"   {label:<22} {left_value:>14} {right_value:>14}")

    left_markets = {market_key(row): row for row in a["rows"] if market_key(row)}
    right_markets = {market_key(row): row for row in b["rows"] if market_key(row)}
    shared = sorted(set(left_markets) & set(right_markets))
    print(f"\n== markets both portfolios closed: {len(shared)}"
          f"  (only left: {len(set(left_markets) - set(right_markets))},"
          f" only right: {len(set(right_markets) - set(left_markets))})")
    if shared:
        print(f"   {'market':<44} {'entry L':>8} {'entry R':>8} {'exit L':>8} {'exit R':>8}"
              f" {'P/L L':>9} {'P/L R':>9}  reason L / reason R")
        for key in shared[:40]:
            rowa, rowb = left_markets[key], right_markets[key]
            question = str(rowa.get("question") or key)[:42]
            def price(row, *keys):
                value = number(row, *keys)
                return "-" if value is None else f"{value:.4f}"
            reason_a = str(rowa.get("closeReason") or rowa.get("exitReason") or rowa.get("status") or "")[:16]
            reason_b = str(rowb.get("closeReason") or rowb.get("exitReason") or rowb.get("status") or "")[:16]
            print(f"   {question:<44} {price(rowa, 'entryPrice'):>8} {price(rowb, 'entryPrice'):>8}"
                  f" {price(rowa, 'exitPrice', 'currentPrice'):>8} {price(rowb, 'exitPrice', 'currentPrice'):>8}"
                  f" {number(rowa, 'realizedPnlUsdc', 'pnlUsdc') or 0:>+9.2f}"
                  f" {number(rowb, 'realizedPnlUsdc', 'pnlUsdc') or 0:>+9.2f}  {reason_a} / {reason_b}")

    print("\n== trades only one of them made")
    for label, only, source in [("left only", set(left_markets) - set(right_markets), left_markets),
                                ("right only", set(right_markets) - set(left_markets), right_markets)]:
        print(f"   {label}: {len(only)}")
        for key in sorted(only)[:20]:
            row = source[key]
            print(f"      {str(row.get('question') or key)[:52]:<52}"
                  f" {number(row, 'realizedPnlUsdc', 'pnlUsdc') or 0:>+8.2f}"
                  f"  {str(row.get('closeReason') or row.get('exitReason') or row.get('status') or '')[:20]}")

    print("\n== how to read this")
    print("   A difference in the parameters is not bad luck -- it is the answer.")
    print("   Same markets, same entries, same exits, different P/L is not possible;")
    print("   same markets with WORSE entries or EARLIER exits is an execution fault;")
    print("   different markets entirely is selection, which is either the rules or the")
    print("   order they ran in. Only the last one can be luck, and only over few trades.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
