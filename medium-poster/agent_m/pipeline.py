from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from agent_m.config import config
from agent_m.gemini.imager import generate_header_image
from agent_m.gemini.researcher import Topic, TopicResearcher
from agent_m.gemini.writer import Article, write_article
from agent_m.history import History
from agent_m.images.uploader import upload_to_imgur
from agent_m.medium.publisher import MediumClient

log = logging.getLogger(__name__)


@dataclass
class PipelineResult:
    topic: Topic
    article: Article
    image_bytes: bytes | None
    image_url: str | None
    post_url: str | None
    mode: str
    tokens_used: int


_lock = asyncio.Lock()


async def run_pipeline(mode: str = "public") -> PipelineResult:
    async with _lock:
        return await _run(mode)


async def _run(mode: str) -> PipelineResult:
    history = History(config.data_dir)
    researcher = TopicResearcher(config.data_dir)

    previous_titles = await history.get_all_titles()
    topic = await researcher.get_next_topic(previous_titles)
    log.info("Selected topic: %s", topic.title)

    article = await write_article(topic)
    log.info("Generated article: %s (%d chars)", article.title, len(article.body))

    image_bytes: bytes | None = None
    image_url: str | None = None
    try:
        image_bytes = await generate_header_image(topic)
        if mode != "preview":
            image_url = await upload_to_imgur(image_bytes)
            log.info("Uploaded image: %s", image_url)
    except Exception:
        log.warning("Image generation/upload failed, continuing without image", exc_info=True)

    post_url: str | None = None
    if mode != "preview":
        content = _assemble_content(article.title, article.body, image_url)
        medium = MediumClient()
        try:
            result = await medium.create_post(
                title=article.title,
                content_markdown=content,
                tags=article.tags,
                publish_status=mode,
            )
            post_url = result.get("data", {}).get("url")
            log.info("Published to Medium: %s", post_url)
        finally:
            await medium.close()

    from agent_m.gemini.client import get_tracker
    today = await get_tracker().get_today()

    entry = History.make_entry(
        title=article.title,
        medium_url=post_url,
        mode=mode,
        tags=article.tags,
        tokens_used=today.get("total", 0),
    )
    await history.add(entry)

    return PipelineResult(
        topic=topic,
        article=article,
        image_bytes=image_bytes,
        image_url=image_url,
        post_url=post_url,
        mode=mode,
        tokens_used=today.get("total", 0),
    )


def _assemble_content(title: str, body: str, image_url: str | None) -> str:
    parts = [f"# {title}", ""]
    if image_url:
        parts.append(f"![{title}]({image_url})")
        parts.append("")
    parts.append(body)
    return "\n".join(parts)
