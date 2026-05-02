from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from agent_m.config import config
from agent_m.gemini.client import generate_text


@dataclass
class Topic:
    title: str
    angle: str
    tags: list[str]


_RESEARCH_PROMPT = """You are a Bitcoin DCA content strategist for {site_name}.
Generate 7 unique blog topic ideas about Bitcoin Dollar-Cost Averaging (DCA).

Requirements:
- Each topic must be timely and relevant
- Mix of educational, analytical, and practical angles
- Appeal to both beginners and intermediate Bitcoin investors
- Topics should naturally allow references to a Bitcoin DCA calculator/tool
- Each topic: a title (max 80 chars) and a 1-sentence angle description

Previously covered topics to AVOID:
{previous_titles}

Respond ONLY with a JSON array:
[{{"title": "...", "angle": "...", "tags": ["tag1", "tag2", "tag3"]}}]"""


class TopicResearcher:
    def __init__(self, data_dir: Path) -> None:
        self._cache_file = data_dir / "topics_cache.json"

    async def get_next_topic(self, previous_titles: list[str]) -> Topic:
        cache = self._read_cache()
        unused = [t for t in cache.get("topics", []) if not t.get("used")]

        if not unused:
            topics = await self._generate_topics(previous_titles)
            self._write_cache(topics)
            unused = topics
        else:
            unused = [
                {"title": t["title"], "angle": t["angle"], "tags": t["tags"]}
                for t in unused
            ]

        pick = unused[0]
        self._mark_used(pick["title"])
        return Topic(
            title=pick["title"],
            angle=pick["angle"],
            tags=pick["tags"][:3],
        )

    async def get_cached_topics(self) -> list[dict]:
        return self._read_cache().get("topics", [])

    async def _generate_topics(self, previous_titles: list[str]) -> list[dict]:
        titles_text = "\n".join(f"- {t}" for t in previous_titles[-20:]) or "None yet"
        prompt = _RESEARCH_PROMPT.format(
            site_name=config.site_name,
            previous_titles=titles_text,
        )
        raw = await generate_text(prompt, temperature=0.9, max_tokens=2048)
        start = raw.find("[")
        end = raw.rfind("]") + 1
        if start == -1 or end == 0:
            raise RuntimeError(f"Failed to parse topic research response: {raw[:200]}")
        return json.loads(raw[start:end])

    def _mark_used(self, title: str) -> None:
        cache = self._read_cache()
        for t in cache.get("topics", []):
            if t["title"] == title:
                t["used"] = True
                break
        self._cache_file.write_text(json.dumps(cache, indent=2))

    def _read_cache(self) -> dict:
        if not self._cache_file.exists():
            return {}
        try:
            return json.loads(self._cache_file.read_text())
        except json.JSONDecodeError:
            return {}

    def _write_cache(self, topics: list[dict]) -> None:
        for t in topics:
            t["used"] = False
        data = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "topics": topics,
        }
        self._cache_file.write_text(json.dumps(data, indent=2))
