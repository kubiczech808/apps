<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');

function fetch_json(string $url): ?array
{
    $context = stream_context_create([
        'http' => [
            'timeout' => 5,
            'ignore_errors' => true,
            'header' => "User-Agent: BTC-DCA ticker/1.0\r\n",
        ],
    ]);
    $body = @file_get_contents($url, false, $context);
    if ($body === false) {
        return null;
    }
    $decoded = json_decode($body, true);
    return is_array($decoded) ? $decoded : null;
}

function emit_price($price): void
{
    if (!is_numeric($price) || (float) $price <= 0) {
        return;
    }
    $rounded = (int) round((float) $price);
    echo json_encode([
        'status' => 1,
        'msg' => 'BTCUSD rate',
        'rate' => '$ ' . number_format($rounded, 0, '.', '&nbsp;'),
        'rateToTitle' => (string) $rounded,
    ]);
    exit;
}

$binance = fetch_json('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
if ($binance !== null && array_key_exists('price', $binance)) {
    emit_price($binance['price']);
}
$coinGecko = fetch_json('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
if ($coinGecko !== null && isset($coinGecko['bitcoin']['usd'])) {
    emit_price($coinGecko['bitcoin']['usd']);
}
http_response_code(503);
echo json_encode(['status' => 0, 'msg' => 'Unable to load the current BTC price.']);
