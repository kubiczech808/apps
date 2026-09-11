#!/usr/bin/env python3
"""Mirror a published Trading state into the MySQL ingestion API.

The JSON/FTP state remains the live fallback until database reads are explicitly
activated. This helper makes every worker also send its just-produced state to the
database first, in small idempotent batches, so activation never starts with a stale
catalogue or an empty run-log history.

Nothing here prints credentials. A failed optional mirror never changes the worker's
legacy publish result; after the database cutover the workflow sets
TRADING_STORAGE_INGEST_REQUIRED=true so a failed mirror stops the run instead.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def post(url: str, key: str, payload: dict[str, Any]) -> dict[str, Any]:
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=encoded,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(len(encoded)),
            "User-Agent": "trading-storage-ingest/1.0",
            "X-Trading-Trigger-Key": key,
        },
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        data = json.loads(response.read().decode("utf-8"))
    if not isinstance(data, dict) or not data.get("ok"):
        raise RuntimeError("storage API rejected the ingest")
    return data


def segment_paths(state_file: Path, state: dict[str, Any]) -> dict[str, Path]:
    manifest = state.get("stateSegments") or {}
    if not isinstance(manifest, dict):
        return {}
    paths: dict[str, Path] = {}
    for name, info in manifest.items():
        if not isinstance(name, str) or not isinstance(info, dict) or info.get("carriedOver"):
            continue
        filename = str(info.get("file") or "")
        if not filename or Path(filename).name != filename or not filename.endswith(".json"):
            continue
        candidate = state_file.parent / filename
        if candidate.is_file():
            paths[name] = candidate
    return paths


def list_rows(value: Any) -> list[dict[str, Any]]:
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def event_rows(stream: str, portfolio_id: str | None, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "stream": stream,
            "portfolioId": portfolio_id,
            "occurredAt": row.get("changedAt") or row.get("runAt") or row.get("date"),
            "payload": row,
        }
        for row in rows
    ]


def trade_rows(account: str, portfolio_id: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Trades as rows for the database, each one carrying the portfolio that placed it.

    Asked for: every trade written when it opens and updated when it closes, kept long-term
    so statistics and reposting can be built on it. The state document cannot serve that --
    it is replaced wholesale on every run -- so the trades travel separately and the API
    upserts them, which is what makes the open-then-closed transition an UPDATE rather than
    a second row.

    A trade with no portfolio is not sent at all. The API refuses those anyway rather than
    filing them under an empty string, and sending them would only make the refusal noisy.
    """
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        status = str(row.get("status") or "").upper()
        out.append({
            **row,
            "account": account,
            # The row's own portfolio wins when it has one: live rows are stamped by the
            # sync, and only paper rows take the id from the segment they were read out of.
            "portfolioId": str(row.get("portfolioId") or portfolio_id or "").strip(),
            "closed": status in {"CLOSED", "REDEEMED", "RESOLVED", "SOLD"},
        })
    return out


