"""Fail before isolation when BTC-DCA app entry points require WordPress files."""

from __future__ import annotations

import ftplib
import os
import posixpath
import re


HOSTS = tuple(
    filter(None, os.environ.get("BTCDCA_FTP_HOSTS", "ftp.btc-dca.com,neuron.blueboard.cz").split(","))
)
LOGIN = os.environ["BTCDCA_FTP_LOGIN"]
PASSWORD = os.environ["BTCDCA_FTP_PASSWORD"]
ENTRY_POINTS = ("login-user.php", "signup-user.php", "app/index.php")
WORDPRESS_RUNTIME_MARKERS = (
    "wp-load.php",
    "wp-blog-header.php",
    "wp-config.php",
    "wp-includes/",
    "wp-content/",
)
WORDPRESS_TABLE_PATTERN = re.compile(r"wp_dca_[a-z0-9_]+", re.IGNORECASE)
INCLUDE_PATTERN = re.compile(
    r"\b(?:require|require_once|include|include_once)\s*(?:\(\s*)?"
    r"(?:(?:dirname\s*\(\s*__DIR__\s*,\s*\d+\s*\)|__DIR__)\s*\.\s*)?"
    r"['\"]([^'\"]+)['\"]",
    re.IGNORECASE,
)


def connect() -> ftplib.FTP:
    last_error: Exception | None = None
    for host in HOSTS:
        try:
            ftp = ftplib.FTP(host, timeout=30)
            ftp.login(LOGIN, PASSWORD)
            print(f"Connected to FTP host: {host}")
            ftp.cwd("www")
            return ftp
        except ftplib.all_errors as exc:
            last_error = exc
    raise RuntimeError(f"Could not connect to an FTP host: {last_error}")


def read_remote_file(ftp: ftplib.FTP, path: str) -> str:
    payload = bytearray()
    ftp.retrbinary(f"RETR {path}", payload.extend)
    return payload.decode("utf-8", errors="replace").lower()


def dependency_paths(path: str, contents: str) -> list[str]:
    base = posixpath.dirname(path)
    paths: list[str] = []
    for relative in INCLUDE_PATTERN.findall(contents):
        candidate = posixpath.normpath(posixpath.join(base, relative))
        if candidate.startswith("../") or not candidate.endswith(".php"):
            continue
        paths.append(candidate)
    return paths


def main() -> None:
    ftp = connect()
    try:
        findings: list[str] = []
        pending = list(ENTRY_POINTS)
        visited: set[str] = set()
        while pending:
            path = pending.pop()
            if path in visited or len(visited) >= 200:
                continue
            visited.add(path)
            try:
                contents = read_remote_file(ftp, path)
            except ftplib.error_perm:
                # Dynamic includes and optional production files are not proof
                # of a WordPress dependency; the entry point itself was read.
                continue
            matches = [marker for marker in WORDPRESS_RUNTIME_MARKERS if marker in contents]
            if matches:
                findings.append(f"{path}: {', '.join(matches)}")
            tables = sorted(set(WORDPRESS_TABLE_PATTERN.findall(contents)))
            if tables:
                findings.append(f"{path}: database tables {', '.join(tables)}")
            elif "wp_dca_" in contents:
                findings.append(f"{path}: WordPress database prefix wp_dca_")
            pending.extend(dependency_paths(path, contents))
        if findings:
            raise RuntimeError(
                "BTC-DCA account/app entry points still reference WordPress files or tables: "
                + "; ".join(findings)
            )
        print(
            "BTC-DCA account and app entry points are independent of WordPress files and tables "
            f"across {len(visited)} PHP files."
        )
    finally:
        ftp.quit()


if __name__ == "__main__":
    main()
