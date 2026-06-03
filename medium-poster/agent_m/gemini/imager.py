from __future__ import annotations

import logging
import math
import random
import struct
from urllib.parse import quote
import zlib

import httpx

from agent_m.gemini.client import generate_image, generate_image_native
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
        f"Style: {style}, Bitcoin orange (#F7931A) accents, "
        f"Bitcoin coin symbol, recurring purchase rhythm, calm automated investing, "
        f"dollar-cost averaging visual metaphor. Purely visual, NO text, NO letters, "
        f"NO words, NO numbers, NO typography, NO watermarks, NO company logos. "
        f"Wide editorial banner, high quality, 1200x630."
    )
    try:
        return await _generate_with_pollinations(prompt, seed=seed)
    except Exception as exc:
        if "pollinations queue is full" not in str(exc).lower():
            raise
        log.warning("Pollinations queue full; falling back to Gemini image generation")
        return await _generate_with_gemini(prompt)


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
                "text, letters, words, numbers, typography, writing, caption, "
                "title, label, watermark, logo, signature, stamp, badge, "
                "handwriting, calligraphy, font, alphabet, characters"
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
            if "queue full" in str(exc).lower():
                raise RuntimeError(
                    "Pollinations queue is full for this IP; retry later with a wider interval."
                ) from exc

    raise RuntimeError(f"All Pollinations models failed. Last: {last_error}")


async def _generate_with_gemini(prompt: str) -> tuple[bytes, str]:
    last_error: Exception | None = None
    try:
        image = await generate_image_native(prompt)
        return image, "Gemini native image fallback"
    except Exception as exc:
        last_error = exc
        log.warning("Gemini native image fallback failed: %s", str(exc)[:300])

    try:
        image = await generate_image(prompt)
        return image, "Imagen 3 fallback"
    except Exception as exc:
        last_error = exc
        log.warning("Imagen fallback failed: %s", str(exc)[:300])

    log.warning("External image generators failed; using local geometric fallback")
    return _generate_local_dca_banner(), f"Local geometric DCA fallback (external generators failed: {last_error})"


def _generate_local_dca_banner() -> bytes:
    width, height = 1200, 630
    pixels = bytearray(width * height * 3)

    def set_px(x: int, y: int, color: tuple[int, int, int], alpha: float = 1.0) -> None:
        if x < 0 or x >= width or y < 0 or y >= height:
            return
        idx = (y * width + x) * 3
        inv = 1.0 - alpha
        pixels[idx] = int(pixels[idx] * inv + color[0] * alpha)
        pixels[idx + 1] = int(pixels[idx + 1] * inv + color[1] * alpha)
        pixels[idx + 2] = int(pixels[idx + 2] * inv + color[2] * alpha)

    def rect(x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int], alpha: float = 1.0) -> None:
        for yy in range(max(0, y0), min(height, y1)):
            for xx in range(max(0, x0), min(width, x1)):
                set_px(xx, yy, color, alpha)

    def circle(cx: int, cy: int, radius: int, color: tuple[int, int, int], alpha: float = 1.0) -> None:
        r2 = radius * radius
        for yy in range(max(0, cy - radius), min(height, cy + radius + 1)):
            dy = yy - cy
            for xx in range(max(0, cx - radius), min(width, cx + radius + 1)):
                dx = xx - cx
                d2 = dx * dx + dy * dy
                if d2 <= r2:
                    edge = min(1.0, (radius - math.sqrt(d2)) / 8.0)
                    set_px(xx, yy, color, alpha * max(0.15, edge))

    def line(points: list[tuple[int, int]], color: tuple[int, int, int], thickness: int = 4) -> None:
        for (x0, y0), (x1, y1) in zip(points, points[1:]):
            steps = max(abs(x1 - x0), abs(y1 - y0), 1)
            for i in range(steps + 1):
                t = i / steps
                x = int(x0 + (x1 - x0) * t)
                y = int(y0 + (y1 - y0) * t)
                circle(x, y, thickness, color, 0.9)

    for y in range(height):
        for x in range(width):
            t = x / (width - 1)
            u = y / (height - 1)
            r = int(18 + 24 * t + 10 * u)
            g = int(30 + 42 * (1 - t) + 12 * u)
            b = int(46 + 36 * (1 - u))
            idx = (y * width + x) * 3
            pixels[idx:idx + 3] = bytes((r, g, b))

    circle(995, 150, 210, (247, 147, 26), 0.22)
    circle(220, 500, 260, (54, 114, 180), 0.20)
    circle(595, 315, 145, (255, 255, 255), 0.05)

    for i, h in enumerate([95, 135, 120, 170, 145, 210, 185, 245, 225, 285, 255, 320]):
        x = 125 + i * 58
        rect(x, 520 - h, x + 24, 520, (247, 147, 26), 0.88)
        rect(x + 28, 520 - int(h * 0.72), x + 42, 520, (102, 180, 255), 0.58)

    points = []
    for i in range(18):
        x = 110 + i * 55
        y = int(425 - i * 9 + math.sin(i * 0.9) * 28)
        points.append((x, y))
    line(points, (255, 255, 255), 3)
    line([(x, y + 18) for x, y in points], (247, 147, 26), 2)

    circle(885, 320, 116, (247, 147, 26), 0.96)
    circle(885, 320, 92, (28, 35, 48), 0.84)
    circle(885, 320, 70, (247, 147, 26), 0.90)
    rect(872, 245, 884, 395, (28, 35, 48), 0.95)
    rect(898, 245, 910, 395, (28, 35, 48), 0.95)
    circle(890, 292, 38, (28, 35, 48), 0.95)
    circle(900, 348, 42, (28, 35, 48), 0.95)
    rect(850, 258, 890, 382, (247, 147, 26), 0.95)
    rect(835, 286, 905, 306, (247, 147, 26), 0.95)
    rect(835, 340, 914, 362, (247, 147, 26), 0.95)

    for x in range(80, 1120, 80):
        rect(x, 548, x + 38, 553, (255, 255, 255), 0.14)
    for i in range(9):
        line([(780 + i * 28, 455), (920 + i * 18, 530)], (255, 255, 255), 1)

    raw = bytearray()
    for y in range(height):
        raw.append(0)
        start = y * width * 3
        raw.extend(pixels[start:start + width * 3])

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), level=6))
        + chunk(b"IEND", b"")
    )
