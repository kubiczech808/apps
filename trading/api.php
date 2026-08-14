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

/**
 * Heavy state collections the bot publishes as sibling files. Decoding the whole
 * catalogue for a request that only shows portfolio numbers is what pushed
 * json_decode past memory_limit and answered 500, so each caller declares which
 * segments it needs and pays for nothing else.
 */
function state_segment_fields(): array
{
    return [
        'observations' => ['marketObservations', 'marketScan'],
        'evaluations' => ['evaluations'],
        // Scan history is small in row count but carries per-run audits, and the
        // audit endpoints read nothing else. Keeping it separate lets them skip
        // the market catalogue entirely.
        'scanHistory' => ['marketScanHistory'],
        // Resolved observations are history and only the Resolved and All views read
        // them. They arrive under their own field name and are appended to the active
        // catalogue below, so the rest of this file still sees one list.
        'resolvedObservations' => ['resolvedMarketObservations'],
        // The newest page of that archive, capped by the writer and carrying the same
        // transport field, so it merges identically. Reading this instead of the whole
        // archive is what keeps the cost of the scraped view constant: the archive had
        // reached 23,561 rows, which costs 138 MB to decode on a 128 MB host, and the
        // page answered 500 rather than showing anything at all.
        'resolvedRecent' => ['resolvedMarketObservations'],
    ];
}

/**
 * Which segments a summary genuinely reads. Anything not listed here gets the
 * core file alone.
 */
function state_segments_for_summary(string $summary): array
{
    switch ($summary) {
        case 'dashboard':
            return [];
        case 'candidates':
            return ['evaluations'];
        case 'execution':
            // Only tradable markets can be executed, so the resolved archive is
            // never decoded for this view no matter how large it grows.
            return ['observations'];
        case 'scraped':
            // The recent page, never the whole archive. observationTotals still reports
            // the true totals from the manifest, so the tab labels keep growing.
            return ['observations', 'resolvedRecent', 'scanHistory'];
        case 'refresh':
            // The worker fetches segments straight from the data directory, so
            // this response only carries the core and the manifest that names
            // them. Reassembling the catalogue here is what made the bot's own
            // state read the most memory-hungry request on the hosting. A
            // pre-segmentation state has no manifest, and state_payload() then
            // returns it whole regardless of what is requested here.
            return [];
        default:
            // The unnamed summary drops the market catalogue on the way out, so
            // there is no reason to decode it on the way in.
            return ['evaluations', 'scanHistory'];
    }
}

function decode_state_file(string $path, bool $waitForUpload = true): ?array
{
    // FTP state replacement briefly removes the old file on hosts that do not
    // support an atomic overwrite. Give the upload a short window to finish
    // before reporting a real missing-state error to the browser.
    if ($waitForUpload) {
        for ($attempt = 0; $attempt < 4 && !is_file($path); $attempt++) {
            usleep(250000);
            clearstatcache(true, $path);
        }
    }
    if (!is_file($path)) {
        return null;
    }

    for ($attempt = 0; $attempt < 4; $attempt++) {
        clearstatcache(true, $path);
        $raw = @file_get_contents($path);
        if ($raw !== false) {
            $data = json_decode($raw, true);
            unset($raw);
            if (is_array($data)) {
                return $data;
            }
        }
        usleep(150000);
    }

    return null;
}

function state_payload(string $target, array $segments = ['observations', 'evaluations']): array
{
    $files = [
        'paper' => __DIR__ . '/data/paper-state.json',
        'live' => __DIR__ . '/data/live-state.json',
        'live-execution' => __DIR__ . '/data/live-execution-state.json',
        // The 5050 portfolio shares the wallet with the main live portfolio but not
        // its decisions, so its run log lives in its own file.
        'live-5050-execution' => __DIR__ . '/data/live-5050-execution-state.json',
    ];
    if (!isset($files[$target])) {
        respond(['ok' => false, 'error' => 'Unknown state target'], 400);
    }

    $path = $files[$target];
    $data = decode_state_file($path);
    if ($data === null) {
        if (!is_file($path)) {
            respond(['ok' => false, 'error' => 'State file is not available yet'], 404);
        }
        respond(['ok' => false, 'error' => 'State file contains invalid JSON'], 502);
    }

    $manifest = is_array($data['stateSegments'] ?? null) ? $data['stateSegments'] : [];
    if ($manifest === []) {
        // A state written before segmentation carries every collection inline.
        return $data;
    }

    $known = state_segment_fields();
    foreach ($segments as $name) {
        if (!isset($manifest[$name]) || !is_array($manifest[$name]) || !isset($known[$name])) {
            continue;
        }
        $file = (string) ($manifest[$name]['file'] ?? '');
        // The manifest is generated data, but it still reaches this code as file
        // content, so the name is constrained to a plain sibling file.
        if (!preg_match('/^[A-Za-z0-9._-]+\.json$/', $file)) {
            continue;
        }
        $segment = decode_state_file(dirname($path) . '/' . $file, false);
        if (!is_array($segment)) {
            continue;
        }
        foreach ($known[$name] as $field) {
            if (!array_key_exists($field, $segment) || $segment[$field] === null) {
                continue;
            }
            if ($field === 'resolvedMarketObservations') {
                // Appended, not assigned: the active catalogue may already be loaded
                // and the views downstream expect one combined marketObservations list.
                $active = is_array($data['marketObservations'] ?? null) ? $data['marketObservations'] : [];
                $resolved = is_array($segment[$field]) ? $segment[$field] : [];
                $data['marketObservations'] = array_merge($active, $resolved);
                continue;
            }
            $data[$field] = $segment[$field];
        }
        unset($segment);
    }

    return $data;
}

