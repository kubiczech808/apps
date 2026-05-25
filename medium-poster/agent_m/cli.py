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
    if result.platform_urls:
        for pname, purl in result.platform_urls.items():
            summary += f"{pname}: {purl}\n"
    elif result.post_url:
        summary += f"URL: {result.post_url}\n"
    if result.platform_errors:
        summary += "\nIssues:\n"
        for err in result.platform_errors[:4]:
            summary += f"- {err[:200]}\n"
    if result.image_model:
        summary += f"Image: {result.image_model}\n"
    summary += f"Tokens: {result.tokens_used}"

    await send_telegram(summary, result.image_bytes)

    print("AGENT_M_RESULT_START")
    print(f"Title: {result.article.title}")
    print(f"Published to: {platforms}")
    if result.platform_urls:
        for pname, purl in result.platform_urls.items():
            print(f"{pname}: {purl}")
    elif result.post_url:
        print(f"URL: {result.post_url}")
    if result.platform_errors:
        print("Platform issues:")
        for err in result.platform_errors[:6]:
            print(f"- {err[:240]}")
    print(f"Tokens: {result.tokens_used}")
    print("AGENT_M_RESULT_END")


def _import_medium_cookies() -> None:
    import json
    from pathlib import Path

    cookies_path = config.data_dir / "medium_cookies.json"
    print("Vlož JSON cookies z Cookie-Editor rozšíření (Chrome/Firefox).")
    print("Po vložení stiskni Enter na prázdném řádku.\n")

    lines = []
    while True:
        try:
            line = input()
        except EOFError:
            break
        if not line.strip() and lines:
            try:
                json.loads("\n".join(lines))
                break
            except json.JSONDecodeError:
                pass
        lines.append(line)

    raw = json.loads("\n".join(lines))

    pw_cookies = []
    for c in raw:
        pc = {
            "name": c["name"],
            "value": c["value"],
            "domain": c.get("domain", ".medium.com"),
            "path": c.get("path", "/"),
            "httpOnly": c.get("httpOnly", False),
            "secure": c.get("secure", True),
        }
        if "expirationDate" in c:
            pc["expires"] = c["expirationDate"]
        elif "expires" in c:
            pc["expires"] = c["expires"]
        same_site = c.get("sameSite", "None")
        mapping = {"no_restriction": "None", "lax": "Lax", "strict": "Strict"}
        pc["sameSite"] = mapping.get(same_site, same_site)
        pw_cookies.append(pc)

    cookies_path.parent.mkdir(parents=True, exist_ok=True)
    cookies_path.write_text(json.dumps(pw_cookies, indent=2))
    print(f"\nUloženo {len(pw_cookies)} cookies do {cookies_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Agent M — one-shot publish")
    parser.add_argument("mode", choices=["post", "draft", "preview", "update-links", "medium-login", "medium-import-cookies", "hashnode-login"], default="draft", nargs="?")
    parser.add_argument("--slug", help="Specific topic slug from content plan")
    args = parser.parse_args()

    logging.basicConfig(
        level=config.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    if args.mode == "update-links":
        from agent_m.update_links import main as update_main
        update_main()
    elif args.mode == "medium-login":
        from agent_m.publishers.medium_playwright import MediumPlaywrightPublisher
        asyncio.run(MediumPlaywrightPublisher().login())
    elif args.mode == "medium-import-cookies":
        _import_medium_cookies()
    elif args.mode == "hashnode-login":
        from agent_m.publishers.hashnode_playwright import HashnodePlaywrightPublisher
        asyncio.run(HashnodePlaywrightPublisher().login())
    else:
        asyncio.run(run(mode=args.mode, slug=args.slug))


if __name__ == "__main__":
    main()
