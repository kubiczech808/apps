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

    $lastError = 'State file contains invalid JSON';
    for ($attempt = 0; $attempt < 4; $attempt++) {
        clearstatcache(true, $path);
        $raw = @file_get_contents($path);
        if ($raw === false) {
            $lastError = 'State file could not be read';
        } else {
            $data = json_decode($raw, true);
            if (is_array($data)) {
                return $data;
            }
            $lastError = 'State file contains invalid JSON';
        }
        usleep(150000);
    }

    respond(['ok' => false, 'error' => $lastError], 502);
}

function default_portfolio_config(): array
{
    return [
        'paper' => [
            'conservative' => [
                'minProbability' => 0.95,
                'maxOrderFraction' => 0.05,
                'maxResolutionDays' => 7,
                'selectionOrder' => 'highest_ev_pa_first',
                'minLiquidityUsdc' => null,
                'tradeCadenceHours' => 1,
                'requireMostProbableOutcome' => false,
            ],
            'highReward' => [
                'minProbability' => 0.6,
                'maxOrderFraction' => 0.05,
                'maxResolutionDays' => 7,
                'selectionOrder' => 'highest_reward_risk_first',
                'minLiquidityUsdc' => null,
                'tradeCadenceHours' => 1,
                'requireMostProbableOutcome' => false,
            ],
            'moreProbable' => [
                'minProbability' => 0.6,
                'maxOrderFraction' => 0.05,
                'maxResolutionDays' => 7,
                'selectionOrder' => 'highest_reward_risk_first',
                'minLiquidityUsdc' => 500000,
                'tradeCadenceHours' => 1,
                'requireMostProbableOutcome' => true,
            ],
        ],
        'live' => [
            'minProbability' => 0.95,
            'maxOrderFraction' => 0.05,
            'maxResolutionDays' => 7,
            'selectionOrder' => 'highest_ev_pa_first',
            'minLiquidityUsdc' => 100,
            'tradeCadenceHours' => 24,
            'useLimitOrders' => true,
            'requireMostProbableOutcome' => false,
        ],
        'system' => [
            'crossLivePortfolioRiskDiversification' => true,
        ],
    ];
}

function portfolio_config_path(): string
{
    return __DIR__ . '/data/portfolio-config.json';
}

function normalize_probability_value(mixed $value, float $fallback): float
{
    if (!is_numeric($value)) {
        return $fallback;
    }
    $probability = (float) $value;
    if ($probability > 1) {
        $probability /= 100;
    }
    return max(0.01, min(0.99, $probability));
}

function normalize_fraction_value(mixed $value, float $fallback): float
{
    if (!is_numeric($value)) {
        return $fallback;
    }
    $fraction = (float) $value;
    if ($fraction > 1) {
        $fraction /= 100;
    }
    return max(0.01, min(0.5, $fraction));
}

function normalize_optional_days_value(mixed $value): ?int
{
    if ($value === null || $value === '') {
        return null;
    }
    if (!is_numeric($value)) {
        return null;
    }
    return max(1, min(365, (int) round((float) $value)));
}

function normalize_days_value(mixed $value, int $fallback): int
{
    return normalize_optional_days_value($value) ?? max(1, min(365, $fallback));
}

function normalize_optional_money_value(mixed $value): ?float
{
    if ($value === null || $value === '') {
        return null;
    }
    if (!is_numeric($value)) {
        return null;
    }
    return max(0.0, round((float) $value, 2));
}

function normalize_cadence_hours_value(mixed $value, int $fallback): int
{
    if (!is_numeric($value)) {
        return max(1, min(168, $fallback));
    }
    return max(1, min(168, (int) round((float) $value)));
}

function normalize_selection_order_value(mixed $value): string
{
    return $value === 'highest_reward_risk_first' ? 'highest_reward_risk_first' : 'highest_ev_pa_first';
}

