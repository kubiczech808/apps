from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from agent_m.config import config

log = logging.getLogger(__name__)

_COOKIES_FILE = config.data_dir / "medium_cookies.json"


class MediumPlaywrightPublisher:
    """Publishes articles to Medium via browser automation (Playwright).

    First run requires manual login — use `login()` to open a browser,
    log in manually, then cookies are saved for future headless sessions.
    """

    async def login(self) -> None:
        from playwright.async_api import async_playwright

        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=False,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-infobars",
                ],
            )
            context = await browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
                ),
                viewport={"width": 1280, "height": 800},
            )
            await context.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            )
            page = await context.new_page()

            await page.goto("https://medium.com/m/signin")
            print("\n>>> Přihlaš se do Medium v prohlížeči.")
            print(">>> Až budeš přihlášen/a a uvidíš svůj feed, stiskni Enter zde...")

            await asyncio.get_event_loop().run_in_executor(None, input)

            await asyncio.sleep(2)
            cookies = await context.cookies()
            _COOKIES_FILE.parent.mkdir(parents=True, exist_ok=True)
            _COOKIES_FILE.write_text(json.dumps(cookies, indent=2))
            print(f">>> Cookies uloženy: {_COOKIES_FILE}")
            log.info("Cookies saved to %s", _COOKIES_FILE)

            await browser.close()

    async def publish(
        self,
        title: str,
        body_markdown: str,
        tags: list[str],
        publish: bool = True,
    ) -> str | None:
        if not _COOKIES_FILE.exists():
            raise RuntimeError(
                "No Medium cookies found. Run the bot with /medium_login first "
                "to save your session."
            )

        from playwright.async_api import async_playwright

        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                ],
            )
            context = await browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
                ),
            )
            await context.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            )

            cookies = json.loads(_COOKIES_FILE.read_text())
            await context.add_cookies(cookies)

            page = await context.new_page()

            try:
                url = await self._create_story(page, title, body_markdown, tags, publish)
                return url
            except Exception:
                log.exception("Medium Playwright publish failed")
                try:
                    screenshot_path = config.data_dir / "medium_error.png"
                    await page.screenshot(path=str(screenshot_path))
                    log.error("Screenshot saved: %s", screenshot_path)
                except Exception:
                    pass
                raise
            finally:
                await browser.close()

    async def _create_story(
        self,
        page,
        title: str,
        body_markdown: str,
        tags: list[str],
        publish: bool,
    ) -> str | None:
        await page.goto("https://medium.com/new-story", wait_until="networkidle")
        await asyncio.sleep(5)

        log.info("Medium: page URL after nav: %s", page.url)

        if "signin" in page.url.lower() or "login" in page.url.lower():
            raise RuntimeError("Session expired — cookies are invalid. Run /medium_login again.")

        title_field = await self._find_title_field(page)
        await title_field.click()
        await asyncio.sleep(0.5)
        await page.keyboard.type(title, delay=20)
        await page.keyboard.press("Enter")
        await asyncio.sleep(1)

        paragraphs = body_markdown.split("\n\n")
        for para in paragraphs:
            if not para.strip():
                continue
            await page.keyboard.type(para.strip(), delay=5)
            await page.keyboard.press("Enter")
            await page.keyboard.press("Enter")
            await asyncio.sleep(0.3)

        await asyncio.sleep(2)

        if not publish:
            log.info("Medium: draft saved (not published)")
            return page.url

        publish_btn = page.locator('button:has-text("Publish")').first
        if await publish_btn.is_visible(timeout=5000):
            await publish_btn.click()
            await asyncio.sleep(2)

            for tag in tags[:5]:
                tag_input = page.locator('input[placeholder*="tag" i]').first
                try:
                    if await tag_input.is_visible(timeout=2000):
                        await tag_input.fill(tag)
                        await asyncio.sleep(1)
                        await page.keyboard.press("Enter")
                        await asyncio.sleep(0.5)
                except Exception:
                    break

            final_publish = page.locator('button:has-text("Publish now")').or_(
                page.locator('button:has-text("Publish")').last
            )
            if await final_publish.is_visible(timeout=5000):
                await final_publish.click()
                await asyncio.sleep(5)

            log.info("Medium: published at %s", page.url)
            return page.url

        log.warning("Medium: publish button not found, draft saved")
        return page.url

    async def _find_title_field(self, page):
        selectors = [
            '[data-testid="title"]',
            'h3[data-contents="true"]',
            'h4[data-contents="true"]',
            'p[data-placeholder*="Title" i]',
            'div[data-placeholder*="Title" i]',
            '[role="textbox"][data-placeholder*="title" i]',
            'h3[contenteditable="true"]',
            'h4[contenteditable="true"]',
        ]
        for sel in selectors:
            loc = page.locator(sel).first
            if await loc.is_visible(timeout=1000):
                log.info("Medium: title field found via %s", sel)
                return loc

        all_editable = page.locator('[contenteditable="true"]')
        count = await all_editable.count()
        log.info("Medium: no specific title selector matched, found %d contenteditable elements", count)
        if count > 0:
            return all_editable.first

        html = await page.content()
        log.error("Medium: no editable field found. Page snippet: %s", html[:2000])
        raise RuntimeError("Medium: no title field found on new-story page")

    async def close(self) -> None:
        pass
