from __future__ import annotations

import logging

import httpx

from agent_m.config import config

log = logging.getLogger(__name__)


class DevToPublisher:
    API_BASE = "https://dev.to/api"

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(
            headers={
                "api-key": config.devto_api_key,
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    async def publish(
        self,
        title: str,
        body_markdown: str,
        tags: list[str],
        published: bool = True,
        canonical_url: str | None = None,
    ) -> dict:
        tags_clean = [t.lower().replace(" ", "").replace("-", "")[:20] for t in tags[:4]]

        payload: dict = {
            "article": {
                "title": title,
                "body_markdown": body_markdown,
                "published": published,
                "tags": tags_clean,
            }
        }
        if canonical_url:
            payload["article"]["canonical_url"] = canonical_url

        resp = await self._client.post(f"{self.API_BASE}/articles", json=payload)
        if resp.status_code not in (200, 201):
            log.error("Dev.to API error %d: %s", resp.status_code, resp.text[:500])
            resp.raise_for_status()

        data = resp.json()
        log.info("Published to Dev.to: %s", data.get("url"))
        return data

    async def close(self) -> None:
        await self._client.aclose()
