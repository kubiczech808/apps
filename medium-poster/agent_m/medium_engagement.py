from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from agent_m.config import config
from agent_m.content_plan import get_available
from agent_m.gemini.client import generate_text
from agent_m.history import History
from agent_m.publishers.medium_playwright import MediumPlaywrightPublisher

log = logging.getLogger(__name__)

_STATE_FILE = config.data_dir / "medium_engagement.json"
_OWN_MEDIUM_MARKERS = ("/@info_89535/", "medium.com/@info_89535")
_DEFAULT_QUERIES = [
    "bitcoin dca",
    "dollar cost averaging bitcoin",
    "bitcoin recurring buys",
    "bitcoin accumulation strategy",
    "bitcoin self custody dca",
]


@dataclass(frozen=True)
class EngagementOpportunity:
    title: str
    url: str
    query: str
    score: int
    reason: str
    comment: str


async def run_once(limit: int = 3, query: str | None = None) -> dict:
    """Find related Medium articles and draft useful comments for review.

    This intentionally does not post comments. Medium engagement needs to stay
    selective and human-approved; automatic posting is too easy to turn into
    platform spam.
    """
    state = _read_state(_STATE_FILE)
    seen = set(state.setdefault("seen_urls", []))

    queries = [query] if query else await _build_queries()
    publisher = MediumPlaywrightPublisher()

    raw_candidates: list[dict] = []
    for q in queries[:5]:
        try:
            raw_candidates.extend(await publisher.search_articles(q, limit=8))
        except Exception as exc:
            log.warning("Medium engagement search failed for %r: %s", q, exc)

    candidates = _rank_candidates(raw_candidates, seen)
    opportunities: list[EngagementOpportunity] = []

    for candidate in candidates[: max(limit * 2, limit)]:
        if len(opportunities) >= limit:
            break
        try:
            comment = await _draft_comment(candidate)
        except Exception as exc:
            log.warning("Medium engagement comment draft failed for %s: %s", candidate.get("url"), exc)
            continue
        opportunities.append(
            EngagementOpportunity(
                title=candidate["title"],
                url=candidate["url"],
                query=candidate["query"],
                score=candidate["score"],
                reason=candidate["reason"],
                comment=comment,
            )
        )
        seen.add(candidate["url"])

    state["seen_urls"] = sorted(seen)[-500:]
    state["last_run_at"] = datetime.now(timezone.utc).isoformat()
    _write_state(_STATE_FILE, state)

    return {
        "status": "ok" if opportunities else "nothing_found",
        "queries": queries,
        "candidates_found": len(raw_candidates),
        "opportunities": [op.__dict__ for op in opportunities],
    }


def format_result(result: dict) -> str:
    if result.get("status") != "ok":
        queries = ", ".join(result.get("queries") or [])
        return (
            "Medium engagement scout: no suitable opportunities found.\n"
            f"Queries: {queries}\n"
            f"Candidates checked: {result.get('candidates_found', 0)}"
        )

    lines = [
        "Medium engagement scout: prepared comment drafts",
        "Review manually before posting. No comments were published.",
    ]
    for idx, item in enumerate(result.get("opportunities", []), 1):
        lines.extend(
            [
                "",
                f"{idx}. {item.get('title')}",
                f"Score: {item.get('score')} | Query: {item.get('query')}",
                f"Reason: {item.get('reason')}",
                f"URL: {item.get('url')}",
                "Comment:",
                item.get("comment") or "",
            ]
        )
    return "\n".join(lines)[:4096]


async def _build_queries() -> list[str]:
    history = History(config.data_dir)
    used_slugs = await history.get_used_slugs()
    recent = await history.get_recent(5)
    available = get_available(used_slugs)

    queries = []
    for entry in reversed(recent):
        queries.append(_query_from_title(entry.title))
        for tag in entry.tags[:2]:
            queries.append(f"bitcoin {tag.lower()} dca")

    for plan in available[:5]:
        queries.append(plan.seo_keyword)

    queries.extend(_DEFAULT_QUERIES)
    return _dedupe([q for q in queries if len(q.split()) >= 2])[:6]


def _rank_candidates(items: list[dict], seen: set[str]) -> list[dict]:
    ranked = []
    seen_this_run = set()
    for item in items:
        url = _clean_url(item.get("url") or item.get("href") or "")
        title = _clean_text(item.get("title") or "")
        snippet = _clean_text(item.get("snippet") or item.get("text") or "")
        query = _clean_text(item.get("query") or "")
        if not url or not title:
            continue
        if url in seen or url in seen_this_run:
            continue
        if any(marker in url for marker in _OWN_MEDIUM_MARKERS):
            continue
        if "/me/" in url or "/m/signin" in url or "/p/" in url and "/edit" in url:
            continue

        score, reason = _score_candidate(title, snippet, query)
        if score < 45:
            continue

        seen_this_run.add(url)
        ranked.append(
            {
                "title": title,
                "url": url,
                "snippet": snippet[:900],
                "query": query,
                "score": score,
                "reason": reason,
            }
        )

    return sorted(ranked, key=lambda x: x["score"], reverse=True)