function normalize_strategy_config(array $input, array $defaults): array
{
    return [
        'minProbability' => normalize_probability_value($input['minProbability'] ?? null, (float) $defaults['minProbability']),
        'maxOrderFraction' => normalize_fraction_value($input['maxOrderFraction'] ?? null, (float) $defaults['maxOrderFraction']),
        'maxResolutionDays' => normalize_days_value($input['maxResolutionDays'] ?? null, (int) $defaults['maxResolutionDays']),
        'selectionOrder' => normalize_selection_order_value($input['selectionOrder'] ?? $defaults['selectionOrder']),
        'minLiquidityUsdc' => normalize_optional_money_value($input['minLiquidityUsdc'] ?? $defaults['minLiquidityUsdc']),
        'tradeCadenceHours' => normalize_cadence_hours_value($input['tradeCadenceHours'] ?? null, (int) $defaults['tradeCadenceHours']),
        'requireMostProbableOutcome' => (bool) ($input['requireMostProbableOutcome'] ?? $defaults['requireMostProbableOutcome']),
    ];
}

function normalize_portfolio_config(array $input): array
{
    $defaults = default_portfolio_config();
    $paperInput = is_array($input['paper'] ?? null) ? $input['paper'] : [];
    $liveInput = is_array($input['live'] ?? null) ? $input['live'] : [];
    $systemInput = is_array($input['system'] ?? null) ? $input['system'] : [];
    $config = $defaults;
    foreach ($defaults['paper'] as $id => $strategyDefaults) {
        $strategyInput = is_array($paperInput[$id] ?? null) ? $paperInput[$id] : [];
        $config['paper'][$id] = normalize_strategy_config($strategyInput, $strategyDefaults);
    }
    $config['live'] = normalize_strategy_config($liveInput, $defaults['live']);
    $config['live']['useLimitOrders'] = (bool) ($liveInput['useLimitOrders'] ?? $defaults['live']['useLimitOrders']);
    $config['system'] = [
        'crossLivePortfolioRiskDiversification' => (bool) ($systemInput['crossLivePortfolioRiskDiversification'] ?? $defaults['system']['crossLivePortfolioRiskDiversification']),
    ];
    return $config;
}

function load_portfolio_config(): array
{
    $path = portfolio_config_path();
    if (!is_file($path)) {
        return default_portfolio_config();
    }
    $raw = file_get_contents($path);
    $data = json_decode(is_string($raw) ? $raw : '', true);
    return normalize_portfolio_config(is_array($data) ? $data : []);
}

function save_portfolio_config(array $config): array
{
    $normalized = normalize_portfolio_config($config);
    $path = portfolio_config_path();
    $dir = dirname($path);
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
        respond(['ok' => false, 'error' => 'Unable to create data directory'], 500);
    }
    $encoded = json_encode($normalized, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if (!is_string($encoded) || file_put_contents($path, $encoded . "\n", LOCK_EX) === false) {
        respond(['ok' => false, 'error' => 'Unable to persist portfolio config'], 500);
    }
    return $normalized;
}

function live_state_path(): string
{
    return __DIR__ . '/data/live-state.json';
}

function money_text($value): string
{
    if (!is_numeric($value)) {
        return '-';
    }

    return '$' . number_format((float) $value, 2, '.', ',');
}

function percent_text($value): string
{
    if (!is_numeric($value)) {
        return '-';
    }

    return number_format(((float) $value) * 100, 1, '.', ',') . '%';
}

