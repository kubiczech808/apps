"""Read-only audit for stale Learn Center references in BTC-DCA application files."""

from __future__ import annotations

import ftplib
import os
import re
from pathlib import Path


HOSTS = tuple(filter(None, os.environ.get("BTCDCA_FTP_HOSTS", "ftp.btc-dca.com,neuron.blueboard.cz").split(",")))
LOGIN = os.environ["BTCDCA_FTP_LOGIN"]
PASSWORD = os.environ["BTCDCA_FTP_PASSWORD"]
REPORT = Path(os.environ.get("BTCDCA_LEARN_LINK_REPORT", ".github/inspection/btcdca-learn-link-audit.md"))
TEXT_EXTENSIONS = (".php", ".js", ".css", ".html", ".htm", ".inc")
ROOT_FILES = (
    "www/login-user.php",
    "www/signup-user.php",
    "www/dca-calculator.php",
    "www/forgot-password.php",
    "www/reset-code.php",
    "www/new-password.php",
)


def connect() -> ftplib.FTP:
    last_error: Exception | None = None
    for host in HOSTS:
        try:
            ftp = ftplib.FTP(host.strip(), timeout=45)
            ftp.login(LOGIN, PASSWORD)
            return ftp
        except Exception as exc:  # pragma: no cover - production connectivity
            last_error = exc
    raise RuntimeError(f"Could not connect to BTC-DCA FTP: {last_error}")


def app_files(ftp: ftplib.FTP, path: str = "www/app", depth: int = 0) -> set[str]:
    if depth > 4:
        return set()
    try:
        names = ftp.nlst(path)
    except ftplib.all_errors:
        return set()
    found: set[str] = set()
    for name in names:
        if name.rsplit("/", 1)[-1] in {".", ".."}:
            continue
        if name.lower().endswith(TEXT_EXTENSIONS):
            found.add(name)
        elif "." not in name.rsplit("/", 1)[-1]:
            found.update(app_files(ftp, name, depth + 1))
    return found


def read_text(ftp: ftplib.FTP, remote: str) -> str | None:
    chunks: list[bytes] = []
    try:
        ftp.retrbinary(f"RETR {remote}", chunks.append)
    except ftplib.all_errors:
        return None
    data = b"".join(chunks)
    if len(data) > 1_000_000:
        return None
    return data.decode("utf-8", "replace")


def main() -> None:
    ftp = connect()
    try:
        files = sorted(app_files(ftp) | set(ROOT_FILES))
        matches: list[tuple[str, int, str]] = []
        for remote in files:
            content = read_text(ftp, remote)
            if content is None:
                continue
            for number, line in enumerate(content.splitlines(), 1):
                if re.search(r"learn[\s-]*center", line, re.I):
                    matches.append((remote, number, line.strip()[:500]))
    finally:
        ftp.quit()

    report = [
        "# BTC-DCA Learn Center link audit",
        "",
        "Read-only production audit of root account pages and application text files. No files were changed.",
        "",
        f"Files scanned: {len(files)}.",
        "",
        "## Findings",
        "",
    ]
    if matches:
        report += [f"- `{remote}:{number}`: `{line}`" for remote, number, line in matches]
    else:
        report.append("No Learn Center references found in the scanned BTC-DCA application files.")
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text("\n".join(report) + "\n", encoding="utf-8")
    print(f"Audited {len(files)} files; stale Learn Center references: {len(matches)}.")


if __name__ == "__main__":
    main()
