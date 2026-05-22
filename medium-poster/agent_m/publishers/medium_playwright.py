from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from agent_m.config import config

log = logging.getLogger(__name__)

_COOKIES_FILE = config.data_dir / "medium_cookies.json"

_STEALTH_SCRIPTS = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
window.chrome = {runtime: {}};
"""


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
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
                ),
                viewport={"width": 1280, "height": 800},
            )
            await context.add_init_script(_STEALTH_SCRIPTS)
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
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                ],
            )
            context = await browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
                ),
                viewport={"width": 1280, "height": 800},
            )
            await context.add_init_script(_STEALTH_SCRIPTS)

            cookies = json.loads(_COOKIES_FILE.read_text())
            await context.add_cookies(cookies)

            page = await context.new_page()
            try:
                from playwright_stealth import stealth_async
                await stealth_async(page)
            except Exception as exc:
                log.debug("playwright-stealth not available: %s", exc)

            try:
                url = await self._create_story(page, title, body_markdown, tags, publish)
                return url
            except Exception:
                log.exception("Medium Playwright publish failed")
                try:
                    screenshot_path = config.data_dir / "medium_error.png"
                    await page.screenshot(path=str(screenshot_path), full_page=True)
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

        page_url = page.url
        page_title = await page.title()
        log.info("Medium: page URL after nav: %s", page_url)
        log.info("Medium: page title: %s", page_title)

        if "signin" in page_url.lower() or "login" in page_url.lower():
            raise RuntimeError("Session expired — cookies are invalid. Run /medium_login again.")

        if "new-story" not in page_url.lower():
            raise RuntimeError(
                f"Medium cookies expired — redirected to {page_url} ('{page_title}'). "
                "Run /medium_login to refresh cookies and update MEDIUM_COOKIES secret."
            )

        await self._wait_for_editor(page)

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

    async def _wait_for_editor(self, page) -> None:
        """Wait for the editor to fully load (SPA hydration)."""
        editor_sel = '[contenteditable="true"], textarea, [role="textbox"], .ProseMirror'
        try:
            await page.wait_for_selector(editor_sel, state="visible", timeout=30000)
            log.info("Medium: editor element detected after wait")
        except Exception:
            await self._dump_page_diagnostics(page, "editor_wait_timeout")
            raise RuntimeError(
                "Medium: editor did not load within 30s — page may be blocked or cookies expired"
            )

    async def _dump_page_diagnostics(self, page, context: str) -> None:
        """Log page state for debugging."""
        try:
            log.error("Medium DIAG [%s]: URL = %s", context, page.url)
            log.error("Medium DIAG [%s]: title = %s", context, await page.title())
            html = await page.content()
            for i in range(0, min(len(html), 6000), 2000):
                chunk = html[i:i + 2000]
                log.error("Medium DIAG [%s]: HTML[%d:%d] = %s", context, i, i + 2000, chunk)
            screenshot_path = config.data_dir / f"medium_{context}.png"
            await page.screenshot(path=str(screenshot_path), full_page=True)
            log.error("Medium DIAG [%s]: screenshot saved: %s", context, screenshot_path)
        except Exception as exc:
            log.error("Medium DIAG [%s]: dump failed: %s", context, exc)

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
            try:
                if await loc.is_visible(timeout=3000):
                    log.info("Medium: title field found via %s", sel)
                    return loc
            except Exception:
                continue

        all_editable = page.locator('[contenteditable="true"]')
        count = await all_editable.count()
        log.info("Medium: no specific title selector matched, found %d contenteditable elements", count)
        if count > 0:
            return all_editable.first

        await self._dump_page_diagnostics(page, "no_title_field")
        raise RuntimeError("Medium: no title field found on new-story page")

    async def close(self) -> None:
        pass
