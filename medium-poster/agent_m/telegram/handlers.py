from __future__ import annotations

import io
import logging
from functools import wraps

from telegram import Update
from telegram.constants import ChatAction
from telegram.ext import ContextTypes

from agent_m.config import config
from agent_m.content_plan import get_plan
from agent_m.feedback import add_feedback, get_all_feedback, clear_feedback
from agent_m.gemini.client import get_tracker
from agent_m.history import History
from agent_m.pipeline import run_pipeline

log = logging.getLogger(__name__)


def admin_only(func):
    @wraps(func)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        if update.effective_chat and update.effective_chat.id != config.telegram_admin_chat_id:
            if update.message:
                await update.message.reply_text("Unauthorized.")
            return
        return await func(update, context)
    return wrapper


@admin_only
async def start_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    platforms = []
    if config.devto_api_key:
        platforms.append("Dev.to")
    if config.hashnode_token:
        platforms.append("Hashnode")
    if config.medium_playwright:
        platforms.append("Medium (Playwright)")
    platforms.append("GitHub Pages (RSS)")
    platforms_str = ", ".join(platforms)

    await update.message.reply_text(  # type: ignore[union-attr]
        f"Agent M ready.\n"
        f"Platforms: {platforms_str}\n\n"
        "/post [slug] — publish to all platforms\n"
        "/draft [slug] — publish as draft\n"
        "/preview [slug] — generate without publishing\n"
        "/feedback <text> — add standing instruction for future articles\n"
        "/feedback — show all active feedback\n"
        "/feedback_clear — remove all feedback\n"
        "/medium_login — save Medium session\n"
        "/hashnode_login — save Hashnode session\n"
        "/history — recent publications\n"
        "/topics — content plan status\n"
        "/status — token usage & schedule\n"
        "/help — this message\n\n"
        "Slug is optional — without it, the next planned topic is used."
    )


help_cmd = start_cmd


@admin_only
async def post_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    slug = _extract_slug(context)
    await _publish(update, mode="public", slug=slug)


@admin_only
async def draft_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    slug = _extract_slug(context)
    await _publish(update, mode="draft", slug=slug)


@admin_only
async def preview_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    slug = _extract_slug(context)
    await _publish(update, mode="preview", slug=slug)


def _extract_slug(context: ContextTypes.DEFAULT_TYPE) -> str | None:
    if context.args:
        return context.args[0]
    return None


async def _publish(update: Update, mode: str, slug: str | None = None) -> None:
    msg = update.message
    if not msg:
        return
    await msg.reply_chat_action(ChatAction.TYPING)

    label = f"({mode})"
    if slug:
        label += f" [{slug}]"
    await msg.reply_text(f"Generating article {label}...")

    try:
        result = await run_pipeline(mode=mode, slug=slug)
    except Exception as e:
        log.exception("Pipeline failed")
        await msg.reply_text(f"Failed: {e}")
        return

    if result.image_bytes:
        await msg.reply_photo(
            photo=io.BytesIO(result.image_bytes),
            caption=result.article.title[:200],
        )

    if mode == "preview":
        await msg.reply_text(
            f"Preview complete — not published.\n"
            f"Use /post {result.topic.slug} or /draft {result.topic.slug} to publish."
        )
    elif result.published_to:
        platforms = ", ".join(result.published_to)
        url_line = f"\n{result.post_url}" if result.post_url else ""
        await msg.reply_text(f"Published to: {platforms}{url_line}")
    else:
        await msg.reply_text("Publishing failed on all platforms. Check logs.")


@admin_only
async def history_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return
    history = History(config.data_dir)
    entries = await history.get_recent(10)
    if not entries:
        await msg.reply_text("No publications yet.")
        return

    lines = []
    for i, e in enumerate(reversed(entries), 1):
        url = e.medium_url or "n/a"
        slug_label = f" ({e.slug})" if e.slug else ""
        lines.append(f"{i}. [{e.mode}]{slug_label} {e.title}\n   {url}\n   {e.published_at[:10]}")
    await msg.reply_text("\n\n".join(lines))


@admin_only
async def topics_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return

    history = History(config.data_dir)
    used_slugs = await history.get_used_slugs()
    all_plans = get_plan()

    total = len(all_plans)
    used = sum(1 for p in all_plans if p.slug in used_slugs)
    available = total - used

    lines = [f"Content plan: {available}/{total} available\n"]

    pillars: dict[str, list[str]] = {}
    for p in all_plans:
        status = "done" if p.slug in used_slugs else "next"
        entry = f"  [{status}] {p.slug}: {p.title_hint[:60]}"
        pillars.setdefault(p.pillar, []).append(entry)

    for pillar, entries in pillars.items():
        lines.append(f"\n{pillar.upper()}:")
        lines.extend(entries)

    text = "\n".join(lines)
    if len(text) > 4000:
        text = text[:3990] + "\n..."
    await msg.reply_text(text)


@admin_only
async def medium_login_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return
    await msg.reply_text(
        "Opening Medium login browser on the host machine...\n"
        "Log in to Medium, then close the browser window.\n"
        "Cookies will be saved automatically."
    )
    try:
        from agent_m.publishers.medium_playwright import MediumPlaywrightPublisher
        pub = MediumPlaywrightPublisher()
        await pub.login()
        await msg.reply_text("Medium session saved. Future publishes will use this session.")
    except Exception as e:
        log.exception("Medium login failed")
        await msg.reply_text(f"Medium login failed: {e}")


@admin_only
async def hashnode_login_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return
    await msg.reply_text(
        "Opening Hashnode login browser on the host machine...\n"
        "Log in to Hashnode, then close the browser window.\n"
        "Cookies will be saved automatically."
    )
    try:
        from agent_m.publishers.hashnode_playwright import HashnodePlaywrightPublisher
        pub = HashnodePlaywrightPublisher()
        await pub.login()
        await msg.reply_text("Hashnode session saved. Future publishes will use this session.")
    except Exception as e:
        log.exception("Hashnode login failed")
        await msg.reply_text(f"Hashnode login failed: {e}")


@admin_only
async def feedback_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return
    text = " ".join(context.args) if context.args else ""
    if not text:
        items = get_all_feedback()
        if not items:
            await msg.reply_text("No feedback stored yet.\n\nUsage: /feedback <your instruction>")
        else:
            lines = [f"{i}. {item}" for i, item in enumerate(items, 1)]
            await msg.reply_text("Active feedback:\n\n" + "\n".join(lines))
        return

    count = add_feedback(text)
    await msg.reply_text(f"Feedback #{count} saved. Will be applied to all future articles.")


@admin_only
async def feedback_clear_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return
    clear_feedback()
    await msg.reply_text("All feedback cleared.")


@admin_only
async def status_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return
    tracker = get_tracker()
    today = await tracker.get_today()
    month = await tracker.get_this_month()

    history = History(config.data_dir)
    recent = await history.get_recent(1)
    last = recent[0].published_at[:16] if recent else "never"

    used_slugs = await history.get_used_slugs()
    remaining = len(get_plan()) - len(used_slugs)

    text = (
        f"Last publish: {last}\n"
        f"Schedule: daily at {config.publish_hour:02d}:{config.publish_minute:02d} UTC\n"
        f"Content plan: {remaining} articles remaining\n\n"
        f"Today: {today['total']} tokens, {today['calls']} calls\n"
        f"This month: {month['total']} tokens, {month['calls']} calls"
    )
    await msg.reply_text(text)
