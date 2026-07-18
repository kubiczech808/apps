#!/usr/bin/env python3
"""Harden OpenClaw image generation prompts without replacing runtime scripts.

The virtual assistant/XOZ image flow produces clean images because it asks for a
realistic, text-free scene and lets Pollinations run with nologo=true. Agent D
and older Agent C paths were still allowed to add headline/logo overlays or use
text-trap subjects such as dashboards, charts, documents and neon numbers.

This patcher is intentionally idempotent and surgical so it can run from GitHub
Actions on the self-hosted runner without overwriting parallel Claude Code work.
"""

from __future__ import annotations

import datetime as dt
import re
import shutil
import subprocess
from pathlib import Path


VERSION = "2026-07-18-no-text-clean-images-v1"

AGENT_D_APPROVE = Path("/home/openclaw2/scripts/x_approve.py")
AGENT_D_DAILY = Path("/home/openclaw2/.openclaw/x_post.py")
AGENT_C_BLOGGER = Path("/home/openclaw2/scripts/btc-dca-blogger.py")


def log(message: str) -> None:
    print(f"[image-quality] {message}")


def backup(path: Path) -> None:
    stamp = dt.datetime.now().strftime("%Y%m%d%H%M%S")
    dest = path.with_name(path.name + f".bak-image-quality-{stamp}")
    shutil.copy2(path, dest)
    log(f"backup: {path} -> {dest}")


def replace_once(text: str, pattern: str, repl: str, label: str, *, flags: int = re.S) -> tuple[str, bool]:
    new_text, count = re.subn(pattern, lambda _match: repl, text, count=1, flags=flags)
    if count:
        log(f"patched: {label}")
        return new_text, True
    log(f"unchanged: {label} pattern not found")
    return text, False


def replace_literal(text: str, old: str, new: str, label: str) -> tuple[str, bool]:
    if old in text:
        log(f"patched: {label}")
        return text.replace(old, new), True
    log(f"unchanged: {label} literal not found")
    return text, False


AGENT_D_NO_TEXT = '''NO_TEXT = (
    "Clean premium editorial image, purely visual, no rendered writing, no letters, "
    "no words, no numbers, no captions, no typography, no UI text, no watermarks, "
    "no logos, no brand marks, no Bitcoin logo, no BTC or DCA letters, no ticker symbols, "
    "no coin rim markings, no signs, no screens, no dashboards, no documents, "
    "no pseudo-text, no random glyphs, no code rain. Represent ideas only through "
    "unmarked objects, light, composition, blank geometric forms and atmosphere."
)'''


AGENT_D_NEGATIVE = '''NEGATIVE_IMAGE_PROMPT = (
    "text, letters, words, captions, labels, signs, inscriptions, engravings, markings, numbers, "
    "typography, headline, slogan, glyphs, runes, pseudo-writing, gibberish text, random text, "
    "ticker symbols, BTC letters, DCA letters, dollar signs, UI text, dashboards, screens, "
    "banners, placards, text panels, paper, documents, banknotes, newspapers, maps, charts, "
    "diagrams, blueprints, strategy boards, control panels, stamps, seals, pictograms, "
    "small icons, coin logos, altcoin logos, brand logos, project logos, fake logos, "
    "watermarks, signatures, corner logos, stock symbols, humans, people, faces, bodies, "
    "hands, fingers, clothing"
)'''


def no_op_function(name: str, args: str, message: str, returns: str = "return None") -> str:
    return f'''def {name}({args}):
    log("{message} ({VERSION})")
    {returns}

'''


