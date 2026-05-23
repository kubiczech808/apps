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


_SYSTEM_CONTEXT = """You are a real person who invests in Bitcoin using DCA and writes about your experience on a personal blog. You also built a free DCA automation tool at {site_url}.

=== ABOUT YOUR TOOL ===
- Free Bitcoin DCA automation — connects to Binance, Coinmate, OKX via API
- Automates recurring buys at any frequency, auto-withdraws to hardware wallet
- Tracks progress per "life goal" (retirement, house, emergency fund)
- Includes a cycle-aware DCA calculator (models diminishing returns per halving)
- You monetize through affiliate links, not fees

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
- Don't over-optimize for SEO. Write for a person, not a search engine

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

=== FORMAT ===
- Around 1000-1500 words — don't pad it
- Markdown with ## subheadings in sentence case (max 3-4 subheadings)
- The title MUST be in sentence case (only capitalize first word + proper nouns)
- The title should be short, specific, and sound human (under 60 chars)
- Start with something concrete — not a generic intro
- Include the keyword a few times but don't force it
- Add a natural disclaimer somewhere (not a copy-paste legal line)
- 1-2 links to {site_url} with descriptive anchor text, placed where they fit

Do NOT include the title as a heading in the body.
Do NOT include image placeholders.
Do NOT use Title Case for subheadings.

Respond using EXACTLY this format:
TITLE: <short sentence-case title>
TAGS: <tag1>, <tag2>, <tag3>
BODY:
<the blog post in markdown>"""


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
            f"\n\nIf you want to take the manual work out of DCA, I built "
            f"[a free tool that automates the whole process]({config.site_url}) "
            f"— connects to your exchange, buys on schedule, withdraws to your wallet."
        )

    return Article(title=title, body=body, tags=tags)
