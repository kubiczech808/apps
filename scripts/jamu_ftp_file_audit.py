from __future__ import annotations

import ftplib
import json
import os
import time
from collections import defaultdict
from pathlib import Path, PurePosixPath
from typing import Any


HOSTS = ("ftp.tajemstvijamu.cz", "neuron.blueboard.cz")
OUTPUT = Path("jamu-content/file-audit.json")
MAX_PREFIX_DEPTH = 5
MAX_LIST_ITEMS = 80


def connect() -> tuple[ftplib.FTP, str]:
    login = os.environ["JAMU_FTP_LOGIN"]
    password = os.environ["JAMU_FTP_PWD"]
    failures = []
    for host in HOSTS:
        try:
            ftp = ftplib.FTP(host, timeout=60)
            ftp.login(login, password)
            ftp.set_pasv(True)
            return ftp, host
        except ftplib.all_errors as exc:
            failures.append(f"{host}: {type(exc).__name__}")
    raise RuntimeError("FTP connection failed: " + ", ".join(failures))


def entries(ftp: ftplib.FTP, directory: PurePosixPath) -> list[tuple[str, dict[str, str]]]:
    try:
        return [(name, facts) for name, facts in ftp.mlsd(str(directory)) if name not in {".", ".."}]
    except ftplib.all_errors:
        rows = []
        try:
            for value in ftp.nlst(str(directory)):
                name = PurePosixPath(value).name
                if name not in {".", ".."}:
                    rows.append((name, {}))
        except ftplib.all_errors:
            return []
        return rows


def locate_wordpress(ftp: ftplib.FTP) -> PurePosixPath:
    candidates = [PurePosixPath("/"), PurePosixPath("/www"), PurePosixPath("/web"), PurePosixPath("/public_html")]
    for name, facts in entries(ftp, PurePosixPath("/"))[:80]:
        if facts.get("type") in {"dir", "cdir", "pdir", ""}:
            candidates.append(PurePosixPath("/") / name)

    seen = set()
    for candidate in candidates:
        candidate_key = str(candidate)
        if candidate_key in seen:
            continue
        seen.add(candidate_key)
        names = {name for name, _ in entries(ftp, candidate)}
        if {"wp-admin", "wp-content", "wp-includes"}.issubset(names):
            return candidate
    raise RuntimeError("Could not locate WordPress root over FTP.")


def relpath(path: PurePosixPath, root: PurePosixPath) -> str:
    path_str = str(path)
    root_str = str(root).rstrip("/")
    if root_str and path_str.startswith(root_str + "/"):
        return path_str[len(root_str) + 1 :]
    if path == root:
        return ""
    return path_str.lstrip("/")


def path_prefixes(relative: str, max_depth: int = MAX_PREFIX_DEPTH) -> list[str]:
    parts = [part for part in relative.split("/") if part]
    return ["/".join(parts[:depth]) for depth in range(1, min(max_depth, len(parts)) + 1)]


