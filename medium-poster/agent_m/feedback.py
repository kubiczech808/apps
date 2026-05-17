"""Persistent feedback storage for writer instructions."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from agent_m.config import config

log = logging.getLogger(__name__)

_FEEDBACK_FILE = config.data_dir / "feedback.json"


def _load() -> list[dict]:
    if _FEEDBACK_FILE.exists():
        try:
            return json.loads(_FEEDBACK_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return []
    return []


def _save(entries: list[dict]) -> None:
    _FEEDBACK_FILE.write_text(json.dumps(entries, indent=2, ensure_ascii=False))


def add_feedback(text: str) -> int:
    entries = _load()
    entries.append({
        "text": text,
        "added": datetime.now(timezone.utc).isoformat(),
    })
    _save(entries)
    return len(entries)


def get_all_feedback() -> list[str]:
    return [e["text"] for e in _load()]


def get_feedback_for_prompt() -> str:
    items = get_all_feedback()
    if not items:
        return ""
    lines = ["=== USER FEEDBACK / STANDING INSTRUCTIONS ==="]
    for i, item in enumerate(items, 1):
        lines.append(f"{i}. {item}")
    return "\n".join(lines)


def clear_feedback() -> None:
    _save([])
