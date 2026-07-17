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
_DEFAULT_DAILY_PROPOSALS = 1
_MIN_RESPONSES = 3
_MIN_FOLLOWERS = 500
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
    responses: int
    followers: int
    language: str


async def run_once(limit: int = 3, query: str | None = None) -> dict:
    """Find related Medium articles and draft useful comments for review.

    This intentionally does not post comments. Medium engagement needs to stay
    selective and human-approved; automatic posting is too easy to turn into
    platform spam.
    """
    state = _read_state(_STATE_FILE)
    seen = set(state.setdefault("seen_urls", []))
    blocked_articles = _used_article_urls(state)
    blocked_profiles = _blocked_profiles(state) | _used_profiles_this_week(state)

    queries = [query] if query else await _build_queries()
    publisher = MediumPlaywrightPublisher()

    raw_candidates: list[dict] = []
    for q in queries[:5]:
        try:
            raw_candidates.extend(await publisher.search_articles(q, limit=12))
        except Exception as exc:
            log.warning("Medium engagement search failed for %r: %s", q, exc)

    # A searched-but-rejected article is not permanently disqualified. Its
    # response count, language hints, or author follower count can change, and
    # a narrow query may otherwise get stuck with zero inspected candidates.
    # Only pending/posted articles and this week's used profiles are hard
    # blocks.
    candidates, prefilter_rejected = _rank_candidates(raw_candidates, blocked_articles, blocked_profiles)
    if not candidates and prefilter_rejected:
        candidates = _prefilter_fallback_candidates(prefilter_rejected, limit=max(limit * 6, 8))
    opportunities: list[EngagementOpportunity] = []
    fallback_candidates: list[dict] = []
    rejected: list[dict] = prefilter_rejected[:10] if not candidates else []
    inspected = 0

    for candidate in candidates[: max(limit * 8, 12)]:
        if len(opportunities) >= limit:
            break
        inspected += 1
        try:
            details = await publisher.inspect_article_engagement(candidate["url"])
        except Exception as exc:
            log.warning("Medium engagement article inspection failed for %s: %s", candidate.get("url"), exc)
            rejected.append({"url": candidate.get("url"), "reason": f"inspection failed: {exc}"})
            seen.add(candidate["url"])
            continue

        candidate["responses"] = int(details.get("responses") or 0)
        candidate["followers"] = int(details.get("followers") or 0)
        candidate["language"] = details.get("lang") or "unknown"
        candidate["author_profile_url"] = details.get("authorProfileUrl") or candidate.get("profile")

        eligible, reason = _eligible_article(candidate, details)
        candidate["eligibility_reason"] = reason
        if not eligible:
            fallback_ok, fallback_reason = _fallback_article(candidate, details)
            if fallback_ok:
                fallback = dict(candidate)
                fallback["fallback_reason"] = fallback_reason
                fallback_candidates.append(fallback)
            rejected.append({
                "url": candidate.get("url"),
                "title": candidate.get("title"),
                "reason": reason,
            })
            seen.add(candidate["url"])
            continue

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
                responses=candidate["responses"],
                followers=candidate["followers"],
                language=candidate["language"],
            )
        )
        seen.add(candidate["url"])

    if not opportunities and fallback_candidates:
        fallback_candidates.sort(
            key=lambda item: (
                int(item.get("followers") or 0),
                int(item.get("responses") or 0),
                int(item.get("score") or 0),
            ),
            reverse=True,
        )
        for candidate in fallback_candidates[: max(limit * 3, 3)]:
            if len(opportunities) >= limit:
                break
            candidate["reason"] = (
                f"{candidate.get('reason')}; fallback: no inspected article had "
                f"{_MIN_RESPONSES}+ responses, selected highest follower count"
            )
            try:
                comment = await _draft_comment(candidate)
            except Exception as exc:
                log.warning("Medium engagement fallback comment draft failed for %s: %s", candidate.get("url"), exc)
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
                    responses=candidate["responses"],
                    followers=candidate["followers"],
                    language=candidate["language"],
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
        "candidates_inspected": inspected,
        "rejected": rejected[:10],
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
            "candidates_inspected": result.get("candidates_inspected", 0),
            "rejected": result.get("rejected") or [],
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
    profile = _normalize_profile(op.get("profile") or _profile_from_url(op.get("url") or ""))
    if profile:
        blocked = state.setdefault("blocked_profiles", {})
        blocked[profile] = {
            "blocked_at": datetime.now(timezone.utc).isoformat(),
            "reason": "telegram_skip",
            "title": op.get("title"),
            "url": op.get("url"),
            "opportunity_id": op_id,
        }
    op["status"] = "skipped"
    op["updated_at"] = datetime.now(timezone.utc).isoformat()
    _write_state(_STATE_FILE, state)
    return {"status": "skipped", "id": op_id, "title": op.get("title"), "profile": profile}


