from __future__ import annotations

import logging
import random
from urllib.parse import quote

import httpx

from agent_m.gemini.researcher import Topic

log = logging.getLogger(__name__)

_POLLINATIONS_URL = "https://image.pollinations.ai/prompt/{prompt}"

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


async def generate_header_image(topic: Topic) -> bytes:
    style = random.choice(_STYLES)
    seed = random.randint(1, 999_999)
    angle_hint = f" Angle: {topic.angle}." if topic.angle else ""
    prompt = (
        f"Blog header image: {topic.title}.{angle_hint} "
        f"Style: {style}, Bitcoin orange (#F7931A) accents. "
        f"No text, no watermarks, no logos, no letters. Wide panoramic banner, aspect ratio 1000:420."
    )
    return await _generate_with_pollinations(prompt, seed=seed)


async def _generate_with_pollinations(prompt: str, seed: int | None = None) -> bytes:
    url = _POLLINATIONS_URL.format(prompt=quote(prompt))
    params = {"width": 1000, "height": 420, "model": "klein", "nologo": "true"}
    if seed is not None:
        params["seed"] = str(seed)

    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        resp = await client.get(url, params=params)
        if resp.status_code != 200:
            raise RuntimeError(f"Pollinations HTTP {resp.status_code}: {resp.text[:200]}")

        content_type = resp.headers.get("content-type", "")
        if "image" not in content_type and len(resp.content) < 1000:
            raise RuntimeError(f"Pollinations returned non-image: {content_type}")

        log.info("Generated image via Pollinations (%d bytes, seed=%s)", len(resp.content), seed)
        return resp.content
