from __future__ import annotations

import ftplib
import json
import os
import re
import sys
from dataclasses import dataclass, asdict
from html import unescape
from pathlib import PurePosixPath
from typing import Optional

import requests


@dataclass
class Audit:
    ftp_host: str = ""
    ftp_root: str = ""
    wordpress_root: str = ""
    wordpress_version: str = "unknown"
    plugin_directories: list[str] = None
    admin_login_ok: bool = False
    active_plugins: list[str] = None
    product_count: Optional[int] = None
    page_count: Optional[int] = None
    post_count: Optional[int] = None

    def __post_init__(self):
        self.plugin_directories = self.plugin_directories or []
        self.active_plugins = self.active_plugins or []


def ftp_entries(ftp: ftplib.FTP, path: str) -> list[tuple[str, str]]:
    try:
        return [(name, facts.get("type", "")) for name, facts in ftp.mlsd(path)]
    except ftplib.all_errors:
        try:
            return [(PurePosixPath(name).name, "") for name in ftp.nlst(path)]
        except ftplib.all_errors:
            return []


def ftp_file(ftp: ftplib.FTP, path: str) -> str:
    chunks: list[bytes] = []
    ftp.retrbinary(f"RETR {path}", chunks.append)
    return b"".join(chunks).decode("utf-8", errors="replace")


def locate_wordpress(ftp: ftplib.FTP) -> str:
    candidates = ["/", "/www", "/web", "/public_html"]
    root_names = [name for name, _ in ftp_entries(ftp, "/")]
    candidates.extend(f"/{name}" for name in root_names[:50])
    for candidate in dict.fromkeys(candidates):
        names = {name for name, _ in ftp_entries(ftp, candidate)}
        if {"wp-admin", "wp-content", "wp-includes"}.issubset(names):
            return candidate.rstrip("/") or "/"
    return ""


def parse_count(html: str) -> Optional[int]:
    match = re.search(r'<span class="displaying-num">\s*([\d\s,.]+)', html, re.I)
    if not match:
        return None
    digits = re.sub(r"\D", "", unescape(match.group(1)))
    return int(digits) if digits else None


def admin_audit(audit: Audit) -> None:
    username = os.environ["JAMU_WP_LOGIN"]
    password = os.environ["WP_JAMU_PWD"]
    session = requests.Session()
    session.headers["User-Agent"] = "JAMU deployment audit/1.0"
    session.get("https://tajemstvijamu.cz/wp-login.php", timeout=30)
    response = session.post(
        "https://tajemstvijamu.cz/wp-login.php",
        data={
            "log": username,
            "pwd": password,
            "wp-submit": "Log In",
            "redirect_to": "https://tajemstvijamu.cz/wp-admin/",
            "testcookie": "1",
        },
        timeout=30,
        allow_redirects=True,
    )
    audit.admin_login_ok = "/wp-admin" in response.url and "login_error" not in response.text
    if not audit.admin_login_ok:
        return

    plugins = session.get("https://tajemstvijamu.cz/wp-admin/plugins.php", timeout=30).text
    audit.active_plugins = sorted(set(re.findall(
        r'<tr[^>]*class="[^"]*\bactive\b[^"]*"[^>]*data-slug="([^"]+)"', plugins, re.I
    )))
    for post_type, field in [("product", "product_count"), ("page", "page_count"), ("post", "post_count")]:
        url = f"https://tajemstvijamu.cz/wp-admin/edit.php?post_type={post_type}" if post_type != "post" else "https://tajemstvijamu.cz/wp-admin/edit.php"
        setattr(audit, field, parse_count(session.get(url, timeout=30).text))


def main() -> int:
    login = os.environ["JAMU_FTP_LOGIN"]
    password = os.environ["JAMU_FTP_PWD"]
    audit = Audit()
    ftp = None
    errors = []
    for host in ["ftp.tajemstvijamu.cz", "neuron.blueboard.cz"]:
        try:
            candidate = ftplib.FTP(host, timeout=30)
            candidate.login(login, password)
            candidate.set_pasv(True)
            ftp = candidate
            audit.ftp_host = host
            audit.ftp_root = candidate.pwd()
            break
        except ftplib.all_errors as exc:
            errors.append(f"{host}: {type(exc).__name__}")
    if ftp is None:
        raise RuntimeError("FTP connection failed: " + ", ".join(errors))

    audit.wordpress_root = locate_wordpress(ftp)
    if audit.wordpress_root:
        prefix = "" if audit.wordpress_root == "/" else audit.wordpress_root
        try:
            version_php = ftp_file(ftp, f"{prefix}/wp-includes/version.php")
            match = re.search(r"\$wp_version\s*=\s*'([^']+)'", version_php)
            if match:
                audit.wordpress_version = match.group(1)
        except ftplib.all_errors:
            pass
        audit.plugin_directories = sorted(name for name, kind in ftp_entries(ftp, f"{prefix}/wp-content/plugins") if name not in {".", ".."})
    ftp.quit()

    admin_audit(audit)
    result = asdict(audit)
    with open("jamu-audit.json", "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not audit.wordpress_root:
        print("WordPress root could not be located.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

