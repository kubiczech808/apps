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
    // FTP state replacement briefly removes the old file on hosts that do not
    // support an atomic overwrite. Give the upload a short window to finish
    // before reporting a real missing-state error to the browser.
    for ($attempt = 0; $attempt < 4 && !is_file($path); $attempt++) {
        usleep(250000);
        clearstatcache(true, $path);
    }
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

function compact_text(mixed $value, int $limit = 700): string
{
    $text = trim((string) ($value ?? ''));
    if ($text === '' || strlen($text) <= $limit) {
        return $text;
    }

    return rtrim(substr($text, 0, $limit - 3)) . '...';
}

function compact_evaluation(array $item): array
{
    $keys = [
        'id',
        'tokenId',
        'clobTokenId',
        'assetId',
        'marketId',
        'eventId',
        'question',
        'outcome',
        'slug',
        'eventSlug',
        'url',
        'status',
        'selectionStatus',
        'rejectReasons',
        'riskGroupKeys',
        'marketType',
        'category',
        'endDate',
        'scheduledEventDate',
        'resolutionEndDate',
        'endDateSource',
        'evaluatedAt',
        'firstEvaluatedAt',
        'lastSeenAt',
        'updatedAt',
        'resolvedAt',
        'aiProbability',
        'rawProbability',
        'marketProbability',
        'marketDataUpdatedAt',
        'marketPrice',
        'entryPrice',
        'askPrice',
        'bidPrice',
        'annualizedReturn',
        'aiAnnualizedReturn',
        'marketAnnualizedReturn',
        'annualizedNetReturn',
        'annualizedExpectedReturn',
        'expectedValueUsdc',
        'aiExpectedValueUsdc',
        'marketExpectedValueUsdc',
        'marketExpectedRoi',
        'netGainIfWinUsdc',
        'grossGainIfWinUsdc',
        'feeUsdc',
        'takerFeeUsdc',
        'stakeUsdc',
        'shares',
        'executableShares',
        'totalCostUsdc',
        'daysToResolution',
        'riskReward',
        'liquidity',
        'volume',
        'volume24hr',
        'edge',
        'thesisType',
        'analysisModel',
    ];
    $compact = [];
    foreach ($keys as $key) {
        if (array_key_exists($key, $item)) {
            $compact[$key] = $item[$key];
        }
    }

    $compact['analysisSummary'] = compact_text($item['analysisSummary'] ?? $item['probabilityThesis'] ?? '', 220);
    $compact['probabilityThesis'] = compact_text($item['probabilityThesis'] ?? '', 220);
    if (isset($item['aiAnalysis']) && is_array($item['aiAnalysis'])) {
        $compact['aiAnalysis'] = [
            'model' => $item['aiAnalysis']['model'] ?? ($item['analysisModel'] ?? null),
            'thesis' => compact_text($item['aiAnalysis']['thesis'] ?? '', 180),
            'aiModelStatus' => $item['aiAnalysis']['aiModelStatus'] ?? null,
        ];
    }

    return $compact;
}

function compact_market_observation(array $item): array
{
    $keys = [
        'id',
        'marketKey',
        'marketId',
        'conditionId',
        'assetId',
        'clobTokenId',
        'market',
        'question',
        'slug',
        'eventSlug',
        'outcome',
        'tokenId',
        'status',
        'selectionStatus',
        'marketType',
        'tags',
        'polymarketTags',
        'riskCategory',
        'riskPrimaryEntity',
        'riskGroupKeys',
        'riskGroupLabels',
        'rejectReasons',
        'marketPrice',
        'marketProbability',
        'binaryYesMarketProbability',
        'binaryNoMarketProbability',
        'outcomeCount',
        'endDate',
        'scheduledEventDate',
        'resolutionEndDate',
        'endDateSource',
        'resolvedAt',
        'resolvedDetectedAt',
        'resolutionStatus',
        'daysToResolution',
        'liquidity',
        'volume24hr',
        'stakeUsdc',
        'executableShares',
        'takerFeeUsdc',
        'totalCostUsdc',
        'netGainIfWinUsdc',
        'netYield',
        'riskReward',
        'potentialAnnualizedReturn',
        'marketExpectedValueUsdc',
        'marketExpectedRoi',
        'marketAnnualizedReturn',
        'annualizedReturn',
        'expectedValueUsdc',
        'feesEnabled',
        'feeType',
        'feeRate',
        'marketDataUpdatedAt',
        'observedAt',
        'firstObservedAt',
        'firstMarketProbability',
        'firstLiquidity',
        'firstVolume24hr',
        'firstDaysToResolution',
        'firstFeeRate',
        'firstOutcome',
        'firstTokenId',
        'firstCategory',
        'firstTags',
        'updatedAt',
        'orderPrice',
        'orderSize',
        'orderNotionalUsdc',
        'minOrderSize',
        'spread',
        'source',
    ];
    $compact = [];
    foreach ($keys as $key) {
        if (array_key_exists($key, $item)) {
            $compact[$key] = $item[$key];
        }
    }
    if (isset($item['executionRevalidation']) && is_array($item['executionRevalidation'])) {
        $compact['executionRevalidation'] = $item['executionRevalidation'];
    }

    return $compact;
}

