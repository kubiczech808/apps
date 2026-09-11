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
# Observations are the bulk of the import. Measured: 750 per call returns HTTP 504 from this
# hosting's gateway -- the request is still running upstream when the gateway gives up, which
# is the worst kind of failure because the rows may or may not have landed. 200 finishes well
# inside the limit, and the retry below halves it again rather than giving up, so a hosting
# that is merely slow today does not need a code change to get through.
PAGE_LIMIT = 200
MIN_PAGE_LIMIT = 25
# A phase that reports done immediately still costs a round trip; this only bounds runaway.
MAX_PAGES = 400


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


def run_phase(url: str, key: str, phase: str) -> None:
    """One migration phase, paged to completion when it pages."""
    offset = 0
    limit = PAGE_LIMIT
    for page in range(MAX_PAGES):
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
        # Gentle on a shared host: the import is a one-off and does not need to race.
        time.sleep(0.5)
    raise RuntimeError(f"{phase} did not finish within {MAX_PAGES} pages")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation", default="migrate", choices=["migrate", "activate", "deactivate", "status"])
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

    print("== migrating the JSON state into MySQL")
    # Documents first: the activation gate checks for state:paper, and the observation
    # phases read the same files, so a failure here stops the run before it spends an hour
    # importing rows that could not be switched to anyway.
    for phase in ["documents", "scraped", "resolved", "events", "finalize"]:
        print(f" -> {phase}")
        run_phase(url, key, phase)

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
