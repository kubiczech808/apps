from __future__ import annotations

import logging

from agent_m.gemini.client import generate_image, generate_image_native
from agent_m.gemini.researcher import Topic

log = logging.getLogger(__name__)


async def generate_header_image(topic: Topic) -> bytes:
    prompt = (
        f"Professional blog header image for an article about Bitcoin Dollar-Cost Averaging. "
        f"Theme: {topic.title}. "
        f"Style: clean, modern financial illustration with Bitcoin orange (#F7931A) accents. "
        f"No text, no watermarks, no logos. 16:9 aspect ratio."
    )
    try:
        return await generate_image(prompt)
    except Exception as exc:
        log.info("Imagen failed (%s), trying Gemini native image generation", exc)

    return await generate_image_native(prompt)
