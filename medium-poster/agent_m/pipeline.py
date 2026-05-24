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
    platform_errors: list[str] = field(default_factory=list)
    platform_urls: dict[str, str] = field(default_factory=dict)


_lock = asyncio.Lock()


async def run_pipeline(mode: str = "public", slug: str | None = None) -> PipelineResult:
    async with _lock:
        return await _run(mode, slug)


async def _run(mode: str, slug: str | None = None) -> PipelineResult:
    log.info(
        "Config: hashnode_playwright=%s, medium_playwright=%s, "
        "hashnode_token=%s, medium_token=%s, devto_api_key=%s",
        config.hashnode_playwright,
        config.medium_playwright,
        bool(config.hashnode_token),
        bool(config.medium_token),
        bool(config.devto_api_key),
    )
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
    log.info("[pipeline] Step 1/7: Validating Gemini API key")
    await validate_api_key()

    history = History(config.data_dir)
    researcher = TopicResearcher(config.data_dir)

    log.info("[pipeline] Step 2/7: Selecting topic")
    if slug:
        topic = await researcher.get_topic_by_slug(slug)
        if not topic:
            raise ValueError(f"Unknown topic slug: {slug}")
    else:
        previous_titles = await history.get_all_titles()
        used_slugs = await history.get_used_slugs()
        log.info("[pipeline] Fetching remote article slugs from GitHub Pages")
        remote_slugs = await _get_remote_article_slugs()
        used_slugs |= remote_slugs
        if remote_slugs:
            log.info("Found %d existing GitHub Pages article slugs", len(remote_slugs))
        log.info("[pipeline] Getting next topic (used_slugs=%d)", len(used_slugs))
        topic = await researcher.get_next_topic(previous_titles, used_slugs)

    log.info("[pipeline] Selected topic: %s [%s]", topic.title, topic.slug)

    log.info("[pipeline] Step 3/7: Writing article via Gemini")
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

    log.info("[pipeline] Step 4/7: Article generated: %s (%d chars)", article.title, len(article.body))

    log.info("[pipeline] Step 5/7: Generating header image")
    image_bytes: bytes | None = None
    image_url: str | None = None
    try:
        image_bytes = await generate_header_image(topic)
        if mode != "preview" and image_bytes:
            if config.imgur_client_id:
                from agent_m.images.uploader import upload_to_imgur
                image_url = await upload_to_imgur(image_bytes)
            elif config.github_pat:
                gh = GitHubPagesPublisher()
                try:
                    image_url = await gh.publish_binary_file(
                        path=f"articles/images/{topic.slug}.jpg",
                        data=image_bytes,
                        message=f"Add header image: {topic.slug}",
                    )
                finally:
                    await gh.close()
            if image_url:
                log.info("Uploaded image: %s", image_url)
    except Exception as exc:
        log.warning("Image generation/upload failed, continuing without image: %s", exc)

    published_to: list[str] = []
    platform_errors: list[str] = []
    platform_urls: dict[str, str] = {}
    post_url: str | None = None

    log.info("[pipeline] Step 6/7: Publishing (mode=%s)", mode)
    if mode == "preview":
        pass  # no publishing
    else:
        is_draft = mode == "draft"

        # 1. GitHub Pages (RSS feed)
        rss_url = await _publish_rss(history, topic, article, image_url)
        if rss_url:
            published_to.append("GitHub Pages")
            post_url = rss_url
        else:
            platform_errors.append("GitHub Pages: publish failed")

        # 2. Dev.to
        if config.devto_api_key:
            devto_url, devto_error = await _publish_devto(article, is_draft, rss_url, image_url)
            if devto_url:
                published_to.append("Dev.to")
                platform_urls["Dev.to"] = devto_url
                post_url = devto_url
            elif devto_error:
                platform_errors.append(f"Dev.to: {devto_error}")
        else:
            platform_errors.append("Dev.to: DEVTO_API_KEY missing")

        # 3. Hashnode
        if config.hashnode_playwright:
            hn_url, hn_error = await _publish_hashnode_playwright(article, rss_url, image_url)
            if hn_url:
                published_to.append("Hashnode")
                platform_urls["Hashnode"] = hn_url
                post_url = hn_url
            elif hn_error:
                platform_errors.append(f"Hashnode: {hn_error}")
        elif config.hashnode_token and config.hashnode_publication_id:
            hn_url, hn_error = await _publish_hashnode(article, rss_url, image_url)
            if hn_url:
                published_to.append("Hashnode")
                platform_urls["Hashnode"] = hn_url
                post_url = hn_url
            elif hn_error:
                platform_errors.append(f"Hashnode: {hn_error}")
        else:
            platform_errors.append("Hashnode: not configured (set HASHNODE_PLAYWRIGHT=true or API token)")

        # 4. Medium (Playwright)
        if config.medium_playwright:
            medium_url, medium_error = await _publish_medium_playwright(article, not is_draft)
            if medium_url:
                published_to.append("Medium")
                platform_urls["Medium"] = medium_url
                post_url = medium_url
            elif medium_error:
                platform_errors.append(f"Medium: {medium_error}")

        # 5. Medium (API — integration token)
        if config.medium_token and not config.medium_playwright:
            medium_url = await _publish_medium_api(article, image_url, rss_url, is_draft)
            if medium_url:
                published_to.append("Medium")
                platform_urls["Medium"] = medium_url
                post_url = medium_url

    log.info("[pipeline] Step 7/7: Saving to history (published_to=%s, errors=%s)",
             published_to, platform_errors)
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
        platform_errors=platform_errors,
        platform_urls=platform_urls,
    )


