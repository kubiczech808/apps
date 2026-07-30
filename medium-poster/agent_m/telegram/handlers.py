from __future__ import annotations

import asyncio
import io
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from functools import wraps

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import ChatAction
from telegram.ext import ContextTypes

from agent_m.config import config
from agent_m.content_plan import get_plan
from agent_m.feedback import add_feedback, get_all_feedback, clear_feedback
from agent_m.gemini.client import get_tracker
from agent_m.gemini.imager import generate_header_image
from agent_m.gemini.researcher import Topic
from agent_m.history import History
from agent_m.pipeline import run_pipeline
from agent_m.publishers.medium_playwright import MediumPlaywrightPublisher
from agent_m.topic_suggestions import (
    confirm_suggestion,
    create_suggestion,
    format_confirmation,
    get_confirmed,
    reject_suggestion,
)

log = logging.getLogger(__name__)

_DRAFT_ACTIONS_FILE = config.data_dir / "telegram_draft_actions.json"
_MEDIUM_POST_RE = re.compile(r"/p/([a-f0-9]{8,})(?:/|$|[?#])", re.IGNORECASE)
_draft_action_lock = asyncio.Lock()
_engagement_action_lock = asyncio.Lock()
_topic_suggestion_lock = asyncio.Lock()


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
    from agent_m.medium_publish_settings import is_medium_publish_enabled

    platforms = []
    if config.devto_api_key:
        platforms.append("Dev.to")
    if config.medium_playwright:
        label = "Medium (Playwright)"
        if not is_medium_publish_enabled():
            label += " disabled"
        platforms.append(label)
    platforms.append("GitHub Pages (RSS)")
    platforms_str = ", ".join(platforms)

    await update.message.reply_text(  # type: ignore[union-attr]
        f"Agent M ready.\n"
        f"Platforms: {platforms_str}\n\n"
        "/topic <text> - propose a new article topic for confirmation\n"
        "/post [slug] — publish to all platforms\n"
        "/draft [slug] — publish as draft\n"
        "/preview [slug] — generate without publishing\n"
        "/feedback <text> — add standing instruction for future articles\n"
        "/feedback — show all active feedback\n"
        "/feedback_clear — remove all feedback\n"
        "/medium_login — jak nastavit Medium session (+ přijímám JSON soubor z Cookie-Editor)\n"
        "/medium_publish on|off|status — zapnout/vypnout publikování článků na Medium\n"
        "/history — recent publications\n"
        "/topics — content plan status\n"
        "/engage [query] — find related Medium articles and draft comments\n"
        "/engage_rules — show Medium engagement eligibility rules\n"
        "/engage_auto <0-10> — set daily scheduled Medium engagement proposals\n"
        "/engage_autopost on|off|status — post scheduled engagement without approval\n"
        "/engage_notify on|off|status — immediate scheduled engagement Telegram updates\n"
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


def _load_draft_actions() -> dict:
    if not _DRAFT_ACTIONS_FILE.exists():
        return {"actions": {}}
    try:
        data = json.loads(_DRAFT_ACTIONS_FILE.read_text())
    except Exception:
        log.exception("Could not read draft action state")
        return {"actions": {}}
    if not isinstance(data, dict):
        return {"actions": {}}
    actions = data.get("actions")
    if not isinstance(actions, dict):
        data["actions"] = {}
    return data


def _save_draft_actions(data: dict) -> None:
    _DRAFT_ACTIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _DRAFT_ACTIONS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))


def _extract_medium_post_id(url: str | None) -> str | None:
    if not url:
        return None
    match = _MEDIUM_POST_RE.search(url)
    return match.group(1) if match else None


def _register_draft_action(result) -> str | None:
    medium_url = result.platform_urls.get("Medium")
    post_id = _extract_medium_post_id(medium_url)
    if not post_id:
        return None

    action_id = uuid.uuid4().hex[:12]
    data = _load_draft_actions()
    data["actions"][action_id] = {
        "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "medium_post_id": post_id,
        "medium_url": medium_url,
        "title": result.article.title,
        "article_tags": result.article.tags,
        "image_model": result.image_model,
        "topic": {
            "title": result.topic.title,
            "angle": result.topic.angle,
            "tags": result.topic.tags,
            "slug": result.topic.slug,
        },
    }
    _save_draft_actions(data)
    return action_id


