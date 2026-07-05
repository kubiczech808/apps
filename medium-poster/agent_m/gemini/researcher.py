from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from agent_m.config import config
from agent_m.content_plan import ContentPlan, get_available, get_by_slug, get_plan
from agent_m.gemini.client import generate_text
from agent_m.topic_suggestions import get_confirmed_by_slug, get_next_confirmed, to_content_plan

log = logging.getLogger(__name__)


@dataclass
class Topic:
    title: str
    angle: str
    tags: list[str]
    slug: str = ""
    plan: ContentPlan | None = None


class TopicResearcher:
    def __init__(self, data_dir: Path) -> None:
        self._cache_file = data_dir / "topics_cache.json"

    async def get_next_topic(self, previous_titles: list[str], used_slugs: set[str] | None = None) -> Topic:
        if used_slugs is None:
            used_slugs = set()

        suggestion = get_next_confirmed(used_slugs)
        if suggestion:
            pick = to_content_plan(suggestion)
            log.info("Selected confirmed Telegram topic: %s", pick.slug)
            return Topic(
                title=pick.title_hint,
                angle=pick.angle,
                tags=pick.tags,
                slug=pick.slug,
                plan=pick,
            )

        available = get_available(used_slugs)
        if available:
            pick = available[0]
            log.info("Selected from content plan: %s (%s/%s)", pick.slug, pick.pillar, pick.funnel_stage)
            return Topic(
                title=pick.title_hint,
                angle=pick.angle,
                tags=pick.tags,
                slug=pick.slug,
                plan=pick,
            )

        log.info("All curated topics used, generating fresh topics via Gemini")
        return await self._generate_fresh_topic(previous_titles)

    async def get_topic_by_slug(self, slug: str) -> Topic | None:
        plan = get_by_slug(slug)
        if not plan:
            suggestion = get_confirmed_by_slug(slug)
            plan = to_content_plan(suggestion) if suggestion else None
        if not plan:
            return None
        return Topic(
            title=plan.title_hint,
            angle=plan.angle,
            tags=plan.tags,
            slug=plan.slug,
            plan=plan,
        )

    async def get_cached_topics(self) -> list[dict]:
        all_plans = get_plan()
        return [
            {
                "slug": p.slug,
                "title": p.title_hint,
                "pillar": p.pillar,
                "funnel_stage": p.funnel_stage,
                "used": False,
            }
            for p in all_plans
        ]

    async def _generate_fresh_topic(self, previous_titles: list[str]) -> Topic:
        titles_text = "\n".join(f"- {t}" for t in previous_titles[-20:]) or "None yet"
        prompt = _FALLBACK_PROMPT.format(
            site_name=config.site_name,
            previous_titles=titles_text,
        )

        title = angle = ""
        tags: list[str] = []
        raw = ""
        # Gemini occasionally returns an empty body (503 fallback, safety filter).
        # Retry a few times before giving up.
        for attempt in range(3):
            raw = await generate_text(prompt, temperature=0.9, max_tokens=1024)
            if not raw or not raw.strip():
                log.warning("Topic generation attempt %d/3 returned empty, retrying", attempt + 1)
                continue

            title = _extract_field(raw, "title")
            angle = _extract_field(raw, "angle")
            tags_raw = _extract_field(raw, "tags")
            tags = [t.strip().strip("*\"'`") for t in tags_raw.split(",") if t.strip()][:3]

            # Fallback: if structured prefixes are missing, use the first
            # substantial line as the title rather than crashing.
            if not title:
                for line in raw.splitlines():
                    candidate = _strip_markdown(line)
                    if len(candidate) > 20:
                        title = candidate
                        break

            if title:
                break
            log.warning("Topic generation attempt %d/3 unparseable, retrying", attempt + 1)

        if not title:
            raise RuntimeError(f"Failed to parse topic response: {raw[:300]!r}")

        if not angle:
            angle = title

        return Topic(
            title=title,
            angle=angle,
            tags=tags or ["Bitcoin", "DCA", "Investing"],
            slug=f"generated-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M')}",
        )


def _strip_markdown(text: str) -> str:
    """Remove leading bullets/markers and surrounding markdown/quote characters."""
    cleaned = text.strip()
    cleaned = re.sub(r"^[\s>*#\-•\d.]+", "", cleaned)  # leading bullets, numbering, headers
    cleaned = cleaned.strip("*_`\"'“”‘’ ").strip()
    return cleaned


def _extract_field(raw: str, field: str) -> str:
    """Find a labelled field (TITLE/ANGLE/TAGS) regardless of markdown wrapping."""
    pattern = re.compile(rf"{field}\s*[:：]\s*(.+)", re.IGNORECASE)
    for line in raw.splitlines():
        m = pattern.search(line)
        if m:
            return _strip_markdown(m.group(1))
    return ""


_FALLBACK_PROMPT = """You are a Bitcoin DCA content strategist for {site_name}.
Generate 1 unique, high-value blog topic about Bitcoin Dollar-Cost Averaging.

Previously covered topics to AVOID (must be substantially different in angle and content):
{previous_titles}

Requirements:
- Must be genuinely useful and educational
- Must be DIFFERENT from all previously covered topics — not just a rephrasing
- Should naturally allow references to a Bitcoin DCA automation tool
- Timely and relevant to current market conditions

Respond with ONLY these three lines, nothing before or after.
Do NOT use Markdown, asterisks, quotes, bullets, or any intro text.
Plain text only, in EXACTLY this format:
TITLE: <article title>
ANGLE: <1-2 sentence description of the unique angle>
TAGS: <tag1>, <tag2>, <tag3>"""
