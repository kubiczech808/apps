#!/usr/bin/env python3
"""What is actually in the published state files, segment by segment.

Read-only: public GETs of the published JSON. No writes, nothing is touched.

Measured first: every paper portfolio's trade history now begins within three seconds of
2026-09-12T08:54:03Z, and one portfolio still carries five trades from mid-July. That is not
trading, it is a reset -- so the question is what still holds the trades from before it.

The published state is segmented: a core file plus one file per portfolio holding that
portfolio's trades and run log. A writer only overwrites the segments it produced, so a
segment that was dropped from the manifest can still be sitting on the host with its
history intact. This prints, for the core and for every segment the manifest declares:
how many trades it holds and the oldest and newest one in it.

A segment whose oldest trade predates 2026-09-12T08:54Z is a surviving copy of the history.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

DATA = os.environ.get("TRADING_DATA_URL", "https://osobnizkusenosti.cz/trading/data").rstrip("/")
CORE = os.environ.get("TRADING_CORE_STATE", f"{DATA}/paper-state.json")
# Everything before this is history from before the reset.
CUTOFF = os.environ.get("RESET_CUTOFF", "2026-09-12T08:54")


def get(url: str):
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read()
        return json.loads(raw.decode("utf-8") or "{}"), len(raw), None
    except urllib.error.HTTPError as error:
        return None, 0, f"HTTP {error.code}"
    except Exception as error:  # noqa: BLE001
        return None, 0, str(error)


def trade_rows(document):
    """Every trade in a document, wherever this shape happens to keep them."""
    found = []
    portfolios = document.get("paperPortfolios")
    if isinstance(portfolios, dict):
        for key, row in portfolios.items():
            if isinstance(row, dict) and isinstance(row.get("trades"), list):
                found.extend((key, trade) for trade in row["trades"])
    if isinstance(document.get("trades"), list):
        found.extend(("(core)", trade) for trade in document["trades"])
    return found


def describe(label: str, document, size: int):
    rows = trade_rows(document)
    if not rows:
        print(f"   {label:<44} {size/1024:8.0f} KB  trades=0")
        return 0
    opened = sorted(str(trade.get("openedAt") or "") for _, trade in rows)
    before = sum(1 for stamp in opened if stamp and stamp < CUTOFF)
    flag = "  <-- HISTORY FROM BEFORE THE RESET" if before else ""
    print(f"   {label:<44} {size/1024:8.0f} KB  trades={len(rows):<5}"
          f" oldest={opened[0][:19] or '?':<19} newest={opened[-1][:19] or '?':<19} before-cutoff={before}{flag}")
    return before


core, size, error = get(f"{CORE}?t=probe")
if error:
    print(f"core state FAILED: {error}")
    raise SystemExit(1)

manifest = core.get("stateSegments")
manifest = manifest if isinstance(manifest, dict) else {}
print(f"== core {CORE}")
print(f"   generatedAt={json.dumps(core.get('generatedAt'))}  bytes={size}"
      f"  portfolios={len(core.get('paperPortfolios') or {})}  declaredSegments={len(manifest)}")
print("")
print(f"   {'segment':<44} {'size':>11}  contents")
surviving = describe("(core file itself)", core, size)

for name in sorted(manifest):
    entry = manifest[name]
    file = (entry or {}).get("file") if isinstance(entry, dict) else None
    if not file:
        print(f"   {name:<44} (no file named in the manifest)")
        continue
    segment, segment_size, segment_error = get(f"{DATA}/{file}?t=probe")
    if segment_error:
        print(f"   {name:<44} {'':>11}  FAILED: {segment_error}  ({file})")
        continue
    surviving += describe(f"{name}  [{file}]", segment, segment_size)

print("")
if surviving:
    print(f"{surviving} trade(s) from before {CUTOFF} are still in the published files.")
else:
    print(f"No trade from before {CUTOFF} survives in any file the manifest declares.")
    print("If a history is to be recovered it has to come from somewhere else: the database")
    print("mirror, or a segment file the manifest no longer names.")
