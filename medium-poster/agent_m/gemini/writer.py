from __future__ import annotations

from dataclasses import dataclass

from agent_m.config import config
from agent_m.content_plan import ContentPlan
from agent_m.feedback import get_feedback_for_prompt
from agent_m.gemini.client import generate_text
from agent_m.site_context import format_site_context_for_prompt, get_site_context


@dataclass
class Article:
    title: str
    body: str
    tags: list[str]


_SYSTEM_CONTEXT = """You are an expert Bitcoin and personal finance writer creating content for a Bitcoin DCA automation platform.

=== ABOUT THE PLATFORM ===
The platform is a FREE Bitcoin DCA automation tool that:
- Connects to crypto exchanges (Binance, Coinmate, OKX) via secure API
- Automates recurring Bitcoin purchases at any frequency (daily, weekly, monthly, even every few minutes)
- Adds auto-invest capability even to exchanges that don't natively support it
- Automatically withdraws Bitcoin to user's own hardware wallet when balance hits a threshold
- Tracks investment progress separately per "life goal" (retirement, house, emergency fund, etc.)
- Uses IP-restricted API keys + 2FA for withdrawal confirmation — never holds user funds
- Includes a DCA calculator with cycle-aware return modeling based on Bitcoin's 4-year halving cycles
- Completely free — monetized through affiliate links to exchanges and hardware wallets

=== KEY DIFFERENTIATORS ===
- Unlike dcabtc.com (calculator only) — this platform actually AUTOMATES purchases
- Unlike exchange built-in auto-invest — works across multiple exchanges, adds withdrawal automation
- Unlike trading bots — focused purely on long-term DCA accumulation, not speculation
- Unique cycle-aware calculator that models diminishing returns per halving cycle (not flat CAGR)
- Per-goal tracking — separate strategies for different financial objectives

=== WRITING GUIDELINES ===
- Write authoritative but approachable content — like a knowledgeable friend, not a textbook
- Use concrete numbers and data wherever possible (historical returns, percentages, dollar amounts)
- Every article must provide genuine standalone value — a reader should learn something useful even if they never use any tool
- Never use hype language ("to the moon", "guaranteed returns", "get rich quick")
- Always include a brief disclaimer that this is not financial advice
- Target keyword density: primary keyword 3-5 times naturally, not stuffed

=== LINK PLACEMENT RULES (CRITICAL) ===
- Include 2-3 links to {site_url} but NEVER show the bare URL or domain name as visible text
- ALWAYS link through descriptive keyword anchor text related to the content — examples:
  "[automate recurring Bitcoin purchases]({site_url})", "[cycle-aware DCA calculator]({site_url})", "[track separate investment goals]({site_url})", "[set up automatic withdrawals to cold storage]({site_url})"
- NEVER write "visit", "check out", "go to", or "try" followed by a site name or URL
- NEVER write the domain name as visible text — the reader should see a useful descriptive phrase, not a URL or brand
- The linked phrase should describe a FEATURE or BENEFIT that the reader is already curious about from the article
- Place links where the article naturally discusses a problem that the tool solves — the reader clicks because the anchor text promises something useful, not because you told them to visit a website
- End with a brief, topic-relevant closing thought — NOT a "sign up now" style call-to-action"""

_ARTICLE_PROMPT = """Write a comprehensive, SEO-optimized blog article in English.

=== ARTICLE BRIEF ===
Topic: {title_hint}
Angle: {angle}
Primary SEO keyword: "{seo_keyword}"
Funnel stage: {funnel_stage}

=== KEY POINTS TO COVER ===
{key_points}

=== FORMAT REQUIREMENTS ===
- Approximately 1500 words
- Markdown formatting with ## subheadings (NOT # — reserved for title)
- 4-6 subheadings with at least 2 containing the SEO keyword naturally
- Compelling hook in the first paragraph — start with a surprising stat, question, or scenario
- The first or second paragraph MUST include one link to {site_url} through a descriptive anchor phrase (NOT the domain name)
- SEO keyword in: first paragraph, at least 2 subheadings, conclusion
- Include a one-line disclaimer: *This article is for educational purposes only and does not constitute financial advice.*

Do NOT include the title as a heading.
Do NOT include image placeholders.

Respond using EXACTLY this format (no JSON, no code fences — plain text with these exact markers):
TITLE: <SEO-friendly title, max 100 chars>
TAGS: <tag1>, <tag2>, <tag3>
BODY:
<full article body in markdown — everything after this line until end of response>"""


async def write_article_from_plan(plan: ContentPlan) -> Article:
    system = _SYSTEM_CONTEXT.format(
        site_url=config.site_url,
    )

    # Load site context (pages, affiliate links) and user feedback
    site_ctx = await get_site_context()
    site_section = format_site_context_for_prompt(site_ctx)
    feedback_section = get_feedback_for_prompt()

    extra_sections = ""
    if site_section:
        extra_sections += f"\n\n{site_section}"
    if feedback_section:
        extra_sections += f"\n\n{feedback_section}"

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
    prompt = f"{system}{extra_sections}\n\n---\n\n{user_prompt}"
    raw = await generate_text(prompt, temperature=0.7, max_tokens=8192, json_mode=False)

    title = ""
    tags: list[str] = []
    body = ""

    lines = raw.splitlines()
    body_start_idx = None
    for i, line in enumerate(lines):
        if not title and line.startswith("TITLE:"):
            title = line[len("TITLE:"):].strip()[:100]
        elif not tags and line.startswith("TAGS:"):
            raw_tags = line[len("TAGS:"):].strip()
            tags = [t.strip()[:25] for t in raw_tags.split(",") if t.strip()][:3]
        elif line.strip() == "BODY:":
            body_start_idx = i + 1
            break

    if body_start_idx is not None:
        body = "\n".join(lines[body_start_idx:]).strip()

    if not title or not body:
        raise RuntimeError(f"Failed to parse writer response (missing title or body): {raw[:300]}")

    if not tags:
        tags = [t[:25] for t in plan.tags[:3]]

    if config.site_url not in body:
        body += (
            f"\n\n---\n\n*Whether you invest $10 or $1,000 per month, the key is consistency — "
            f"and [automating your Bitcoin DCA]({config.site_url}) makes consistency effortless.*"
        )

    return Article(title=title, body=body, tags=tags)
