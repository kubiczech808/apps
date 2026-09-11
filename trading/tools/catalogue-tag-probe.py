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

    # The question the whole probe exists for, asked of the data rather than of a list of
    # games I thought to write down. Guessing which slugs to check is how honor-of-kings and
    # rainbow-six-siege were missed on the first pass: every tag that appears ONLY on rows
    # the filter drops is a thing that stops being scraped, so all of them are named.
    dropped = [row for row in rows if not (row_tags(row) & KEEP)]
    dropped_counts = Counter()
    for row in dropped:
        dropped_counts.update(row_tags(row))
    print(f"\n== what the {len(dropped)} deleted rows are tagged with")
    for slug, count in dropped_counts.most_common(40):
        total = counts[slug]
        share = f"{round(100 * count / total)}%" if total else "-"
        print(f"   {count:>5} of {total:>5} ({share:>4}) {slug}")
    if len(dropped_counts) > 40:
        print(f"   ... and {len(dropped_counts) - 40} more slugs")

    # A slug that loses EVERY one of its rows disappears from the catalogue entirely. If one
    # of those is a sport or an esport, the filter is wrong and this is where it shows.
    vanishing = sorted(slug for slug, count in dropped_counts.items() if count == counts[slug])
    print(f"\n== slugs that would vanish completely: {len(vanishing)}")
    for slug in vanishing[:60]:
        print(f"   {counts[slug]:>5}  {slug}")
    if len(vanishing) > 60:
        print(f"   ... and {len(vanishing) - 60} more")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
