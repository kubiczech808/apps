from __future__ import annotations

import httpx

from agent_m.config import config


class MediumPublishError(Exception):
    def __init__(self, status_code: int, body: str) -> None:
        self.status_code = status_code
        self.body = body
        super().__init__(f"Medium API error {status_code}: {body}")


class MediumClient:
    BASE_URL = "https://api.medium.com/v1"

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(
            headers={
                "Authorization": f"Bearer {config.medium_token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            timeout=30.0,
        )
        self._author_id: str | None = None

    async def get_author_id(self) -> str:
        if self._author_id:
            return self._author_id
        resp = await self._client.get(f"{self.BASE_URL}/me")
        if resp.status_code != 200:
            raise MediumPublishError(resp.status_code, resp.text)
        self._author_id = resp.json()["data"]["id"]
        return self._author_id

    async def create_post(
        self,
        title: str,
        content_markdown: str,
        tags: list[str],
        publish_status: str = "public",
        canonical_url: str | None = None,
    ) -> dict:
        author_id = await self.get_author_id()
        payload: dict = {
            "title": title[:100],
            "contentFormat": "markdown",
            "content": content_markdown,
            "tags": tags[:3],
            "publishStatus": publish_status,
        }
        if canonical_url:
            payload["canonicalUrl"] = canonical_url
        resp = await self._client.post(
            f"{self.BASE_URL}/users/{author_id}/posts",
            json=payload,
        )
        if resp.status_code not in (200, 201):
            raise MediumPublishError(resp.status_code, resp.text)
        return resp.json()

    async def close(self) -> None:
        await self._client.aclose()