def _score_candidate(title: str, snippet: str, query: str) -> tuple[int, str]:
    haystack = f"{title} {snippet}".lower()
    score = 0
    reasons = []

    weighted_terms = {
        "bitcoin": 18,
        "dca": 25,
        "dollar cost averaging": 28,
        "recurring": 10,
        "automation": 12,
        "self custody": 12,
        "wallet": 8,
        "exchange": 8,
        "fees": 8,
        "halving": 8,
    }
    for term, points in weighted_terms.items():
        if term in haystack:
            score += points
            reasons.append(term)

    query_terms = [t for t in re.split(r"\W+", query.lower()) if len(t) > 3]
    overlap = sum(1 for term in set(query_terms) if term in haystack)
    score += min(25, overlap * 6)

    if "crypto" in haystack and "bitcoin" not in haystack:
        score -= 12
    if any(bad in haystack for bad in ("airdrop", "meme coin", "casino", "100x")):
        score -= 20

    return score, ", ".join(reasons[:5]) or "query overlap"


async def _draft_comment(candidate: dict) -> str:
    prompt = f"""You are drafting ONE Medium comment for the btc-dca.com author account.

Article title:
{candidate['title']}

Article snippet:
{candidate.get('snippet') or 'No snippet available.'}

Why it matched:
{candidate.get('reason')}

Write a thoughtful comment that could be posted under this article.

Rules:
- 55-95 words.
- Sound like a real practitioner, not a marketer.
- Add one concrete idea, question, or small nuance related to Bitcoin DCA.
- Do not flatter generically ("great article", "thanks for sharing").
- Do not mention AI, automation bots, or that this was generated.
- Do not include a link unless the article clearly asks for tools or calculators.
- If you include a link, include at most one natural btc-dca.com link.
- No hashtags, no emojis, no sales CTA.
- Plain text only.
"""
    for attempt in range(2):
        text = await generate_text(prompt, temperature=0.65, max_tokens=260)
        comment = _clean_comment(text)
        if _valid_comment(comment):
            return comment
        log.warning(
            "Medium engagement draft rejected for %s on attempt %d: %r",
            candidate.get("url"),
            attempt + 1,
            comment[:160],
        )
    return _fallback_comment(candidate)


def _clean_comment(text: str) -> str:
    text = _clean_text(text)
    text = re.sub(r"^comment:\s*", "", text, flags=re.IGNORECASE)
    text = text.strip("\"'` ")
    words = text.split()
    if len(words) > 110:
        text = " ".join(words[:110]).rstrip(".,;:") + "."
    return text


def _valid_comment(comment: str) -> bool:
    words = comment.split()
    if len(words) < 45 or len(words) > 110:
        return False
    if not comment.endswith((".", "?", "!")):
        return False
    lowered = comment.lower()
    generic_openers = (
        "great article",
        "great post",
        "thanks for sharing",
        "nice article",
    )
    if lowered.startswith(generic_openers):
        return False
    if lowered.count("http://") + lowered.count("https://") > 1:
        return False
    return True


def _fallback_comment(candidate: dict) -> str:
    title = candidate.get("title") or "this"
    if "timing" in title.lower() or "signal" in (candidate.get("snippet") or "").lower():
        return (
            "One thing I would pressure-test is whether the strategy still works after fees, "
            "spreads, taxes, and missed execution days. For most Bitcoin DCA plans, the hard "
            "part is not the backtest but staying consistent when the signal disagrees with "
            "your emotions. I would be curious how the results change if withdrawals to "
            "self-custody and real exchange spread costs are included."
        )
    return (
        "The nuance I keep coming back to is that Bitcoin DCA is less about finding the perfect "
        "entry and more about reducing the number of emotional decisions you have to make. The "
        "best rule is usually the one you can keep following during boring sideways markets and "
        "ugly drawdowns. I would be curious how you think about fees and withdrawal timing in "
        "that process."
    )


def _query_from_title(title: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9 ]+", " ", title).lower()
    stop = {
        "with", "from", "that", "this", "what", "when", "your", "into",
        "after", "still", "king", "actually", "keeps", "coming", "back",
    }
    terms = [t for t in cleaned.split() if len(t) > 3 and t not in stop]
    if "bitcoin" not in terms:
        terms.insert(0, "bitcoin")
    if "dca" not in terms:
        terms.append("dca")
    return " ".join(terms[:5])


def _clean_url(url: str) -> str:
    if not url:
        return ""
    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return ""
    return urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/"), "", ""))


def _clean_text(text: str) -> str:
    return " ".join(str(text).replace("\xa0", " ").split())


def _dedupe(items: list[str]) -> list[str]:
    out = []
    seen = set()
    for item in items:
        key = item.lower().strip()
        if key and key not in seen:
            seen.add(key)
            out.append(item.strip())
    return out


def _read_state(path: Path) -> dict:
    if not path.exists():
        return {"seen_urls": []}
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        backup = path.with_suffix(".json.bak")
        path.rename(backup)
        return {"seen_urls": []}


def _write_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def main() -> None:
    logging.basicConfig(
        level=config.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    result = asyncio.run(run_once())
    print("MEDIUM_ENGAGEMENT_START")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print("MEDIUM_ENGAGEMENT_END")


if __name__ == "__main__":
    main()
