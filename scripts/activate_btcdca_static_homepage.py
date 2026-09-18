"""Upload the static BTC-DCA homepage and SEO files after backups are complete."""

from __future__ import annotations

import ftplib
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HOSTS = tuple(filter(None, os.environ.get("BTCDCA_FTP_HOSTS", "ftp.btc-dca.com,neuron.blueboard.cz").split(",")))
LOGIN = os.environ["BTCDCA_FTP_LOGIN"]
PASSWORD = os.environ["BTCDCA_FTP_PASSWORD"]
FILES = {
    ROOT / "btcdca-static" / "homepage" / "index.html": "www/index.html",
    ROOT / "btcdca-static" / "seo" / ".htaccess": "www/.htaccess",
    ROOT / "btcdca-static" / "seo" / "robots.txt": "www/robots.txt",
    ROOT / "btcdca-static" / "seo" / "sitemap.xml": "www/sitemap.xml",
}
ROUTE_NAMES = (
    "login-user",
    "signup-user",
    "dca-calculator",
    "forgot-password",
    "reset-code",
    "new-password",
    "password-changed",
    "user-otp",
    "logout-user",
    "btcdca-google-login",
    "btcdca-google-callback",
    "btcdca-google-token-login",
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


def upload(ftp: ftplib.FTP, local: Path, remote: str) -> None:
    parent, name = remote.rsplit('/', 1)
    original = ftp.pwd()
    try:
        ftp.cwd(parent)
        with local.open('rb') as handle:
            ftp.storbinary(f'STOR {name}', handle)
    finally:
        ftp.cwd(original)


def upload_route_wrapper(ftp: ftplib.FTP, route: str) -> None:
    original = ftp.pwd()
    try:
        ftp.cwd("www")
        try:
            ftp.mkd(route)
        except ftplib.error_perm as exc:
            if not str(exc).startswith("550"):
                raise
        ftp.cwd(route)
        local = ROOT / "btcdca-static" / "routes" / route / "index.php"
        with local.open('rb') as handle:
            ftp.storbinary('STOR index.php', handle)
    finally:
        ftp.cwd(original)


def main() -> None:
    ftp = connect()
    try:
        for local, remote in FILES.items():
            upload(ftp, local, remote)
            print(f'Uploaded {remote}')
        for route in ROUTE_NAMES:
            upload_route_wrapper(ftp, route)
            print(f'Uploaded www/{route}/index.php')
    finally:
        ftp.quit()


if __name__ == '__main__':
    main()
