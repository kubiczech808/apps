from __future__ import annotations

import logging
from urllib.parse import quote

import httpx

from agent_m.gemini.researcher import Topic

log = logging.getLogger(__name__)

_POLLINATIONS_URL = "https://image.pollinations.ai/prompt/{prompt}"


async def generate_header_image(topic: Topic) -> bytes:
    prompt = (
        f"Professional blog header image for an article about Bitcoin Dollar-Cost Averaging. "
        f"Theme: {topic.title}. "
        f"Style: clean, modern financial illustration with Bitcoin orange (#F7931A) accents. "
        f"No text, no watermarks, no logos. 16:9 aspect ratio."
    )
    return await _generate_with_pollinations(prompt)


async def _generate_with_pollinations(prompt: str) -> bytes:
    url = _POLLINATIONS_URL.format(prompt=quote(prompt))
    params = {"width": 1200, "height": 630, "model": "klein", "nologo": "true"}

    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        resp = await client.get(url, params=params)
        if resp.status_code != 200:
            raise RuntimeError(f"Pollinations HTTP {resp.status_code}: {resp.text[:200]}")

        content_type = resp.headers.get("content-type", "")
        if "image" not in content_type and len(resp.content) < 1000:
            raise RuntimeError(f"Pollinations returned non-image: {content_type}")

        log.info("Generated image via Pollinations (%d bytes)", len(resp.content))
        return resp.content
