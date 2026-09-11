#!/usr/bin/env python3
"""Which portfolios change behaviour now that exclusions apply alongside a whitelist.

Read-only: one public GET, no secrets, no writes.

Until now a populated `includeOnlyMarketTags` discarded `excludedMarketTags` entirely. So a
portfolio could carry an exclusion that never did anything, and nobody would have seen a
symptom -- the setting simply sat there. Making the two combine is what lets a portfolio ask
for sport WITHOUT tennis, which is the point; but it also means any exclusion that was inert
starts biting the moment it ships.

The portfolios that matter are the ones holding BOTH lists. For those this prints what was
being ignored, so a narrowing is something to expect rather than something to discover later
from a portfolio that quietly stopped opening positions.
"""
from __future__ import annotations

import json
import os
import urllib.request

HOST = os.environ.get("TRADING_HOST", "https://osobnizkusenosti.cz/trading").rstrip("/")


def get(path: str) -> dict:
    request = urllib.request.Request(f"{HOST}/{path}", headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def tag_list(value) -> list[str]:
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, list):
        return []
    return [str(tag).strip().lower() for tag in value if str(tag).strip()]


def main() -> int:
    try:
        config = get("data/portfolio-config.json")
    except Exception as error:  # noqa: BLE001 - a probe must not fail the step
        print(f"could not read portfolio-config.json: {error}")
        return 0

    # The file holds per-portfolio configs plus mode-keyed ones (live, 5050). Anything that
    # is a dict and carries either tag list is a policy worth reporting.
    entries: list[tuple[str, dict]] = []
    for key, value in (config.items() if isinstance(config, dict) else []):
        if isinstance(value, dict):
            if "includeOnlyMarketTags" in value or "excludedMarketTags" in value:
                entries.append((key, value))
            for inner_key, inner in value.items():
                if isinstance(inner, dict) and (
                    "includeOnlyMarketTags" in inner or "excludedMarketTags" in inner
                ):
                    entries.append((f"{key}.{inner_key}", inner))

    print(f"== portfolios carrying a tag policy: {len(entries)}")
    changed = 0
    for name, entry in sorted(entries):
        include = tag_list(entry.get("includeOnlyMarketTags"))
        exclude = tag_list(entry.get("excludedMarketTags"))
        if not include and not exclude:
            continue
        both = bool(include and exclude)
        if both:
            changed += 1
        marker = "CHANGES" if both else "unchanged"
        print(f"   [{marker:>9}] {name}")
        print(f"                include only: {', '.join(include) if include else '(none)'}")
        print(f"                excluded    : {', '.join(exclude) if exclude else '(none)'}")
        if both:
            print("                -> these exclusions were being ignored and now apply")

    print()
    if changed:
        print(f"== {changed} portfolio(s) will narrow. Everything else keeps the behaviour it had.")
    else:
        print("== no portfolio holds both lists, so nothing narrows: the change only adds a capability.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
