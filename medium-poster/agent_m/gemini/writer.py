from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass

from agent_m.config import config
from agent_m.content_plan import ContentPlan
from agent_m.feedback import get_feedback_for_prompt
from agent_m.gemini.client import generate_text
from agent_m.site_context import format_site_context_for_prompt, get_site_context

log = logging.getLogger(__name__)

_PROPER_CASE = {
    "bitcoin": "Bitcoin", "btc": "BTC", "dca": "DCA", "etf": "ETF",
    "hodl": "HODL", "fomo": "FOMO", "binance": "Binance", "coinmate": "Coinmate",
    "okx": "OKX", "trezor": "Trezor", "ledger": "Ledger", "s&p": "S&P",
    "fifo": "FIFO", "lifo": "LIFO", "cagr": "CAGR", "ath": "ATH",
    "monday": "Monday", "tuesday": "Tuesday", "wednesday": "Wednesday",
    "thursday": "Thursday", "friday": "Friday", "saturday": "Saturday", "sunday": "Sunday",
    "i": "I",
}


def _to_sentence_case(title: str) -> str:
    parts = re.split(r'([.?!:]\s+)', title)
    result = []
    for part in parts:
        if not part:
            continue
        if re.match(r'^[.?!:]\s+$', part):
            result.append(part)
            continue
        lowered = part[0].upper() + part[1:].lower() if len(part) > 1 else part.upper()
        words = lowered.split()
        for j, word in enumerate(words):
            if re.search(r'\d', word):
                words[j] = re.sub(r'([0-9])([a-z])', lambda m: m.group(1) + m.group(2).upper(), word)
                continue
            clean = re.sub(r'[^a-z&]', '', word.lower())
            if clean in _PROPER_CASE:
                prefix = word[:len(word) - len(word.lstrip('("\''))]
                suffix = word[len(word.rstrip('.,;:!?"\')')):]  if word.rstrip('.,;:!?"\')') != word else ""
                core = _PROPER_CASE[clean]
                words[j] = prefix + core + suffix
        result.append(" ".join(words))
    return "".join(result)


@dataclass
class Article:
    title: str
    body: str
    tags: list[str]


_SYSTEM_CONTEXT = """You are a real person who invests in Bitcoin using DCA and writes about your experience on a personal blog. You also built a free DCA automation tool at {site_url}.

=== ABOUT YOUR TOOL ===
- Free Bitcoin DCA automation — connects to Binance, Coinmate, OKX via API
- Automates recurring buys at any frequency, auto-withdraws to hardware wallet
- Tracks progress per "life goal" (retirement, house, emergency fund)
- Includes a cycle-aware DCA calculator (models diminishing returns per halving)
- You monetize through affiliate links, not fees

=== MEDIUM ENGAGEMENT ===
- Write for Medium readers who do not know you yet: the title and first 5 lines must carry the article
- Titles must be searchable AND clickable: specific, slightly opinionated, no vague diary titles
- Good title shape: "Bitcoin DCA in a bull market: the rule I use" or "Why I stopped waiting for Bitcoin dips"
- First 120 words must establish tension: what most people do, what you do differently, and why it matters
- Include at least one concrete rule, threshold, checklist, or example that readers can argue with or save
- End with a short reflective question that can invite comments, not a sales CTA

=== WRITING STYLE (CRITICAL — your posts MUST read like a real person wrote them) ===
- Write like a blog post, not an article. Use "I", share opinions, admit uncertainty
- Sentence case everywhere — only capitalize the first word and proper nouns (Bitcoin, Binance, etc.)
- Keep titles short (under 60 chars), lowercase style: "How I handle dips in my DCA plan"
- NO listicle-style titles ("7 ways to...", "The ultimate guide to...")
- NO generic filler intros ("In the world of cryptocurrency...", "Bitcoin has been...")
- Start with something specific — a personal anecdote, a concrete number, a question you actually had
- Vary paragraph length. Some short. Some longer with actual reasoning
- Use casual transitions, not formal ones ("So here's the thing" not "Furthermore")
- Include at least one opinion or mild disagreement with mainstream crypto advice
- Mention a specific mistake you made or almost made — makes it real
- NO excessive formatting — max 3-4 subheadings, not 6+. Some sections can just flow
- The disclaimer should feel natural, not copy-pasted: something like "Obviously I'm not your financial advisor — do your own research"

=== SEO STRUCTURE (important for search ranking — follow strictly) ===
- The TITLE MUST contain the main SEO keyword naturally — this determines the article URL slug
- First paragraph: mention the SEO keyword within the first 2-3 sentences
- At least one ## subheading should include the SEO keyword or a close variation
- Use the SEO keyword 3-5 times total throughout the article, always naturally
- Write a strong opening sentence that works as a meta description (~150 chars) — search engines pull it from the first paragraph
- Use descriptive anchor text for ALL links — never use "click here" or raw URLs
- Bold (**) the SEO keyword once in the body where it appears naturally
- Keep paragraphs under 300 words for readability (important for SEO scanners)

=== LINK PLACEMENT ===
- Include 1-2 links to {site_url} through descriptive anchor text (NOT the domain name)
- Examples: "[automate my DCA buys]({site_url})", "[the calculator I built]({site_url})"
- Place links only where they genuinely fit the context
- End with a brief closing thought, not a call-to-action"""

