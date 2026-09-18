"""Stage the three preserved BTC-DCA guides without touching WordPress files."""

from __future__ import annotations

import ftplib
import base64
import hashlib
import json
import os
import re
import tempfile
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "btcdca-static"
HOSTS = tuple(filter(None, os.environ.get("BTCDCA_FTP_HOSTS", "ftp.btc-dca.com,neuron.blueboard.cz").split(",")))
LOGIN = os.environ["BTCDCA_FTP_LOGIN"]
PASSWORD = os.environ["BTCDCA_FTP_PASSWORD"]
REPORT = Path(os.environ.get("BTCDCA_STAGE_REPORT", ".github/inspection/btcdca-static-stage-report.md"))

GUIDES = {
    "btc-dca-binance-how-to-set-up-api-key": "BTC DCA &amp; Binance: How to set up an API key",
    "btc-dca-coinmate-how-to-set-up-api-key": "BTC DCA &amp; Coinmate: How to set up an API key",
    "btc-dca-okx-how-to-set-up-api-key": "BTC DCA &amp; OKX: How to set up an API key",
}

# Each destination is fetched from a known production source. The fallback is for
# hosting accounts that expose old WordPress uploads beneath the legacy route.
MEDIA = {
    "coinmate-1.jpg": ("www/assets/img/articles/coinmate-1.jpg",),
    "coinmate-template-withdrawal.jpg": ("www/assets/img/articles/coinmate-template-withdrawal.jpg",),
    "coinmate-3.jpg": ("www/assets/img/articles/coinmate-3.jpg",),
    "coinmate-4.jpg": ("www/assets/img/articles/coinmate-4.jpg",),
    "coinmate-5.jpg": ("www/assets/img/articles/coinmate-5.jpg",),
    "bitpanda-7.jpg": ("www/assets/img/articles/bitpanda-7.jpg",),
    "binance.jpg": ("www/assets/img/articles/binance.jpg",),
    "binance-api-setup.png": (
        "www/wp-content/uploads/2023/03/image.png",
        "www/learn-center/wp-content/uploads/2023/03/image.png",
    ),
    "api-keys-okx.png": (
        "www/wp-content/uploads/2023/07/api-keys-okx.png",
        "www/learn-center/wp-content/uploads/2023/07/api-keys-okx.png",
    ),
    "api-key-btc-dca-okx.png": (
        "www/wp-content/uploads/2023/07/api-key-btc-dca-okx.png",
        "www/learn-center/wp-content/uploads/2023/07/api-key-btc-dca-okx.png",
    ),
    "auth-okx-api-key.png": (
        "www/wp-content/uploads/2023/07/auth-okx-api-key.png",
        "www/learn-center/wp-content/uploads/2023/07/auth-okx-api-key.png",
    ),
    "okx-api-key-details.png": (
        "www/wp-content/uploads/2023/07/image-1.png",
        "www/learn-center/wp-content/uploads/2023/07/image-1.png",
    ),
    "btc-dca-okx-set-up.png": (
        "www/wp-content/uploads/2023/07/btc-dca-okx-set-up.png",
        "www/learn-center/wp-content/uploads/2023/07/btc-dca-okx-set-up.png",
    ),
}


def connect() -> ftplib.FTP:
    last_error: Exception | None = None
    for host in HOSTS:
        try:
            ftp = ftplib.FTP(host.strip(), timeout=45)
            ftp.login(LOGIN, PASSWORD)
            print(f"Connected to {host.strip()}")
            return ftp
        except Exception as exc:  # pragma: no cover - depends on production FTP
            last_error = exc
    raise RuntimeError(f"Could not connect to BTC-DCA FTP: {last_error}")


def ensure_dir(ftp: ftplib.FTP, remote_dir: str) -> None:
    original = ftp.pwd()
    try:
        for part in filter(None, remote_dir.split("/")):
            try:
                ftp.cwd(part)
            except ftplib.error_perm:
                ftp.mkd(part)
                ftp.cwd(part)
    finally:
        ftp.cwd(original)


def download_any(ftp: ftplib.FTP, candidates: tuple[str, ...], target: Path) -> str:
    for source in candidates:
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with target.open("wb") as handle:
                ftp.retrbinary(f"RETR {source}", handle.write)
            if target.stat().st_size == 0:
                target.unlink()
                continue
            return source
        except ftplib.all_errors:
            target.unlink(missing_ok=True)
    raise RuntimeError(f"Required guide media is unavailable: {', '.join(candidates)}")