def patch_agent_d_approve(text: str) -> tuple[str, bool]:
    changed = False

    text, did = replace_once(
        text,
        r"NO_TEXT\s*=\s*\(.*?\)\s*\n\nCOOKIES_FILE",
        AGENT_D_NO_TEXT + "\n\nCOOKIES_FILE",
        "Agent D approve NO_TEXT policy",
    )
    changed |= did

    text, did = replace_once(
        text,
        r"def generate_title_words\(tweet, gemini_key\):\n.*?\n(?=def generate_image_prompt\()",
        no_op_function(
            "generate_title_words",
            "tweet, gemini_key",
            "Title words disabled; image must stay text-free",
            "return None",
        ),
        "Agent D approve title word generation disabled",
    )
    changed |= did

    text, did = replace_once(
        text,
        r"def add_title_overlay\(img_path, title\):\n.*?\n(?=def add_logo_watermark\()",
        no_op_function(
            "add_title_overlay",
            "img_path, title",
            "Title overlay disabled; approval caption carries text instead",
            "return None",
        ),
        "Agent D approve title overlay disabled",
    )
    changed |= did

    text, did = replace_once(
        text,
        r"def add_logo_watermark\(img_path\):\n.*?\n(?=def is_regen_command\()",
        no_op_function(
            "add_logo_watermark",
            "img_path",
            "Logo watermark disabled; generated image must stay clean",
            "return None",
        ),
        "Agent D approve logo watermark disabled",
    )
    changed |= did

    text, did = replace_literal(
        text,
        "render it as large glowing neon text centered in the scene.",
        "represent it through blank repeated objects, scale, spacing or light intensity; never render digits, letters or words.",
        "Agent D approve numeric text trap removed",
    )
    changed |= did

    text, did = replace_literal(
        text,
        "- If a number was given above, include it explicitly as styled neon text in the scene",
        "- If a number was given above, imply it with repeated blank shapes, scale, spacing or light intensity; never render digits, words, tickers or labels",
        "Agent D approve neon text instruction removed",
    )
    changed |= did

    text, did = replace_literal(
        text,
        "- Cyberpunk aesthetic: neon, dark, futuristic",
        "- Premium editorial style: cinematic realistic materials, controlled contrast, clean composition, no text-bearing objects",
        "Agent D approve style made cleaner",
    )
    changed |= did

    text, did = replace_literal(
        text,
        "You are creating an image generation prompt for a cyberpunk-styled Bitcoin DCA social media post.",
        "You are creating an image generation prompt for a clean premium editorial Bitcoin DCA social media post.",
        "Agent D approve prompt role made cleaner",
    )
    changed |= did

    if "'negative_prompt':" not in text:
        text, did = replace_literal(
            text,
            "'seed': pollinations_seed,\n        }",
            "'seed': pollinations_seed,\n            'negative_prompt': 'text, letters, words, numbers, typography, headline, caption, logo, watermark, UI text, pseudo text, random glyphs, brand marks, screens, dashboards, documents',\n        }",
            "Agent D approve Pollinations negative prompt added",
        )
        changed |= did
    else:
        log("unchanged: Agent D approve Pollinations negative prompt already present")

    return text, changed


def patch_agent_d_daily(text: str) -> tuple[str, bool]:
    changed = False

    text, did = replace_once(
        text,
        r"NO_TEXT\s*=\s*\(.*?\)\nNEGATIVE_IMAGE_PROMPT\s*=",
        AGENT_D_NO_TEXT + "\n" + AGENT_D_NEGATIVE.split("=", 1)[0] + "=",
        "Agent D daily NO_TEXT policy",
    )
    changed |= did

    text, did = replace_once(
        text,
        r"NEGATIVE_IMAGE_PROMPT\s*=\s*\(.*?\)\n\ndef recent_image_context",
        AGENT_D_NEGATIVE + "\n\ndef recent_image_context",
        "Agent D daily negative prompt",
    )
    changed |= did

    text, did = replace_once(
        text,
        r"def add_title_overlay\(img_path, title\):\n.*?\n(?=def _fetch_logo\()",
        no_op_function(
            "add_title_overlay",
            "img_path, title",
            "Title overlay disabled; Telegram caption carries approval text instead",
            "return None",
        ),
        "Agent D daily title overlay disabled",
    )
    changed |= did

    text, did = replace_once(
        text,
        r"def add_logo_watermark\(img_path\):\n.*?\n(?=def send_photo_with_buttons\()",
        no_op_function(
            "add_logo_watermark",
            "img_path",
            "Logo watermark disabled; generated image must stay clean",
            "return None",
        ),
        "Agent D daily logo watermark disabled",
    )
    changed |= did

    text, did = replace_once(
        text,
        r"def generate_image_headline\(tweet, gemini_key\):\n.*?\n(?=FALLBACK_HEADLINES\s*=)",
        no_op_function(
            "generate_image_headline",
            "tweet, gemini_key",
            "Image headline disabled; no text overlays in generated assets",
            "return ''",
        ),
        "Agent D daily first headline generator disabled",
    )
    changed |= did

    text, did = replace_once(
        text,
        r"def generate_image_headline\(tweet, gemini_key, state=None, current=None\):\n.*?\n(?=def add_title_overlay\()",
        no_op_function(
            "generate_image_headline",
            "tweet, gemini_key, state=None, current=None",
            "Image headline disabled; no text overlays in generated assets",
            "return ''",
        ),
        "Agent D daily second headline generator disabled",
    )
    changed |= did

    replacements = [
        (
            "Headline overlay that will be added after generation:\n{headline or 'curiosity headline from the tweet'}",
            "No headline overlay will be added after generation; the image itself must stay purely visual and text-free.",
            "Agent D daily prompt no longer promises headline overlay",
        ),
        (
            "- Shows a Bitcoin coin symbol / clean Bitcoin B-with-two-vertical-strokes emblem, recurring purchase rhythm, calm automated investing, and a dollar-cost averaging visual metaphor",
            "- Shows recurring purchase rhythm, calm automated investing, and a dollar-cost averaging visual metaphor through unmarked objects and orange light accents, without any letters, numerals or logos",
            "Agent D daily Bitcoin logo requirement removed",
        ),
        (
            "- Do not render BTC letters, DCA letters, dollar signs, words, alphabets, or numeric characters. A single clean Bitcoin B-with-two-vertical-strokes emblem is allowed as a visual object. The project logo and headline text will be added programmatically after image generation",
            "- Do not render BTC letters, DCA letters, dollar signs, words, alphabets, numeric characters, brand marks, project logos, Bitcoin logos or coin rim symbols. No project logo or headline text will be added later.",
            "Agent D daily programmatic text/logo assumption removed",
        ),
        (
            "- Reserve a clean, darker lower band or negative space for the headline overlay above. Do NOT render the headline text yourself.",
            "- Use balanced negative space only for composition. Do not reserve a text band and do not render headline text, labels or logo marks yourself.",
            "Agent D daily reserved title band removed",
        ),
        (
            "- Include an unmistakable Bitcoin/DCA/investing automation association without text: one clean Bitcoin emblem plus recurring buy interval nodes, a smooth averaging staircase shape, automated investment packets, schedule rings, vaults, keys, locks, protective shields, lighthouses, compass paths, metronome/circuit rhythms, or set-and-forget flows",
            "- Include an unmistakable DCA/investing automation association without text: recurring buy interval nodes, a smooth averaging staircase shape, automated investment packets, schedule rings, vaults, keys, locks, protective shields, lighthouses, compass paths, metronome/circuit rhythms, or set-and-forget flows. Use blank orange circular assets, never marked coins.",
            "Agent D daily visual association made logo-free",
        ),
    ]
    for old, new, label in replacements:
        text, did = replace_literal(text, old, new, label)
        changed |= did

    return text, changed


