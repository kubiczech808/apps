"""One-shot: update existing Dev.to articles with affiliate + internal links."""
from __future__ import annotations

import asyncio
import logging
import sys

from agent_m.config import config
from agent_m.gemini.client import generate_text
from agent_m.site_context import _default_affiliate_links, _default_pages

log = logging.getLogger(__name__)

_LINK_INJECTION_PROMPT = """You are editing an existing blog article about Bitcoin DCA.

Your task: add affiliate links and internal site links naturally into the existing text.
Do NOT rewrite the article — only ADD links where they fit naturally.

=== AFFILIATE LINKS (use when exchanges or wallets are mentioned) ===
{affiliate_section}

=== INTERNAL SITE LINKS (link to these through keyword anchor text) ===
{pages_section}

=== RULES ===
- Add 1-3 affiliate links where the article mentions buying Bitcoin, exchanges, or hardware wallets
- Add 1-2 internal links to btc-dca.com subpages using descriptive keyword anchor text
- NEVER show bare URLs as visible text — always use [descriptive anchor](url) format
- NEVER add a link that's already present in the article
- Do NOT change the article structure, tone, or content — only insert links
- Do NOT add links in headings
- If the article already has good links, make minimal changes
- Return the FULL article body (not just the changed parts)

=== EXISTING ARTICLE BODY ===
{body}"""


def _build_affiliate_section() -> str:
    lines = []
    for a in _default_affiliate_links():
        prio = "(priority)" if a.get("priority") == "high" else "(low priority)"
        lines.append(f"- {a['name']} {prio}: {a['url']}")
    return "\n".join(lines)


def _build_pages_section() -> str:
    lines = []
    for p in _default_pages():
        desc = f" — {p['description']}" if p.get("description") else ""
        lines.append(f"- {p['url']} [{p['text']}]{desc}")
    return "\n".join(lines)


async def enhance_article_body(body: str) -> str:
    prompt = _LINK_INJECTION_PROMPT.format(
        affiliate_section=_build_affiliate_section(),
        pages_section=_build_pages_section(),
        body=body,
    )
    result = await generate_text(prompt, temperature=0.3, max_tokens=8192, json_mode=False)
    return result.strip()


async def run_update() -> None:
    from agent_m.publishers.devto import DevToPublisher

    if not config.devto_api_key:
        print("ERROR: DEVTO_API_KEY not configured")
        sys.exit(1)

    pub = DevToPublisher()
    try:
        articles = await pub.list_my_articles()
        print(f"Found {len(articles)} published articles on Dev.to")

        for art in articles:
            article_id = art["id"]
            title = art.get("title", "?")
            print(f"\n--- Processing: {title} (id={article_id}) ---")

            full = await pub.get_article(article_id)
            body = full.get("body_markdown", "")
            if not body:
                print("  SKIP: no body_markdown")
                continue

            has_affiliate = any(
                kw in body for kw in [
                    "coinbase.com/join", "binance.com", "bybit.eu",
                    "coinmate.io/?affiliate", "bit.ly/buy-trezor",
                ]
            )
            if has_affiliate:
                print("  SKIP: already contains affiliate links")
                continue

            print("  Enhancing with Gemini...")
            enhanced = await enhance_article_body(body)

            if enhanced == body or len(enhanced) < len(body) * 0.8:
                print("  SKIP: no meaningful changes or suspiciously shorter")
                continue

            await pub.update_article(article_id, enhanced)
            print(f"  UPDATED: {art.get('url', '')}")

    finally:
        await pub.close()


def main() -> None:
    logging.basicConfig(
        level=config.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    asyncio.run(run_update())


if __name__ == "__main__":
    main()