def _draft_action_keyboard(action_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("zveřejnit", callback_data=f"mdraft:publish:{action_id}"),
            InlineKeyboardButton("zahodit", callback_data=f"mdraft:discard:{action_id}"),
        ],
        [
            InlineKeyboardButton("jiný obrázek", callback_data=f"mdraft:image:{action_id}"),
        ],
    ])


def _get_draft_action(action_id: str) -> tuple[dict, dict | None]:
    data = _load_draft_actions()
    action = data.get("actions", {}).get(action_id)
    return data, action if isinstance(action, dict) else None


def _mark_draft_action(action_id: str, status: str, **updates) -> None:
    data, action = _get_draft_action(action_id)
    if action is None:
        return
    action.update({
        "status": status,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        **updates,
    })
    _save_draft_actions(data)


def _topic_from_draft_action(action: dict) -> Topic:
    topic = action.get("topic") or {}
    return Topic(
        title=topic.get("title") or action.get("title") or "Bitcoin DCA",
        angle=topic.get("angle") or "",
        tags=topic.get("tags") or action.get("article_tags") or ["Bitcoin", "DCA", "Investing"],
        slug=topic.get("slug") or "",
    )


def engagement_action_keyboard(action_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("vložit + like", callback_data=f"mengage:approve:{action_id}"),
                InlineKeyboardButton("zahodit", callback_data=f"mengage:skip:{action_id}"),
            ]
        ]
    )


def topic_suggestion_keyboard(suggestion_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[
            InlineKeyboardButton("Ano, pridat", callback_data=f"mtopic:approve:{suggestion_id}"),
            InlineKeyboardButton("Ne", callback_data=f"mtopic:reject:{suggestion_id}"),
        ]]
    )


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
        result = await asyncio.wait_for(
            run_pipeline(mode=mode, slug=slug),
            timeout=600,
        )
    except asyncio.TimeoutError:
        log.error("Pipeline timed out after 600s")
        await msg.reply_text("Pipeline timed out after 10 minutes. Check logs for details.")
        return
    except Exception as e:
        log.exception("Pipeline failed")
        await msg.reply_text(f"Failed: {e}")
        return

    if mode == "preview":
        if result.image_bytes:
            caption = result.article.title[:180]
            if result.image_model:
                caption += f"\n🎨 {result.image_model}"
            await msg.reply_photo(
                photo=io.BytesIO(result.image_bytes),
                caption=caption,
            )
        await msg.reply_text(
            f"Preview complete — not published.\n"
            f"Use /post {result.topic.slug} or /draft {result.topic.slug} to publish."
        )
    elif result.published_to:
        platforms = ", ".join(result.published_to)
        url_lines = [f"{name}: {url}" for name, url in result.platform_urls.items()]
        if result.post_url and not url_lines:
            url_lines.append(result.post_url)
        error_lines = [f"- {err}" for err in result.platform_errors]

        text = f"Published to: {platforms}"
        if result.image_model:
            text += f"\nImage: {result.image_model}"
        if error_lines:
            text += "\n\nIssues:\n" + "\n".join(error_lines)
        if url_lines:
            text += "\n\n" + "\n".join(url_lines)

        reply_markup = None
        if mode == "draft" and "Medium" in result.platform_urls:
            action_id = _register_draft_action(result)
            if action_id:
                reply_markup = _draft_action_keyboard(action_id)

        if result.image_bytes:
            await msg.reply_photo(
                photo=io.BytesIO(result.image_bytes),
                caption=text[:1024],
                reply_markup=reply_markup,
            )
        else:
            await msg.reply_text(text[:4000], reply_markup=reply_markup)
    else:
        error_lines = [f"- {err}" for err in result.platform_errors]
        text = "Publishing failed on all platforms. Check logs."
        if error_lines:
            text += "\n\nErrors:\n" + "\n".join(error_lines)
        await msg.reply_text(text[:4000])