function send_redeem_alert_email(array $alert): bool
{
    if (!function_exists('mail')) {
        throw new RuntimeException('PHP mail() is not available on this hosting.');
    }

    $recipient = 'jakub.elias88@gmail.com';
    $subject = 'Polymarket winning position / redeem alert';
    $type = (string) ($alert['type'] ?? '');
    $headline = $type === 'REDEEM_CONFIRMED'
        ? 'Vyherni Polymarket pozice byla nalezena jako redeemed.'
        : 'Polymarket pozice vypada jako vyherne vyhodnocena a muze vyzadovat manualni redeem.';
    $lines = [
        $headline,
        '',
        'Market: ' . (string) ($alert['question'] ?? '-'),
        'Outcome: ' . (string) ($alert['outcome'] ?? '-'),
        'URL: ' . (string) ($alert['url'] ?? 'https://polymarket.com/'),
        'Stake: ' . money_text($alert['stakeUsdc'] ?? null),
        'Current value: ' . money_text($alert['currentValueUsdc'] ?? null),
        'Realized P/L: ' . money_text($alert['realizedPnlUsdc'] ?? null),
        'Realized P/L %: ' . percent_text($alert['realizedPnlPct'] ?? null),
        'Reason: ' . (string) ($alert['reason'] ?? '-'),
        'Detected at: ' . (string) ($alert['detectedAt'] ?? gmdate('c')),
        '',
        'Pokud neni redeem automaticky proveden Polymarketem/API, otevri pozici a udelej redeem manualne.',
    ];
    $body = implode("\n", $lines);
    $headers = [
        'From: Trading Bot <noreply@osobnizkusenosti.cz>',
        'Reply-To: noreply@osobnizkusenosti.cz',
        'Content-Type: text/plain; charset=UTF-8',
        'X-Mailer: osobnizkusenosti.cz trading bot',
        'X-Auto-Response-Suppress: All',
    ];

    return mail($recipient, $subject, $body, implode("\r\n", $headers), '-f noreply@osobnizkusenosti.cz');
}

function redeem_alert_was_sent(array $alert, array $sentKeys): bool
{
    $key = (string) ($alert['key'] ?? '');
    $sentAt = trim((string) ($alert['sentAt'] ?? ''));
    if ($key === '' || $sentAt === '') {
        return false;
    }
    return !empty($alert['sent']) || isset($sentKeys[$key]);
}

function send_redeem_alerts(): array
{
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        respond(['ok' => false, 'error' => 'POST is required'], 405);
    }

    $path = live_state_path();
    if (!is_file($path)) {
        respond(['ok' => false, 'error' => 'Live state file is not available yet'], 404);
    }

    $raw = file_get_contents($path);
    $state = json_decode(is_string($raw) ? $raw : '', true);
    if (!is_array($state)) {
        respond(['ok' => false, 'error' => 'Live state file contains invalid JSON'], 502);
    }

    $notifications = is_array($state['notifications'] ?? null) ? $state['notifications'] : [];
    $alerts = is_array($notifications['redeemAlerts'] ?? null) ? $notifications['redeemAlerts'] : [];
    $sentKeys = [];
    foreach ((array) ($notifications['sentRedeemAlertKeys'] ?? []) as $key) {
        $sentKeys[(string) $key] = true;
    }

    $sent = [];
    $failed = [];
    foreach ($alerts as $index => $alert) {
        if (!is_array($alert)) {
            continue;
        }
        $key = (string) ($alert['key'] ?? '');
        if ($key === '' || redeem_alert_was_sent($alert, $sentKeys)) {
            continue;
        }
        $attemptAt = gmdate('c');
        if (!isset($alerts[$index]['emailAttempts']) || !is_array($alerts[$index]['emailAttempts'])) {
            $alerts[$index]['emailAttempts'] = [];
        }
        try {
            if (!send_redeem_alert_email($alert)) {
                throw new RuntimeException('PHP mail() returned false.');
            }
            $sentKeys[$key] = true;
            $alerts[$index]['sent'] = true;
            $alerts[$index]['sentAt'] = $attemptAt;
            $alerts[$index]['emailAttempts'][] = [
                'attemptedAt' => $attemptAt,
                'status' => 'sent',
            ];
            $sent[] = [
                'key' => $key,
                'type' => (string) ($alert['type'] ?? ''),
                'question' => (string) ($alert['question'] ?? ''),
                'sentAt' => $alerts[$index]['sentAt'],
            ];
        } catch (Throwable $e) {
            $alerts[$index]['sent'] = false;
            $alerts[$index]['emailAttempts'][] = [
                'attemptedAt' => $attemptAt,
                'status' => 'failed',
                'error' => $e->getMessage(),
            ];
            $failed[] = [
                'key' => $key,
                'error' => $e->getMessage(),
            ];
        }
    }

    $notifications['redeemAlerts'] = $alerts;
    $notifications['unsentRedeemAlerts'] = array_values(array_filter(
        $alerts,
        static fn ($alert): bool => is_array($alert) && empty($alert['sent'])
    ));
    $confirmedSentKeys = [];
    foreach ($alerts as $alert) {
        if (!is_array($alert) || !redeem_alert_was_sent($alert, $sentKeys)) {
            continue;
        }
        $confirmedSentKeys[(string) $alert['key']] = true;
    }
    $notifications['sentRedeemAlertKeys'] = array_keys($confirmedSentKeys);
    $notifications['lastEmailCheckAt'] = gmdate('c');
    $notifications['lastEmailSent'] = $sent;
    $notifications['lastEmailFailures'] = $failed;
    $state['notifications'] = $notifications;

    $encoded = json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if (!is_string($encoded) || file_put_contents($path, $encoded . "\n", LOCK_EX) === false) {
        respond(['ok' => false, 'error' => 'Unable to persist notification ledger'], 500);
    }

    return [
        'ok' => $failed === [],
        'generatedAt' => gmdate('c'),
        'recipient' => 'jakub.elias88@gmail.com',
        'checked' => count($alerts),
        'sentCount' => count($sent),
        'failedCount' => count($failed),
        'sent' => $sent,
        'failed' => $failed,
    ];
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

