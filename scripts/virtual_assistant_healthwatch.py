#!/usr/bin/env python3
"""Local healthwatch for the Virtual Assistant Telegram daemon.

The bridge owns the GitHub secret. This watchdog owns local continuity:
it detects a bad runtime token, restores the last verified local token when
available, restarts the daemon, and alerts through Agent G if it cannot heal.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import importlib.util
import json
import os
import pwd
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


OPENCLAW_DIR = Path("/home/openclaw2/.openclaw")
ENV_FILE = OPENCLAW_DIR / ".env.local"
VA_DIR = OPENCLAW_DIR / "virtual-assistant"
STATE_FILE = VA_DIR / "TELEGRAM_HEALTHWATCH.json"
LAST_GOOD_FILE = VA_DIR / "telegram-last-good.env"
LOG_FILE = OPENCLAW_DIR / "logs" / "virtual-assistant-healthwatch.log"
APP_LOG_FILE = OPENCLAW_DIR / "logs" / "virtual-assistant.log"
VA_SCRIPT = Path("/home/openclaw2/scripts/agent_virtual_assistant.py")
SERVICE_NAME = "virtual-assistant.service"
SILENCE_RESTART_SECONDS = int(os.environ.get("VIRTUAL_ASSISTANT_SILENCE_RESTART_SECONDS", "1800"))
LIVENESS_RESTART_MIN_INTERVAL_SECONDS = int(os.environ.get("VIRTUAL_ASSISTANT_LIVENESS_RESTART_MIN_INTERVAL_SECONDS", "900"))
SILENCE_ALERT_SECONDS = int(os.environ.get("VIRTUAL_ASSISTANT_SILENCE_ALERT_SECONDS", "7200"))

VA_TOKEN_KEYS = {
    "TELEGRAM_VIRTUAL_ASSISTANT_BOT_TOKEN",
    "VIRTUAL_ASSISTANT_TELEGRAM_TOKEN",
    "VA_TELEGRAM_TOKEN",
    "M_TELEGRAM_TOKEN",
    "AGENT_VA_TELEGRAM_TOKEN",
    "TELEGRAM_AGENT_VA_BOT_TOKEN",
    "ASSISTANT_TELEGRAM_TOKEN",
}
VA_CHAT_KEYS = {
    "TELEGRAM_VIRTUAL_ASSISTANT_CHAT_ID",
    "VIRTUAL_ASSISTANT_TELEGRAM_CHAT_ID",
    "VA_TELEGRAM_CHAT_ID",
    "M_TELEGRAM_CHAT_ID",
    "AGENT_VA_TELEGRAM_CHAT_ID",
    "TELEGRAM_AGENT_VA_CHAT_ID",
    "ASSISTANT_TELEGRAM_CHAT_ID",
}
AGENT_G_TOKEN_KEYS = (
    "TELEGRAM_AGENT_G_BOT_TOKEN",
    "G_TELEGRAM_BOT_TOKEN",
    "G_TELEGRAM_TOKEN",
    "AGENT_G_TELEGRAM_TOKEN",
)
AGENT_G_CHAT_KEYS = (
    "TELEGRAM_AGENT_G_CHAT_ID",
    "G_TELEGRAM_CHAT_ID",
    "AGENT_G_CHAT_ID",
)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def local_now() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def token_sha(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:12] if token else "empty"


def log(message: str) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    LOG_FILE.write_text("", encoding="utf-8") if not LOG_FILE.exists() else None
    with LOG_FILE.open("a", encoding="utf-8") as handle:
        handle.write(f"[{local_now()}] {message}\n")


def read_kv_file(path: Path) -> tuple[dict[str, str], list[str]]:
    env: dict[str, str] = {}
    lines: list[str] = []
    if not path.exists():
        return env, lines
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        lines.append(raw)
        if raw and not raw.startswith("#") and "=" in raw:
            key, value = raw.split("=", 1)
            env[key.strip()] = value
    return env, lines


def pick(env: dict[str, str], keys: tuple[str, ...] | set[str], default: str = "") -> str:
    for key in keys:
        value = env.get(key)
        if value:
            return value
    return default


def atomic_write(path: Path, text: str, mode: int, owner: str | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=str(path.parent), delete=False) as handle:
        handle.write(text)
        tmp_name = handle.name
    tmp = Path(tmp_name)
    os.chmod(tmp, mode)
    if owner:
        try:
            account = pwd.getpwnam(owner)
            os.chown(tmp, account.pw_uid, account.pw_gid)
        except Exception as exc:
            log(f"chown skipped for {path}: {type(exc).__name__}")
    os.replace(tmp, path)


def save_state(state: dict[str, Any]) -> None:
    state["updated_at"] = utc_now()
    atomic_write(STATE_FILE, json.dumps(state, ensure_ascii=False, indent=2) + "\n", 0o600, "openclaw2")


def load_state() -> dict[str, Any]:
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        data = {}
    return data if isinstance(data, dict) else {}


def telegram_call(token: str, method: str, data: dict[str, Any] | None = None, timeout: int = 12) -> dict[str, Any]:
    if not token:
        raise RuntimeError("missing-token")
    payload = None
    if data is not None:
        payload = urllib.parse.urlencode({
            key: json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
            for key, value in data.items()
        }).encode("utf-8")
    request = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=payload)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def token_status(token: str) -> dict[str, Any]:
    status: dict[str, Any] = {"ok": False, "sha12": token_sha(token)}
    try:
        data = telegram_call(token, "getMe")
        status["ok"] = bool(data.get("ok"))
        status["username"] = (data.get("result") or {}).get("username", "")
        status["error"] = "" if status["ok"] else "ok=false"
    except Exception as exc:
        status["error"] = f"{type(exc).__name__}:{getattr(exc, 'code', '')}"
    return status


def write_last_good(token: str, chat_id: str) -> None:
    text = "\n".join([
        f"saved_at={utc_now()}",
        f"token_sha12={token_sha(token)}",
        f"TELEGRAM_VIRTUAL_ASSISTANT_BOT_TOKEN={token}",
        f"TELEGRAM_VIRTUAL_ASSISTANT_CHAT_ID={chat_id}",
        "",
    ])
    atomic_write(LAST_GOOD_FILE, text, 0o600, None)


def restore_va_env(token: str, chat_id: str) -> None:
    env, original_lines = read_kv_file(ENV_FILE)
    drop = VA_TOKEN_KEYS | VA_CHAT_KEYS
    kept: list[str] = []
    for raw in original_lines:
        key = raw.split("=", 1)[0].strip() if "=" in raw else ""
        if key and key in drop:
            continue
        kept.append(raw)
    kept.append(f"TELEGRAM_VIRTUAL_ASSISTANT_BOT_TOKEN={token}")
    kept.append(f"TELEGRAM_VIRTUAL_ASSISTANT_CHAT_ID={chat_id or pick(env, VA_CHAT_KEYS, '6247540911')}")
    atomic_write(ENV_FILE, "\n".join(kept).rstrip() + "\n", 0o600, "openclaw2")


def systemctl(*args: str, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["systemctl", *args], text=True, capture_output=True, check=check)


def file_age_seconds(path: Path) -> int | None:
    try:
        return max(0, int(time.time() - path.stat().st_mtime))
    except FileNotFoundError:
        return None
    except Exception as exc:
        log(f"file age check failed for {path}: {type(exc).__name__}")
        return None


def recent_lines(path: Path, limit: int = 120) -> list[str]:
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]
    except Exception:
        return []


def service_properties() -> dict[str, str]:
    result = systemctl(
        "show",
        SERVICE_NAME,
        "--property=ActiveState,SubState,MainPID,ExecMainStatus,NRestarts,ExecMainStartTimestamp",
    )
    props: dict[str, str] = {}
    for line in (result.stdout or "").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            props[key] = value
    return props


def restart_va_service() -> str:
    result = systemctl("restart", SERVICE_NAME)
    if result.returncode == 0:
        return "restarted"
    return f"restart-failed:{(result.stderr or result.stdout).strip()[:160]}"


def stop_va_service() -> str:
    result = systemctl("stop", SERVICE_NAME)
    if result.returncode == 0:
        return "stopped"
    return f"stop-failed:{(result.stderr or result.stdout).strip()[:160]}"


def service_active() -> bool:
    return systemctl("is-active", "--quiet", SERVICE_NAME).returncode == 0


def repair_runtime_liveness(env: dict[str, str], state: dict[str, Any]) -> None:
    props = service_properties()
    active = service_active()
    log_age = file_age_seconds(APP_LOG_FILE)
    tail = "\n".join(recent_lines(APP_LOG_FILE, 120))
    state["service_active"] = active
    state["service_substate"] = props.get("SubState", "")
    state["service_main_pid"] = props.get("MainPID", "")
    state["service_n_restarts"] = props.get("NRestarts", "")
    state["app_log_age_seconds"] = log_age

    reason = ""
    if not active:
        reason = "service-inactive"
    elif log_age is None:
        reason = "missing-app-log"
    elif log_age > SILENCE_RESTART_SECONDS:
        reason = f"silent-app-log:{log_age}s"
    elif "Conflict: terminated by other getUpdates request" in tail:
        reason = "telegram-getupdates-conflict"
    elif "HTTP Error 401: Unauthorized" in tail and "Telegram bot commands refresh: sent" not in tail[-1200:]:
        reason = "recent-telegram-401-without-command-refresh"

    state["liveness_status"] = "ok" if not reason else reason
    if not reason:
        return

    now_ts = time.time()
    last_restart = float(state.get("last_liveness_restart_ts") or 0)
    if now_ts - last_restart < LIVENESS_RESTART_MIN_INTERVAL_SECONDS:
        state["liveness_repair"] = "restart-rate-limited"
        return

    state["last_liveness_restart_ts"] = now_ts
    state["last_liveness_restart_at"] = utc_now()
    state["last_liveness_restart_reason"] = reason
    state["liveness_repair"] = restart_va_service()
    time.sleep(3)
    state["post_restart_service_active"] = service_active()
    state["post_restart_app_log_age_seconds"] = file_age_seconds(APP_LOG_FILE)
    try:
        state["post_restart_menu_refresh"] = refresh_menu()
    except Exception as exc:
        state["post_restart_menu_refresh"] = f"failed:{type(exc).__name__}"
    log(f"liveness repair reason={reason} result={state.get('liveness_repair')}")

    final_age = file_age_seconds(APP_LOG_FILE)
    if final_age is not None and final_age > SILENCE_ALERT_SECONDS:
        alert = (
            "Blocker: Virtualni asistentka ma validni Telegram token, ale runtime log "
            f"mlci uz {final_age // 60} minut. Healthwatch provedl restart; prover prosim "
            "virtual-assistant.service a journal."
        )
        state["agent_g_silence_alert"] = send_agent_g_alert(env, state, alert, "silent_va_runtime")


def refresh_menu() -> str:
    if not VA_SCRIPT.exists():
        return "missing-va-script"
    os.environ.setdefault("HOME", "/home/openclaw2")
    os.environ.setdefault("CODEX_HOME", "/home/openclaw2/.codex")
    spec = importlib.util.spec_from_file_location("va", VA_SCRIPT)
    if spec is None or spec.loader is None:
        return "import-spec-failed"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return str(module.refresh_telegram_bot_commands(push_to_telegram=True))


def send_agent_g_alert(env: dict[str, str], state: dict[str, Any], text: str, key: str) -> str:
    now_ts = time.time()
    last = float(state.get(f"{key}_alert_ts") or 0)
    if now_ts - last < 6 * 3600:
        return "deduped"
    token = pick(env, AGENT_G_TOKEN_KEYS)
    chat_id = pick(env, AGENT_G_CHAT_KEYS) or pick(env, VA_CHAT_KEYS) or "6247540911"
    if not token or not chat_id:
        return "missing-agent-g-token-or-chat"
    try:
        telegram_call(token, "sendMessage", {"chat_id": chat_id, "text": text}, timeout=15)
        state[f"{key}_alert_ts"] = now_ts
        return "sent"
    except Exception as exc:
        return f"failed:{type(exc).__name__}:{getattr(exc, 'code', '')}"


def main() -> int:
    state = load_state()
    env, _ = read_kv_file(ENV_FILE)
    token = pick(env, VA_TOKEN_KEYS)
    chat_id = pick(env, VA_CHAT_KEYS, "6247540911")
    current = token_status(token)
    state["last_check_at"] = utc_now()
    state["current_token_sha12"] = current.get("sha12")
    state["current_token_ok"] = current.get("ok")
    state["current_token_error"] = current.get("error")

    if current.get("ok"):
        write_last_good(token, chat_id)
        state["last_valid_at"] = utc_now()
        state["last_valid_sha12"] = current.get("sha12")
        state["last_valid_username"] = current.get("username")
        repair_runtime_liveness(env, state)
        last_menu = float(state.get("last_menu_refresh_ts") or 0)
        if time.time() - last_menu > 3600:
            menu_status = refresh_menu()
            state["last_menu_refresh_status"] = menu_status
            state["last_menu_refresh_ts"] = time.time()
        save_state(state)
        log(f"ok token={current.get('sha12')} user={current.get('username')}")
        return 0

    backup_env, _ = read_kv_file(LAST_GOOD_FILE)
    backup_token = pick(backup_env, VA_TOKEN_KEYS)
    backup_chat = pick(backup_env, VA_CHAT_KEYS, chat_id)
    backup = token_status(backup_token)
    state["backup_token_sha12"] = backup.get("sha12")
    state["backup_token_ok"] = backup.get("ok")
    state["backup_token_error"] = backup.get("error")

    if backup.get("ok"):
        restore_va_env(backup_token, backup_chat)
        state["restored_at"] = utc_now()
        state["restored_from_sha12"] = backup.get("sha12")
        state["service_repair"] = restart_va_service()
        time.sleep(2)
        state["menu_after_restore"] = refresh_menu()
        save_state(state)
        log(f"restored runtime token from last-good token={backup.get('sha12')}")
        return 0

    alert = (
        "Blocker: Virtualni asistentka ma neplatny Telegram token (401) "
        "a watchdog nema validni lokalni zalozni token. Aktualizuj GitHub secret "
        "TELEGRAM_VIRTUAL_ASSISTANT_BOT_TOKEN a spust VA bridge."
    )
    if "401" in str(current.get("error") or ""):
        state["service_repair"] = stop_va_service()
    state["agent_g_alert"] = send_agent_g_alert(env, state, alert, "invalid_va_token")
    save_state(state)
    log(f"invalid token={current.get('sha12')} backup={backup.get('sha12')} alert={state.get('agent_g_alert')}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
