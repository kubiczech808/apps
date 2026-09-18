#!/usr/bin/env python3
"""Decides whether a table rebuild has room to run, before it starts.

OPTIMIZE TABLE builds the table again beside the old one and swaps at the end, so while it
runs both exist. The space it needs is the size of the NEW copy, and that number is already
measured: trading_storage_row_density() adds up what the columns hold and divides by the fill
factor InnoDB builds at.

Why this matters more than it looks. The hosting quota is shared -- this schema is one
database among several, and the reported figure is 1,844 MB of 2,000 MB used, so the room a
rebuild may take is about 156 MB, not the 1,219 MB the schema's own size suggests. A rebuild
that runs out of space is rolled back by InnoDB and the table survives, but on the way there
it fills the quota, and every other database on the account is writing at the same time. That
is the outage worth avoiding, and it is avoidable by arithmetic before anything starts.

So this refuses rather than attempts. A refusal costs a dispatch; a full disk at one in the
morning costs whatever was writing at the time.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

MEGABYTE = 1048576

# Left over after the new copy is written. InnoDB needs scratch beyond the table itself -- the
# online log that collects concurrent writes during the rebuild, and the undo it may roll back
# through -- and the quota is shared with databases this process cannot see or measure.
DEFAULT_MARGIN_MB = 60.0


def decide(
    table: str,
    density: dict,
    used_mb: float,
    quota_mb: float,
    margin_mb: float = DEFAULT_MARGIN_MB,
) -> dict:
    """Whether `table` can be rebuilt right now, and the arithmetic behind the answer."""
    tables = {row.get("table"): row for row in (density.get("tables") or [])}
    row = tables.get(table)
    if row is None:
        return {
            "ok": False,
            # Naming what WAS measured beats "not found": the caller then knows whether the
            # measurement failed or the table name is wrong.
            "reason": f"{table} was not measured; the density report covers {sorted(tables)}",
            "needsMb": None,
            "headroomMb": None,
        }

    # The clustered index AND the secondary indexes: a rebuild writes them all again. The
    # first version of this guard used estimatedRebuiltBytes alone and would have sized
    # trading_trades' copy at 28 MB when it actually landed at 42 MB -- an under-estimate, and
    # under-estimating is the direction that fills a shared quota.
    needs_mb = (
        float(row.get("estimatedRebuiltBytes") or 0) + float(row.get("indexBytes") or 0)
    ) / MEGABYTE
    headroom_mb = float(quota_mb) - float(used_mb)
    returns_mb = float(row.get("estimatedReclaimBytes") or 0) / MEGABYTE

    if needs_mb <= 0:
        return {
            "ok": False,
            "reason": f"{table} measured as needing no space at all, which cannot be right",
            "needsMb": needs_mb,
            "headroomMb": headroom_mb,
        }

    spare_mb = headroom_mb - needs_mb
    if spare_mb < margin_mb:
        return {
            "ok": False,
            "reason": (
                f"{table} needs about {needs_mb:,.0f} MB for its second copy and only"
                f" {headroom_mb:,.0f} MB is free on the hosting"
                f" ({used_mb:,.0f} of {quota_mb:,.0f} MB used)."
                f" That leaves {spare_mb:,.0f} MB, under the {margin_mb:,.0f} MB margin."
                " Rows have to come out of the table before it can be repacked."
            ),
            "needsMb": needs_mb,
            "headroomMb": headroom_mb,
            "returnsMb": returns_mb,
        }

    return {
        "ok": True,
        "reason": (
            f"{table} needs about {needs_mb:,.0f} MB while {headroom_mb:,.0f} MB is free,"
            f" leaving {spare_mb:,.0f} MB spare. It should return about {returns_mb:,.0f} MB."
        ),
        "needsMb": needs_mb,
        "headroomMb": headroom_mb,
        "returnsMb": returns_mb,
    }


def _admin(url: str, key: str, operation: str, timeout: int = 90, **params) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps({"operation": operation, **params}).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "X-Trading-Trigger-Key": key},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {error.code}: {body[:400]}") from error
    if not payload.get("ok"):
        raise RuntimeError(str(payload.get("error") or f"{operation} failed")[:400])
    return payload


def main() -> int:
    table = os.environ["TABLE"]
    url = os.environ.get("STORAGE_URL", "https://www.osobnizkusenosti.cz/trading/api.php?action=storage-admin")
    key = os.environ["TRADING_TRIGGER_KEY"]
    used_mb = float(os.environ.get("HOSTING_USED_MB") or 0)
    quota_mb = float(os.environ.get("HOSTING_QUOTA_MB") or 0)
    margin_mb = float(os.environ.get("HOSTING_MARGIN_MB") or DEFAULT_MARGIN_MB)

    density = _admin(url, key, "row-density")["density"]
    verdict = decide(table, density, used_mb, quota_mb, margin_mb)
    print(verdict["reason"])
    if not verdict["ok"]:
        print(f"::error title=Rebuild refused::{verdict['reason'][:300]}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
