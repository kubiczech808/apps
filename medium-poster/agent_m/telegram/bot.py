from __future__ import annotations

import datetime
import io
import logging
from zoneinfo import ZoneInfo

from telegram import BotCommand
from telegram.ext import ApplicationBuilder, CallbackQueryHandler, CommandHandler, ContextTypes, MessageHandler, filters

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
        if result.image_model:
            caption += f"\nImage: {result.image_model}"
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


async def _scheduled_engagement_slot(context: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        from agent_m.medium_engagement import (
            approve_opportunity,
            format_opportunity_message,
            is_auto_post_enabled,
            is_immediate_notifications_enabled,
            prepare_next_opportunity,
        )

        immediate_notifications = is_immediate_notifications_enabled()
        result = await prepare_next_opportunity()
        if result.get("status") != "prepared":
            log.info("Medium engagement slot produced no proposal: %s", result)
            if immediate_notifications:
                await context.bot.send_message(
                    chat_id=config.telegram_admin_chat_id,
                    text=format_opportunity_message(result),
                )
            return

        op = result["opportunity"]
        if is_auto_post_enabled():
            log.info("Medium engagement auto-posting opportunity %s", op.get("id"))
            post_result = await approve_opportunity(op["id"])
            if post_result.get("status") == "posted":
                if immediate_notifications:
                    await context.bot.send_message(
                        chat_id=config.telegram_admin_chat_id,
                        text=(
                            "Medium engagement auto-posted\n"
                            f"Time: {post_result.get('posted_at_local')}\n"
                            f"Profile: {post_result.get('profile')}\n"
                            f"Article: {post_result.get('article_url')}\n"
                            f"Clapped: {'yes' if post_result.get('clapped') else 'not confirmed'}"
                        ),
                    )
                return

            await context.bot.send_message(
                chat_id=config.telegram_admin_chat_id,
                text=(
                    "Medium engagement auto-post not completed\n"
                    f"Status: {post_result.get('status')}\n"
                    f"Article: {op.get('url')}\n"
                    f"Detail: {post_result.get('profile') or post_result.get('url') or post_result.get('current_status') or ''}"
                ),
            )
            return

        await context.bot.send_message(
            chat_id=config.telegram_admin_chat_id,
            text=format_opportunity_message(result),
            reply_markup=handlers.engagement_action_keyboard(op["id"]),
        )
    except Exception as e:
        log.exception("Medium engagement slot failed")
        await context.bot.send_message(
            chat_id=config.telegram_admin_chat_id,
            text=f"Medium engagement slot failed:\n{e}",
        )


async def _scheduled_engagement_summary(context: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        from agent_m.medium_engagement import format_daily_summary

        await context.bot.send_message(
            chat_id=config.telegram_admin_chat_id,
            text=format_daily_summary(),
        )
    except Exception as e:
        log.exception("Medium engagement summary failed")
        await context.bot.send_message(
            chat_id=config.telegram_admin_chat_id,
            text=f"Medium engagement summary failed:\n{e}",
        )


async def _schedule_engagement_day(context: ContextTypes.DEFAULT_TYPE) -> None:
    _schedule_engagement_slots(context.application)


def _schedule_engagement_slots(application) -> None:
    from agent_m.medium_engagement import get_daily_proposal_count, planned_times_for_today

    now = datetime.datetime.now(ZoneInfo("Europe/Prague"))
    daily_count = get_daily_proposal_count()
    for job in application.job_queue.jobs():
        if job.name.startswith("medium_engagement_") and job.name not in {
            "medium_engagement_schedule_day",
            "medium_engagement_summary",
        }:
            job.schedule_removal()
    slots = planned_times_for_today(now, count=daily_count)
    for slot in slots:
        application.job_queue.run_once(
            _scheduled_engagement_slot,
            when=slot,
            name=f"medium_engagement_{slot.strftime('%Y%m%d_%H%M')}",
        )
    if slots:
        log.info(
            "Scheduled %d/%d Medium engagement proposal slots: %s",
            len(slots),
            daily_count,
            ", ".join(slot.strftime("%H:%M") for slot in slots),
        )
    else:
        log.info("Scheduled 0/%d Medium engagement proposal slots for the rest of today", daily_count)


_BOT_COMMANDS = [
    BotCommand("topic", "Param: <text> - navrhnout nove tema clanku"),
    BotCommand("post", "Param: [slug] - publikovat na vsechny platformy"),
    BotCommand("draft", "Param: [slug] - publikovat jako koncept"),
    BotCommand("preview", "Param: [slug] - vygenerovat bez publikace"),
    BotCommand("feedback", "Param: [text] - pridat/zobrazit trvale instrukce"),
    BotCommand("feedback_clear", "Smazat všechny instrukce"),
    BotCommand("medium_login", "Nastavit Medium session (cookies)"),
    BotCommand("medium_publish", "Param: on|off|status - publikovani clanku na Medium"),
    BotCommand("history", "Poslední publikace"),
    BotCommand("topics", "Stav obsahového plánu"),
    BotCommand("engage", "Param: [query] - najit clanky a navrhnout komentare"),
    BotCommand("engage_rules", "Bez parametru - vypsat engagement pravidla"),
    BotCommand("engage_auto", "Param: <0-10> - denni pocet engagement navrhu"),
    BotCommand("engage_autopost", "Param: on|off|status - komentare bez schvalovani"),
    BotCommand("engage_notify", "Param: on|off|status - okamzite engagement notifikace"),
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

    _schedule_engagement_slots(application)
    application.job_queue.run_daily(
        callback=_schedule_engagement_day,
        time=datetime.time(hour=0, minute=10, tzinfo=tz),
        name="medium_engagement_schedule_day",
    )
    application.job_queue.run_daily(
        callback=_scheduled_engagement_summary,
        time=datetime.time(hour=21, minute=1, tzinfo=tz),
        name="medium_engagement_summary",
    )
    log.info("Scheduled Medium engagement summary at 21:01 Europe/Prague")


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
    app.add_handler(CommandHandler("topic", handlers.topic_suggestion_cmd))
    app.add_handler(CommandHandler("engage", handlers.engage_cmd))
    app.add_handler(CommandHandler("engage_rules", handlers.engage_rules_cmd))
    app.add_handler(CommandHandler("engage_auto", handlers.engage_auto_cmd))
    app.add_handler(CommandHandler("engage_autopost", handlers.engage_autopost_cmd))
    app.add_handler(CommandHandler("engage_notify", handlers.engage_notify_cmd))
    app.add_handler(CommandHandler("status", handlers.status_cmd))
    app.add_handler(CommandHandler("feedback", handlers.feedback_cmd))
    app.add_handler(CommandHandler("feedback_clear", handlers.feedback_clear_cmd))
    app.add_handler(CommandHandler("medium_login", handlers.medium_login_cmd))
    app.add_handler(CommandHandler("medium_publish", handlers.medium_publish_cmd))
    app.add_handler(CallbackQueryHandler(handlers.draft_action_callback, pattern=r"^mdraft:"))
    app.add_handler(CallbackQueryHandler(handlers.engagement_action_callback, pattern=r"^mengage:"))
    app.add_handler(CallbackQueryHandler(handlers.topic_suggestion_callback, pattern=r"^mtopic:"))
    app.add_handler(MessageHandler(
        filters.Document.ALL & filters.ChatType.PRIVATE,
        handlers.medium_cookies_document_cmd,
    ))
    app.add_handler(MessageHandler(
        filters.TEXT & ~filters.COMMAND & filters.ChatType.PRIVATE,
        handlers.topic_suggestion_text,
    ))
    return app
