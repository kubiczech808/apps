from __future__ import annotations

import json
from dataclasses import dataclass

from agent_m.config import config
from agent_m.content_plan import ContentPlan
from agent_m.gemini.client import generate_text


@dataclass
class Article:
    title: str
    body: str
    tags: list[str]


_SYSTEM_CONTEXT = """You are an expert Bitcoin and personal finance writer creating content for {site_name} ({site_url}).

=== ABOUT {site_name} ===
{site_name} is a FREE Bitcoin DCA automation platform that:
- Connects to crypto exchanges (Binance, Coinmate, OKX) via secure API
- Automates recurring Bitcoin purchases at any frequency (daily, weekly, monthly, even every few minutes)
- Adds auto-invest capability even to exchanges that don't natively support it
- Automatically withdraws Bitcoin to user's own hardware wallet when balance hits a threshold
- Tracks investment progress separately per "life goal" (retirement, house, emergency fund, etc.)
- Uses IP-restricted API keys + 2FA for withdrawal confirmation — never holds user funds
- Includes a DCA calculator with cycle-aware return modeling based on Bitcoin's 4-year halving cycles
- Completely free — monetized through affiliate links to exchanges and hardware wallets

=== KEY DIFFERENTIATORS FROM COMPETITORS ===
- Unlike dcabtc.com (calculator only) — btc-dca.com actually AUTOMATES purchases
- Unlike exchange built-in auto-invest — works across multiple exchanges, adds withdrawal automation
- Unlike trading bots — focused purely on long-term DCA accumulation, not speculation
- Unique cycle-aware calculator that models diminishing returns per halving cycle (not flat CAGR)
- Per-goal tracking — separate strategies for different financial objectives

=== WRITING GUIDELINES ===
- Write authoritative but approachable content — like a knowledgeable friend, not a textbook
- Use concrete numbers and data wherever possible (historical returns, percentages, dollar amounts)
- Every article must provide genuine standalone value — a reader should learn something useful even if they never visit {site_name}
- References to {site_name} must be natural and contextual — mention it where the tool genuinely solves a problem discussed in the article
- Include 2-3 mentions of {site_name}: once in the body where relevant, once in a practical tip, and once in the CTA
- Never use hype language ("to the moon", "guaranteed returns", "get rich quick")
- Always include a brief disclaimer that this is not financial advice
- Target keyword density: primary keyword 3-5 times naturally, not stuffed"""

_ARTICLE_PROMPT = """Write a comprehensive, SEO-optimized blog article in English.

=== ARTICLE BRIEF ===
Topic: {title_hint}
Angle: {angle}
Primary SEO keyword: "{seo_keyword}"
Target CTA: {cta_target}
Funnel stage: {funnel_stage}

=== KEY POINTS TO COVER ===
{key_points}

=== FORMAT REQUIREMENTS ===
- Approximately 1500 words
- Markdown formatting with ## subheadings (NOT # — reserved for title)
- 4-6 subheadings with at least 2 containing the SEO keyword naturally
- Compelling hook in the first paragraph — start with a surprising stat, question, or scenario
- The first or second paragraph MUST include a natural contextual link to {site_url} — e.g. "tools like [{site_name}]({site_url})" or "you can automate this at [{site_name}]({site_url})"
- SEO keyword in: first paragraph, at least 2 subheadings, conclusion
- End with a clear call-to-action pointing to {site_url} ({cta_target})
- Include a one-line disclaimer: *This article is for educational purposes only and does not constitute financial advice.*

Do NOT include the title as a heading.
Do NOT include image placeholders.

Respond ONLY with a JSON object (no other text):
{{"title": "SEO-friendly title, max 100 chars", "body": "full article in markdown", "tags": ["tag1", "tag2", "tag3"]}}"""


async def write_article_from_plan(plan: ContentPlan) -> Article:
    system = _SYSTEM_CONTEXT.format(
        site_name=config.site_name,
        site_url=config.site_url,
    )
    key_points_text = "\n".join(f"- {p}" for p in plan.key_points)
    user_prompt = _ARTICLE_PROMPT.format(
        title_hint=plan.title_hint,
        angle=plan.angle,
        seo_keyword=plan.seo_keyword,
        cta_target=plan.cta_target,
        funnel_stage=plan.funnel_stage,
        key_points=key_points_text,
        site_url=config.site_url,
    )
    prompt = f"{system}\n\n---\n\n{user_prompt}"
    raw = await generate_text(prompt, temperature=0.7, max_tokens=8192, json_mode=True)

    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start == -1 or end == 0:
        raise RuntimeError(f"Failed to parse writer response: {raw[:200]}")

    try:
        data = json.loads(raw[start:end])
    except json.JSONDecodeError:
        data = json.loads(raw)
    title = data["title"][:100]
    body = data["body"]
    tags = [t[:25] for t in data.get("tags", plan.tags)[:3]]

    if config.site_url not in body and config.site_name not in body:
        body += (
            f"\n\n---\n\n*Start your own Bitcoin DCA journey at "
            f"[{config.site_name}]({config.site_url}) — it's free.*"
        )

    return Article(title=title, body=body, tags=tags)