function is_active_scraped_market_observation(array $item): bool
{
    $status = strtoupper((string) ($item['status'] ?? $item['selectionStatus'] ?? ''));
    if (in_array($status, ['RESOLVED', 'CLOSED', 'EXPIRED', 'FINALIZED', 'SETTLED'], true)) {
        return false;
    }
    $resolutionStatus = strtoupper((string) ($item['resolutionStatus'] ?? ''));
    if (in_array($resolutionStatus, ['PENDING_RESULT', 'FINAL_PRICE_AVAILABLE', 'NOT_ACCEPTING_ORDERS'], true)) {
        return false;
    }
    $probability = (float) ($item['marketProbability'] ?? 0);
    if ($probability < 0.5 || $probability >= 1) {
        return false;
    }
    $scheduledEvent = strtotime((string) ($item['scheduledEventDate'] ?? ''));
    if ($scheduledEvent !== false && $scheduledEvent <= time()) {
        return false;
    }
    $endDate = strtotime((string) ($item['endDate'] ?? $item['resolutionEndDate'] ?? ''));
    return $endDate === false || $endDate > time();
}

function compact_state_payload(string $target, array $data, string $summary): array
{
    if ($target !== 'paper') {
        return $data;
    }

    if ($summary === 'dashboard') {
        $compact = $data;
        $compact['evaluations'] = [];
        unset($compact['evaluationRunLog'], $compact['calculationReports'], $compact['runLog'], $compact['marketObservations'], $compact['marketScan']);
        $compact['evaluationDetailsMode'] = 'dashboard';
        return $compact;
    }

    if ($summary === 'candidates') {
        $evaluations = is_array($data['evaluations'] ?? null) ? $data['evaluations'] : [];
        $compact = [
            'schemaVersion' => $data['schemaVersion'] ?? null,
            'generatedAt' => $data['generatedAt'] ?? null,
        ];
        $compact['evaluations'] = array_map(
            static fn($item): array => is_array($item) ? compact_evaluation($item) : [],
            array_values(array_filter($evaluations, 'is_array'))
        );
        // Keep this response focused on stored AI evaluations. Polymarket
        // portfolios use the lighter `execution` summary below for quotes.
        $compact['evaluationDetailsMode'] = 'compact';
        return $compact;
    }

    if ($summary === 'execution') {
        $observations = is_array($data['marketObservations'] ?? null) ? $data['marketObservations'] : [];
        $active = array_values(array_filter($observations, static fn($item): bool => is_array($item) && is_active_scraped_market_observation($item)));
        return [
            'schemaVersion' => $data['schemaVersion'] ?? null,
            'generatedAt' => $data['generatedAt'] ?? null,
            'marketObservations' => array_map(
                static fn($item): array => is_array($item) ? compact_market_observation($item) : [],
                $active
            ),
            'marketDetailsMode' => 'compact',
        ];
    }

    if ($summary === 'scraped') {
        $observations = is_array($data['marketObservations'] ?? null) ? $data['marketObservations'] : [];
        $active = array_values(array_filter($observations, static fn($item): bool => is_array($item) && is_active_scraped_market_observation($item)));
        $scanHistory = is_array($data['marketScanHistory'] ?? null)
            ? array_slice(array_values(array_filter($data['marketScanHistory'], 'is_array')), 0, 200)
            : [];
        // Full audit rows can contain hundreds of markets. The log list only
        // needs scan summaries; the browser fetches a selected run's audit on
        // demand through action=scan-audit.
        $scanHistory = array_map(static function (array $item): array {
            unset($item['audit']);
            return $item;
        }, $scanHistory);
        return [
            'schemaVersion' => $data['schemaVersion'] ?? null,
            'generatedAt' => $data['generatedAt'] ?? null,
            'marketObservations' => array_map(
                static fn($item): array => is_array($item) ? compact_market_observation($item) : [],
                $active
            ),
            'marketScan' => is_array($data['marketScan'] ?? null) ? $data['marketScan'] : [],
            'marketScanHistory' => $scanHistory,
            'marketDetailsMode' => 'compact',
        ];
    }

    // A focused scraped-market refresh must merge one updated quote into the
    // complete persisted market set. This worker-only summary avoids dropping
    // the retained observations that are omitted from normal dashboard reads.
    if ($summary === 'refresh') {
        return $data;
    }

    // Raw market observations can contain thousands of rows. They are exposed
    // only through the lazy `scraped` summary used by the opportunities log.
    $compact = $data;
    unset($compact['marketObservations'], $compact['marketScan']);
    return $compact;
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
                'minNetYield' => 0.0,
                'executionTrigger' => 'cron',
                'requireMostProbableOutcome' => false,
                'probabilitySource' => 'ai',
                'excludedCandidateTokenIds' => [],
            ],
            'highReward' => [
                'minProbability' => 0.6,
                'maxOrderFraction' => 0.05,
                'maxResolutionDays' => 7,
                'selectionOrder' => 'highest_reward_risk_first',
                'minLiquidityUsdc' => null,
                'minNetYield' => 0.0,
                'executionTrigger' => 'cron',
                'requireMostProbableOutcome' => false,
                'probabilitySource' => 'ai',
                'excludedCandidateTokenIds' => [],
            ],
            'moreProbable' => [
                'minProbability' => 0.6,
                'maxOrderFraction' => 0.05,
                'maxResolutionDays' => 7,
                'selectionOrder' => 'highest_reward_risk_first',
                'minLiquidityUsdc' => 500000,
                'minNetYield' => 0.0,
                'executionTrigger' => 'cron',
                'requireMostProbableOutcome' => true,
                'probabilitySource' => 'ai',
                'excludedCandidateTokenIds' => [],
            ],
        ],
        'live' => [
            'minProbability' => 0.95,
            'maxOrderFraction' => 0.05,
            'maxResolutionDays' => 7,
            'selectionOrder' => 'highest_ev_pa_first',
            'minLiquidityUsdc' => 100,
            'minNetYield' => 0.0,
            'executionTrigger' => 'cron',
            'useLimitOrders' => true,
            'requireMostProbableOutcome' => false,
            'probabilitySource' => 'ai',
            'excludedCandidateTokenIds' => [],
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

function scan_preferences_path(): string
{
    return __DIR__ . '/data/scrape-scan-preferences.json';
}

function normalize_scan_liquidity_preference(mixed $value): float
{
    if (!is_numeric($value)) {
        return 0.0;
    }
    return max(0.0, min(1000000000.0, round((float) $value, 2)));
}

function normalize_scan_days_preference(mixed $value): ?float
{
    if ($value === null || $value === '' || !is_numeric($value)) {
        return null;
    }
    return max(0.0, min(3650.0, round((float) $value, 2)));
}

function load_scan_preferences(): array
{
    $path = scan_preferences_path();
    if (!is_file($path)) {
        return ['liquidityMin' => 0.0, 'maxDays' => 7.0];
    }
    $raw = file_get_contents($path);
    $data = json_decode(is_string($raw) ? $raw : '', true);
    return [
        'liquidityMin' => normalize_scan_liquidity_preference(is_array($data) ? ($data['liquidityMin'] ?? 0) : 0),
        'maxDays' => normalize_scan_days_preference(
            is_array($data) && array_key_exists('maxDays', $data) ? $data['maxDays'] : 7
        ),
    ];
}

function save_scan_preferences(array $input): array
{
    $preferences = [
        'liquidityMin' => normalize_scan_liquidity_preference($input['liquidityMin'] ?? $input['liquidity_min'] ?? 0),
        'maxDays' => normalize_scan_days_preference($input['maxDays'] ?? $input['market_scan_max_days'] ?? null),
        'updatedAt' => gmdate('c'),
    ];
    $path = scan_preferences_path();
    $dir = dirname($path);
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
        respond(['ok' => false, 'error' => 'Unable to create data directory'], 500);
    }
    $encoded = json_encode($preferences, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if (!is_string($encoded) || file_put_contents($path, $encoded . "\n", LOCK_EX) === false) {
        respond(['ok' => false, 'error' => 'Unable to persist scraping preferences'], 500);
    }
    return $preferences;
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

function normalize_net_yield_value(mixed $value, float $fallback): float
{
    if (!is_numeric($value)) {
        return $fallback;
    }
    $yield = (float) $value;
    if ($yield > 1) {
        $yield /= 100;
    }
    return max(0.0, min(10.0, round($yield, 3)));
}

function normalize_selection_order_value(mixed $value): string
{
    return $value === 'highest_reward_risk_first' ? 'highest_reward_risk_first' : 'highest_ev_pa_first';
}

function normalize_probability_source_value(mixed $value): string
{
    return $value === 'polymarket' ? 'polymarket' : 'ai';
}

function normalize_execution_trigger_value(mixed $value): string
{
    return $value === 'after_scrape' ? 'after_scrape' : 'cron';
}

function normalize_excluded_candidate_token_ids(mixed $value): array
{
    if (!is_array($value)) {
        return [];
    }
    $tokens = [];
    foreach ($value as $candidate) {
        $token = trim((string) $candidate);
        if (!preg_match('/^\d{8,100}$/', $token) || isset($tokens[$token])) {
            continue;
        }
        $tokens[$token] = true;
        if (count($tokens) >= 500) {
            break;
        }
    }
    return array_keys($tokens);
}

function normalize_strategy_config(array $input, array $defaults): array
{
    return [
        'minProbability' => normalize_probability_value($input['minProbability'] ?? null, (float) $defaults['minProbability']),
        'maxOrderFraction' => normalize_fraction_value($input['maxOrderFraction'] ?? null, (float) $defaults['maxOrderFraction']),
        'maxResolutionDays' => normalize_days_value($input['maxResolutionDays'] ?? null, (int) $defaults['maxResolutionDays']),
        'selectionOrder' => normalize_selection_order_value($input['selectionOrder'] ?? $defaults['selectionOrder']),
        'minLiquidityUsdc' => normalize_optional_money_value($input['minLiquidityUsdc'] ?? $defaults['minLiquidityUsdc']),
        'minNetYield' => normalize_net_yield_value($input['minNetYield'] ?? null, (float) $defaults['minNetYield']),
        'executionTrigger' => normalize_execution_trigger_value($input['executionTrigger'] ?? $defaults['executionTrigger']),
        'requireMostProbableOutcome' => (bool) ($input['requireMostProbableOutcome'] ?? $defaults['requireMostProbableOutcome']),
        'probabilitySource' => normalize_probability_source_value($input['probabilitySource'] ?? $defaults['probabilitySource']),
        'excludedCandidateTokenIds' => normalize_excluded_candidate_token_ids($input['excludedCandidateTokenIds'] ?? $defaults['excludedCandidateTokenIds'] ?? []),
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
    $subject = 'Polymarket: vyherni pozice ceka na redeem';
    $lines = [
        'Polymarket tuto pozici vyhodnotil jako vyherni. Prostredky zatim cekaji na manualni redeem.',
        '',
        'Market: ' . (string) ($alert['question'] ?? '-'),
        'Outcome: ' . (string) ($alert['outcome'] ?? '-'),
        'Status: Redeem required',
        'Polymarket position: ' . (string) ($alert['url'] ?? 'https://polymarket.com/'),
        'Portfolio position: ' . (string) ($alert['portfolioUrl'] ?? 'https://www.osobnizkusenosti.cz/trading/portfolios/closed/'),
        'Stake: ' . money_text($alert['stakeUsdc'] ?? null),
        'Current value: ' . money_text($alert['currentValueUsdc'] ?? null),
        'Reason: ' . (string) ($alert['reason'] ?? '-'),
        'Detected at: ' . (string) ($alert['detectedAt'] ?? gmdate('c')),
        '',
        'Otevri pozici v Polymarketu a proved redeem. Po potvrzeni se prostredky uvolni pro dalsi obchody.',
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

function redeem_alert_ledger_path(): string
{
    return __DIR__ . '/data/redeem-alert-ledger.json';
}

function with_redeem_alert_ledger(callable $callback): array
{
    $path = redeem_alert_ledger_path();
    $directory = dirname($path);
    if (!is_dir($directory) && !mkdir($directory, 0775, true) && !is_dir($directory)) {
        throw new RuntimeException('Unable to create redeem alert ledger directory.');
    }
    $handle = fopen($path, 'c+');
    if ($handle === false) {
        throw new RuntimeException('Unable to open redeem alert ledger.');
    }

    try {
        if (!flock($handle, LOCK_EX)) {
            throw new RuntimeException('Unable to lock redeem alert ledger.');
        }
        rewind($handle);
        $raw = stream_get_contents($handle);
        $decoded = json_decode(is_string($raw) ? $raw : '', true);
        $ledger = is_array($decoded) ? $decoded : [];
        if (!is_array($ledger['sent'] ?? null)) {
            $ledger['sent'] = [];
        }

        $result = $callback($ledger);
        $ledger['version'] = 1;
        $ledger['updatedAt'] = gmdate('c');
        $encoded = json_encode($ledger, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($encoded)) {
            throw new RuntimeException('Unable to encode redeem alert ledger.');
        }
        rewind($handle);
        if (!ftruncate($handle, 0) || fwrite($handle, $encoded . "\n") === false || !fflush($handle)) {
            throw new RuntimeException('Unable to persist redeem alert ledger.');
        }
        flock($handle, LOCK_UN);
        fclose($handle);
        return is_array($result) ? $result : [];
    } catch (Throwable $e) {
        flock($handle, LOCK_UN);
        fclose($handle);
        throw $e;
    }
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
    if (strtoupper((string) ($state['mode'] ?? '')) !== 'LIVE') {
        respond(['ok' => true, 'skipped' => 'Redeem emails are only enabled for the live Polymarket account.']);
    }

    $notifications = is_array($state['notifications'] ?? null) ? $state['notifications'] : [];
    $alerts = is_array($notifications['redeemAlerts'] ?? null) ? $notifications['redeemAlerts'] : [];
    $legacySentKeys = [];
    foreach ((array) ($notifications['sentRedeemAlertKeys'] ?? []) as $key) {
        $legacySentKeys[(string) $key] = true;
    }

    $delivery = with_redeem_alert_ledger(function (array &$ledger) use (&$alerts, $legacySentKeys): array {
        $sent = [];
        $failed = [];
        $skipped = 0;
        $sentMap = is_array($ledger['sent'] ?? null) ? $ledger['sent'] : [];
        foreach ($alerts as $index => $alert) {
            if (!is_array($alert) || (string) ($alert['type'] ?? '') !== 'REDEEM_REQUIRED') {
                $skipped++;
                continue;
            }
            $key = (string) ($alert['key'] ?? '');
            if ($key === '') {
                $skipped++;
                continue;
            }
            $previousSentAt = trim((string) ($sentMap[$key] ?? ''));
            if ($previousSentAt !== '' || isset($legacySentKeys[$key]) || redeem_alert_was_sent($alert, $legacySentKeys)) {
                $alerts[$index]['sent'] = true;
                $alerts[$index]['sentAt'] = $previousSentAt !== '' ? $previousSentAt : (string) ($alert['sentAt'] ?? gmdate('c'));
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
                $sentMap[$key] = $attemptAt;
                $alerts[$index]['sent'] = true;
                $alerts[$index]['sentAt'] = $attemptAt;
                $alerts[$index]['emailAttempts'][] = [
                    'attemptedAt' => $attemptAt,
                    'status' => 'sent',
                ];
                $sent[] = [
                    'key' => $key,
                    'type' => 'REDEEM_REQUIRED',
                    'question' => (string) ($alert['question'] ?? ''),
                    'sentAt' => $attemptAt,
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
        $ledger['sent'] = $sentMap;
        return ['sent' => $sent, 'failed' => $failed, 'skippedCount' => $skipped];
    });
    $sent = $delivery['sent'] ?? [];
    $failed = $delivery['failed'] ?? [];

    $notifications['redeemAlerts'] = $alerts;
    $notifications['unsentRedeemAlerts'] = array_values(array_filter(
        $alerts,
        static fn ($alert): bool => is_array($alert) && (string) ($alert['type'] ?? '') === 'REDEEM_REQUIRED' && empty($alert['sent'])
    ));
    $confirmedSentKeys = [];
    foreach ($alerts as $alert) {
        if (!is_array($alert) || (string) ($alert['type'] ?? '') !== 'REDEEM_REQUIRED' || empty($alert['sent'])) {
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
        'skippedCount' => (int) ($delivery['skippedCount'] ?? 0),
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

function workflow_failure_detail(array $run, array $config): ?string
{
    $runId = (int) ($run['id'] ?? 0);
    $conclusion = strtolower((string) ($run['conclusion'] ?? ''));
    if ($runId <= 0 || $conclusion === '' || $conclusion === 'success') {
        return null;
    }

    $url = sprintf(
        'https://api.github.com/repos/%s/actions/runs/%d/jobs?per_page=100',
        rawurlencode($config['repo']),
        $runId
    );
    $url = str_replace('%2F', '/', $url);
    try {
        $payload = github_json_request($url);
    } catch (Throwable $e) {
        return null;
    }

    foreach (($payload['jobs'] ?? []) as $job) {
        if (!is_array($job) || strtolower((string) ($job['conclusion'] ?? '')) === 'success') {
            continue;
        }
        $jobName = trim((string) ($job['name'] ?? 'GitHub Actions job'));
        foreach (($job['steps'] ?? []) as $step) {
            if (!is_array($step) || strtolower((string) ($step['conclusion'] ?? '')) === 'success') {
                continue;
            }
            $stepName = trim((string) ($step['name'] ?? 'unnamed step'));
            $stepConclusion = trim((string) ($step['conclusion'] ?? 'failed'));
            return "{$jobName}: {$stepName} ({$stepConclusion})";
        }
        return $jobName . ' (' . (string) ($job['conclusion'] ?? 'failed') . ')';
    }
    return null;
}

function workflow_status_payload(string $target): array
{
    $config = app_config();
    $targetKey = workflow_target_key($target);
    $workflows = [
        'paper' => 'trading-paper-bot.yml',
        'paper-scan' => 'trading-market-scan.yml',
        'paper-evaluation' => 'trading-paper-evaluation.yml',
        'paper-refresh' => 'trading-paper-bot.yml',
        'live' => 'polymarket-live-limit-order-test.yml',
        'live-sync' => 'trading-live-account.yml',
    ];
    if (!isset($workflows[$targetKey])) {
        respond(['ok' => false, 'error' => 'Unknown workflow target'], 400);
    }

    $workflow = $workflows[$targetKey];
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
    $rawRunsById = [];
    foreach (($payload['workflow_runs'] ?? []) as $run) {
        if (!is_array($run)) {
            continue;
        }
        $created = strtotime((string) ($run['created_at'] ?? '')) ?: 0;
        if ($since > 0 && $created > 0 && $created + 120 < $since) {
            continue;
        }
        $rawRunsById[(string) ($run['id'] ?? '')] = $run;
        $runs[] = [
            'id' => $run['id'] ?? null,
            'name' => $run['name'] ?? '',
            'displayTitle' => $run['display_title'] ?? '',
            'event' => $run['event'] ?? '',
            'status' => $run['status'] ?? '',
            'conclusion' => $run['conclusion'] ?? null,
            'createdAt' => $run['created_at'] ?? null,
            'updatedAt' => $run['updated_at'] ?? null,
            'htmlUrl' => $run['html_url'] ?? null,
        ];
    }

    if (isset($runs[0]) && is_array($runs[0])) {
        $runs[0]['failureDetail'] = workflow_failure_detail($rawRunsById[(string) ($runs[0]['id'] ?? '')] ?? [], $config);
    }

    return [
        'ok' => true,
        'target' => $target,
        'workflowTarget' => $targetKey,
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

function normalized_nonnegative_yield_input($value): ?string
{
    if (!is_numeric($value)) {
        return null;
    }
    $yield = (float) $value;
    if ($yield > 1) {
        $yield /= 100;
    }
    if ($yield < 0 || $yield > 10) {
        return null;
    }
    $normalized = rtrim(rtrim(number_format($yield, 3, '.', ''), '0'), '.');
    return $normalized === '' ? '0' : $normalized;
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

function normalized_scan_tag_input($value): ?string
{
    if ($value === null || $value === '') {
        return null;
    }
    $tag = strtolower(trim((string) $value));
    $tag = preg_replace('/[^a-z0-9_-]+/', '-', $tag) ?? '';
    $tag = trim($tag, '-_');
    return $tag === '' ? null : substr($tag, 0, 80);
}

function normalized_scan_max_days_input($value): ?string
{
    if ($value === null || $value === '') {
        return null;
    }
    if (!is_numeric($value)) {
        return null;
    }
    $days = (float) $value;
    if ($days < 0) {
        return '-1';
    }
    return rtrim(rtrim(number_format(min(3650.0, max(0.0, $days)), 2, '.', ''), '0'), '.');
}

function normalized_scan_days_input($value): ?string
{
    if ($value === null || $value === '' || !is_numeric($value)) {
        return null;
    }
    $days = max(0.5, min(3650, round((float) $value * 2) / 2));
    return rtrim(rtrim(number_format($days, 1, '.', ''), '0'), '.');
}

function normalized_scan_probability_input($value): ?string
{
    if ($value === null || $value === '' || !is_numeric($value)) {
        return null;
    }
    $probability = (float) $value;
    if ($probability > 1) {
        $probability /= 100;
    }
    if ($probability <= 0) {
        return null;
    }
    $probability = min(1, $probability);
    return rtrim(rtrim(number_format($probability, 4, '.', ''), '0'), '.');
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

function normalized_probability_source_input($value): ?string
{
    if ($value === null || $value === '') {
        return null;
    }
    $source = strtolower(trim((string) $value));
    return in_array($source, ['ai', 'polymarket'], true) ? $source : null;
}

function normalized_live_shortlist_token_ids_input($value): ?string
{
    if (!is_string($value) && !is_numeric($value)) {
        return null;
    }
    $tokens = preg_split('/[\s,]+/', trim((string) $value)) ?: [];
    $unique = [];
    foreach ($tokens as $token) {
        $token = trim($token);
        if ($token === '' || !preg_match('/^[0-9]{8,100}$/', $token) || isset($unique[$token])) {
            continue;
        }
        $unique[$token] = true;
        if (count($unique) >= 120) {
            break;
        }
    }
    return $unique === [] ? null : implode(',', array_keys($unique));
}

function normalized_paper_strategy_input($value): ?string
{
    if ($value === null || $value === '') {
        return null;
    }
    $text = (string) $value;
    return in_array($text, ['conservative', 'highReward', 'moreProbable'], true) ? $text : null;
}

function paper_strategy_from_target(string $target): ?string
{
    return match ($target) {
        'paper-conservative' => 'conservative',
        'paper-highReward' => 'highReward',
        'paper-moreProbable' => 'moreProbable',
        default => null,
    };
}

function workflow_target_key(string $target): string
{
    return paper_strategy_from_target($target) !== null ? 'paper' : $target;
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
        $targetKey = workflow_target_key($target);
        $liveMinProbability = normalized_probability_input($payload['min_probability'] ?? $payload['live_min_probability'] ?? null);
        $paperConservativeMinProbability = normalized_probability_input($payload['paper_conservative_min_probability'] ?? null);
        $paperHighRewardMinProbability = normalized_probability_input($payload['paper_high_reward_min_probability'] ?? null);
        $paperMoreProbableMinProbability = normalized_probability_input($payload['paper_more_probable_min_probability'] ?? null);
        $scanTag = normalized_scan_tag_input($payload['market_scan_tag'] ?? null);
        $scanLiquidityMin = normalized_money_input($payload['market_scan_liquidity_min'] ?? $payload['marketScanLiquidityMin'] ?? null);
        $scanMaxDays = normalized_scan_max_days_input($payload['market_scan_max_days'] ?? $payload['marketScanMaxDays'] ?? null);
        $liveMaxOrderFraction = normalized_fraction_input($payload['max_order_fraction'] ?? $payload['live_max_order_fraction'] ?? null);
        $paperMaxOrderFraction = normalized_fraction_input($payload['max_order_fraction'] ?? $payload['paper_max_order_fraction'] ?? null);
        $liveMaxResolutionDays = normalized_days_input($payload['maxResolutionDays'] ?? $payload['live_max_resolution_days'] ?? null);
        $liveSelectionOrder = normalized_selection_order_input($payload['selectionOrder'] ?? $payload['live_selection_order'] ?? null);
        $liveMinLiquidity = normalized_money_input($payload['minLiquidityUsdc'] ?? $payload['live_min_liquidity_usdc'] ?? null);
        $liveMinNetYield = normalized_nonnegative_yield_input($payload['minNetYield'] ?? $payload['live_min_net_yield'] ?? null);
        $liveUseLimitOrders = normalized_bool_input($payload['useLimitOrders'] ?? $payload['use_limit_orders'] ?? null);
        $crossLiveRiskDiversification = normalized_bool_input($payload['cross_live_portfolio_risk_diversification'] ?? $payload['crossLivePortfolioRiskDiversification'] ?? null);
        $liveShortlistTokenIds = normalized_live_shortlist_token_ids_input($payload['live_execution_candidate_token_ids'] ?? null);
        $liveShortlistProbabilitySource = normalized_probability_source_input($payload['live_execution_probability_source'] ?? null);
        $manualRunOnce = normalized_bool_input($payload['manual_run_once'] ?? $payload['manualRunOnce'] ?? null);
        $requestedLiveRunSource = strtoupper(trim((string) ($payload['live_run_source'] ?? $payload['liveRunSource'] ?? '')));
        if ($targetKey === 'live' && $requestedLiveRunSource === 'MANUAL') {
            $manualRunOnce = true;
        }
        if ($targetKey === 'live' && $manualRunOnce === true && ($liveShortlistTokenIds === null || $liveShortlistProbabilitySource === null)) {
            respond(['ok' => false, 'error' => 'Manual live execution requires a current execution shortlist and its probability source. Refresh the shortlist before running.'], 400);
        }
        $evaluationTokenId = preg_replace('/[^0-9]/', '', (string) ($payload['evaluation_token_id'] ?? $payload['evaluationTokenId'] ?? ''));
        $evaluationMarketSlug = preg_replace('/[^A-Za-z0-9_-]/', '', (string) ($payload['evaluation_market_slug'] ?? $payload['evaluationMarketSlug'] ?? ''));
        $refreshMarketSlug = preg_replace('/[^A-Za-z0-9_-]/', '', (string) ($payload['refresh_market_slug'] ?? $payload['refreshMarketSlug'] ?? ''));
        if ($targetKey === 'paper-refresh' && $refreshMarketSlug === '') {
            respond(['ok' => false, 'error' => 'A scraped market slug is required for refresh.'], 400);
        }
        $paperStrategyId = paper_strategy_from_target($target) ?? normalized_paper_strategy_input($payload['paper_strategy_id'] ?? $payload['paperStrategyId'] ?? null);
        $paperStrategies = ['conservative', 'high_reward', 'more_probable'];
        $paperExtraInputs = [];
        foreach ($paperStrategies as $strategy) {
            $paperExtraInputs["paper_{$strategy}_max_order_fraction"] = normalized_fraction_input($payload["paper_{$strategy}_max_order_fraction"] ?? null);
            $paperExtraInputs["paper_{$strategy}_max_resolution_days"] = normalized_days_input($payload["paper_{$strategy}_max_resolution_days"] ?? null);
            $paperExtraInputs["paper_{$strategy}_selection_order"] = normalized_selection_order_input($payload["paper_{$strategy}_selection_order"] ?? null);
            $paperExtraInputs["paper_{$strategy}_min_liquidity_usdc"] = normalized_money_input($payload["paper_{$strategy}_min_liquidity_usdc"] ?? null);
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
                    'manual_run_once' => $manualRunOnce,
                    'paper_strategy_id' => $paperStrategyId,
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
                    'live_min_net_yield' => $liveMinNetYield,
                    'live_use_limit_orders' => $liveUseLimitOrders,
                    'cross_live_portfolio_risk_diversification' => $crossLiveRiskDiversification,
                    'live_run_source' => $manualRunOnce === true ? 'MANUAL' : 'AUTO',
                    'live_execution_candidate_token_ids' => $liveShortlistTokenIds,
                    'live_execution_probability_source' => $liveShortlistProbabilitySource,
                ], static fn ($value): bool => $value !== null),
                'message' => 'Live one-time execution workflow dispatched.',
            ],
            'paper-scan' => [
                'workflow' => 'trading-market-scan.yml',
                'inputs' => array_filter([
                    'market_scan_tag' => $scanTag,
                    'market_scan_liquidity_min' => $scanLiquidityMin,
                    'market_scan_max_days' => $scanMaxDays ?? '-1',
                ], static fn ($value): bool => $value !== null),
                'message' => 'One-time tagged Polymarket scan workflow dispatched.',
            ],
        ];

        if ($targetKey === 'paper-evaluation') {
            $workflows['paper-evaluation'] = [
                'workflow' => 'trading-paper-evaluation.yml',
                'inputs' => array_filter([
                    'evaluation_token_id' => $evaluationTokenId !== '' ? $evaluationTokenId : null,
                    'evaluation_market_slug' => $evaluationMarketSlug !== '' ? $evaluationMarketSlug : null,
                ], static fn ($value): bool => $value !== null),
                'message' => 'Focused paper evaluation workflow dispatched.',
            ];
        }

        if ($targetKey === 'paper-refresh') {
            $workflows['paper-refresh'] = [
                'workflow' => 'trading-paper-bot.yml',
                'inputs' => array_filter([
                    'mode' => 'refresh',
                    // The paper workflow is at GitHub's 25-input limit. During
                    // refresh mode this otherwise unused input carries the slug.
                    'paper_strategy_id' => $refreshMarketSlug !== '' ? $refreshMarketSlug : null,
                ], static fn ($value): bool => $value !== null),
                'message' => 'Focused scraped-market refresh workflow dispatched.',
            ];
        }

        if (!isset($workflows[$targetKey])) {
            respond(['ok' => false, 'error' => 'Unknown workflow target'], 400);
        }

        $result = dispatch_workflow($workflows[$targetKey]['workflow'], $workflows[$targetKey]['inputs'], false);
        respond([
            'ok' => true,
            'target' => $target,
            'workflowTarget' => $targetKey,
            'paperStrategyId' => $paperStrategyId,
            'message' => $workflows[$targetKey]['message'],
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

    if ($action === 'scan-preferences') {
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $saved = save_scan_preferences(request_payload());
            respond([
                'ok' => true,
                'preferences' => $saved,
                'generatedAt' => gmdate('c'),
            ]);
        }
        respond([
            'ok' => true,
            'preferences' => load_scan_preferences(),
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
        $payload = state_payload($target);
        $summary = (string) ($_GET['summary'] ?? '');
        if ($target === 'paper') {
            $payload = compact_state_payload($target, $payload, $summary);
        }
        respond($payload);
    }

    if ($action === 'scan-audit') {
        $runId = trim((string) ($_GET['run_id'] ?? ''));
        if ($runId === '' || !preg_match('/^scan-[A-Za-z0-9:.+_-]{10,80}$/', $runId)) {
            respond(['ok' => false, 'error' => 'A valid scraping run id is required'], 400);
        }
        $state = state_payload('paper');
        $history = is_array($state['marketScanHistory'] ?? null) ? $state['marketScanHistory'] : [];
        foreach ($history as $run) {
            if (!is_array($run) || (string) ($run['id'] ?? '') !== $runId) {
                continue;
            }
            $audit = is_array($run['audit'] ?? null) ? $run['audit'] : null;
            if ($audit === null) {
                respond(['ok' => false, 'error' => 'Detailed audit is no longer retained for this scraping run'], 404);
            }
            $summary = $run;
            unset($summary['audit']);
            respond([
                'ok' => true,
                'run' => $summary,
                'apiCalls' => array_values(array_filter($audit['apiCalls'] ?? [], 'is_array')),
                'markets' => array_values(array_filter($audit['markets'] ?? [], 'is_array')),
                'generatedAt' => gmdate('c'),
            ]);
        }
        respond(['ok' => false, 'error' => 'Scraping run was not found'], 404);
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