def load_active_plugin_slugs() -> set[str]:
    inventory = Path("jamu-content/source-inventory.json")
    if not inventory.is_file():
        return set()
    try:
        data = json.loads(inventory.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return set()
    slugs = set()
    for plugin in data.get("active_plugins", []):
        plugin_file = str(plugin.get("file", "")).strip("/")
        if "/" in plugin_file:
            slugs.add(plugin_file.split("/", 1)[0])
    return slugs


def int_fact(facts: dict[str, str], key: str) -> int:
    try:
        return int(facts.get(key, "0") or 0)
    except ValueError:
        return 0


def classify_candidate(relative: str, is_dir: bool, active_plugin_slugs: set[str]) -> tuple[str, str]:
    lower = relative.lower().strip("/")
    parts = lower.split("/") if lower else []

    if not lower:
        return "", ""

    if any(token in lower for token in ["/cache/", "/cache", "wp-content/cache", "wp-content/upgrade"]):
        return "low", "cache_or_upgrade"

    if any(token in lower for token in ["backup", "backups", "updraft", "ai1wm-backups"]):
        return "medium", "backup_like"

    if any(token in lower for token in [".jamu-multilingual-incoming-", ".jamu-multilingual-previous-"]):
        return "low", "stale_jamu_deploy_temp"

    if lower.endswith((".zip", ".tar", ".tar.gz", ".tgz", ".bak", ".old", ".log")):
        return "medium", "archive_or_log_file"

    if len(parts) >= 3 and parts[0:2] == ["wp-content", "plugins"]:
        slug = parts[2]
        if slug and slug not in active_plugin_slugs:
            return "medium", "inactive_plugin_directory"

    if len(parts) >= 3 and parts[0:2] == ["wp-content", "uploads"]:
        return "high", "uploads_media"

    if parts[:2] == ["wp-content", "themes"] or parts[:1] in (["wp-admin"], ["wp-includes"]):
        return "high", "wordpress_runtime"

    return "", ""


def top(counter: dict[str, int], limit: int = MAX_LIST_ITEMS) -> list[dict[str, Any]]:
    return [{"path": key, "count": value} for key, value in sorted(counter.items(), key=lambda item: item[1], reverse=True)[:limit]]


def audit_tree(ftp: ftplib.FTP, root: PurePosixPath) -> dict[str, Any]:
    active_plugin_slugs = load_active_plugin_slugs()
    stack = [root]
    total_files = 0
    total_dirs = 0
    total_bytes = 0
    errors: list[dict[str, str]] = []

    file_prefix_counts: dict[str, int] = defaultdict(int)
    dir_prefix_counts: dict[str, int] = defaultdict(int)
    byte_prefix_counts: dict[str, int] = defaultdict(int)
    extension_counts: dict[str, int] = defaultdict(int)
    plugin_file_counts: dict[str, int] = defaultdict(int)
    plugin_byte_counts: dict[str, int] = defaultdict(int)
    candidate_counts: dict[str, int] = defaultdict(int)
    candidate_bytes: dict[str, int] = defaultdict(int)
    candidate_reasons: dict[str, dict[str, str]] = {}

    while stack:
        directory = stack.pop()
        try:
            rows = entries(ftp, directory)
        except ftplib.all_errors as exc:
            errors.append({"path": str(directory), "error": f"{type(exc).__name__}: {exc}"[:240]})
            continue

        for name, facts in rows:
            child = directory / name
            relative = relpath(child, root)
            kind = facts.get("type", "")
            is_dir = kind == "dir"

            if is_dir:
                total_dirs += 1
                for prefix in path_prefixes(relative):
                    dir_prefix_counts[prefix] += 1
                stack.append(child)
                risk, reason = classify_candidate(relative, True, active_plugin_slugs)
                if risk:
                    candidate_reasons.setdefault(relative, {"risk": risk, "reason": reason})
                continue

            total_files += 1
            size = int_fact(facts, "size")
            total_bytes += size

            suffix = PurePosixPath(relative).suffix.lower() or "[no extension]"
            extension_counts[suffix] += 1

            prefixes = path_prefixes(relative)
            for prefix in prefixes:
                file_prefix_counts[prefix] += 1
                byte_prefix_counts[prefix] += size

            parts = relative.split("/")
            if len(parts) >= 3 and parts[0] == "wp-content" and parts[1] == "plugins":
                plugin_file_counts[parts[2]] += 1
                plugin_byte_counts[parts[2]] += size

            risk, reason = classify_candidate(relative, False, active_plugin_slugs)
            if risk and prefixes:
                candidate_path = prefixes[min(len(prefixes), 3) - 1]
                candidate_counts[candidate_path] += 1
                candidate_bytes[candidate_path] += size
                candidate_reasons.setdefault(candidate_path, {"risk": risk, "reason": reason})

    plugin_summary = []
    for slug, count in sorted(plugin_file_counts.items(), key=lambda item: item[1], reverse=True):
        plugin_summary.append(
            {
                "slug": slug,
                "files": count,
                "bytes": plugin_byte_counts[slug],
                "active": slug in active_plugin_slugs,
            }
        )

    candidate_summary = []
    for path, count in sorted(candidate_counts.items(), key=lambda item: item[1], reverse=True):
        meta = candidate_reasons.get(path, {})
        candidate_summary.append(
            {
                "path": path,
                "files": count,
                "bytes": candidate_bytes[path],
                "risk": meta.get("risk", ""),
                "reason": meta.get("reason", ""),
            }
        )

    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "wordpress_root": str(root),
        "total_files": total_files,
        "total_dirs": total_dirs,
        "total_bytes": total_bytes,
        "active_plugin_slugs_from_source_inventory": sorted(active_plugin_slugs),
        "top_file_prefixes": top(file_prefix_counts),
        "top_dir_prefixes": top(dir_prefix_counts),
        "top_byte_prefixes": top(byte_prefix_counts),
        "extension_counts": top(extension_counts),
        "plugin_file_counts": plugin_summary[:MAX_LIST_ITEMS],
        "cleanup_candidates_read_only": candidate_summary[:MAX_LIST_ITEMS],
        "errors": errors[:MAX_LIST_ITEMS],
    }


def main() -> int:
    ftp, host = connect()
    try:
        root = locate_wordpress(ftp)
        report = audit_tree(ftp, root)
        report["ftp_host"] = host
        report["scope"] = "read-only FTP file count audit; no remote files changed"
    finally:
        try:
            ftp.quit()
        except ftplib.all_errors:
            ftp.close()

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: report[key] for key in ["ftp_host", "wordpress_root", "total_files", "total_dirs", "total_bytes"]}, indent=2))
    print("Top file prefixes:")
    for row in report["top_file_prefixes"][:20]:
        print(f"{row['count']:>8}  {row['path']}")
    print("Top cleanup candidates:")
    for row in report["cleanup_candidates_read_only"][:20]:
        print(f"{row['files']:>8}  {row['risk']:<6}  {row['reason']:<28}  {row['path']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
