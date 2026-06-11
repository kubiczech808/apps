from __future__ import annotations

import asyncio
import io
import json
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
        "/medium_login — jak nastavit Medium session (+ přijímám JSON soubor z Cookie-Editor)\n"
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

        if result.image_bytes:
            await msg.reply_photo(
                photo=io.BytesIO(result.image_bytes),
                caption=text[:1024],
            )
        else:
            await msg.reply_text(text[:4000])
    else:
        error_lines = [f"- {err}" for err in result.platform_errors]
        text = "Publishing failed on all platforms. Check logs."
        if error_lines:
            text += "\n\nErrors:\n" + "\n".join(error_lines)
        await msg.reply_text(text[:4000])


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

    text = (
        f"Last publish: {last}\n"
        f"Schedule: daily at {config.publish_hour:02d}:{config.publish_minute:02d} UTC\n"
        f"Content plan: {remaining} articles remaining\n\n"
        f"Today: {today['total']} tokens, {today['calls']} calls\n"
        f"This month: {month['total']} tokens, {month['calls']} calls"
    )
    await msg.reply_text(text)
