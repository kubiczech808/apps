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

function app_config(): array
{
    $config = [];
    $path = __DIR__ . '/config.php';
    if (is_file($path)) {
        $loaded = require $path;
        if (is_array($loaded)) {
            $config = $loaded;
        }
    }

    return [
        'github_token' => (string) ($config['github_token'] ?? getenv('POLY_TRADING_GITHUB_TOKEN') ?: getenv('TRADING_GITHUB_TOKEN') ?: ''),
        'trigger_key' => (string) ($config['trigger_key'] ?? getenv('TRADING_TRIGGER_KEY') ?: ''),
        'repo' => (string) ($config['repo'] ?? getenv('TRADING_GITHUB_REPO') ?: 'kubiczech808/apps'),
        'ref' => (string) ($config['ref'] ?? getenv('TRADING_GITHUB_REF') ?: 'claude/energy-consumption-app-Nf7bh'),
    ];
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

function state_payload(string $target): array
{
    $files = [
        'paper' => __DIR__ . '/data/paper-state.json',
        'live' => __DIR__ . '/data/live-state.json',
        'live-execution' => __DIR__ . '/data/live-execution-state.json',
    ];
    if (!isset($files[$target])) {
        respond(['ok' => false, 'error' => 'Unknown state target'], 400);
    }

    $path = $files[$target];
    if (!is_file($path)) {
        respond(['ok' => false, 'error' => 'State file is not available yet'], 404);
    }

    clearstatcache(true, $path);
    $raw = file_get_contents($path);
    $data = json_decode(is_string($raw) ? $raw : '', true);
    if (!is_array($data)) {
        respond(['ok' => false, 'error' => 'State file contains invalid JSON'], 502);
    }

    return $data;
}

function live_state_age_seconds(): ?int
{
    $path = __DIR__ . '/data/live-state.json';
    if (!is_file($path)) {
        return null;
    }

    $raw = file_get_contents($path);
    $data = json_decode(is_string($raw) ? $raw : '', true);
    $generatedAt = is_array($data) ? (string) ($data['generatedAt'] ?? '') : '';
    $generatedTime = $generatedAt !== '' ? strtotime($generatedAt) : false;
    if ($generatedTime === false) {
        $generatedTime = filemtime($path);
    }

    return $generatedTime ? max(0, time() - $generatedTime) : null;
}

function request_payload(): array
{
    $raw = file_get_contents('php://input');
    $data = json_decode(is_string($raw) ? $raw : '', true);
    return is_array($data) ? $data : [];
}

function request_header(string $name): string
{
    $normalized = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    if (isset($_SERVER[$normalized])) {
        return (string) $_SERVER[$normalized];
    }

    if (function_exists('getallheaders')) {
        $headers = getallheaders();
        foreach ($headers as $key => $value) {
            if (strcasecmp((string) $key, $name) === 0) {
                return (string) $value;
            }
        }
    }

    return '';
}

function dispatch_workflow(string $workflow, array $inputs, bool $requireTriggerKey = true): array
{
    $config = app_config();
    if ($config['github_token'] === '' || ($requireTriggerKey && $config['trigger_key'] === '')) {
        respond([
            'ok' => false,
            'error' => 'Workflow trigger is not configured on the server.',
            'requiredSecrets' => $requireTriggerKey ? ['POLY_TRADING_GITHUB_TOKEN', 'TRADING_TRIGGER_KEY'] : ['POLY_TRADING_GITHUB_TOKEN'],
        ], 503);
    }

    if ($requireTriggerKey) {
        $providedKey = request_header('X-Trading-Trigger-Key');
        if ($providedKey === '' || !hash_equals($config['trigger_key'], $providedKey)) {
            respond(['ok' => false, 'error' => 'Invalid workflow trigger key.'], 403);
        }
    }

    $url = sprintf(
        'https://api.github.com/repos/%s/actions/workflows/%s/dispatches',
        rawurlencode($config['repo']),
        rawurlencode($workflow)
    );
    $url = str_replace('%2F', '/', $url);
    $body = json_encode([
        'ref' => $config['ref'],
        'inputs' => (object) $inputs,
    ], JSON_UNESCAPED_SLASHES);

    $httpHeaders = [
        'Accept: application/vnd.github+json',
        'Authorization: Bearer ' . $config['github_token'],
        'Content-Type: application/json',
        'User-Agent: osobnizkusenosti-trading-trigger',
        'X-GitHub-Api-Version: 2022-11-28',
    ];

    if (!function_exists('curl_init')) {
        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => implode("\r\n", $httpHeaders) . "\r\n",
                'content' => $body,
                'timeout' => 20,
                'ignore_errors' => true,
            ],
        ]);
        $responseBody = @file_get_contents($url, false, $context);
        $status = 0;
        foreach ($http_response_header ?? [] as $header) {
            if (preg_match('/^HTTP\/\S+\s+(\d{3})/', $header, $matches)) {
                $status = (int) $matches[1];
            }
        }
        if ($responseBody === false || $status < 200 || $status >= 300) {
            $decoded = json_decode(is_string($responseBody) ? $responseBody : '', true);
            $message = "GitHub HTTP {$status}";
            if (is_array($decoded) && isset($decoded['message'])) {
                $message .= ': ' . (string) $decoded['message'];
            }
            throw new RuntimeException($message);
        }

        return [
            'status' => $status,
            'workflow' => $workflow,
            'ref' => $config['ref'],
        ];
    }

    $ch = curl_init($url);
    if ($ch === false) {
        throw new RuntimeException('Unable to initialize GitHub request');
    }
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => 'POST',
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_HTTPHEADER => $httpHeaders,
    ]);

    $responseBody = curl_exec($ch);
    $error = curl_error($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($responseBody === false || $status < 200 || $status >= 300) {
        $message = $error !== '' ? $error : "GitHub HTTP {$status}";
        $decoded = json_decode(is_string($responseBody) ? $responseBody : '', true);
        if (is_array($decoded) && isset($decoded['message'])) {
            $message .= ': ' . (string) $decoded['message'];
        }
        throw new RuntimeException($message);
    }

    return [
        'status' => $status,
        'workflow' => $workflow,
        'ref' => $config['ref'],
    ];
}

