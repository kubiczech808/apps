from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
import subprocess
import tempfile
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
        image_bytes: bytes | None = None,
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
                await context.add_cookies(self._load_cookies())
                page = await context.new_page()

                try:
                    return await self._create_story(page, title, body_markdown, tags, publish, image_bytes)
                except Exception:
                    log.exception("Medium Playwright publish failed")
                    await self._safe_screenshot(page, "medium_error.png")
                    raise
                finally:
                    try:
                        cookies = await context.cookies()
                        if cookies:
                            normalized = self._normalize_cookies(cookies)
                            _COOKIES_FILE.write_text(json.dumps(normalized, indent=2))
                            log.info("Saved %d refreshed cookies to %s", len(normalized), _COOKIES_FILE)
                    except Exception:
                        pass
                    await browser.close()
        finally:
            self._cleanup_display()

    # ── Editor interaction ──────────────────────────────────────────

    async def _create_story(
        self,
        page,
        title: str,
        body_markdown: str,
        tags: list[str],
        publish: bool,
        image_bytes: bytes | None = None,
    ) -> str | None:
        # Go directly to new-story — skipping homepage avoids Cloudflare challenge
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

        if image_bytes:
            await self._insert_cover_image(page, image_bytes)

        blocks = self._parse_markdown_blocks(body_markdown)
        log.info("Medium: typing %d blocks with native formatting", len(blocks))

        for block in blocks:
            btype = block["type"]
            if btype == "heading":
                await self._type_heading(page, block["text"], block["level"])
            elif btype == "paragraph":
                await self._type_formatted_text(page, block["text"])
                await page.keyboard.press("Enter")
                await page.keyboard.press("Enter")
                await self._human_delay(0.2, 0.5)
            elif btype == "list_item":
                await page.keyboard.type("• ", delay=5)
                await self._type_formatted_text(page, block["text"])
                await page.keyboard.press("Enter")
                await self._human_delay(0.1, 0.3)
            elif btype == "hr":
                await page.keyboard.press("Enter")

        await self._human_delay(5, 8)

        if not publish:
            log.info("Medium: draft saved")
            return page.url

        # Wait for Medium to finish auto-saving — clicking Publish while the
        # top-right button still says "Saving..." is a no-op and the prepublish
        # dialog never opens.
        await self._wait_for_save_complete(page)

        # Extra settle time: Medium's React SPA re-renders after save completes
        # and the button may not be wired to its click handler immediately.
        # Medium can also queue additional background saves, so we give it
        # generous time to fully stabilize.
        await self._human_delay(8, 12)

        # Open the prepublish dialog. _click_initial_publish escalates click
        # methods and waits for the dialog to actually render.
        if not await self._click_initial_publish(page):
            await self._dump_page_diagnostics(page, "no_publish_dialog")
            raise RuntimeError("Medium: prepublish dialog did not open")
        await self._human_delay(1, 2)

        # Add topics/tags
        tag_input = page.locator('input[placeholder*="tag" i]').or_(
            page.locator('input[placeholder*="topic" i]')
        ).first
        for tag in tags[:5]:
            try:
                if await tag_input.is_visible(timeout=3000):
                    await tag_input.fill(tag)
                    await page.keyboard.press("Enter")
                    await self._human_delay(0.7, 1.2)
            except Exception:
                break

        # Click the final "Publish now" button (robust, multi-strategy)
        if not await self._click_final_publish(page):
            await self._dump_page_diagnostics(page, "no_publish_now")
            raise RuntimeError("Medium: final publish button not visible")
        await self._human_delay(3, 5)

        published_url = await self._wait_for_published_url(page)
        log.info("Medium: published at %s", published_url)
        return published_url

    async def _wait_for_save_complete(self, page, timeout_s: int = 60, stable_s: int = 5) -> None:
        """Wait until Medium's auto-save truly finishes.

        The button shows 'Saving...' while a save is in flight and switches
        to 'Publish' once done. But Medium can flip back to 'Saving...' if
        it queues another save. We require the button to be in a stable
        ready state (text != 'saving' AND not disabled) for stable_s
        consecutive seconds before returning.
        """
        stable_count = 0
        for i in range(timeout_s):
            try:
                state = await page.evaluate("""() => {
                    const btn = document.querySelector('button[data-action="show-prepublish"]');
                    if (!btn) return {text: 'none', disabled: true};
                    return {
                        text: (btn.textContent || '').trim().toLowerCase(),
                        disabled: btn.disabled || btn.getAttribute('aria-disabled') === 'true',
                    };
                }""")
            except Exception:
                stable_count = 0
                await asyncio.sleep(1)
                continue

            text = state.get("text", "none")
            disabled = state.get("disabled", True)

            if text != "none" and "saving" not in text and not disabled:
                stable_count += 1
                if stable_count >= stable_s:
                    log.info(
                        "Medium: auto-save complete after %ds, stable for %ds (button: '%s')",
                        i, stable_s, text,
                    )
                    return
            else:
                if stable_count > 0:
                    log.info("Medium: save state reset at %ds (text='%s', disabled=%s)", i, text, disabled)
                stable_count = 0
            await asyncio.sleep(1)
        log.warning("Medium: auto-save not stable after %ds, continuing anyway", timeout_s)

    async def _click_initial_publish(self, page) -> bool:
        """Click the top-right Publish button that opens the prepublish dialog.

        Medium is a React SPA whose event handlers are attached via React's
        synthetic event system.  A plain Playwright `.click()` or JS `.click()`
        sometimes does NOT trigger the React handler — the native DOM event
        fires but React never sees it.

        We escalate through increasingly aggressive strategies:
        1. page.mouse.click at exact bounding-box coordinates (trusted OS event)
        2. Focus the button + keyboard Enter (bypasses click entirely)
        3. Full native MouseEvent dispatch sequence (mousedown→mouseup→click)
        4. Playwright .click() and JS .click() as last resorts
        """
        sel = 'button[data-action="show-prepublish"]'
        loc = page.locator(sel).first
        try:
            if not await loc.is_visible(timeout=5000):
                for alt in ['button[data-testid="publishButton"]',
                            'button[aria-label*="Publish" i]',
                            'button:has-text("Publish")']:
                    loc = page.locator(alt).first
                    if await loc.is_visible(timeout=3000):
                        sel = alt
                        break
                else:
                    return False
        except Exception:
            return False

        # Pre-click: scroll into view and log button state
        try:
            await loc.scroll_into_view_if_needed(timeout=3000)
        except Exception:
            pass
        await self._human_delay(0.5, 1)

        diag = await page.evaluate("""(selector) => {
            const btn = document.querySelector(selector);
            if (!btn) return 'not found';
            const r = btn.getBoundingClientRect();
            return JSON.stringify({
                text: (btn.textContent || '').trim(),
                disabled: btn.disabled,
                ariaDisabled: btn.getAttribute('aria-disabled'),
                rect: {x: r.x, y: r.y, w: r.width, h: r.height},
                visible: btn.offsetParent !== null,
                pointerEvents: getComputedStyle(btn).pointerEvents,
            });
        }""", sel)
        log.info("Medium: publish button state before click: %s", diag)

        strategies = [
            ("mouse_coords", self._click_via_mouse_coords),
            ("keyboard_enter", self._click_via_keyboard),
            ("dispatch_events", self._click_via_dispatch_events),
            ("playwright_click", self._click_via_playwright),
            ("js_click", self._click_via_js),
        ]

        for idx, (name, fn) in enumerate(strategies):
            # Before each strategy (except the first), re-wait for save to
            # complete — the previous click may have triggered a new save cycle.
            if idx > 0:
                await self._wait_for_save_complete(page, timeout_s=30, stable_s=5)
                # Re-acquire locator state after waiting
                try:
                    if not await loc.is_visible(timeout=3000):
                        log.info("Medium: publish button lost after save wait, aborting")
                        return False
                except Exception:
                    return False

            try:
                await fn(page, loc, sel)
                log.info("Medium: clicked initial publish via %s", name)
            except Exception as e:
                log.info("Medium: initial publish %s failed: %s", name, e)
                continue

            # The click may trigger a navigation (Medium SPA route change).
            # Wait for the page to stabilize before probing for the dialog.
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=8000)
            except Exception:
                pass
            await self._human_delay(1, 2)

            if await self._wait_for_publish_dialog(page, timeout_s=15):
                return True
            log.info("Medium: dialog didn't open after %s, escalating", name)

        return False

    async def _click_via_mouse_coords(self, page, loc, sel) -> None:
        box = await loc.bounding_box()
        if not box:
            raise RuntimeError("no bounding box")
        x = box["x"] + box["width"] / 2
        y = box["y"] + box["height"] / 2
        await page.mouse.click(x, y)

    async def _click_via_keyboard(self, page, loc, sel) -> None:
        await loc.focus()
        await self._human_delay(0.3, 0.5)
        await page.keyboard.press("Enter")
        await self._human_delay(1, 2)
        await loc.focus()
        await page.keyboard.press("Space")

    async def _click_via_dispatch_events(self, page, loc, sel) -> None:
        await page.evaluate("""(selector) => {
            const btn = document.querySelector(selector);
            if (!btn) return;
            const opts = {bubbles: true, cancelable: true, view: window,
                          button: 0, buttons: 1, clientX: 0, clientY: 0};
            const r = btn.getBoundingClientRect();
            opts.clientX = r.x + r.width / 2;
            opts.clientY = r.y + r.height / 2;
            btn.dispatchEvent(new PointerEvent('pointerdown', {...opts, pointerId: 1}));
            btn.dispatchEvent(new MouseEvent('mousedown', opts));
            btn.dispatchEvent(new PointerEvent('pointerup', {...opts, pointerId: 1}));
            btn.dispatchEvent(new MouseEvent('mouseup', opts));
            btn.dispatchEvent(new MouseEvent('click', opts));
        }""", sel)

    async def _click_via_playwright(self, page, loc, sel) -> None:
        await loc.click(timeout=5000)

    async def _click_via_js(self, page, loc, sel) -> None:
        await loc.evaluate("el => el.click()")

    async def _wait_for_publish_dialog(self, page, timeout_s: int = 20) -> bool:
        """Wait until the prepublish dialog (with tags + 'Publish now') appears.

        Looks specifically for the 'Publish now' button or the topics/tags
        input — NOT a generic 'Publish' button, which stays in the DOM and
        would cause a false positive while the dialog is still rendering.

        Handles 'execution context destroyed' errors that occur when Medium
        navigates (SPA route change) after clicking the publish button.
        """
        for i in range(timeout_s * 2):
            try:
                found = await page.evaluate("""() => {
                    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
                    const hasPublishNow = btns.some(b => {
                        const t = (b.textContent || '').trim().toLowerCase();
                        return t.includes('publish now') && b.offsetParent !== null;
                    });
                    const hasTagInput = !!document.querySelector(
                        'input[placeholder*="tag" i], input[placeholder*="topic" i]');
                    return hasPublishNow || hasTagInput;
                }""")
            except Exception as e:
                if "context was destroyed" in str(e) or "navigation" in str(e).lower():
                    log.info("Medium: navigation detected while waiting for dialog (iter %d), waiting...", i)
                    try:
                        await page.wait_for_load_state("domcontentloaded", timeout=10000)
                    except Exception:
                        pass
                    await asyncio.sleep(1)
                    continue
                raise
            if found:
                log.info("Medium: publish dialog ready (after %.1fs)", i * 0.5)
                await self._human_delay(0.8, 1.5)
                return True
            await asyncio.sleep(0.5)
        return False

    async def _click_final_publish(self, page) -> bool:
        """Click the final 'Publish now' confirmation button using several strategies."""
        for attempt in range(3):
            # Strategy 1: explicit Playwright selectors
            selectors = [
                'button[data-testid="publishConfirmButton"]',
                'button[data-action="publish"]',
                'button[data-testid="publish-button"]',
                'button:has-text("Publish now")',
            ]
            for sel in selectors:
                try:
                    loc = page.locator(sel).first
                    if await loc.is_visible(timeout=3000):
                        await loc.scroll_into_view_if_needed(timeout=3000)
                        await loc.click()
                        log.info("Medium: clicked final publish via %s", sel)
                        return True
                except Exception:
                    continue

            # Strategy 2: JS scan for a visible button whose text is "Publish now"
            clicked = await page.evaluate("""() => {
                const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
                const exact = btns.find(b =>
                    (b.textContent || '').trim().toLowerCase() === 'publish now'
                    && b.offsetParent !== null);
                if (exact) { exact.click(); return 'exact'; }
                const partial = btns.find(b =>
                    (b.textContent || '').trim().toLowerCase().includes('publish now')
                    && b.offsetParent !== null);
                if (partial) { partial.click(); return 'partial'; }
                return '';
            }""")
            if clicked:
                log.info("Medium: clicked final publish via JS (%s)", clicked)
                return True

            # Not found yet — the prepublish dialog may not have opened because
            # the draft was still saving. Wait for save, re-open, and retry.
            log.info("Medium: final publish not found (attempt %d/3), retrying", attempt + 1)
            await self._wait_for_save_complete(page)
            await self._click_initial_publish(page)
            await self._wait_for_publish_dialog(page)
            await self._human_delay(1, 2)

        return False

    async def _insert_cover_image(self, page, image_bytes: bytes) -> None:
        """Insert image as first body element via Medium's 'Add an image' button."""
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
                f.write(image_bytes)
                tmp_path = f.name

            diag = await page.evaluate("""() => {
                const r = [];
                document.querySelectorAll('input[type="file"]').forEach((el, i) =>
                    r.push('file[' + i + '] accept=' + el.accept));
                document.querySelectorAll('button, [role="button"]').forEach(b => {
                    const a = b.getAttribute('aria-label') || '';
                    if (/image|photo|cover|upload/i.test(a))
                        r.push('btn aria="' + a + '" vis=' + (b.offsetParent !== null));
                });
                return r.join('\\n') || 'no image-related elements';
            }""")
            log.info("Medium image elements:\n%s", diag)

            # Primary: click the "Add an image" button (exact aria-label)
            img_btn = page.locator('button[aria-label="Add an image"]').first
            if not await img_btn.is_visible(timeout=3000):
                plus_btn = page.locator(
                    'button[aria-label*="Add an image, video"]'
                ).first
                try:
                    if await plus_btn.is_visible(timeout=2000):
                        await plus_btn.click()
                        log.info("Medium: clicked '+' menu to reveal image button")
                        await self._human_delay(1, 2)
                except Exception:
                    pass

            if await img_btn.is_visible(timeout=3000):
                async with page.expect_file_chooser(timeout=10000) as fc:
                    await img_btn.click()
                chooser = await fc.value
                await chooser.set_files(tmp_path)
                log.info("Medium: cover image inserted via 'Add an image' button")
                await self._human_delay(5, 8)
                await page.keyboard.press("Enter")
                await self._human_delay(0.5, 1)
                return

            # Fallback: any file input that appeared
            file_inputs = page.locator('input[type="file"]')
            if await file_inputs.count() > 0:
                await file_inputs.first.set_input_files(tmp_path)
                log.info("Medium: cover image via file input fallback")
                await self._human_delay(5, 8)
                await page.keyboard.press("Enter")
                await self._human_delay(0.5, 1)
                return

            log.warning("Medium: 'Add an image' button not found, skipping cover image")
        except Exception as exc:
            log.warning("Medium: cover image insert failed: %s", exc)
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

    # ── Native formatting helpers ───────────────────────────────────

    async def _type_formatted_text(self, page, text: str) -> None:
        segments = self._parse_inline_segments(text)
        for seg in segments:
            seg_text = seg["text"]
            await page.keyboard.type(seg_text, delay=random.randint(3, 8))

            if seg["type"] == "link":
                await self._select_chars_backward(page, len(seg_text))
                await self._human_delay(0.3, 0.5)
                await page.keyboard.press("Control+k")
                await self._human_delay(0.8, 1.5)
                await page.keyboard.type(seg["url"], delay=random.randint(2, 5))
                await page.keyboard.press("Enter")
                await self._human_delay(0.3, 0.5)
                await page.keyboard.press("ArrowRight")

            elif seg["type"] == "bold":
                await self._select_chars_backward(page, len(seg_text))
                await page.keyboard.press("Control+b")
                await page.keyboard.press("ArrowRight")

            elif seg["type"] == "italic":
                await self._select_chars_backward(page, len(seg_text))
                await page.keyboard.press("Control+i")
                await page.keyboard.press("ArrowRight")

    async def _type_heading(self, page, text: str, level: int) -> None:
        await self._type_formatted_text(page, text)

        await page.keyboard.press("Home")
        await page.keyboard.press("Shift+End")
        await self._human_delay(0.5, 1)

        applied = await page.evaluate("""(level) => {
            const sel = window.getSelection();
            if (!sel.rangeCount) return false;
            const node = sel.anchorNode?.parentElement?.closest?.('[contenteditable]')
                      || document.querySelector('.ProseMirror');
            if (!node) return false;

            // Try 1: find visible toolbar heading buttons by title/aria-label
            const keywords = level <= 2
                ? ['big', 'large', 'heading 1', 'heading 2', 'h2', 'section']
                : ['small', 'heading 3', 'heading 4', 'h3', 'subtitle'];
            const allBtns = document.querySelectorAll('button');
            for (const btn of allBtns) {
                if (btn.offsetParent === null) continue;
                const t = ((btn.title || '') + ' ' + (btn.ariaLabel || '')).toLowerCase();
                if (keywords.some(k => t.includes(k))) {
                    btn.click();
                    return true;
                }
            }

            // Try 2: find floating toolbar, click T button by position
            for (const sel_q of ['[class*="toolbar" i]', '[class*="popover" i]', '[role="toolbar"]']) {
                const bar = document.querySelector(sel_q);
                if (!bar || bar.offsetParent === null) continue;
                const btns = bar.querySelectorAll('button');
                const idx = level <= 2 ? 3 : 4;
                if (btns.length > idx) {
                    btns[idx].click();
                    return true;
                }
            }

            // Try 3: execCommand formatBlock
            const tag = level <= 2 ? 'H3' : 'H4';
            return document.execCommand('formatBlock', false, tag);
        }""", level)

        log.info("Medium: heading level %d applied=%s", level, applied)

        await page.keyboard.press("End")
        await page.keyboard.press("Enter")
        await self._human_delay(0.3, 0.5)

    async def _select_chars_backward(self, page, count: int) -> None:
        await page.evaluate("""(n) => {
            const sel = window.getSelection();
            for (let i = 0; i < n; i++) {
                sel.modify('extend', 'backward', 'character');
            }
        }""", count)

    # ── Markdown parsing ────────────────────────────────────────────

    @staticmethod
    def _parse_markdown_blocks(md: str) -> list[dict]:
        blocks: list[dict] = []
        lines = md.split("\n")
        para_lines: list[str] = []

        def flush():
            if para_lines:
                blocks.append({"type": "paragraph", "text": " ".join(para_lines)})
                para_lines.clear()

        for line in lines:
            s = line.strip()
            if not s:
                flush()
                continue
            if re.match(r"^!\[.*\]\(.*\)$", s):
                flush()
                continue
            if re.match(r"^#{1,4}\s", s):
                flush()
                m = re.match(r"^(#{1,4})\s+(.*)", s)
                blocks.append({"type": "heading", "level": len(m.group(1)), "text": m.group(2)})
            elif s.startswith("---"):
                flush()
                blocks.append({"type": "hr"})
            elif s.startswith("- ") or s.startswith("* "):
                flush()
                blocks.append({"type": "list_item", "text": s[2:]})
            elif re.match(r"^\d+\.\s", s):
                flush()
                blocks.append({"type": "list_item", "text": re.sub(r"^\d+\.\s", "", s)})
            else:
                para_lines.append(s)

        flush()
        return blocks

    @staticmethod
    def _parse_inline_segments(text: str) -> list[dict]:
        segments: list[dict] = []
        pattern = r"(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))"
        for part in re.split(pattern, text):
            if not part:
                continue
            if part.startswith("**") and part.endswith("**"):
                segments.append({"type": "bold", "text": part[2:-2]})
            elif part.startswith("*") and part.endswith("*"):
                segments.append({"type": "italic", "text": part[1:-1]})
            elif part.startswith("["):
                m = re.match(r"\[([^\]]+)\]\(([^)]+)\)", part)
                if m:
                    segments.append({"type": "link", "text": m.group(1), "url": m.group(2)})
                else:
                    segments.append({"type": "text", "text": part})
            else:
                segments.append({"type": "text", "text": part})
        return segments

    # ── Navigation helpers ──────────────────────────────────────────

    async def _wait_for_published_url(self, page, timeout_s: int = 30) -> str:
        editor_patterns = ("new-story", "/edit", "/p/")
        for _ in range(timeout_s * 2):
            url = page.url
            if url and not any(p in url for p in editor_patterns) and "medium.com" in url:
                return url
            await asyncio.sleep(0.5)

        url = page.url
        log.warning("Medium: timed out waiting for published URL, returning: %s", url)
        return url

    async def _wait_for_cloudflare(self, page, label: str) -> None:
        title = await page.title()
        if "just a moment" not in title.lower():
            return

        log.info("Medium: Cloudflare challenge detected on %s", label)
        for i in range(36):
            await self._try_click_turnstile(page)
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

    async def _try_click_turnstile(self, page) -> None:
        try:
            for frame in page.frames:
                if "challenges.cloudflare.com" in (frame.url or ""):
                    checkbox = frame.locator('input[type="checkbox"]').or_(
                        frame.locator('[role="checkbox"]')
                    ).or_(
                        frame.locator(".cb-i")
                    )
                    if await checkbox.count() > 0 and await checkbox.first.is_visible(timeout=1000):
                        await checkbox.first.click()
                        log.info("Medium: clicked Turnstile checkbox")
                        await self._human_delay(2, 4)
                        return
            turnstile = page.locator('iframe[src*="challenges.cloudflare"]').first
            if await turnstile.is_visible(timeout=1000):
                box = await turnstile.bounding_box()
                if box:
                    await page.mouse.click(
                        box["x"] + box["width"] / 2,
                        box["y"] + box["height"] / 2,
                    )
                    log.info("Medium: clicked Turnstile iframe center")
                    await self._human_delay(2, 4)
        except Exception:
            pass

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

    # ── Browser / display helpers ───────────────────────────────────

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

    # ── Diagnostics ─────────────────────────────────────────────────

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
            # List every visible button/role=button with its text + aria-label,
            # so we can see exactly what the publish dialog offers.
            buttons = await page.evaluate("""() => {
                const out = [];
                document.querySelectorAll('button, [role="button"]').forEach(b => {
                    if (b.offsetParent === null) return;
                    const t = (b.textContent || '').trim().substring(0, 40);
                    const a = b.getAttribute('aria-label') || '';
                    const d = b.getAttribute('data-testid') || b.getAttribute('data-action') || '';
                    out.push(`"${t}" aria="${a}" data="${d}"`);
                });
                return out;
            }""")
            log.error("Medium DIAG [%s]: %d visible buttons:\n%s",
                      context, len(buttons), "\n".join(buttons[:40]))
            await self._safe_screenshot(page, f"medium_{context}.png")
        except Exception as exc:
            log.error("Medium DIAG [%s]: dump failed: %s", context, exc)

    async def close(self) -> None:
        pass
