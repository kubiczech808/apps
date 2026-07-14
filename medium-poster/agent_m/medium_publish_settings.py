from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from agent_m.config import config

_SETTINGS_FILE = config.data_dir / "medium_publish_settings.json"


def is_medium_publish_enabled() -> bool:
    data = _read_settings(_SETTINGS_FILE)
    return bool(data.get("enabled", True))


def set_medium_publish_enabled(enabled: bool) -> dict:
    data = _read_settings(_SETTINGS_FILE)
    data["enabled"] = bool(enabled)
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    _write_settings(_SETTINGS_FILE, data)
    return {"status": "ok", "enabled": bool(enabled), "updated_at": data["updated_at"]}


def medium_publish_status() -> dict:
    data = _read_settings(_SETTINGS_FILE)
    return {
        "enabled": bool(data.get("enabled", True)),
        "updated_at": data.get("updated_at"),
    }


def _read_settings(path: Path) -> dict:
    if not path.exists():
        return {"enabled": True}
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        backup = path.with_suffix(".json.bak")
        path.rename(backup)
        return {"enabled": True}
    return data if isinstance(data, dict) else {"enabled": True}


def _write_settings(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False))
