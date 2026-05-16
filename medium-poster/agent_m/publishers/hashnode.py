from __future__ import annotations

import logging
import asyncio
import re

import httpx

from agent_m.config import config

log = logging.getLogger(__name__)

_PUBLISH_MUTATION = """
mutation PublishPost($input: PublishPostInput!) {
  publishPost(input: $input) {
    post {
      id
      title
      url
      slug
    }
  }
}
"""


class HashnodePublisher:
    API_URL = "https://gql.hashnode.com"

    def __init__(self) -> None:
        token = config.hashnode_token
        auth_value = f"Bearer {token}" if not token.lower().startswith("bearer") else token
        self._client = httpx.AsyncClient(
            headers={
                "Authorization": auth_value,
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    async def publish(
        self,
        title: str,
        body_markdown: str,
        tags: list[str],
        canonical_url: str | None = None,
        cover_image_url: str | None = None,
    ) -> dict:
        tag_objects = [{"slug": normalize_tag_slug(t), "name": t[:32]} for t in tags[:5]]

        variables: dict = {
            "input": {
                "publicationId": config.hashnode_publication_id,
                "title": title,
                "contentMarkdown": body_markdown,
                "tags": tag_objects,
            }
        }
        if canonical_url:
            variables["input"]["originalArticleURL"] = canonical_url
        if cover_image_url:
            variables["input"]["coverImageOptions"] = {"coverImageURL": cover_image_url}

        resp = await self._post_with_retry({"query": _PUBLISH_MUTATION, "variables": variables})
        if resp.status_code != 200:
            body = resp.text[:500]
            log.error("Hashnode API error %d: %s", resp.status_code, body)
            raise RuntimeError(f"Hashnode HTTP {resp.status_code}: {body}")

        data = resp.json()
        if "errors" in data:
            error_msg = data["errors"][0].get("message", "Unknown error")
            log.error("Hashnode GraphQL error: %s", error_msg)
            raise RuntimeError(f"Hashnode: {error_msg}")

        post = data["data"]["publishPost"]["post"]
        log.info("Published to Hashnode: %s", post.get("url"))
        return post

    async def close(self) -> None:
        await self._client.aclose()

    async def _post_with_retry(self, payload: dict) -> httpx.Response:
        last_exc: Exception | None = None
        for attempt in range(3):
            try:
                url = self.API_URL
                resp = await self._client.post(url, json=payload)
                if resp.status_code in (301, 302, 307, 308):
                    location = resp.headers.get("location")
                    if location:
                        log.info("Hashnode redirect %d → %s", resp.status_code, location)
                        resp = await self._client.post(location, json=payload)
                if resp.status_code not in (429, 500, 502, 503, 504):
                    return resp
                last_exc = RuntimeError(f"Hashnode HTTP {resp.status_code}: {resp.text[:200]}")
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout) as exc:
                last_exc = exc
            await asyncio.sleep(2 * (attempt + 1))
        assert last_exc is not None
        raise last_exc


def normalize_tag_slug(tag: str) -> str:
    slug = re.sub(r"[^a-z0-9-]", "-", tag.lower().strip())
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or "bitcoin"
