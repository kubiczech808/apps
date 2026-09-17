"""Fail before isolation when BTC-DCA app entry points require WordPress files."""

from __future__ import annotations

import ftplib
import os


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


def main() -> None:
    ftp = connect()
    try:
        findings: list[str] = []
        for path in ENTRY_POINTS:
            contents = read_remote_file(ftp, path)
            matches = [marker for marker in WORDPRESS_RUNTIME_MARKERS if marker in contents]
            if matches:
                findings.append(f"{path}: {', '.join(matches)}")
        if findings:
            raise RuntimeError(
                "BTC-DCA account/app entry points still reference the WordPress runtime: "
                + "; ".join(findings)
            )
        print("BTC-DCA account and app entry points are independent of WordPress runtime files.")
    finally:
        ftp.quit()


if __name__ == "__main__":
    main()
