from __future__ import annotations

import ftplib
import json
import os
import requests
from pathlib import Path, PurePosixPath


HOSTS = ("ftp.tajemstvijamu.cz", "neuron.blueboard.cz")
OUTPUT = Path("jamu-content/file-audit.json")
TEMPLATE = Path("scripts/templates/jamu_file_audit_bridge.php")
PUBLIC_BASE_URL = "https://tajemstvijamu.cz"


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


def upload_bridge(ftp: ftplib.FTP, root: PurePosixPath, nonce: str) -> PurePosixPath:
    source = TEMPLATE.read_text(encoding="utf-8").replace("__JAMU_FILE_AUDIT_NONCE__", nonce)
    remote = root / f"jamu-file-audit-bridge-{nonce}.php"
    with os.fdopen(os.open("jamu-file-audit-bridge.tmp.php", os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600), "w", encoding="utf-8") as handle:
        handle.write(source)
    with open("jamu-file-audit-bridge.tmp.php", "rb") as handle:
        ftp.storbinary(f"STOR {remote}", handle)
    Path("jamu-file-audit-bridge.tmp.php").unlink(missing_ok=True)
    return remote


def fetch_report(remote: PurePosixPath, nonce: str) -> dict:
    url = f"{PUBLIC_BASE_URL}/{remote.name}"
    response = requests.get(
        url,
        params={"jamu_bridge": "file_audit", "jamu_nonce": nonce},
        headers={"X-JAMU-File-Audit-Token": nonce, "User-Agent": "JAMU file audit/1.0"},
        timeout=220,
    )
    response.raise_for_status()
    report = response.json()
    if report.get("site") != "https://tajemstvijamu.cz/":
        raise RuntimeError("Unexpected file audit response site.")
    return report


def main() -> int:
    nonce = "".join(ch for ch in os.environ.get("GITHUB_RUN_ID", "local") if ch.isdigit()) or "local"
    ftp, host = connect()
    remote_bridge = None
    try:
        root = locate_wordpress(ftp)
        remote_bridge = upload_bridge(ftp, root, nonce)
        report = fetch_report(remote_bridge, nonce)
        report["ftp_host"] = host
    finally:
        if remote_bridge is not None:
            try:
                ftp.delete(str(remote_bridge))
            except ftplib.all_errors:
                pass
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