/**
 * True retained row counts, taken from the manifest rather than from the rows that
 * survived response truncation. The scraped tabs show these in parentheses; deriving
 * them from a truncated payload is what made them look like they were shrinking.
 */
function state_observation_totals(array $data): array
{
    $manifest = is_array($data['stateSegments'] ?? null) ? $data['stateSegments'] : [];
    $active = null;
    $resolved = null;
    if (isset($manifest['observations']['counts']['marketObservations'])) {
        $active = (int) $manifest['observations']['counts']['marketObservations'];
    }
    if (isset($manifest['resolvedObservations']['counts']['resolvedMarketObservations'])) {
        $resolved = (int) $manifest['resolvedObservations']['counts']['resolvedMarketObservations'];
    }
    if ($active === null && $resolved === null) {
        // A pre-segmentation state carries everything inline, so count it directly.
        $observations = is_array($data['marketObservations'] ?? null) ? $data['marketObservations'] : [];
        $resolved = 0;
        $active = 0;
        foreach ($observations as $item) {
            if (!is_array($item)) {
                continue;
            }
            if (is_resolved_scraped_market_observation($item) && !is_active_scraped_market_observation($item)) {
                $resolved += 1;
            } else {
                $active += 1;
            }
        }
    }
    $active = max(0, (int) $active);
    $resolved = max(0, (int) $resolved);
    return ['active' => $active, 'resolved' => $resolved, 'all' => $active + $resolved];
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
        'polymarketCategories',
        'firstPolymarketTags',
        'firstPolymarketCategories',
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
        // The Resolved tab needs the settlement outcome and the closed/accepting
        // flags to classify and describe a row, and the last live quote so a
        // settled 0/1 book does not replace the probability the market carried
        // while it was still tradable.
        'finalOutcomePrice',
        'marketClosed',
        'acceptingOrders',
        'umaResolutionStatus',
        'lastLiveMarketProbability',
        'daysToResolution',
        'liquidity',
        'volumeUsdc',
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
        // Keep both volume snapshots: the discovery-time value explains the
        // opportunity as it was found, while the resolved-time value feeds the
        // historical performance reports.
        'firstVolumeUsdc',
        'firstVolume24hr',
        'resolvedVolumeUsdc',
        'resolvedVolume24hr',
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

// The scraped view also lists markets whose result is already in or is being
// settled, so the Resolved tab can show them and report a count. This is the
// deliberate complement of is_active_scraped_market_observation: a row that is
// merely unattractive (an inverted sub-50% leftover) is still excluded, only rows
// that genuinely reached the end of their life are reported here.
function is_resolved_scraped_market_observation(array $item): bool
{
    $status = strtoupper((string) ($item['status'] ?? $item['selectionStatus'] ?? ''));
    if (in_array($status, ['RESOLVED', 'CLOSED', 'EXPIRED', 'FINALIZED', 'SETTLED'], true)) {
        return true;
    }
    $resolutionStatus = strtoupper((string) ($item['resolutionStatus'] ?? ''));
    if (in_array($resolutionStatus, ['PENDING_RESULT', 'FINAL_PRICE_AVAILABLE', 'NOT_ACCEPTING_ORDERS'], true)) {
        return true;
    }
    if (($item['marketClosed'] ?? null) === true || ($item['acceptingOrders'] ?? null) === false) {
        return true;
    }

    return false;
}

function compact_market_scan_history_entry(array $item): array
{
    $item['auditAvailable'] = isset($item['audit']) && is_array($item['audit']);
    unset($item['audit']);
    return $item;
}

function market_scan_history_records(array $fallback = []): array
{
    $byId = [];
    $archiveFiles = glob(__DIR__ . '/data/market-scan-history/*.ndjson') ?: [];
    sort($archiveFiles, SORT_STRING);
    foreach ($archiveFiles as $archiveFile) {
        $handle = @fopen($archiveFile, 'rb');
        if ($handle === false) {
            continue;
        }
        while (($line = fgets($handle)) !== false) {
            $item = json_decode(trim($line), true);
            if (!is_array($item) || (!isset($item['id']) && !isset($item['runAt']))) {
                continue;
            }
            $key = (string) ($item['id'] ?? $item['runAt']);
            $byId[$key] = compact_market_scan_history_entry($item);
        }
        fclose($handle);
    }
    foreach ($fallback as $item) {
        if (!is_array($item) || (!isset($item['id']) && !isset($item['runAt']))) {
            continue;
        }
        $key = (string) ($item['id'] ?? $item['runAt']);
        $byId[$key] = compact_market_scan_history_entry($item);
    }
    $records = array_values($byId);
    usort($records, static function (array $left, array $right): int {
        return strtotime((string) ($right['runAt'] ?? '')) <=> strtotime((string) ($left['runAt'] ?? ''));
    });
    return $records;
}

function compact_state_payload(string $target, array $data, string $summary): array
{
    if ($target !== 'paper') {
        return $data;
    }

    if ($summary === 'dashboard') {
        $compact = $data;
        $compact['evaluations'] = [];
        // Scraping history is read only from the scraped/execution state, never
        // from the dashboard payload, so this view does not load that segment.
        // Emptying it here keeps the response shape stable whether or not the
        // published state is segmented.
        $compact['marketScanHistory'] = [];
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
        // Resolved markets belong in this view too: the Resolved tab lists them and
        // shows their count. They are appended rather than merged into $active so the
        // active catalogue keeps its own ordering.
        $resolved = array_values(array_filter(
            $observations,
            static fn($item): bool => is_array($item)
                && !is_active_scraped_market_observation($item)
                && is_resolved_scraped_market_observation($item),
        ));
        usort($resolved, static function (array $a, array $b): int {
            $left = strtotime((string) ($a['resolvedAt'] ?? $a['endDate'] ?? '')) ?: 0;
            $right = strtotime((string) ($b['resolvedAt'] ?? $b['endDate'] ?? '')) ?: 0;
            return $right <=> $left;
        });
        // Nothing is discarded on disk any more: the archive keeps every resolved
        // market so the counts reflect what was really mined. This is purely a
        // response-size guard, and it has to be a real one -- measured on a 5000-row
        // active catalogue, this summary peaks near 111 MB at 8000 resolved rows and a
        // 128 MB host answers 500 before that. observationTotals reports the true
        // total regardless, so the tab labels keep growing while the list serves the
        // most recent page of it.
        $resolvedServeLimit = 3000;
        $resolvedTruncated = count($resolved) > $resolvedServeLimit;
        $resolved = array_slice($resolved, 0, $resolvedServeLimit);
        $active = array_merge($active, $resolved);
        $scanHistory = is_array($data['marketScanHistory'] ?? null)
            ? array_values(array_filter($data['marketScanHistory'], 'is_array'))
            : [];
        // Full audit rows can contain hundreds of markets. The log list only
        // needs scan summaries; the browser fetches a selected run's audit on
        // demand through action=scan-audit.
        $scanHistory = array_map('compact_market_scan_history_entry', $scanHistory);
        return [
            'schemaVersion' => $data['schemaVersion'] ?? null,
            'generatedAt' => $data['generatedAt'] ?? null,
            'marketObservations' => array_map(
                static fn($item): array => is_array($item) ? compact_market_observation($item) : [],
                $active
            ),
            'observationTotals' => state_observation_totals($data) + ['resolvedTruncated' => $resolvedTruncated],
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
                'displayName' => 'Conservative',
                'minProbability' => 0.95,
                'maxOrderFraction' => 0.05,
                'maxResolutionDays' => 7,
                'selectionOrder' => 'highest_ev_pa_first',
                'minLiquidityUsdc' => null,
                'minNetYield' => 0.0,
                'executionTrigger' => 'cron',
                'marketType' => 'all',
                'requireMostProbableOutcome' => false,
                'probabilitySource' => 'ai',
                'excludedCandidateTokenIds' => [],
                'includeOnlyMarketTags' => [],
                'excludedMarketTags' => [],
            ],
            'highReward' => [
                'displayName' => 'High reward',
                'minProbability' => 0.6,
                'maxOrderFraction' => 0.05,
                'maxResolutionDays' => 7,
                'selectionOrder' => 'highest_reward_risk_first',
                'minLiquidityUsdc' => null,
                'minNetYield' => 0.0,
                'executionTrigger' => 'cron',
                'marketType' => 'all',
                'requireMostProbableOutcome' => false,
                'probabilitySource' => 'ai',
                'excludedCandidateTokenIds' => [],
                'includeOnlyMarketTags' => [],
                'excludedMarketTags' => [],
            ],
            'moreProbable' => [
                'displayName' => 'More probable',
                'minProbability' => 0.6,
                'maxOrderFraction' => 0.05,
                'maxResolutionDays' => 7,
                'selectionOrder' => 'highest_reward_risk_first',
                'minLiquidityUsdc' => 500000,
                'minNetYield' => 0.0,
                'executionTrigger' => 'cron',
                'marketType' => 'multi',
                'requireMostProbableOutcome' => true,
                'probabilitySource' => 'ai',
                'excludedCandidateTokenIds' => [],
                'includeOnlyMarketTags' => [],
                'excludedMarketTags' => [],
            ],
            'equal' => [
                'displayName' => 'Equal',
                'minProbability' => 0.75,
                'maxOrderFraction' => 0.05,
                'maxResolutionDays' => 7,
                'selectionOrder' => 'highest_ev_pa_first',
                // Equal needs a real secondary market for its synthetic stop.
                // The field is historically named liquidity, but is compared with
                // Polymarket's traded-volume figure throughout the application.
                'minLiquidityUsdc' => 20000,
                'minNetYield' => 0.0,
                // Equal defaults to a check after a completed market scan. Users may
                // choose a scheduled cadence when they prefer a defined interval.
                'executionTrigger' => 'after_scrape',
                'marketType' => 'all',
                'requireMostProbableOutcome' => false,
                'probabilitySource' => 'polymarket',
                'excludedCandidateTokenIds' => [],
                'includeOnlyMarketTags' => [],
                'excludedMarketTags' => [],
            ],
        ],
        'live' => [
            'displayName' => 'Live',
            'minProbability' => 0.95,
            'maxOrderFraction' => 0.05,
            'maxResolutionDays' => 7,
            'selectionOrder' => 'highest_ev_pa_first',
            'minLiquidityUsdc' => 100,
            'minNetYield' => 0.0,
            'executionTrigger' => 'cron',
            'useLimitOrders' => true,
            'marketType' => 'all',
            'requireMostProbableOutcome' => false,
            'probabilitySource' => 'ai',
            'excludedCandidateTokenIds' => [],
            'includeOnlyMarketTags' => [],
            'excludedMarketTags' => [],
        ],
        // 5050 rests a bid at a fixed point on the 0..1 scale across every candidate
        // that clears its probability bar, rather than buying the best one at the
        // market. Automation ships off: it deliberately commits past its capital.
        'live5050' => [
            'displayName' => '5050',
            'minProbability' => 0.90,
            'fixedEntryPrice' => 0.50,
            'stakePerOrderUsdc' => null,
            'maxOrderFraction' => 0.05,
            'maxResolutionDays' => 30,
            'selectionOrder' => 'highest_ev_pa_first',
            'minLiquidityUsdc' => 100,
            'minNetYield' => 0.0,
            'executionTrigger' => 'cron',
            'useLimitOrders' => true,
            'marketType' => 'all',
            'requireMostProbableOutcome' => false,
            'probabilitySource' => 'polymarket',
            'automationEnabled' => false,
            // Sports and esports are where the short-dated, high-probability fixtures
            // this strategy rests bids against actually live. Empty means every tag.
            'allowedMarketTags' => ['sports', 'esports'],
            // Seeded with the default so a fresh install still recognises its own fills.
            'fixedEntryPriceHistory' => [0.50],
            'excludedCandidateTokenIds' => [],
            'includeOnlyMarketTags' => [],
            'excludedMarketTags' => [],
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

function normalize_portfolio_market_type_value(mixed $value, bool $legacyMultichoice = false): string
{
    $normalized = strtolower(trim((string) ($value ?? '')));
    if (in_array($normalized, ['all', 'binary', 'multi'], true)) {
        return $normalized;
    }
    return $legacyMultichoice ? 'multi' : 'all';
}

function normalize_probability_source_value(mixed $value): string
{
    return $value === 'polymarket' ? 'polymarket' : 'ai';
}

function normalize_execution_trigger_value(mixed $value): string
{
    return $value === 'after_scrape' ? 'after_scrape' : 'cron';
}

function normalize_execution_cron_minutes_value(mixed $value, mixed $fallback = 60): int
{
    $choices = [30, 60, 120, 240, 480, 720, 1440];
    $minutes = is_numeric($value) ? (int) $value : (is_numeric($fallback) ? (int) $fallback : 60);
    return in_array($minutes, $choices, true) ? $minutes : 60;
}

function normalize_portfolio_display_name(mixed $value, string $fallback): string
{
    $name = preg_replace('/[\x00-\x1F\x7F]+/', ' ', (string) $value);
    $name = preg_replace('/\s+/', ' ', is_string($name) ? $name : '');
    $name = trim(is_string($name) ? $name : '');
    if ($name === '') {
        return $fallback;
    }
    if ($name === '75') {
        return 'Paper 75';
    }
    return function_exists('mb_substr')
        ? mb_substr($name, 0, 80, 'UTF-8')
        : substr($name, 0, 80);
}

// A list of Polymarket tags saved on a portfolio: the tags 5050 may bid on, or the tags any
// portfolio refuses outright. Both are the same shape, and both accept a saved list or a
// typed comma/space separated string. Slugs are normalized the way the dashboard's tag
// picker normalizes them, or a tag typed with a capital or a space would never match the
// tags stored on a market.
function normalize_market_tag_list(mixed $value): array
{
    if (is_string($value)) {
        $value = preg_split('/[,\s]+/', $value) ?: [];
    }
    if (!is_array($value)) {
        return [];
    }
    $tags = [];
    foreach ($value as $candidate) {
        $tag = strtolower(trim((string) $candidate));
        $tag = trim((string) preg_replace('/[^a-z0-9_-]+/', '-', $tag), '-');
        if ($tag === '' || isset($tags[$tag])) {
            continue;
        }
        $tags[$tag] = true;
        if (count($tags) >= 40) {
            break;
        }
    }
    return array_keys($tags);
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

// The prices 5050 has bid at, current one first. Capped, because this only has to cover
// rows still on the account -- a price nothing was ever bought at costs nothing to keep,
// but an unbounded list would grow with every tweak of the setting.
function normalize_fixed_entry_price_history(mixed $value, float $current): array
{
    $prices = [];
    $add = static function ($candidate) use (&$prices): void {
        if (!is_numeric($candidate)) {
            return;
        }
        $price = round((float) $candidate, 4);
        // A limit order cannot rest at 0 or 1, so anything outside the band is not a
        // price this portfolio ever used.
        if ($price <= 0 || $price >= 1) {
            return;
        }
        $key = (string) $price;
        if (!isset($prices[$key])) {
            $prices[$key] = $price;
        }
    };
    $add($current);
    foreach (is_array($value) ? $value : [] as $candidate) {
        $add($candidate);
        if (count($prices) >= 12) {
            break;
        }
    }
    return array_values($prices);
}

function normalize_strategy_config(array $input, array $defaults): array
{
    $executionTrigger = normalize_execution_trigger_value($input['executionTrigger'] ?? $defaults['executionTrigger']);
    $executionCronMinutes = $executionTrigger === 'after_scrape'
        ? 0
        : normalize_execution_cron_minutes_value($input['executionCronMinutes'] ?? $defaults['executionCronMinutes'] ?? 60);
    $legacyMultichoice = (bool) ($input['requireMostProbableOutcome'] ?? $defaults['requireMostProbableOutcome'] ?? false);
    $marketType = normalize_portfolio_market_type_value(
        $input['marketType'] ?? $defaults['marketType'] ?? null,
        $legacyMultichoice
    );
    return [
        'displayName' => normalize_portfolio_display_name(
            $input['displayName'] ?? $defaults['displayName'],
            (string) $defaults['displayName']
        ),
        'minProbability' => normalize_probability_value($input['minProbability'] ?? null, (float) $defaults['minProbability']),
        'maxOrderFraction' => normalize_fraction_value($input['maxOrderFraction'] ?? null, (float) $defaults['maxOrderFraction']),
        'maxResolutionDays' => normalize_days_value($input['maxResolutionDays'] ?? null, (int) $defaults['maxResolutionDays']),
        'selectionOrder' => normalize_selection_order_value($input['selectionOrder'] ?? $defaults['selectionOrder']),
        'minLiquidityUsdc' => normalize_optional_money_value($input['minLiquidityUsdc'] ?? $defaults['minLiquidityUsdc']),
        'minNetYield' => normalize_net_yield_value($input['minNetYield'] ?? null, (float) $defaults['minNetYield']),
        'executionTrigger' => $executionTrigger,
        // A scheduled trigger always has a concrete cadence. Legacy zero values
        // are migrated to an explicit interval so trading frequency stays clear.
        'executionCronMinutes' => $executionCronMinutes,
        // Absent means on, so a portfolio saved before this existed keeps trading
        // rather than silently stopping.
        'automationEnabled' => (bool) ($input['automationEnabled'] ?? $defaults['automationEnabled'] ?? true),
        'marketType' => $marketType,
        // Kept while older workflows are still in circulation. The three-value
        // marketType field above is the source of truth.
        'requireMostProbableOutcome' => $marketType === 'multi',
        'probabilitySource' => normalize_probability_source_value($input['probabilitySource'] ?? $defaults['probabilitySource']),
        'excludedCandidateTokenIds' => normalize_excluded_candidate_token_ids($input['excludedCandidateTokenIds'] ?? $defaults['excludedCandidateTokenIds'] ?? []),
        // The allow-list takes precedence at shortlist and execution time. The block-list
        // stays stored so clearing this field restores the prior exclusions.
        'includeOnlyMarketTags' => normalize_market_tag_list($input['includeOnlyMarketTags'] ?? $defaults['includeOnlyMarketTags'] ?? []),
        // Whole tags this portfolio refuses, dropped before a candidate is ever ranked.
        // Every portfolio carries it, unlike 5050's allow-list. Empty is the default and
        // means nothing is excluded, so unlike the allow-list an absent value and an
        // explicitly cleared one mean the same thing and need no special case here.
        'excludedMarketTags' => normalize_market_tag_list($input['excludedMarketTags'] ?? $defaults['excludedMarketTags'] ?? []),
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
    // 5050 carries three settings no other portfolio has. They are normalized here
    // rather than passed through, so a bad value cannot reach the executor and be
    // rejected by the exchange one bid at a time.
    $fixedInput = is_array($input['live5050'] ?? null) ? $input['live5050'] : [];
    $config['live5050'] = normalize_strategy_config($fixedInput, $defaults['live5050']);
    $config['live5050']['useLimitOrders'] = true;
    $entryPrice = is_numeric($fixedInput['fixedEntryPrice'] ?? null)
        ? (float) $fixedInput['fixedEntryPrice']
        : (float) $defaults['live5050']['fixedEntryPrice'];
    // A limit order cannot rest at 0 or 1, so the band is exclusive at both ends.
    $config['live5050']['fixedEntryPrice'] = ($entryPrice > 0 && $entryPrice < 1)
        ? round($entryPrice, 2)
        : (float) $defaults['live5050']['fixedEntryPrice'];
    // Every price 5050 has rested bids at, newest first. Both live portfolios share one
    // Polymarket wallet, so what a row was bought at is how the dashboard tells whose it
    // is -- and with only the current price to go on, changing this setting handed every
    // position, order and closed trade made at the old one straight to the live
    // portfolio. Its own tab then showed no trades and no P/L at all.
    // The shipped 0.50 is merged in rather than merely defaulted to. Falling back to it
    // only when the field is absent recovered nothing in practice: production's config
    // already carried the field, holding [0.65] alone, because the history began being
    // recorded after the price had already been changed. The 0.50 rows stayed on the main
    // live portfolio's tab exactly as reported.
    //
    // Keeping it permanently is not a workaround. 0.50 is the price this strategy is
    // named for and ships with, and the live portfolio buys at the market against a
    // probability bar in the nineties -- the lowest entry price among the account's
    // closed live trades is 0.75 -- so no row at 0.50 was ever the live portfolio's.
    // It goes ahead of the stored list so the 12-price cap can never drop it.
    $config['live5050']['fixedEntryPriceHistory'] = normalize_fixed_entry_price_history(
        array_merge(
            $defaults['live5050']['fixedEntryPriceHistory'],
            is_array($fixedInput['fixedEntryPriceHistory'] ?? null) ? $fixedInput['fixedEntryPriceHistory'] : []
        ),
        (float) $config['live5050']['fixedEntryPrice']
    );
    $stake = $fixedInput['stakePerOrderUsdc'] ?? null;
    $config['live5050']['stakePerOrderUsdc'] = is_numeric($stake) && (float) $stake > 0 ? round((float) $stake, 2) : null;
    // Absent keeps the default; an explicitly empty list means every tag, so the
    // restriction can be lifted and not only narrowed.
    $config['live5050']['allowedMarketTags'] = array_key_exists('allowedMarketTags', $fixedInput)
        ? normalize_market_tag_list($fixedInput['allowedMarketTags'])
        : $defaults['live5050']['allowedMarketTags'];
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
    // A save replaces the stored config with whatever the dashboard is holding, so the
    // price history is carried across here rather than trusted to the client: a tab
    // opened before the field existed would POST a config without it and drop the record
    // of every price 5050 had traded at -- which is exactly the loss this guards against.
    $stored = load_portfolio_config();
    if (!is_array($config['live5050'] ?? null)) {
        $config['live5050'] = [];
    }
    $config['live5050']['fixedEntryPriceHistory'] = array_merge(
        is_array($config['live5050']['fixedEntryPriceHistory'] ?? null) ? $config['live5050']['fixedEntryPriceHistory'] : [],
        [$stored['live5050']['fixedEntryPrice'] ?? null],
        is_array($stored['live5050']['fixedEntryPriceHistory'] ?? null) ? $stored['live5050']['fixedEntryPriceHistory'] : [],
    );

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

// Where a run that is still going has got to: the step it is executing, and when that step
// started. Without it an in-flight run can only say "in progress", which after two minutes
// tells the reader nothing about whether it is working or wedged.
function workflow_progress_detail(array $run, array $config): ?array
{
    $runId = (int) ($run['id'] ?? 0);
    $status = strtolower((string) ($run['status'] ?? ''));
    if ($runId <= 0 || $status === 'completed') {
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
        // A progress read is decoration; failing it must not fail the status call that
        // tells the dashboard a run exists at all.
        return null;
    }

    foreach (($payload['jobs'] ?? []) as $job) {
        if (!is_array($job) || strtolower((string) ($job['status'] ?? '')) === 'completed') {
            continue;
        }
        $completedSteps = 0;
        $steps = is_array($job['steps'] ?? null) ? $job['steps'] : [];
        foreach ($steps as $step) {
            if (is_array($step) && strtolower((string) ($step['status'] ?? '')) === 'completed') {
                $completedSteps += 1;
            }
        }
        foreach ($steps as $step) {
            if (!is_array($step) || strtolower((string) ($step['status'] ?? '')) !== 'in_progress') {
                continue;
            }
            return [
                'job' => trim((string) ($job['name'] ?? '')),
                'step' => trim((string) ($step['name'] ?? '')),
                'stepStartedAt' => $step['started_at'] ?? null,
                'stepNumber' => $completedSteps + 1,
                'stepCount' => count($steps),
            ];
        }
        // Between steps, or the job is still waiting for a runner -- which on the shared
        // self-hosted runner is itself the answer to "why has nothing happened yet".
        return [
            'job' => trim((string) ($job['name'] ?? '')),
            'step' => strtolower((string) ($job['status'] ?? '')) === 'queued' ? 'waiting for a runner' : '',
            'stepStartedAt' => $job['started_at'] ?? null,
            'stepNumber' => $completedSteps,
            'stepCount' => count($steps),
        ];
    }
    return null;
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
        // 5050 dispatches its own workflow but had no entry here, so every status read for
        // it answered 400: its run watcher spent all 32 polls on "status unavailable", and
        // nothing about a 5050 run in flight could be shown anywhere.
        'live-5050' => 'trading-live-5050.yml',
        'live-sync' => 'trading-live-account.yml',
    ];
    if (!isset($workflows[$targetKey])) {
        respond(['ok' => false, 'error' => 'Unknown workflow target'], 400);
    }

    // Which runs count. The default stays dispatches only, because the caller that waits
    // on a button press must not mistake a cron run that started meanwhile for its own.
    // `event=all` is for the opposite question -- is anything running right now -- where
    // a scheduled or post-scrape run is exactly what must not be missed.
    $eventFilter = strtolower(trim((string) ($_GET['event'] ?? 'workflow_dispatch')));
    $query = [
        'branch' => $config['ref'],
        'per_page' => 5,
    ];
    if ($eventFilter !== '' && $eventFilter !== 'all') {
        $query['event'] = $eventFilter;
    }

    $workflow = $workflows[$targetKey];
    $url = sprintf(
        'https://api.github.com/repos/%s/actions/workflows/%s/runs?%s',
        rawurlencode($config['repo']),
        rawurlencode($workflow),
        http_build_query($query)
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

    // Both details cost an extra jobs request, so only the newest run gets them -- and
    // each returns null for a run in the state the other one is about, so a completed run
    // never pays for a progress read nor a running one for a failure read.
    if (isset($runs[0]) && is_array($runs[0])) {
        $raw = $rawRunsById[(string) ($runs[0]['id'] ?? '')] ?? [];
        $runs[0]['failureDetail'] = workflow_failure_detail($raw, $config);
        $runs[0]['progress'] = workflow_progress_detail($raw, $config);
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
    return in_array($text, ['conservative', 'highReward', 'moreProbable', 'equal'], true) ? $text : null;
}

function paper_strategy_from_target(string $target): ?string
{
    return match ($target) {
        'paper-conservative' => 'conservative',
        'paper-highReward' => 'highReward',
        'paper-moreProbable' => 'moreProbable',
        'paper-equal' => 'equal',
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

        // Dispatching this is a full Actions run (npm install, Polymarket calls, FTP
        // upload), and the account's runner capacity is shared with deploy, the market
        // scan, the paper bot and live execution. A 30s floor let one open dashboard tab
        // dispatch ~120 runs an hour, which starved all of those: their jobs sat with no
        // runner assigned and GitHub cancelled each after 15 minutes. The floor is the
        // only protection that survives a stale cached frontend, so it is enforced here
        // and not only in app.js. 120s still leaves a deliberate refresh responsive.
        $minSeconds = max(120, min(900, (int) ($_GET['minSeconds'] ?? 600)));
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
        $manualRunOnce = normalized_bool_input($payload['manual_run_once'] ?? $payload['manualRunOnce'] ?? null);
        $requestedLiveRunSource = strtoupper(trim((string) ($payload['live_run_source'] ?? $payload['liveRunSource'] ?? '')));
        if ($targetKey === 'live' && $requestedLiveRunSource === 'MANUAL') {
            $manualRunOnce = true;
        }
        $evaluationTokenId = preg_replace('/[^0-9]/', '', (string) ($payload['evaluation_token_id'] ?? $payload['evaluationTokenId'] ?? ''));
        $evaluationMarketSlug = preg_replace('/[^A-Za-z0-9_-]/', '', (string) ($payload['evaluation_market_slug'] ?? $payload['evaluationMarketSlug'] ?? ''));
        $refreshMarketSlug = preg_replace('/[^A-Za-z0-9_-]/', '', (string) ($payload['refresh_market_slug'] ?? $payload['refreshMarketSlug'] ?? ''));
        if ($targetKey === 'paper-refresh' && $refreshMarketSlug === '') {
            respond(['ok' => false, 'error' => 'A scraped market slug is required for refresh.'], 400);
        }
        $paperStrategyId = paper_strategy_from_target($target) ?? normalized_paper_strategy_input($payload['paper_strategy_id'] ?? $payload['paperStrategyId'] ?? null);
        // Equal reads its complete configuration from portfolio-config.json in the
        // paper bot. Do not add unsupported workflow_dispatch inputs here.
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
                ], static fn ($value): bool => $value !== null),
                'message' => 'Live one-time execution workflow dispatched.',
            ],
            // 5050 runs a different algorithm from the main live portfolio, so the
            // button on its dashboard must dispatch its own workflow. Its parameters
            // are read from the saved config by the run itself; nothing is passed
            // here, so a manual run and a scheduled one use identical settings.
            'live-5050' => [
                'workflow' => 'trading-live-5050.yml',
                'inputs' => [
                    'live_confirm' => true,
                ],
                'message' => '5050 execution workflow dispatched.',
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
        $summary = (string) ($_GET['summary'] ?? '');
        // Load the segments this summary reads before decoding anything else. The
        // dashboard is by far the most requested view and needs none of them.
        $payload = state_payload($target, state_segments_for_summary($summary));
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
        $state = state_payload('paper', ['scanHistory']);
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

    if ($action === 'scan-history') {
        $page = max(0, (int) ($_GET['page'] ?? 0));
        $pageSize = min(200, max(25, (int) ($_GET['page_size'] ?? 100)));
        $state = state_payload('paper', ['scanHistory']);
        $fallback = is_array($state['marketScanHistory'] ?? null) ? $state['marketScanHistory'] : [];
        $records = market_scan_history_records($fallback);
        $offset = $page * $pageSize;
        respond([
            'ok' => true,
            'records' => array_slice($records, $offset, $pageSize),
            'page' => $page,
            'pageSize' => $pageSize,
            'total' => count($records),
            'hasMore' => $offset + $pageSize < count($records),
        ]);
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
