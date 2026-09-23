<?php

/*
 * Small, bounded market-data cache shared by the public site and the app.
 * Cache files live outside /www and are replaced atomically.
 */

function btcdca_market_cache_dir()
{
    $dir = dirname(__DIR__, 2) . '/.btcdca-market-cache';
    if (!is_dir($dir)) {
        @mkdir($dir, 0750, true);
    }
    return $dir;
}

function btcdca_market_read_cache($name)
{
    $path = btcdca_market_cache_dir() . '/' . $name . '.json';
    if (!is_file($path)) {
        return null;
    }
    $raw = @file_get_contents($path);
    $decoded = $raw === false ? null : json_decode($raw, true);
    return is_array($decoded) ? $decoded : null;
}

function btcdca_market_write_cache($name, array $payload)
{
    $dir = btcdca_market_cache_dir();
    if (!is_dir($dir) || !is_writable($dir)) {
        return false;
    }
    $temp = @tempnam($dir, $name . '-');
    if ($temp === false) {
        return false;
    }
    $written = @file_put_contents($temp, json_encode($payload), LOCK_EX);
    if ($written === false) {
        @unlink($temp);
        return false;
    }
    return @rename($temp, $dir . '/' . $name . '.json');
}

function btcdca_market_request_json($url)
{
    $context = stream_context_create(array(
        'http' => array(
            'timeout' => 5,
            'ignore_errors' => true,
            'header' => "User-Agent: BTC-DCA market-data/1.0\r\n",
        ),
    ));
    $body = @file_get_contents($url, false, $context);
    if ($body === false) {
        return null;
    }
    $decoded = json_decode($body, true);
    return is_array($decoded) ? $decoded : null;
}

function btcdca_market_numeric($value)
{
    return is_numeric($value) && (float) $value > 0 ? (float) $value : null;
}

function btcdca_market_spot($freshSeconds = 60, $staleSeconds = 604800)
{
    $cached = btcdca_market_read_cache('spot');
    $now = time();
    if (is_array($cached) && isset($cached['fetched_at']) && $now - (int) $cached['fetched_at'] <= $freshSeconds) {
        $cached['cache_status'] = 'fresh';
        return $cached;
    }

    $coinGecko = btcdca_market_request_json('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,eur,czk');
    $binance = btcdca_market_request_json('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    $usd = is_array($binance) && isset($binance['price']) ? btcdca_market_numeric($binance['price']) : null;
    $cg = is_array($coinGecko) && isset($coinGecko['bitcoin']) && is_array($coinGecko['bitcoin']) ? $coinGecko['bitcoin'] : array();
    if ($usd === null && isset($cg['usd'])) {
        $usd = btcdca_market_numeric($cg['usd']);
    }
    $eur = isset($cg['eur']) ? btcdca_market_numeric($cg['eur']) : null;
    $czk = isset($cg['czk']) ? btcdca_market_numeric($cg['czk']) : null;

    if ($usd !== null && $eur !== null && $czk !== null) {
        $payload = array(
            'fetched_at' => $now,
            'source' => is_array($binance) ? 'binance+coingecko' : 'coingecko',
            'rates' => array(
                'BTC_USDT' => $usd,
                'BTC_USD' => $usd,
                'BTC_EUR' => $eur,
                'BTC_CZK' => $czk,
            ),
        );
        btcdca_market_write_cache('spot', $payload);
        $payload['cache_status'] = 'fresh';
        return $payload;
    }

    if (is_array($cached) && isset($cached['fetched_at']) && $now - (int) $cached['fetched_at'] <= $staleSeconds) {
        $cached['cache_status'] = 'stale';
        return $cached;
    }
    return array('fetched_at' => 0, 'source' => 'unavailable', 'rates' => array(), 'cache_status' => 'unavailable');
}

function btcdca_market_candles($interval, $limit)
{
    $allowedIntervals = array('1h', '4h', '1d', '1w');
    if (!in_array($interval, $allowedIntervals, true)) {
        return null;
    }
    $limit = max(2, min(1000, (int) $limit));
    $key = 'candles-btcusdt-' . $interval . '-' . $limit;
    $cached = btcdca_market_read_cache($key);
    $ttl = $interval === '1h' ? 300 : 1800;
    if (is_array($cached) && isset($cached['fetched_at']) && time() - (int) $cached['fetched_at'] <= $ttl) {
        $cached['cache_status'] = 'fresh';
        return $cached;
    }
    $response = btcdca_market_request_json('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=' . rawurlencode($interval) . '&limit=' . $limit);
    $candles = array();
    if (is_array($response)) {
        foreach ($response as $row) {
            if (!is_array($row) || !isset($row[0], $row[1], $row[2], $row[3], $row[4])) {
                continue;
            }
            $candles[] = array(
                'open_time' => (int) $row[0],
                'open' => (float) $row[1],
                'high' => (float) $row[2],
                'low' => (float) $row[3],
                'close' => (float) $row[4],
            );
        }
    }
    if (!$candles) {
        $days = $interval === '1h' ? max(1, min(90, (int) ceil($limit / 24))) : 365;
        $fallback = btcdca_market_request_json(
            'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=' . $days
        );
        if (is_array($fallback) && isset($fallback['prices']) && is_array($fallback['prices'])) {
            foreach ($fallback['prices'] as $row) {
                if (!is_array($row) || !isset($row[0], $row[1]) || !is_numeric($row[1])) {
                    continue;
                }
                $price = (float) $row[1];
                $candles[] = array(
                    'open_time' => (int) $row[0],
                    'open' => $price,
                    'high' => $price,
                    'low' => $price,
                    'close' => $price,
                );
            }
            $candles = array_slice($candles, -$limit);
        }
    }
    if ($candles) {
        $payload = array(
            'fetched_at' => time(),
            'source' => is_array($response) ? 'binance' : 'coingecko',
            'interval' => $interval,
            'candles' => $candles,
        );
        btcdca_market_write_cache($key, $payload);
        $payload['cache_status'] = 'fresh';
        return $payload;
    }
    if (is_array($cached)) {
        $cached['cache_status'] = 'stale';
        return $cached;
    }
    return null;
}

function btcdca_market_stats_rows($group)
{
    $intervals = array(
        'hour' => array('interval' => '1h', 'limit' => 1000),
        'day' => array('interval' => '1d', 'limit' => 1000),
        'week' => array('interval' => '1w', 'limit' => 1000),
        'month' => array('interval' => '1d', 'limit' => 1000),
    );
    if (!isset($intervals[$group])) {
        return array();
    }
    $config = $intervals[$group];
    $payload = btcdca_market_candles($config['interval'], $config['limit']);
    if (!is_array($payload) || !isset($payload['candles']) || !is_array($payload['candles'])) {
        return array();
    }
    $rows = array();
    foreach ($payload['candles'] as $candle) {
        if (!is_array($candle) || !isset($candle['open_time'], $candle['close'])) {
            continue;
        }
        $rows[] = array(
            'created' => gmdate('Y-m-d H:i:s', (int) $candle['open_time'] / 1000),
            'avg_price' => (float) $candle['close'],
        );
    }
    return $rows;
}
