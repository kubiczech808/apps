#!/usr/bin/env python3
"""Print the storage status as a few readable lines instead of a page of JSON.

The migration workflow reports the status before and after every operation, and dumping
the raw payload twice made a single dispatch 971 log lines -- so long that the numbers the
report exists for (how big each table is, and how much of that is free space MySQL has not
handed back) were buried under a full per-portfolio trade listing.

The first line is the one that matters operationally: the hosting account allows 2000 MB
of MySQL in total and was at 1785 MB before this migration started, so the whole-database
figure -- not just the trading tables -- is what has to stay inside its budget.

Reads the storage-status payload on stdin. Never fails the step: an unreadable payload is
reported as such and exits 0, because a formatting problem must not mask the operation.
"""
from __future__ import annotations

import json
import os
import sys

# What the hosting account allows in total, and what it was using when this migration
# began. Both are overridable so the note stays true if the plan changes.
QUOTA_MB = float(os.environ.get("MYSQL_QUOTA_MB") or 2000)
BASELINE_MB = float(os.environ.get("MYSQL_BASELINE_MB") or 1785)


def mb(value: object) -> str:
    try:
        return f"{round(int(value) / 1048576, 1)} MB"
    except (TypeError, ValueError):
        return "?"


def trades(payload: dict) -> int:
    """One line per account, not one block per portfolio.

    The full listing is available whenever it is wanted; what a migration step needs to
    show is whether trades are still arriving and still attributed to a portfolio.
    """
    rows = payload.get("portfolios") or payload.get("rows") or []
    if not isinstance(rows, list):
        print("   trade summary had an unexpected shape")
        return 0
    accounts: dict[str, dict[str, object]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        bucket = accounts.setdefault(
            str(row.get("account") or "?"),
            {"portfolios": 0, "total": 0, "open": 0, "closed": 0, "unattributed": 0, "last": ""},
        )
        owner = str(row.get("portfolioId") or "").strip()
        if owner:
            bucket["portfolios"] = int(bucket["portfolios"]) + 1
        else:
            # Live rows are stored before anyone knows who opened them. Counted rather than
            # folded into the total, because "364 trades across 1 portfolios" reads like an
            # attributed account and is the opposite.
            bucket["unattributed"] = int(bucket["unattributed"]) + int(row.get("total") or 0)
        for field in ("total", "open", "closed"):
            bucket[field] = int(bucket[field]) + int(row.get(field) or 0)
        last = str(row.get("lastUpdatedAt") or "")
        if last > str(bucket["last"]):
            bucket["last"] = last
    if not accounts:
        print("   no trade rows are stored yet")
        return 0
    for name in sorted(accounts):
        bucket = accounts[name]
        unattributed = int(bucket["unattributed"])
        print(
            f"   {name}: {bucket['total']} trades across {bucket['portfolios']} portfolios"
            f" ({bucket['open']} open, {bucket['closed']} closed"
            + (f", {unattributed} with NO portfolio yet" if unattributed else "")
            + f"), last updated {bucket['last'] or 'never'}"
        )
    return 0


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        print(f"   payload was not JSON ({len(raw)} bytes): {raw[:200]}")
        return 0

    if "--trades" in sys.argv[1:]:
        return trades(payload)

    storage = payload.get("storage") or {}
    tables = storage.get("tradingTables") or {}

    database_bytes = storage.get("databaseSizeBytes")
    if isinstance(database_bytes, int):
        used = database_bytes / 1048576
        other = max(0.0, BASELINE_MB - (storage.get("tradingSizeBytes") or 0) / 1048576)
        print(
            f"   whole database: {round(used, 1)} MB of {round(QUOTA_MB)} MB"
            f" (hosting reported {round(BASELINE_MB)} MB used in total;"
            f" roughly {round(other)} MB of that is not trading)"
        )
    else:
        print("   whole database size unavailable -- the status endpoint could not connect")

    free = sum(
        int(stats.get("freeBytes") or 0)
        for stats in tables.values()
        if isinstance(stats, dict)
    )
    print(
        f"   trading tables: {mb(storage.get('tradingSizeBytes'))} allocated,"
        f" {mb(free)} of it free inside the files"
    )
    for name in sorted(tables):
        stats = tables[name]
        if not isinstance(stats, dict):
            continue
        size = int(stats.get("dataBytes") or 0) + int(stats.get("indexBytes") or 0)
        print(
            f"      {name}: {stats.get('rows', '?')} rows,"
            f" {mb(size)} ({mb(stats.get('freeBytes'))} free)"
        )

    streams = payload.get("eventStreams")
    if isinstance(streams, list) and streams:
        print("   event log by stream:")
        for entry in streams:
            if not isinstance(entry, dict):
                continue
            rows = int(entry.get("rows") or 0)
            total = int(entry.get("bytes") or 0)
            average = round(total / rows) if rows else 0
            print(
                f"      {entry.get('stream')}: {rows} rows, {mb(total)}"
                f" (avg {average} B, largest {entry.get('largestRowBytes')} B)"
                f" {entry.get('oldest')} .. {entry.get('newest')}"
            )

    freshness = payload.get("observationFreshness")
    if isinstance(freshness, list) and freshness:
        print("   stored markets by age of their last observation:")
        for entry in freshness:
            if not isinstance(entry, dict):
                continue
            rows = int(entry.get("rows") or 0)
            day = int(entry.get("within1Day") or 0)
            week = int(entry.get("within7Days") or 0)
            month = int(entry.get("within30Days") or 0)
            share = f"{round(100 * day / rows)}%" if rows else "-"
            print(
                f"      {entry.get('lifecycle')}: {rows} rows,"
                f" {day} seen in the last day ({share}), {week} in 7d, {month} in 30d"
            )
            print(f"         oldest {entry.get('oldest')}, newest {entry.get('newest')}")

    counts = payload.get("counts") or {}
    print(
        f"   reads from database: {payload.get('active')}"
        f" | schemaReady: {storage.get('schemaReady')}"
        f" | scraped: {counts.get('SCRAPED')} resolved: {counts.get('RESOLVED')}"
    )
    print(
        f"   lastIngestAt: {payload.get('lastIngestAt')}"
        f" | jsonImportedAt: {payload.get('jsonImportedAt')}"
    )
    error = payload.get("lastMigrationError")
    if error:
        print(f"   !! lastMigrationError: {error}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
