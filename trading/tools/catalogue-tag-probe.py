#!/usr/bin/env python3
"""What tags the retained active catalogue actually carries.

Read-only: public GETs, no secrets, no writes.

Asked before narrowing the scan to sports and esports and deleting everything else from the
active catalogue. The deletion is wanted and deliberate; the risk is narrowing on the wrong
key. The portfolios in use are named leagueoflegends, counterstrike2 and esports2, so if
those markets are tagged only with their game and not with `esports`, a two-slug filter
starves exactly the portfolios it is meant to serve -- and the symptom would be positions
quietly ceasing to open, which is slow to notice and slow to attribute.

So: every tag slug in the catalogue with a count, and what a candidate filter would keep.
A market carries several tags, so the shares do not add up to the total.
"""
from __future__ import annotations

import json
import os
import urllib.request
from collections import Counter

HOST = os.environ.get("TRADING_HOST", "https://osobnizkusenosti.cz/trading").rstrip("/")
PAGE_LIMIT = 1200
MAX_PAGES = 24

# The same six fields every reader in the codebase consults. A row whose tags live in the
# one field a reader forgot is the bug this list exists to prevent -- it has happened, and
# it made portfolios refuse the very markets the server had selected for them.
TAG_FIELDS = [
    "polymarketTags", "tags", "firstPolymarketTags",
    "firstTags", "polymarketCategories", "firstPolymarketCategories",
]
CATEGORY_FIELDS = ["riskCategory", "category", "firstCategory"]

KEEP = {slug.strip().lower() for slug in (
    os.environ.get("KEEP_TAG_SLUGS") or "sports,esports"
).split(",") if slug.strip()}


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
    slugs.discard("")
    return slugs


def get(query: str) -> dict:
    request = urllib.request.Request(f"{HOST}/api.php?{query}", headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def main() -> int:
    rows: list[dict] = []
    seen: set[str] = set()
    for page in range(MAX_PAGES):
        payload = get(f"action=state&target=paper&summary=scraped&offset={page * PAGE_LIMIT}")
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

    print(f"== retained active catalogue: {len(rows)} rows")
    counts = Counter()
    untagged = 0
    for row in rows:
        tags = row_tags(row)
        if not tags:
            untagged += 1
        counts.update(tags)

    print(f"   rows carrying no tag at all: {untagged}")
    print(f"\n== every tag slug, most common first (a market carries several)")
    for slug, count in counts.most_common(60):
        print(f"   {count:>6}  {slug}")
    if len(counts) > 60:
        print(f"   ... and {len(counts) - 60} more slugs")

    keep = [row for row in rows if row_tags(row) & KEEP]
    print(f"\n== a filter on {sorted(KEEP)}")
    print(f"   keeps {len(keep)} of {len(rows)}, deletes {len(rows) - len(keep)}")

    # The question the whole probe exists for. If a game slug carries markets that the
    # two-slug filter would NOT keep, the filter has to include that slug as well.
    print("\n== esports markets that a two-slug filter would miss")
    for game in ("league-of-legends", "leagueoflegends", "counter-strike", "counterstrike",
                 "cs2", "valorant", "dota", "dota-2", "video-games", "csgo", "call-of-duty",
                 "rocket-league", "overwatch", "starcraft"):
        tagged = [row for row in rows if game in row_tags(row)]
        if not tagged:
            continue
        missed = [row for row in tagged if not (row_tags(row) & KEEP)]
        verdict = "ALL COVERED" if not missed else f"{len(missed)} WOULD BE DELETED"
        print(f"   {game}: {len(tagged)} row(s), {verdict}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