async def _get_remote_article_slugs() -> set[str]:
    if not config.github_pat:
        return set()
    gh = GitHubPagesPublisher()
    try:
        return await gh.list_article_slugs()
    except Exception as exc:
        log.warning("Could not read GitHub Pages article list: %s", exc)
        return set()
    finally:
        await gh.close()


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
    except Exception as exc:
        log.warning("GitHub Pages publish failed: %s", exc)
        return None


async def _publish_devto(
    article: Article, draft: bool, canonical_url: str | None, cover_image: str | None = None,
) -> tuple[str | None, str | None]:
    try:
        from agent_m.publishers.devto import DevToPublisher
        pub = DevToPublisher()
        try:
            result = await pub.publish(
                title=article.title,
                body_markdown=article.body,
                tags=article.tags,
                published=not draft,
                canonical_url=canonical_url,
                main_image=cover_image,
            )
            return result.get("url"), None
        finally:
            await pub.close()
    except Exception as exc:
        log.warning("Dev.to publish failed: %s", exc)
        return None, str(exc)


async def _publish_hashnode_playwright(
    article: Article, canonical_url: str | None, cover_image: str | None = None,
) -> tuple[str | None, str | None]:
    try:
        from agent_m.publishers.hashnode_playwright import HashnodePlaywrightPublisher
        pub = HashnodePlaywrightPublisher()
        result = await pub.publish(
            title=article.title,
            body_markdown=article.body,
            tags=article.tags,
            canonical_url=canonical_url,
            cover_image_url=cover_image,
        )
        return result, None
    except Exception as exc:
        log.warning("Hashnode Playwright publish failed: %s", exc)
        return None, str(exc)


async def _publish_hashnode(
    article: Article, canonical_url: str | None, cover_image: str | None = None,
) -> tuple[str | None, str | None]:
    try:
        from agent_m.publishers.hashnode import HashnodePublisher
        pub = HashnodePublisher()
        try:
            result = await pub.publish(
                title=article.title,
                body_markdown=article.body,
                tags=article.tags,
                canonical_url=canonical_url,
                cover_image_url=cover_image,
            )
            return result.get("url"), None
        finally:
            await pub.close()
    except Exception as exc:
        log.warning("Hashnode publish failed: %s", exc)
        return None, str(exc)


async def _publish_medium_playwright(article: Article, publish: bool) -> tuple[str | None, str | None]:
    try:
        from agent_m.publishers.medium_playwright import MediumPlaywrightPublisher
        pub = MediumPlaywrightPublisher()
        result = await asyncio.wait_for(
            pub.publish(
                title=article.title,
                body_markdown=article.body,
                tags=article.tags,
                publish=publish,
            ),
            timeout=180,
        )
        return result, None
    except asyncio.TimeoutError:
        log.warning("Medium Playwright publish timed out after 180s")
        return None, "Medium Playwright timed out after 180s"
    except Exception as exc:
        log.warning("Medium Playwright publish failed: %s", exc)
        return None, str(exc)


async def _publish_medium_api(
    article: Article, image_url: str | None, canonical_url: str | None, draft: bool
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
                publish_status="draft" if draft else "public",
                canonical_url=canonical_url,
            )
            url = result.get("data", {}).get("url")
            log.info("Published to Medium: %s", url)
            return url
        finally:
            await medium.close()
    except Exception as exc:
        log.warning("Medium API publish failed: %s", exc)
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
