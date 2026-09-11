#!/usr/bin/env python3
"""How the active catalogue is spread over time, and what a resolution horizon would cost.

Read-only: public GETs, no secrets, no writes.

Two questions, both asked before changing anything.

1. The proposal is to stop retaining markets whose resolution is more than N hours away, so
   the catalogue's capacity holds imminent markets instead of far-dated ones. That only buys
   candidates if the capacity cap is actually BINDING. If the catalogue now sits under the
   cap -- and narrowing the scan to sport and esport may well have put it there -- then
   dropping far-dated rows adds no near-dated ones. It just makes the set smaller, and
   starves whatever portfolio was configured to trade a longer horizon.

   So: the distribution of hours-to-resolution, how many rows each candidate horizon keeps,
   and what each portfolio's own resolution filter is, since a horizon shorter than a
   portfolio's window silently empties it.

2. Whether `video-games` can be dropped without taking esports with it. The esports
   portfolios are the ones in use, so if their markets carry `video-games` alongside
   `esports`, excluding the tag starves exactly what it is meant to leave alone.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import urllib.request
from collections import Counter

HOST = os.environ.get("TRADING_HOST", "https://osobnizkusenosti.cz/trading").rstrip("/")
PAGE_LIMIT = 1200
MAX_PAGES = 24
HORIZONS = [6, 12, 24, 36, 48, 72, 120, 168]

TAG_FIELDS = [
    "polymarketTags", "tags", "firstPolymarketTags",
    "firstTags", "polymarketCategories", "firstPolymarketCategories",
]
CATEGORY_FIELDS = ["riskCategory", "category", "firstCategory"]
UNKNOWN = {"general", ""}


def slugify(value) -> str:
    return str(value).strip().lower().replace(" ", "-") if value is not None else ""


def row_tags(row: dict) -> set[str]:
    slugs: set[str] = set()
    for field in TAG_FIELDS:
        value = row.get(field)
        if isinstance(value, list):
            for entry in value:
                if isinstance(entry, dict):
                    slugs.add(slugify(entry.get("slug") or entry.get("label") or entry.get("name")))
                else:
                    slugs.add(slugify(entry))
        elif isinstance(value, str):
            slugs.add(slugify(value))
    for field in CATEGORY_FIELDS:
        if isinstance(row.get(field), str):
            slugs.add(slugify(row[field]))
    return slugs - UNKNOWN


def get(path: str) -> dict:
    request = urllib.request.Request(f"{HOST}/{path}", headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def hours_to_end(row: dict, now: dt.datetime) -> float | None:
    for field in ("endDate", "endDateIso", "end_date", "endAt"):
        raw = row.get(field)
        if not raw:
            continue
        text = str(raw).strip().replace("Z", "+00:00")
        try:
            parsed = dt.datetime.fromisoformat(text)
        except ValueError:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return (parsed - now).total_seconds() / 3600.0
    return None


def main() -> int:
    now = dt.datetime.now(dt.timezone.utc)
    rows: list[dict] = []
    seen: set[str] = set()
    for page in range(MAX_PAGES):
        payload = get(f"api.php?action=state&target=paper&summary=scraped&offset={page * PAGE_LIMIT}")
        batch = payload.get("marketObservations")
        if not isinstance(batch, list) or not batch:
            break
        for row in batch:
            if not isinstance(row, dict):
                continue
            key = str(row.get("tokenId") or row.get("id") or row.get("marketKey") or "")
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            rows.append(row)
        if payload.get("scrapedScopeTruncated") is not True:
            break

    total = len(rows)
    print(f"== retained active catalogue: {total} rows")
    # The cap is 8000. Whether it BINDS is the whole question behind a horizon: under the
    # cap, dropping far-dated rows frees capacity nothing is waiting to use.
    print(f"   capacity cap 8000 -> {'BINDING, eviction is happening' if total >= 7900 else 'NOT binding, there is free capacity'}")

    undated = [row for row in rows if hours_to_end(row, now) is None]
    past = [row for row in rows if (hours_to_end(row, now) or 0) < 0 and hours_to_end(row, now) is not None]
    print(f"   rows with no readable end date: {len(undated)}")
    print(f"   rows already past their end date: {len(past)}")

    print("\n== how many rows a horizon would KEEP (of the dated, still-future rows)")
    dated = [h for row in rows if (h := hours_to_end(row, now)) is not None and h >= 0]
    print(f"   dated and still ahead: {len(dated)}")
    for horizon in HORIZONS:
        kept = sum(1 for h in dated if h <= horizon)
        share = f"{round(100 * kept / len(dated))}%" if dated else "-"
        print(f"   within {horizon:>4}h ({horizon / 24:>4.1f}d): {kept:>6}  ({share:>4} of dated)")

    # What the portfolios are actually configured to trade. A horizon below a portfolio's own
    # window empties it, which is slow to notice and easy to blame on the market.
    try:
        config = get("data/portfolio-config.json")
    except Exception as error:  # noqa: BLE001
        config = {}
        print(f"\n   (portfolio config unavailable: {error})")

    windows: list[tuple[str, float]] = []

    def collect(name: str, entry: dict) -> None:
        for field in ("maxResolutionHours", "maxResolutionDays", "resolutionHours"):
            if field in entry and entry[field] not in (None, ""):
                try:
                    value = float(entry[field])
                except (TypeError, ValueError):
                    continue
                windows.append((name, value * 24 if "Days" in field else value))
                return

    if isinstance(config, dict):
        for key, value in config.items():
            if isinstance(value, dict):
                collect(key, value)
                for inner_key, inner in value.items():
                    if isinstance(inner, dict):
                        collect(f"{key}.{inner_key}", inner)

    print(f"\n== each portfolio's own resolution window ({len(windows)} found)")
    for name, hours in sorted(windows, key=lambda pair: pair[1]):
        kept = sum(1 for h in dated if h <= hours)
        print(f"   {hours:>7.1f}h ({hours / 24:>4.1f}d)  {name:<36} sees {kept} dated rows today")
    if windows:
        shortest = min(hours for _, hours in windows)
        longest = max(hours for _, hours in windows)
        print(f"   shortest window {shortest:.1f}h, longest {longest:.1f}h")
        print("   -> a retention horizon below the LONGEST window silently empties that portfolio")

    print("\n== video-games, and whether dropping it would take esports with it")
    vg = [row for row in rows if "video-games" in row_tags(row)]
    vg_only = [row for row in vg if not ({"esports", "sports"} & row_tags(row))]
    print(f"   rows tagged video-games: {len(vg)}")
    print(f"   of those, NOT also sports or esports: {len(vg_only)}")
    print(f"   of those, also esports: {sum(1 for row in vg if 'esports' in row_tags(row))}")
    print(f"   of those, also sports : {sum(1 for row in vg if 'sports' in row_tags(row))}")
    companions = Counter()
    for row in vg:
        companions.update(row_tags(row) - {"video-games"})
    print("   what video-games rows are tagged with alongside it:")
    for slug, count in companions.most_common(15):
        print(f"      {count:>5}  {slug}")
    if vg and len(vg_only) == len(vg):
        print("   -> video-games never overlaps sport or esport here: dropping it is safe")
    elif vg:
        print(f"   -> dropping video-games would also remove {len(vg) - len(vg_only)} sport/esport rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