@admin_only
async def draft_action_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if not query or not query.data:
        return
    message = query.message
    await query.answer()
    try:
        await query.edit_message_reply_markup(reply_markup=None)
    except Exception:
        log.info("Could not remove draft action keyboard", exc_info=True)

    parts = query.data.split(":")
    if len(parts) != 3 or parts[0] != "mdraft":
        return
    action_name, action_id = parts[1], parts[2]

    if not message:
        return

    async with _draft_action_lock:
        data, action = _get_draft_action(action_id)
        if not action:
            await message.reply_text("Draft action expired or was not found.")
            return

        if action.get("status") != "pending":
            await message.reply_text(f"Draft action already processed: {action.get('status')}.")
            return

        post_id = action.get("medium_post_id")
        if not post_id:
            _mark_draft_action(action_id, "failed", error="missing Medium post ID")
            await message.reply_text("Medium draft action failed: missing post ID.")
            return

        publisher = MediumPlaywrightPublisher()
        if action_name == "publish":
            await message.reply_text(f"Publishing Medium draft:\n{action.get('title') or post_id}")
            try:
                url = await publisher.publish_draft_now(post_id, action.get("article_tags") or [])
            except Exception as exc:
                _mark_draft_action(action_id, "failed", error=str(exc))
                await message.reply_text(f"Medium draft publish failed:\n{exc}")
                return
            _mark_draft_action(action_id, "published", published_url=url)
            await message.reply_text(f"Medium draft published:\n{url}")
            return

        if action_name == "discard":
            await message.reply_text(f"Discarding Medium draft:\n{action.get('title') or post_id}")
            try:
                deleted = await publisher.delete_draft(post_id)
            except Exception as exc:
                _mark_draft_action(action_id, "discard_failed", error=str(exc))
                await message.reply_text(
                    "Medium draft discard failed. Buttons were removed, but the draft may still exist on Medium.\n"
                    f"{exc}"
                )
                return
            _mark_draft_action(action_id, "discarded", medium_deleted=deleted)
            if deleted:
                await message.reply_text("Medium draft discarded.")
            else:
                await message.reply_text(
                    "Draft action discarded locally, but Medium did not confirm deletion. "
                    "Check Medium drafts before assuming it is gone."
                )
            return

        if action_name == "image":
            await message.reply_text(f"Generating another Medium draft image:\n{action.get('title') or post_id}")
            try:
                image_bytes, image_model = await generate_header_image(_topic_from_draft_action(action))
                url = await publisher.replace_draft_cover_image(post_id, image_bytes)
            except Exception as exc:
                _mark_draft_action(action_id, "image_failed", error=str(exc))
                await message.reply_text(f"Medium draft image regeneration failed:\n{exc}")
                return
            _mark_draft_action(
                action_id,
                "image_replaced",
                image_model=image_model,
                medium_url=url,
            )
            await message.reply_photo(
                photo=io.BytesIO(image_bytes),
                caption=f"New Medium draft image inserted.\nImage: {image_model}\n{url}"[:1024],
            )
            return

        await message.reply_text("Unknown draft action.")


