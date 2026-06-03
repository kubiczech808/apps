from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from agent_m.config import config
from agent_m.gemini.imager import generate_header_image
from agent_m.gemini.researcher import Topic
from agent_m.publishers.medium_playwright import MediumPlaywrightPublisher

log = logging.getLogger(__name__)

_STATE_FILE = config.data_dir / "medium_featured_images.json"


async def run_once() -> dict:
    state = _read_state(_STATE_FILE)
    processed = state.setdefault("processed", {})

    publisher = MediumPlaywrightPublisher()
    posts = await publisher.list_published_posts()
    pending = [
        post for post in posts
        if not post.get("images") and processed.get(post.get("postId"), {}).get("status") != "done"
    ]

    if not pending:
        result = {
            "status": "nothing_to_do",
            "total_posts": len(posts),
            "processed": len(processed),
        }
        log.info("Medium featured image backfill: %s", result)
        return result

    post = pending[0]
    post_id = post["postId"]
    title = _clean_title(post.get("title") or post_id)
    log.info("Medium featured image backfill: processing %s: %s", post_id, title)

    topic = Topic(
        title=title,
        angle=(
            "Create a calm editorial hero image for a Bitcoin DCA article. "
            "Show automated recurring purchases, portfolio balance, and long-term investing discipline."
        ),
        tags=["Bitcoin", "DCA", "Investing"],
        slug=f"medium-{post_id}",
    )
    try:
        image_bytes, image_model = await generate_header_image(topic)
    except Exception as exc:
        processed[post_id] = {
            "status": "retry_later",
            "title": title,
            "error": str(exc),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        state["last_run_at"] = datetime.now(timezone.utc).isoformat()
        _write_state(_STATE_FILE, state)
        result = {
            "status": "retry_later",
            "post_id": post_id,
            "title": title,
            "error": str(exc),
            "remaining": len(pending),
        }
        log.warning("Medium featured image backfill deferred: %s", result)
        return result

    url = await publisher.add_featured_image_to_post(post_id, image_bytes)

    processed[post_id] = {
        "status": "done",
        "title": title,
        "url": url,
        "image_model": image_model,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    state["last_run_at"] = datetime.now(timezone.utc).isoformat()
    _write_state(_STATE_FILE, state)

    result = {
        "status": "updated",
        "post_id": post_id,
        "title": title,
        "url": url,
        "image_model": image_model,
        "remaining": max(0, len(pending) - 1),
    }
    log.info("Medium featured image backfill result: %s", result)
    return result


def _read_state(path: Path) -> dict:
    if not path.exists():
        return {"processed": {}}
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        backup = path.with_suffix(".json.bak")
        path.rename(backup)
        return {"processed": {}}


def _write_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def _clean_title(title: str) -> str:
    title = " ".join(title.replace("\n", " ").split())
    return title.rstrip("…").strip() or "Bitcoin DCA strategy"


def main() -> None:
    logging.basicConfig(
        level=config.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    result = asyncio.run(run_once())
    print("MEDIUM_FEATURED_IMAGE_BACKFILL_START")
    for key, value in result.items():
        print(f"{key}: {value}")
    print("MEDIUM_FEATURED_IMAGE_BACKFILL_END")


if __name__ == "__main__":
    main()
