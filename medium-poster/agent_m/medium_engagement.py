from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from zoneinfo import ZoneInfo

from agent_m.config import config
from agent_m.content_plan import get_available
from agent_m.gemini.client import generate_text
from agent_m.history import History
from agent_m.publishers.medium_playwright import MediumPlaywrightPublisher

log = logging.getLogger(__name__)

_STATE_FILE = config.data_dir / "medium_engagement.json"
_OWN_MEDIUM_MARKERS = ("/@info_89535/", "medium.com/@info_89535")
_PRAGUE = ZoneInfo("Europe/Prague")
_DAILY_LIMIT = 10
_DEFAULT_QUERIES = [
    "bitcoin dca",
    "dollar cost averaging bitcoin",
    "bitcoin recurring buys",
    "bitcoin accumulation strategy",
    "bitcoin self custody dca",
]


@dataclass(frozen=True)
class EngagementOpportunity:
    id: str
    title: str
    url: str
    profile: str
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
    blocked_articles = _used_article_urls(state)
    blocked_profiles = _used_profiles_this_week(state)

    queries = [query] if query else await _build_queries()
    publisher = MediumPlaywrightPublisher()

    raw_candidates: list[dict] = []
    for q in queries[:5]:
        try:
            raw_candidates.extend(await publisher.search_articles(q, limit=8))
        except Exception as exc:
            log.warning("Medium engagement search failed for %r: %s", q, exc)

    candidates = _rank_candidates(raw_candidates, seen | blocked_articles, blocked_profiles)
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
                id=str(uuid.uuid4()),
                title=candidate["title"],
                url=candidate["url"],
                profile=candidate["profile"],
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


async def prepare_next_opportunity(query: str | None = None) -> dict:
    state = _read_state(_STATE_FILE)
    today = _today_key()
    if _posted_count_for_day(state, today) >= _DAILY_LIMIT:
        return {
            "status": "limit_reached",
            "day": today,
            "limit": _DAILY_LIMIT,
        }

    result = await run_once(limit=1, query=query)
    opportunities = result.get("opportunities") or []
    if not opportunities:
        return {
            "status": "nothing_found",
            "queries": result.get("queries") or [],
            "candidates_found": result.get("candidates_found", 0),
        }

    state = _read_state(_STATE_FILE)
    pending = state.setdefault("pending", {})
    op = opportunities[0]
    op["status"] = "pending"
    op["created_at"] = datetime.now(timezone.utc).isoformat()
    op["day"] = today
    pending[op["id"]] = op
    _write_state(_STATE_FILE, state)
    return {
        "status": "prepared",
        "opportunity": op,
        "remaining_today": max(0, _DAILY_LIMIT - _posted_count_for_day(state, today)),
    }


async def approve_opportunity(op_id: str) -> dict:
    state = _read_state(_STATE_FILE)
    pending = state.setdefault("pending", {})
    op = pending.get(op_id)
    if not op:
        return {"status": "not_found", "id": op_id}
    if op.get("status") != "pending":
        return {"status": "already_handled", "id": op_id, "current_status": op.get("status")}

    today = _today_key()
    if _posted_count_for_day(state, today) >= _DAILY_LIMIT:
        return {"status": "limit_reached", "day": today, "limit": _DAILY_LIMIT}

    article_url = op.get("url") or ""
    profile = op.get("profile") or _profile_from_url(article_url)
    if article_url in _posted_article_urls(state):
        op["status"] = "blocked_duplicate_article"
        op["updated_at"] = datetime.now(timezone.utc).isoformat()
        _write_state(_STATE_FILE, state)
        return {"status": "blocked_duplicate_article", "url": article_url}
    if profile in _used_profiles_this_week(state, exclude_pending_id=op_id):
        op["status"] = "blocked_weekly_profile"
        op["updated_at"] = datetime.now(timezone.utc).isoformat()
        _write_state(_STATE_FILE, state)
        return {"status": "blocked_weekly_profile", "profile": profile}

    publisher = MediumPlaywrightPublisher()
    result = await publisher.comment_and_clap(article_url, op.get("comment") or "")
    posted_at = datetime.now(timezone.utc).isoformat()
    record = {
        **op,
        "status": "posted",
        "posted_at": posted_at,
        "posted_at_local": datetime.now(_PRAGUE).isoformat(),
        "article_url": article_url,
        "profile": profile,
        "comment_url": result.get("comment_url") or article_url,
        "clapped": bool(result.get("clapped")),
    }

    op.update(record)
    state.setdefault("posted", []).append(record)
    _write_state(_STATE_FILE, state)
    return {"status": "posted", **record}


def skip_opportunity(op_id: str) -> dict:
    state = _read_state(_STATE_FILE)
    op = state.setdefault("pending", {}).get(op_id)
    if not op:
        return {"status": "not_found", "id": op_id}
    if op.get("status") != "pending":
        return {"status": "already_handled", "id": op_id, "current_status": op.get("status")}
    op["status"] = "skipped"
    op["updated_at"] = datetime.now(timezone.utc).isoformat()
    _write_state(_STATE_FILE, state)
    return {"status": "skipped", "id": op_id, "title": op.get("title")}


