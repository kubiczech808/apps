<?php

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=30, stale-while-revalidate=300');
require_once __DIR__ . '/market-data-lib.php';

$action = isset($_GET['action']) ? (string) $_GET['action'] : 'spot';
if ($action === 'spot') {
    $spot = btcdca_market_spot();
    if (empty($spot['rates'])) {
        http_response_code(503);
        echo json_encode(array('status' => 0, 'message' => 'Market data is temporarily unavailable.'));
        exit;
    }
    echo json_encode(array('status' => 1, 'data' => $spot));
    exit;
}
if ($action === 'candles') {
    $interval = isset($_GET['interval']) ? (string) $_GET['interval'] : '1h';
    $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 168;
    $candles = btcdca_market_candles($interval, $limit);
    if ($candles === null || empty($candles['candles'])) {
        http_response_code(503);
        echo json_encode(array('status' => 0, 'message' => 'Market candles are temporarily unavailable.'));
        exit;
    }
    echo json_encode(array('status' => 1, 'data' => $candles));
    exit;
}
http_response_code(400);
echo json_encode(array('status' => 0, 'message' => 'Unsupported market-data action.'));
