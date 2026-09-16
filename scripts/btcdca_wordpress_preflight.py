"""Read-only production inventory for retiring the BTC-DCA WordPress site."""

from __future__ import annotations

import ftplib
import os
import re
import subprocess
from posixpath import dirname, basename
from pathlib import Path
from typing import Iterable


HOSTS = ("ftp.btc-dca.com", "neuron.blueboard.cz")
FTP_LOGIN = os.environ["BTCDCA_FTP_LOGIN"]
FTP_PASSWORD = os.environ["BTCDCA_FTP_PASSWORD"]
DB_NAME = os.environ["BTCDCA_DB"]
DB_USER = os.environ["BTCDCA_DB_USER"]
DB_PASSWORD = os.environ["BTCDCA_DB_PASSWORD"]
REPORT = Path(".github/inspection/btcdca-wordpress-preflight.md")


def connect_ftp() -> ftplib.FTP:
    last_error: Exception | None = None
    for host in HOSTS:
        try:
            ftp = ftplib.FTP(host, timeout=45, encoding="latin-1")
            ftp.login(FTP_LOGIN, FTP_PASSWORD)
            return ftp
        except Exception as exc:  # pragma: no cover - production connectivity
            last_error = exc
    raise RuntimeError(f"Could not connect to BTC-DCA FTP: {last_error}")


def cwd_path(ftp: ftplib.FTP, path: str) -> bool:
    try:
        ftp.cwd("/")
        for part in (part for part in path.strip("/").split("/") if part):
            ftp.cwd(part)
        return True
    except ftplib.all_errors:
        return False


def list_current(ftp: ftplib.FTP) -> list[tuple[str, bool, int | None]]:
    try:
        return [
            (name, facts.get("type") == "dir", int(facts["size"]) if facts.get("size", "").isdigit() else None)
            for name, facts in ftp.mlsd()
            if name not in {".", ".."}
        ]
    except ftplib.all_errors:
        lines: list[str] = []
        ftp.retrlines("LIST", lines.append)
        result: list[tuple[str, bool, int | None]] = []
        for line in lines:
            fields = line.split(maxsplit=8)
            if len(fields) != 9 or fields[8] in {".", ".."}:
                continue
            result.append((fields[8].split(" -> ", 1)[0], fields[0].startswith("d"), None))
        return result


def describe_directory(ftp: ftplib.FTP, path: str) -> tuple[int, int, int, list[str]]:
    """Report only the directory boundary; deep traversal is too slow on this FTP server."""
    if not cwd_path(ftp, path):
        return 0, 0, 0, [f"Not accessible: {path}"]
    try:
        entries = list_current(ftp)
    except ftplib.all_errors as exc:
        return 0, 0, 0, [f"Could not list {path}: {exc}"]
    files = sum(1 for _name, is_dir, _size in entries if not is_dir)
    directories = sum(1 for _name, is_dir, _size in entries if is_dir)
    bytes_seen = sum(size or 0 for _name, is_dir, size in entries if not is_dir)
    return files, directories, bytes_seen, []


def download_optional(ftp: ftplib.FTP, remote: str) -> str | None:
    chunks: list[bytes] = []
    try:
        parent, name = dirname(remote), basename(remote)
        if not cwd_path(ftp, parent):
            return None
        ftp.retrbinary(f"RETR {name}", chunks.append)
    except ftplib.all_errors:
        return None
    return b"".join(chunks).decode("utf-8", "replace")


def source_snippets(text: str | None, label: str) -> list[str]:
    if not text:
        return [f"### {label}", "", "File not available over FTP.", ""]
    lines = text.splitlines()
    terms = re.compile(r"learn\s*center|latest\s+from\s+the\s+blog|wordpress|wp-content|wp-admin", re.I)
    hits = [index for index, line in enumerate(lines) if terms.search(line)]
    output = [f"### {label}", ""]
    if not hits:
        return output + ["No relevant text found.", ""]
    for hit in hits[:30]:
        output += [f"Lines {hit + 1}-{min(hit + 3, len(lines))}:", "```"]
        output += [line[:600] for line in lines[hit:min(hit + 3, len(lines))]]
        output += ["```", ""]
    return output


