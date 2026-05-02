from __future__ import annotations

import io
import logging
from functools import wraps

from telegram import Update
from telegram.constants import ChatAction
from telegram.ext import ContextTypes

from agent_m.config import config
from agent_m.gemini.client import get_tracker
from agent_m.gemini.researcher import TopicResearcher
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
        "/post — publish article (public)\n"
        "/draft — publish as draft\n"
        "/preview — generate without publishing\n"
        "/history — recent publications\n"
        "/topics — cached topic queue\n"
        "/status — token usage & schedule\n"
        "/help — this message"
    )


help_cmd = start_cmd


@admin_only
async def post_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await _publish(update, mode="public")


@admin_only
async def draft_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await _publish(update, mode="draft")


@admin_only
async def preview_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await _publish(update, mode="preview")


async def _publish(update: Update, mode: str) -> None:
    msg = update.message
    if not msg:
        return
    await msg.reply_chat_action(ChatAction.TYPING)
    await msg.reply_text(f"Generating article ({mode})...")

    try:
        result = await run_pipeline(mode=mode)
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
        await msg.reply_text("Preview complete — not published. Use /post or /draft to publish.")


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
        lines.append(f"{i}. [{e.mode}] {e.title}\n   {url}\n   {e.published_at[:10]}")
    await msg.reply_text("\n\n".join(lines))


@admin_only
async def topics_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return
    researcher = TopicResearcher(config.data_dir)
    topics = await researcher.get_cached_topics()
    if not topics:
        await msg.reply_text("No cached topics. They will be generated on next /post or /preview.")
        return

    lines = []
    for t in topics:
        status = "used" if t.get("used") else "available"
        lines.append(f"[{status}] {t['title']}")
    await msg.reply_text("\n".join(lines))


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

    text = (
        f"Last publish: {last}\n"
        f"Schedule: daily at {config.publish_hour:02d}:{config.publish_minute:02d} UTC\n\n"
        f"Today: {today['total']} tokens, {today['calls']} calls\n"
        f"This month: {month['total']} tokens, {month['calls']} calls"
    )
    await msg.reply_text(text)