function github_json_request(string $url): array
{
    $config = app_config();
    if ($config['github_token'] === '') {
        respond([
            'ok' => false,
            'error' => 'GitHub workflow status is not configured on the server.',
            'requiredSecrets' => ['POLY_TRADING_GITHUB_TOKEN'],
        ], 503);
    }

    $headers = [
        'Accept: application/vnd.github+json',
        'Authorization: Bearer ' . $config['github_token'],
        'User-Agent: osobnizkusenosti-trading-trigger',
        'X-GitHub-Api-Version: 2022-11-28',
    ];

    if (!function_exists('curl_init')) {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'header' => implode("\r\n", $headers) . "\r\n",
                'timeout' => 20,
                'ignore_errors' => true,
            ],
        ]);
        $body = @file_get_contents($url, false, $context);
        $status = 0;
        foreach ($http_response_header ?? [] as $header) {
            if (preg_match('/^HTTP\/\S+\s+(\d{3})/', $header, $matches)) {
                $status = (int) $matches[1];
            }
        }
        if ($body === false || $status < 200 || $status >= 300) {
            throw new RuntimeException("GitHub HTTP {$status}");
        }
        $decoded = json_decode($body, true);
        if (!is_array($decoded)) {
            throw new RuntimeException('GitHub returned invalid JSON');
        }
        return $decoded;
    }

    $ch = curl_init($url);
    if ($ch === false) {
        throw new RuntimeException('Unable to initialize GitHub request');
    }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_HTTPHEADER => $headers,
    ]);
    $body = curl_exec($ch);
    $error = curl_error($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($body === false || $status < 200 || $status >= 300) {
        throw new RuntimeException($error !== '' ? $error : "GitHub HTTP {$status}");
    }
    $decoded = json_decode(is_string($body) ? $body : '', true);
    if (!is_array($decoded)) {
        throw new RuntimeException('GitHub returned invalid JSON');
    }
    return $decoded;
}

