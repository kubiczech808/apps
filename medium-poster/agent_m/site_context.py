"""Discovers and caches site structure + affiliate links from btc-dca.com."""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone

import httpx

from agent_m.config import config

log = logging.getLogger(__name__)

_CACHE_FILE = config.data_dir / "site_context.json"
_CACHE_MAX_AGE_HOURS = 24


def _load_cache() -> dict | None:
    if not _CACHE_FILE.exists():
        return None
    try:
        data = json.loads(_CACHE_FILE.read_text())
        cached_at = datetime.fromisoformat(data.get("cached_at", "2000-01-01"))
        age_hours = (datetime.now(timezone.utc) - cached_at).total_seconds() / 3600
        if age_hours < _CACHE_MAX_AGE_HOURS:
            return data
    except (json.JSONDecodeError, OSError, ValueError):
        pass
    return None


def _save_cache(data: dict) -> None:
    data["cached_at"] = datetime.now(timezone.utc).isoformat()
    _CACHE_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))


async def get_site_context() -> dict:
    cached = _load_cache()
    if cached:
        return cached

    context = await _scrape_site()
    if context["pages"]:
        _save_cache(context)
    return context


async def _scrape_site() -> dict:
    site_url = config.site_url.rstrip("/")
    pages: list[dict] = []
    affiliate_links: list[dict] = []

    try:
        async with httpx.AsyncClient(
            timeout=15.0,
            follow_redirects=True,
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; AgentM/1.0; +https://btc-dca.com)",
                "Accept": "text/html,application/xhtml+xml",
            },
        ) as client:
            resp = await client.get(site_url)
            if resp.status_code == 200:
                html = resp.text
                pages = _extract_internal_links(html, site_url)
                affiliate_links = _extract_affiliate_links(html)
    except Exception as exc:
        log.warning("Site scrape failed, using defaults: %s", exc)

    if not pages:
        pages = _default_pages()

    # Affiliate links are always the stored defaults — scraping may find extras
    stored_affiliates = _default_affiliate_links()
    seen_names = {a["name"].lower() for a in stored_affiliates}
    for a in affiliate_links:
        if a["name"].lower() not in seen_names:
            stored_affiliates.append(a)

    return {
        "site_url": site_url,
        "pages": pages,
        "affiliate_links": stored_affiliates,
    }


def _extract_internal_links(html: str, site_url: str) -> list[dict]:
    links = []
    seen = set()
    domain = site_url.replace("https://", "").replace("http://", "")

    for match in re.finditer(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>([^<]*)</a>', html, re.IGNORECASE):
        href, text = match.group(1), match.group(2).strip()
        if not text:
            continue

        if href.startswith("/"):
            full_url = site_url + href
        elif domain in href:
            full_url = href
        else:
            continue

        full_url = full_url.split("#")[0].split("?")[0].rstrip("/")
        if full_url in seen or full_url == site_url:
            continue
        seen.add(full_url)
        links.append({"url": full_url, "text": text[:60]})

    return links


def _extract_affiliate_links(html: str) -> list[dict]:
    affiliate_patterns = [
        (r'(https?://[^"\']*(?:binance|bybit|coinbase|kraken|bitget|okx|kucoin|htx|mexc|gate\.io)[^"\']*)', "exchange"),
        (r'(https?://[^"\']*(?:trezor|ledger|bitbox)[^"\']*)', "hardware_wallet"),
    ]

    links = []
    seen = set()
    for pattern, category in affiliate_patterns:
        for match in re.finditer(pattern, html, re.IGNORECASE):
            url = match.group(1)
            if url in seen:
                continue
            seen.add(url)
            name = _extract_brand_name(url)
            links.append({"url": url, "name": name, "category": category})

    return links


def _extract_brand_name(url: str) -> str:
    brands = {
        "binance": "Binance", "bybit": "Bybit", "coinbase": "Coinbase",
        "kraken": "Kraken", "bitget": "Bitget", "okx": "OKX",
        "kucoin": "KuCoin", "htx": "HTX", "mexc": "MEXC",
        "gate.io": "Gate.io", "trezor": "Trezor", "ledger": "Ledger",
        "bitbox": "BitBox",
    }
    url_lower = url.lower()
    for key, name in brands.items():
        if key in url_lower:
            return name
    return "Exchange"


def _default_pages() -> list[dict]:
    base = config.site_url.rstrip("/")
    return [
        {"url": f"{base}/", "text": "Bitcoin DCA Calculator", "description": "Main DCA calculator tool"},
        {"url": f"{base}/blog", "text": "Blog", "description": "Bitcoin DCA articles and guides"},
        {"url": f"{base}/#calculator", "text": "DCA Calculator", "description": "Interactive DCA investment calculator"},
        {"url": f"{base}/#how-it-works", "text": "How DCA Works", "description": "Explanation of dollar-cost averaging"},
        {"url": f"{base}/#faq", "text": "FAQ", "description": "Frequently asked questions about Bitcoin DCA"},
    ]


def _default_affiliate_links() -> list[dict]:
    return [
        {"url": "https://advanced.coinbase.com/join/RSCXAJL", "name": "Coinbase", "category": "exchange", "priority": "high"},
        {"url": "https://accounts.binance.com/en/register?ref=ABP939VR", "name": "Binance", "category": "exchange", "priority": "high"},
        {"url": "https://partner.bybit.eu/b/ZKUSENOSTI", "name": "Bybit", "category": "exchange", "priority": "high"},
        {"url": "https://coinmate.io/?affiliate=UlhaT1ZETjZNbkJ6V0hrd1IyeERZakEzVUdaV2R3PT0", "name": "Coinmate", "category": "exchange", "priority": "high"},
        {"url": "https://www.okx.com/join/65437822", "name": "OKX", "category": "exchange", "priority": "low"},
        {"url": "https://partner.bybit.com/b/BTCDCA", "name": "Bybit Global", "category": "exchange", "priority": "low"},
        {"url": "https://bit.ly/buy-trezor-t", "name": "Trezor", "category": "hardware_wallet", "priority": "high"},
    ]


def format_site_context_for_prompt(context: dict) -> str:
    lines = ["=== SITE STRUCTURE — use these URLs as link targets in articles ==="]
    lines.append(f"Main site: {context['site_url']}")
    lines.append("")

    if context.get("pages"):
        lines.append("Internal pages (link to these using keyword anchor text):")
        for p in context["pages"]:
            desc = f" — {p['description']}" if p.get("description") else ""
            lines.append(f"  - {p['url']} [{p['text']}]{desc}")
        lines.append("")

    if context.get("affiliate_links"):
        high = [a for a in context["affiliate_links"] if a.get("priority") != "low"]
        low = [a for a in context["affiliate_links"] if a.get("priority") == "low"]
        lines.append("Affiliate/referral links — USE THESE when mentioning exchanges or wallets:")
        for a in high:
            lines.append(f"  - {a['name']}: {a['url']}")
        if low:
            lines.append("  Lower priority (use only if highly relevant):")
            for a in low:
                lines.append(f"  - {a['name']}: {a['url']}")
        lines.append("")
        lines.append("RULES for affiliate links:")
        lines.append("- When the article mentions buying Bitcoin, choosing an exchange, or self-custody,")
        lines.append("  naturally include 1-3 affiliate links as helpful recommendations.")
        lines.append("- Use keyword anchor text: e.g. [buy Bitcoin on Coinbase](affiliate_url)")
        lines.append("- Do NOT list all exchanges — pick the 1-2 most relevant to the article's context.")
        lines.append("- For hardware wallets / self-custody topics, always link Trezor.")

    return "\n".join(lines)
