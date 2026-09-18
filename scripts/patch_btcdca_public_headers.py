"""Normalize the legacy public PHP headers without touching application logic."""

from __future__ import annotations

import ftplib
import os
import re
import tempfile
from pathlib import Path


HOSTS = tuple(filter(None, os.environ.get("BTCDCA_FTP_HOSTS", "ftp.btc-dca.com,neuron.blueboard.cz").split(",")))
LOGIN = os.environ["BTCDCA_FTP_LOGIN"]
PASSWORD = os.environ["BTCDCA_FTP_PASSWORD"]
BACKUP_ID = os.environ.get("GITHUB_RUN_ID", "manual")
TARGETS = (
    "dca-calculator.php",
    "login-user.php",
    "signup-user.php",
    "forgot-password.php",
    "reset-code.php",
    "new-password.php",
    "password-changed.php",
    "user-otp.php",
)

NAV = (
    '<nav class="btcdca-public-nav" aria-label="Primary navigation">'
    '<a href="https://www.btc-dca.com/">Home</a>'
    '<a href="https://www.btc-dca.com/dca-calculator">Calculator</a>'
    '<a href="https://www.btc-dca.com/#dca">DCA</a>'
    '<a href="https://www.btc-dca.com/#how-it-works">How it works</a>'
    '<a href="https://www.btc-dca.com/#faq">FAQ</a>'
    '<a href="https://www.btc-dca.com/login-user" class="btn-nav-cta">Login</a>'
    '</nav>'
)

STYLE_START = "/* BEGIN BTC-DCA unified public header */"
STYLE_END = "/* END BTC-DCA unified public header */"
STYLE = f"""
    {STYLE_START}
    .site-header {{ position: sticky; top: 0; z-index: 200; background: rgba(11,11,11,.94); backdrop-filter: blur(16px); border-bottom: 1px solid var(--border); padding: 14px 0; }}
    .site-header .container, .site-header .inner {{ min-height: 34px; }}
    .site-header .logo-link {{ display: flex; align-items: center; gap: 0; }}
    .site-header .logo-link img {{ display: block; width: auto; height: 34px; }}
    .btcdca-public-nav {{ display: flex; align-items: center; gap: 2px; }}
    .btcdca-public-nav a {{ color: var(--text-muted); font-size: 13px; font-weight: 500; padding: 6px 9px; border-radius: 6px; text-decoration: none; transition: all .2s; white-space: nowrap; }}
    .btcdca-public-nav a:hover {{ color: #fff; background: var(--border); opacity: 1; }}
    .btcdca-public-nav .btn-nav-cta {{ background: var(--btc) !important; color: #000 !important; font-weight: 700 !important; padding: 8px 18px !important; border-radius: 6px !important; }}
    .btcdca-public-nav .btn-nav-cta:hover {{ opacity: .85 !important; }}
    @media (max-width: 900px) {{ .btcdca-public-nav a:not(.btn-nav-cta) {{ display: none; }} }}
    {STYLE_END}
"""


def connect() -> ftplib.FTP:
    last_error: Exception | None = None
    for host in HOSTS:
        try:
            ftp = ftplib.FTP(host.strip(), timeout=45)
            ftp.login(LOGIN, PASSWORD)
            print(f"Connected to {host.strip()}")
            return ftp
        except Exception as exc:  # pragma: no cover - production FTP
            last_error = exc
    raise RuntimeError(f"Could not connect to BTC-DCA FTP: {last_error}")


def download(ftp: ftplib.FTP, remote: str, local: Path) -> None:
    with local.open("wb") as handle:
        ftp.retrbinary(f"RETR {remote}", handle.write)


def upload(ftp: ftplib.FTP, local: Path, remote: str) -> None:
    parent, name = remote.rsplit("/", 1)
    original = ftp.pwd()
    try:
        ftp.cwd(parent)
        with local.open("rb") as handle:
            ftp.storbinary(f"STOR {name}", handle)
    finally:
        ftp.cwd(original)


def patch_html(html: str) -> tuple[str, int]:
    header_pattern = re.compile(
        r'(<header\s+class=["\']site-header["\'][\s\S]*?<nav(?:\s[^>]*)?>)[\s\S]*?(</nav>)',
        re.IGNORECASE,
    )
    html, nav_replacements = header_pattern.subn(lambda match: match.group(1).split("<nav", 1)[0] + NAV + match.group(2), html, count=1)
    html = re.sub(r'(?<=src=["\'])assets/img/BDCA_white\.png', "/assets/img/BDCA_white.png", html)
    html = re.sub(
        r'<a\b[^>]*href=["\'][^"\']*btc-dca-(?:binance|coinmate|okx)-how-to-set-up-api-key/[^"\']*["\'][^>]*>\s*API setup guides\s*</a>',
        "",
        html,
        flags=re.IGNORECASE,
    )
    if STYLE_START not in html:
        if "</style>" not in html:
            raise RuntimeError("Public PHP page has no style block.")
        html = html.replace("</style>", STYLE + "\n  </style>", 1)
    return html, nav_replacements


def main() -> None:
    ftp = connect()
    with tempfile.TemporaryDirectory(prefix="btcdca-public-header-") as temporary:
        root = Path(temporary)
        changed = 0
        try:
            backup_dir = f".codex-backups/btcdca-public-header/{BACKUP_ID}"
            try:
                ftp.cwd(backup_dir)
            except ftplib.all_errors:
                original = ftp.pwd()
                try:
                    for part in filter(None, backup_dir.split("/")):
                        try:
                            ftp.cwd(part)
                        except ftplib.error_perm:
                            ftp.mkd(part)
                            ftp.cwd(part)
                finally:
                    ftp.cwd(original)

            for name in TARGETS:
                local = root / name
                try:
                    download(ftp, f"www/{name}", local)
                except ftplib.all_errors:
                    continue
                upload(ftp, local, f"{backup_dir}/{name}")
                html = local.read_text(encoding="utf-8", errors="replace")
                patched, replacements = patch_html(html)
                if replacements:
                    local.write_text(patched, encoding="utf-8")
                    upload(ftp, local, f"www/{name}")
                    changed += 1
                    print(f"Patched {name}")
        finally:
            ftp.quit()
    if changed == 0:
        raise RuntimeError("No public PHP headers were patched.")
    print(f"Patched {changed} public PHP header files; backups stored under .codex-backups/btcdca-public-header/{BACKUP_ID}.")


if __name__ == "__main__":
    main()
