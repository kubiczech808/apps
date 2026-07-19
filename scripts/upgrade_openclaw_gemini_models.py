#!/usr/bin/env python3
"""Prefer Gemini 3.5 Flash across OpenClaw agent runtime configs.

The script is intentionally conservative:
- it makes gemini-3.5-flash the first text model/default;
- it preserves older Gemini models as fallbacks;
- it does not change Gemini image-generation model lists, because
  gemini-3.5-flash is a text-output model, not an image model.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import shutil
import subprocess
from pathlib import Path


TARGET = "gemini-3.5-flash"
VERSION = "2026-07-19-prefer-gemini-3.5-flash"

SCRIPT_FILES = [
    Path("/home/openclaw2/scripts/agent_n_post.py"),
    Path("/home/openclaw2/scripts/agent_oz_approve.py"),
    Path("/home/openclaw2/scripts/g_agent.py"),
    Path("/home/openclaw2/scripts/btc-dca-blogger.py"),
    Path("/home/openclaw2/scripts/reddit-commenter.py"),
    Path("/home/openclaw2/scripts/youtube_analysis_ingest.py"),
    Path("/home/openclaw2/scripts/agent_n_approve.py"),
    Path("/home/openclaw2/scripts/agent_r_engage.py"),
    Path("/home/openclaw2/scripts/breaking-news-monitor.py"),
    Path("/home/openclaw2/scripts/agent_w_post.py"),
    Path("/home/openclaw2/scripts/x_approve.py"),
    Path("/home/openclaw2/scripts/agent_oz_post.py"),
    Path("/home/openclaw2/scripts/agent_virtual_assistant.py"),
    Path("/home/openclaw2/.openclaw/x_post.py"),
    Path("/home/openclaw2/.openclaw/x_approve.py"),
]

CONFIG_FILES = [
    Path("/home/openclaw2/.openclaw/btc-dca-blogger-config.json"),
    Path("/home/openclaw2/.openclaw/osobnizkusenosti-cz-blogger-config.json"),
    Path("/home/openclaw2/.openclaw/tajemstvijamu-cz-blogger-config.json"),
]

ENV_FILES = [
    Path("/home/openclaw2/.openclaw/.env.local"),
]

def log(message: str) -> None:
    print(f"[gemini-upgrade] {message}")


def backup(path: Path) -> None:
    stamp = dt.datetime.now().strftime("%Y%m%d%H%M%S")
    dest = path.with_name(path.name + f".bak-gemini35-{stamp}")
    shutil.copy2(path, dest)
    log(f"backup: {path} -> {dest}")


def write_if_changed(path: Path, original: str, updated: str) -> bool:
    if updated == original:
        log(f"already current: {path}")
        return False
    backup(path)
    path.write_text(updated, encoding="utf-8")
    log(f"written: {path}")
    return True


def ensure_bracket_model_first(text: str) -> str:
    """Move/insert TARGET first in simple list assignments containing Gemini text models."""

    variable_pattern = r"(?:GEMINI_MODELS|MODELS|_MODELS|models)"

    def update_list(match: re.Match[str]) -> str:
        prefix = match.group("prefix")
        body = match.group("body")
        suffix = match.group("suffix")
        if "gemini-" not in body:
            return match.group(0)
        if "flash-image" in body or "image-preview" in body:
            return match.group(0)
        stripped = body.lstrip()
        if stripped.startswith(f'"{TARGET}"') or stripped.startswith(f"'{TARGET}'"):
            return match.group(0)
        if re.match(rf"\(\s*[\"']{re.escape(TARGET)}[\"']", stripped):
            return match.group(0)

        cleaned = re.sub(
            rf"\s*[\"']{re.escape(TARGET)}[\"']\s*,?",
            "",
            body,
        )
        cleaned = re.sub(
            rf"\s*\([\"']{re.escape(TARGET)}[\"']\s*,\s*[\"']v1beta[\"']\)\s*,?",
            "",
            cleaned,
        )

        if re.search(r"\([\"']gemini-", body):
            insert = f'\n    ("{TARGET}", "v1beta"),'
            return prefix + insert + cleaned + suffix
        return prefix + f'"{TARGET}", ' + cleaned.lstrip() + suffix

    text = re.sub(
        rf"(?P<prefix>\b{variable_pattern}\s*=\s*\[)(?P<body>.*?)(?P<suffix>\])",
        update_list,
        text,
        flags=re.S,
    )

    def update_tuple(match: re.Match[str]) -> str:
        prefix = match.group("prefix")
        body = match.group("body")
        suffix = match.group("suffix")
        if "gemini-" not in body or TARGET in body:
            return match.group(0)
        if "flash-image" in body or "image-preview" in body:
            return match.group(0)
        return prefix + f'"{TARGET}", ' + body.lstrip() + suffix

    text = re.sub(
        rf"(?P<prefix>\b{variable_pattern}\s*=\s*\()(?P<body>.*?)(?P<suffix>\))",
        update_tuple,
        text,
        flags=re.S,
    )
    return text


def patch_script_text(text: str) -> str:
    text = ensure_bracket_model_first(text)

    replacements = {
        'DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"': f'DEFAULT_GEMINI_MODEL = "{TARGET}"',
        'DEFAULT_GEMINI_MODEL = "gemini-2.0-flash"': f'DEFAULT_GEMINI_MODEL = "{TARGET}"',
        'cfg.get("gemini_model", "gemini-2.0-flash")': f'cfg.get("gemini_model", "{TARGET}")',
        'cfg.get("gemini_model", "gemini-2.5-flash")': f'cfg.get("gemini_model", "{TARGET}")',
        'or "gemini-2.0-flash").strip()': f'or "{TARGET}").strip()',
        'models/gemini-2.5-flash:generateContent': f"models/{TARGET}:generateContent",
        'models/gemini-2.0-flash:generateContent': f"models/{TARGET}:generateContent",
        'models/gemini-2.0-flash-lite:generateContent': f"models/{TARGET}:generateContent",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)

    # Virtual Assistant default fallback list already contained TARGET; make it first.
    text = text.replace(
        '''models = [
            "gemini-flash-latest",
            "gemini-3.5-flash",''',
        '''models = [
            "gemini-3.5-flash",
            "gemini-flash-latest",''',
    )
    return text


def patch_script(path: Path) -> bool:
    if not path.exists():
        log(f"missing: {path}")
        return False
    original = path.read_text(encoding="utf-8", errors="replace")
    updated = patch_script_text(original)
    return write_if_changed(path, original, updated)


def patch_config(path: Path) -> bool:
    if not path.exists():
        log(f"missing: {path}")
        return False
    original = path.read_text(encoding="utf-8", errors="replace")
    try:
        data = json.loads(original)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Cannot parse {path}: {exc}") from exc

    changed = False
    for key in ("gemini_model", "gemini_vision_model"):
        value = data.get(key)
        if isinstance(value, str) and value.startswith("gemini-") and "image" not in value and value != TARGET:
            data[key] = TARGET
            changed = True
    if not changed:
        log(f"already current: {path}")
        return False

    updated = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    return write_if_changed(path, original, updated)


def reorder_csv_models(value: str) -> str:
    parts = [part.strip() for part in value.split(",") if part.strip()]
    if not parts:
        return value
    text_models = [part for part in parts if "image" not in part]
    if not text_models:
        return value
    reordered = [TARGET]
    reordered.extend(part for part in parts if part != TARGET)
    return ",".join(reordered)


def patch_env(path: Path) -> bool:
    if not path.exists():
        log(f"missing: {path}")
        return False
    original = path.read_text(encoding="utf-8", errors="replace")
    lines = []
    changed = False
    for line in original.splitlines():
        if line.startswith("GEMINI_VA_MODELS="):
            key, value = line.split("=", 1)
            new_value = reorder_csv_models(value)
            new_line = f"{key}={new_value}"
            if new_line != line:
                line = new_line
                changed = True
        lines.append(line)
    if not changed:
        log(f"already current: {path}")
        return False
    updated = "\n".join(lines) + ("\n" if original.endswith("\n") else "")
    return write_if_changed(path, original, updated)


def compile_scripts(paths: list[Path]) -> None:
    for path in paths:
        if path.exists() and path.suffix == ".py":
            subprocess.run(["python3", "-m", "py_compile", str(path)], check=True)
            log(f"compiled: {path}")


def main() -> int:
    log(f"target text model: {TARGET}")
    log(f"policy version: {VERSION}")
    changed: list[str] = []

    for path in SCRIPT_FILES:
        if patch_script(path):
            changed.append(str(path))
    for path in CONFIG_FILES:
        if patch_config(path):
            changed.append(str(path))
    for path in ENV_FILES:
        if patch_env(path):
            changed.append(str(path))

    compile_scripts(SCRIPT_FILES)
    log("changed files: " + (", ".join(changed) if changed else "none"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