def ingest_paper(url: str, key: str, state_file: Path, state: dict[str, Any], target: str) -> tuple[int, int]:
    segments = segment_paths(state_file, state)
    portfolio_states: dict[str, dict[str, Any]] = {}
    trades: list[dict[str, Any]] = []
    events = event_rows("market-scan-history", None, list_rows(state.get("marketScanHistory")))
    history_path = segments.get("scanHistory")
    if history_path is not None:
        try:
            history_segment = json.loads(history_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise RuntimeError(f"could not read scan history segment {history_path.name}: {error}") from error
        events.extend(event_rows("market-scan-history", None, list_rows(history_segment.get("marketScanHistory"))))
    for name, path in segments.items():
        if not name.startswith("portfolio:"):
            continue
        portfolio_id = name[len("portfolio:"):]
        try:
            segment = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise RuntimeError(f"could not read paper portfolio segment {path.name}: {error}") from error
        portfolio = segment.get("paperPortfolio")
        if isinstance(portfolio, dict):
            portfolio_states[portfolio_id] = portfolio
            events.extend(event_rows("portfolio-run-log", portfolio_id, list_rows(portfolio.get("runLog"))))
            trades.extend(trade_rows("paper", portfolio_id, list_rows(portfolio.get("trades"))))

    # Trades go in their own batches so one large portfolio cannot push another out of the
    # single request, and so a batch that fails does not take the state document with it.
    post(url, key, {
        "target": target,
        "state": state,
        "paperPortfolios": portfolio_states,
        "events": events[:1000],
        "trades": trades[:2000],
    })
    for start in range(2000, len(trades), 2000):
        post(url, key, {"target": target, "trades": trades[start:start + 2000]})

    imported = 0
    batches = 0
    sources: list[tuple[Path, str]] = []
    active_path = segments.get("observations")
    resolved_path = segments.get("resolvedObservations")
    if active_path is not None:
        sources.append((active_path, "marketObservations"))
    elif isinstance(state.get("marketObservations"), list):
        sources.append((state_file, "marketObservations"))
    if resolved_path is not None:
        sources.append((resolved_path, "resolvedMarketObservations"))
    elif isinstance(state.get("resolvedMarketObservations"), list):
        sources.append((state_file, "resolvedMarketObservations"))
    for source, field in sources:
        try:
            rows = list_rows(json.loads(source.read_text(encoding="utf-8")).get(field))
        except (OSError, ValueError) as error:
            raise RuntimeError(f"could not read observation segment {source.name}: {error}") from error
        for offset in range(0, len(rows), 300):
            result = post(url, key, {"target": target, "observations": rows[offset:offset + 300]})
            imported += int(((result.get("ingest") or {}).get("observations") or 0))
            batches += 1
    return imported, batches


def main() -> int:
    # Storage has an explicit activation gate. Keeping the mirror disabled by
    # default prevents a deploy or a normal worker pass from starting an
    # unbounded import before the database footprint has been verified.
    if not env_bool("TRADING_STORAGE_MIRROR_ENABLED"):
        print("Trading SQL mirror is disabled pending storage verification")
        return 0
    url = os.environ.get("TRADING_STORAGE_INGEST_URL", "").strip()
    key = os.environ.get("TRADING_TRIGGER_KEY", "").strip()
    required = env_bool("TRADING_STORAGE_INGEST_REQUIRED")
    target = os.environ.get("TRADING_STORAGE_INGEST_TARGET", "").strip()
    state_file = Path(os.environ.get("TRADING_STORAGE_STATE_FILE", "").strip())
    if not url or not key:
        print("Trading SQL mirror skipped: endpoint or trigger key is not configured")
        return 1 if required else 0
    if not target or not state_file.is_file():
        message = "Trading SQL mirror skipped: target or state file is not available"
        print(message)
        return 1 if required else 0
    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
        if not isinstance(state, dict):
            raise RuntimeError("state root is not an object")
        if target == "paper":
            observations, batches = ingest_paper(url, key, state_file, state, target)
            print(f"Mirrored paper state, {observations} observations in {batches} batch(es)")
        else:
            # Live rows carry their portfolio only once the sync has stamped it, and the API
            # refuses a trade without one rather than filing it under an empty string. So an
            # unstamped row is simply not sent -- it is the row whose owner is genuinely
            # unknown, and inventing a portfolio for it is the one thing this must not do.
            live_trades = trade_rows("live", "", list_rows(state.get("positions"))) \
                + trade_rows("live", "", list_rows(state.get("closedTrades")))
            live_trades = [row for row in live_trades if str(row.get("portfolioId") or "").strip()]
            post(url, key, {
                "target": target,
                "state": state,
                "events": event_rows("state-run-log", target, list_rows(state.get("runLog"))),
                "trades": live_trades[:2000],
            })
            for start in range(2000, len(live_trades), 2000):
                post(url, key, {"target": target, "trades": live_trades[start:start + 2000]})
            print(f"Mirrored {target} state, {len(live_trades)} attributed trade(s)")
        return 0
    except (OSError, ValueError, RuntimeError, urllib.error.URLError, urllib.error.HTTPError) as error:
        print(f"Trading SQL mirror failed: {error}", file=sys.stderr)
        return 1 if required else 0


if __name__ == "__main__":
    raise SystemExit(main())
