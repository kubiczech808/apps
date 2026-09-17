"""Reversibly isolate or restore only the BTC-DCA WordPress filesystem."""

from __future__ import annotations

import ftplib
import io
import json
import os
import re
from pathlib import PurePosixPath


HOSTS = tuple(filter(None, os.environ.get("BTCDCA_FTP_HOSTS", "ftp.btc-dca.com,neuron.blueboard.cz").split(",")))
LOGIN = os.environ["BTCDCA_FTP_LOGIN"]
PASSWORD = os.environ["BTCDCA_FTP_PASSWORD"]
MODE = os.environ["BTCDCA_WORDPRESS_FILE_MODE"]
BACKUP_DIRECTORY = ".btcdca-wordpress-isolation"
MANIFEST = f"{BACKUP_DIRECTORY}/manifest.json"
STATIC_REPLACEMENTS = ("index.html", ".htaccess", "robots.txt", "sitemap.xml")
WORDPRESS_ROOT_FILES = (
    "wp-activate.php",
    "wp-blog-header.php",
    "wp-comments-post.php",
    "wp-config-sample.php",
    "wp-config.php",
    "wp-cron.php",
    "wp-links-opml.php",
    "wp-load.php",
    "wp-login.php",
    "wp-mail.php",
    "wp-settings.php",
    "wp-signup.php",
    "wp-trackback.php",
    "xmlrpc.php",
)
OPTIONAL_ROOT_FILES = ("index.php", "license.txt", "readme.html", *STATIC_REPLACEMENTS)


def connect() -> ftplib.FTP:
    last_error: Exception | None = None
    for host in HOSTS:
        try:
            ftp = ftplib.FTP(host.strip(), timeout=60)
            ftp.login(LOGIN, PASSWORD)
            ftp.cwd("/www")
            return ftp
        except Exception as exc:  # pragma: no cover - production connectivity
            last_error = exc
    raise RuntimeError(f"Could not connect to BTC-DCA FTP: {last_error}")


def listing(ftp: ftplib.FTP) -> set[str]:
    return {PurePosixPath(name).name for name in ftp.nlst()}


def file_exists(ftp: ftplib.FTP, name: str) -> bool:
    try:
        return ftp.size(name) is not None
    except ftplib.error_perm as exc:
        if str(exc).startswith("550"):
            return False
        raise


def isolate(ftp: ftplib.FTP) -> None:
    names = listing(ftp)
    if BACKUP_DIRECTORY in names:
        raise RuntimeError("WordPress isolation directory already exists.")

    required_directories = {"wp-admin", "wp-includes", "wp-content"}
    missing = required_directories - names
    if not file_exists(ftp, "wp-config.php"):
        missing.add("wp-config.php")
    if not file_exists(ftp, "index.php"):
        missing.add("index.php")
    if missing:
        raise RuntimeError(f"Expected WordPress paths are missing: {', '.join(sorted(missing))}")

    wordpress_root = set(name for name in names if re.fullmatch(r"wp-[A-Za-z0-9-]+\.php", name))
    wordpress_root.update(name for name in WORDPRESS_ROOT_FILES if file_exists(ftp, name))
    wordpress_root = sorted(wordpress_root)
    moved = ["wp-admin", "wp-includes", "wp-content", *wordpress_root]
    moved.extend(name for name in OPTIONAL_ROOT_FILES if file_exists(ftp, name) and name not in moved)

    ftp.mkd(BACKUP_DIRECTORY)
    completed: list[str] = []
    try:
        for name in moved:
            ftp.rename(name, f"{BACKUP_DIRECTORY}/{name}")
            completed.append(name)
        manifest = {
            "version": 1,
            "moved": completed,
            "static_replacements": list(STATIC_REPLACEMENTS),
        }
        payload = json.dumps(manifest, sort_keys=True).encode("utf-8")
        ftp.storbinary(f"STOR {MANIFEST}", io.BytesIO(payload))
    except Exception:
        for name in reversed(completed):
            try:
                ftp.rename(f"{BACKUP_DIRECTORY}/{name}", name)
            except ftplib.all_errors:
                pass
        try:
            ftp.rmd(BACKUP_DIRECTORY)
        except ftplib.all_errors:
            pass
        raise


def rollback(ftp: ftplib.FTP) -> None:
    payload = bytearray()
    ftp.retrbinary(f"RETR {MANIFEST}", payload.extend)
    manifest = json.loads(payload.decode("utf-8"))
    moved = manifest.get("moved")
    static_replacements = manifest.get("static_replacements")
    if not isinstance(moved, list) or not isinstance(static_replacements, list):
        raise RuntimeError("WordPress isolation manifest is invalid.")
    if any(not isinstance(name, str) or "/" in name or name in {"", ".", ".."} for name in moved):
        raise RuntimeError("WordPress isolation manifest contains an unsafe path.")

    preview_directory = f"{BACKUP_DIRECTORY}/static-preview"
    ftp.mkd(preview_directory)
    for name in static_replacements:
        if file_exists(ftp, name):
            ftp.rename(name, f"{preview_directory}/{name}")
    for name in reversed(moved):
        ftp.rename(f"{BACKUP_DIRECTORY}/{name}", name)


def main() -> None:
    ftp = connect()
    try:
        if MODE == "isolate":
            isolate(ftp)
            print("WordPress files isolated without deletion.")
        elif MODE == "rollback":
            rollback(ftp)
            print("WordPress files restored from the isolation directory.")
        else:
            raise RuntimeError("BTCDCA_WORDPRESS_FILE_MODE must be isolate or rollback")
    finally:
        ftp.quit()


if __name__ == "__main__":
    main()