def planned_times_for_today(now: datetime | None = None, count: int = _DAILY_LIMIT) -> list[datetime]:
    now = now.astimezone(_PRAGUE) if now else datetime.now(_PRAGUE)
    state = _read_state(_STATE_FILE)
    plans = state.setdefault("plans", {})
    day_key = now.date().isoformat()
    day_plan = plans.get(day_key)
    if not day_plan:
        day_plan = {
            "created_at": datetime.now(timezone.utc).isoformat(),
            "times": [dt.isoformat() for dt in _generate_day_times(now.date(), count)],
        }
        plans[day_key] = day_plan
        _write_state(_STATE_FILE, state)
    return [
        datetime.fromisoformat(item).astimezone(_PRAGUE)
        for item in day_plan.get("times", [])
        if datetime.fromisoformat(item).astimezone(_PRAGUE) > now
    ]


def format_opportunity_message(result: dict) -> str:
    if result.get("status") == "limit_reached":
        return f"Medium engagement: daily limit reached ({result.get('limit')})."
    if result.get("status") != "prepared":
        return (
            "Medium engagement: no suitable article found for this slot.\n"
            f"Candidates checked: {result.get('candidates_found', 0)}"
        )
    op = result["opportunity"]
    return (
        "Medium engagement candidate\n\n"
        f"Title: {op.get('title')}\n"
        f"Profile: {op.get('profile')}\n"
        f"Score: {op.get('score')} | Query: {op.get('query')}\n"
        f"URL: {op.get('url')}\n\n"
        "Comment draft:\n"
        f"{op.get('comment')}\n\n"
        "Nothing has been published yet. Approve to post the comment and clap the article."
    )[:4096]


def format_daily_summary(day: date | None = None) -> str:
    state = _read_state(_STATE_FILE)
    day_key = (day or datetime.now(_PRAGUE).date()).isoformat()
    records = [
        item for item in state.get("posted", [])
        if _local_day_key(item.get("posted_at") or item.get("posted_at_local")) == day_key
    ]
    if not records:
        return f"Medium engagement summary {day_key}: no approved comments were posted today."

    lines = [f"Medium engagement summary {day_key}: {len(records)} comment(s) posted"]
    for idx, item in enumerate(records, 1):
        when = _local_time_label(item.get("posted_at") or item.get("posted_at_local"))
        lines.extend(
            [
                "",
                f"{idx}. {when} - {item.get('title')}",
                f"Profile: {item.get('profile')}",
                f"URL: {item.get('article_url') or item.get('url')}",
            ]
        )
    return "\n".join(lines)[:4096]


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


def _rank_candidates(items: list[dict], seen: set[str], blocked_profiles: set[str] | None = None) -> list[dict]:
    blocked_profiles = blocked_profiles or set()
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
        profile = _profile_from_url(url)
        if profile in blocked_profiles:
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
                "profile": profile,
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


def _profile_from_url(url: str) -> str:
    parts = urlsplit(url)
    path_parts = [part for part in parts.path.split("/") if part]
    if path_parts:
        if path_parts[0].startswith("@"):
            return f"{parts.netloc}/{path_parts[0]}".lower()
        return f"{parts.netloc}/{path_parts[0]}".lower()
    return parts.netloc.lower()


def _today_key() -> str:
    return datetime.now(_PRAGUE).date().isoformat()


def _week_key(dt: datetime | None = None) -> str:
    local = (dt or datetime.now(_PRAGUE)).astimezone(_PRAGUE)
    year, week, _ = local.isocalendar()
    return f"{year}-W{week:02d}"


def _posted_count_for_day(state: dict, day_key: str) -> int:
    return sum(
        1 for item in state.get("posted", [])
        if _local_day_key(item.get("posted_at") or item.get("posted_at_local")) == day_key
    )


def _posted_article_urls(state: dict) -> set[str]:
    return {
        _clean_url(item.get("article_url") or item.get("url") or "")
        for item in state.get("posted", [])
        if item.get("article_url") or item.get("url")
    }


def _used_article_urls(state: dict) -> set[str]:
    urls = _posted_article_urls(state)
    for item in state.get("pending", {}).values():
        if item.get("status") in {"pending", "posted"} and item.get("url"):
            urls.add(_clean_url(item["url"]))
    return urls


def _used_profiles_this_week(state: dict, exclude_pending_id: str | None = None) -> set[str]:
    week = _week_key()
    profiles = set()
    for item in state.get("posted", []):
        if _week_key(_parse_dt(item.get("posted_at") or item.get("posted_at_local"))) == week:
            profiles.add(item.get("profile") or _profile_from_url(item.get("url") or ""))
    for pending_id, item in state.get("pending", {}).items():
        if pending_id == exclude_pending_id:
            continue
        if item.get("status") == "pending":
            created = _parse_dt(item.get("created_at"))
            if _week_key(created) == week:
                profiles.add(item.get("profile") or _profile_from_url(item.get("url") or ""))
    return {p for p in profiles if p}


def _generate_day_times(day: date, count: int) -> list[datetime]:
    # Ten spread-out slots between 07:35 and 20:10 Europe/Prague.
    import random

    start_min = 7 * 60 + 35
    end_min = 20 * 60 + 10
    span = end_min - start_min
    rng = random.Random(day.isoformat())
    times = []
    for idx in range(count):
        bucket_start = start_min + int(span * idx / count)
        bucket_end = start_min + int(span * (idx + 1) / count)
        minute = rng.randint(bucket_start + 5, max(bucket_start + 5, bucket_end - 5))
        times.append(datetime.combine(day, time(minute // 60, minute % 60), tzinfo=_PRAGUE))
    return sorted(times)


def _parse_dt(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _local_day_key(value: str | None) -> str:
    return _parse_dt(value).astimezone(_PRAGUE).date().isoformat()


def _local_time_label(value: str | None) -> str:
    return _parse_dt(value).astimezone(_PRAGUE).strftime("%H:%M")


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
