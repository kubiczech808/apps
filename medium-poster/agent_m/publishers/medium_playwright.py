from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import subprocess
import time

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
    _xvfb_proc: subprocess.Popen | None = None
    _xvfb_display: str | None = None

    async def login(self) -> None:
        from playwright.async_api import async_playwright

        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=False,
                channel="chrome",
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-infobars",
                ],
            )
            context = await browser.new_context(
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

        self._ensure_display()

        from playwright.async_api import async_playwright

        try:
            async with async_playwright() as p:
                use_headless = not os.environ.get("DISPLAY")
                if use_headless:
                    log.warning("Medium: no DISPLAY, using headless mode (editor may not load)")

                browser = await p.chromium.launch(
                    headless=use_headless,
                    channel="chrome",
                    args=[
                        "--disable-blink-features=AutomationControlled",
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                        "--disable-gpu",
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
        finally:
            self._cleanup_display()

    @staticmethod
    async def _human_delay(min_s: float = 2, max_s: float = 5) -> None:
        await asyncio.sleep(random.uniform(min_s, max_s))

    @classmethod
    def _ensure_display(cls):
        if os.environ.get("DISPLAY"):
            return
        for display_num in range(99, 110):
            display = f":{display_num}"
            try:
                proc = subprocess.Popen(
                    ["Xvfb", display, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                time.sleep(0.5)
                if proc.poll() is None:
                    os.environ["DISPLAY"] = display
                    cls._xvfb_proc = proc
                    cls._xvfb_display = display
                    log.info("Started Xvfb on display %s (PID %d)", display, proc.pid)
                    return
            except FileNotFoundError:
                log.warning("Xvfb not found — install with: sudo apt install xvfb")
                return
            except Exception:
                continue

    @classmethod
    def _cleanup_display(cls):
        if cls._xvfb_proc:
            cls._xvfb_proc.terminate()
            try:
                cls._xvfb_proc.wait(timeout=5)
            except Exception:
                cls._xvfb_proc.kill()
            cls._xvfb_proc = None
            if cls._xvfb_display and os.environ.get("DISPLAY") == cls._xvfb_display:
                del os.environ["DISPLAY"]
            cls._xvfb_display = None

    async def _create_story(
        self,
        page,
        title: str,
        body_markdown: str,
        tags: list[str],
        publish: bool,
    ) -> str | None:
        await page.goto("https://medium.com", wait_until="domcontentloaded", timeout=60000)
        await self._human_delay(3, 6)

        page_url = page.url
        log.info("Medium: homepage URL: %s", page_url)

        if "signin" in page_url.lower() or "login" in page_url.lower():
            raise RuntimeError("Session expired — cookies are invalid. Run /medium_login again.")

        write_btn = (
            page.locator('a:has-text("Write")')
            .or_(page.locator('button:has-text("Write")'))
            .or_(page.locator('a[href*="new-story"]'))
        )
        try:
            if await write_btn.first.is_visible(timeout=5000):
                log.info("Medium: clicking Write button")
                await write_btn.first.click()
                await self._human_delay(3, 6)
            else:
                raise Exception("Write button not visible")
        except Exception:
            log.info("Medium: Write button not found, navigating directly to new-story")
            await page.goto(
                "https://medium.com/new-story",
                wait_until="domcontentloaded",
                timeout=60000,
            )
            await self._human_delay(3, 6)

        page_url = page.url
        page_title = await page.title()
        log.info("Medium: editor page URL: %s", page_url)
        log.info("Medium: editor page title: %s", page_title)

        if "signin" in page_url.lower() or "login" in page_url.lower():
            raise RuntimeError("Session expired — cookies are invalid. Run /medium_login again.")

        await self._wait_for_editor(page)
        await self._human_delay(1, 3)

        title_field = await self._find_title_field(page)
        await title_field.click()
        await self._human_delay(1, 2)
        await page.keyboard.type(title, delay=random.randint(40, 80))
        await self._human_delay(2, 4)
        await page.keyboard.press("Enter")
        await self._human_delay(1, 2)

        pasted = await page.evaluate("""(text) => {
            const el = document.querySelector('.ProseMirror')
                || document.querySelector('[contenteditable]:not([contenteditable="false"])')
                || document.activeElement;
            if (!el) return false;
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            const ev = new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true});
            el.dispatchEvent(ev);
            return true;
        }""", body_markdown)

        if pasted:
            log.info("Medium: pasted %d chars via ClipboardEvent", len(body_markdown))
        else:
            log.warning("Medium: ClipboardEvent paste failed, falling back to keyboard typing")
            for para in body_markdown.split("\n\n"):
                para = para.strip()
                if not para:
                    continue
                await page.keyboard.type(para, delay=random.randint(3, 8))
                await page.keyboard.press("Enter")
                await page.keyboard.press("Enter")
                await self._human_delay(0.3, 0.8)

        await self._human_delay(8, 15)
        log.info("Medium: review pause before publish")

        await page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
        await self._human_delay(2, 4)
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await self._human_delay(2, 3)
        await page.evaluate("window.scrollTo(0, 0)")
        await self._human_delay(2, 3)

        if not publish:
            log.info("Medium: draft saved (not published)")
            return page.url

        publish_btn = page.locator('button:has-text("Publish")').first
        try:
            if await publish_btn.is_visible(timeout=5000):
                await publish_btn.click()
                await self._human_delay(3, 5)

                for tag in tags[:5]:
                    tag_input = page.locator('input[placeholder*="tag" i]').first
                    try:
                        if await tag_input.is_visible(timeout=2000):
                            await tag_input.fill(tag)
                            await self._human_delay(1, 2)
                            await page.keyboard.press("Enter")
                            await self._human_delay(0.5, 1)
                    except Exception:
                        break

                final_publish = page.locator('button:has-text("Publish now")').or_(
                    page.locator('button:has-text("Publish")').last
                )
                if await final_publish.is_visible(timeout=5000):
                    await final_publish.click()
                    await self._human_delay(5, 8)

                log.info("Medium: published at %s", page.url)
                return page.url
        except Exception as exc:
            log.warning("Medium: publish flow failed: %s", exc)

        log.warning("Medium: publish button not found, draft saved")
        return page.url

    async def _wait_for_editor(self, page) -> None:
        editor_sel = (
            '[contenteditable]:not([contenteditable="false"]), '
            'textarea, [role="textbox"], .ProseMirror'
        )
        try:
            await page.wait_for_selector(editor_sel, state="visible", timeout=30000)
            log.info("Medium: editor element detected")
        except Exception:
            await self._dump_page_diagnostics(page, "editor_wait_timeout")
            raise RuntimeError(
                "Medium: editor did not load within 30s. "
                "Ensure Xvfb is installed (sudo apt install xvfb) for headed mode."
            )

    async def _dump_page_diagnostics(self, page, context: str) -> None:
        try:
            log.error("Medium DIAG [%s]: URL = %s", context, page.url)
            log.error("Medium DIAG [%s]: title = %s", context, await page.title())
            for sel in [
                '[contenteditable]',
                '[contenteditable="true"]',
                '[contenteditable=""]',
                '.ProseMirror',
                'textarea',
                '[role="textbox"]',
                '[data-testid="title"]',
            ]:
                try:
                    n = await page.locator(sel).count()
                    log.error("Medium DIAG [%s]: %s count=%d", context, sel, n)
                except Exception:
                    pass
            html = await page.content()
            log.error("Medium DIAG [%s]: HTML[0:3000] = %s", context, html[:3000])
            screenshot_path = config.data_dir / f"medium_{context}.png"
            await page.screenshot(path=str(screenshot_path), full_page=True)
            log.error("Medium DIAG [%s]: screenshot saved: %s", context, screenshot_path)
        except Exception as exc:
            log.error("Medium DIAG [%s]: dump failed: %s", context, exc)

    async def _find_title_field(self, page):
        selectors = [
            'p[data-placeholder*="Title" i]',
            'div[data-placeholder*="Title" i]',
            '[data-testid="title"]',
            'h3[data-contents="true"]',
            'h4[data-contents="true"]',
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

        all_editable = page.locator('[contenteditable]:not([contenteditable="false"])')
        count = await all_editable.count()
        log.info("Medium: no specific title selector matched, found %d contenteditable elements", count)
        if count > 0:
            return all_editable.first

        await self._dump_page_diagnostics(page, "no_title_field")
        raise RuntimeError("Medium: no title field found on new-story page")

    async def close(self) -> None:
        pass
