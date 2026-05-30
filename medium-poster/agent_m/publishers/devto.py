from __future__ import annotations

import logging
import re

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
        main_image: str | None = None,
    ) -> dict:
        tags_clean = normalize_tags(tags)

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
        if main_image:
            payload["article"]["main_image"] = main_image
            log.info("Dev.to: setting main_image=%s", main_image)

        resp = await self._client.post(f"{self.API_BASE}/articles", json=payload)
        if resp.status_code not in (200, 201):
            body = resp.text[:500]
            log.error("Dev.to API error %d: %s", resp.status_code, body)
            if (
                resp.status_code == 422
                and canonical_url
                and "Canonical url has already been taken" in body
            ):
                existing = await self.find_by_canonical_url(canonical_url)
                if existing:
                    log.info("Dev.to article already exists: %s", existing.get("url"))
                    return existing
                raise RuntimeError(
                    f"Dev.to canonical URL is already taken, but existing article was not found: {body}"
                )
            raise RuntimeError(f"Dev.to HTTP {resp.status_code}: {body}")

        data = resp.json()
        log.info("Published to Dev.to: %s", data.get("url"))
        return data

    async def list_my_articles(self) -> list[dict]:
        articles = []
        page = 1
        while True:
            resp = await self._client.get(
                f"{self.API_BASE}/articles/me/published",
                params={"page": page, "per_page": 30},
            )
            if resp.status_code != 200:
                break
            batch = resp.json()
            if not batch:
                break
            articles.extend(batch)
            page += 1
        return articles

    async def get_article(self, article_id: int) -> dict:
        resp = await self._client.get(f"{self.API_BASE}/articles/{article_id}")
        if resp.status_code != 200:
            raise RuntimeError(f"Dev.to GET article {article_id} failed: {resp.status_code}")
        return resp.json()

    async def update_article(self, article_id: int, body_markdown: str) -> dict:
        payload = {"article": {"body_markdown": body_markdown}}
        resp = await self._client.put(f"{self.API_BASE}/articles/{article_id}", json=payload)
        if resp.status_code != 200:
            raise RuntimeError(f"Dev.to PUT {article_id} failed {resp.status_code}: {resp.text[:300]}")
        log.info("Updated Dev.to article %d", article_id)
        return resp.json()

    async def close(self) -> None:
        await self._client.aclose()

    async def find_by_canonical_url(self, canonical_url: str) -> dict | None:
        resp = await self._client.get(
            f"{self.API_BASE}/articles/me/all",
            params={"page": 1, "per_page": 1000},
        )
        if resp.status_code != 200:
            log.warning("Dev.to existing article lookup failed %d: %s", resp.status_code, resp.text[:300])
            return None
        for article in resp.json():
            if article.get("canonical_url") == canonical_url:
                return article
        return None


def normalize_tags(tags: list[str]) -> list[str]:
    result: list[str] = []
    for tag in tags:
        cleaned = re.sub(r"[^a-z0-9]", "", tag.lower())[:20]
        if cleaned and cleaned not in result:
            result.append(cleaned)
    for fallback in ("bitcoin", "crypto", "investing", "beginners"):
        if len(result) >= 4:
            break
        if fallback not in result:
            result.append(fallback)
    return result[:4]
