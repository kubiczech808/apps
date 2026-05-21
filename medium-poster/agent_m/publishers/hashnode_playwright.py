from __future__ import annotations

import asyncio
import json
import logging

from agent_m.config import config

log = logging.getLogger(__name__)

_COOKIES_FILE = config.data_dir / "hashnode_cookies.json"
_WRITE_URL = "https://hashnode.com/draft"

_STEALTH_SCRIPTS = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
window.chrome = {runtime: {}};
"""


class HashnodePlaywrightPublisher:
    """Publishes articles to Hashnode via browser automation.

    First run requires manual login — use login() to open a browser,
    log in to Hashnode, then cookies are saved for future headless sessions.
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

            await page.goto("https://hashnode.com")
            print("\n>>> Přihlaš se do Hashnode v prohlížeči.")
            print(">>> Až budeš přihlášen/a a uvidíš svůj dashboard, stiskni Enter zde...")

            await asyncio.get_event_loop().run_in_executor(None, input)

            await asyncio.sleep(2)
            cookies = await context.cookies()
            _COOKIES_FILE.parent.mkdir(parents=True, exist_ok=True)
            _COOKIES_FILE.write_text(json.dumps(cookies, indent=2))
            print(f">>> Cookies uloženy: {_COOKIES_FILE}")
            log.info("Hashnode cookies saved to %s", _COOKIES_FILE)
            await browser.close()

    async def publish(
        self,
        title: str,
        body_markdown: str,
        tags: list[str],
        canonical_url: str | None = None,
        cover_image_url: str | None = None,
    ) -> str | None:
        if not _COOKIES_FILE.exists():
            raise RuntimeError(
                "No Hashnode cookies found. Run the bot with /hashnode_login first."
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
                url = await self._create_post(page, title, body_markdown, tags, canonical_url, cover_image_url)
                return url
            except Exception:
                log.exception("Hashnode Playwright publish failed")
                try:
                    screenshot_path = config.data_dir / "hashnode_error.png"
                    await page.screenshot(path=str(screenshot_path), full_page=True)
                    log.error("Screenshot saved: %s", screenshot_path)
                except Exception:
                    pass
                raise
            finally:
                await browser.close()

    async def _create_post(
        self,
        page,
        title: str,
        body_markdown: str,
        tags: list[str],
        canonical_url: str | None,
        cover_image_url: str | None,
    ) -> str | None:
        await page.goto(_WRITE_URL, wait_until="networkidle")

        page_url = page.url
        page_title = await page.title()
        log.info("Hashnode: page URL after nav: %s", page_url)
        log.info("Hashnode: page title: %s", page_title)

        if "signin" in page_url.lower() or "login" in page_url.lower():
            raise RuntimeError("Hashnode session expired — run /hashnode_login again.")

        if "user not found" in page_title.lower() or page_url.rstrip("/") != _WRITE_URL.rstrip("/"):
            raise RuntimeError(
                f"Hashnode cookies expired — got '{page_title}' at {page_url}. "
                "Run /hashnode_login to refresh cookies and update HASHNODE_COOKIES secret."
            )

        await self._wait_for_editor(page)

        title_field = await self._find_title_field(page)
        await title_field.click()
        await asyncio.sleep(0.3)
        await page.keyboard.type(title, delay=20)
        await asyncio.sleep(0.5)

        await page.keyboard.press("Tab")
        await asyncio.sleep(0.5)

        editor = (
            page.locator('.ProseMirror')
            .or_(page.locator('[role="textbox"]').last)
            .or_(page.locator('div[contenteditable="true"]').last)
        )
        try:
            await editor.click(timeout=5000)
        except Exception:
            log.warning("Hashnode: editor click failed, typing anyway")
        await asyncio.sleep(0.5)

        for para in body_markdown.split("\n\n"):
            para = para.strip()
            if not para:
                continue
            await page.keyboard.type(para, delay=2)
            await page.keyboard.press("Enter")
            await page.keyboard.press("Enter")
            await asyncio.sleep(0.1)

        await asyncio.sleep(2)

        publish_btn = (
            page.locator('button:has-text("Publish")')
            .or_(page.locator('button[aria-label*="Publish" i]'))
            .first
        )
        if await publish_btn.is_visible(timeout=5000):
            await publish_btn.click()
            await asyncio.sleep(2)
        else:
            log.warning("Hashnode: Publish button not found, trying to proceed anyway")

        if cover_image_url:
            await self._set_cover_image(page, cover_image_url)

        await self._add_tags(page, tags)

        if canonical_url:
            await self._set_canonical_url(page, canonical_url)

        final_btn = (
            page.locator('button:has-text("Publish now")')
            .or_(page.locator('button:has-text("Publish post")'))
            .or_(page.locator('button[type="submit"]:has-text("Publish")'))
            .first
        )
        if await final_btn.is_visible(timeout=5000):
            await final_btn.click()
            await asyncio.sleep(5)
            log.info("Hashnode: published at %s", page.url)
        else:
            log.warning("Hashnode: final Publish button not found, draft may have been saved")

        return page.url

    async def _wait_for_editor(self, page) -> None:
        """Wait for the editor to fully load (SPA hydration)."""
        editor_sel = '[contenteditable="true"], textarea, [role="textbox"], .ProseMirror'
        try:
            await page.wait_for_selector(editor_sel, state="visible", timeout=30000)
            log.info("Hashnode: editor element detected after wait")
        except Exception:
            await self._dump_page_diagnostics(page, "editor_wait_timeout")
            raise RuntimeError(
                "Hashnode: editor did not load within 30s — page may be blocked or cookies expired"
            )

    async def _dump_page_diagnostics(self, page, context: str) -> None:
        """Log page state for debugging."""
        try:
            log.error("Hashnode DIAG [%s]: URL = %s", context, page.url)
            log.error("Hashnode DIAG [%s]: title = %s", context, await page.title())
            html = await page.content()
            for i in range(0, min(len(html), 6000), 2000):
                chunk = html[i:i + 2000]
                log.error("Hashnode DIAG [%s]: HTML[%d:%d] = %s", context, i, i + 2000, chunk)
            screenshot_path = config.data_dir / f"hashnode_{context}.png"
            await page.screenshot(path=str(screenshot_path), full_page=True)
            log.error("Hashnode DIAG [%s]: screenshot saved: %s", context, screenshot_path)
        except Exception as exc:
            log.error("Hashnode DIAG [%s]: dump failed: %s", context, exc)

    async def _find_title_field(self, page):
        selectors = [
            'textarea[placeholder*="title" i]',
            'div[contenteditable="true"][data-placeholder*="title" i]',
            '[data-testid="post-title"]',
            'h1[contenteditable="true"]',
            'input[placeholder*="title" i]',
            '[data-placeholder*="title" i]',
        ]
        for sel in selectors:
            loc = page.locator(sel).first
            try:
                if await loc.is_visible(timeout=3000):
                    log.info("Hashnode: title field found via %s", sel)
                    return loc
            except Exception:
                continue

        all_editable = page.locator('[contenteditable="true"]')
        count = await all_editable.count()
        log.info("Hashnode: no specific title selector matched, found %d contenteditable elements", count)
        if count > 0:
            return all_editable.first

        await self._dump_page_diagnostics(page, "no_title_field")
        raise RuntimeError("Hashnode: no title field found on draft page")

    async def _add_tags(self, page, tags: list[str]) -> None:
        tag_input = (
            page.locator('input[placeholder*="tag" i]')
            .or_(page.locator('input[placeholder*="Add tag" i]'))
            .first
        )
        for tag in tags[:5]:
            try:
                if await tag_input.is_visible(timeout=2000):
                    await tag_input.fill(tag)
                    await asyncio.sleep(0.5)
                    suggestion = page.locator(f'[role="option"]:has-text("{tag}")').first
                    if await suggestion.is_visible(timeout=1000):
                        await suggestion.click()
                    else:
                        await page.keyboard.press("Enter")
                    await asyncio.sleep(0.5)
            except Exception as exc:
                log.debug("Hashnode tag input failed for %r: %s", tag, exc)

    async def _set_canonical_url(self, page, canonical_url: str) -> None:
        try:
            for label in ["SEO", "Advanced", "seo"]:
                toggle = page.locator(f'button:has-text("{label}"), [aria-label="{label}"]').first
                if await toggle.is_visible(timeout=1000):
                    await toggle.click()
                    await asyncio.sleep(1)
                    break

            canonical_input = (
                page.locator('input[placeholder*="canonical" i]')
                .or_(page.locator('input[placeholder*="original article" i]'))
                .first
            )
            if await canonical_input.is_visible(timeout=2000):
                await canonical_input.fill(canonical_url)
                await asyncio.sleep(0.3)
        except Exception as exc:
            log.debug("Hashnode canonical URL set failed: %s", exc)

    async def _set_cover_image(self, page, cover_image_url: str) -> None:
        try:
            cover_btn = (
                page.locator('button:has-text("Add cover")')
                .or_(page.locator('button:has-text("Cover")')
                .or_(page.locator('[aria-label*="cover" i]')))
                .first
            )
            if await cover_btn.is_visible(timeout=2000):
                await cover_btn.click()
                await asyncio.sleep(1)

            url_input = (
                page.locator('input[placeholder*="image URL" i]')
                .or_(page.locator('input[placeholder*="paste" i]'))
                .or_(page.locator('input[type="url"]'))
                .first
            )
            if await url_input.is_visible(timeout=2000):
                await url_input.fill(cover_image_url)
                await page.keyboard.press("Enter")
                await asyncio.sleep(1)
        except Exception as exc:
            log.debug("Hashnode cover image set failed: %s", exc)

    async def close(self) -> None:
        pass
