from __future__ import annotations

import datetime
import io
import logging
from zoneinfo import ZoneInfo

from telegram import BotCommand
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes, MessageHandler, filters

from agent_m.config import config
from agent_m.pipeline import run_pipeline
from agent_m.telegram import handlers

log = logging.getLogger(__name__)


_QUOTA_KEYWORDS = ("quota", "resource_exhausted", "429", "rate")
_MAX_RETRIES = 3
_RETRY_DELAY_S = 3600  # 1 hour


def _is_quota_error(err: Exception) -> bool:
    msg = str(err).lower()
    return any(k in msg for k in _QUOTA_KEYWORDS)


async def _scheduled_publish(context: ContextTypes.DEFAULT_TYPE) -> None:
    attempt = context.job.data or 0
    try:
        log.info("Scheduled publish started (attempt %d)", attempt + 1)
        result = await run_pipeline(mode="public")

        platforms = ", ".join(result.published_to) if result.published_to else "none"
        caption = f"Published to: {platforms}\n{result.article.title}"
        errors = [e for e in result.platform_errors if "not configured" not in e.lower()]
        if errors:
            caption += "\n\nIssues:\n" + "\n".join(f"- {e}" for e in errors)
        if result.platform_urls:
            for name, url in result.platform_urls.items():
                caption += f"\n{name}: {url}"
        elif result.post_url:
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
        log.exception("Scheduled publish failed (attempt %d)", attempt + 1)
        if _is_quota_error(e) and attempt < _MAX_RETRIES:
            next_attempt = attempt + 1
            delay = _RETRY_DELAY_S * next_attempt
            context.job_queue.run_once(
                _scheduled_publish,
                when=delay,
                name=f"quota_retry_{next_attempt}",
                data=next_attempt,
            )
            log.info("Gemini quota exhausted — retry #%d in %d min", next_attempt, delay // 60)
            await context.bot.send_message(
                chat_id=config.telegram_admin_chat_id,
                text=f"Gemini quota exhausted — retry #{next_attempt} za {delay // 60} min.",
            )
        else:
            await context.bot.send_message(
                chat_id=config.telegram_admin_chat_id,
                text=f"Scheduled publish failed:\n{e}",
            )


_BOT_COMMANDS = [
    BotCommand("post", "Publikovat na všechny platformy"),
    BotCommand("draft", "Publikovat jako koncept"),
    BotCommand("preview", "Vygenerovat bez publikace"),
    BotCommand("feedback", "Přidat/zobrazit trvalé instrukce"),
    BotCommand("feedback_clear", "Smazat všechny instrukce"),
    BotCommand("medium_login", "Nastavit Medium session (cookies)"),
    BotCommand("hashnode_login", "Nastavit Hashnode session"),
    BotCommand("history", "Poslední publikace"),
    BotCommand("topics", "Stav obsahového plánu"),
    BotCommand("status", "Využití tokenů a rozvrh"),
    BotCommand("help", "Nápověda"),
]


async def _post_init(application) -> None:
    await application.bot.set_my_commands(_BOT_COMMANDS)
    log.info("Registered %d bot commands in Telegram menu", len(_BOT_COMMANDS))

    tz = ZoneInfo("Europe/Prague")
    target_time = datetime.time(
        hour=config.publish_hour,
        minute=config.publish_minute,
        tzinfo=tz,
    )
    application.job_queue.run_daily(
        callback=_scheduled_publish,
        time=target_time,
        name="daily_publish",
    )
    log.info(
        "Scheduled daily publish at %s Europe/Prague",
        target_time.strftime("%H:%M"),
    )


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
        filters.Document.ALL & filters.ChatType.PRIVATE,
        handlers.medium_cookies_document_cmd,
    ))
    return app
