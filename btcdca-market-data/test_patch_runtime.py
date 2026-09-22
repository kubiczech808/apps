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
    insert = "<?php\n$sql = \"INSERT INTO exchange_rates (asset) VALUES ('BTC_USDT')\";\n"
    write(patch_runtime.SOURCE / "app/php/get_live_price.php", insert)
    write(patch_runtime.SOURCE / "app/php/get_ticker.php", insert)
    patch_runtime.main()
    overview = (patch_runtime.TARGET / "app/overview.php").read_text(encoding="utf-8")
    assert patch_runtime.MARKER in overview
    assert "SELECT * FROM exchange_rates" not in overview
    for relative in ("app/php/get_live_price.php", "app/php/get_ticker.php"):
        patched = (patch_runtime.TARGET / relative).read_text(encoding="utf-8")
        assert "INSERT INTO exchange_rates" not in patched
        assert "SELECT 1" in patched
    for relative in ("php/market-data-lib.php", "php/market-data.php", "php/getTicker.php"):
        assert (patch_runtime.TARGET / relative).is_file()

print("Runtime patch test passed.")