try {
    $action = $_GET['action'] ?? 'markets';

    if ($action === 'live-sync') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond(['ok' => false, 'error' => 'POST is required'], 405);
        }

        $minSeconds = max(30, min(900, (int) ($_GET['minSeconds'] ?? 60)));
        $ageSeconds = live_state_age_seconds();
        $lockPath = __DIR__ . '/data/.live-sync-request.json';
        $lastRequest = null;
        if (is_file($lockPath)) {
            $rawLock = file_get_contents($lockPath);
            $lockData = json_decode(is_string($rawLock) ? $rawLock : '', true);
            $lastRequest = is_array($lockData) ? (int) ($lockData['requestedAt'] ?? 0) : null;
        }

        $recentRequest = $lastRequest !== null && time() - $lastRequest < $minSeconds;
        if ($recentRequest) {
            respond([
                'ok' => true,
                'target' => 'live-sync',
                'action' => 'SKIP',
                'reason' => 'live sync was requested recently',
                'ageSeconds' => $ageSeconds,
                'minSeconds' => $minSeconds,
                'generatedAt' => gmdate('c'),
            ]);
        }

        $result = dispatch_workflow('trading-live-account.yml', [], false);
        @file_put_contents($lockPath, json_encode([
            'requestedAt' => time(),
            'generatedAt' => gmdate('c'),
            'workflow' => $result['workflow'],
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        respond([
            'ok' => true,
            'target' => 'live-sync',
            'action' => 'DISPATCH',
            'message' => 'Live account sync workflow dispatched.',
            'workflow' => $result['workflow'],
            'ref' => $result['ref'],
            'ageSeconds' => $ageSeconds,
            'minSeconds' => $minSeconds,
            'generatedAt' => gmdate('c'),
        ], $result['status'] === 204 ? 202 : 200);
    }

    if ($action === 'workflow') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond(['ok' => false, 'error' => 'POST is required'], 405);
        }

        $payload = request_payload();
        $target = (string) ($payload['target'] ?? '');
        $workflows = [
            'paper' => [
                'workflow' => 'trading-paper-bot.yml',
                'inputs' => ['mode' => 'full'],
                'message' => 'Paper bot workflow dispatched.',
            ],
            'live' => [
                'workflow' => 'polymarket-live-limit-order-test.yml',
                'inputs' => ['live_confirm' => true],
                'message' => 'Live one-time execution workflow dispatched.',
            ],
        ];

        if (!isset($workflows[$target])) {
            respond(['ok' => false, 'error' => 'Unknown workflow target'], 400);
        }

        $result = dispatch_workflow($workflows[$target]['workflow'], $workflows[$target]['inputs'], false);
        respond([
            'ok' => true,
            'target' => $target,
            'message' => $workflows[$target]['message'],
            'workflow' => $result['workflow'],
            'ref' => $result['ref'],
            'generatedAt' => gmdate('c'),
        ], $result['status'] === 204 ? 202 : 200);
    }

    if ($action === 'state') {
        $target = (string) ($_GET['target'] ?? '');
        respond(state_payload($target));
    }

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
                'orderPriceMinTickSize' => $market['orderPriceMinTickSize'] ?? '0.01',
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
