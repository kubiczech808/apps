from __future__ import annotations

import json
import re
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path

from agent_m.config import config
from agent_m.content_plan import ContentPlan


_STATE_FILE = config.data_dir / "topic_suggestions.json"


def create_suggestion(text: str) -> dict:
    request = " ".join(text.split()).strip()
    if not request:
        raise ValueError("Topic suggestion is empty")

    suggestion_id = uuid.uuid4().hex[:12]
    topic = _strip_request_prefix(request) or request
    slug_base = _slugify(topic)[:55] or "bitcoin-dca-topic"
    suggestion = {
        "id": suggestion_id,
        "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "request": request,
        "topic": topic,
        "slug": f"suggested-{slug_base}-{suggestion_id[:6]}",
        "title_hint": f"An English Bitcoin DCA article about: {topic}",
        "angle": topic,
        "seo_keyword": "bitcoin dca",
        "tags": ["Bitcoin", "DCA", "Investing"],
        "key_points": [topic],
    }
    state = _read_state()
    state.setdefault("suggestions", {})[suggestion_id] = suggestion
    _write_state(state)
    return suggestion


def confirm_suggestion(suggestion_id: str) -> dict | None:
    state = _read_state()
    suggestion = state.setdefault("suggestions", {}).get(suggestion_id)
    if not isinstance(suggestion, dict):
        return None
    if suggestion.get("status") == "pending":
        suggestion["status"] = "confirmed"
        suggestion["confirmed_at"] = datetime.now(timezone.utc).isoformat()
        _write_state(state)
    return suggestion


def reject_suggestion(suggestion_id: str) -> dict | None:
    state = _read_state()
    suggestion = state.setdefault("suggestions", {}).get(suggestion_id)
    if not isinstance(suggestion, dict):
        return None
    if suggestion.get("status") == "pending":
        suggestion["status"] = "rejected"
        suggestion["rejected_at"] = datetime.now(timezone.utc).isoformat()
        _write_state(state)
    return suggestion


def get_next_confirmed(used_slugs: set[str]) -> dict | None:
    suggestions = _read_state().get("suggestions", {}).values()
    confirmed = [
        item for item in suggestions
        if isinstance(item, dict)
        and item.get("status") == "confirmed"
        and item.get("slug") not in used_slugs
    ]
    return min(confirmed, key=lambda item: item.get("confirmed_at") or item.get("created_at") or "") if confirmed else None


def get_confirmed_by_slug(slug: str) -> dict | None:
    for item in _read_state().get("suggestions", {}).values():
        if isinstance(item, dict) and item.get("status") == "confirmed" and item.get("slug") == slug:
            return item
    return None


def get_confirmed() -> list[dict]:
    items = [
        item for item in _read_state().get("suggestions", {}).values()
        if isinstance(item, dict) and item.get("status") == "confirmed"
    ]
    return sorted(items, key=lambda item: item.get("confirmed_at") or item.get("created_at") or "")


def to_content_plan(suggestion: dict) -> ContentPlan:
    return ContentPlan(
        slug=suggestion["slug"],
        title_hint=suggestion["title_hint"],
        pillar="suggested",
        funnel_stage="awareness",
        seo_keyword=suggestion.get("seo_keyword") or "bitcoin dca",
        tags=suggestion.get("tags") or ["Bitcoin", "DCA", "Investing"],
        angle=suggestion.get("angle") or suggestion.get("topic") or suggestion["request"],
        key_points=suggestion.get("key_points") or [suggestion.get("topic") or suggestion["request"]],
        cta_target="A natural btc-dca.com tool or calculator link when relevant",
    )


def format_confirmation(suggestion: dict) -> str:
    return (
        "Navrh noveho tematu\n\n"
        f"Podnet: {suggestion['request']}\n"
        f"Tema: {suggestion['topic']}\n\n"
        "Co agent udela:\n"
        "- zaradi tema pred standardni content plan\n"
        "- pripravi clanek v anglictine pro Medium a Dev.to\n"
        "- zachova SEO, obrazek a prirozene odkazy na btc-dca.com\n"
        "- konkretni titulek a klicova slova doladi pri generovani\n\n"
        "Pridat toto tema do fronty?"
    )[:4096]


def _strip_request_prefix(text: str) -> str:
    return re.sub(
        r"^(?:prosim[,.]?\s*)?(?:navrhuji\s+)?(?:napis|napiš|priprav|připrav|udelej|udělej|write)?\s*"
        r"(?:novy|nový|dalsi|další|an?|the)?\s*(?:clanek|článek|article|tema|téma|topic)?\s*(?:o|na|about|:|-)?\s*",
        "",
        text,
        flags=re.IGNORECASE,
    ).strip(" .:-")


def _slugify(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text)
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text).strip("-")


def _read_state() -> dict:
    if not _STATE_FILE.exists():
        return {"suggestions": {}}
    try:
        data = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"suggestions": {}}
    return data if isinstance(data, dict) else {"suggestions": {}}


def _write_state(state: dict) -> None:
    _STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = _STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(_STATE_FILE)
