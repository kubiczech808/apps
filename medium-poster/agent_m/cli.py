"""One-shot CLI: run pipeline once, send result to Telegram, exit."""
from __future__ import annotations

import argparse
import asyncio
import io
import logging
import sys

import httpx

from agent_m.config import config
from agent_m.pipeline import run_pipeline


async def send_telegram(text: str, image_bytes: bytes | None = None) -> None:
    url = f"https://api.telegram.org/bot{config.telegram_bot_token}"
    log = logging.getLogger(__name__)
    async with httpx.AsyncClient(timeout=30.0) as client:
        if image_bytes:
            resp = await client.post(
                f"{url}/sendPhoto",
                data={
                    "chat_id": config.telegram_admin_chat_id,
                    "caption": text[:1024],
                },
                files={"photo": ("image.jpg", io.BytesIO(image_bytes), "image/jpeg")},
            )
        else:
            resp = await client.post(
                f"{url}/sendMessage",
                json={
                    "chat_id": config.telegram_admin_chat_id,
                    "text": text[:4096],
                },
            )
        if resp.status_code != 200:
            log.error("Telegram API error %d: %s", resp.status_code, resp.text[:500])


async def run(mode: str, slug: str | None) -> None:
    try:
        result = await run_pipeline(mode=mode, slug=slug)
    except Exception as e:
        logging.getLogger(__name__).error("Pipeline failed: %s", e, exc_info=True)
        await send_telegram(f"Agent M pipeline failed:\n{e}")
        sys.exit(1)

    platforms = ", ".join(result.published_to) if result.published_to else "none"
    summary = (
        f"Agent M — {mode}\n\n"
        f"Title: {result.article.title}\n"
        f"Platforms: {platforms}\n"
    )
    if result.post_url:
        summary += f"URL: {result.post_url}\n"
    if result.platform_errors:
        summary += "\nPlatform issues:\n"
        for err in result.platform_errors[:6]:
            summary += f"- {err[:240]}\n"
    summary += f"Tokens: {result.tokens_used}"

    await send_telegram(summary, result.image_bytes)

    print("AGENT_M_RESULT_START")
    print(f"Title: {result.article.title}")
    print(f"Published to: {platforms}")
    if result.post_url:
        print(f"URL: {result.post_url}")
    if result.platform_errors:
        print("Platform issues:")
        for err in result.platform_errors[:6]:
            print(f"- {err[:240]}")
    print(f"Tokens: {result.tokens_used}")
    print("AGENT_M_RESULT_END")


def main() -> None:
    parser = argparse.ArgumentParser(description="Agent M — one-shot publish")
    parser.add_argument("mode", choices=["post", "draft", "preview"], default="draft", nargs="?")
    parser.add_argument("--slug", help="Specific topic slug from content plan")
    args = parser.parse_args()

    logging.basicConfig(
        level=config.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    # Suppress httpx/httpcore request logs to avoid exposing tokens in URLs
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    asyncio.run(run(mode=args.mode, slug=args.slug))


if __name__ == "__main__":
    main()
