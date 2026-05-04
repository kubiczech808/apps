from __future__ import annotations

import logging

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
        self._client = httpx.AsyncClient(
            headers={
                "Authorization": config.hashnode_token,
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
    ) -> dict:
        tag_objects = [{"slug": t.lower().replace(" ", "-"), "name": t} for t in tags[:5]]

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

        resp = await self._client.post(
            self.API_URL,
            json={"query": _PUBLISH_MUTATION, "variables": variables},
        )
        if resp.status_code != 200:
            log.error("Hashnode API error %d: %s", resp.status_code, resp.text[:500])
            resp.raise_for_status()

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
