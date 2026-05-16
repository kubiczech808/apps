from __future__ import annotations

import base64
import logging
import re

import httpx

from agent_m.config import config

log = logging.getLogger(__name__)


class GitHubPagesPublisher:
    API_BASE = "https://api.github.com"

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(
            headers={
                "Authorization": f"Bearer {config.github_pat}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=30.0,
        )
        owner, repo = config.github_pages_repo.split("/")
        self._owner = owner
        self._repo = repo
        self._branch = config.github_pages_branch

    async def publish_file(self, path: str, content: str, message: str) -> str:
        url = f"{self.API_BASE}/repos/{self._owner}/{self._repo}/contents/{path}"

        sha = await self._get_file_sha(url)

        payload = {
            "message": message,
            "content": base64.b64encode(content.encode()).decode(),
            "branch": self._branch,
        }
        if sha:
            payload["sha"] = sha

        resp = await self._client.put(url, json=payload)
        if resp.status_code not in (200, 201):
            log.error("GitHub API error %d: %s", resp.status_code, resp.text[:500])
            resp.raise_for_status()

        data = resp.json()
        html_url = data.get("content", {}).get("html_url", "")
        log.info("Published to GitHub: %s", html_url)
        return html_url

    async def publish_binary_file(self, path: str, data: bytes, message: str) -> str:
        url = f"{self.API_BASE}/repos/{self._owner}/{self._repo}/contents/{path}"
        sha = await self._get_file_sha(url)
        payload = {
            "message": message,
            "content": base64.b64encode(data).decode(),
            "branch": self._branch,
        }
        if sha:
            payload["sha"] = sha
        resp = await self._client.put(url, json=payload)
        if resp.status_code not in (200, 201):
            log.error("GitHub binary upload error %d: %s", resp.status_code, resp.text[:500])
            resp.raise_for_status()
        pages_url = f"https://{self._owner}.github.io/{self._repo}/{path}"
        log.info("Uploaded binary to GitHub Pages: %s", pages_url)
        return pages_url

    async def publish_article_and_feed(
        self,
        slug: str,
        article_html: str,
        feed_xml: str,
    ) -> str:
        await self.publish_file(
            path=f"articles/{slug}.html",
            content=article_html,
            message=f"Add article: {slug}",
        )

        await self.publish_file(
            path="feed.xml",
            content=feed_xml,
            message=f"Update RSS feed ({slug})",
        )

        pages_url = f"https://{self._owner}.github.io/{self._repo}/articles/{slug}.html"
        return pages_url

    async def list_article_slugs(self) -> set[str]:
        url = f"{self.API_BASE}/repos/{self._owner}/{self._repo}/contents/articles"
        resp = await self._client.get(url, params={"ref": self._branch})
        if resp.status_code == 404:
            return set()
        if resp.status_code != 200:
            log.warning("GitHub articles list failed %d: %s", resp.status_code, resp.text[:300])
            return set()
        data = resp.json()
        if not isinstance(data, list):
            return set()
        slugs: set[str] = set()
        for item in data:
            name = str(item.get("name", ""))
            match = re.fullmatch(r"(.+)\.html", name)
            if match:
                slugs.add(match.group(1))
        return slugs

    async def _get_file_sha(self, url: str) -> str | None:
        resp = await self._client.get(url, params={"ref": self._branch})
        if resp.status_code == 200:
            return resp.json().get("sha")
        return None

    async def close(self) -> None:
        await self._client.aclose()
