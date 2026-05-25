from __future__ import annotations

import datetime
import io
import logging

from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes, MessageHandler, filters

from agent_m.config import config
from agent_m.pipeline import run_pipeline
from agent_m.telegram import handlers

log = logging.getLogger(__name__)


async def _scheduled_publish(context: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        result = await run_pipeline(mode="public")
        caption = f"Published: {result.article.title}"
        if result.post_url:
            caption += f"\n{result.post_url}"

        if result.image_bytes:
            await context.bot.send_photo(
                chat_id=config.telegram_admin_chat_id,
                photo=io.BytesIO(result.image_bytes),
                caption=caption[:1024],
            )
        else:
            await context.bot.send_message(
                chat_id=config.telegram_admin_chat_id,
                text=caption,
            )
    except Exception as e:
        log.exception("Scheduled publish failed")
        await context.bot.send_message(
            chat_id=config.telegram_admin_chat_id,
            text=f"Scheduled publish failed:\n{e}",
        )


async def _post_init(application) -> None:
    target_time = datetime.time(
        hour=config.publish_hour,
        minute=config.publish_minute,
        tzinfo=datetime.timezone.utc,
    )
    application.job_queue.run_daily(
        callback=_scheduled_publish,
        time=target_time,
        name="daily_publish",
    )
    log.info("Scheduled daily publish at %s UTC", target_time.strftime("%H:%M"))


def build_app():
    app = (
        ApplicationBuilder()
        .token(config.telegram_bot_token)
        .post_init(_post_init)
        .build()
    )
    app.add_handler(CommandHandler("start", handlers.start_cmd))
    app.add_handler(CommandHandler("help", handlers.help_cmd))
    app.add_handler(CommandHandler("post", handlers.post_cmd))
    app.add_handler(CommandHandler("draft", handlers.draft_cmd))
    app.add_handler(CommandHandler("preview", handlers.preview_cmd))
    app.add_handler(CommandHandler("history", handlers.history_cmd))
    app.add_handler(CommandHandler("topics", handlers.topics_cmd))
    app.add_handler(CommandHandler("status", handlers.status_cmd))
    app.add_handler(CommandHandler("feedback", handlers.feedback_cmd))
    app.add_handler(CommandHandler("feedback_clear", handlers.feedback_clear_cmd))
    app.add_handler(CommandHandler("medium_login", handlers.medium_login_cmd))
    app.add_handler(CommandHandler("hashnode_login", handlers.hashnode_login_cmd))
    app.add_handler(MessageHandler(
        filters.Document.JSON & filters.ChatType.PRIVATE,
        handlers.medium_cookies_document_cmd,
    ))
    return app