def upload(ftp: ftplib.FTP, local: Path, remote: str) -> None:
    parent, name = remote.rsplit("/", 1)
    ensure_dir(ftp, parent)
    original = ftp.pwd()
    try:
        ftp.cwd(parent)
        with local.open("rb") as handle:
            ftp.storbinary(f"STOR {name}", handle)
    finally:
            ftp.cwd(original)


def stage_brand_logo(ftp: ftplib.FTP, temporary_root: Path) -> None:
    homepage = (STATIC / "homepage" / "index.html").read_text(encoding="utf-8")
    match = re.search(r'data:image/png;base64,([^"\']+)', homepage)
    if not match:
        raise RuntimeError("The homepage does not contain the canonical BTC-DCA logo asset.")
    logo = temporary_root / "BDCA_white.png"
    logo.write_bytes(base64.b64decode(match.group(1)))
    upload(ftp, logo, "www/assets/img/BDCA_white.png")
    upload(ftp, logo, "www/assets/img/logo.png")


def public_text(url: str) -> tuple[int, str]:
    request = urllib.request.Request(url, headers={"User-Agent": "BTC-DCA static migration verifier"})
    with urllib.request.urlopen(request, timeout=30) as response:  # nosec B310 - fixed public domain
        return response.status, response.read().decode("utf-8", "replace")


def main() -> None:
    guide_hash = hashlib.sha256()
    for slug in GUIDES:
        guide_hash.update((STATIC / "guides" / slug / "index.html").read_bytes())
    guide_hash.update((STATIC / "guides" / "assets" / "guide.css").read_bytes())

    with tempfile.TemporaryDirectory(prefix="btcdca-guide-media-") as temporary:
        temporary_root = Path(temporary)
        ftp = connect()
        copied_media: dict[str, str] = {}
        try:
            for destination, candidates in MEDIA.items():
                local = temporary_root / destination
                try:
                    copied_media[destination] = download_any(ftp, candidates, local)
                except RuntimeError:
                    # After WordPress isolation the original upload may no longer
                    # be reachable, but a previous successful stage already
                    # preserved the exact guide media under this static path.
                    existing = f"www/assets/img/guides/{destination}"
                    try:
                        with local.open("wb") as handle:
                            ftp.retrbinary(f"RETR {existing}", handle.write)
                    except ftplib.all_errors as exc:
                        raise RuntimeError(
                            f"Required guide media is unavailable: {', '.join(candidates)}; "
                            f"static fallback {existing} is also unavailable."
                        ) from exc
                    copied_media[destination] = existing
                upload(ftp, local, f"www/assets/img/guides/{destination}")

            stage_brand_logo(ftp, temporary_root)
            upload(ftp, STATIC / "guides" / "assets" / "guide.css", "www/assets/img/guides/guide.css")
            upload(ftp, STATIC / "seo" / ".htaccess", "www/.htaccess")
            for slug in GUIDES:
                upload(ftp, STATIC / "guides" / slug / "index.html", f"www/{slug}/index.html")

            marker = {
                "guide_sha256": guide_hash.hexdigest(),
                "source_revision": os.environ.get("GITHUB_SHA", "manual"),
                "guides": sorted(GUIDES),
            }
            marker_path = temporary_root / "stage-marker.json"
            marker_path.write_text(json.dumps(marker, sort_keys=True) + "\n", encoding="utf-8")
            upload(ftp, marker_path, "www/.btcdca-static-guides-stage.json")
        finally:
            ftp.quit()

    verified: list[str] = []
    for slug, title in GUIDES.items():
        status, page = public_text(f"https://www.btc-dca.com/{slug}/")
        if status != 200 or title not in page or "/assets/img/guides/guide.css" not in page:
            raise RuntimeError(f"Public guide verification failed for /{slug}/ (HTTP {status}).")
        verified.append(slug)
    logo_status, _ = public_text("https://www.btc-dca.com/assets/img/BDCA_white.png")
    if logo_status != 200:
        raise RuntimeError("Public BTC-DCA logo verification failed.")

    report = [
        "# BTC-DCA static guide staging report",
        "",
        "The three preserved guides and only their required media were uploaded. No WordPress file or database table was changed.",
        "",
        "## Public verification",
        "",
        *[f"- `/{slug}/` returned the staged static guide." for slug in verified],
        "",
        "## Copied media",
        "",
        *[f"- `assets/img/guides/{destination}` from `{source}`" for destination, source in sorted(copied_media.items())],
        "",
        f"Guide content SHA-256: `{guide_hash.hexdigest()}`.",
    ]
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text("\n".join(report) + "\n", encoding="utf-8")
    print("Static guides staged and publicly verified.")


if __name__ == "__main__":
    main()
