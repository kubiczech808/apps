from __future__ import annotations

import asyncio
import json
import logging

import httpx

from agent_m.config import config
from agent_m.medium_draft_scheduler import format_result as format_draft_result
from agent_m.medium_draft_scheduler import run_once as run_draft_scheduler_once
from agent_m.medium_featured_images import run_once as run_featured_image_once

log = logging.getLogger(__name__)


async def run_once(send_status: bool = True) -> dict:
    draft = await run_draft_scheduler_once(send_status=False)
    draft_status = draft.get("status")

    if draft_status in {"scheduled", "retry_later"}:
        result = {
            "status": "draft_priority",
            "draft": draft,
            "featured": {
                "status": "skipped",
                "reason": "draft scheduler used or attempted the hourly image-generation slot",
            },
        }
        await _maybe_send_status(result, send_status)
        return result

    featured = await run_featured_image_once()
    result = {
        "status": "combined",
        "draft": draft,
        "featured": featured,
    }
    await _maybe_send_status(result, send_status)
    return result


def format_result(result: dict) -> str:
    draft = result.get("draft") or {}
    featured = result.get("featured") or {}
    lines = ["Medium image maintenance"]

    lines.append("")
    lines.append(format_draft_result(draft))

    lines.append("")
    featured_status = featured.get("status")
    if featured_status == "updated":
        lines.append("Featured image backfill: updated")
        lines.append(f"Post: {featured.get('url')}")
        lines.append(f"Remaining: {featured.get('remaining')}")
    elif featured_status == "retry_later":
        lines.append("Featured image backfill: retry later")
        lines.append(f"Title: {featured.get('title')}")
        lines.append(f"Reason: {featured.get('error')}")
    elif featured_status == "nothing_to_do":
        lines.append("Featured image backfill: nothing to do")
    elif featured_status == "skipped":
        lines.append("Featured image backfill: skipped")
        lines.append(f"Reason: {featured.get('reason')}")
    else:
        lines.append(f"Featured image backfill: {featured_status}")

    return "\n".join(lines)[:4096]


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
                "text": format_result(result),
            },
        )
        if resp.status_code != 200:
            log.error("Telegram API error %d: %s", resp.status_code, resp.text[:500])


def main() -> None:
    logging.basicConfig(
        level=config.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    result = asyncio.run(run_once(send_status=True))
    print("MEDIUM_IMAGE_MAINTENANCE_START")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print("MEDIUM_IMAGE_MAINTENANCE_END")


if __name__ == "__main__":
    main()
