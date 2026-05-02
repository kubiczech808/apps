from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path


class TokenTracker:
    def __init__(self, data_dir: Path) -> None:
        self._file = data_dir / "token_usage.json"
        self._lock = asyncio.Lock()

    async def track(self, prompt_tokens: int, completion_tokens: int) -> None:
        async with self._lock:
            data = self._read()
            now = datetime.now(timezone.utc)
            day_key = now.strftime("%Y-%m-%d")
            month_key = now.strftime("%Y-%m")
            total = prompt_tokens + completion_tokens

            for period_key, period_name in [(day_key, "daily"), (month_key, "monthly")]:
                bucket = data.setdefault(period_name, {}).setdefault(period_key, {
                    "prompt": 0, "completion": 0, "total": 0, "calls": 0,
                })
                bucket["prompt"] += prompt_tokens
                bucket["completion"] += completion_tokens
                bucket["total"] += total
                bucket["calls"] += 1

            self._write(data)

    async def get_today(self) -> dict:
        data = self._read()
        day_key = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        return data.get("daily", {}).get(day_key, {
            "prompt": 0, "completion": 0, "total": 0, "calls": 0,
        })

    async def get_this_month(self) -> dict:
        data = self._read()
        month_key = datetime.now(timezone.utc).strftime("%Y-%m")
        return data.get("monthly", {}).get(month_key, {
            "prompt": 0, "completion": 0, "total": 0, "calls": 0,
        })

    def _read(self) -> dict:
        if not self._file.exists():
            return {}
        try:
            return json.loads(self._file.read_text())
        except json.JSONDecodeError:
            return {}

    def _write(self, data: dict) -> None:
        self._file.write_text(json.dumps(data, indent=2))
