from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from agent_m.config import config
from agent_m.content_plan import ContentPlan, get_available, get_by_slug, get_plan
from agent_m.gemini.client import generate_text

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
        raw = await generate_text(prompt, temperature=0.9, max_tokens=1024)
        start = raw.find("{")
        end = raw.rfind("}") + 1
        if start == -1 or end == 0:
            raise RuntimeError(f"Failed to parse topic response: {raw[:200]}")
        data = json.loads(raw[start:end])
        return Topic(
            title=data["title"],
            angle=data["angle"],
            tags=data.get("tags", ["Bitcoin", "DCA", "Investing"])[:3],
            slug=f"generated-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M')}",
        )


_FALLBACK_PROMPT = """You are a Bitcoin DCA content strategist for {site_name}.
Generate 1 unique, high-value blog topic about Bitcoin Dollar-Cost Averaging.

Previously covered topics to AVOID:
{previous_titles}

Requirements:
- Must be genuinely useful and educational
- Should naturally allow references to a Bitcoin DCA automation tool
- Timely and relevant to current market conditions

Respond ONLY with a JSON object:
{{"title": "...", "angle": "...", "tags": ["tag1", "tag2", "tag3"]}}"""
