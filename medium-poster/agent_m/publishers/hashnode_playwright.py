from __future__ import annotations

import asyncio
import json
import logging
import re

from agent_m.config import config

log = logging.getLogger(__name__)

_COOKIES_FILE = config.data_dir / "hashnode_cookies.json"

_STEALTH_SCRIPTS = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
window.chrome = {runtime: {}};
"""


class HashnodePlaywrightPublisher:
    """Publishes articles to Hashnode via browser automation."""

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
                channel="chrome",
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
        # Navigate to dashboard first, then open editor via Write button
        await page.goto("https://hashnode.com", wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(3)

        page_url = page.url
        page_title = await page.title()
        log.info("Hashnode: dashboard URL: %s", page_url)
        log.info("Hashnode: dashboard title: %s", page_title)

        if "signin" in page_url.lower() or "login" in page_url.lower():
            raise RuntimeError("Hashnode session expired — run /hashnode_login again.")

        # Open a NEW draft (avoid reusing stale drafts)
        await self._open_new_draft(page)

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
            .or_(page.locator('[contenteditable]:not([contenteditable="false"])').last)
            .or_(page.locator('[role="textbox"]').last)
        )
        try:
            await editor.click(timeout=5000)
        except Exception:
            log.warning("Hashnode: editor click failed, trying Tab")
            await page.keyboard.press("Tab")
        await asyncio.sleep(0.5)

        # Paste markdown via synthetic ClipboardEvent — editor parses pasted markdown
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
            log.info("Hashnode: pasted %d chars via ClipboardEvent", len(body_markdown))
        else:
            log.warning("Hashnode: ClipboardEvent paste failed, falling back to keyboard typing")
            for para in body_markdown.split("\n\n"):
                para = para.strip()
                if not para:
                    continue
                await page.keyboard.type(para, delay=2)
                await page.keyboard.press("Enter")
                await page.keyboard.press("Enter")
                await asyncio.sleep(0.1)

        await asyncio.sleep(3)

        # Click the Publish button (top bar) — exclude tab buttons
        publish_btn = page.locator(
            'button:not([role="tab"]):has-text("Publish")'
        ).first
        try:
            if await publish_btn.is_visible(timeout=5000):
                log.info("Hashnode: clicking Publish button")
                await publish_btn.click()
                await asyncio.sleep(3)
            else:
                log.warning("Hashnode: Publish button not visible, looking for alternatives")
                # Try aria-label based selector
                alt_btn = page.locator('[aria-label*="publish" i]').first
                if await alt_btn.is_visible(timeout=3000):
                    await alt_btn.click()
                    await asyncio.sleep(3)
        except Exception as exc:
            log.warning("Hashnode: Publish button click failed: %s", exc)

        if cover_image_url:
            await self._set_cover_image(page, cover_image_url)

        await self._add_tags(page, tags)

        if canonical_url:
            await self._set_canonical_url(page, canonical_url)

        await self._select_publication(page)

        # Click final "Publish" / "Publish now" / "Publish post" button
        final_selectors = [
            'button:not([role="tab"]):has-text("Publish now")',
            'button:not([role="tab"]):has-text("Publish post")',
            'button[type="submit"]:has-text("Publish")',
        ]
        published = False
        for sel in final_selectors:
            btn = page.locator(sel).first
            try:
                if await btn.is_visible(timeout=3000):
                    log.info("Hashnode: clicking final publish via %s", sel)
                    await btn.click()
                    await asyncio.sleep(5)
                    published = True
                    break
            except Exception:
                continue

        if not published:
            all_publish = page.locator('button:not([role="tab"]):has-text("Publish")')
            count = await all_publish.count()
            log.info("Hashnode: found %d non-tab Publish buttons", count)
            if count > 0:
                await all_publish.last.click()
                await asyncio.sleep(5)
                published = True

        if not published:
            log.warning("Hashnode: no Publish button found, draft saved at %s", page.url)
            return page.url

        article_url = await self._extract_article_url(page, title)
        log.info("Hashnode: published, article URL: %s", article_url)
        return article_url

    async def _open_new_draft(self, page) -> None:
        """Create a new draft via Write button or direct URL navigation."""
        # First try: click Write/New Article link to create a NEW post
        new_post_selectors = [
            'a:has-text("Write")',
            'button:has-text("Write")',
            'a:has-text("New Article")',
            'button:has-text("New Article")',
            'a:has-text("New Post")',
        ]
        for sel in new_post_selectors:
            loc = page.locator(sel).first
            try:
                if await loc.is_visible(timeout=2000):
                    href = await loc.get_attribute("href")
                    log.info("Hashnode: found Write button via %s (href=%s)", sel, href)
                    await loc.click()
                    await asyncio.sleep(5)
                    current = page.url
                    log.info("Hashnode: after Write click: %s", current)
                    if "draft" in current:
                        # If we landed on an existing draft, clear title to check
                        title_elem = page.locator('textarea[placeholder*="title" i]').first
                        try:
                            if await title_elem.is_visible(timeout=5000):
                                existing = await title_elem.input_value()
                                if existing.strip():
                                    log.info("Hashnode: existing draft has title '%s', creating new one", existing[:50])
                                    # Navigate to create a truly new draft
                                    await page.goto("https://hashnode.com/draft/new", wait_until="domcontentloaded", timeout=30000)
                                    await asyncio.sleep(5)
                                    log.info("Hashnode: new draft URL: %s", page.url)
                                    return
                        except Exception:
                            pass
                    return
            except Exception:
                continue

        # Fallback: direct new-draft URL
        log.warning("Hashnode: Write button not found, trying direct URLs")
        for direct_url in ["https://hashnode.com/draft/new", "https://hashnode.com/new"]:
            try:
                await page.goto(direct_url, wait_until="domcontentloaded", timeout=30000)
                await asyncio.sleep(5)
                current = page.url
                log.info("Hashnode: direct URL %s → %s", direct_url, current)
                if "signin" not in current.lower() and "login" not in current.lower():
                    return
            except Exception as exc:
                log.debug("Hashnode: direct URL %s failed: %s", direct_url, exc)

        await self._dump_page_diagnostics(page, "no_write_button")
        raise RuntimeError(
            "Hashnode: could not open new draft — Write button not found, direct URLs failed."
        )

    async def _wait_for_editor(self, page) -> None:
        """Wait for the editor to fully load (SPA hydration)."""
        # Match any editable element: contenteditable="" (Lexical) or "true" (Draft.js)
        editor_sel = (
            '[contenteditable]:not([contenteditable="false"]), '
            'textarea, [role="textbox"], .ProseMirror, '
            '[data-lexical-editor], .ContentEditable__root'
        )
        try:
            await page.wait_for_selector(editor_sel, state="visible", timeout=60000)
            log.info("Hashnode: editor element detected after wait")
        except Exception:
            await self._dump_page_diagnostics(page, "editor_wait_timeout")
            raise RuntimeError(
                "Hashnode: editor did not load within 60s — page may be blocked or cookies expired"
            )

    async def _dump_page_diagnostics(self, page, context: str) -> None:
        """Log page state for debugging."""
        try:
            log.error("Hashnode DIAG [%s]: URL = %s", context, page.url)
            log.error("Hashnode DIAG [%s]: title = %s", context, await page.title())
            # Count various element types for quick diagnosis
            for sel in [
                '[contenteditable]',
                '[contenteditable="true"]',
                '[contenteditable=""]',
                '[data-lexical-editor]',
                '.ProseMirror',
                'textarea',
                '[role="textbox"]',
            ]:
                try:
                    n = await page.locator(sel).count()
                    log.error("Hashnode DIAG [%s]: %s count=%d", context, sel, n)
                except Exception:
                    pass
            html = await page.content()
            log.error("Hashnode DIAG [%s]: HTML[0:3000] = %s", context, html[:3000])
            screenshot_path = config.data_dir / f"hashnode_{context}.png"
            await page.screenshot(path=str(screenshot_path), full_page=True)
            log.error("Hashnode DIAG [%s]: screenshot saved: %s", context, screenshot_path)
        except Exception as exc:
            log.error("Hashnode DIAG [%s]: dump failed: %s", context, exc)

    async def _find_title_field(self, page):
        selectors = [
            'textarea[placeholder*="title" i]',
            'div[contenteditable][data-placeholder*="title" i]',
            '[data-testid="post-title"]',
            'h1[contenteditable]',
            'input[placeholder*="title" i]',
            '[data-placeholder*="title" i]',
            '[data-lexical-editor] + * h1',
        ]
        for sel in selectors:
            loc = page.locator(sel).first
            try:
                if await loc.is_visible(timeout=3000):
                    log.info("Hashnode: title field found via %s", sel)
                    return loc
            except Exception:
                continue

        all_editable = page.locator('[contenteditable]:not([contenteditable="false"])')
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

    async def _select_publication(self, page) -> None:
        """Select btc-dca blog publication in the publish dialog."""
        try:
            pub_selector = (
                page.locator('button:has-text("btc-dca")')
                .or_(page.locator('[data-testid*="publication" i]:has-text("btc-dca")'))
                .or_(page.locator('label:has-text("btc-dca")'))
                .or_(page.locator('div[role="radio"]:has-text("btc-dca")'))
                .or_(page.locator('div[role="option"]:has-text("btc-dca")'))
            )
            if await pub_selector.first.is_visible(timeout=3000):
                await pub_selector.first.click()
                await asyncio.sleep(1)
                log.info("Hashnode: selected btc-dca publication")
                return

            select_btn = (
                page.locator('button:has-text("Select blog")')
                .or_(page.locator('button:has-text("Select publication")'))
                .or_(page.locator('[aria-label*="publication" i]'))
            )
            if await select_btn.first.is_visible(timeout=2000):
                await select_btn.first.click()
                await asyncio.sleep(1)
                option = page.locator('[role="option"]:has-text("btc-dca")').or_(
                    page.locator('li:has-text("btc-dca")')
                )
                if await option.first.is_visible(timeout=2000):
                    await option.first.click()
                    await asyncio.sleep(1)
                    log.info("Hashnode: selected btc-dca publication via dropdown")
                    return

            log.debug("Hashnode: publication selector not found, using default")
        except Exception as exc:
            log.debug("Hashnode: publication selection failed: %s", exc)

    async def _extract_article_url(self, page, title: str) -> str:
        """Try to get the actual published article URL instead of the edit URL."""
        current = page.url
        if "/edit/" not in current and "/draft/" not in current:
            return current

        blog_domain = config.hashnode_blog_domain or "btc-dca.hashnode.dev"
        try:
            slug = await page.evaluate("""() => {
                const meta = document.querySelector('meta[property="og:url"]');
                if (meta) return meta.content;
                const link = document.querySelector('link[rel="canonical"]');
                if (link) return link.href;
                return null;
            }""")
            if slug and blog_domain in str(slug):
                return slug
        except Exception:
            pass

        try:
            view_link = page.locator('a:has-text("View post")').or_(
                page.locator('a:has-text("View article")')
            ).or_(page.locator('a[href*="' + blog_domain + '"]'))
            if await view_link.first.is_visible(timeout=3000):
                href = await view_link.first.get_attribute("href")
                if href:
                    log.info("Hashnode: found article link: %s", href)
                    return href
        except Exception:
            pass

        slug_text = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')[:80]
        constructed = f"https://{blog_domain}/{slug_text}"
        log.info("Hashnode: constructed article URL: %s", constructed)
        return constructed

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
