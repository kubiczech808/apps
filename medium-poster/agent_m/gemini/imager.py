from __future__ import annotations

from agent_m.gemini.client import generate_image
from agent_m.gemini.researcher import Topic


async def generate_header_image(topic: Topic) -> bytes:
    prompt = (
        f"Professional blog header image for an article about Bitcoin Dollar-Cost Averaging. "
        f"Theme: {topic.title}. "
        f"Style: clean, modern financial illustration with Bitcoin orange (#F7931A) accents. "
        f"No text, no watermarks, no logos. 16:9 aspect ratio."
    )
    return await generate_image(prompt)
