"""Verify the public BTC-DCA site after the reversible WordPress isolation."""

from __future__ import annotations

import urllib.error
import urllib.request


BASE_URL = "https://www.btc-dca.com"
USER_AGENT = "BTC-DCA static migration verifier"
GUIDES = (
    "btc-dca-binance-how-to-set-up-api-key",
    "btc-dca-coinmate-how-to-set-up-api-key",
    "btc-dca-okx-how-to-set-up-api-key",
)


def fetch(path: str) -> tuple[int, str]:
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        headers={"User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # nosec B310 - fixed public domain
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def require_page(path: str, expected_status: int, marker: str | None = None) -> None:
    status, page = fetch(path)
    if status != expected_status:
        raise RuntimeError(f"{path} returned HTTP {status}; expected HTTP {expected_status}.")
    if marker is not None and marker not in page:
        raise RuntimeError(f"{path} returned HTTP {status} without its expected content marker.")


def main() -> None:
    require_page("/", 200, "BTC DCA static homepage")
    for slug in GUIDES:
        require_page(f"/{slug}/", 200, "/assets/img/guides/guide.css")
    require_page("/learn-center/", 410)
    require_page("/app/", 200, "<html")
    print("Public static site, preserved guides, retired Learn Center, and app verified.")


if __name__ == "__main__":
    main()