@admin_only
async def engagement_action_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if not query or not query.data:
        return
    await query.answer()

    parts = query.data.split(":", 2)
    if len(parts) != 3:
        return
    _, action_name, action_id = parts

    message = query.message
    if message:
        try:
            await query.edit_message_reply_markup(reply_markup=None)
        except Exception:
            pass

    async with _engagement_action_lock:
        if action_name == "skip":
            from agent_m.medium_engagement import skip_opportunity

            result = skip_opportunity(action_id)
            if message:
                await message.reply_text(f"Medium engagement skipped: {result.get('title') or action_id}")
            return

        if action_name != "approve":
            if message:
                await message.reply_text("Unknown engagement action.")
            return

        if message:
            await message.reply_text("Posting Medium comment and clapping the article...")

        try:
            from agent_m.medium_engagement import approve_opportunity

            result = await approve_opportunity(action_id)
        except Exception as exc:
            log.exception("Medium engagement approval failed")
            if message:
                await message.reply_text(f"Medium engagement failed:\n{exc}")
            return

        status = result.get("status")
        if status == "posted":
            if message:
                await message.reply_text(
                    "Medium engagement posted\n"
                    f"Time: {result.get('posted_at_local')}\n"
                    f"Article: {result.get('article_url')}\n"
                    f"Clapped: {'yes' if result.get('clapped') else 'not confirmed'}"
                )
            return

        if message:
            await message.reply_text(
                "Medium engagement not posted\n"
                f"Status: {status}\n"
                f"Detail: {result.get('profile') or result.get('url') or result.get('current_status') or ''}"
            )


async def _offer_topic_suggestion(update: Update, text: str) -> None:
    msg = update.message
    if not msg:
        return
    clean = " ".join(text.split()).strip()
    if len(clean) < 4:
        await msg.reply_text("Napis trochu konkretneji, jake tema clanku navrhujes.")
        return
    suggestion = create_suggestion(clean)
    await msg.reply_text(
        format_confirmation(suggestion),
        reply_markup=topic_suggestion_keyboard(suggestion["id"]),
    )


@admin_only
async def topic_suggestion_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    text = " ".join(context.args).strip() if context.args else ""
    if not text:
        msg = update.message
        if msg:
            await msg.reply_text("Pouziti: /topic <navrh tematu clanku>")
        return
    await _offer_topic_suggestion(update, text)


@admin_only
async def topic_suggestion_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg or not msg.text:
        return
    await _offer_topic_suggestion(update, msg.text)


@admin_only
async def topic_suggestion_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if not query or not query.data:
        return
    await query.answer()

    parts = query.data.split(":", 2)
    if len(parts) != 3:
        return
    _, action_name, suggestion_id = parts
    message = query.message
    if message:
        try:
            await query.edit_message_reply_markup(reply_markup=None)
        except Exception:
            pass

    async with _topic_suggestion_lock:
        if action_name == "approve":
            suggestion = confirm_suggestion(suggestion_id)
            if message:
                if suggestion:
                    await message.reply_text(
                        "Tema pridano do fronty.\n"
                        f"Tema: {suggestion.get('topic')}\n"
                        f"Slug: {suggestion.get('slug')}\n"
                        "Bude mit prednost pri pristim /draft nebo denni publikaci."
                    )
                else:
                    await message.reply_text("Navrh tematu uz neni dostupny.")
            return

        if action_name == "reject":
            suggestion = reject_suggestion(suggestion_id)
            if message:
                await message.reply_text(
                    f"Navrh tematu zamitnut: {(suggestion or {}).get('topic') or suggestion_id}"
                )
            return

        if message:
            await message.reply_text("Neznama akce pro navrh tematu.")


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

    confirmed = get_confirmed()
    queued = [item for item in confirmed if item.get("slug") not in used_slugs]
    if queued:
        lines.append("SUGGESTED TOPICS (priority queue):")
        for item in queued:
            lines.append(f"  [next] {item.get('slug')}: {str(item.get('topic') or '')[:80]}")

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
async def engage_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return

    query = " ".join(context.args).strip() if context.args else None
    await msg.chat.send_action(ChatAction.TYPING)
    await msg.reply_text(
        "Searching Medium for related articles and drafting comments. "
        "Nothing will be published automatically."
    )

    try:
        from agent_m.medium_engagement import format_result, run_once

        result = await run_once(limit=3, query=query)
        await msg.reply_text(format_result(result))
    except Exception as exc:
        log.exception("Medium engagement scout failed")
        await msg.reply_text(f"Medium engagement scout failed:\n{exc}")


@admin_only
async def engage_rules_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return

    from agent_m.medium_engagement import format_engagement_rules_status

    await msg.reply_text(format_engagement_rules_status())


