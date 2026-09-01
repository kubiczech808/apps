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


def ingest_paper(url: str, key: str, state_file: Path, state: dict[str, Any], target: str) -> tuple[int, int]:
    segments = segment_paths(state_file, state)
    portfolio_states: dict[str, dict[str, Any]] = {}
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

    post(url, key, {
        "target": target,
        "state": state,
        "paperPortfolios": portfolio_states,
        "events": events[:1000],
    })

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
            post(url, key, {"target": target, "state": state, "events": event_rows("state-run-log", target, list_rows(state.get("runLog")))})
            print(f"Mirrored {target} state")
        return 0
    except (OSError, ValueError, RuntimeError, urllib.error.URLError, urllib.error.HTTPError) as error:
        print(f"Trading SQL mirror failed: {error}", file=sys.stderr)
        return 1 if required else 0


if __name__ == "__main__":
    raise SystemExit(main())
