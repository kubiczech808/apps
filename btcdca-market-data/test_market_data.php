<?php

require_once __DIR__ . '/market-data-lib.php';

$spot = btcdca_market_spot(0);
foreach (array('BTC_USDT', 'BTC_EUR', 'BTC_CZK') as $symbol) {
    if (!isset($spot['rates'][$symbol]) || !is_numeric($spot['rates'][$symbol]) || (float) $spot['rates'][$symbol] <= 0) {
        fwrite(STDERR, "Missing valid rate for {$symbol}\n");
        exit(1);
    }
}
$candles = btcdca_market_candles('1h', 5);
if ($candles === null || count($candles['candles']) < 2) {
    fwrite(STDERR, "Missing candle response\n");
    exit(1);
}
echo "Market data smoke test passed.\n";