@admin_only
async def engage_auto_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return

    from agent_m.medium_engagement import get_daily_proposal_count, set_daily_proposal_count

    if not context.args:
        count = get_daily_proposal_count()
        await msg.reply_text(
            "Medium engagement auto proposals\n"
            f"Current: {count} per day\n"
            "Usage: /engage_auto <0-10>\n"
            "0 disables scheduled proposals. Approved comments still have a hard cap of 10 per day."
        )
        return

    try:
        count = int(context.args[0])
    except ValueError:
        await msg.reply_text("Usage: /engage_auto <0-10>")
        return

    result = set_daily_proposal_count(count)
    try:
        from agent_m.telegram.bot import _schedule_engagement_slots

        _schedule_engagement_slots(context.application)
        rescheduled = True
    except Exception:
        log.exception("Could not reschedule Medium engagement slots after /engage_auto")
        rescheduled = False

    await msg.reply_text(
        "Medium engagement auto proposals updated\n"
        f"Daily proposals: {result['daily_proposals']}\n"
        f"Hard daily posting cap: {result['max_daily_posts']}\n"
        f"Today's slots rescheduled: {'yes' if rescheduled else 'not confirmed'}"
    )


@admin_only
async def engage_autopost_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return

    from agent_m.medium_engagement import (
        get_daily_proposal_count,
        is_auto_post_enabled,
        set_auto_post_enabled,
    )

    action = (context.args[0].lower() if context.args else "status").strip()
    if action in {"on", "enable", "enabled", "zapnout"}:
        result = set_auto_post_enabled(True)
    elif action in {"off", "disable", "disabled", "vypnout"}:
        result = set_auto_post_enabled(False)
    elif action in {"status", "stav"}:
        result = {
            "auto_post_enabled": is_auto_post_enabled(),
            "daily_proposals": get_daily_proposal_count(),
            "max_daily_posts": 10,
        }
    else:
        await msg.reply_text("Usage: /engage_autopost on|off|status")
        return

    enabled = bool(result["auto_post_enabled"])
    await msg.reply_text(
        "Medium engagement autopost\n"
        f"Status: {'ON - comments will be posted without approval' if enabled else 'OFF - proposals require approval'}\n"
        f"Scheduled slots per day: {result['daily_proposals']}\n"
        f"Hard daily posting cap: {result['max_daily_posts']}\n"
        "Use /engage_auto <0-10> to change how many scheduled slots run each day."
    )


@admin_only
async def engage_notify_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return

    from agent_m.medium_engagement import (
        get_daily_proposal_count,
        is_immediate_notifications_enabled,
        set_immediate_notifications_enabled,
    )

    action = (context.args[0].lower() if context.args else "status").strip()
    if action in {"on", "enable", "enabled", "zapnout"}:
        result = set_immediate_notifications_enabled(True)
    elif action in {"off", "disable", "disabled", "vypnout"}:
        result = set_immediate_notifications_enabled(False)
    elif action in {"status", "stav"}:
        result = {
            "immediate_notifications_enabled": is_immediate_notifications_enabled(),
            "daily_proposals": get_daily_proposal_count(),
            "max_daily_posts": 10,
        }
    else:
        await msg.reply_text("Usage: /engage_notify on|off|status")
        return

    enabled = bool(result["immediate_notifications_enabled"])
    await msg.reply_text(
        "Medium engagement notifications\n"
        f"Status: {'ON - every scheduled slot/post can send an immediate update' if enabled else 'OFF - daily summary only, errors still reported'}\n"
        f"Scheduled slots per day: {result['daily_proposals']}\n"
        f"Hard daily posting cap: {result['max_daily_posts']}\n"
        "Use /engage_rules to show the full engagement setup."
    )


