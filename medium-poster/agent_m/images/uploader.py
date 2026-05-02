from __future__ import annotations

import base64

import httpx

from agent_m.config import config


async def upload_to_imgur(image_bytes: bytes) -> str:
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            "https://api.imgur.com/3/image",
            headers={"Authorization": f"Client-ID {config.imgur_client_id}"},
            json={
                "image": base64.b64encode(image_bytes).decode(),
                "type": "base64",
            },
        )
        response.raise_for_status()
        data = response.json()
        return data["data"]["link"]
