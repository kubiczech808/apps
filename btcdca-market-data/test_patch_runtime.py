from __future__ import annotations

import tempfile
from pathlib import Path

import patch_runtime


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    patch_runtime.SOURCE = root / "server-current"
    patch_runtime.TARGET = root / "deploy-root" / "www"
    write(
        patch_runtime.SOURCE / "app/overview.php",
        "<?php\nrequire_once '../includes/php/loginCheck.php';\n"
        "$ratesSql = \"SELECT * FROM exchange_rates WHERE asset = 'BTC_CZK'\";\n"
        "$ratesSql = \"SELECT * FROM exchange_rates WHERE asset = 'BTC_EUR'\";\n"
        "$ratesSql = \"SELECT * FROM exchange_rates WHERE asset = 'BTC_USDT'\";\n",
    )
    write(
        patch_runtime.SOURCE / "app/stats.php",
        "<?php\ninclude '../includes/dbConnect.php';\n"
        "$ratesSql = \"SELECT created, AVG(rate) FROM exchange_rates GROUP BY year(created), month(created), day(created), hour(created)\";\n"
        "$ratesQ = mysqli_query($conn, $ratesSql); while($ratesData = mysqli_fetch_array($ratesQ)){ echo $ratesData['created']; }\n"
        "$ratesSql = \"SELECT created, AVG(rate) FROM exchange_rates GROUP BY year(created), month(created), day(created)\";\n"
        "$ratesQ = mysqli_query($conn, $ratesSql); while($ratesData = mysqli_fetch_array($ratesQ)){ echo $ratesData['created']; }\n"
        "$ratesSql = \"SELECT created, AVG(rate) FROM exchange_rates GROUP BY year(created), week(created)\";\n"
        "$ratesQ = mysqli_query($conn, $ratesSql); while($ratesData = mysqli_fetch_array($ratesQ)){ echo $ratesData['created']; }\n"
        "$ratesSql = \"SELECT created, AVG(rate) FROM exchange_rates GROUP BY year(created), month(created)\";\n"
        "$ratesQ = mysqli_query($conn, $ratesSql); while($ratesData = mysqli_fetch_array($ratesQ)){ echo $ratesData['created']; }\n",
    )
    write(
        patch_runtime.SOURCE / "app/includes/calc_result.php",
        "<?php\n$priceSql = \"SELECT * FROM exchange_rates WHERE asset = 'BTC_USDT' ORDER BY rate_id DESC LIMIT 1\";\n"
        "$ratesQ = mysqli_query($conn, $priceSql); while($ratesData = mysqli_fetch_array($ratesQ)){ $current_price = $ratesData['rate']; }\n",
    )
    write(patch_runtime.SOURCE / "app/php/get_cycle_ath.php", "<?php\n$cycleSql = 'SELECT * FROM btc_cycles';\n")
    insert = "<?php\n$sql = \"INSERT INTO exchange_rates (asset) VALUES ('BTC_USDT')\";\n"
    write(patch_runtime.SOURCE / "app/php/get_live_price.php", insert)
    write(patch_runtime.SOURCE / "app/php/get_ticker.php", insert)
    patch_runtime.main()
    overview = (patch_runtime.TARGET / "app/overview.php").read_text(encoding="utf-8")
    assert patch_runtime.MARKER in overview
    assert "SELECT * FROM exchange_rates" not in overview
    assert "exchange_rates" not in overview
    stats = (patch_runtime.TARGET / "app/stats.php").read_text(encoding="utf-8")
    assert "exchange_rates" not in stats
    assert stats.count("btcdca_market_stats_rows") == 4
    calc_result = (patch_runtime.TARGET / "app/includes/calc_result.php").read_text(encoding="utf-8")
    assert "exchange_rates" not in calc_result
    assert "btcdca_market_spot" in calc_result
    for relative in ("app/php/get_live_price.php", "app/php/get_ticker.php"):
        patched = (patch_runtime.TARGET / relative).read_text(encoding="utf-8")
        assert "INSERT INTO exchange_rates" not in patched
        assert "SELECT 1" in patched
    for relative in ("php/market-data-lib.php", "php/market-data.php", "php/getTicker.php"):
        assert (patch_runtime.TARGET / relative).is_file()

print("Runtime patch test passed.")
