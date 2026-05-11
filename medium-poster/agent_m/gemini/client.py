from __future__ import annotations

import asyncio
import logging

from google import genai
from google.genai import types

from agent_m.config import config
from agent_m.token_tracker import TokenTracker

log = logging.getLogger(__name__)

_MODELS = ["gemini-2.0-flash-001", "gemini-1.5-flash-001", "gemini-1.5-flash-8b-001"]

_client: genai.Client | None = None
_tracker: TokenTracker | None = None


def get_client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(api_key=config.gemini_api_key)
    return _client


def get_tracker() -> TokenTracker:
    global _tracker
    if _tracker is None:
        _tracker = TokenTracker(config.data_dir)
    return _tracker


async def generate_text(prompt: str, *, temperature: float = 0.8, max_tokens: int = 4096) -> str:
    client = get_client()
    last_error: Exception | None = None

    for model in _MODELS:
        for attempt in range(3):
            try:
                response = await client.aio.models.generate_content(
                    model=model,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        temperature=temperature,
                        max_output_tokens=max_tokens,
                        automatic_function_calling=types.AutomaticFunctionCallingConfig(
                            disable=True,
                        ),
                    ),
                )
                if response.usage_metadata:
                    await get_tracker().track(
                        prompt_tokens=response.usage_metadata.prompt_token_count or 0,
                        completion_tokens=response.usage_metadata.candidates_token_count or 0,
                    )
                if model != _MODELS[0]:
                    log.info("Generated with fallback model: %s", model)
                return response.text or ""
            except Exception as e:
                last_error = e
                err_lower = str(e).lower()
                is_rate_limit = any(k in err_lower for k in ("429", "resource_exhausted", "quota", "rate"))
                log.warning("Gemini %s attempt %d/%d: %s", model, attempt + 1, 3, str(e)[:200])
                if is_rate_limit and attempt < 2:
                    wait = 10 * (2 ** attempt)
                    log.warning("Rate limited — waiting %ds before retry", wait)
                    await asyncio.sleep(wait)
                else:
                    break  # non-rate-limit or last attempt, try next model

    raise RuntimeError(f"All Gemini models failed. Last error: {last_error}")


async def generate_image(prompt: str) -> bytes:
    import asyncio

    client = get_client()

    def _sync_generate() -> bytes:
        response = client.models.generate_images(
            model="imagen-3.0-generate-002",
            prompt=prompt,
            config=types.GenerateImagesConfig(
                number_of_images=1,
                output_mime_type="image/jpeg",
                aspect_ratio="16:9",
            ),
        )
        if not response.generated_images:
            raise RuntimeError("Imagen returned no images")
        return response.generated_images[0].image.image_bytes

    return await asyncio.to_thread(_sync_generate)