def get_daily_proposal_count() -> int:
    state = _read_state(_STATE_FILE)
    settings = state.setdefault("settings", {})
    return _clamp_daily_proposals(settings.get("daily_proposals", _DEFAULT_DAILY_PROPOSALS))


def is_auto_post_enabled() -> bool:
    state = _read_state(_STATE_FILE)
    settings = state.setdefault("settings", {})
    return bool(settings.get("auto_post_enabled", False))


def set_auto_post_enabled(enabled: bool) -> dict:
    state = _read_state(_STATE_FILE)
    settings = state.setdefault("settings", {})
    settings["auto_post_enabled"] = bool(enabled)
    settings["auto_post_updated_at"] = datetime.now(timezone.utc).isoformat()
    _write_state(_STATE_FILE, state)
    return {
        "status": "ok",
        "auto_post_enabled": bool(enabled),
        "daily_proposals": _clamp_daily_proposals(settings.get("daily_proposals", _DEFAULT_DAILY_PROPOSALS)),
        "max_daily_posts": _DAILY_LIMIT,
    }


def set_daily_proposal_count(count: int) -> dict:
    count = _clamp_daily_proposals(count)
    state = _read_state(_STATE_FILE)
    settings = state.setdefault("settings", {})
    settings["daily_proposals"] = count
    settings["updated_at"] = datetime.now(timezone.utc).isoformat()
    plans = state.setdefault("plans", {})
    today = datetime.now(_PRAGUE).date().isoformat()
    plans.pop(today, None)
    _write_state(_STATE_FILE, state)
    return {"status": "ok", "daily_proposals": count, "max_daily_posts": _DAILY_LIMIT}


