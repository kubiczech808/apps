"""Preview or apply the removal of Learn Center links from BTC-DCA app files."""

from __future__ import annotations

import difflib
import ftplib
import os
import re
import shutil
from pathlib import Path


HOSTS = tuple(filter(None, os.environ.get("BTCDCA_FTP_HOSTS", "ftp.btc-dca.com,neuron.blueboard.cz").split(",")))
LOGIN = os.environ["BTCDCA_FTP_LOGIN"]
PASSWORD = os.environ["BTCDCA_FTP_PASSWORD"]
MODE = os.environ.get("BTCDCA_LEARN_LINK_MODE", "preview")
WORK = Path("btcdca-learn-link-cleanup")
REPORT = Path(".github/inspection/btcdca-learn-link-cleanup-preview.md")
FILES = (
    "www/app/includes/calc_form.php",
    "www/app/includes/calc_result.php",
    "www/app/includes/emails/_email-welcome.php",
    "www/app/includes/emails/email-welcome.php",
    "www/app/php/execute_withdrawal_job.php",
    "www/app/setup.php",
    "www/dca-calculator.php",
    "www/forgot-password.php",
    "www/login-user.php",
    "www/new-password.php",
    "www/reset-code.php",
    "www/signup-user.php",
)

PRESERVED_URLS = {
    "https://www.btc-dca.com/learn-center/binance-how-to-set-up-api-key/": "/btc-dca-binance-how-to-set-up-api-key/",
    "https://www.btc-dca.com/learn-center/coinmate-how-to-set-up-api-key/": "/btc-dca-coinmate-how-to-set-up-api-key/",
    "https://www.btc-dca.com/learn-center/btc-dca-okx-how-to-set-up-an-api-key/": "/btc-dca-okx-how-to-set-up-api-key/",
    "https://www.btc-dca.com/learn-center/coinmate-how-to-set-up-api-key/#Set_Up_API_Key": "/btc-dca-coinmate-how-to-set-up-api-key/#api-key",
}
RETIRED_ARTICLES = (
    "https://www.btc-dca.com/learn-center/how-much-do-bitcoin-investments-earn/#Whats_the_minimal_surely_profitable_bitcoin_investment_period",
    "https://www.btc-dca.com/learn-center/how-to-invest-in-bitcoin-periodically/",
    "https://www.btc-dca.com/learn-center/the-power-of-dollar-cost-averaging-why-dca-is-the-smarter-choice-for-long-term-investing/",
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


def download(ftp: ftplib.FTP, remote: str, local: Path) -> None:
    local.parent.mkdir(parents=True, exist_ok=True)
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


def remove_article_anchor(text: str, url: str) -> str:
    escaped_url = re.escape(url)
    pattern = re.compile(rf'<a\b[^>]*\bhref="{escaped_url}"[^>]*>(.*?)</a>', re.I | re.S)
    return pattern.sub(r'\1', text)


def transform(remote: str, original: str) -> str:
    text = original
    for source, target in sorted(PRESERVED_URLS.items(), key=lambda item: len(item[0]), reverse=True):
        text = text.replace(source, target)
    for retired in RETIRED_ARTICLES:
        text = remove_article_anchor(text, retired)

    # The generic exchange URL cannot be mapped safely for unsupported exchanges.
    text = re.sub(
        r'<small><a\b[^>]*href="https://www\.btc-dca\.com/learn-center/[^\"]*"[^>]*>How to set up API Key\?</a></small>',
        '<small>API setup guides are available for Binance, Coinmate, and OKX.</small>',
        text,
        flags=re.I | re.S,
    )
    text = re.sub(
        r'<a\b[^>]*href="https://www\.btc-dca\.com/learn-center/"[^>]*>Learn Center</a>',
        '<a href="/btc-dca-coinmate-how-to-set-up-api-key/">API setup guides</a>',
        text,
        flags=re.I | re.S,
    )
    if re.search(r'learn[\s-]*center', text, re.I):
        raise RuntimeError(f"Unresolved Learn Center reference in {remote}")
    return text


def main() -> None:
    if MODE not in {"preview", "apply"}:
        raise RuntimeError("BTCDCA_LEARN_LINK_MODE must be preview or apply")
    shutil.rmtree(WORK, ignore_errors=True)
    original_dir = WORK / "original"
    changed_dir = WORK / "changed"
    ftp = connect()
    changes: list[tuple[str, str, str]] = []
    try:
        for remote in FILES:
            original_path = original_dir / remote.removeprefix("www/")
            changed_path = changed_dir / remote.removeprefix("www/")
            download(ftp, remote, original_path)
            original = original_path.read_text(encoding="utf-8", errors="replace")
            changed = transform(remote, original)
            changed_path.parent.mkdir(parents=True, exist_ok=True)
            changed_path.write_text(changed, encoding="utf-8")
            if changed != original:
                changes.append((remote, original, changed))
        if MODE == "apply":
            for remote, _original, _changed in changes:
                upload(ftp, changed_dir / remote.removeprefix("www/"), remote)
    finally:
        ftp.quit()

    if not changes:
        raise RuntimeError("No files changed; do not treat this as a successful cleanup.")
    report = [
        "# BTC-DCA Learn Center cleanup preview",
        "",
        f"Mode: `{MODE}`. Files changed: `{len(changes)}`.",
        "",
    ]
    for remote, original, changed in changes:
        report += [f"## {remote}", "", "```diff"]
        report += list(difflib.unified_diff(original.splitlines(), changed.splitlines(), fromfile="before", tofile="after", lineterm=""))
        report += ["```", ""]
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text("\n".join(report) + "\n", encoding="utf-8")
    print(f"{MODE.title()} completed for {len(changes)} files.")


if __name__ == "__main__":
    main()