function workflow_status_payload(string $target): array
{
    $config = app_config();
    $workflows = [
        'paper' => 'trading-paper-bot.yml',
        'live' => 'polymarket-live-limit-order-test.yml',
        'live-sync' => 'trading-live-account.yml',
    ];
    if (!isset($workflows[$target])) {
        respond(['ok' => false, 'error' => 'Unknown workflow target'], 400);
    }

    $workflow = $workflows[$target];
    $url = sprintf(
        'https://api.github.com/repos/%s/actions/workflows/%s/runs?%s',
        rawurlencode($config['repo']),
        rawurlencode($workflow),
        http_build_query([
            'branch' => $config['ref'],
            'event' => 'workflow_dispatch',
            'per_page' => 5,
        ])
    );
    $url = str_replace('%2F', '/', $url);
    $payload = github_json_request($url);
    $since = strtotime((string) ($_GET['since'] ?? '')) ?: 0;
    $runs = [];
    foreach (($payload['workflow_runs'] ?? []) as $run) {
        if (!is_array($run)) {
            continue;
        }
        $created = strtotime((string) ($run['created_at'] ?? '')) ?: 0;
        if ($since > 0 && $created > 0 && $created + 120 < $since) {
            continue;
        }
        $runs[] = [
            'id' => $run['id'] ?? null,
            'name' => $run['name'] ?? '',
            'event' => $run['event'] ?? '',
            'status' => $run['status'] ?? '',
            'conclusion' => $run['conclusion'] ?? null,
            'createdAt' => $run['created_at'] ?? null,
            'updatedAt' => $run['updated_at'] ?? null,
            'htmlUrl' => $run['html_url'] ?? null,
        ];
    }

    return [
        'ok' => true,
        'target' => $target,
        'workflow' => $workflow,
        'generatedAt' => gmdate('c'),
        'runs' => $runs,
        'latest' => $runs[0] ?? null,
    ];
}

function normalized_probability_input($value): ?string
{
    if (!is_numeric($value)) {
        return null;
    }
    $probability = (float) $value;
    if ($probability > 1) {
        $probability /= 100;
    }
    if ($probability < 0.01 || $probability > 1) {
        return null;
    }
    return rtrim(rtrim(number_format($probability, 4, '.', ''), '0'), '.');
}

function normalized_fraction_input($value): ?string
{
    if (!is_numeric($value)) {
        return null;
    }
    $fraction = (float) $value;
    if ($fraction > 1) {
        $fraction /= 100;
    }
    if ($fraction < 0.01 || $fraction > 0.50) {
        return null;
    }
    return rtrim(rtrim(number_format($fraction, 4, '.', ''), '0'), '.');
}

function normalized_days_input($value): ?string
{
    if ($value === null || $value === '') {
        return null;
    }
    if (!is_numeric($value)) {
        return null;
    }
    $days = max(1, min(365, (int) round((float) $value)));
    return (string) $days;
}

function normalized_money_input($value): ?string
{
    if ($value === null || $value === '') {
        return null;
    }
    if (!is_numeric($value)) {
        return null;
    }
    $money = max(0.0, (float) $value);
    return rtrim(rtrim(number_format($money, 2, '.', ''), '0'), '.');
}

function normalized_bool_input($value): ?string
{
    if ($value === null) {
        return null;
    }
    if (is_bool($value)) {
        return $value ? 'true' : 'false';
    }
    $text = strtolower((string) $value);
    if (in_array($text, ['1', 'true', 'yes', 'on'], true)) {
        return 'true';
    }
    if (in_array($text, ['0', 'false', 'no', 'off'], true)) {
        return 'false';
    }
    return null;
}

