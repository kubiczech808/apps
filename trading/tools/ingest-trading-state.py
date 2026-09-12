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
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# How much run-log history travels to the database.
#
# Measured: trading_event_log held 21506 portfolio-run-log rows using 103 MB, and its OLDEST
# row was two months old -- despite a retention rule that archives and deletes anything past
# a week. Archiving was not failing. The mirror sends the portfolio's whole JSON run log on
# every pass, so every row the archive deleted came straight back on the next run, and the
# table could never fall below two months of history however often it was cleaned.
#
# Cutting it here is the fix that holds: the database keeps the retention window, the archive
# keeps everything older in gzipped files, and the published JSON keeps its own longer
# history for the dashboard. Only the run-log streams are cut -- the same two the archive
# covers -- so the two rules agree. Config history is a permanent record and tiny, and is
# deliberately not cut.
RUN_LOG_RETENTION_DAYS = int(os.environ.get("RUN_LOG_RETENTION_DAYS") or 7)
RETAINED_RUN_LOG_STREAMS = {"portfolio-run-log", "state-run-log"}


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
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        # The endpoint answers a refusal with a reason in the body, and urllib turns the
        # status into an exception before anything reads it. Two hours of silent mirror
        # failure looked like "HTTP Error 503" for exactly this reason.
        detail = ""
        try:
            body = json.loads(error.read().decode("utf-8") or "{}")
            detail = str(body.get("reason") or body.get("error") or "")[:300]
        except (ValueError, OSError):
            detail = ""
        raise RuntimeError(f"HTTP {error.code}{': ' + detail if detail else ''}") from error
    if not isinstance(data, dict) or not data.get("ok"):
        reason = str(data.get("reason") or data.get("error") or "")[:300] if isinstance(data, dict) else ""
        raise RuntimeError(f"storage API rejected the ingest{': ' + reason if reason else ''}")
    return data


# Every part that failed after its retry, so the step can say so instead of exiting 0 quietly.
MIRROR_FAILURES: list[str] = []


def try_post(url: str, key: str, payload: dict[str, Any], label: str) -> dict[str, Any]:
    """One part of the mirror, whose failure must not cancel the parts after it.

    Measured, not supposed: every scan and bot pass reported this step as a success while
    the database went two hours without a write. The state document, the portfolios, the
    events and the trades all went in one request, and the observation batches came after
    it -- so a single oversized or slow request raised, unwound the whole function, and the
    27 batches of catalogue that were the point of the mirror were never sent. The step then
    exited 0, because the mirror is deliberately optional.

    Each part is now sent and judged on its own, retried once for a transient failure, and
    a part that still fails is recorded and reported rather than swallowed.
    """
    for attempt in range(2):
        try:
            return post(url, key, payload)
        except (urllib.error.HTTPError, urllib.error.URLError, OSError, ValueError, RuntimeError) as error:
            if attempt == 0:
                time.sleep(3)
                continue
            MIRROR_FAILURES.append(f"{label}: {error}")
    return {}


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


def run_log_cutoff() -> str:
    """The oldest run-log moment worth sending, as a comparable ISO prefix.

    Nineteen characters -- YYYY-MM-DDTHH:MM:SS -- so the comparison never depends on whether
    a timestamp ends in Z or +00:00 or carries milliseconds. Every timestamp in these streams
    is produced by toISOString and is therefore UTC.
    """
    moment = datetime.now(timezone.utc) - timedelta(days=RUN_LOG_RETENTION_DAYS)
    return moment.strftime("%Y-%m-%dT%H:%M:%S")