def mysql(query: str) -> str:
    env = {**os.environ, "MYSQL_PWD": DB_PASSWORD}
    command = ["mysql", "--batch", "--skip-column-names", "--host=localhost", f"--user={DB_USER}", DB_NAME, "--execute", query]
    result = subprocess.run(command, env=env, text=True, capture_output=True, check=False)
    if result.returncode:
        return f"ERROR: {result.stderr.strip() or 'mysql command failed'}"
    return result.stdout.strip()


def main() -> None:
    ftp = connect_ftp()
    try:
        targets = ("www/wp-admin", "www/wp-includes", "www/wp-content", "www/learn-center")
        inventory = {target: describe_directory(ftp, target) for target in targets}
        root_entries = list_current(ftp) if cwd_path(ftp, "www") else []
        index_php = download_optional(ftp, "www/index.php")
        index_html = download_optional(ftp, "www/index.html")
        homepage_template = download_optional(ftp, "www/wp-content/themes/neve/btcdca-homepage-template.php")
        htaccess = download_optional(ftp, "www/.htaccess")
        robots = download_optional(ftp, "www/robots.txt")
        wp_config = download_optional(ftp, "www/wp-config.php")
    finally:
        ftp.quit()

    table_rows = mysql(
        "SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH "
        "FROM information_schema.TABLES "
        f"WHERE TABLE_SCHEMA = '{DB_NAME.replace(chr(39), chr(39) + chr(39))}' "
        "ORDER BY DATA_LENGTH + INDEX_LENGTH DESC;"
    )
    wp_prefixes = sorted(set(re.findall(r"\$table_prefix\s*=\s*['\"]([^'\"]+)", wp_config or "")))
    public_status = mysql("SELECT VERSION();")

    report = [
        "# BTC-DCA WordPress retirement preflight",
        "",
        "Read-only production inventory. No files or database records were changed.",
        "FTP values describe only the directory boundary; recursive counting is intentionally avoided because it can stall on this hosting server.",
        "",
        "## FTP inventory",
        "",
        "| Path | Files | Directories | Listed bytes | Warnings |",
        "| --- | ---: | ---: | ---: | --- |",
    ]
    for target, (files, directories, bytes_seen, errors) in inventory.items():
        warning = "<br>".join(errors[:3]) or "-"
        report.append(f"| `{target}` | {files:,} | {directories:,} | {bytes_seen:,} | {warning} |")

    report += ["", "## Database inventory", "", f"MySQL server reachable: `{public_status or 'no'}`.", ""]
    if wp_prefixes:
        report += [f"WordPress table prefix found in `wp-config.php`: `{', '.join(wp_prefixes)}`.", ""]
    else:
        report += ["WordPress table prefix was not found in `wp-config.php`; do not delete database tables until this is resolved.", ""]
    report += ["```text", table_rows or "No tables returned.", "```", ""]
    report += source_snippets(index_html, "Homepage index.html source matches")
    report += source_snippets(index_php, "WordPress index.php source matches")
    report += ["### Immediate `www` directory entries", "", "```text"]
    report += [f"{'dir ' if is_dir else 'file'} {name} ({size if size is not None else '?'} bytes)" for name, is_dir, size in root_entries]
    report += ["```", ""]
    report += source_snippets(htaccess, "Root .htaccess matches")
    report += source_snippets(robots, "robots.txt matches")
    report += [
        "## Required removal contract",
        "",
        "The removal workflow must only run after this report identifies the WordPress prefix and exact public homepage markers.",
        "It must first upload the static guides and copied guide media, export only the WordPress-prefixed tables as an Actions artifact, verify the three public guide URLs, and only then remove WordPress files and WordPress tables.",
    ]
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text("\n".join(report) + "\n", encoding="utf-8")
    if index_html:
        Path(".github/inspection/btcdca-homepage-index.html").write_text(index_html, encoding="utf-8")
    if homepage_template:
        Path(".github/inspection/btcdca-homepage-template.php").write_text(homepage_template, encoding="utf-8")


if __name__ == "__main__":
    main()
