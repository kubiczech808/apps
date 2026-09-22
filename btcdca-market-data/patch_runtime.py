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
        if re.search(r"\binsert\s+into\s+[\x60]?exchange_rates[\x60]?\b", match.group(3), re.IGNORECASE):
            count += 1
            return match.group(1) + "'SELECT 1';"
        return match.group(0)

    value = assignment.sub(replace, value)
    if re.search(r"\binsert\s+into\s+[\x60]?exchange_rates[\x60]?\b", value, re.IGNORECASE):
        raise SystemExit(f"{relative} still contains an exchange_rates INSERT")
    target.write_text(value, encoding="utf-8")


def patch_stats() -> None:
    target = copy("app/stats.php")
    value = target.read_text(encoding="utf-8", errors="replace")
    marker = "/* BTC-DCA market stats cache */"
    if marker not in value:
        include = re.search(r"^.*dbConnect\.php.*$", value, re.MULTILINE)
        if include is None:
            raise SystemExit("stats.php no longer has the expected dbConnect include")
        injected = "\n%s\nrequire_once __DIR__ . '/php/market-data-lib.php';\n" % marker
        value = value[: include.end()] + injected + value[include.end() :]

    def replace_query(match: re.Match[str]) -> str:
        query = match.group(0).lower()
        if "hour(created)" in query:
            group = "hour"
        elif "week(created)" in query:
            group = "week"
        elif "year(created), month(created), day(created)" in query:
            group = "day"
        elif "year(created), month(created)" in query:
            group = "month"
        else:
            raise SystemExit("stats.php contains an unsupported exchange-rate grouping")
        return "$ratesDataRows = btcdca_market_stats_rows('%s');" % group

    query = re.compile(
        r"(?im)^[ \t]*\$ratesSql\s*=\s*(['\"]).*?exchange_rates.*?\1\s*;"
    )
    value, query_count = query.subn(replace_query, value)
    if query_count != 4:
        raise SystemExit(f"stats.php expected 4 exchange-rate queries, found {query_count}")
    fetch = re.compile(r"\$ratesQ\s*=\s*mysqli_query\(\$conn,\s*\$ratesSql\)\s*;", re.IGNORECASE)
    value, fetch_count = fetch.subn("", value)
    loops = re.compile(r"while\s*\(\s*\$ratesData\s*=\s*mysqli_fetch_array\(\$ratesQ\)\s*\)\s*\{", re.IGNORECASE)
    value, loop_count = loops.subn("foreach ($ratesDataRows as $ratesData) {", value)
    if fetch_count != 4 or loop_count != 4:
        raise SystemExit(
            f"stats.php expected 4 result loops, found {fetch_count} queries and {loop_count} loops"
        )
    if re.search(r"exchange_rates", value, re.IGNORECASE):
        raise SystemExit("stats.php still contains an exchange_rates reference")
    target.write_text(value, encoding="utf-8")


def patch_calc_result() -> None:
    target = copy("app/includes/calc_result.php")
    value = target.read_text(encoding="utf-8", errors="replace")
    marker = "/* BTC-DCA market calculator price */"
    if marker not in value:
        price_block = re.compile(
            r"\$priceSql\s*=\s*(['\"]).*?exchange_rates.*?\1\s*;\s*"
            r"\$ratesQ\s*=\s*mysqli_query\(\$conn,\s*\$priceSql\)\s*;\s*"
            r"while\s*\(\s*\$ratesData\s*=\s*mysqli_fetch_array\(\$ratesQ\)\s*\)\s*\{\s*"
            r"\$current_price\s*=\s*\$ratesData\['rate'\]\s*;\s*\}",
            re.IGNORECASE | re.DOTALL,
        )
        replacement = (
            "%s\n"
            "require_once __DIR__ . '/../php/market-data-lib.php';\n"
            "$btcdcaMarketSnapshot = btcdca_market_spot();\n"
            "$btcdcaMarketRates = isset($btcdcaMarketSnapshot['rates']) ? $btcdcaMarketSnapshot['rates'] : array();\n"
            "$current_price = isset($btcdcaMarketRates['BTC_USDT']) ? $btcdcaMarketRates['BTC_USDT'] : 0;"
        ) % marker
        value, count = price_block.subn(replacement, value, count=1)
        if count != 1:
            raise SystemExit("calc_result.php no longer has the expected exchange-rate price block")
    if re.search(r"exchange_rates", value, re.IGNORECASE):
        raise SystemExit("calc_result.php still contains an exchange_rates reference")
    target.write_text(value, encoding="utf-8")


def main() -> None:
    patch_overview()
    patch_stats()
    patch_calc_result()
    neutralize_exchange_rate_inserts("app/php/get_live_price.php")
    neutralize_exchange_rate_inserts("app/php/get_ticker.php")
    for name in ("market-data-lib.php", "market-data.php", "getTicker.php"):
        target = TARGET / "php" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path("btcdca-market-data") / name, target)


if __name__ == "__main__":
    main()