@admin_only
async def medium_publish_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return

    from agent_m.medium_publish_settings import (
        medium_publish_status,
        set_medium_publish_enabled,
    )

    action = (context.args[0].lower() if context.args else "status").strip()
    if action in {"on", "enable", "enabled", "zapnout"}:
        result = set_medium_publish_enabled(True)
    elif action in {"off", "disable", "disabled", "vypnout"}:
        result = set_medium_publish_enabled(False)
    elif action in {"status", "stav"}:
        result = medium_publish_status()
    else:
        await msg.reply_text("Usage: /medium_publish on|off|status")
        return

    enabled = bool(result["enabled"])
    await msg.reply_text(
        "Medium article publishing\n"
        f"Status: {'ON - new articles will publish to Medium' if enabled else 'OFF - new articles will skip Medium'}\n"
        "This affects /post, /draft and the daily article pipeline. "
        "Medium engagement and Medium login/cookies stay available."
    )


@admin_only
async def medium_login_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return
    await msg.reply_text(
        "Medium cookies — 2 možnosti:\n\n"
        "*Možnost 1 — Cookie-Editor (doporučeno):*\n"
        "1. V Chrome/Firefox nainstaluj rozšíření Cookie-Editor\n"
        "2. Přihlaš se na medium.com\n"
        "3. Klikni na Cookie-Editor → Export → Export as JSON\n"
        "4. Ulož jako soubor a pošli mi ho sem jako přílohu\n\n"
        "*Možnost 2 — SSH na RPi:*\n"
        "```\n"
        "cd /home/jakub/apps/medium-poster\n"
        "source .venv/bin/activate\n"
        "python -m agent_m.cli medium-login\n"
        "```",
        parse_mode="Markdown",
    )


@admin_only
async def medium_cookies_document_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg or not msg.document:
        return
    doc = msg.document
    if not doc.file_name or not doc.file_name.lower().endswith(".json"):
        await msg.reply_text("Pošli soubor s příponou .json (export z Cookie-Editor).")
        return

    try:
        file = await context.bot.get_file(doc.file_id)
        buf = io.BytesIO()
        await file.download_to_memory(buf)
        raw = json.loads(buf.getvalue())
    except Exception as e:
        await msg.reply_text(f"Chyba při čtení souboru: {e}")
        return

    if not isinstance(raw, list) or not raw:
        await msg.reply_text("Neplatný formát — očekáváno JSON pole cookies.")
        return

    # Convert Cookie-Editor format → Playwright format
    pw_cookies = []
    for c in raw:
        if not isinstance(c, dict) or "name" not in c or "value" not in c:
            continue
        pc: dict = {
            "name": c["name"],
            "value": c["value"],
            "domain": c.get("domain", ".medium.com"),
            "path": c.get("path", "/"),
            "httpOnly": c.get("httpOnly", False),
            "secure": c.get("secure", True),
        }
        expires = c.get("expirationDate") or c.get("expires")
        if expires:
            pc["expires"] = int(expires)
        same_site = c.get("sameSite", "None")
        mapping = {"no_restriction": "None", "lax": "Lax", "strict": "Strict"}
        pc["sameSite"] = mapping.get(same_site, same_site)
        pw_cookies.append(pc)

    if not pw_cookies:
        await msg.reply_text("Nebyly nalezeny žádné platné cookies.")
        return

    cookies_path = config.data_dir / "medium_cookies.json"
    cookies_path.parent.mkdir(parents=True, exist_ok=True)
    cookies_path.write_text(json.dumps(pw_cookies, indent=2))
    log.info("Medium cookies saved: %d cookies to %s", len(pw_cookies), cookies_path)
    await msg.reply_text(
        f"✓ Uloženo {len(pw_cookies)} Medium cookies.\n"
        "Nyní zkus /draft pro otestování publikace na Medium."
    )


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
    from agent_m.medium_publish_settings import is_medium_publish_enabled

    text = (
        f"Last publish: {last}\n"
        f"Schedule: daily at {config.publish_hour:02d}:{config.publish_minute:02d} UTC\n"
        f"Content plan: {remaining} articles remaining\n\n"
        f"Medium publish: {'ON' if is_medium_publish_enabled() else 'OFF'}\n"
        f"Today: {today['total']} tokens, {today['calls']} calls\n"
        f"This month: {month['total']} tokens, {month['calls']} calls"
    )
    await msg.reply_text(text)
