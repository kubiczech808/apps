from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

from agent_m.config import config
from agent_m.gemini.imager import generate_header_image
from agent_m.gemini.researcher import Topic, TopicResearcher
from agent_m.gemini.writer import Article, write_article_from_plan
from agent_m.history import History
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
    published_to: list[str] = field(default_factory=list)


_lock = asyncio.Lock()


async def run_pipeline(mode: str = "public", slug: str | None = None) -> PipelineResult:
    async with _lock:
        return await _run(mode, slug)


async def _run(mode: str, slug: str | None = None) -> PipelineResult:
    missing = []
    if not config.gemini_api_key:
        missing.append("GEMINI_API_KEY")
    if not config.telegram_bot_token:
        missing.append("TELEGRAM_BOT_TOKEN")
    if not config.telegram_admin_chat_id:
        missing.append("TELEGRAM_ADMIN_CHAT_ID")
    if missing:
        raise RuntimeError(f"Missing required config: {', '.join(missing)}")

    from agent_m.gemini.client import validate_api_key
    await validate_api_key()

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

    # Image generation + upload
    image_bytes: bytes | None = None
    image_url: str | None = None
    try:
        image_bytes = await generate_header_image(topic)
        if mode != "preview" and config.imgur_client_id:
            from agent_m.images.uploader import upload_to_imgur
            image_url = await upload_to_imgur(image_bytes)
            log.info("Uploaded image: %s", image_url)
    except Exception:
        log.warning("Image generation/upload failed, continuing without image", exc_info=True)

    published_to: list[str] = []
    post_url: str | None = None

    if mode == "preview":
        pass  # no publishing
    else:
        is_draft = mode == "draft"

        # 1. GitHub Pages (RSS feed)
        rss_url = await _publish_rss(history, topic, article, image_url)
        if rss_url:
            published_to.append("GitHub Pages")
            post_url = rss_url

        # 2. Dev.to
        if config.devto_api_key:
            devto_url = await _publish_devto(article, is_draft)
            if devto_url:
                published_to.append("Dev.to")
                post_url = devto_url

        # 3. Hashnode
        if config.hashnode_token and config.hashnode_publication_id:
            hn_url = await _publish_hashnode(article)
            if hn_url:
                published_to.append("Hashnode")
                post_url = hn_url

        # 4. Medium (Playwright)
        if config.medium_playwright:
            medium_url = await _publish_medium_playwright(article, not is_draft)
            if medium_url:
                published_to.append("Medium")
                post_url = medium_url

        # 5. Medium (API — legacy, if token exists)
        if config.medium_token and not config.medium_playwright:
            medium_url = await _publish_medium_api(article, image_url, mode)
            if medium_url:
                published_to.append("Medium API")
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
        published_to=published_to,
    )


async def _publish_rss(history, topic, article, image_url) -> str | None:
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
            return await gh.publish_article_and_feed(
                slug=topic.slug,
                article_html=article_html,
                feed_xml=feed_xml,
            )
        finally:
            await gh.close()
    except Exception:
        log.warning("GitHub Pages publish failed", exc_info=True)
        return None


async def _publish_devto(article: Article, draft: bool) -> str | None:
    try:
        from agent_m.publishers.devto import DevToPublisher
        pub = DevToPublisher()
        try:
            result = await pub.publish(
                title=article.title,
                body_markdown=article.body,
                tags=article.tags,
                published=not draft,
                canonical_url=config.site_url,
            )
            return result.get("url")
        finally:
            await pub.close()
    except Exception:
        log.warning("Dev.to publish failed", exc_info=True)
        return None


async def _publish_hashnode(article: Article) -> str | None:
    try:
        from agent_m.publishers.hashnode import HashnodePublisher
        pub = HashnodePublisher()
        try:
            result = await pub.publish(
                title=article.title,
                body_markdown=article.body,
                tags=article.tags,
            )
            return result.get("url")
        finally:
            await pub.close()
    except Exception:
        log.warning("Hashnode publish failed", exc_info=True)
        return None


async def _publish_medium_playwright(article: Article, publish: bool) -> str | None:
    try:
        from agent_m.publishers.medium_playwright import MediumPlaywrightPublisher
        pub = MediumPlaywrightPublisher()
        return await pub.publish(
            title=article.title,
            body_markdown=article.body,
            tags=article.tags,
            publish=publish,
        )
    except Exception:
        log.warning("Medium Playwright publish failed", exc_info=True)
        return None


async def _publish_medium_api(article, image_url, mode) -> str | None:
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
            return result.get("data", {}).get("url")
        finally:
            await medium.close()
    except Exception:
        log.warning("Medium API publish failed", exc_info=True)
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
