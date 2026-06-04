from __future__ import annotations

import logging
import random
from urllib.parse import quote

import httpx

from agent_m.gemini.researcher import Topic

log = logging.getLogger(__name__)

_POLLINATIONS_URL = "https://image.pollinations.ai/prompt/{prompt}"

_IMAGE_MODELS = [
    {"param": "klein", "name": "FLUX.2 Klein 4B"},
]

_POLLINATIONS_ATTEMPTS = 1

_STYLES = [
    "clean modern flat illustration with geometric shapes",
    "abstract digital art with flowing gradients",
    "minimalist vector illustration with bold colors",
    "isometric 3D render with soft lighting",
    "watercolor-style digital painting with crisp edges",
    "futuristic neon-lit cyberpunk aesthetic",
    "warm photorealistic still-life composition",
    "paper-cut layered artwork with depth shadows",
]

async def generate_header_image(topic: Topic) -> tuple[bytes, str]:
    style = random.choice(_STYLES)
    seed = random.randint(1, 999_999)
    angle_hint = f" Angle: {topic.angle}." if topic.angle else ""

    prompt = (
        f"Blog header image: {topic.title}.{angle_hint} "
        f"Style: {style}, Bitcoin orange (#F7931A) accents, "
        f"Bitcoin coin symbol, recurring purchase rhythm, calm automated investing, "
        f"dollar-cost averaging visual metaphor. Purely visual, NO text, NO letters, "
        f"NO words, NO numbers, NO typography, NO watermarks, NO company logos. "
        f"Wide editorial banner, high quality, 1200x630."
    )
    return await _generate_with_pollinations(prompt, seed=seed)


async def _generate_with_pollinations(prompt: str, seed: int | None = None) -> tuple[bytes, str]:
    url = _POLLINATIONS_URL.format(prompt=quote(prompt))
    last_error: Exception | None = None

    model_info = _IMAGE_MODELS[0]
    params = {
        "width": 1200,
        "height": 630,
        "model": model_info["param"],
        "nologo": "true",
        "negative_prompt": (
            "text, letters, words, numbers, typography, writing, caption, "
            "title, label, watermark, logo, signature, stamp, badge, "
            "handwriting, calligraphy, font, alphabet, characters, "
            "low quality, blurry, distorted, ugly, broken, deformed"
        ),
    }
    if seed is not None:
        params["seed"] = str(seed)

    for attempt in range(1, _POLLINATIONS_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=90.0, follow_redirects=True) as client:
                resp = await client.get(url, params=params)
                if resp.status_code != 200:
                    raise RuntimeError(f"Pollinations HTTP {resp.status_code}: {resp.text[:200]}")

                content_type = resp.headers.get("content-type", "")
                if "image" not in content_type and len(resp.content) < 1000:
                    raise RuntimeError(f"Pollinations returned non-image: {content_type}")

                model_name = model_info["name"]
                log.info(
                    "Generated image via Pollinations [%s] (%d bytes, seed=%s, attempt=%d)",
                    model_name, len(resp.content), seed, attempt,
                )
                return resp.content, model_name
        except Exception as exc:
            last_error = exc
            log.warning(
                "Pollinations [%s] attempt %d/%d failed: %s",
                model_info["name"], attempt, _POLLINATIONS_ATTEMPTS, exc,
            )

    raise RuntimeError(
        "Pollinations Klein image generation failed; retry later rather than using a low-quality fallback. "
        f"Last: {last_error}"
    )
