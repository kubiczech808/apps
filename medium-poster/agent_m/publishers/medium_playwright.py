from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
import subprocess
import time
from pathlib import Path

from agent_m.config import config

log = logging.getLogger(__name__)

_COOKIES_FILE = config.data_dir / "medium_cookies.json"


class MediumPlaywrightPublisher:
    _xvfb_proc: subprocess.Popen | None = None
    _xvfb_display: str | None = None

    async def login(self) -> None:
        from playwright.async_api import async_playwright
        from playwright_stealth import Stealth

        self._ensure_display()
        stealth = self._make_stealth()

        try:
            async with stealth.use_async(async_playwright()) as p:
                browser = await p.chromium.launch(
                    headless=False,
                    args=self._browser_args(),
                )
                context = await browser.new_context(
                    user_agent=self._user_agent(),
                    viewport={"width": 1280, "height": 800},
                    locale="en-US",
                    timezone_id="Europe/Prague",
                    extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
                )
                await stealth.apply_stealth_async(context)
                page = await context.new_page()

                await page.goto("https://medium.com/m/signin", wait_until="domcontentloaded")
                print("\n>>> Prihlas se do Medium v prohlizeci.")
                print(">>> Az bude prihlaseni hotove a uvidis feed, stiskni Enter zde...")

                await asyncio.get_event_loop().run_in_executor(None, input)
                await asyncio.sleep(2)

                cookies = await context.cookies()
                _COOKIES_FILE.parent.mkdir(parents=True, exist_ok=True)
                _COOKIES_FILE.write_text(json.dumps(self._normalize_cookies(cookies), indent=2))
                log.info("Cookies saved to %s", _COOKIES_FILE)
                print(f">>> Cookies ulozeny: {_COOKIES_FILE}")

                await browser.close()
        finally:
            self._cleanup_display()

    async def publish(
        self,
        title: str,
        body_markdown: str,
        tags: list[str],
        publish: bool = True,
    ) -> str | None:
        if not _COOKIES_FILE.exists():
            raise RuntimeError(
                "No Medium cookies found. Send a Cookie-Editor JSON export to the bot first."
            )

        self._ensure_display()

        from playwright.async_api import async_playwright

        try:
            from playwright_stealth import Stealth

            stealth = self._make_stealth()
            async with stealth.use_async(async_playwright()) as p:
                browser = await p.chromium.launch(
                    headless=False,
                    args=self._browser_args(),
                )
                context = await browser.new_context(
                    user_agent=self._user_agent(),
                    viewport={"width": 1280, "height": 800},
                    locale="en-US",
                    timezone_id="Europe/Prague",
                    extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
                )
                await stealth.apply_stealth_async(context)
                await context.grant_permissions(
                    ["clipboard-read", "clipboard-write"],
                    origin="https://medium.com",
                )
                await context.add_cookies(self._load_cookies())
                page = await context.new_page()

                try:
                    return await self._create_story(page, title, body_markdown, tags, publish)
                except Exception:
                    log.exception("Medium Playwright publish failed")
                    await self._safe_screenshot(page, "medium_error.png")
                    raise
                finally:
                    try:
                        await context.storage_state(path=str(config.data_dir / "medium_storage_state.json"))
                    except Exception:
                        pass
                    await browser.close()
        finally:
            self._cleanup_display()

    @staticmethod
    def _user_agent() -> str:
        return (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
        )

    @classmethod
    def _make_stealth(cls):
        from playwright_stealth import Stealth

        return Stealth(
            navigator_user_agent_override=cls._user_agent(),
            navigator_platform_override="Linux x86_64",
            navigator_vendor_override="Google Inc.",
        )

    @staticmethod
    def _browser_args() -> list[str]:
        return [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-web-security",
            "--window-size=1280,800",
        ]

    @staticmethod
    async def _human_delay(min_s: float = 2, max_s: float = 5) -> None:
        await asyncio.sleep(random.uniform(min_s, max_s))

    @classmethod
    def _ensure_display(cls) -> None:
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
                log.warning("Xvfb not found - install with: sudo apt install xvfb")
                return
            except Exception:
                continue

    @classmethod
    def _cleanup_display(cls) -> None:
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

    @classmethod
    def _load_cookies(cls) -> list[dict]:
        cookies = json.loads(_COOKIES_FILE.read_text())
        normalized = cls._normalize_cookies(cookies)
        if normalized != cookies:
            _COOKIES_FILE.write_text(json.dumps(normalized, indent=2))
            log.info("Normalized Medium cookies for Playwright")
        return normalized

    @staticmethod
    def _normalize_cookies(cookies: list[dict]) -> list[dict]:
        mapping = {
            "no_restriction": "None",
            "none": "None",
            "unspecified": "None",
            "lax": "Lax",
            "strict": "Strict",
        }
        result: list[dict] = []
        for cookie in cookies:
            c = dict(cookie)
            raw_same_site = str(c.get("sameSite", "None")).strip().lower()
            c["sameSite"] = mapping.get(raw_same_site, c.get("sameSite", "None"))
            if c["sameSite"] not in {"Strict", "Lax", "None"}:
                c["sameSite"] = "None"
            result.append(c)
        return result

    async def _create_story(
        self,
        page,
        title: str,
        body_markdown: str,
        tags: list[str],
        publish: bool,
    ) -> str | None:
        await page.goto("https://medium.com", wait_until="domcontentloaded", timeout=60000)
        await self._human_delay(4, 7)
        await self._wait_for_cloudflare(page, "home")
        log.info("Medium: homepage URL: %s title=%s", page.url, await page.title())

        if "signin" in page.url.lower() or "login" in page.url.lower():
            raise RuntimeError("Session expired - cookies are invalid. Upload fresh Medium cookies.")

        await page.goto("https://medium.com/new-story", wait_until="domcontentloaded", timeout=60000)
        await self._human_delay(6, 10)
        await self._wait_for_cloudflare(page, "new_story")
        log.info("Medium: editor URL: %s title=%s", page.url, await page.title())

        if "signin" in page.url.lower() or "login" in page.url.lower():
            raise RuntimeError("Session expired - cookies are invalid. Upload fresh Medium cookies.")

        title_field = await self._find_title_field(page)
        await title_field.click()
        await page.keyboard.type(title, delay=random.randint(35, 70))
        await page.keyboard.press("Enter")
        await self._human_delay(1, 2)

        body_html = self._markdown_to_html(body_markdown)
        log.info("Medium: HTML body length: %d chars", len(body_html))

        clipboard_ok = await page.evaluate(
            """async ([html, plain]) => {
                try {
                    const htmlBlob = new Blob([html], {type: 'text/html'});
                    const textBlob = new Blob([plain], {type: 'text/plain'});
                    await navigator.clipboard.write([
                        new ClipboardItem({
                            'text/html': htmlBlob,
                            'text/plain': textBlob,
                        })
                    ]);
                    return true;
                } catch(e) {
                    return false;
                }
            }""",
            [body_html, body_markdown],
        )

        if clipboard_ok:
            await page.keyboard.press("Control+v")
            log.info("Medium: pasted %d chars as HTML via clipboard API + Ctrl+V", len(body_markdown))
        else:
            log.warning("Medium: clipboard API failed, falling back to keyboard typing")
            for para in body_markdown.split("\n\n"):
                para = para.strip()
                if not para:
                    continue
                await page.keyboard.type(para, delay=random.randint(3, 8))
                await page.keyboard.press("Enter")
                await page.keyboard.press("Enter")
                await self._human_delay(0.3, 0.8)

        await self._human_delay(8, 12)

        if not publish:
            log.info("Medium: draft saved")
            return page.url

        publish_btn = page.locator('button:has-text("Publish")').first
        if not await publish_btn.is_visible(timeout=10000):
            await self._safe_screenshot(page, "medium_no_publish.png")
            raise RuntimeError("Medium: publish button not visible")

        await publish_btn.click()
        await self._human_delay(3, 5)

        tag_input = page.locator('input[placeholder*="tag" i]').first
        for tag in tags[:5]:
            try:
                if await tag_input.is_visible(timeout=3000):
                    await tag_input.fill(tag)
                    await page.keyboard.press("Enter")
                    await self._human_delay(0.7, 1.2)
            except Exception:
                break

        final_publish = page.locator('button:has-text("Publish now")').or_(
            page.locator('button:has-text("Publish")').last
        )
        if await final_publish.is_visible(timeout=10000):
            await final_publish.click()
            await self._human_delay(6, 9)
        else:
            await self._safe_screenshot(page, "medium_no_publish_now.png")
            raise RuntimeError("Medium: final publish button not visible")

        log.info("Medium: published at %s", page.url)
        return page.url

    async def _wait_for_cloudflare(self, page, label: str) -> None:
        title = await page.title()
        if "just a moment" not in title.lower():
            return

        log.info("Medium: Cloudflare challenge detected on %s", label)
        for i in range(36):
            await asyncio.sleep(5)
            title = await page.title()
            log.info("Medium: CF check %d/36 on %s - title: %s", i + 1, label, title)
            if "just a moment" not in title.lower():
                log.info("Medium: Cloudflare challenge resolved on %s", label)
                await self._human_delay(2, 4)
                return

        await self._dump_page_diagnostics(page, f"{label}_cloudflare_stuck")
        raise RuntimeError(
            "Medium: Cloudflare challenge did not resolve. Upload fresh cookies "
            "from the same network or solve login on the RPi browser."
        )

    async def _find_title_field(self, page):
        selectors = [
            'p[data-placeholder*="Title" i]',
            'div[data-placeholder*="Title" i]',
            '[data-testid="title"]',
            '[role="textbox"]',
            '[contenteditable]:not([contenteditable="false"])',
        ]
        for selector in selectors:
            locator = page.locator(selector).first
            try:
                if await locator.is_visible(timeout=10000):
                    log.info("Medium: title field found via %s", selector)
                    return locator
            except Exception:
                continue

        await self._dump_page_diagnostics(page, "no_title_field")
        raise RuntimeError("Medium: no title field found on new-story page")

    async def _safe_screenshot(self, page, name: str) -> None:
        try:
            path = config.data_dir / name
            await page.screenshot(path=str(path), full_page=True)
            log.error("Medium screenshot saved: %s", path)
        except Exception:
            pass

    async def _dump_page_diagnostics(self, page, context: str) -> None:
        try:
            log.error("Medium DIAG [%s]: URL = %s", context, page.url)
            log.error("Medium DIAG [%s]: title = %s", context, await page.title())
            for sel in [
                '[contenteditable]',
                '.ProseMirror',
                'textarea',
                '[role="textbox"]',
                '[data-testid="title"]',
                'button:has-text("Publish")',
            ]:
                try:
                    n = await page.locator(sel).count()
                    log.error("Medium DIAG [%s]: %s count=%d", context, sel, n)
                except Exception:
                    pass
            html = await page.content()
            log.error("Medium DIAG [%s]: HTML[0:3000] = %s", context, html[:3000])
            await self._safe_screenshot(page, f"medium_{context}.png")
        except Exception as exc:
            log.error("Medium DIAG [%s]: dump failed: %s", context, exc)

    @staticmethod
    def _markdown_to_html(md: str) -> str:
        def _inline(text: str) -> str:
            text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', text)
            text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
            text = re.sub(r'\*([^*]+)\*', r'<em>\1</em>', text)
            return text

        lines = md.split("\n")
        html_parts: list[str] = []
        list_tag: str | None = None
        paragraph_lines: list[str] = []

        def flush_paragraph():
            if paragraph_lines:
                text = " ".join(paragraph_lines)
                html_parts.append(f"<p>{_inline(text)}</p>")
                paragraph_lines.clear()

        def close_list():
            nonlocal list_tag
            if list_tag:
                html_parts.append(f"</{list_tag}>")
                list_tag = None

        def open_list(tag: str):
            nonlocal list_tag
            if list_tag != tag:
                close_list()
                html_parts.append(f"<{tag}>")
                list_tag = tag

        for line in lines:
            stripped = line.strip()
            if not stripped:
                flush_paragraph()
                close_list()
                continue

            if re.match(r'^!\[.*\]\(.*\)$', stripped):
                flush_paragraph()
                close_list()
                m = re.match(r'^!\[([^\]]*)\]\(([^)]+)\)$', stripped)
                if m:
                    html_parts.append(
                        f'<figure><img src="{m.group(2)}" alt="{m.group(1)}"/></figure>'
                    )
            elif stripped.startswith("#### "):
                flush_paragraph()
                close_list()
                html_parts.append(f"<h4>{_inline(stripped[5:])}</h4>")
            elif stripped.startswith("### "):
                flush_paragraph()
                close_list()
                html_parts.append(f"<h3>{_inline(stripped[4:])}</h3>")
            elif stripped.startswith("## "):
                flush_paragraph()
                close_list()
                html_parts.append(f"<h2>{_inline(stripped[3:])}</h2>")
            elif stripped.startswith("# "):
                flush_paragraph()
                close_list()
                html_parts.append(f"<h1>{_inline(stripped[2:])}</h1>")
            elif stripped.startswith("- ") or stripped.startswith("* "):
                flush_paragraph()
                open_list("ul")
                html_parts.append(f"<li>{_inline(stripped[2:])}</li>")
            elif stripped.startswith("---"):
                flush_paragraph()
                close_list()
                html_parts.append("<hr/>")
            elif re.match(r'^\d+\.\s', stripped):
                flush_paragraph()
                open_list("ol")
                text = re.sub(r'^\d+\.\s', '', stripped)
                html_parts.append(f"<li>{_inline(text)}</li>")
            else:
                paragraph_lines.append(stripped)

        flush_paragraph()
        close_list()
        return "\n".join(html_parts)

    async def close(self) -> None:
        pass
