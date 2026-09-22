"""Patch the small set of production files that currently persist live prices.

The input is downloaded fresh from FTP.  A failed expectation aborts the deploy
before any file is uploaded, so this script never guesses at a changed runtime.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path


SOURCE = Path("server-current")
TARGET = Path("deploy-root/www")
MARKER = "/* BTC-DCA bounded market-data cache */"


def copy(relative: str) -> Path:
    source = SOURCE / relative
    target = TARGET / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    return target


def patch_overview() -> None:
    target = copy("app/overview.php")
    value = target.read_text(encoding="utf-8", errors="replace")
    if MARKER in value:
        return
    login_include = re.search(r"^.*loginCheck\.php.*$", value, re.MULTILINE)
    if login_include is None:
        raise SystemExit("overview.php no longer has the expected login check include")
    injected = """
%s
require_once __DIR__ . '/../php/market-data-lib.php';
$btcdcaMarketSnapshot = btcdca_market_spot();
$btcdcaMarketRates = isset($btcdcaMarketSnapshot['rates']) ? $btcdcaMarketSnapshot['rates'] : array();
$czk_btc = isset($btcdcaMarketRates['BTC_CZK']) ? $btcdcaMarketRates['BTC_CZK'] : null;
$eur_btc = isset($btcdcaMarketRates['BTC_EUR']) ? $btcdcaMarketRates['BTC_EUR'] : null;
$btc_usd = isset($btcdcaMarketRates['BTC_USDT']) ? $btcdcaMarketRates['BTC_USDT'] : null;
""" % MARKER
    value = value[: login_include.end()] + injected + value[login_include.end() :]

    # The legacy queries would overwrite the live cached values above.  Keep
    # their loops harmless while the historical table remains available to
    # legacy statistics pages during the migration.
    patterns = (
        "BTC_CZK",
        "BTC_EUR",
        "BTC_USDT",
    )
    replacements = 0
    for asset in patterns:
        pattern = re.compile(
            r"(?is)(\$ratesSql\s*=\s*)(['\"])(?:(?!\2).|\\.)*?exchange_rates(?:(?!\2).|\\.)*?"
            + re.escape(asset)
            + r"(?:(?!\2).|\\.)*?\2\s*;"
        )
        value, count = pattern.subn(r"\1'SELECT 1 WHERE 1 = 0';", value, count=1)
        replacements += count
    if replacements != len(patterns):
        raise SystemExit("overview.php exchange-rate query shape changed; refusing to deploy")
    target.write_text(value, encoding="utf-8")


def neutralize_exchange_rate_inserts(relative: str) -> None:
    target = copy(relative)
    value = target.read_text(encoding="utf-8", errors="replace")
    if MARKER not in value:
        value = MARKER + "\n" + value

    assignment = re.compile(
        r"(?is)(\$[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(['\"])((?:\\.|(?!\2).)*?)(\2\s*;)"
    )
    count = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal count
        if re.search(r"\binsert\s+into\s+`?exchange_rates`?\b", match.group(3), re.IGNORECASE):
            count += 1
            return match.group(1) + "'SELECT 1';"
        return match.group(0)

    value = assignment.sub(replace, value)
    if count == 0:
        raise SystemExit(f"{relative} did not contain an exchange_rates INSERT assignment")
    if re.search(r"\binsert\s+into\s+`?exchange_rates`?\b", value, re.IGNORECASE):
        raise SystemExit(f"{relative} still contains an exchange_rates INSERT")
    target.write_text(value, encoding="utf-8")


def main() -> None:
    patch_overview()
    neutralize_exchange_rate_inserts("app/php/get_live_price.php")
    neutralize_exchange_rate_inserts("app/php/get_ticker.php")
    for name in ("market-data-lib.php", "market-data.php", "getTicker.php"):
        target = TARGET / "php" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path("btcdca-market-data") / name, target)


if __name__ == "__main__":
    main()