AGENT_C_POLICY_BLOCK = '''
# --- Image quality policy override installed by harden_agent_image_quality.py ---
IMAGE_QUALITY_POLICY_VERSION = "__VERSION__"
RISKY_IMAGE_TERMS_RE = re.compile(
    r"\\b(?:screen|screens|dashboard|dashboards|document|documents|paper|papers|newspaper|newspapers|"
    r"magazine|magazines|poster|posters|billboard|billboards|sign|signs|label|labels|caption|captions|"
    r"headline|headlines|typography|lettering|word|words|text|texts|number|numbers|digit|digits|"
    r"ticker|tickers|logo|logos|watermark|watermarks|ui|interface|interfaces|chart|charts|graph|graphs|"
    r"diagram|diagrams|blueprint|blueprints|control panel|strategy board|banknote|banknotes)\\b",
    re.I,
)

def sanitize_image_prompt(prompt):
    """Runtime override: keep image prompts clean, realistic and text-free."""
    p = str(prompt or "").strip()
    p = re.sub(r"https?://\\S+", " ", p)
    p = re.sub(r"`[^`]*`", " ", p)
    p = re.sub(r"['\\"][^'\\"]{1,120}['\\"]", " ", p)
    p = re.sub(r"\\b\\d[\\d,.]*\\s*%?\\b", "several blank repeated shapes", p)
    p = re.sub(r"\\b(?:bitcoin|btc)\\s+(?:logo|symbol|mark|letter|letters)\\b", "blank orange circular asset", p, flags=re.I)
    p = RISKY_IMAGE_TERMS_RE.sub("blank abstract shape", p)
    p = re.sub(r"\\s+", " ", p).strip(" ,.;:-")
    if len(p) < 40:
        p = "premium realistic editorial finance still life with calm light, clean composition, blank abstract shapes, subtle orange accent"
    p = p[:420].rstrip(" ,.;:-")
    guard = (
        "Premium realistic editorial visual, one clear subject, cinematic natural light, refined materials, "
        "clean composition, no generated writing, no letters, no words, no numbers, no captions, no typography, "
        "no UI text, no watermarks, no logos, no brand marks, no pseudo-text, no signs, no screens, "
        "no dashboards, no documents, no charts, no graphs, no marked coins."
    )
    return f"{p}. {guard}"

def _image_prompts_avoid_forbidden_content(prompts):
    """Reject risky prompts before generation; fallback prompts are safer than text traps."""
    risky = (
        "readable text", "lettering", "typography", "caption", "watermark", "headline",
        "newspaper", "magazine", "billboard", "slogan", "dashboard", "screen", "document",
        "ticker", "logo", "chart", "graph", "diagram", "blueprint", "banknote",
        "numeric characters", "neon text", "text overlay",
    )
    for prompt in prompts or []:
        low = str(prompt or "").lower()
        if any(term in low for term in risky):
            return False
    return True

# --- End image quality policy override ---
'''.replace("__VERSION__", VERSION)


