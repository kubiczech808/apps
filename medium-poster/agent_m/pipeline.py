from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from agent_m.config import config
from agent_m.gemini.imager import generate_header_image
from agent_m.gemini.researcher import Topic, TopicResearcher
from agent_m.gemini.writer import Article, write_article_from_plan
from agent_m.history import History
from agent_m.images.uploader import upload_to_imgur
from agent_m.publishers.github_pages import GitHubPagesPublisher
from agent_m.publishers.rss_feed import generate_feed

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


async def run_pipeline(mode: str = "public", slug: str | None = None) -> PipelineResult:
    async with _lock:
        return await _run(mode, slug)


async def _run(mode: str, slug: str | None = None) -> PipelineResult:
    history = History(config.data_dir)
    researcher = TopicResearcher(config.data_dir)

    if slug:
        topic = await researcher.get_topic_by_slug(slug)
        if not topic:
            raise ValueError(f"Unknown topic slug: {slug}")
    else:
        previous_titles = await history.get_all_titles()
        used_slugs = await history.get_used_slugs()
        topic = await researcher.get_next_topic(previous_titles, used_slugs)

    log.info("Selected topic: %s [%s]", topic.title, topic.slug)

    if topic.plan:
        article = await write_article_from_plan(topic.plan)
    else:
        from agent_m.content_plan import ContentPlan
        fallback_plan = ContentPlan(
            slug=topic.slug,
            title_hint=topic.title,
            pillar="general",
            funnel_stage="awareness",
            seo_keyword=topic.title.lower(),
            tags=topic.tags,
            angle=topic.angle,
            key_points=[topic.angle],
            cta_target="DCA calculator",
        )
        article = await write_article_from_plan(fallback_plan)

    log.info("Generated article: %s (%d chars)", article.title, len(article.body))

    image_bytes: bytes | None = None
    image_url: str | None = None
    try:
        image_bytes = await generate_header_image(topic)
        if mode != "preview" and config.imgur_client_id:
            image_url = await upload_to_imgur(image_bytes)
            log.info("Uploaded image: %s", image_url)
        elif mode != "preview":
            log.info("Imgur not configured, skipping image upload")
    except Exception:
        log.warning("Image generation/upload failed, continuing without image", exc_info=True)

    post_url: str | None = None

    if mode != "preview":
        post_url = await _publish_to_rss(history, topic, article, image_url)

        if config.medium_token:
            medium_url = await _publish_to_medium(article, image_url, mode)
            if medium_url:
                post_url = medium_url

    from agent_m.gemini.client import get_tracker
    today = await get_tracker().get_today()

    entry = History.make_entry(
        title=article.title,
        medium_url=post_url,
        mode=mode,
        tags=article.tags,
        tokens_used=today.get("total", 0),
        slug=topic.slug,
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


async def _publish_to_rss(
    history: History,
    topic: Topic,
    article: Article,
    image_url: str | None,
) -> str | None:
    try:
        entries = await history.load()
        feed_articles = [
            {
                "title": e.title,
                "slug": e.slug,
                "published_at": e.published_at,
                "tags": e.tags,
                "body": "",
            }
            for e in entries[-20:]
        ]
        feed_articles.append({
            "title": article.title,
            "slug": topic.slug,
            "published_at": History.make_entry(
                title="", medium_url=None, mode="", tags=[], slug=""
            ).published_at,
            "tags": article.tags,
            "body": article.body,
        })

        article_html = _assemble_html(article.title, article.body, image_url)
        feed_xml = generate_feed(feed_articles)

        gh = GitHubPagesPublisher()
        try:
            pages_url = await gh.publish_article_and_feed(
                slug=topic.slug,
                article_html=article_html,
                feed_xml=feed_xml,
            )
            log.info("Published to GitHub Pages: %s", pages_url)
            return pages_url
        finally:
            await gh.close()
    except Exception:
        log.warning("GitHub Pages publish failed", exc_info=True)
        return None


async def _publish_to_medium(
    article: Article,
    image_url: str | None,
    mode: str,
) -> str | None:
    try:
        from agent_m.medium.publisher import MediumClient
        content = _assemble_markdown(article.title, article.body, image_url)
        medium = MediumClient()
        try:
            result = await medium.create_post(
                title=article.title,
                content_markdown=content,
                tags=article.tags,
                publish_status=mode,
            )
            url = result.get("data", {}).get("url")
            log.info("Published to Medium: %s", url)
            return url
        finally:
            await medium.close()
    except Exception:
        log.warning("Medium publish failed (token may be invalid)", exc_info=True)
        return None


def _assemble_markdown(title: str, body: str, image_url: str | None) -> str:
    parts = [f"# {title}", ""]
    if image_url:
        parts.append(f"![{title}]({image_url})")
        parts.append("")
    parts.append(body)
    return "\n".join(parts)


def _assemble_html(title: str, body: str, image_url: str | None) -> str:
    from agent_m.publishers.rss_feed import _markdown_to_basic_html

    img_tag = ""
    if image_url:
        img_tag = f'<img src="{image_url}" alt="{title}" style="max-width:100%"/>'

    body_html = _markdown_to_basic_html(body)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>{title}</title>
<link rel="canonical" href="{config.site_url}"/>
</head>
<body>
<article>
<h1>{title}</h1>
{img_tag}
{body_html}
</article>
</body>
</html>"""