def event_rows(stream: str, portfolio_id: str | None, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cut = run_log_cutoff() if (stream in RETAINED_RUN_LOG_STREAMS and RUN_LOG_RETENTION_DAYS > 0) else None
    out: list[dict[str, Any]] = []
    for row in rows:
        at = row.get("changedAt") or row.get("runAt") or row.get("date")
        # Fails open: a row whose moment cannot be read is sent rather than dropped. Losing
        # history to a date this could not parse would be a worse outcome than storing it.
        if cut and isinstance(at, str) and len(at) >= 19 and at[:19] < cut:
            continue
        out.append({
            "stream": stream,
            "portfolioId": portfolio_id,
            "occurredAt": at,
            "payload": row,
        })
    return out


def recently_resolved(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The resolved markets worth re-sending, newest first.

    Measured while working out why the hosting collapsed under database reads: the mirror was
    posting the WHOLE resolved archive on every pass. 84183 rows in batches of 300 is 281 POST
    requests, each one an upsert transaction, every ten minutes -- on top of 28 for the active
    catalogue -- against the same shared host that serves the dashboard. That is why every
    resolved row showed as written within the last day: not because any of them changed, but
    because all of them were being rewritten, constantly.

    A resolved market does not change. The backfill is the migration's job and it is done, so
    the mirror only has to carry what has resolved since. Bounded twice over, because one
    bound alone can fail open: a window, so nothing old travels, and a hard cap, so a segment
    whose rows carry no readable resolution date cannot quietly restore the old behaviour.
    """
    days = max(1, int(os.environ.get("RESOLVED_MIRROR_DAYS") or 3))
    cap = max(100, int(os.environ.get("RESOLVED_MIRROR_LIMIT") or 1500))
    cut = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")

    def resolved_at(row: dict[str, Any]) -> str:
        for field in ("resolvedAt", "endDate", "closedAt", "observedAt"):
            value = row.get(field)
            if isinstance(value, str) and len(value) >= 19:
                return value[:19]
        return ""

    recent = sorted(
        (row for row in rows if resolved_at(row) >= cut),
        key=resolved_at,
        reverse=True,
    )
    # A row whose resolution moment cannot be read is not old, it is unplaceable -- so it
    # travels rather than being silently dropped, behind the rows that can be dated and
    # inside the same cap. Dropping it would be the one way a newly resolved market could
    # never reach the database at all.
    undated = [row for row in rows if not resolved_at(row)]
    send = (recent + undated)[:cap]
    if len(send) < len(rows):
        print(
            f"Resolved archive: sending {len(send)} of {len(rows)}"
            f" (window {days}d, cap {cap}; the rest resolved earlier and cannot change,"
            f" and the backfill is the migration's job)"
        )
    return send


def slim_run_log_row(row: dict[str, Any]) -> dict[str, Any]:
    """A run-log entry reduced to what the database is actually asked for.

    Measured the moment the mirror was switched on: trading_event_log went from 713 rows and
    7 MB to 21315 rows and 204 MB, which took the whole database 18 MB past its 300 MB growth
    budget on its own. The cause is that the full record travels -- topCandidates,
    topRejected, the prevalidation filter, the whole shortlist -- roughly 10 KB per run, most
    of it a snapshot of markets that is already in the published state file.

    What the stored history is read back FOR is narrow: which portfolio ordered which token
    at what price (live-order-ownership), and what each run decided. So that is what is kept.
    Everything else stays available in the published execution state, which is where the
    dashboard reads it from anyway.
    """
    attempts = []
    for attempt in list_rows(row.get("attempts")):
        attempts.append({
            "action": attempt.get("action"),
            "tokenId": attempt.get("tokenId"),
            "orderPrice": attempt.get("orderPrice"),
            "shares": attempt.get("shares"),
            "question": attempt.get("question"),
            "outcome": attempt.get("outcome"),
        })
    slim = {
        "id": row.get("id"),
        "runAt": row.get("runAt") or row.get("generatedAt"),
        "generatedAt": row.get("generatedAt"),
        "strategyId": row.get("strategyId"),
        "strategyLabel": row.get("strategyLabel"),
        "action": row.get("action"),
        "reason": row.get("reason"),
        "attempts": attempts,
    }
    return {key: value for key, value in slim.items() if value is not None}


def trade_rows(account: str, portfolio_id: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Trades as rows for the database, each one carrying the portfolio that placed it.

    Asked for: every trade written when it opens and updated when it closes, kept long-term
    so statistics and reposting can be built on it. The state document cannot serve that --
    it is replaced wholesale on every run -- so the trades travel separately and the API
    upserts them, which is what makes the open-then-closed transition an UPDATE rather than
    a second row.

    Live and paper trades are stored the same way and told apart by the account attribute. A
    live trade whose portfolio is not known yet still travels: there is one live wallet, the
    owner is derived afterwards from the order history, and the API fills the id in on a later
    pass. A paper trade always comes out of a named portfolio segment, so one arriving without
    an id is a defect and the API reports it.
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
            events.extend(event_rows("portfolio-run-log", portfolio_id, [slim_run_log_row(row) for row in list_rows(portfolio.get("runLog"))]))
            trades.extend(trade_rows("paper", portfolio_id, list_rows(portfolio.get("trades"))))

    # Four separate requests rather than one. They used to be combined, and the combined one
    # is the largest the mirror sends: the whole state document, every portfolio, a thousand
    # events and two thousand trades. When it started failing, it raised before the first
    # observation batch and the catalogue -- the part the cutover depends on -- went unsent
    # for hours while the step reported success.
    try_post(url, key, {"target": target, "state": state}, "state document")
    try_post(url, key, {"target": target, "paperPortfolios": portfolio_states}, "portfolios")
    try_post(url, key, {"target": target, "events": events[:1000]}, "events")
    for start in range(0, len(trades), 2000):
        try_post(url, key, {"target": target, "trades": trades[start:start + 2000]}, f"trades {start}")

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
        if field == "resolvedMarketObservations":
            rows = recently_resolved(rows)
        for offset in range(0, len(rows), 300):
            result = try_post(
                url, key,
                {"target": target, "observations": rows[offset:offset + 300]},
                f"{field} {offset}",
            )
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
            # Every live trade is sent, stamped with a portfolio or not.
            #
            # Filtering on the stamp used to drop the lot: the sync stamps a live row only once
            # the order history proves who opened it, so at any moment a good share of the
            # account is unattributed -- and with the API refusing those too, the live account
            # had zero rows stored while paper had thousands. Nothing is invented here: an
            # unattributed row goes in with an empty portfolio and the id is filled in by the
            # pass that works the owner out.
            live_trades = trade_rows("live", "", list_rows(state.get("positions"))) \
                + trade_rows("live", "", list_rows(state.get("closedTrades")))
            attributed = sum(1 for row in live_trades if str(row.get("portfolioId") or "").strip())
            try_post(url, key, {"target": target, "state": state}, "state document")
            try_post(url, key, {
                "target": target,
                "events": event_rows("state-run-log", target, [slim_run_log_row(row) for row in list_rows(state.get("runLog"))]),
            }, "events")
            for start in range(0, len(live_trades), 2000):
                try_post(url, key, {"target": target, "trades": live_trades[start:start + 2000]}, f"trades {start}")
            print(
                f"Mirrored {target} state, {len(live_trades)} trade(s)"
                f" ({attributed} with a portfolio, {len(live_trades) - attributed} still unattributed)"
            )
        # A mirror that stops has no symptom of its own: reads still come from the JSON
        # files, so nothing on the dashboard changes and the step goes on exiting 0. Say it
        # here, where the step log is read, and name the parts.
        if MIRROR_FAILURES:
            print(
                f"Trading SQL mirror INCOMPLETE: {len(MIRROR_FAILURES)} part(s) failed"
                f" -- {'; '.join(MIRROR_FAILURES[:6])}",
                file=sys.stderr,
            )
            # The reason travels in the annotation, not only in the step log: a count alone
            # says the mirror is broken without saying how, and the step log for a scan is
            # thousands of lines that the API will not hand back.
            print(
                f"::warning::Trading SQL mirror incomplete: {len(MIRROR_FAILURES)} part(s) failed."
                f" First: {MIRROR_FAILURES[0][:300]}"
            )
            return 1 if required else 0
        return 0
    except (OSError, ValueError, RuntimeError, urllib.error.URLError, urllib.error.HTTPError) as error:
        print(f"Trading SQL mirror failed: {error}", file=sys.stderr)
        return 1 if required else 0


if __name__ == "__main__":
    raise SystemExit(main())
