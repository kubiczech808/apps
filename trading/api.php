<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function respond(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function fetch_json(string $url): array
{
    if (!function_exists('curl_init')) {
        $context = stream_context_create([
            'http' => [
                'timeout' => 15,
                'header' => "User-Agent: TradingPoC/1.0\r\n",
            ],
        ]);
        $body = @file_get_contents($url, false, $context);
        if ($body === false) {
            throw new RuntimeException('HTTP request failed');
        }
        $data = json_decode($body, true);
        if (!is_array($data)) {
            throw new RuntimeException('Invalid JSON response');
        }
        return $data;
    }

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_USERAGENT => 'TradingPoC/1.0',
    ]);

    $body = curl_exec($ch);
    $error = curl_error($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($body === false || $status < 200 || $status >= 300) {
        throw new RuntimeException($error !== '' ? $error : "HTTP {$status}");
    }

    $data = json_decode($body, true);
    if (!is_array($data)) {
        throw new RuntimeException('Invalid JSON response');
    }

    return $data;
}

function parse_json_field(mixed $value): array
{
    if (is_array($value)) {
        return $value;
    }

    if (is_string($value) && $value !== '') {
        $decoded = json_decode($value, true);
        return is_array($decoded) ? $decoded : [];
    }

    return [];
}

try {
    $action = $_GET['action'] ?? 'markets';

    if ($action === 'markets') {
        $limit = max(1, min(50, (int) ($_GET['limit'] ?? 20)));
        $search = trim((string) ($_GET['search'] ?? ''));
        $query = http_build_query([
            'limit' => $limit,
            'active' => 'true',
            'closed' => 'false',
            'order' => 'volume24hr',
            'ascending' => 'false',
        ]);
        if ($search !== '') {
            $query .= '&' . http_build_query(['search' => $search]);
        }

        $markets = fetch_json("https://gamma-api.polymarket.com/markets?{$query}");
        $items = [];

        foreach ($markets as $market) {
            $items[] = [
                'id' => $market['id'] ?? null,
                'question' => $market['question'] ?? '',
                'slug' => $market['slug'] ?? '',
                'outcomes' => parse_json_field($market['outcomes'] ?? []),
                'outcomePrices' => parse_json_field($market['outcomePrices'] ?? []),
                'clobTokenIds' => parse_json_field($market['clobTokenIds'] ?? []),
                'liquidity' => (float) ($market['liquidity'] ?? 0),
                'volume24hr' => (float) ($market['volume24hr'] ?? 0),
                'endDate' => $market['endDate'] ?? null,
                'negRisk' => (bool) ($market['negRisk'] ?? false),
            ];
        }

        respond([
            'ok' => true,
            'generatedAt' => gmdate('c'),
            'markets' => $items,
        ]);
    }

    if ($action === 'book') {
        $tokenId = preg_replace('/[^0-9]/', '', (string) ($_GET['token_id'] ?? ''));
        if ($tokenId === '') {
            respond(['ok' => false, 'error' => 'token_id is required'], 400);
        }

        $book = fetch_json('https://clob.polymarket.com/book?' . http_build_query(['token_id' => $tokenId]));
        $bidPrices = array_map(
            static fn (array $level): float => (float) ($level['price'] ?? 0),
            is_array($book['bids'] ?? null) ? $book['bids'] : []
        );
        $askPrices = array_map(
            static fn (array $level): float => (float) ($level['price'] ?? 0),
            is_array($book['asks'] ?? null) ? $book['asks'] : []
        );
        $bestBid = $bidPrices !== [] ? max($bidPrices) : null;
        $bestAsk = $askPrices !== [] ? min($askPrices) : null;
        $spread = $bestBid !== null && $bestAsk !== null ? max(0, $bestAsk - $bestBid) : null;

        respond([
            'ok' => true,
            'generatedAt' => gmdate('c'),
            'tokenId' => $tokenId,
            'bestAsk' => $bestAsk,
            'bestBid' => $bestBid,
            'spread' => $spread,
            'book' => $book,
        ]);
    }

    respond(['ok' => false, 'error' => 'Unknown action'], 404);
} catch (Throwable $e) {
    respond([
        'ok' => false,
        'error' => $e->getMessage(),
    ], 502);
}
