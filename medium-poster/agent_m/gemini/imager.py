from __future__ import annotations

import asyncio
import logging
import random
from urllib.parse import quote

import httpx

from agent_m.config import config
from agent_m.gemini.researcher import Topic

log = logging.getLogger(__name__)

_PUBLIC_POLLINATIONS_URL = "https://image.pollinations.ai/p/{prompt}"
_AUTH_POLLINATIONS_URL = "https://gen.pollinations.ai/image/{prompt}"

_IMAGE_MODELS = [
    {"param": "flux", "name": "Pollinations Public FLUX"},
    {"param": "zimage", "name": "Pollinations Public Z-Image"},
]

_AUTH_IMAGE_MODELS = [
    {"param": "klein", "name": "FLUX.2 Klein 4B"},
    {"param": "gptimage", "name": "GPT Image"},
]

_POLLINATIONS_ATTEMPTS = 2
_POLLINATIONS_RETRY_DELAY_S = 20

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
        f"Wide editorial banner, high quality, 930x576."
    )
    return await _generate_with_pollinations(prompt, seed=seed)


async def _generate_with_pollinations(prompt: str, seed: int | None = None) -> tuple[bytes, str]:
    public_url = _PUBLIC_POLLINATIONS_URL.format(prompt=quote(prompt, safe=""))
    auth_url = _AUTH_POLLINATIONS_URL.format(prompt=quote(prompt, safe=""))
    last_error: Exception | None = None

    base_params = {
        "width": 930,
        "height": 576,
        "nologo": "true",
        "enhance": "false",
        "safe": "true",
        "negative_prompt": (
            "text, letters, words, numbers, typography, writing, caption, "
            "title, label, watermark, logo, signature, stamp, badge, "
            "handwriting, calligraphy, font, alphabet, characters, "
            "low quality, blurry, distorted, ugly, broken, deformed"
        ),
    }
    if seed is not None:
        base_params["seed"] = str(seed)
    headers = {
        "Accept": "image/*",
        "User-Agent": "agent-m-medium-poster/0.1",
    }

    for model_info in _IMAGE_MODELS:
        params = {**base_params, "model": model_info["param"]}
        for attempt in range(1, _POLLINATIONS_ATTEMPTS + 1):
            try:
                async with httpx.AsyncClient(timeout=90.0, follow_redirects=True) as client:
                    resp = await client.get(public_url, params=params, headers=headers)
                    _raise_for_bad_pollinations_response(resp)

                    model_name = model_info["name"]
                    log.info(
                        "Generated image via public Pollinations [%s] (%d bytes, seed=%s, attempt=%d)",
                        model_name, len(resp.content), seed, attempt,
                    )
                    return resp.content, model_name
            except Exception as exc:
                last_error = exc
                log.warning(
                    "Public Pollinations [%s] attempt %d/%d failed: %s",
                    model_info["name"], attempt, _POLLINATIONS_ATTEMPTS, exc,
                )
                if "HTTP 429" in str(exc):
                    break
                if attempt < _POLLINATIONS_ATTEMPTS:
                    await asyncio.sleep(_POLLINATIONS_RETRY_DELAY_S)

    if config.pollinations_api_key:
        auth_params = {**base_params, "key": config.pollinations_api_key}
        for model_info in _AUTH_IMAGE_MODELS:
            params = {**auth_params, "model": model_info["param"]}
            for attempt in range(1, _POLLINATIONS_ATTEMPTS + 1):
                try:
                    async with httpx.AsyncClient(timeout=90.0, follow_redirects=True) as client:
                        resp = await client.get(auth_url, params=params, headers=headers)
                        _raise_for_bad_pollinations_response(resp)

                        model_name = model_info["name"]
                        log.info(
                            "Generated image via authenticated Pollinations [%s] (%d bytes, seed=%s, attempt=%d)",
                            model_name, len(resp.content), seed, attempt,
                        )
                        return resp.content, model_name
                except Exception as exc:
                    last_error = exc
                    log.warning(
                        "Authenticated Pollinations [%s] attempt %d/%d failed: %s",
                        model_info["name"], attempt, _POLLINATIONS_ATTEMPTS, exc,
                    )
                    if "model balance unavailable" in str(exc):
                        break
                    if attempt < _POLLINATIONS_ATTEMPTS:
                        await asyncio.sleep(_POLLINATIONS_RETRY_DELAY_S)

    raise RuntimeError(
        "Pollinations public image generation failed across allowed models; retry later rather than using a low-quality fallback. "
        f"Last: {last_error}"
    )


def _raise_for_bad_pollinations_response(resp: httpx.Response) -> None:
    if resp.status_code != 200:
        message = f"Pollinations HTTP {resp.status_code}: {resp.text[:200]}"
        if resp.status_code == 402 and "PAYMENT_REQUIRED" in resp.text:
            raise RuntimeError(f"{message} (model balance unavailable)")
        raise RuntimeError(message)

    content_type = (resp.headers.get("content-type") or "").lower()
    if not content_type.startswith("image/"):
        snippet = resp.text[:200] if resp.text else ""
        raise RuntimeError(f"Pollinations returned non-image: {content_type} {snippet}")
    if len(resp.content) < 1000:
        raise RuntimeError(f"Pollinations returned too few bytes: {len(resp.content)}")
