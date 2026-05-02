from __future__ import annotations

import json
from dataclasses import dataclass

from agent_m.config import config
from agent_m.gemini.client import generate_text
from agent_m.gemini.researcher import Topic


@dataclass
class Article:
    title: str
    body: str
    tags: list[str]


_WRITER_PROMPT = """You are an expert Bitcoin and personal finance writer for {site_name}.

Write a comprehensive, SEO-optimized blog article in English.

Topic: {title}
Angle: {angle}

Requirements:
- Compelling introduction that hooks the reader
- Approximately 1500 words
- Markdown formatting with ## subheadings (NOT # — that's reserved for the title)
- 4-6 subheadings for readability
- Naturally mention {site_name} and its Bitcoin DCA calculator 2-3 times (woven into practical advice, not forced)
- Include a call-to-action near the end encouraging readers to try the DCA calculator at {site_url}
- SEO: use the primary keyword in the first paragraph, in at least 2 subheadings, and in the conclusion
- Tone: authoritative but approachable, data-informed, not financial advice
- End with a brief conclusion

Do NOT include the title as a heading.
Do NOT include image placeholders.

Respond ONLY with a JSON object:
{{"title": "SEO-friendly title, max 100 chars", "body": "full article in markdown", "tags": ["tag1", "tag2", "tag3"]}}"""


async def write_article(topic: Topic) -> Article:
    prompt = _WRITER_PROMPT.format(
        site_name=config.site_name,
        site_url=config.site_url,
        title=topic.title,
        angle=topic.angle,
    )
    raw = await generate_text(prompt, temperature=0.7, max_tokens=8192)

    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start == -1 or end == 0:
        raise RuntimeError(f"Failed to parse writer response: {raw[:200]}")

    data = json.loads(raw[start:end])
    title = data["title"][:100]
    body = data["body"]
    tags = [t[:25] for t in data.get("tags", topic.tags)[:3]]

    if config.site_url not in body and config.site_name not in body:
        body += (
            f"\n\n---\n\n*Calculate your own Bitcoin DCA returns at "
            f"[{config.site_name}]({config.site_url}).*"
        )

    return Article(title=title, body=body, tags=tags)
