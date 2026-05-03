from __future__ import annotations

import asyncio
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path


@dataclass
class HistoryEntry:
    title: str
    medium_url: str | None
    mode: str
    published_at: str
    tags: list[str]
    tokens_used: int = 0
    slug: str = ""


class History:
    def __init__(self, data_dir: Path) -> None:
        self._file = data_dir / "history.json"
        self._lock = asyncio.Lock()

    async def load(self) -> list[HistoryEntry]:
        async with self._lock:
            return self._read()

    async def add(self, entry: HistoryEntry) -> None:
        async with self._lock:
            entries = self._read()
            entries.append(entry)
            self._write(entries)

    async def get_all_titles(self) -> list[str]:
        entries = await self.load()
        return [e.title for e in entries]

    async def get_used_slugs(self) -> set[str]:
        entries = await self.load()
        return {e.slug for e in entries if e.slug}

    async def get_recent(self, n: int = 10) -> list[HistoryEntry]:
        entries = await self.load()
        return entries[-n:]

    def _read(self) -> list[HistoryEntry]:
        if not self._file.exists():
            return []
        try:
            raw = json.loads(self._file.read_text())
            return [HistoryEntry(**e) for e in raw]
        except (json.JSONDecodeError, KeyError):
            backup = self._file.with_suffix(".json.bak")
            self._file.rename(backup)
            return []

    def _write(self, entries: list[HistoryEntry]) -> None:
        self._file.write_text(json.dumps([asdict(e) for e in entries], indent=2))

    @staticmethod
    def make_entry(
        title: str,
        medium_url: str | None,
        mode: str,
        tags: list[str],
        tokens_used: int = 0,
        slug: str = "",
    ) -> HistoryEntry:
        return HistoryEntry(
            title=title,
            medium_url=medium_url,
            mode=mode,
            published_at=datetime.now(timezone.utc).isoformat(),
            tags=tags,
            tokens_used=tokens_used,
            slug=slug,
        )
