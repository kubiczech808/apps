from __future__ import annotations

import io
import logging
from functools import wraps

from telegram import Update
from telegram.constants import ChatAction
from telegram.ext import ContextTypes

from agent_m.config import config
from agent_m.content_plan import get_plan
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
    await update.message.reply_text(  # type: ignore[union-attr]
        "Agent M ready.\n\n"
        "/post [slug] — publish article (public)\n"
        "/draft [slug] — publish as draft\n"
        "/preview [slug] — generate without publishing\n"
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

    body_preview = result.article.body[:3500]
    if len(result.article.body) > 3500:
        body_preview += "\n\n... (truncated)"
    await msg.reply_text(body_preview)

    if result.post_url:
        await msg.reply_text(f"Published ({mode}): {result.post_url}")
    else:
        await msg.reply_text(
            f"Preview complete — not published.\n"
            f"Use /post {result.topic.slug} or /draft {result.topic.slug} to publish this article."
        )


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
