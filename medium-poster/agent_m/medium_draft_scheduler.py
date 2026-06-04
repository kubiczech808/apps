from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

from agent_m.config import config
from agent_m.gemini.imager import generate_header_image
from agent_m.gemini.researcher import Topic
from agent_m.publishers.medium_playwright import MediumPlaywrightPublisher

log = logging.getLogger(__name__)

_STATE_FILE = config.data_dir / "medium_draft_scheduler.json"
_PRAGUE = ZoneInfo("Europe/Prague")
_DEFAULT_TAGS = ["Bitcoin", "Bitcoin DCA", "Dollar Cost Averaging", "Automated Investing", "DCA"]

_VISUAL_IMAGE_BLOCKS = {
    "41804b8ee387": "cover contains pseudo text around the Bitcoin coin",
    "6a4a28d983da": "cover contains pseudo UI/text artifacts in the orange dashboard image",
}


async def run_once(send_status: bool = True) -> dict:
    state = _read_state(_STATE_FILE)
    scheduled_done = state.setdefault("scheduled", {})
    image_review_ok = set(state.get("image_review_ok", []))

    publisher = MediumPlaywrightPublisher()
    scheduled_posts = await publisher.list_scheduled_posts()
    if scheduled_posts:
        result = {
            "status": "already_scheduled",
            "scheduled_count": len(scheduled_posts),
            "scheduled": scheduled_posts[:3],
        }
        await _maybe_send_status(result, send_status)
        return result

    drafts = await publisher.list_drafts()
    candidates = []
    rejected = []
    for draft in drafts:
        post_id = draft.get("postId", "")
        if scheduled_done.get(post_id, {}).get("status") == "scheduled":
            rejected.append(_reject(draft, "already handled by scheduler state"))
            continue
        reasons = _quality_reasons(draft)
        image_block = _VISUAL_IMAGE_BLOCKS.get(post_id)
        if image_block and post_id not in image_review_ok:
            draft["needs_preview_image"] = image_block
        if reasons:
            rejected.append(_reject(draft, "; ".join(reasons)))
        else:
            candidates.append(draft)

    if not candidates:
        result = {
            "status": "no_eligible_draft",
            "draft_count": len(drafts),
            "rejected": rejected[:8],
        }
        state["last_run_at"] = datetime.now(timezone.utc).isoformat()
        _write_state(_STATE_FILE, state)
        await _maybe_send_status(result, send_status)
        return result

    draft = candidates[0]
    preview_image_bytes = None
    image_model = None
    if draft.get("needs_preview_image"):
        try:
            preview_image_bytes, image_model = await _generate_clean_preview_image(draft)
        except Exception as exc:
            result = {
                "status": "retry_later",
                "post_id": draft.get("postId"),
                "title": draft.get("title"),
                "reason": f"preview image generation failed: {exc}",
            }
            state["last_run_at"] = datetime.now(timezone.utc).isoformat()
            _write_state(_STATE_FILE, state)
            await _maybe_send_status(result, send_status)
            return result

    scheduled_at = _next_schedule_time()
    try:
        result = await publisher.schedule_draft_for_later(
            draft["postId"],
            scheduled_at,
            tags=_DEFAULT_TAGS,
            preview_image_bytes=preview_image_bytes,
        )
    except Exception as exc:
        reason = str(exc)
        if "maximum of two stories" in reason.lower() and draft.get("needs_preview_image"):
            image_review_ok.add(draft["postId"])
            state["image_review_ok"] = sorted(image_review_ok)
        result = {
            "status": "retry_later",
            "post_id": draft.get("postId"),
            "title": draft.get("title"),
            "reason": reason,
            "image_model": image_model,
        }
        state["last_run_at"] = datetime.now(timezone.utc).isoformat()
        _write_state(_STATE_FILE, state)
        await _maybe_send_status(result, send_status)
        return result

    scheduled_done[draft["postId"]] = {
        "status": "scheduled",
        "title": result.get("title"),
        "scheduled_at": result.get("scheduled_at"),
        "url": result.get("url"),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    state["last_run_at"] = datetime.now(timezone.utc).isoformat()
    _write_state(_STATE_FILE, state)

    result = {
        "status": "scheduled",
        **result,
        "image_model": image_model,
        "remaining_candidates": max(0, len(candidates) - 1),
        "rejected_count": len(rejected),
    }
    await _maybe_send_status(result, send_status)
    return result


def format_result(result: dict) -> str:
    status = result.get("status")
    if status == "scheduled":
        return (
            "Medium draft scheduler: scheduled\n"
            f"Title: {result.get('title')}\n"
            f"When: {result.get('scheduled_at')}\n"
            f"Image: {result.get('image_model') or 'existing'}\n"
            f"Post: {result.get('url')}"
        )
    if status == "retry_later":
        return (
            "Medium draft scheduler: retry later\n"
            f"Title: {result.get('title')}\n"
            f"Reason: {result.get('reason')}"
        )
    if status == "already_scheduled":
        lines = [
            f"Medium draft scheduler: already has {result.get('scheduled_count')} scheduled story.",
            "No duplicate was created.",
        ]
        for post in result.get("scheduled", [])[:2]:
            lines.append(f"- {post.get('title') or post.get('postId')}")
        return "\n".join(lines)
    if status == "no_eligible_draft":
        lines = [
            "Medium draft scheduler: no eligible old draft was scheduled.",
            f"Checked drafts: {result.get('draft_count', 0)}",
        ]
        for item in result.get("rejected", [])[:5]:
            lines.append(f"- {item['title']}: {item['reason']}")
        return "\n".join(lines)
    return f"Medium draft scheduler: {status}\n{json.dumps(result, ensure_ascii=False)[:1500]}"


def _quality_reasons(draft: dict) -> list[str]:
    reasons = []
    title = (draft.get("title") or "").strip()
    text = draft.get("text") or ""
    links = draft.get("links") or []
    images = draft.get("images") or []
    word_count = int(draft.get("wordCount") or 0)

    if "test" in title.lower():
        reasons.append("test draft")
    if len(title) < 20:
        reasons.append("missing or too short title")
    if word_count < 600:
        reasons.append(f"too short ({word_count} words)")
    if not links:
        reasons.append("missing btc-dca/partner links")
    if not images:
        reasons.append("missing featured image")
    if "http://" in text or "https://" in text:
        reasons.append("raw URL visible in article text")
    if any((link.get("href") or "").startswith("http://test") for link in links):
        reasons.append("contains test link")
    return reasons


async def _generate_clean_preview_image(draft: dict) -> tuple[bytes, str]:
    title = draft.get("title") or "Bitcoin DCA strategy"
    topic = Topic(
        title=title,
        angle=(
            "Create a clean Medium featured image for a Bitcoin DCA article. "
            "Show recurring buys, calm automation, disciplined accumulation, "
            "and portfolio cost averaging without any writing or UI labels."
        ),
        tags=["Bitcoin", "DCA", "Investing"],
        slug=f"medium-draft-{draft.get('postId')}",
    )
    return await generate_header_image(topic)


def _reject(draft: dict, reason: str) -> dict:
    return {
        "post_id": draft.get("postId"),
        "title": (draft.get("title") or draft.get("postId") or "untitled")[:140],
        "reason": reason,
    }


def _next_schedule_time() -> datetime:
    now = datetime.now(_PRAGUE)
    target = (now + timedelta(days=1)).replace(
        hour=config.medium_draft_schedule_hour,
        minute=config.medium_draft_schedule_minute,
        second=0,
        microsecond=0,
    )
    if target <= now:
        target += timedelta(days=1)
    return target


async def _maybe_send_status(result: dict, send_status: bool) -> None:
    if not send_status:
        return
    if not config.telegram_bot_token or not config.telegram_admin_chat_id:
        return
    url = f"https://api.telegram.org/bot{config.telegram_bot_token}/sendMessage"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            url,
            json={
                "chat_id": config.telegram_admin_chat_id,
                "text": format_result(result)[:4096],
            },
        )
        if resp.status_code != 200:
            log.error("Telegram API error %d: %s", resp.status_code, resp.text[:500])


def _read_state(path: Path) -> dict:
    if not path.exists():
        return {"scheduled": {}}
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        backup = path.with_suffix(".json.bak")
        path.rename(backup)
        return {"scheduled": {}}


def _write_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def main() -> None:
    logging.basicConfig(
        level=config.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    result = asyncio.run(run_once(send_status=True))
    print("MEDIUM_DRAFT_SCHEDULER_START")
    for key, value in result.items():
        print(f"{key}: {value}")
    print("MEDIUM_DRAFT_SCHEDULER_END")


if __name__ == "__main__":
    main()