def patch_agent_c_blogger(text: str) -> tuple[str, bool]:
    changed = False

    if "IMAGE_QUALITY_POLICY_VERSION" in text:
        text, did = replace_once(
            text,
            r"# --- Image quality policy override installed by harden_agent_image_quality.py ---.*?# --- End image quality policy override ---\n",
            AGENT_C_POLICY_BLOCK.lstrip(),
            "Agent C image quality policy refreshed",
        )
        changed |= did
    else:
        marker = "# --- PHASES ---"
        if marker in text:
            text = text.replace(marker, AGENT_C_POLICY_BLOCK + "\n" + marker, 1)
            log("patched: Agent C image quality policy inserted")
            changed = True
        else:
            log("unchanged: Agent C phase marker not found")

    replacements = [
        (
            "Generate THREE image prompts for Pollinations AI.",
            "Generate THREE clean editorial image prompts for Pollinations AI.",
            "Agent C image prompt heading made cleaner",
        ),
        (
            "financial infographics with clear structure and strong composition",
            "premium editorial finance visuals with clear structure and strong composition",
            "Agent C infographic wording softened",
        ),
        (
            "- The ONLY hard ban is RENDERED WRITING: no readable text, letters, words, captions, watermarks, headlines, logos with text, newspapers, magazines, billboards, or pseudo-text/gibberish lettering anywhere in the image. Charts and arrows are fine as long as they carry no readable numbers or labels.",
            "- The hard ban is anything that tends to create visual text artifacts: no readable text, letters, words, captions, watermarks, headlines, logos, newspapers, magazines, billboards, dashboards, screens, documents, charts, graphs, diagrams, numbers, labels, pseudo-text or glyph-like marks anywhere in the image.",
            "Agent C prompt text-trap ban strengthened",
        ),
        (
            "no readable text, no letters, no words, no numbers, no captions, no typography, no UI text, no watermarks, no company logos, no pseudo-text, no gibberish writing, at most one Bitcoin B symbol if relevant, all other coins and markers completely blank and unmarked, never repeat a logo, safe for work",
            "no readable text, no letters, no words, no numbers, no captions, no typography, no UI text, no watermarks, no company logos, no brand marks, no pseudo-text, no gibberish writing, no Bitcoin logo or B letter, all coins and markers completely blank and unmarked, no screens, no dashboards, no documents, no charts, no graphs, safe for work",
            "Agent C no-text suffix made stricter",
        ),
        (
            "Label-free professional finance infographic, clear concrete subject, purely visual.",
            "Premium realistic editorial finance visual, clear concrete subject, purely visual, no text-bearing objects.",
            "Agent C no-text prefix made less infographic-like",
        ),
    ]
    for old, new, label in replacements:
        text, did = replace_literal(text, old, new, label)
        changed |= did

    return text, changed


def patch_file(path: Path, patcher) -> bool:
    if not path.exists():
        log(f"missing: {path}")
        return False
    original = path.read_text(encoding="utf-8", errors="replace")
    patched, changed = patcher(original)
    if not changed or patched == original:
        log(f"already current: {path}")
        return False
    backup(path)
    path.write_text(patched, encoding="utf-8")
    log(f"written: {path}")
    return True


def compile_file(path: Path) -> None:
    if path.exists():
        subprocess.run(["python3", "-m", "py_compile", str(path)], check=True)
        log(f"compiled: {path}")


def main() -> int:
    log(f"policy version: {VERSION}")
    changed = []
    for path, patcher in (
        (AGENT_D_APPROVE, patch_agent_d_approve),
        (AGENT_D_DAILY, patch_agent_d_daily),
        (AGENT_C_BLOGGER, patch_agent_c_blogger),
    ):
        if patch_file(path, patcher):
            changed.append(str(path))

    for path in (AGENT_D_APPROVE, AGENT_D_DAILY, AGENT_C_BLOGGER):
        compile_file(path)

    if changed:
        log("changed files: " + ", ".join(changed))
    else:
        log("no runtime changes needed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