_ARTICLE_PROMPT = """Write a personal blog post in English about this topic.

=== TOPIC ===
{title_hint}
Angle: {angle}
Keyword to include naturally: "{seo_keyword}"

=== POINTS TO TOUCH ON ===
{key_points}

=== MEDIUM FORMAT OVERRIDES ===
- Around 900-1300 words; prioritize density over length
- The title should be specific enough for search and interesting enough for Medium readers (45-75 chars)
- The first 2-3 lines must create a reason to keep reading: tension, mistake, contrarian angle, or practical payoff
- Include one concrete rule, threshold, example, or mini-checklist that a reader could save
- End with one short discussion question related to the article's tradeoff or strategy

=== FORMAT ===
- Around 1000-1500 words — don't pad it
- Markdown with ## subheadings in sentence case (max 3-4 subheadings)
- The title MUST be in sentence case (only capitalize first word + proper nouns)
- The title MUST contain "{seo_keyword}" or a very close natural variation — this becomes the URL slug
- The title should be short, specific, and sound human (under 60 chars)
- Start with something concrete — not a generic intro
- First paragraph must mention "{seo_keyword}" naturally — search engines use it as meta description
- At least one ## subheading must include "{seo_keyword}" or a close variation
- Use "{seo_keyword}" 3-5 times in the body, bold it (**keyword**) once where it fits naturally
- Add a natural disclaimer somewhere (not a copy-paste legal line)
- 1-2 links to {site_url} with keyword-rich descriptive anchor text, placed where they fit
- ALL links must use descriptive anchor text — never raw URLs, never "click here"

Do NOT include the title as a heading in the body.
Do NOT include image placeholders.
Do NOT use Title Case for subheadings.

Respond using EXACTLY this format:
TITLE: <short sentence-case title>
TAGS: <tag1>, <tag2>, <tag3>, <tag4>, <tag5>
BODY:
<the blog post in markdown>"""


async def write_article_from_plan(plan: ContentPlan) -> Article:
    system = _SYSTEM_CONTEXT.format(
        site_url=config.site_url,
    )

    log.info("Writer: loading site context")
    try:
        site_ctx = await asyncio.wait_for(get_site_context(), timeout=20)
    except asyncio.TimeoutError:
        log.warning("Writer: site context timed out after 20s, using no scraped context")
        site_ctx = {
            "site_url": config.site_url.rstrip("/"),
            "pages": [],
            "affiliate_links": [],
        }
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

    article: Article | None = None
    last_raw = ""
    for attempt in range(3):
        extra = "" if attempt == 0 else (
            "\n\nIMPORTANT: Use exactly this plain text structure, with TITLE, TAGS, and BODY labels. "
            "Do not wrap the response in markdown fences."
        )
        temperature = 0.7 if attempt == 0 else 0.35
        log.info("Writer: Gemini article generation attempt %d/3", attempt + 1)
        raw = await generate_text(prompt + extra, temperature=temperature, max_tokens=8192, json_mode=False)
        last_raw = raw
        article = _parse_writer_response(raw, plan)
        if article:
            break
        log.warning("Writer: parse failed on attempt %d/3. Response head: %s", attempt + 1, raw[:300])

    if not article:
        raise RuntimeError(f"Failed to parse writer response after retries: {last_raw[:300]}")

    title = article.title
    body = article.body
    tags = _finalize_tags(article.tags, plan)

    if config.site_url not in body:
        body += (
            f"\n\nThis is also why I keep improving "
            f"[my Bitcoin DCA automation setup]({config.site_url}) instead of trying to make every buy decision manually."
        )

    return Article(title=title, body=body, tags=tags)


def _parse_writer_response(raw: str, plan: ContentPlan) -> Article | None:
    title = ""
    tags: list[str] = []
    body = ""

    lines = raw.splitlines()
    body_start_idx = None
    for i, line in enumerate(lines):
        if not title and line.startswith("TITLE:"):
            title = _to_sentence_case(line[len("TITLE:"):].strip()[:100])
        elif not tags and line.startswith("TAGS:"):
            raw_tags = line[len("TAGS:"):].strip()
            tags = [t.strip()[:25] for t in raw_tags.split(",") if t.strip()][:5]
        elif line.strip() == "BODY:":
            body_start_idx = i + 1
            break

    if body_start_idx is not None:
        body_lines = lines[body_start_idx:]
        for idx, bl in enumerate(body_lines):
            if bl.startswith("## "):
                body_lines[idx] = "## " + _to_sentence_case(bl[3:])
            elif bl.startswith("### "):
                body_lines[idx] = "### " + _to_sentence_case(bl[4:])
        body = "\n".join(body_lines).strip()

    if not title or not body:
        return None

    tags = _finalize_tags(tags, plan)

    return Article(title=title, body=body, tags=tags)


def _finalize_tags(tags: list[str], plan: ContentPlan) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for tag in [*tags, *plan.tags, "Bitcoin", "DCA", "Investing", "Personal Finance"]:
        cleaned = " ".join(tag.strip().split())[:25]
        key = cleaned.lower()
        if cleaned and key not in seen:
            result.append(cleaned)
            seen.add(key)
        if len(result) >= 5:
            break
    return result
