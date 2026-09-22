<?php

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
require_once __DIR__ . '/market-data-lib.php';

$spot = btcdca_market_spot();
$price = isset($spot['rates']['BTC_USDT']) ? btcdca_market_numeric($spot['rates']['BTC_USDT']) : null;
if ($price === null) {
    http_response_code(503);
    echo json_encode(array('status' => 0, 'msg' => 'Unable to load the current BTC price.'));
    exit;
}
$rounded = (int) round($price);
echo json_encode(array(
    'status' => 1,
    'msg' => 'BTCUSD rate',
    'rate' => '$ ' . number_format($rounded, 0, '.', '&nbsp;'),
    'rateToTitle' => (string) $rounded,
));