function normalized_selection_order_input($value): ?string
{
    if ($value === null || $value === '') {
        return null;
    }
    return $value === 'highest_reward_risk_first' ? 'highest_reward_risk_first' : 'highest_ev_pa_first';
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
        $liveMinProbability = normalized_probability_input($payload['min_probability'] ?? $payload['live_min_probability'] ?? null);
        $paperConservativeMinProbability = normalized_probability_input($payload['paper_conservative_min_probability'] ?? null);
        $paperHighRewardMinProbability = normalized_probability_input($payload['paper_high_reward_min_probability'] ?? null);
        $paperMoreProbableMinProbability = normalized_probability_input($payload['paper_more_probable_min_probability'] ?? null);
        $liveMaxOrderFraction = normalized_fraction_input($payload['max_order_fraction'] ?? $payload['live_max_order_fraction'] ?? null);
        $paperMaxOrderFraction = normalized_fraction_input($payload['max_order_fraction'] ?? $payload['paper_max_order_fraction'] ?? null);
        $liveMaxResolutionDays = normalized_days_input($payload['maxResolutionDays'] ?? $payload['live_max_resolution_days'] ?? null);
        $liveSelectionOrder = normalized_selection_order_input($payload['selectionOrder'] ?? $payload['live_selection_order'] ?? null);
        $liveMinLiquidity = normalized_money_input($payload['minLiquidityUsdc'] ?? $payload['live_min_liquidity_usdc'] ?? null);
        $liveTradeCadenceHours = normalized_days_input($payload['tradeCadenceHours'] ?? $payload['live_trade_cadence_hours'] ?? null);
        $liveUseLimitOrders = normalized_bool_input($payload['useLimitOrders'] ?? $payload['use_limit_orders'] ?? null);
        $crossLiveRiskDiversification = normalized_bool_input($payload['cross_live_portfolio_risk_diversification'] ?? $payload['crossLivePortfolioRiskDiversification'] ?? null);
        $paperStrategies = ['conservative', 'high_reward', 'more_probable'];
        $paperExtraInputs = [];
        foreach ($paperStrategies as $strategy) {
            $paperExtraInputs["paper_{$strategy}_max_order_fraction"] = normalized_fraction_input($payload["paper_{$strategy}_max_order_fraction"] ?? null);
            $paperExtraInputs["paper_{$strategy}_max_resolution_days"] = normalized_days_input($payload["paper_{$strategy}_max_resolution_days"] ?? null);
            $paperExtraInputs["paper_{$strategy}_selection_order"] = normalized_selection_order_input($payload["paper_{$strategy}_selection_order"] ?? null);
            $paperExtraInputs["paper_{$strategy}_min_liquidity_usdc"] = normalized_money_input($payload["paper_{$strategy}_min_liquidity_usdc"] ?? null);
            $paperExtraInputs["paper_{$strategy}_trade_cadence_hours"] = normalized_days_input($payload["paper_{$strategy}_trade_cadence_hours"] ?? null);
            $paperExtraInputs["paper_{$strategy}_require_most_probable"] = normalized_bool_input($payload["paper_{$strategy}_require_most_probable"] ?? null);
        }
        $workflows = [
            'paper' => [
                'workflow' => 'trading-paper-bot.yml',
                'inputs' => array_filter(array_merge([
                    'mode' => 'full',
                    'paper_max_order_fraction' => $paperMaxOrderFraction,
                    'paper_conservative_min_probability' => $paperConservativeMinProbability,
                    'paper_high_reward_min_probability' => $paperHighRewardMinProbability,
                    'paper_more_probable_min_probability' => $paperMoreProbableMinProbability,
                ], $paperExtraInputs), static fn ($value): bool => $value !== null),
                'message' => 'Paper bot workflow dispatched.',
            ],
            'live' => [
                'workflow' => 'polymarket-live-limit-order-test.yml',
                'inputs' => array_filter([
                    'live_confirm' => true,
                    'live_min_probability' => $liveMinProbability,
                    'live_max_order_fraction' => $liveMaxOrderFraction,
                    'live_max_resolution_days' => $liveMaxResolutionDays,
                    'live_selection_order' => $liveSelectionOrder,
                    'live_min_liquidity_usdc' => $liveMinLiquidity,
                    'live_trade_cadence_hours' => $liveTradeCadenceHours,
                    'live_use_limit_orders' => $liveUseLimitOrders,
                    'cross_live_portfolio_risk_diversification' => $crossLiveRiskDiversification,
                ], static fn ($value): bool => $value !== null),
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

    if ($action === 'portfolio-config') {
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $payload = request_payload();
            $config = is_array($payload['config'] ?? null) ? $payload['config'] : $payload;
            $saved = save_portfolio_config($config);
            respond([
                'ok' => true,
                'config' => $saved,
                'generatedAt' => gmdate('c'),
            ]);
        }
        respond([
            'ok' => true,
            'config' => load_portfolio_config(),
            'generatedAt' => gmdate('c'),
        ]);
    }

    if ($action === 'workflow-status') {
        $target = (string) ($_GET['target'] ?? '');
        respond(workflow_status_payload($target));
    }

    if ($action === 'send-redeem-alerts') {
        respond(send_redeem_alerts());
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
