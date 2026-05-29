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
    {"param": "turbo", "name": "Z-Image Turbo"},
]

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
        f"Style: {style}, Bitcoin orange (#F7931A) accents. "
        f"Purely visual, absolutely no text, no words, no letters, no numbers, "
        f"no writing, no captions, no titles, no watermarks, no logos, no signatures, "
        f"no typography of any kind. Wide banner, 1200x630."
    )
    return await _generate_with_pollinations(prompt, seed=seed)


async def _generate_with_pollinations(prompt: str, seed: int | None = None) -> tuple[bytes, str]:
    url = _POLLINATIONS_URL.format(prompt=quote(prompt))
    last_error: Exception | None = None

    for model_info in _IMAGE_MODELS:
        params = {
            "width": 1200,
            "height": 630,
            "model": model_info["param"],
            "nologo": "true",
            "negative_prompt": (
                "text, words, letters, numbers, writing, caption, title, "
                "watermark, logo, signature, typography, label, inscription, "
                "stamp, banner text, overlay text, font, handwriting"
            ),
        }
        if seed is not None:
            params["seed"] = str(seed)

        try:
            async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
                resp = await client.get(url, params=params)
                if resp.status_code != 200:
                    raise RuntimeError(f"Pollinations HTTP {resp.status_code}: {resp.text[:200]}")

                content_type = resp.headers.get("content-type", "")
                if "image" not in content_type and len(resp.content) < 1000:
                    raise RuntimeError(f"Pollinations returned non-image: {content_type}")

                model_name = model_info["name"]
                log.info(
                    "Generated image via Pollinations [%s] (%d bytes, seed=%s)",
                    model_name, len(resp.content), seed,
                )
                return resp.content, model_name
        except Exception as exc:
            last_error = exc
            log.warning("Pollinations [%s] failed: %s", model_info["name"], exc)

    raise RuntimeError(f"All Pollinations models failed. Last: {last_error}")
