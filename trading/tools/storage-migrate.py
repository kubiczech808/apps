#!/usr/bin/env python3
"""Drive the JSON to MySQL migration, and the switch that follows it.

The API exposes the migration as phases rather than as one call, because importing seventy
thousand observations in a single request times out on this hosting. The observation phases
page: each call reports what it processed and whether it is done, and the caller keeps asking
until it is. That loop lives here rather than in a shell script so a stalled phase is caught
by its own offset rather than by a human watching a log.

Every write is an upsert keyed by content, so re-running a phase is not destructive -- which
matters, because a timeout mid-phase has to be recoverable by simply running it again.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any

TIMEOUT_SECONDS = 300
# The trading system runs 24/7, so there is no quiet window to wait for: the import has to
# share the host with live execution rather than take it over. Three settings do that, and
# all three are deliberately conservative.
#
#   PAGE_LIMIT      how much work one request asks the host to do. 750 returned HTTP 504 --
#                   the gateway gave up while the request was still running, which is the
#                   worst shape of failure because the rows may or may not have landed.
#   PAUSE_SECONDS   the gap BETWEEN requests. This is what actually leaves room for the
#                   executor: without it the import is a continuous stream of PHP processes
#                   on a shared host, and the live run waiting behind them is the cost.
#   BUDGET_MINUTES  when to stop and hand the machine back. The import resumes exactly where
#                   it stopped, so a long import becomes several short ones instead of one
#                   session that holds the host for an hour.
PAGE_LIMIT = int(os.environ.get("MIGRATE_PAGE_LIMIT") or 100)
PAUSE_SECONDS = float(os.environ.get("MIGRATE_PAUSE_SECONDS") or 2.0)
BUDGET_MINUTES = float(os.environ.get("MIGRATE_BUDGET_MINUTES") or 35)
MIN_PAGE_LIMIT = 25
# Above this, one request is holding the host long enough to be worth slowing down for.
SLOW_REQUEST_SECONDS = 15.0
MAX_PAGES = 4000


def post(url: str, key: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Trading-Trigger-Key": key,
            "User-Agent": "trading-storage-migrate/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {error.code}: {body[:400]}") from error
    parsed = json.loads(body)
    if not isinstance(parsed, dict) or parsed.get("ok") is not True:
        raise RuntimeError(f"the API refused the operation: {body[:400]}")
    return parsed


def run_phase(url: str, key: str, phase: str, deadline: float, start_offset: int = 0,
              size_guard=None) -> int | None:
    """One migration phase, paged to completion when it pages.

    Returns None when the phase finished, or the offset to resume from when the time budget
    ran out. Stopping on a boundary and reporting where is what makes a 24/7 import possible:
    nothing is half-written, because every page is a complete upsert.
    """
    offset = start_offset
    limit = PAGE_LIMIT
    pause = PAUSE_SECONDS
    for page in range(MAX_PAGES):
        if time.monotonic() > deadline:
            print(f"   {phase}: time budget reached at offset {offset}, handing the host back")
            return offset
        # Checked on a cadence rather than every page: the status endpoint is a round trip of
        # its own, and asking it as often as we write would double the load this is trying to
        # keep down.
        if page and page % 20 == 0 and size_guard is not None and not size_guard():
            print(f"   {phase}: growth cap reached at offset {offset}, stopping")
            return offset
        started = time.monotonic()
        try:
            result = post(url, key, {
                "operation": "migrate-json-batch",
                "phase": phase,
                "offset": offset,
                "limit": limit,
            }).get("result", {})
        except (RuntimeError, urllib.error.URLError, OSError) as error:
            # A gateway timeout, a reset connection or a dropped socket all mean the same
            # thing: the page was too big for this hosting right now, not that the migration
            # cannot run. The second attempt died on "[Errno 104] Connection reset by peer",
            # which is not an HTTPError at all -- catching only 504 left it uncovered.
            #
            # Halving and retrying the SAME offset is safe because every write is an upsert
            # keyed by content, so whatever did land is simply written again.
            text = str(error)
            transient = isinstance(error, (urllib.error.URLError, OSError)) \
                or "504" in text or "502" in text or "timed out" in text.lower()
            if not transient:
                raise
            if limit <= MIN_PAGE_LIMIT:
                raise RuntimeError(f"{phase} timed out even at {limit} rows per call: {error}") from error
            limit = max(MIN_PAGE_LIMIT, limit // 2)
            print(f"   {phase}: gateway timeout at offset {offset}, retrying with {limit} rows per call")
            time.sleep(5)
            continue
        # The non-paging phases (documents, events, finalize) answer once and carry no
        # offset. Treating a missing "done" as finished is what keeps them from looping.
        if "done" not in result:
            print(f"   {phase}: {json.dumps(result)}")
            return
        processed = int(result.get("processed") or 0)
        imported = int(result.get("imported") or 0)
        print(f"   {phase}: offset {offset} processed {processed} imported {imported}")
        # "done" means this call returned fewer rows than it asked for. With a limit that
        # may have been halved, that is still the right test -- it is the server saying the
        # source ran out, not a statement about the original page size.
        if result.get("done") is True:
            return
        next_offset = int(result.get("nextOffset") or (offset + processed))
        if next_offset <= offset:
            raise RuntimeError(f"{phase} stopped advancing at offset {offset}; refusing to loop")
        offset = next_offset
        # Adaptive: a request that took a long time means the host is busy, and the right
        # response is to ask for less and wait longer rather than to keep the same cadence
        # and hope. It never speeds back up on its own -- a shared host that struggled once
        # will struggle again, and the import has nowhere to be.
        elapsed = time.monotonic() - started
        if elapsed > SLOW_REQUEST_SECONDS:
            pause = min(pause * 2, 30.0)
            limit = max(MIN_PAGE_LIMIT, limit // 2)
            print(f"   {phase}: that call took {elapsed:.0f}s -- easing to {limit} rows every {pause:.0f}s")
        time.sleep(pause)
    raise RuntimeError(f"{phase} did not finish within {MAX_PAGES} pages")


def trading_size_bytes(status_url: str) -> int | None:
    """How big the trading tables are right now, read from the public status endpoint."""
    try:
        with urllib.request.urlopen(status_url, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
        return int(payload.get("storage", {}).get("tradingSizeBytes") or 0) or None
    except Exception:
        return None


def slim_events(url: str, key: str) -> int:
    """Rewrite the run-log events that were stored fat, in batches, until there are none left.

    Paced exactly like the import, and for the same reason: it runs against the host that
    live execution depends on, and the system never stops.
    """
    status_url = os.environ.get("STATUS_URL", "").strip()
    before = trading_size_bytes(status_url) if status_url else None
    print(f"== slimming stored run-log events (trading tables at "
          f"{'unknown' if before is None else str(round(before / 1048576)) + ' MB'})")
    cursor = os.environ.get("SLIM_CURSOR", "")
    deadline = time.monotonic() + BUDGET_MINUTES * 60
    scanned = rewritten = saved = 0
    for batch in range(10000):
        if time.monotonic() > deadline:
            print(f"\n== paused at cursor {cursor}")
            print(f"Resume by dispatching slim-events again with SLIM_CURSOR={cursor}.")
            break
        result = post(url, key, {"operation": "slim-events", "cursor": cursor, "limit": PAGE_LIMIT}).get("result", {})
        scanned += int(result.get("scanned") or 0)
        rewritten += int(result.get("rewritten") or 0)
        saved += int(result.get("bytesBefore") or 0) - int(result.get("bytesAfter") or 0)
        cursor = str(result.get("cursor") or cursor)
        if batch % 10 == 0 or result.get("done"):
            print(f"   scanned {scanned}, rewritten {rewritten}, saved {saved / 1048576:.0f} MB")
        if result.get("done"):
            print("   no rows left to slim")
            break
        time.sleep(PAUSE_SECONDS)
    after = trading_size_bytes(status_url) if status_url else None
    print(f"\nscanned {scanned}, rewritten {rewritten}, payload saved {saved / 1048576:.0f} MB")
    if before is not None and after is not None:
        print(f"trading tables {round(before / 1048576)} MB -> {round(after / 1048576)} MB")
    print("MySQL does not hand the freed pages back on its own -- dispatch rebuild-table on"
          " trading_event_log to reclaim them on disk.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--operation",
        default="migrate",
        choices=["migrate", "activate", "deactivate", "status", "slim-events"],
    )
    args = parser.parse_args()

    url = os.environ.get("STORAGE_URL", "").strip()
    key = os.environ.get("TRADING_TRIGGER_KEY", "").strip()
    if not url or not key:
        print("STORAGE_URL and TRADING_TRIGGER_KEY are required", file=sys.stderr)
        return 1

    if args.operation in {"activate", "deactivate", "status"}:
        result = post(url, key, {"operation": args.operation})
        print(json.dumps(result, indent=2))
        return 0

    if args.operation == "slim-events":
        return slim_events(url, key)

    phases = ["documents", "scraped", "resolved", "events", "finalize"]
    resume_phase = os.environ.get("MIGRATE_PHASE", "").strip()
    start_offset = int(os.environ.get("MIGRATE_START_OFFSET") or 0)
    if resume_phase:
        if resume_phase not in phases:
            print(f"Unknown phase {resume_phase}", file=sys.stderr)
            return 1
        phases = phases[phases.index(resume_phase):]

    deadline = time.monotonic() + BUDGET_MINUTES * 60
    # The hard limit, and the reason it exists: the whole MySQL instance has a 2000 MB quota
    # and is already at 1785 MB. An import that fills the last 215 MB does not just fail --
    # it takes down every site on the hosting, including the api.php the live exit worker
    # polls every second. So the growth is measured, not trusted.
    status_url = os.environ.get("STATUS_URL", "").strip()
    growth_cap = float(os.environ.get("MIGRATE_GROWTH_CAP_MB") or 100) * 1048576
    size_at_start = trading_size_bytes(status_url) if status_url else None
    if size_at_start is None:
        print("!! could not read the current storage size, so the growth cap cannot be enforced")
        return 1
    print(f"== migrating the JSON state into MySQL")
    print(f"   trading tables at {round(size_at_start / 1048576)} MB,"
          f" stopping if they grow by more than {round(growth_cap / 1048576)} MB")
    print(f"   {PAGE_LIMIT} rows per call, {PAUSE_SECONDS:.0f}s between calls,"
          f" stopping after {BUDGET_MINUTES:.0f} minutes")
    # Documents first: the activation gate checks for state:paper, and the observation
    # phases read the same files, so a failure here stops the run before it spends an hour
    # importing rows that could not be switched to anyway.
    for index, phase in enumerate(phases):
        print(f" -> {phase}")
        def within_cap() -> bool:
            now = trading_size_bytes(status_url)
            if now is None:
                # An unreadable size is not permission to keep going: the cap is the only
                # thing standing between this import and a full disk.
                print("   !! storage size could not be read; stopping rather than guessing")
                return False
            grown = now - size_at_start
            if grown > growth_cap:
                print(f"   !! trading tables have grown {round(grown / 1048576)} MB"
                      f" (cap {round(growth_cap / 1048576)} MB)")
                return False
            return True

        stopped_at = run_phase(url, key, phase, deadline, start_offset if index == 0 else 0, within_cap)
        if stopped_at is None and not within_cap():
            print("\n== stopped on the growth cap")
            print(f"Resume with phase={phase} once space has been freed.")
            return 0
        if stopped_at is not None:
            print("\n== paused, not failed")
            print(f"Resume with phase={phase} and start_offset={stopped_at}.")
            print("Nothing is half-written: every page is a complete upsert, and the rows"
                  " already imported are simply written again if you re-run from earlier.")
            return 0

    status = post(url, key, {"operation": "status"})
    print("\n== after the migration")
    print(json.dumps(status, indent=2))
    # Said plainly rather than left to be read out of the JSON: the import is only useful
    # once the finalize phase has stamped it, and activation refuses without it.
    if not status.get("jsonImportedAt"):
        print("\n!! the import did not stamp json-imported-at, so activation will be refused")
        return 1
    print("\nThe import is complete. Reads still come from the JSON files until this workflow"
          " is dispatched again with operation=activate and confirm=ACTIVATE.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