def planned_times_for_today(now: datetime | None = None, count: int | None = None) -> list[datetime]:
    now = now.astimezone(_PRAGUE) if now else datetime.now(_PRAGUE)
    count = get_daily_proposal_count() if count is None else _clamp_daily_proposals(count)
    state = _read_state(_STATE_FILE)
    plans = state.setdefault("plans", {})
    day_key = now.date().isoformat()
    day_plan = plans.get(day_key)
    if not day_plan or int(day_plan.get("count") or 0) != count:
        day_plan = {
            "created_at": datetime.now(timezone.utc).isoformat(),
            "count": count,
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
        lines = [
            "Medium engagement: no suitable article found for this slot.",
            f"Candidates found: {result.get('candidates_found', 0)}",
            f"Candidates inspected: {result.get('candidates_inspected', 0)}",
        ]
        for item in (result.get("rejected") or [])[:3]:
            title = item.get("title") or item.get("url") or "candidate"
            lines.append(f"- {title}: {item.get('reason')}")
        return "\n".join(lines)[:4096]
    op = result["opportunity"]
    return (
        "Medium engagement candidate\n\n"
        f"Title: {op.get('title')}\n"
            f"Profile: {op.get('profile')}\n"
            f"Score: {op.get('score')} | Query: {op.get('query')}\n"
            f"Responses: {op.get('responses')} | Followers: {op.get('followers')} | Language: {op.get('language')}\n"
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
                f"Responses: {item.get('responses')} | Followers: {item.get('followers')} | Language: {item.get('language')}",
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


def _rank_candidates(
    items: list[dict],
    seen: set[str],
    blocked_profiles: set[str] | None = None,
) -> tuple[list[dict], list[dict]]:
    blocked_profiles = blocked_profiles or set()
    ranked = []
    rejected = []
    seen_this_run = set()
    for item in items:
        url = _clean_url(item.get("url") or item.get("href") or "")
        title = _clean_text(item.get("title") or "")
        snippet = _clean_text(item.get("snippet") or item.get("text") or "")
        query = _clean_text(item.get("query") or "")
        if not url or not title:
            rejected.append({"url": url or item.get("url"), "title": title, "reason": "missing url/title"})
            continue
        if url in seen or url in seen_this_run:
            rejected.append({"url": url, "title": title, "reason": "duplicate or already used article"})
            continue
        profile = _profile_from_url(url)
        if profile in blocked_profiles:
            rejected.append({"url": url, "title": title, "reason": f"blocked/recent profile: {profile}"})
            continue
        if any(marker in url for marker in _OWN_MEDIUM_MARKERS):
            rejected.append({"url": url, "title": title, "reason": "own Medium profile"})
            continue
        if "/me/" in url or "/m/signin" in url or "/p/" in url and "/edit" in url:
            rejected.append({"url": url, "title": title, "reason": "non-public Medium URL"})
            continue

        score, reason = _score_candidate(title, snippet, query)
        if score < 45:
            rejected.append({
                "title": title,
                "url": url,
                "profile": profile,
                "snippet": snippet[:900],
                "query": query,
                "score": score,
                "rank_reason": reason,
                "reason": f"low topical score ({score} < 45): {reason}",
                "fallback_inspectable": score >= 18,
            })
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

    return sorted(ranked, key=lambda x: x["score"], reverse=True), rejected


def _prefilter_fallback_candidates(rejected: list[dict], limit: int) -> list[dict]:
    candidates = [
        item for item in rejected
        if item.get("fallback_inspectable") and item.get("url") and item.get("title")
    ]
    candidates.sort(key=lambda item: int(item.get("score") or 0), reverse=True)
    out = []
    seen_urls = set()
    for item in candidates:
        url = _clean_url(item.get("url") or "")
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        out.append(
            {
                "title": item.get("title") or "",
                "url": url,
                "profile": item.get("profile") or _profile_from_url(url),
                "snippet": item.get("snippet") or "",
                "query": item.get("query") or "",
                "score": int(item.get("score") or 0),
                "reason": f"prefilter fallback: {item.get('rank_reason') or item.get('reason') or 'low score'}",
            }
        )
        if len(out) >= limit:
            break
    return out


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


def _eligible_article(candidate: dict, details: dict) -> tuple[bool, str]:
    responses = int(details.get("responses") or 0)
    followers = int(details.get("followers") or 0)
    lang = str(details.get("lang") or "").lower()
    sample = " ".join(
        [
            candidate.get("title") or "",
            candidate.get("snippet") or "",
            details.get("title") or "",
            details.get("textSample") or "",
        ]
    )

    if responses < _MIN_RESPONSES:
        return False, f"too few comments/responses ({responses} < {_MIN_RESPONSES})"
    if followers < _MIN_FOLLOWERS:
        return False, f"too few followers ({followers} < {_MIN_FOLLOWERS})"
    if not _looks_english(lang, sample):
        return False, f"not confidently English (lang={lang or 'unknown'})"
    return True, "eligible"


def _fallback_article(candidate: dict, details: dict) -> tuple[bool, str]:
    followers = int(details.get("followers") or 0)
    lang = str(details.get("lang") or "").lower()
    sample = " ".join(
        [
            candidate.get("title") or "",
            candidate.get("snippet") or "",
            details.get("title") or "",
            details.get("textSample") or "",
        ]
    )

    if followers <= 0:
        return False, "fallback rejected: follower count unavailable"
    if not _looks_english(lang, sample):
        return False, f"fallback rejected: not confidently English (lang={lang or 'unknown'})"
    return True, "fallback eligible by highest known follower count"


def _looks_english(lang: str, text: str) -> bool:
    sample = _clean_text(text).lower()[:2500]
    if not sample:
        return False

    if _looks_french(sample):
        return False
    if lang and not lang.startswith("en"):
        return False

    letters = [ch for ch in sample if ch.isalpha()]
    if not letters:
        return False
    ascii_letters = sum(1 for ch in letters if "a" <= ch <= "z")
    if ascii_letters / max(1, len(letters)) < 0.88:
        return False

    english_markers = {
        "the", "and", "that", "with", "this", "from", "have", "you",
        "bitcoin", "dca", "market", "price", "strategy", "investing",
    }
    words = re.findall(r"[a-z]{3,}", sample)
    if not words:
        return False
    hits = sum(1 for word in words[:300] if word in english_markers)
    return hits >= 5 or ("bitcoin" in words and ("dca" in words or "strategy" in words))


def _looks_french(sample: str) -> bool:
    words = re.findall(r"[a-zàâçéèêëîïôûùüÿñæœ]{2,}", sample.lower())
    if not words:
        return False
    french_markers = {
        "la", "le", "les", "des", "du", "de", "pour", "avec", "dans",
        "une", "est", "pas", "plus", "sur", "par", "vous", "votre",
        "meilleure", "strategie", "stratégie", "acheter", "investissement",
        "recurrent", "récurrent", "ou", "et", "que", "qui",
    }
    french_hits = sum(1 for word in words[:220] if word in french_markers)
    english_markers = {
        "the", "and", "that", "with", "this", "from", "have", "your",
        "market", "price", "strategy", "investing", "stack", "wallet",
    }
    english_hits = sum(1 for word in words[:220] if word in english_markers)
    if french_hits >= 4 and french_hits > english_hits:
        return True
    return bool(re.search(r"\b(la|le|les|du|des)\s+\w+\s+(strategie|stratégie|pour|bitcoin)\b", sample))


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
            profiles.add(_normalize_profile(item.get("profile") or _profile_from_url(item.get("url") or "")))
    for pending_id, item in state.get("pending", {}).items():
        if pending_id == exclude_pending_id:
            continue
        if item.get("status") == "pending":
            created = _parse_dt(item.get("created_at"))
            if _week_key(created) == week:
                profiles.add(_normalize_profile(item.get("profile") or _profile_from_url(item.get("url") or "")))
    return {p for p in profiles if p}


def _blocked_profiles(state: dict) -> set[str]:
    raw = state.get("blocked_profiles") or {}
    if isinstance(raw, dict):
        return {_normalize_profile(key) for key in raw.keys() if _normalize_profile(key)}
    if isinstance(raw, list):
        return {_normalize_profile(str(item)) for item in raw if _normalize_profile(str(item))}
    return set()


def _normalize_profile(profile: str | None) -> str:
    if not profile:
        return ""
    profile = profile.strip().lower()
    if profile.startswith("https://"):
        profile = profile[len("https://"):]
    elif profile.startswith("http://"):
        profile = profile[len("http://"):]
    return profile.rstrip("/")


def _clamp_daily_proposals(count: object) -> int:
    try:
        value = int(count)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        value = _DEFAULT_DAILY_PROPOSALS
    return max(0, min(_DAILY_LIMIT, value))


def _generate_day_times(day: date, count: int) -> list[datetime]:
    # Spread slots between 07:35 and 20:10 Europe/Prague.
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
