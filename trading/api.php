<?php

declare(strict_types=1);

// Every created portfolio becomes a strategy the bot runs each pass and a portfolio row
// in the published state, so the number of them is bounded rather than left to whatever
// a form can be submitted enough times to produce.
// Custom portfolios are dynamically configured strategies; keeping a practical bound
// protects a scheduled pass from unbounded work while still leaving room for archived
// experiments and the active portfolios a user actually wants to compare.
const CUSTOM_PAPER_PORTFOLIO_LIMIT = 24;
// A real wallet may be shared, but its strategies must not share a configuration
// record. Keep the live collection smaller because every active one dispatches a
// signed execution workflow against that account.
const CUSTOM_LIVE_PORTFOLIO_LIMIT = 12;

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

    // A dedicated trigger key wins when it exists. The database password is the
    // configured private fallback during the migration, so existing deployment
    // credentials are sufficient for ingestion without a fourth secret.
    $databasePassword = (string) ($config['db_password'] ?? getenv('TRADING_DB_PASSWORD') ?: '');
    $triggerKey = (string) ($config['trigger_key'] ?? getenv('TRADING_TRIGGER_KEY') ?: $databasePassword);

    return [
        'github_token' => (string) ($config['github_token'] ?? getenv('POLY_TRADING_GITHUB_TOKEN') ?: getenv('TRADING_GITHUB_TOKEN') ?: ''),
        'trigger_key' => $triggerKey,
        'repo' => (string) ($config['repo'] ?? getenv('TRADING_GITHUB_REPO') ?: 'kubiczech808/apps'),
        'ref' => (string) ($config['ref'] ?? getenv('TRADING_GITHUB_REF') ?: 'claude/energy-consumption-app-Nf7bh'),
        // The database belongs to Trading alone. It is generated during deploy from
        // repository secrets and is never returned by an API response.
        'db_host' => (string) ($config['db_host'] ?? getenv('TRADING_DB_HOST') ?: ''),
        'db_port' => (string) ($config['db_port'] ?? getenv('TRADING_DB_PORT') ?: '3306'),
        'db_name' => (string) ($config['db_name'] ?? getenv('TRADING_DB_NAME') ?: ''),
        'db_user' => (string) ($config['db_user'] ?? getenv('TRADING_DB_USER') ?: ''),
        'db_password' => $databasePassword,
    ];
}

$tradingStoragePath = __DIR__ . '/storage.php';
if (is_file($tradingStoragePath)) {
    require_once $tradingStoragePath;
} else {
    // Offline API tests deliberately copy just api.php into a temporary document root.
    // The real deployment always ships storage.php with it; this narrow no-storage
    // fallback keeps those JSON-only fixtures exercising their intended code path.
    function trading_storage_is_active(): bool
    {
        return false;
    }
}

/**
 * A deploy-time health check for the dedicated Trading database. It deliberately
 * exposes only capability flags and server limits: credentials, DSN and connection
 * errors stay on the host. The endpoint is for the deployment workflow, never the UI.
 */
function trading_storage_diagnostics(): array
{
    $config = app_config();
    $configured = $config['db_host'] !== ''
        && $config['db_name'] !== ''
        && $config['db_user'] !== ''
        && $config['db_password'] !== '';
    $result = [
        'pdoAvailable' => class_exists('PDO'),
        'pdoMysqlAvailable' => extension_loaded('pdo_mysql'),
        'configured' => $configured,
        'connected' => false,
        'schemaReady' => false,
        'serverVersion' => null,
        'databaseSizeBytes' => null,
        'tradingSizeBytes' => null,
        'tradingTables' => [],
        'maxConnections' => null,
    ];
    if (!$result['pdoMysqlAvailable'] || !$configured) {
        return $result;
    }

    try {
        $port = ctype_digit($config['db_port']) ? (int) $config['db_port'] : 3306;
        $pdo = new PDO(
            sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $config['db_host'], $port, $config['db_name']),
            $config['db_user'],
            $config['db_password'],
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
            ],
        );
        $result['connected'] = true;
        $result['serverVersion'] = (string) $pdo->query('SELECT VERSION()')->fetchColumn();
        $result['maxConnections'] = (int) $pdo->query("SHOW VARIABLES LIKE 'max_connections'")->fetchColumn(1);
        trading_storage_bootstrap($pdo);
        $statement = $pdo->prepare(
            'SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = :database'
        );
        $statement->execute(['database' => $config['db_name']]);
        $result['databaseSizeBytes'] = (int) $statement->fetchColumn();
        $result['tradingTables'] = trading_storage_table_stats($pdo);
        $result['tradingSizeBytes'] = array_sum(array_map(
            static fn (array $table): int => (int) ($table['dataBytes'] ?? 0) + (int) ($table['indexBytes'] ?? 0),
            $result['tradingTables'],
        ));
        $result['schemaReady'] = true;
    } catch (Throwable) {
        // The caller needs to know that the connection is unavailable; implementation
        // details such as host names and authentication failures are not public data.
        $result['connected'] = false;
        return $result;
    }
    return $result;
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
        // Portfolio archives hold the only historical copy after a paper portfolio is
        // reset or archived. Dashboard consumers receive a compact summary below, not
        // the snapshots themselves.
        'archives' => ['paperPortfolioArchives'],
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
            return ['archives'];
        case 'portfolio-overview':
            return [];
        case 'candidates':
            // The browser now builds portfolio shortlists from the compact
            // `execution` response.  Do not decode the legacy AI catalogue here:
            // it can hold thousands of rows and exceeded the shared host's memory
            // before the browser could even request the useful shortlist.
            return [];
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

function state_file_paths(): array
{
    return [
        'paper' => __DIR__ . '/data/paper-state.json',
        'live' => __DIR__ . '/data/live-state.json',
        'live-execution' => __DIR__ . '/data/live-execution-state.json',
        // The 5050 portfolio shares the wallet with the main live portfolio but not
        // its decisions, so its run log lives in its own file.
        'live-5050-execution' => __DIR__ . '/data/live-5050-execution-state.json',
    ];
}

/**
 * A run that never started still happened.
 *
 * Every run-log entry a portfolio has is written by the runner at the end of its run, so a
 * dispatch GitHub refuses produces no entry at all: the popup shows an error, the run log
 * shows the previous run, and once the popup is closed there is no record that anything was
 * attempted. Reported after exactly that -- a manual execution answered
 * "HTTP 422: failed to parse workflow" and left nothing behind.
 *
 * This is the one point where the failure is known, so it is recorded here and merged into
 * whichever run log the portfolio renders. It is deliberately a small append-only file per
 * target rather than a write into the published state: the state is owned by the runner and
 * replaced wholesale on every upload, so anything written here would be lost on the next
 * successful run -- which is the run that matters least to keep the failure beside.
 */
/**
 * The one name a failure is filed under, derived the same way when it is written and when
 * it is read. Deriving it twice from the raw dispatch target would drift: the browser sends
 * "paper" plus a strategy id for some portfolios and "paper-<id>" for others, and the two
 * would file into different buckets while looking identical in the code.
 */
function execution_dispatch_failure_key(?string $paperStrategyId, string $target): string
{
    // Paper dispatches arrive as target "paper" with the portfolio named separately, so the
    // target alone would file every paper portfolio's failures into one bucket. Live
    // dispatches carry the portfolio in the target itself ("live", "live-5050",
    // "live-custom-<id>"), so there the target is already the name.
    if ($paperStrategyId !== null && $paperStrategyId !== '') {
        return 'paper-' . $paperStrategyId;
    }
    return $target;
}

function execution_dispatch_failure_path(string $key): string
{
    $safe = preg_replace('/[^a-zA-Z0-9_-]/', '-', $key);
    return __DIR__ . '/data/dispatch-failures/' . ($safe === '' ? 'unknown' : $safe) . '.ndjson';
}

function record_execution_dispatch_failure(string $key, string $target, ?string $strategyId, string $message): array
{
    $record = [
        'runAt' => gmdate('c'),
        'date' => gmdate('c'),
        'strategyId' => $strategyId,
        'target' => $target,
        'action' => 'DISPATCH_FAILED',
        'status' => 'FAILED',
        // Said in full. The GitHub message names the file and the line, which is the whole
        // diagnosis for a workflow that will not parse.
        'reason' => 'The run never started: ' . $message,
        'source' => 'MANUAL',
        'trigger' => 'MANUAL',
        'dispatchError' => $message,
    ];
    if (trading_storage_is_active()) {
        try {
            trading_storage_event_append('dispatch-failure', $key, $record);
        } catch (Throwable) {
            // Preserve the local fallback below if the database is briefly unavailable.
        }
    }
    $path = execution_dispatch_failure_path($key);
    $directory = dirname($path);
    if (!is_dir($directory) && !@mkdir($directory, 0775, true) && !is_dir($directory)) {
        return $record;
    }
    // Bounded: a workflow that cannot parse fails on every attempt, and a user retrying is
    // exactly when this file would otherwise grow without limit.
    $existing = is_file($path) ? (@file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: []) : [];
    $existing[] = json_encode($record, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $existing = array_slice($existing, -50);
    @file_put_contents($path, implode("\n", $existing) . "\n", LOCK_EX);
    return $record;
}

function execution_dispatch_failure_records(string $key): array
{
    if (trading_storage_is_active()) {
        return trading_storage_event_records('dispatch-failure', $key, 50);
    }
    $path = execution_dispatch_failure_path($key);
    if (!is_file($path)) {
        return [];
    }
    $records = [];
    foreach (@file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        $item = json_decode($line, true);
        if (is_array($item) && isset($item['runAt'])) {
            $records[] = $item;
        }
    }
    return $records;
}

function state_payload(string $target, array $segments = ['observations', 'evaluations'], ?string $selectedStrategyId = null): array
{
    if (trading_storage_is_active()) {
        $document = trading_storage_document_get('state:' . $target);
        if ($document === null) {
            respond(['ok' => false, 'error' => 'Trading database state is not available yet'], 503);
        }
        if (in_array('observations', $segments, true)) {
            $document['marketObservations'] = trading_storage_observations_fetch('SCRAPED');
        }
        if (in_array('resolvedObservations', $segments, true)) {
            $document['marketObservations'] = array_merge(
                is_array($document['marketObservations'] ?? null) ? $document['marketObservations'] : [],
                trading_storage_observations_fetch('RESOLVED'),
            );
        } elseif (in_array('resolvedRecent', $segments, true)) {
            $document['marketObservations'] = array_merge(
                is_array($document['marketObservations'] ?? null) ? $document['marketObservations'] : [],
                trading_storage_observations_fetch('RESOLVED', 5000),
            );
        }
        if ($target === 'paper' && $selectedStrategyId !== null && preg_match('/^[A-Za-z0-9_-]{1,64}$/', $selectedStrategyId)) {
            $portfolio = trading_storage_document_get('paper-portfolio:' . $selectedStrategyId);
            if (is_array($portfolio)) {
                if (!isset($document['paperPortfolios']) || !is_array($document['paperPortfolios'])) {
                    $document['paperPortfolios'] = [];
                }
                $document['paperPortfolios'][$selectedStrategyId] = $portfolio;
            }
        }
        return $document;
    }
    $files = state_file_paths();
    $customLive = custom_live_portfolio_id_from_execution_target($target);
    if ($customLive !== null) {
        $config = load_portfolio_config();
        if (!isset($config['livePortfolios'][$customLive])) {
            respond(['ok' => false, 'error' => 'Unknown live portfolio'], 400);
        }
        $path = __DIR__ . '/data/live-' . $customLive . '-execution-state.json';
    } else {
        if (!isset($files[$target])) {
            respond(['ok' => false, 'error' => 'Unknown state target'], 400);
        }
        $path = $files[$target];
    }
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

    if ($target === 'paper' && $selectedStrategyId !== null && preg_match('/^[A-Za-z0-9_-]{1,64}$/', $selectedStrategyId)) {
        $name = 'portfolio:' . $selectedStrategyId;
        if (isset($manifest[$name]) && is_array($manifest[$name])) {
            $file = (string) ($manifest[$name]['file'] ?? '');
            if (preg_match('/^[A-Za-z0-9._-]+\.json$/', $file)) {
                $segment = decode_state_file(dirname($path) . '/' . $file, false);
                if (is_array($segment) && isset($segment['paperPortfolio']) && is_array($segment['paperPortfolio'])) {
                    if (!isset($data['paperPortfolios']) || !is_array($data['paperPortfolios'])) {
                        $data['paperPortfolios'] = [];
                    }
                    $data['paperPortfolios'][$selectedStrategyId] = $segment['paperPortfolio'];
                }
            }
        }
    }

    return $data;
}

function trading_storage_state_document(array $state): array
{
    // Observations live in their own indexed table. Segment descriptors only point to
    // JSON files, so retaining them after the move would make an active DB response
    // accidentally reach back into the old storage.
    unset(
        $state['marketObservations'],
        $state['resolvedMarketObservations'],
        $state['marketScan'],
        $state['stateSegments'],
    );
    return $state;
}

function trading_storage_import_observation_source(string $path, string $field): int
{
    $batch = [];
    $imported = 0;
    $flush = static function () use (&$batch, &$imported): void {
        if ($batch === []) {
            return;
        }
        $imported += trading_storage_observations_upsert($batch);
        $batch = [];
    };
    $read = stream_json_array_members($path, $field, static function (array $item) use (&$batch, $flush): bool {
        $batch[] = $item;
        if (count($batch) >= 300) {
            $flush();
        }
        return true;
    });
    $flush();
    if (!$read) {
        throw new RuntimeException('Could not stream ' . basename($path) . ' (' . $field . ').');
    }
    return $imported;
}

function trading_storage_import_event_rows(string $stream, ?string $portfolioId, array $rows): int
{
    $imported = 0;
    foreach ($rows as $row) {
        if (!is_array($row)) {
            continue;
        }
        trading_storage_event_append($stream, $portfolioId, $row);
        $imported++;
    }
    return $imported;
}

function trading_storage_import_ndjson_events(string $stream, ?string $portfolioId, array $paths): int
{
    $imported = 0;
    foreach ($paths as $path) {
        $handle = @fopen($path, 'rb');
        if ($handle === false) {
            continue;
        }
        while (($line = fgets($handle)) !== false) {
            $row = json_decode(trim($line), true);
            if (is_array($row)) {
                trading_storage_event_append($stream, $portfolioId, $row);
                $imported++;
            }
        }
        fclose($handle);
    }
    return $imported;
}

function trading_storage_import_json_state(): array
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        throw new RuntimeException('Trading MySQL storage is not configured or reachable.');
    }
    trading_storage_bootstrap($pdo);

    $config = load_portfolio_config();
    $preferences = load_scan_preferences();
    trading_storage_document_put('portfolio-config', 'portfolio-config', $config);
    trading_storage_document_put('scan-preferences', 'preferences', $preferences);

    $targets = ['paper', 'live', 'live-execution', 'live-5050-execution'];
    foreach (array_keys(is_array($config['livePortfolios'] ?? null) ? $config['livePortfolios'] : []) as $id) {
        if (is_string($id) && preg_match('/^[a-z][a-zA-Z0-9]{1,30}$/', $id)) {
            $targets[] = 'live-custom-' . $id . '-execution';
        }
    }
    $targets = array_values(array_unique($targets));
    $files = state_file_paths();
    $counts = ['stateDocuments' => 0, 'paperPortfolioDocuments' => 0, 'observations' => 0, 'events' => 0, 'missingStateFiles' => 0];

    foreach ($targets as $target) {
        $customLive = custom_live_portfolio_id_from_execution_target($target);
        $path = $customLive !== null
            ? __DIR__ . '/data/live-' . $customLive . '-execution-state.json'
            : ($files[$target] ?? null);
        if (!is_string($path) || !is_file($path)) {
            $counts['missingStateFiles']++;
            continue;
        }
        $core = decode_state_file($path, false);
        if (!is_array($core)) {
            throw new RuntimeException('Could not read state file ' . basename($path) . '.');
        }
        trading_storage_document_put('state:' . $target, 'state', trading_storage_state_document($core));
        $counts['stateDocuments']++;
        $counts['events'] += trading_storage_import_event_rows('state-run-log', $target, is_array($core['runLog'] ?? null) ? $core['runLog'] : []);

        if ($target !== 'paper') {
            continue;
        }
        $manifest = is_array($core['stateSegments'] ?? null) ? $core['stateSegments'] : [];
        foreach (['observations' => 'marketObservations', 'resolvedObservations' => 'resolvedMarketObservations'] as $segment => $field) {
            $source = state_segment_path($core, $path, $segment);
            if ($source === null && !array_key_exists($field, $core)) {
                continue;
            }
            $source ??= $path;
            $counts['observations'] += trading_storage_import_observation_source($source, $field);
        }
        foreach ($manifest as $name => $meta) {
            if (!is_string($name) || !str_starts_with($name, 'portfolio:')) {
                continue;
            }
            $id = substr($name, strlen('portfolio:'));
            if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', $id)) {
                continue;
            }
            $segmentPath = state_segment_path($core, $path, $name);
            $segment = $segmentPath === null ? null : decode_state_file($segmentPath, false);
            $portfolio = is_array($segment['paperPortfolio'] ?? null) ? $segment['paperPortfolio'] : null;
            if (!is_array($portfolio)) {
                continue;
            }
            trading_storage_document_put('paper-portfolio:' . $id, 'paper-portfolio', $portfolio);
            $counts['paperPortfolioDocuments']++;
            $counts['events'] += trading_storage_import_event_rows('portfolio-run-log', $id, is_array($portfolio['runLog'] ?? null) ? $portfolio['runLog'] : []);
        }
        $counts['events'] += trading_storage_import_event_rows('market-scan-history', null, is_array($core['marketScanHistory'] ?? null) ? $core['marketScanHistory'] : []);
    }

    $counts['events'] += trading_storage_import_ndjson_events(
        'portfolio-config-history',
        null,
        [portfolio_config_history_path()],
    );
    $counts['events'] += trading_storage_import_ndjson_events(
        'market-scan-history',
        null,
        glob(__DIR__ . '/data/market-scan-history/*.ndjson') ?: [],
    );
    foreach (glob(__DIR__ . '/data/portfolio-run-log/*/*.ndjson') ?: [] as $path) {
        $portfolioId = basename(dirname($path));
        $counts['events'] += trading_storage_import_ndjson_events('portfolio-run-log', $portfolioId, [$path]);
    }
    trading_storage_meta_put('json-imported-at', gmdate('c'));
    trading_storage_meta_put('json-import-counts', json_encode($counts, JSON_UNESCAPED_SLASHES) ?: '{}');
    return $counts;
}

function trading_storage_allowed_ingest_target(string $target): bool
{
    if (in_array($target, ['paper', 'live', 'live-execution', 'live-5050-execution'], true)) {
        return true;
    }
    return preg_match('/^live-custom-[a-z][a-zA-Z0-9]{1,30}-execution$/', $target) === 1;
}

function trading_storage_ingest(array $payload): array
{
    $target = trim((string) ($payload['target'] ?? ''));
    $hasState = array_key_exists('state', $payload);
    $state = $payload['state'] ?? null;
    if (!trading_storage_allowed_ingest_target($target) || ($hasState && !is_array($state))) {
        throw new InvalidArgumentException('A valid state target and an optional object state payload are required.');
    }
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        throw new RuntimeException('Trading MySQL storage is not configured or reachable.');
    }
    trading_storage_bootstrap($pdo);
    if ($hasState) {
        trading_storage_document_put('state:' . $target, 'state', trading_storage_state_document($state));
    }

    $observationCount = 0;
    $observations = $payload['observations'] ?? [];
    if (is_array($observations)) {
        if (count($observations) > 1000) {
            throw new InvalidArgumentException('An ingest batch may contain at most 1000 observations.');
        }
        $observationCount = trading_storage_observations_upsert($observations);
    }

    $portfolioDocuments = 0;
    if ($target === 'paper' && is_array($payload['paperPortfolios'] ?? null)) {
        foreach ($payload['paperPortfolios'] as $id => $portfolio) {
            if (!is_string($id) || !preg_match('/^[A-Za-z0-9_-]{1,64}$/', $id) || !is_array($portfolio)) {
                continue;
            }
            trading_storage_document_put('paper-portfolio:' . $id, 'paper-portfolio', $portfolio);
            $portfolioDocuments++;
        }
    }

    $eventCount = 0;
    $events = $payload['events'] ?? [];
    if (is_array($events)) {
        if (count($events) > 1000) {
            throw new InvalidArgumentException('An ingest batch may contain at most 1000 events.');
        }
        foreach ($events as $event) {
            if (!is_array($event) || !is_array($event['payload'] ?? null)) {
                continue;
            }
            $stream = trim((string) ($event['stream'] ?? ''));
            $portfolioId = isset($event['portfolioId']) ? trim((string) $event['portfolioId']) : null;
            if (!preg_match('/^[a-z0-9_-]{1,64}$/', $stream) || ($portfolioId !== null && !preg_match('/^[A-Za-z0-9_-]{1,80}$/', $portfolioId))) {
                continue;
            }
            trading_storage_event_append($stream, $portfolioId, $event['payload'], isset($event['occurredAt']) ? (string) $event['occurredAt'] : null);
            $eventCount++;
        }
    }

    trading_storage_meta_put('last-ingest-at', gmdate('c'));
    return [
        'target' => $target,
        'observations' => $observationCount,
        'paperPortfolioDocuments' => $portfolioDocuments,
        'events' => $eventCount,
    ];
}

function trading_storage_safe_migration_error(Throwable $error): string
{
    // The migration runs only on the host's own files and localhost database. Keep the
    // public health endpoint useful without exposing a DSN or an accidental credential
    // fragment if a provider includes one in an exception message.
    $message = preg_replace('/(?:password|pwd)\s*=\s*[^\s;]+/i', '$1=[redacted]', $error->getMessage()) ?? 'Migration failed.';
    return substr(trim($message), 0, 300);
}

/**
 * paper-state.json runs tens of megabytes once a few paper portfolios accumulate
 * real trade history, and this hosting's file replication for something that size
 * is not always read-your-writes consistent: a request can occasionally decode an
 * older copy that is still perfectly valid JSON but predates a portfolio's first
 * trade, so that portfolio's entry in paperPortfolios is simply absent (not blank
 * -- absent, since it was never written at all in that older copy). Every
 * portfolio saved in portfolio-config.json always has a paperPortfolios entry
 * once the bot has run even once (normalizeState() seeds a blank one for every
 * configured strategy immediately), so a configured id missing here is never
 * legitimate -- it means this read raced an in-flight replication, and re-reading
 * a moment later almost always sees the current copy.
 */
function paper_state_with_consistent_portfolios(array $payload, string $summary, ?string $selectedStrategyId = null): array
{
    $config = load_portfolio_config();
    $configuredPaper = is_array($config['paper'] ?? null) ? $config['paper'] : [];
    $configuredIds = array_keys($configuredPaper);
    if ($configuredIds === []) {
        return $payload;
    }
    for ($attempt = 0; !trading_storage_is_active() && $attempt < 4; $attempt++) {
        $portfolios = is_array($payload['paperPortfolios'] ?? null) ? $payload['paperPortfolios'] : [];
        if (array_diff($configuredIds, array_keys($portfolios)) === []) {
            break;
        }
        usleep(250000);
        clearstatcache(true, state_file_paths()['paper']);
        $payload = state_payload('paper', state_segments_for_summary($summary), $selectedStrategyId);
    }

    // Saving a new portfolio changes its rules immediately, while its first scheduled
    // bot pass may still be minutes away. Return a stable empty account in that gap so
    // the new row is visible with its own $100 paper capital, rather than disappearing
    // from the overview or borrowing another portfolio's figures.
    if (!isset($payload['paperPortfolios']) || !is_array($payload['paperPortfolios'])) {
        $payload['paperPortfolios'] = [];
    }
    foreach ($configuredPaper as $id => $portfolioConfig) {
        if (!is_array($portfolioConfig) || ($portfolioConfig['archived'] ?? false) === true || isset($payload['paperPortfolios'][$id])) {
            continue;
        }
        $payload['paperPortfolios'][$id] = empty_configured_paper_portfolio((string) $id, $portfolioConfig);
    }

    // An archive snapshot is the preferred historical record, but older portfolios
    // were archived before snapshotting existed. Their trades still live in their
    // small per-portfolio segments. Load those segments only for the dashboard
    // archive summary so "0 resolved" never replaces a real historical count.
    if ($summary === 'dashboard') {
        if (trading_storage_is_active()) {
            foreach ($configuredPaper as $id => $portfolioConfig) {
                if (!is_array($portfolioConfig) || ($portfolioConfig['archived'] ?? false) !== true) {
                    continue;
                }
                $portfolio = trading_storage_document_get('paper-portfolio:' . $id);
                if (is_array($portfolio)) {
                    $payload['paperPortfolios'][$id] = $portfolio;
                }
            }
            return $payload;
        }
        $manifest = is_array($payload['stateSegments'] ?? null) ? $payload['stateSegments'] : [];
        foreach ($configuredPaper as $id => $portfolioConfig) {
            if (!is_array($portfolioConfig) || ($portfolioConfig['archived'] ?? false) !== true) {
                continue;
            }
            $segmentName = 'portfolio:' . $id;
            $segmentMeta = is_array($manifest[$segmentName] ?? null) ? $manifest[$segmentName] : [];
            $file = (string) ($segmentMeta['file'] ?? '');
            if (!preg_match('/^[A-Za-z0-9._-]+\.json$/', $file)) {
                continue;
            }
            $segment = decode_state_file(dirname(state_file_paths()['paper']) . '/' . $file, false);
            if (is_array($segment['paperPortfolio'] ?? null)) {
                $payload['paperPortfolios'][$id] = $segment['paperPortfolio'];
            }
        }
    }
    return $payload;
}

/**
 * Dashboard shape for a saved paper portfolio before its first worker pass. The bot
 * replaces this transient shape with its fully normalized state on the next run.
 */
function empty_configured_paper_portfolio(string $id, array $config): array
{
    $initialUsdc = 100.0;
    $stakeUsdc = is_numeric($config['stakeUsdc'] ?? null) ? (float) $config['stakeUsdc'] : 5.0;
    $minProbability = is_numeric($config['minProbability'] ?? null) ? (float) $config['minProbability'] : 0.5;
    $maxProbability = normalize_optional_probability_value($config['maxProbability'] ?? null);
    $maxResolutionDays = is_numeric($config['maxResolutionDays'] ?? null) ? (int) $config['maxResolutionDays'] : 7;
    $minLiquidityUsdc = is_numeric($config['minLiquidityUsdc'] ?? null) ? (float) $config['minLiquidityUsdc'] : null;
    $selectionOrder = (string) ($config['selectionOrder'] ?? 'highest_ev_pa_first');
    $portfolio = [
        'initialUsdc' => $initialUsdc,
        'equityUsdc' => $initialUsdc,
        'cashUsdc' => $initialUsdc,
        'freeCapitalUsdc' => $initialUsdc,
        'openRiskUsdc' => 0.0,
        'marketValueUsdc' => 0.0,
        'totalPnlUsdc' => 0.0,
        'totalPnlPct' => 0.0,
        'realizedPnlUsdc' => 0.0,
        'realizedPnlPct' => 0.0,
        'openPnlUsdc' => 0.0,
        'openPnlPct' => 0.0,
        'closedTrades' => 0,
        'wins' => 0,
        'stakeUsdc' => $stakeUsdc,
        'minProbability' => $minProbability,
        'maxProbability' => $maxProbability,
        'maxResolutionDays' => $maxResolutionDays,
        'minLiquidityUsdc' => $minLiquidityUsdc,
        'minNetYield' => is_numeric($config['minNetYield'] ?? null) ? (float) $config['minNetYield'] : 0.0,
        'executionTrigger' => (string) ($config['executionTrigger'] ?? 'cron'),
        'marketType' => (string) ($config['marketType'] ?? 'all'),
        'probabilitySource' => (string) ($config['probabilitySource'] ?? 'ai'),
    ];

    return [
        'id' => $id,
        'label' => normalize_portfolio_display_name($config['displayName'] ?? null, $id),
        'displayName' => normalize_portfolio_display_name($config['displayName'] ?? null, $id),
        'selectionMetric' => $selectionOrder === 'highest_reward_risk_first' ? 'Reward / risk' : 'EV p.a.',
        'selectionOrder' => $selectionOrder,
        'minProbability' => $minProbability,
        'maxProbability' => $maxProbability,
        'stakeUsdc' => $stakeUsdc,
        'maxResolutionDays' => $maxResolutionDays,
        'minLiquidityUsdc' => $minLiquidityUsdc,
        'minNetYield' => $portfolio['minNetYield'],
        'executionTrigger' => $portfolio['executionTrigger'],
        'marketType' => $portfolio['marketType'],
        'probabilitySource' => $portfolio['probabilitySource'],
        'portfolio' => $portfolio,
        'trades' => [],
        'runLog' => [],
        'lastDecision' => null,
    ];
}

/**
 * True retained row counts, taken from the manifest rather than from the rows that
 * survived response truncation. The scraped tabs show these in parentheses; deriving
 * them from a truncated payload is what made them look like they were shrinking.
 */
function state_observation_totals(array $data): array
{
    if (trading_storage_is_active()) {
        $counts = trading_storage_observation_counts();
        $active = max(0, (int) ($counts['SCRAPED'] ?? 0));
        $resolved = max(0, (int) ($counts['RESOLVED'] ?? 0));
        return ['active' => $active, 'scraped' => $active, 'resolved' => $resolved, 'all' => $active + $resolved];
    }
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
    return ['active' => $active, 'scraped' => $active, 'resolved' => $resolved, 'all' => $active + $resolved];
}

/**
 * Absolute path of a segment file named by the manifest, or null when the state is
 * not segmented or does not carry that segment.
 */
function state_segment_path(array $data, string $corePath, string $segment): ?string
{
    $manifest = is_array($data['stateSegments'] ?? null) ? $data['stateSegments'] : [];
    $file = (string) ($manifest[$segment]['file'] ?? '');
    // The manifest is generated data, but it still reaches this code as file content,
    // so the name is constrained to a plain sibling file.
    if ($file === '' || !preg_match('/^[A-Za-z0-9._-]+\.json$/', $file)) {
        return null;
    }
    $path = dirname($corePath) . '/' . $file;

    return is_file($path) ? $path : null;
}

/**
 * Walk a large top-level JSON array one member at a time.
 *
 * The resolved archive has reached 26,207 rows, and json_decode of the whole file
 * peaks near 138 MB on a 128 MB host -- which is exactly why the browser is served a
 * capped page of it. A drill-down from the performance tables has to reach every row
 * those tables counted, so this scans the file structurally and decodes one member at
 * a time. The buffer is trimmed after every member, so peak memory stays at one read
 * chunk plus one row plus whatever the caller chooses to keep, however far the
 * archive grows.
 *
 * $accepts receives the raw member text and may reject it before it is ever decoded;
 * a tag drill-down uses that to skip the ~95% of rows that cannot possibly match.
 * $onRow receives each decoded member and returns false to stop the walk.
 */
function stream_json_array_members(string $path, string $field, callable $onRow, ?callable $accepts = null): bool
{
    $handle = @fopen($path, 'rb');
    if ($handle === false) {
        return false;
    }

    $chunkSize = 1 << 19;
    $buffer = '';
    $eof = false;
    $fill = static function () use (&$buffer, &$eof, $handle, $chunkSize): bool {
        if ($eof) {
            return false;
        }
        $data = fread($handle, $chunkSize);
        if ($data === false || $data === '') {
            $eof = true;
            return false;
        }
        $buffer .= $data;
        return true;
    };

    // Position the scan just past the opening bracket of the named array. The name is
    // only accepted when the punctuation that follows it makes it a key holding an
    // array, so the same text appearing inside a string value cannot derail the walk.
    $needle = '"' . $field . '"';
    $entered = false;
    while (true) {
        $at = strpos($buffer, $needle);
        if ($at === false) {
            $keep = strlen($needle);
            if (strlen($buffer) > $keep) {
                $buffer = substr($buffer, -$keep);
            }
            if (!$fill()) {
                break;
            }
            continue;
        }
        $probe = $at + strlen($needle);
        while (strlen($buffer) < $probe + 32 && $fill()) {
            // Make sure the punctuation after the name is in the buffer.
        }
        $rest = ltrim(substr($buffer, $probe, 32));
        if (strncmp($rest, ':', 1) === 0 && strncmp(ltrim(substr($rest, 1)), '[', 1) === 0) {
            $open = strpos($buffer, '[', $probe);
            if ($open !== false) {
                $buffer = substr($buffer, $open + 1);
                $entered = true;
                break;
            }
        }
        $buffer = substr($buffer, $at + 1);
    }
    if (!$entered) {
        fclose($handle);
        return false;
    }

    $index = 0;
    $depth = 0;
    $inString = false;
    $escaped = false;
    $memberStart = null;
    $stopped = false;
    while (!$stopped) {
        $length = strlen($buffer);
        if ($index >= $length) {
            if (!$fill()) {
                break;
            }
            continue;
        }
        if ($inString) {
            $cursor = $index;
            while ($cursor < $length) {
                if ($escaped) {
                    $escaped = false;
                    $cursor += 1;
                    continue;
                }
                $cursor += strcspn($buffer, "\"\\", $cursor);
                if ($cursor >= $length) {
                    break;
                }
                if ($buffer[$cursor] === '\\') {
                    $escaped = true;
                    $cursor += 1;
                    continue;
                }
                $inString = false;
                $cursor += 1;
                break;
            }
            $index = $cursor;
            continue;
        }
        $index += strcspn($buffer, "{}[]\"", $index);
        if ($index >= $length) {
            if (!$fill()) {
                break;
            }
            continue;
        }
        $character = $buffer[$index];
        if ($character === '"') {
            $inString = true;
            $index += 1;
            continue;
        }
        if ($character === '{' || $character === '[') {
            if ($depth === 0) {
                $memberStart = $index;
            }
            $depth += 1;
            $index += 1;
            continue;
        }
        if ($depth === 0) {
            // The closing bracket of the array itself.
            break;
        }
        $depth -= 1;
        $index += 1;
        if ($depth !== 0 || $memberStart === null) {
            continue;
        }
        $raw = substr($buffer, $memberStart, $index - $memberStart);
        if ($accepts === null || $accepts($raw)) {
            $member = json_decode($raw, true);
            if (is_array($member) && $onRow($member) === false) {
                $stopped = true;
            }
            unset($member);
        }
        unset($raw);
        // Nothing before this point can be needed again, so the buffer never grows
        // past one member plus one read chunk.
        $buffer = substr($buffer, $index);
        $index = 0;
        $memberStart = null;
    }

    fclose($handle);

    return true;
}

/**
 * The entry price the performance tables simulate, ported from the bot's
 * scrapedSimulationProbability(). A settled book prints 0 or 1, so a row is priced by
 * the first genuinely live quote it ever carried.
 */
function simulation_entry_probability(array $item): ?float
{
    foreach (['firstMarketProbability', 'lastLiveMarketProbability', 'marketProbability', 'marketPrice'] as $field) {
        $value = $item[$field] ?? null;
        if (!is_numeric($value)) {
            continue;
        }
        $numeric = (float) $value;
        if ($numeric > 0 && $numeric < 1) {
            return $numeric;
        }
    }

    return null;
}

/**
 * 1 for a settled win, 0 for a settled loss, null while the market has no result.
 * The performance tables count exactly the rows this answers non-null for.
 */
function simulation_outcome(array $item): ?int
{
    $value = $item['finalOutcomePrice'] ?? null;
    if (!is_numeric($value)) {
        return null;
    }
    $numeric = (float) $value;
    if ($numeric < 0 || $numeric > 1) {
        return null;
    }

    return $numeric >= 0.5 ? 1 : 0;
}

/**
 * The taxonomy labels the performance tables group a row under, ported from the
 * bot's scrapedSimulationTaxonomy(). Scrape-time relations win, the current Gamma
 * relation is the fallback for rows stored before the immutable field existed, and
 * per-fixture slugs are dropped because they group exactly one opportunity.
 */
function simulation_taxonomy_labels(array $item, string $firstField, string $currentField): array
{
    $first = is_array($item[$firstField] ?? null) ? $item[$firstField] : [];
    $current = is_array($item[$currentField] ?? null) ? $item[$currentField] : [];
    $source = $first !== [] ? $first : $current;
    $labels = [];
    foreach ($source as $raw) {
        $text = '';
        if (is_array($raw)) {
            // Gamma returns tags both as plain strings and as {label,slug} objects.
            foreach (['slug', 'label', 'name'] as $key) {
                if (isset($raw[$key]) && is_scalar($raw[$key]) && (string) $raw[$key] !== '') {
                    $text = (string) $raw[$key];
                    break;
                }
            }
        } elseif (is_scalar($raw)) {
            $text = (string) $raw;
        }
        $text = strtolower(trim($text));
        if ($text === '' || strlen($text) > 60) {
            continue;
        }
        if (preg_match('/^(market|event|team|match|topic|entity)\s*:/i', $text)) {
            continue;
        }
        if (preg_match('/-(?:19|20)\d{2}-\d{2}-\d{2}(?:-|$)/', $text)) {
            continue;
        }
        if (in_array($text, $labels, true)) {
            continue;
        }
        $labels[] = $text;
        // PAPER_SCRAPED_SIMULATION_TAGS_PER_TRADE in the bot.
        if (count($labels) >= 8) {
            break;
        }
    }

    return $labels;
}

/**
 * The "Open now" population of the performance tables: an unsettled row that can
 * still actually be opened, not merely one that is waiting for settlement.
 */
function simulation_row_is_open(array $item): bool
{
    return strtoupper((string) ($item['status'] ?? $item['selectionStatus'] ?? '')) !== 'RESOLVED'
        && ($item['marketClosed'] ?? null) !== true
        && ($item['acceptingOrders'] ?? null) !== false;
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
        // The width of the quote the row was discovered at. Without it an executor
        // reading this compact response cannot tell a real price from the midpoint of a
        // book with no counterparty in it, which is what the spread gate exists to reject.
        'firstSpread',
        'firstBestAsk',
        'firstBestBid',
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
        'bestAsk',
        'bestBid',
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

/**
 * How wide a bid/ask spread may be before a row stops counting as tradable, in
 * probability units. Mirrors PAPER_MAX_TRADABLE_SPREAD in the bot; the two have to agree
 * or the execution shortlist lists rows the run will refuse.
 */
const MAX_TRADABLE_SPREAD = 0.05;

/**
 * The width of a row's quote, or null when nothing on it says. Reads the live quote first,
 * matching the bot's entry-side reader: an order is placed against the book as it is now,
 * and the discovery-time figure is only the fallback for a row not yet re-scanned.
 */
function observation_spread(array $item): ?float
{
    foreach ([['spread', 'bestAsk', 'bestBid'], ['firstSpread', 'firstBestAsk', 'firstBestBid']] as [$stated, $askKey, $bidKey]) {
        if (is_numeric($item[$stated] ?? null)) {
            return abs((float) $item[$stated]);
        }
        if (is_numeric($item[$askKey] ?? null) && is_numeric($item[$bidKey] ?? null)) {
            return abs((float) $item[$askKey] - (float) $item[$bidKey]);
        }
    }
    return null;
}

/**
 * Was there a counterparty close enough to trade against? Measured on the 600 newest open
 * markets: the median spread is 90 points and 87% of them are wider than 10 points with no
 * 24h volume at all.
 *
 * A row that recorded no spread cannot answer. The newer execution shortlist admits it so
 * an unfinished scan does not stall a portfolio; the historical statistics do too, because
 * most archived rows predate spread collection. A known wide book is still rejected in
 * both places, which is the actionable evidence against a fill.
 */
function observation_spread_is_tradable(array $item, bool $unknownIsTradable = false): bool
{
    $spread = observation_spread($item);
    if ($spread === null) {
        return $unknownIsTradable;
    }
    return $spread <= MAX_TRADABLE_SPREAD;
}

/**
 * Whether an event is two-sided or a field of mutually exclusive alternatives. A port of
 * reportMarketType() in paper-trading-bot.mjs, and it has to stay a port: this endpoint
 * builds the execution shortlist that the bot then re-filters with the JS original, so a
 * disagreement shows the screen one set of candidates and trades another.
 *
 * The count of outcomes cannot answer this on its own, which is what the old
 * `outcomeCount > 2 ? multi : binary` line here got wrong. Polymarket quotes a field as one
 * Yes/No market per member -- an election candidate, a correct-score line -- so every one
 * of them carries exactly two outcomes and read as "binary". A portfolio set to `multi`
 * therefore matched nothing at all: measured on production, 0 rows of 1,060. And the
 * converse is just as wrong: a home/draw/away result has three outcomes and is still one
 * fixture with two sides to bet.
 */
function observation_market_type(array $item): string
{
    $question = (string) ($item['question'] ?? '');
    $slug = (string) ($item['eventSlug'] ?? $item['slug'] ?? '');
    $haystack = $slug . ' ' . $question;
    $outcome = strtolower(trim((string) ($item['outcome'] ?? '')));
    $outcomeCount = is_numeric($item['outcomeCount'] ?? null) ? (int) $item['outcomeCount'] : null;

    // A field of alternatives, whatever one member's book looks like. First, because an
    // election candidate and a correct-score line are both quoted Yes/No.
    $multiField = '/(exact|correct)[-\s]?score'
        . '|\belections?\b|\bprimary\b|\bcaucus\b|\bballot\b|\breferend'
        . '|\bnominee\b|\bnomination\b|\baward\b|\boscars?\b|\bgrammys?\b'
        . '|\bnobel\b|\bballon\b|\bmvp\b'
        . '|group[-\s]winner|\btop[-\s]scorer\b|\boutright\b|winner[-\s]of\b'
        . '|\bnext\s+(president|prime\s+minister|pope|chancellor|leader|ceo)\b/i';
    if (preg_match($multiField, $haystack) === 1) {
        return 'multi';
    }
    // A bracket ("400-419 tweets", "150+ seats") is one band of a range that is carved into
    // several. The lookarounds keep calendar dates and dated slugs out.
    if (preg_match('/(?<![\d-])\d{1,3}\s?-\s?\d{1,3}(?![\d-])|(?<![\d-])\d{1,4}\+/', $question) === 1) {
        return 'multi';
    }
    // Two named sides settle it before any question-word guess: in "Team Spirit vs Team
    // Liquid - Game 2 Winner", "winner" means one of these two and nothing else.
    $twoSided = '/\bvs\.?\b|\bv\.\b|\s@\s'
        . '|\bhandicap\b|\bspread\b|\bmoneyline\b|\bpuck\s?line\b|\brun\s?line\b'
        . '|over\s?\/\s?under|\bo\s?\/\s?u\b/i';
    if (preg_match($twoSided, $haystack) === 1) {
        return 'binary';
    }
    if (in_array($outcome, ['yes', 'no', 'over', 'under', 'up', 'down', 'even', 'odd', 'home', 'away', 'draw', 'tie'], true)) {
        return 'binary';
    }
    // Only now can more than two outcomes mean a field. Deliberately after the two-sided
    // tests: a home/draw/away result carries three outcomes and is still one fixture.
    if ($outcomeCount !== null && $outcomeCount > 2) {
        return 'multi';
    }
    // One entity named against a competition instead of an opponent.
    if (preg_match('/^(which|who|what|how many)\b/i', $question) === 1) {
        return 'multi';
    }
    if (preg_match('/\bwins?\b[^?]*\b(cup|league|championship|title|tournament|final|open|series|medal|division|conference|playoffs?)\b/i', $question) === 1) {
        return 'multi';
    }
    // A plain proposition about one thing happening or not.
    if (preg_match('/^(will|is|are|can|does|do|did|has|have|was|were)\b/i', $question) === 1) {
        return 'binary';
    }
    // Left over: a single named outcome with no opponent and none of the pair vocabulary is
    // one member of a field. A Yes/No label with none of the above is still a proposition.
    return ($outcome === 'yes' || $outcome === 'no') ? 'binary' : 'multi';
}

/**
 * O/U totals are a separate portfolio policy from the broad Yes/No market type.
 * The outcome alone is intentionally insufficient: it must be accompanied by a total
 * line in the question or a recognised Gamma/Polymarket slug.
 */
function observation_is_over_under_market(array $item): bool
{
    $question = (string) ($item['question'] ?? '');
    $slug = (string) ($item['eventSlug'] ?? $item['slug'] ?? '');
    $outcome = strtolower(trim((string) ($item['outcome'] ?? '')));
    $text = $slug . ' ' . $question;
    if (preg_match('/(?:\bo\s*\/\s*u\b|over\s*\/\s*under|over\s+under|\btotal(?:\s+(?:goals?|points?|runs?|maps?|rounds?|kills?|games?|sets?))?\s*(?:o\s*\/\s*u\s*)?\d+(?:[.,]\d+)?\b)/i', $text) === 1) {
        return true;
    }
    if (preg_match('/(?:^|[-_])(?:o[-_]?u|over[-_]?under|total[-_]\d)/i', $slug) === 1) {
        return true;
    }
    return in_array($outcome, ['over', 'under'], true)
        && preg_match('/(?:\bo\s*\/\s*u\b|\bover\b|\bunder\b|\btotal\b|\b\d+(?:[.,]\d+)?\b)/i', $question) === 1;
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
    // A passed date is not a resolution. Gamma's end date and scheduled start are
    // frequently wrong -- a fixture is rescheduled, a market is listed with a placeholder
    // date, an event runs long -- and Polymarket goes on accepting orders throughout.
    // Dropping those rows here meant a market that was still tradable never reached the
    // execution shortlist at all, so the opportunity was refused on the strength of a date
    // rather than on anything the exchange said.
    //
    // The checks above are what actually decide it, and they read the exchange rather than
    // the calendar: a resolved, closed, expired or settled status, or a resolution status
    // of pending/final-price/not-accepting-orders. Those are set by the scan from the
    // market's own state, so "really resolved" has evidence behind it. Until that evidence
    // arrives the row stays a candidate.
    //
    // Keeping them is safe because nothing trades on this list alone: the live executor
    // revalidates every candidate against the CLOB before it orders, and refuses one whose
    // market is not accepting orders. A stale row therefore costs a revalidation call, not
    // a bad order -- which is the right way round, because the reverse cost a real
    // opportunity every time a date was wrong.
    return true;
}

/**
 * The candidates tab used to receive the whole active market catalogue and only
 * then apply a portfolio's static rules in the browser. That response grows with
 * every scrape and was large enough to make the PHP endpoint intermittently run
 * out of memory. These are deliberately only the stable, saved rules; the
 * browser and executor still perform their own final quote/risk checks.
 */
function execution_scope_strategy_config(?string $strategyId): ?array
{
    if ($strategyId === null || !preg_match('/^[A-Za-z0-9_-]{1,64}$/', $strategyId)) {
        return null;
    }
    $config = load_portfolio_config();
    if ($strategyId === 'live' || $strategyId === 'live5050') {
        return is_array($config[$strategyId] ?? null) ? $config[$strategyId] : null;
    }
    if (preg_match('/^live-custom-([a-z][a-zA-Z0-9]{1,30})$/', $strategyId, $matches) === 1) {
        $id = $matches[1];
        return is_array($config['livePortfolios'][$id] ?? null) ? $config['livePortfolios'][$id] : null;
    }
    return is_array($config['paper'][$strategyId] ?? null) ? $config['paper'][$strategyId] : null;
}

function execution_scope_observation_tags(array $item): array
{
    $values = [];
    foreach (['polymarketTags', 'tags', 'firstPolymarketTags', 'firstTags', 'polymarketCategories', 'firstPolymarketCategories', 'riskCategory'] as $key) {
        $raw = $item[$key] ?? null;
        if (is_array($raw)) {
            foreach ($raw as $entry) {
                if (is_array($entry)) {
                    $values[] = $entry['slug'] ?? $entry['name'] ?? $entry['label'] ?? '';
                } else {
                    $values[] = $entry;
                }
            }
        } elseif ($raw !== null) {
            $values[] = $raw;
        }
    }
    return normalize_market_tag_list($values);
}

function execution_scope_matches_observation(array $item, array $config): bool
{
    if (!is_active_scraped_market_observation($item)) {
        return false;
    }
    $probability = is_numeric($item['marketProbability'] ?? null) ? (float) $item['marketProbability'] : null;
    $minimum = normalize_probability_value($config['minProbability'] ?? null, 0.01);
    $maximum = normalize_optional_probability_value($config['maxProbability'] ?? null);
    if ($probability === null || $probability < $minimum || ($maximum !== null && $probability > $maximum)) {
        return false;
    }
    $days = is_numeric($item['daysToResolution'] ?? null) ? (float) $item['daysToResolution'] : null;
    $maxDays = normalize_optional_days_value($config['maxResolutionDays'] ?? null);
    if ($days !== null && $maxDays !== null && $days > $maxDays) {
        return false;
    }
    $minimumLiquidity = normalize_optional_money_value($config['minLiquidityUsdc'] ?? null);
    $liquidity = is_numeric($item['volumeUsdc'] ?? null)
        ? (float) $item['volumeUsdc']
        : (float) ($item['liquidity'] ?? 0);
    if ($minimumLiquidity !== null && $liquidity < $minimumLiquidity) {
        return false;
    }
    // The same gate the bot applies at entry, including its treatment of a row that has not
    // recorded a spread yet. This endpoint feeds the execution shortlist, so shipping rows
    // the bot will then reject would make the screen disagree with the run -- and a market
    // quoting a 90-point spread has no counterparty to fill an order at all.
    if (!observation_spread_is_tradable($item, true)) {
        return false;
    }
    $minimumYield = normalize_net_yield_value($config['minNetYield'] ?? null, 0.0);
    if (is_numeric($item['netYield'] ?? null) && (float) $item['netYield'] < $minimumYield) {
        return false;
    }
    $marketType = normalize_portfolio_market_type_value($config['marketType'] ?? null, false);
    if ($marketType !== 'all' && observation_market_type($item) !== $marketType) {
        return false;
    }
    if (($config['excludeOverUnderMarkets'] ?? false) === true && observation_is_over_under_market($item)) {
        return false;
    }
    $tags = execution_scope_observation_tags($item);
    $include = normalize_market_tag_list($config['includeOnlyMarketTags'] ?? []);
    if ($include !== [] && array_intersect($include, $tags) === []) {
        return false;
    }
    if ($include === []) {
        $exclude = normalize_market_tag_list($config['excludedMarketTags'] ?? []);
        if ($exclude !== [] && array_intersect($exclude, $tags) !== []) {
            return false;
        }
    }
    return true;
}

function execution_scope_sort_value(array $item, array $config): float
{
    if (($config['selectionOrder'] ?? '') === 'highest_reward_risk_first') {
        return is_numeric($item['riskReward'] ?? null) ? (float) $item['riskReward'] : -INF;
    }
    foreach (['marketAnnualizedReturn', 'potentialAnnualizedReturn', 'annualizedReturn'] as $key) {
        if (is_numeric($item[$key] ?? null)) {
            return (float) $item[$key];
        }
    }
    return -INF;
}

const EXECUTION_SCOPE_PAGE_LIMIT = 1200;

function scoped_execution_observations(array $observations, ?string $strategyId, int $offset = 0): array
{
    $config = execution_scope_strategy_config($strategyId);
    $active = array_values(array_filter($observations, static function ($item) use ($config): bool {
        if (!is_array($item)) {
            return false;
        }
        return $config === null
            ? is_active_scraped_market_observation($item)
            : execution_scope_matches_observation($item, $config);
    }));
    // The ranking used to be skipped whenever no strategy id was supplied -- and the live
    // executor supplies none, so what it actually received was array_slice(storage order,
    // 0, 1200). Storage order is "most recently updated first": retainMarketObservations()
    // ranks the catalogue by nearest resolution to decide what to KEEP, then re-sorts the
    // merged result by update time before writing it. Update time says nothing about how
    // tradable a market is, so the cut was arbitrary with respect to the only thing that
    // matters here. Measured on production: 4998 rows in scope, 1200 served, and the live
    // portfolio's own 2-day horizon holds 4749 markets of which only 1170 reached the run.
    // Ranking before the cut costs nothing and makes the served page the frontier the
    // executor would have chosen anyway -- compareLiveCandidatePriority's primary key,
    // highest annualized return first, then the nearer resolution.
    $ordering = $config ?? [];
    usort($active, static function (array $left, array $right) use ($ordering): int {
        $return = execution_scope_sort_value($right, $ordering) <=> execution_scope_sort_value($left, $ordering);
        if ($return !== 0) {
            return $return;
        }
        $leftDays = is_numeric($left['daysToResolution'] ?? null) ? (float) $left['daysToResolution'] : INF;
        $rightDays = is_numeric($right['daysToResolution'] ?? null) ? (float) $right['daysToResolution'] : INF;
        return $leftDays <=> $rightDays;
    });
    $total = count($active);
    // A broad custom portfolio can still match thousands of rows, and decoding the whole
    // catalogue into one response is what used to exhaust the hosting memory limit. So the
    // transport stays capped -- but capped is not the same as truncated: an offset makes
    // the rest reachable in further pages instead of unreachable. Nothing is discarded
    // from the persisted catalogue either way.
    $limit = EXECUTION_SCOPE_PAGE_LIMIT;
    $offset = max(0, $offset);
    return [array_slice($active, $offset, $limit), $total, $total > $offset + $limit, $offset];
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
    if (trading_storage_is_active()) {
        foreach (trading_storage_event_records('market-scan-history', null, 5000) as $item) {
            if (!isset($item['id']) && !isset($item['runAt'])) {
                continue;
            }
            $key = (string) ($item['id'] ?? $item['runAt']);
            $byId[$key] = compact_market_scan_history_entry($item);
        }
    }
    if (!trading_storage_is_active()) {
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

// One portfolio's full run-log history: the live state only ever carries the newest
// PORTFOLIO_RUN_LOG_LIMIT rows, everything older survives only in these per-portfolio,
// per-month archives the paper-bot workflow appends to after every run.
function portfolio_run_log_records(string $strategyId, array $fallback = []): array
{
    $byRunAt = [];
    if (trading_storage_is_active()) {
        foreach (trading_storage_event_records('portfolio-run-log', $strategyId, 5000) as $item) {
            if (isset($item['runAt']) && (string) ($item['strategyId'] ?? $strategyId) === $strategyId) {
                $byRunAt[(string) $item['runAt']] = $item;
            }
        }
    }
    $safeId = preg_replace('/[^a-zA-Z0-9_-]/', '', $strategyId);
    if (!trading_storage_is_active()) {
        $archiveFiles = $safeId === '' ? [] : (glob(__DIR__ . "/data/portfolio-run-log/{$safeId}/*.ndjson") ?: []);
        sort($archiveFiles, SORT_STRING);
        foreach ($archiveFiles as $archiveFile) {
            $handle = @fopen($archiveFile, 'rb');
            if ($handle === false) {
                continue;
            }
            while (($line = fgets($handle)) !== false) {
                $item = json_decode(trim($line), true);
                if (!is_array($item) || !isset($item['runAt']) || (string) ($item['strategyId'] ?? '') !== $strategyId) {
                    continue;
                }
                $byRunAt[(string) $item['runAt']] = $item;
            }
            fclose($handle);
        }
    }
    foreach ($fallback as $item) {
        if (!is_array($item) || !isset($item['runAt']) || (string) ($item['strategyId'] ?? '') !== $strategyId) {
            continue;
        }
        $byRunAt[(string) $item['runAt']] = $item;
    }
    // Dispatches this portfolio refused. These never reached a runner, so no archive file
    // and no published state carries them -- and without them the log silently skips an
    // execution the user watched fail.
    foreach (execution_dispatch_failure_records('paper-' . $strategyId) as $item) {
        $byRunAt[(string) $item['runAt']] = $item;
    }
    $records = array_values($byRunAt);
    usort($records, static function (array $left, array $right): int {
        return strtotime((string) ($right['runAt'] ?? '')) <=> strtotime((string) ($left['runAt'] ?? ''));
    });
    return $records;
}

// The archive holds the complete diagnostic bundle for every execution run. Returning
// all of it for 24 rows made the list request several hundred kilobytes large and the
// shared host intermittently closed it before the browser received a response. The list
// only needs a human-readable verdict and the selected order; the full bundle is fetched
// on demand when someone opens one row.
function compact_portfolio_run_log_candidate(array $candidate): array
{
    $keys = [
        'id',
        'question',
        'outcome',
        'tokenId',
        'marketPrice',
        'marketProbability',
        'aiProbability',
        'netGainIfWinUsdc',
        'netYield',
        'potentialAnnualizedReturn',
        'annualizedReturn',
        'daysToResolution',
        'liquidity',
        'url',
    ];
    $compact = [];
    foreach ($keys as $key) {
        if (array_key_exists($key, $candidate)) {
            $compact[$key] = $candidate[$key];
        }
    }
    return $compact;
}

function portfolio_run_log_excerpt(mixed $value, int $length): string
{
    $text = (string) $value;
    return function_exists('mb_substr')
        ? mb_substr($text, 0, $length, 'UTF-8')
        : substr($text, 0, $length);
}

function compact_portfolio_run_log_list_record(array $run): array
{
    $batch = is_array($run['batchLog'] ?? null) ? $run['batchLog'] : [];
    $selected = is_array($batch['selected'] ?? null) ? $batch['selected'] : (is_array($run['selected'] ?? null) ? $run['selected'] : []);
    $settings = is_array($batch['settings'] ?? null) ? $batch['settings'] : [];
    $counts = is_array($batch['counts'] ?? null) ? $batch['counts'] : [];
    $capital = is_array($batch['capital'] ?? null) ? $batch['capital'] : [];
    $batchSummary = [
        'id' => $batch['id'] ?? null,
        'runAt' => $batch['runAt'] ?? ($run['runAt'] ?? null),
        'strategyId' => $batch['strategyId'] ?? ($run['strategyId'] ?? null),
        'strategyLabel' => $batch['strategyLabel'] ?? ($run['strategyLabel'] ?? null),
        'selectionMetric' => $batch['selectionMetric'] ?? ($run['selectionMetric'] ?? null),
        'action' => $batch['action'] ?? ($run['action'] ?? null),
        'reason' => portfolio_run_log_excerpt($batch['reason'] ?? $run['reason'] ?? '', 1000),
        'humanReason' => portfolio_run_log_excerpt($batch['humanReason'] ?? '', 1000),
        'explanation' => portfolio_run_log_excerpt($batch['explanation'] ?? '', 1200),
        'settings' => [
            'probabilitySource' => $settings['probabilitySource'] ?? null,
            'selectionOrder' => $settings['selectionOrder'] ?? null,
        ],
        'counts' => [
            'rankedEligible' => $counts['rankedEligible'] ?? null,
            'eligibleCandidates' => $counts['eligibleCandidates'] ?? null,
            'revalidatedCandidates' => $counts['revalidatedCandidates'] ?? null,
            'skippedForRisk' => $counts['skippedForRisk'] ?? null,
        ],
        'capital' => [
            'availableUsdc' => $capital['availableUsdc'] ?? ($run['availableCapitalUsdc'] ?? null),
            'requiredStakeUsdc' => $capital['requiredStakeUsdc'] ?? ($run['requiredStakeUsdc'] ?? null),
            'insufficientCapital' => $capital['insufficientCapital'] ?? ($run['insufficientCapital'] ?? false),
        ],
        'selected' => $selected === [] ? null : compact_portfolio_run_log_candidate($selected),
    ];

    return [
        'runAt' => $run['runAt'] ?? null,
        'runSource' => $run['runSource'] ?? null,
        'strategyId' => $run['strategyId'] ?? ($batch['strategyId'] ?? null),
        'strategyLabel' => $run['strategyLabel'] ?? ($batch['strategyLabel'] ?? null),
        'selectionMetric' => $run['selectionMetric'] ?? ($batch['selectionMetric'] ?? null),
        'evaluatedCount' => $run['evaluatedCount'] ?? null,
        'eligibleCount' => $run['eligibleCount'] ?? null,
        'action' => $run['action'] ?? ($batch['action'] ?? null),
        'reason' => portfolio_run_log_excerpt($run['reason'] ?? $batch['reason'] ?? '', 1000),
        'tradeId' => $run['tradeId'] ?? null,
        'closedTradeId' => $run['closedTradeId'] ?? null,
        'availableCapitalUsdc' => $run['availableCapitalUsdc'] ?? null,
        'requiredStakeUsdc' => $run['requiredStakeUsdc'] ?? null,
        'insufficientCapital' => (bool) ($run['insufficientCapital'] ?? false),
        'riskSkippedCount' => $run['riskSkippedCount'] ?? null,
        'batchLog' => $batchSummary,
        'detailAvailable' => $batch !== [] || is_array($run['rotationReview'] ?? null),
    ];
}

function compact_dashboard_paper_portfolio(array $portfolio, bool $includeTrades, bool $overviewOnly = false): array
{
    if ($includeTrades) {
        if (isset($portfolio['runLog']) && is_array($portfolio['runLog'])) {
            $portfolio['runLog'] = sorted_run_log_rows($portfolio['runLog']);
            $portfolio['runLog'] = array_slice($portfolio['runLog'], 0, 80);
        }
        return $portfolio;
    }

    $compact = [];
    $fields = [
        'id',
        'label',
        'displayName',
        'description',
        'selectionMetric',
        'portfolio',
        'lastTradeDate',
        'capitalAdjustmentAt',
        'archived',
    ];
    // The overview needs the balances of every portfolio, not each portfolio's
    // potentially very large decision audit. Keeping the audits out is what makes
    // switching portfolios cheap even after many execution runs.
    if (!$overviewOnly) {
        $fields[] = 'lastDecision';
    }
    foreach ($fields as $field) {
        if (array_key_exists($field, $portfolio)) {
            $compact[$field] = $portfolio[$field];
        }
    }
    $compact['historySummary'] = is_array($portfolio['historySummary'] ?? null)
        ? $portfolio['historySummary']
        : paper_portfolio_history_summary($portfolio);
    $compact['trades'] = [];
    $compact['runLog'] = [];
    return $compact;
}

/**
 * The overview omits every portfolio's trade segment from its response. It still
 * needs the first trade timestamp for ROI, so each segment is read separately and
 * reduced to its small history summary before the next segment is opened.
 */
function attach_paper_portfolio_history_summaries(array &$data): void
{
    if (!isset($data['paperPortfolios']) || !is_array($data['paperPortfolios']) || $data['paperPortfolios'] === []) {
        return;
    }

    $corePath = state_file_paths()['paper'];
    foreach ($data['paperPortfolios'] as $id => &$portfolio) {
        if (!is_array($portfolio)) {
            continue;
        }

        $source = $portfolio;
        $segmentPath = state_segment_path($data, $corePath, 'portfolio:' . (string) $id);
        if ($segmentPath !== null) {
            $segment = decode_state_file($segmentPath, false);
            if (is_array($segment['paperPortfolio'] ?? null)) {
                $source = $segment['paperPortfolio'];
            }
            unset($segment);
        }
        $portfolio['historySummary'] = paper_portfolio_history_summary($source);
    }
    unset($portfolio);
}

function sorted_run_log_rows(array $rows): array
{
    usort($rows, static function (array $left, array $right): int {
        $rightTime = strtotime((string) ($right['runAt'] ?? $right['generatedAt'] ?? $right['createdAt'] ?? '')) ?: 0;
        $leftTime = strtotime((string) ($left['runAt'] ?? $left['generatedAt'] ?? $left['createdAt'] ?? '')) ?: 0;
        return $rightTime <=> $leftTime;
    });
    return $rows;
}

function archived_trade_is_closed(array $trade): bool
{
    return in_array(strtoupper((string) ($trade['status'] ?? '')), [
        'WON', 'LOST', 'CLOSED', 'REDEEMED', 'SOLD', 'REDEEM_REQUIRED',
        'RESOLVED', 'STOP_LOSS', 'STOP_GAP', 'LIMIT_ORDER_EXPIRED',
    ], true);
}

function archived_trade_prediction_result(array $trade): ?bool
{
    $status = strtoupper((string) ($trade['status'] ?? ''));
    if (in_array($status, ['WON', 'REDEEMED', 'REDEEM_REQUIRED'], true)) {
        return true;
    }
    if (in_array($status, ['LOST', 'STOP_LOSS', 'STOP_GAP'], true)) {
        return false;
    }
    if ($status === 'LIMIT_ORDER_EXPIRED') {
        return null;
    }

    $final = $trade['finalOutcomePrice'] ?? null;
    if (is_numeric($final)) {
        $price = (float) $final;
        if ($price >= 0.995) {
            return true;
        }
        if ($price <= 0.005) {
            return false;
        }
    }
    return null;
}

function portfolio_trade_timestamp(string $value): ?int
{
    $value = trim($value);
    if ($value === '') {
        return null;
    }

    $timestamp = strtotime($value);
    if ($timestamp !== false) {
        return $timestamp;
    }

    foreach (['d.m.Y H:i:s', 'd.m.Y H:i', 'd.m.Y'] as $format) {
        $date = DateTimeImmutable::createFromFormat($format, $value);
        $errors = DateTimeImmutable::getLastErrors();
        if ($date instanceof DateTimeImmutable && ($errors === false || ((int) $errors['warning_count'] === 0 && (int) $errors['error_count'] === 0))) {
            return $date->getTimestamp();
        }
    }

    return null;
}

function paper_portfolio_history_summary(array $portfolio): array
{
    $trades = is_array($portfolio['trades'] ?? null) ? $portfolio['trades'] : [];
    $closed = 0;
    $correct = 0;
    $resolved = 0;
    $firstOpenedAt = null;
    $firstOpenedTimestamp = null;
    foreach ($trades as $trade) {
        if (!is_array($trade)) {
            continue;
        }
        $openedAt = (string) ($trade['openedAt'] ?? $trade['date'] ?? $trade['createdAt'] ?? '');
        $openedTimestamp = portfolio_trade_timestamp($openedAt);
        if ($openedTimestamp !== null && ($firstOpenedTimestamp === null || $openedTimestamp < $firstOpenedTimestamp)) {
            $firstOpenedAt = $openedAt;
            $firstOpenedTimestamp = $openedTimestamp;
        }
        if (!archived_trade_is_closed($trade)) {
            continue;
        }
        $closed++;
        $result = archived_trade_prediction_result($trade);
        if ($result === null) {
            continue;
        }
        $resolved++;
        if ($result) {
            $correct++;
        }
    }
    return [
        'tradeCount' => count($trades),
        'closedTradeCount' => $closed,
        'correctCount' => $correct,
        'resolvedCount' => $resolved,
        'accuracy' => $resolved > 0 ? $correct / $resolved : null,
        'firstOpenedAt' => $firstOpenedAt,
    ];
}

function compact_paper_portfolio_archives(array $archives, array $currentPortfolios = []): array
{
    $rowsByStrategy = [];
    foreach ($archives as $archive) {
        if (!is_array($archive) || !isset($archive['id'], $archive['strategyId'])) {
            continue;
        }
        $snapshot = is_array($archive['snapshot'] ?? null) ? $archive['snapshot'] : [];
        $history = paper_portfolio_history_summary($snapshot);
        $portfolio = is_array($snapshot['portfolio'] ?? null) ? $snapshot['portfolio'] : [];
        $strategyId = (string) $archive['strategyId'];
        $current = is_array($currentPortfolios[$strategyId] ?? null) ? $currentPortfolios[$strategyId] : [];
        $currentHistory = paper_portfolio_history_summary($current);
        // An archived strategy can still have a small placeholder state beside its
        // immutable snapshot. Keep whichever one actually carries more resolved
        // decisions; choosing merely the newest record was the source of 0-of-0
        // archive cards after a reset.
        if ((int) ($currentHistory['resolvedCount'] ?? 0) > (int) ($history['resolvedCount'] ?? 0)) {
            $history = $currentHistory;
            $portfolio = is_array($current['portfolio'] ?? null) ? $current['portfolio'] : $portfolio;
        }
        $row = [
            'id' => (string) $archive['id'],
            'strategyId' => $strategyId,
            'label' => (string) ($archive['label'] ?? $strategyId),
            'archivedAt' => (string) ($archive['archivedAt'] ?? ''),
            'reason' => (string) ($archive['reason'] ?? ''),
            'summary' => array_merge([
                'equityUsdc' => is_numeric($portfolio['equityUsdc'] ?? null) ? (float) $portfolio['equityUsdc'] : null,
            ], $history),
        ];
        $existing = $rowsByStrategy[$strategyId] ?? null;
        if ($existing === null
            || (int) ($row['summary']['resolvedCount'] ?? 0) > (int) ($existing['summary']['resolvedCount'] ?? 0)
            || ((int) ($row['summary']['resolvedCount'] ?? 0) === (int) ($existing['summary']['resolvedCount'] ?? 0)
                && (strtotime((string) ($row['archivedAt'] ?? '')) ?: 0) > (strtotime((string) ($existing['archivedAt'] ?? '')) ?: 0))) {
            $rowsByStrategy[$strategyId] = $row;
        }
    }
    $rows = array_values($rowsByStrategy);
    usort($rows, static function (array $left, array $right): int {
        return (strtotime((string) ($right['archivedAt'] ?? '')) ?: 0)
            <=> (strtotime((string) ($left['archivedAt'] ?? '')) ?: 0);
    });
    return $rows;
}

function compact_dashboard_paper_portfolios(array $data, ?string $selectedStrategyId, bool $overviewOnly): array
{
    if (!isset($data['paperPortfolios']) || !is_array($data['paperPortfolios'])) {
        if (!$overviewOnly && isset($data['runLog']) && is_array($data['runLog'])) {
            $data['runLog'] = array_slice($data['runLog'], 0, 80);
        }
        if ($overviewOnly) {
            $data['trades'] = [];
            $data['runLog'] = [];
        }
        return $data;
    }

    $selectedStrategyId = $selectedStrategyId !== null && preg_match('/^[A-Za-z0-9_-]{1,64}$/', $selectedStrategyId)
        ? $selectedStrategyId
        : null;

    foreach ($data['paperPortfolios'] as $id => $portfolio) {
        if (!is_array($portfolio)) {
            continue;
        }
        $includeTrades = !$overviewOnly && $selectedStrategyId !== null && (string) $id === $selectedStrategyId;
        $data['paperPortfolios'][$id] = compact_dashboard_paper_portfolio($portfolio, $includeTrades, $overviewOnly);
    }

    return $data;
}

function compact_state_payload(string $target, array $data, string $summary, ?string $selectedStrategyId = null, int $executionOffset = 0): array
{
    if ($target !== 'paper') {
        return $data;
    }

    if (isset($data['paperPortfolioArchives']) && is_array($data['paperPortfolioArchives'])) {
        $data['paperPortfolioArchives'] = compact_paper_portfolio_archives(
            $data['paperPortfolioArchives'],
            is_array($data['paperPortfolios'] ?? null) ? $data['paperPortfolios'] : []
        );
    }

    if ($summary === 'portfolio-overview') {
        // Archived portfolios are left out entirely. This summary exists only to fill the
        // overview table, which never lists them, so sending them was payload the browser
        // fetched and then discarded -- and it gave the table a set of rows it had to
        // filter, which is how an archived portfolio could appear for a frame.
        if (isset($data['paperPortfolios']) && is_array($data['paperPortfolios'])) {
            $data['paperPortfolios'] = array_filter(
                $data['paperPortfolios'],
                static fn ($row): bool => !is_array($row) || ($row['archived'] ?? false) !== true,
            );
        }
        attach_paper_portfolio_history_summaries($data);
        $compact = compact_dashboard_paper_portfolios($data, null, true);
        unset($compact['evaluations'], $compact['evaluationRunLog'], $compact['calculationReports'], $compact['latestCalculationReport'], $compact['runLog'], $compact['lastDecision'], $compact['marketObservations'], $compact['marketScan'], $compact['marketScanHistory'], $compact['trades']);
        $compact['evaluationDetailsMode'] = 'portfolio-overview';
        return $compact;
    }

    if ($summary === 'dashboard') {
        $compact = compact_dashboard_paper_portfolios($data, $selectedStrategyId, false);
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
        // The client now derives every portfolio shortlist from the compact
        // Polymarket `execution` response.  Keeping this legacy route small is
        // important: decoding and compacting the full AI archive (5,000+ rows)
        // exceeds the hosting memory limit and used to answer HTTP 500 before the
        // browser could request the actual shortlist.
        return [
            'schemaVersion' => $data['schemaVersion'] ?? null,
            'generatedAt' => $data['generatedAt'] ?? null,
            'evaluations' => [],
            'evaluationDetailsMode' => 'compact',
            'legacyCandidatesDisabled' => true,
        ];
    }

    if ($summary === 'execution') {
        $observations = is_array($data['marketObservations'] ?? null) ? $data['marketObservations'] : [];
        [$active, $total, $truncated, $offset] = scoped_execution_observations($observations, $selectedStrategyId, $executionOffset);
        return [
            'schemaVersion' => $data['schemaVersion'] ?? null,
            'generatedAt' => $data['generatedAt'] ?? null,
            'marketObservations' => array_map(
                static fn($item): array => is_array($item) ? compact_market_observation($item) : [],
                $active
            ),
            'executionScopeStrategyId' => $selectedStrategyId,
            'executionScopeTotal' => $total,
            'executionScopeTruncated' => $truncated,
            // Where this page sits and how wide a page is, so a caller that needs more of
            // the scope than one page carries can ask for the next one rather than
            // assuming the catalogue ends here.
            'executionScopeOffset' => $offset,
            'executionScopeLimit' => EXECUTION_SCOPE_PAGE_LIMIT,
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
                'stakeUsdc' => 5.0,
                'maxOrderFraction' => 0.05,
                'maxResolutionDays' => 7,
                'selectionOrder' => 'highest_ev_pa_first',
                'minLiquidityUsdc' => null,
                'minNetYield' => 0.0,
                'executionTrigger' => 'cron',
                // Paper portfolios default to immediate simulated fills. Unlike live,
                // their order mode is configurable and must be retained on save.
                'useLimitOrders' => false,
                'marketType' => 'all',
                'excludeOverUnderMarkets' => false,
                'requireMostProbableOutcome' => false,
                'probabilitySource' => 'ai',
                'autoRotatePositions' => true,
                // Off by default: Conservative never had a protective stop, and turning
                // this on is what makes Equal's mechanism apply here too.
                'stopLossEnabled' => false,
                'stopLossRiskMultiplier' => 0.0,
                'reverseOnStopLoss' => false,
                'excludedCandidateTokenIds' => [],
                'includeOnlyMarketTags' => [],
                'excludedMarketTags' => [],
            ],
            'highReward' => [
                'displayName' => 'High reward',
                'minProbability' => 0.6,
                'stakeUsdc' => 5.0,
                'maxOrderFraction' => 0.05,
                'maxResolutionDays' => 7,
                'selectionOrder' => 'highest_reward_risk_first',
                'minLiquidityUsdc' => null,
                'minNetYield' => 0.0,
                'executionTrigger' => 'cron',
                'useLimitOrders' => false,
                'marketType' => 'all',
                'excludeOverUnderMarkets' => false,
                'requireMostProbableOutcome' => false,
                'probabilitySource' => 'ai',
                'autoRotatePositions' => true,
                'stopLossEnabled' => false,
                'stopLossRiskMultiplier' => 0.0,
                'reverseOnStopLoss' => false,
                'excludedCandidateTokenIds' => [],
                'includeOnlyMarketTags' => [],
                'excludedMarketTags' => [],
            ],
            'moreProbable' => [
                'displayName' => 'More probable',
                'minProbability' => 0.6,
                'stakeUsdc' => 5.0,
                'maxOrderFraction' => 0.05,
                'maxResolutionDays' => 7,
                'selectionOrder' => 'highest_reward_risk_first',
                'minLiquidityUsdc' => 500000,
                'minNetYield' => 0.0,
                'executionTrigger' => 'cron',
                'useLimitOrders' => false,
                'marketType' => 'multi',
                'excludeOverUnderMarkets' => false,
                'requireMostProbableOutcome' => true,
                'probabilitySource' => 'ai',
                'autoRotatePositions' => true,
                'stopLossEnabled' => false,
                'stopLossRiskMultiplier' => 0.0,
                'reverseOnStopLoss' => false,
                'excludedCandidateTokenIds' => [],
                'includeOnlyMarketTags' => [],
                'excludedMarketTags' => [],
            ],
            'equal' => [
                'displayName' => 'Equal',
                'minProbability' => 0.75,
                'stakeUsdc' => 5.0,
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
                'useLimitOrders' => false,
                'marketType' => 'all',
                'excludeOverUnderMarkets' => false,
                'requireMostProbableOutcome' => false,
                'probabilitySource' => 'polymarket',
                // Equal remains conservative by default, but the same On/Off control
                // can explicitly enable its paper rotation review.
                'autoRotatePositions' => false,
                // The mechanism this portfolio is named for. It is now a parameter any
                // paper portfolio may turn on, but Equal is where it ships enabled.
                'stopLossEnabled' => true,
                'stopLossRiskMultiplier' => 1.5,
                'reverseOnStopLoss' => false,
                'excludedCandidateTokenIds' => [],
                'includeOnlyMarketTags' => [],
                'excludedMarketTags' => [],
            ],
        ],
        'live' => [
            'displayName' => 'Live',
            'initialUsdc' => null,
            'minProbability' => 0.95,
            'stakeUsdc' => 5.0,
            'maxOrderFraction' => 0.05,
            'maxResolutionDays' => 7,
            'selectionOrder' => 'highest_ev_pa_first',
            'minLiquidityUsdc' => 100,
            'minNetYield' => 0.0,
            'executionTrigger' => 'cron',
            'useLimitOrders' => true,
            'marketType' => 'all',
            'excludeOverUnderMarkets' => false,
            'requireMostProbableOutcome' => false,
            'probabilitySource' => 'ai',
            'autoRotatePositions' => true,
            'stopLossEnabled' => false,
            'stopLossRiskMultiplier' => 0.0,
            'reverseOnStopLoss' => false,
            'excludedCandidateTokenIds' => [],
            'includeOnlyMarketTags' => [],
            'excludedMarketTags' => [],
        ],
        // Independently managed strategies using the same connected Polymarket
        // account. Their execution state and run log are separate from the legacy
        // Live portfolio, so creating one can never alter its rules.
        'livePortfolios' => [],
        // 5050 rests a bid at a fixed point on the 0..1 scale across every candidate
        // that clears its probability bar, rather than buying the best one at the
        // market. Automation ships off: it deliberately commits past its capital.
        'live5050' => [
            'displayName' => '5050',
            'minProbability' => 0.90,
            'fixedEntryPrice' => 0.50,
            'stakePerOrderUsdc' => null,
            'stakeUsdc' => 5.0,
            'maxOrderFraction' => 0.05,
            'maxResolutionDays' => 30,
            'selectionOrder' => 'highest_ev_pa_first',
            'minLiquidityUsdc' => 100,
            'minNetYield' => 0.0,
            'executionTrigger' => 'cron',
            'useLimitOrders' => true,
            'marketType' => 'all',
            'excludeOverUnderMarkets' => false,
            'requireMostProbableOutcome' => false,
            'probabilitySource' => 'polymarket',
            'automationEnabled' => false,
            'autoRotatePositions' => false,
            'stopLossEnabled' => false,
            'stopLossRiskMultiplier' => 0.0,
            'reverseOnStopLoss' => false,
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

function portfolio_config_history_path(): string
{
    return __DIR__ . '/data/portfolio-config-history.ndjson';
}

function portfolio_config_history_fields(): array
{
    return [
        'displayName', 'initialUsdc', 'minProbability', 'maxProbability', 'stakeUsdc',
        'maxResolutionDays', 'selectionOrder', 'marketType', 'excludeOverUnderMarkets', 'probabilitySource',
        'minLiquidityUsdc', 'minNetYield', 'executionTrigger', 'executionCronMinutes',
        'useLimitOrders', 'autoRotatePositions', 'stopLossRiskMultiplier', 'reverseOnStopLoss',
        'includeOnlyMarketTags', 'excludedMarketTags', 'automationEnabled', 'archived',
    ];
}

function portfolio_config_history_value(mixed $value): mixed
{
    if (is_array($value)) {
        return array_values($value);
    }
    if (is_bool($value) || is_string($value) || is_numeric($value) || $value === null) {
        return $value;
    }
    return null;
}

function portfolio_config_history_changes(array $before, array $after): array
{
    $changes = [];
    $scopes = [
        'live' => ['live' => $before['live'] ?? [], 'next' => $after['live'] ?? []],
        'live5050' => ['live' => $before['live5050'] ?? [], 'next' => $after['live5050'] ?? []],
    ];
    foreach (['paper' => 'paper'] as $scope => $source) {
        $beforePaper = is_array($before[$source] ?? null) ? $before[$source] : [];
        $afterPaper = is_array($after[$source] ?? null) ? $after[$source] : [];
        foreach (array_unique(array_merge(array_keys($beforePaper), array_keys($afterPaper))) as $id) {
            $scopes[(string) $id] = [
                'live' => is_array($beforePaper[$id] ?? null) ? $beforePaper[$id] : [],
                'next' => is_array($afterPaper[$id] ?? null) ? $afterPaper[$id] : [],
            ];
        }
    }
    $beforeLive = is_array($before['livePortfolios'] ?? null) ? $before['livePortfolios'] : [];
    $afterLive = is_array($after['livePortfolios'] ?? null) ? $after['livePortfolios'] : [];
    foreach (array_unique(array_merge(array_keys($beforeLive), array_keys($afterLive))) as $id) {
        $scopes['live-custom-' . (string) $id] = [
            'live' => is_array($beforeLive[$id] ?? null) ? $beforeLive[$id] : [],
            'next' => is_array($afterLive[$id] ?? null) ? $afterLive[$id] : [],
        ];
    }
    foreach ($scopes as $strategyId => $rows) {
        $old = $rows['live'];
        $new = $rows['next'];
        foreach (portfolio_config_history_fields() as $field) {
            $beforeValue = portfolio_config_history_value($old[$field] ?? null);
            $afterValue = portfolio_config_history_value($new[$field] ?? null);
            if (json_encode($beforeValue) === json_encode($afterValue)) {
                continue;
            }
            $changes[] = [
                'strategyId' => $strategyId,
                'field' => $field,
                'before' => $beforeValue,
                'after' => $afterValue,
            ];
        }
    }
    return $changes;
}

function append_portfolio_config_history(array $before, array $after): void
{
    $changes = portfolio_config_history_changes($before, $after);
    if ($changes === []) {
        return;
    }
    $entry = [
        'id' => 'cfg-' . bin2hex(random_bytes(8)),
        'changedAt' => gmdate('c'),
        'changes' => $changes,
    ];
    if (trading_storage_is_active()) {
        try {
            trading_storage_event_append('portfolio-config-history', null, $entry);
        } catch (Throwable) {
            // The configuration write must remain authoritative. A later ingest can
            // recover this audit row rather than rejecting a valid portfolio edit.
        }
        return;
    }
    $path = portfolio_config_history_path();
    $dir = dirname($path);
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
        return;
    }
    $record = json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if (is_string($record)) {
        @file_put_contents($path, $record . "\n", FILE_APPEND | LOCK_EX);
    }
}

function portfolio_config_history_records(?string $strategyId = null): array
{
    if (trading_storage_is_active()) {
        $rows = [];
        foreach (trading_storage_event_records('portfolio-config-history', null, 500) as $record) {
            $changes = array_values(array_filter($record['changes'] ?? [], static function ($change) use ($strategyId): bool {
                return is_array($change) && ($strategyId === null || (string) ($change['strategyId'] ?? '') === $strategyId);
            }));
            if ($changes !== []) {
                $rows[] = [
                    'id' => (string) ($record['id'] ?? ''),
                    'changedAt' => (string) ($record['changedAt'] ?? ''),
                    'changes' => $changes,
                ];
            }
        }
        return $rows;
    }
    $path = portfolio_config_history_path();
    if (!is_file($path)) {
        return [];
    }
    $rows = [];
    $handle = @fopen($path, 'rb');
    if ($handle === false) {
        return [];
    }
    while (($line = fgets($handle)) !== false) {
        $record = json_decode(trim($line), true);
        if (!is_array($record) || !is_array($record['changes'] ?? null)) {
            continue;
        }
        $changes = array_values(array_filter($record['changes'], static function ($change) use ($strategyId): bool {
            return is_array($change) && ($strategyId === null || (string) ($change['strategyId'] ?? '') === $strategyId);
        }));
        if ($changes === []) {
            continue;
        }
        $rows[] = [
            'id' => (string) ($record['id'] ?? ''),
            'changedAt' => (string) ($record['changedAt'] ?? ''),
            'changes' => $changes,
        ];
    }
    fclose($handle);
    usort($rows, static fn (array $left, array $right): int => (strtotime($right['changedAt']) ?: 0) <=> (strtotime($left['changedAt']) ?: 0));
    return array_slice($rows, 0, 500);
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
    if (trading_storage_is_active()) {
        $stored = trading_storage_document_get('scan-preferences');
        if (is_array($stored)) {
            return [
                'liquidityMin' => normalize_scan_liquidity_preference($stored['liquidityMin'] ?? 0),
                'maxDays' => normalize_scan_days_preference($stored['maxDays'] ?? 7),
                'updatedAt' => (string) ($stored['updatedAt'] ?? ''),
            ];
        }
    }
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
    if (trading_storage_is_active()) {
        trading_storage_document_put('scan-preferences', 'preferences', $preferences);
        return $preferences;
    }
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

/**
 * Optional upper probability bound. Unlike a minimum threshold it may be empty,
 * and 100% is a valid human-facing end of a reporting band.
 */
function normalize_optional_probability_value(mixed $value): ?float
{
    if ($value === null || $value === '' || !is_numeric($value)) {
        return null;
    }
    $probability = (float) $value;
    if ($probability > 1) {
        $probability /= 100;
    }
    return max(0.01, min(1.0, $probability));
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

function normalize_stake_usdc_value(mixed $value, float $fallback): float
{
    if (!is_numeric($value)) {
        return max(0.01, min(1000.0, round($fallback, 2)));
    }
    return max(0.01, min(1000.0, round((float) $value, 2)));
}

function normalize_initial_usdc_value(mixed $value, mixed $fallback = null): ?float
{
    if (!is_numeric($value)) {
        return is_numeric($fallback)
            ? max(0.01, min(10000000.0, round((float) $fallback, 2)))
            : null;
    }
    return max(0.01, min(10000000.0, round((float) $value, 2)));
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

function normalize_stop_loss_risk_multiplier_value(mixed $value, float $fallback): float
{
    if (!is_numeric($value)) {
        return $fallback;
    }
    $multiplier = (float) $value;
    if ($multiplier > 10) {
        $multiplier /= 100;
    }
    return max(0.0, min(3.0, round($multiplier, 2)));
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
    $defaultStopLossRiskMultiplier = normalize_stop_loss_risk_multiplier_value(
        $defaults['stopLossRiskMultiplier'] ?? (($defaults['stopLossEnabled'] ?? false) ? 1.0 : 0.0),
        0.0
    );
    if (array_key_exists('stopLossRiskMultiplier', $input)) {
        $stopLossRiskMultiplier = normalize_stop_loss_risk_multiplier_value(
            $input['stopLossRiskMultiplier'],
            $defaultStopLossRiskMultiplier
        );
    } elseif (array_key_exists('stopLossEnabled', $input)) {
        $stopLossRiskMultiplier = (bool) $input['stopLossEnabled']
            ? max(1.0, $defaultStopLossRiskMultiplier)
            : 0.0;
    } else {
        $stopLossRiskMultiplier = $defaultStopLossRiskMultiplier;
    }
    $minProbability = normalize_probability_value($input['minProbability'] ?? null, (float) $defaults['minProbability']);
    $maxProbability = normalize_optional_probability_value($input['maxProbability'] ?? ($defaults['maxProbability'] ?? null));
    if ($maxProbability !== null && $maxProbability < $minProbability) {
        $maxProbability = $minProbability;
    }
    return [
        'displayName' => normalize_portfolio_display_name(
            $input['displayName'] ?? $defaults['displayName'],
            (string) $defaults['displayName']
        ),
        'initialUsdc' => normalize_initial_usdc_value(
            $input['initialUsdc'] ?? null,
            $defaults['initialUsdc'] ?? null
        ),
        'minProbability' => $minProbability,
        'maxProbability' => $maxProbability,
        'stakeUsdc' => normalize_stake_usdc_value($input['stakeUsdc'] ?? null, (float) ($defaults['stakeUsdc'] ?? 5.0)),
        // Kept for backward compatibility with older workflow inputs and archived
        // states. New sizing uses the fixed stakeUsdc field above.
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
        // Missing means the portfolio keeps its established behavior. Equal is the
        // only default-off portfolio; all other existing portfolios keep rotation on.
        'autoRotatePositions' => (bool) ($input['autoRotatePositions'] ?? $defaults['autoRotatePositions'] ?? true),
        // This applies to every portfolio type. Previously it was normalized only for
        // the primary live portfolio, so a paper setting silently disappeared after
        // saving and the bot fell back to market orders.
        'useLimitOrders' => (bool) ($input['useLimitOrders'] ?? $defaults['useLimitOrders'] ?? false),
        'marketType' => $marketType,
        'excludeOverUnderMarkets' => (bool) ($input['excludeOverUnderMarkets'] ?? $defaults['excludeOverUnderMarkets'] ?? false),
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
        // Archived portfolios keep every row they ever traded and every setting they
        // were traded under. They leave the dashboard and stop being executed, and
        // restoring one is only clearing this flag.
        'archived' => (bool) ($input['archived'] ?? $defaults['archived'] ?? false),
        // A zero multiplier disables the protective exit. Paper portfolios simulate it;
        // live portfolios publish the setting to the RPi protective-exit worker, which
        // submits a strict fee-aware FOK sell only when its separately armed live mode
        // observes the configured floor.
        'stopLossEnabled' => $stopLossRiskMultiplier > 0,
        'stopLossRiskMultiplier' => $stopLossRiskMultiplier,
        // This is kept separately from the stop multiplier. It remains a dormant
        // preference while the stop is off, so enabling the stop later is explicit.
        'reverseOnStopLoss' => (bool) ($input['reverseOnStopLoss'] ?? $defaults['reverseOnStopLoss'] ?? false),
    ];
}

// A created portfolio needs an id that can safely become a state key, a mode name and a
// workflow input. Anything that would not survive all three is refused rather than
// silently rewritten into something the user did not name.
function normalize_custom_paper_portfolio_id(mixed $value): ?string
{
    $id = trim((string) ($value ?? ''));

    return preg_match('/^[a-z][a-zA-Z0-9]{1,30}$/', $id) ? $id : null;
}

function normalize_custom_live_portfolio_id(mixed $value): ?string
{
    return normalize_custom_paper_portfolio_id($value);
}

function custom_live_portfolio_defaults(string $id): array
{
    $defaults = default_portfolio_config()['live'];
    $defaults['displayName'] = $id;
    $defaults['minProbability'] = 0.5;
    $defaults['minLiquidityUsdc'] = null;
    $defaults['autoRotatePositions'] = false;
    $defaults['automationEnabled'] = true;
    $defaults['archived'] = false;
    $defaults['custom'] = true;

    return $defaults;
}

/**
 * The starting point for a portfolio the user creates. Deliberately the most permissive
 * of the shipped profiles, so a created portfolio trades what its own form says and not
 * what some template quietly also required.
 */
function custom_paper_portfolio_defaults(string $id): array
{
    $defaults = default_portfolio_config()['paper']['highReward'];
    $defaults['displayName'] = $id;
    $defaults['minProbability'] = 0.5;
    $defaults['minLiquidityUsdc'] = null;
    $defaults['autoRotatePositions'] = false;
    // A created paper portfolio is still a paper portfolio: once the user saves it, it
    // should participate in the same scheduled execution pipeline as the shipped ones
    // unless its own automation switch is deliberately turned off.
    $defaults['automationEnabled'] = true;
    $defaults['archived'] = false;

    return $defaults;
}

function normalize_portfolio_config(array $input): array
{
    $defaults = default_portfolio_config();
    $paperInput = is_array($input['paper'] ?? null) ? $input['paper'] : [];
    $liveInput = is_array($input['live'] ?? null) ? $input['live'] : [];
    $customLiveInput = is_array($input['livePortfolios'] ?? null) ? $input['livePortfolios'] : [];
    $systemInput = is_array($input['system'] ?? null) ? $input['system'] : [];
    $config = $defaults;
    foreach ($defaults['paper'] as $id => $strategyDefaults) {
        $strategyInput = is_array($paperInput[$id] ?? null) ? $paperInput[$id] : [];
        $config['paper'][$id] = normalize_strategy_config($strategyInput, $strategyDefaults);
    }
    // Portfolios the user created. They are stored beside the shipped ones and are
    // otherwise identical; the count is bounded because every one of them becomes a
    // strategy the bot runs and a row in the published state.
    $customCount = 0;
    foreach ($paperInput as $rawId => $strategyInput) {
        if (isset($config['paper'][$rawId]) || !is_array($strategyInput)) {
            continue;
        }
        $id = normalize_custom_paper_portfolio_id($rawId);
        if ($id === null || $customCount >= CUSTOM_PAPER_PORTFOLIO_LIMIT) {
            continue;
        }
        $customCount += 1;
        $config['paper'][$id] = normalize_strategy_config($strategyInput, custom_paper_portfolio_defaults($id));
        // Stated rather than inferred from "not one of the four shipped ids", so the
        // browser and the bot agree on which portfolios the user owns outright.
        $config['paper'][$id]['custom'] = true;
    }
    $config['live'] = normalize_strategy_config($liveInput, $defaults['live']);
    // The legacy live portfolio stays permanently visible because it represents the
    // connected wallet. User-created live strategies can be archived independently;
    // their state files remain available for history and any existing exposure.
    $config['live']['archived'] = false;
    $customLiveCount = 0;
    foreach ($customLiveInput as $rawId => $strategyInput) {
        if (!is_array($strategyInput)) {
            continue;
        }
        $id = normalize_custom_live_portfolio_id($rawId);
        if ($id === null || $customLiveCount >= CUSTOM_LIVE_PORTFOLIO_LIMIT) {
            continue;
        }
        $customLiveCount += 1;
        $config['livePortfolios'][$id] = normalize_strategy_config($strategyInput, custom_live_portfolio_defaults($id));
        $config['livePortfolios'][$id]['custom'] = true;
    }
    // 5050 carries three settings no other portfolio has. They are normalized here
    // rather than passed through, so a bad value cannot reach the executor and be
    // rejected by the exchange one bid at a time.
    $fixedInput = is_array($input['live5050'] ?? null) ? $input['live5050'] : [];
    $config['live5050'] = normalize_strategy_config($fixedInput, $defaults['live5050']);
    $config['live5050']['useLimitOrders'] = true;
    // Unlike the plain live portfolio above, 5050 may be archived: it hides the tab and
    // stops resting new bids, but withdrawing an expired resting order and refreshing
    // the account snapshot are unconditional in the executor, so an archived 5050 still
    // keeps whatever it is already holding under watch. normalize_strategy_config()
    // already carried the field through; nothing here needs to force it either way.
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
    if (trading_storage_is_active()) {
        $stored = trading_storage_document_get('portfolio-config');
        if (is_array($stored)) {
            return normalize_portfolio_config($stored);
        }
    }
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
    if (trading_storage_is_active()) {
        $before = load_portfolio_config();
        $normalized = normalize_portfolio_config($config);
        trading_storage_document_put('portfolio-config', 'portfolio-config', $normalized);
        append_portfolio_config_history($before, $normalized);
        return $normalized;
    }
    $path = portfolio_config_path();
    $dir = dirname($path);
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
        respond(['ok' => false, 'error' => 'Unable to create data directory'], 500);
    }

    // Saving from a second tab used to replace the entire JSON from its older snapshot.
    // That made a just-created portfolio disappear. Serialise the read/merge/write and
    // retain portfolios absent from a stale client because portfolios are archived, not
    // deleted, in this application.
    $lock = fopen($path . '.lock', 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) {
        if (is_resource($lock)) {
            fclose($lock);
        }
        respond(['ok' => false, 'error' => 'Unable to lock portfolio config'], 503);
    }
    try {
        $stored = load_portfolio_config();
        $incomingPaper = is_array($config['paper'] ?? null) ? $config['paper'] : [];
        foreach ((array) ($stored['paper'] ?? []) as $id => $row) {
            if (!array_key_exists($id, $incomingPaper)) {
                $incomingPaper[$id] = $row;
            }
        }
        $config['paper'] = $incomingPaper;
        $incomingLive = is_array($config['livePortfolios'] ?? null) ? $config['livePortfolios'] : [];
        foreach ((array) ($stored['livePortfolios'] ?? []) as $id => $row) {
            if (!array_key_exists($id, $incomingLive)) {
                $incomingLive[$id] = $row;
            }
        }
        $config['livePortfolios'] = $incomingLive;
        if (!is_array($config['live5050'] ?? null)) {
            $config['live5050'] = [];
        }
        $config['live5050']['fixedEntryPriceHistory'] = array_merge(
            is_array($config['live5050']['fixedEntryPriceHistory'] ?? null) ? $config['live5050']['fixedEntryPriceHistory'] : [],
            [$stored['live5050']['fixedEntryPrice'] ?? null],
            is_array($stored['live5050']['fixedEntryPriceHistory'] ?? null) ? $stored['live5050']['fixedEntryPriceHistory'] : [],
        );

        $normalized = normalize_portfolio_config($config);
        $encoded = json_encode($normalized, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($encoded) || file_put_contents($path, $encoded . "\n", LOCK_EX) === false) {
            respond(['ok' => false, 'error' => 'Unable to persist portfolio config'], 500);
        }
        append_portfolio_config_history($stored, $normalized);
        return $normalized;
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
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

    // Redeem availability is still tracked in the live account state and displayed in
    // the desk. Delivery was intentionally retired, however, so a legacy caller of
    // this endpoint can never send an email.
    return [
        'ok' => true,
        'notificationsEnabled' => false,
        'skipped' => 'Redeem email notifications are disabled.',
        'generatedAt' => gmdate('c'),
    ];

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

function require_trading_trigger_key(): void
{
    $config = app_config();
    if ($config['trigger_key'] === '') {
        respond(['ok' => false, 'error' => 'Storage administration is not configured.'], 503);
    }
    $providedKey = request_header('X-Trading-Trigger-Key');
    if ($providedKey === '' || !hash_equals($config['trigger_key'], $providedKey)) {
        respond(['ok' => false, 'error' => 'Invalid storage administration key.'], 403);
    }
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

    // Which runs count. The default stays dispatches only, because the browser only
    // watches runs it dispatched itself; scheduled work publishes its real decision into
    // the persisted run log when it finishes.
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
            // dispatch-after-scan.mjs dispatches this same event type ("workflow_dispatch")
            // to chain a run onto a scan, so the event alone cannot tell a person's click
            // apart from that machine call. Its own dispatches always run as this actor;
            // a person's always run as their own GitHub login.
            'triggeringActor' => $run['triggering_actor']['login'] ?? null,
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
    return in_array($text, ['conservative', 'highReward', 'moreProbable', 'equal'], true)
        ? $text
        : normalize_custom_paper_portfolio_id($text);
}

function paper_strategy_from_target(string $target): ?string
{
    $builtIn = match ($target) {
        'paper-conservative' => 'conservative',
        'paper-highReward' => 'highReward',
        'paper-moreProbable' => 'moreProbable',
        'paper-equal' => 'equal',
        default => null,
    };
    if ($builtIn !== null) {
        return $builtIn;
    }

    if (in_array($target, ['paper-scan', 'paper-evaluation', 'paper-refresh'], true)) {
        return null;
    }

    if (!str_starts_with($target, 'paper-')) {
        return null;
    }

    return normalize_custom_paper_portfolio_id(substr($target, 6));
}

function paper_strategy_is_known(?string $strategyId, ?array $config = null): bool
{
    if ($strategyId === null || $strategyId === '') {
        return false;
    }
    $config = $config ?? load_portfolio_config();
    $paper = is_array($config['paper'] ?? null) ? $config['paper'] : [];

    return isset($paper[$strategyId]) && is_array($paper[$strategyId]) && ($paper[$strategyId]['archived'] ?? false) !== true;
}

function custom_live_portfolio_id_from_target(string $target): ?string
{
    if (!preg_match('/^live-custom-([a-z][a-zA-Z0-9]{1,30})$/', $target, $matches)) {
        return null;
    }
    return normalize_custom_live_portfolio_id($matches[1]);
}

function custom_live_portfolio_id_from_execution_target(string $target): ?string
{
    if (!preg_match('/^live-custom-([a-z][a-zA-Z0-9]{1,30})-execution$/', $target, $matches)) {
        return null;
    }
    return normalize_custom_live_portfolio_id($matches[1]);
}

function custom_live_portfolio_is_known(?string $portfolioId, ?array $config = null): bool
{
    if ($portfolioId === null || $portfolioId === '') {
        return false;
    }
    $config = $config ?? load_portfolio_config();
    $live = is_array($config['livePortfolios'] ?? null) ? $config['livePortfolios'] : [];
    return isset($live[$portfolioId]) && is_array($live[$portfolioId]) && ($live[$portfolioId]['archived'] ?? false) !== true;
}

/**
 * The RPi worker needs only an explicitly enabled stop policy and the token to
 * watch. It never receives a private key or a portfolio's broader UI settings
 * through this endpoint. A successful entry is recorded in that portfolio's
 * execution state, so it is enough to associate the token with its owning live
 * strategy after the order has actually been accepted by Polymarket.
 */
function live_stop_loss_policy_config(array $config, string $portfolioId): ?array
{
    $row = null;
    if ($portfolioId === 'live') {
        $row = $config['live'] ?? null;
    } elseif ($portfolioId === 'live5050') {
        $row = $config['live5050'] ?? null;
    } elseif (substr($portfolioId, 0, strlen('live-custom-')) === 'live-custom-') {
        $id = substr($portfolioId, strlen('live-custom-'));
        $row = $config['livePortfolios'][$id] ?? null;
    }
    if (!is_array($row) || ($row['archived'] ?? false) === true) {
        return null;
    }
    $multiplier = normalize_stop_loss_risk_multiplier_value(
        $row['stopLossRiskMultiplier'] ?? (($row['stopLossEnabled'] ?? false) ? 1.0 : 0.0),
        0.0
    );
    if ($multiplier <= 0) {
        return null;
    }
    return [
        'portfolioId' => $portfolioId,
        'stopLossRiskMultiplier' => $multiplier,
        'reverseOnStopLoss' => (bool) ($row['reverseOnStopLoss'] ?? false),
        'enabled' => true,
    ];
}

function live_execution_state_path_for_policy(string $portfolioId): string
{
    if ($portfolioId === 'live') {
        return __DIR__ . '/data/live-execution-state.json';
    }
    if ($portfolioId === 'live5050') {
        return __DIR__ . '/data/live-5050-execution-state.json';
    }
    $id = substr($portfolioId, strlen('live-custom-'));
    return __DIR__ . '/data/live-' . $id . '-execution-state.json';
}

function live_execution_record_was_submitted(array $record): bool
{
    $action = strtoupper(trim((string) ($record['action'] ?? ($record['batchLog']['action'] ?? ''))));
    return in_array($action, ['SUBMITTED', 'CANCELED_AND_SUBMITTED', 'ROTATED_OPENED'], true);
}

function live_execution_record_token_ids(array $record): array
{
    $ids = [];
    $candidates = [
        $record['selected'] ?? null,
        $record['batchLog']['selected'] ?? null,
    ];
    foreach ($candidates as $candidate) {
        if (!is_array($candidate)) {
            continue;
        }
        $tokenId = trim((string) ($candidate['tokenId'] ?? $candidate['assetId'] ?? ''));
        if ($tokenId !== '') {
            $ids[$tokenId] = true;
        }
    }
    return array_keys($ids);
}

function live_stop_loss_policy_payload(): array
{
    $config = load_portfolio_config();
    $portfolioIds = ['live', 'live5050'];
    foreach ((array) ($config['livePortfolios'] ?? []) as $id => $row) {
        if (is_array($row)) {
            $portfolioIds[] = 'live-custom-' . (string) $id;
        }
    }

    $policies = [];
    foreach ($portfolioIds as $portfolioId) {
        $policy = live_stop_loss_policy_config($config, $portfolioId);
        if ($policy === null) {
            continue;
        }
        $state = decode_state_file(live_execution_state_path_for_policy($portfolioId), false);
        if (!is_array($state)) {
            continue;
        }
        $records = array_merge([$state], is_array($state['runLog'] ?? null) ? $state['runLog'] : []);
        foreach ($records as $record) {
            if (!is_array($record) || !live_execution_record_was_submitted($record)) {
                continue;
            }
            $updatedAt = (string) ($record['generatedAt'] ?? $record['runAt'] ?? $record['batchLog']['runAt'] ?? '');
            foreach (live_execution_record_token_ids($record) as $tokenId) {
                $current = $policies[$tokenId] ?? null;
                // A token can be seen in an older strategy state after it has been
                // traded again. The newest accepted order owns its current policy.
                if (is_array($current) && strcmp((string) ($current['updatedAt'] ?? ''), $updatedAt) > 0) {
                    continue;
                }
                $policies[$tokenId] = array_merge($policy, ['tokenId' => $tokenId, 'updatedAt' => $updatedAt]);
            }
        }
    }

    // The original Live strategy predates per-order execution state. When enabled,
    // it deliberately protects otherwise unlabelled positions on the same connected
    // account as well. Custom live portfolios are never used as this fallback.
    return [
        'ok' => true,
        'generatedAt' => gmdate('c'),
        'policies' => array_values($policies),
        'defaultPolicy' => live_stop_loss_policy_config($config, 'live'),
    ];
}

function workflow_target_key(string $target): string
{
    if (paper_strategy_from_target($target) !== null) {
        return 'paper';
    }
    return custom_live_portfolio_id_from_target($target) !== null ? 'live' : $target;
}

try {
    $action = $_GET['action'] ?? 'markets';

    if ($action === 'storage-diagnostics') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond(['ok' => false, 'error' => 'POST is required'], 405);
        }
        require_trading_trigger_key();
        respond([
            'ok' => true,
            'storage' => trading_storage_diagnostics(),
            'generatedAt' => gmdate('c'),
        ]);
    }

    if ($action === 'storage-status') {
        $storage = trading_storage_diagnostics();
        $status = [
            'ok' => true,
            'storage' => $storage,
            'triggerConfigured' => app_config()['trigger_key'] !== '',
            'active' => false,
            'jsonImportedAt' => null,
            'lastMigrationError' => null,
            'lastIngestAt' => null,
            'counts' => ['SCRAPED' => 0, 'RESOLVED' => 0],
            'generatedAt' => gmdate('c'),
        ];
        if ($storage['schemaReady'] === true) {
            try {
                $status['active'] = trading_storage_is_active();
                $status['jsonImportedAt'] = trading_storage_meta_get('json-imported-at');
                $status['lastMigrationError'] = trading_storage_meta_get('last-migration-error');
                $status['lastIngestAt'] = trading_storage_meta_get('last-ingest-at');
                $status['counts'] = trading_storage_observation_counts();
            } catch (Throwable) {
                $status['storage']['schemaReady'] = false;
            }
        }
        respond($status);
    }

    if ($action === 'storage-admin') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond(['ok' => false, 'error' => 'POST is required'], 405);
        }
        require_trading_trigger_key();
        $operation = strtolower(trim((string) (request_payload()['operation'] ?? 'status')));
        $pdo = trading_storage_pdo();
        if (!$pdo instanceof PDO) {
            respond(['ok' => false, 'error' => 'Trading MySQL storage is not configured or reachable.'], 503);
        }
        trading_storage_bootstrap($pdo);
        if ($operation === 'bootstrap') {
            respond(['ok' => true, 'operation' => 'bootstrap', 'storage' => trading_storage_diagnostics()]);
        }
        if ($operation === 'compact-empty') {
            $tables = trading_storage_compact_empty_tables($pdo);
            respond([
                'ok' => true,
                'operation' => 'compact-empty',
                'tables' => $tables,
                'storage' => trading_storage_diagnostics(),
            ]);
        }
        if ($operation === 'migrate-json') {
            try {
                $counts = trading_storage_import_json_state();
                trading_storage_meta_put('last-migration-error', '');
                respond(['ok' => true, 'operation' => 'migrate-json', 'counts' => $counts, 'active' => trading_storage_is_active()]);
            } catch (Throwable $error) {
                trading_storage_meta_put('last-migration-error', trading_storage_safe_migration_error($error));
                throw $error;
            }
        }
        if ($operation === 'activate') {
            if (trading_storage_meta_get('json-imported-at') === null || trading_storage_document_get('state:paper') === null) {
                respond(['ok' => false, 'error' => 'Run the JSON migration successfully before activating database reads.'], 409);
            }
            // Activation deliberately remains an explicit second operation. The runner
            // ingest must be enabled first, otherwise a later JSON-only bot pass would
            // make the database state stale while the dashboard still appeared healthy.
            trading_storage_meta_put('storage-active', '1');
            respond(['ok' => true, 'operation' => 'activate', 'active' => true, 'counts' => trading_storage_observation_counts()]);
        }
        if ($operation === 'deactivate') {
            trading_storage_meta_put('storage-active', '0');
            respond(['ok' => true, 'operation' => 'deactivate', 'active' => false]);
        }
        if ($operation === 'status') {
            respond([
                'ok' => true,
                'operation' => 'status',
                'active' => trading_storage_is_active(),
                'jsonImportedAt' => trading_storage_meta_get('json-imported-at'),
                'lastIngestAt' => trading_storage_meta_get('last-ingest-at'),
                'counts' => trading_storage_observation_counts(),
                'storage' => trading_storage_diagnostics(),
            ]);
        }
        respond(['ok' => false, 'error' => 'Unknown storage administration operation.'], 400);
    }

    if ($action === 'storage-ingest') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond(['ok' => false, 'error' => 'POST is required'], 405);
        }
        require_trading_trigger_key();
        try {
            respond(['ok' => true, 'ingest' => trading_storage_ingest(request_payload()), 'generatedAt' => gmdate('c')]);
        } catch (InvalidArgumentException $error) {
            respond(['ok' => false, 'error' => $error->getMessage()], 400);
        } catch (Throwable) {
            respond(['ok' => false, 'error' => 'Trading MySQL ingest failed.'], 503);
        }
    }

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
        $customLivePortfolioId = custom_live_portfolio_id_from_target($target);
        // Every way this request can be refused ends up in the portfolio's run log, not only
        // the ones GitHub refuses. A run that never started is still a run the user asked
        // for, and the difference between "the server would not send it" and "GitHub would
        // not accept it" is exactly what a reader needs and could not previously see.
        $refuse = static function (string $message, int $status) use ($target, &$paperStrategyId): void {
            record_execution_dispatch_failure(
                execution_dispatch_failure_key($paperStrategyId ?? null, $target),
                $target,
                $paperStrategyId ?? null,
                $message,
            );
            respond(['ok' => false, 'target' => $target, 'error' => $message, 'recordedInRunLog' => true], $status);
        };
        if ($targetKey === 'live' && $customLivePortfolioId !== null && !custom_live_portfolio_is_known($customLivePortfolioId)) {
            $refuse('Unknown or archived live portfolio', 400);
        }
        $liveMinProbability = normalized_probability_input($payload['min_probability'] ?? $payload['live_min_probability'] ?? null);
        $scanTag = normalized_scan_tag_input($payload['market_scan_tag'] ?? null);
        $scanLiquidityMin = normalized_money_input($payload['market_scan_liquidity_min'] ?? $payload['marketScanLiquidityMin'] ?? null);
        $scanMaxDays = normalized_scan_max_days_input($payload['market_scan_max_days'] ?? $payload['marketScanMaxDays'] ?? null);
        $liveStakeUsdc = normalized_money_input($payload['stake_usdc'] ?? $payload['stakeUsdc'] ?? $payload['live_stake_usdc'] ?? null);
        $paperStakeUsdc = normalized_money_input($payload['stake_usdc'] ?? $payload['stakeUsdc'] ?? $payload['paper_stake_usdc'] ?? null);
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
        if ($targetKey === 'paper' && $paperStrategyId !== null && !paper_strategy_is_known($paperStrategyId)) {
            $refuse('Unknown or archived paper portfolio', 400);
        }
        // Every portfolio, shipped or created, reads its complete configuration from
        // portfolio-config.json in the paper bot: the workflow's "Load portfolio config"
        // step appends it to GITHUB_ENV, which overrides the job env for every later
        // step. So per-strategy dispatch inputs could never actually take effect, and
        // sending them only created two ways to fail -- GitHub rejects an input the
        // workflow does not declare ("Unexpected inputs provided"), and declaring them
        // took the file past its hard ceiling of 25 inputs, which made GitHub refuse to
        // parse the workflow at all and stopped both dispatches and the schedule.
        // A portfolio's parameters are saved, not dispatched. Nothing per-strategy
        // belongs in this payload.
        $workflows = [
            'paper' => [
                'workflow' => 'trading-paper-bot.yml',
                'inputs' => array_filter([
                    'mode' => 'full',
                    'paper_stake_usdc' => $paperStakeUsdc,
                    'paper_max_order_fraction' => $paperMaxOrderFraction,
                    'manual_run_once' => $manualRunOnce,
                    'paper_strategy_id' => $paperStrategyId,
                ], static fn ($value): bool => $value !== null),
                'message' => 'Paper bot workflow dispatched.',
            ],
            'live' => [
                'workflow' => 'polymarket-live-limit-order-test.yml',
                'inputs' => array_filter([
                    'live_confirm' => true,
                    'live_min_probability' => $liveMinProbability,
                    'live_stake_usdc' => $liveStakeUsdc,
                    'live_max_order_fraction' => $liveMaxOrderFraction,
                    'live_max_resolution_days' => $liveMaxResolutionDays,
                    'live_selection_order' => $liveSelectionOrder,
                    'live_min_liquidity_usdc' => $liveMinLiquidity,
                    'live_min_net_yield' => $liveMinNetYield,
                    'live_use_limit_orders' => $liveUseLimitOrders,
                    'cross_live_portfolio_risk_diversification' => $crossLiveRiskDiversification,
                    'live_run_source' => $manualRunOnce === true ? 'MANUAL' : 'AUTO',
                    'live_execution_candidate_token_ids' => $liveShortlistTokenIds,
                    'live_portfolio_id' => $customLivePortfolioId,
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
            $refuse('Unknown workflow target: ' . ($target === '' ? '(empty)' : $target), 400);
        }

        // A refused dispatch is recorded before the error is reported, so the attempt shows
        // up in the portfolio's run log rather than only in a popup the user then closes.
        try {
            $result = dispatch_workflow($workflows[$targetKey]['workflow'], $workflows[$targetKey]['inputs'], false);
        } catch (Throwable $error) {
            record_execution_dispatch_failure(
                execution_dispatch_failure_key($paperStrategyId, $target),
                $target,
                $paperStrategyId ?? $customLivePortfolioId,
                $error->getMessage(),
            );
            respond([
                'ok' => false,
                'target' => $target,
                'workflowTarget' => $targetKey,
                'error' => $error->getMessage(),
                'recordedInRunLog' => true,
            ], 502);
        }
        respond([
            'ok' => true,
            'target' => $target,
            'workflowTarget' => $targetKey,
            'paperStrategyId' => $paperStrategyId,
            'livePortfolioId' => $customLivePortfolioId,
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

    if ($action === 'portfolio-config-history') {
        $strategyId = trim((string) ($_GET['strategy_id'] ?? ''));
        if ($strategyId !== '' && !preg_match('/^[A-Za-z0-9_-]{1,64}$/', $strategyId)) {
            respond(['ok' => false, 'error' => 'Invalid portfolio strategy id'], 400);
        }
        respond([
            'ok' => true,
            'records' => portfolio_config_history_records($strategyId !== '' ? $strategyId : null),
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
        try {
            respond(workflow_status_payload($target));
        } catch (Throwable $e) {
            respond([
                'ok' => true,
                'target' => $target,
                'generatedAt' => gmdate('c'),
                'runs' => [],
                'latest' => null,
                'statusError' => $e->getMessage(),
            ]);
        }
    }

    if ($action === 'send-redeem-alerts') {
        respond(send_redeem_alerts());
    }

    if ($action === 'live-exit-policy') {
        respond(live_stop_loss_policy_payload());
    }

    if ($action === 'state') {
        $target = (string) ($_GET['target'] ?? '');
        $summary = (string) ($_GET['summary'] ?? '');
        $strategyId = isset($_GET['strategy_id']) ? (string) $_GET['strategy_id'] : null;
        // Which page of the execution scope to serve. Only the execution summary reads it;
        // every other view ignores it.
        $executionOffset = max(0, (int) ($_GET['offset'] ?? 0));
        // Load the segments this summary reads before decoding anything else. The
        // dashboard is by far the most requested view and needs none of them.
        $payload = state_payload($target, state_segments_for_summary($summary), $strategyId);
        if ($target === 'paper') {
            $payload = paper_state_with_consistent_portfolios($payload, $summary, $strategyId);
            $payload = compact_state_payload($target, $payload, $summary, $strategyId, $executionOffset);
        }
        respond($payload);
    }

    // Portfolio trade analysis deliberately grades the original selection at market
    // settlement, not at the time a rotation or stop loss sold it. Return a compact
    // token -> final outcome index built from the full archive. The archive is streamed
    // one member at a time because decoding it whole exceeds the host memory limit.
    if ($action === 'portfolio-analysis-outcomes') {
        $files = state_file_paths();
        $corePath = $files['paper'];
        $core = decode_state_file($corePath);
        if ($core === null) {
            respond(['ok' => false, 'error' => 'State file is not available yet'], 404);
        }
        $manifest = is_array($core['stateSegments'] ?? null) ? $core['stateSegments'] : [];
        $sources = [];
        $activePath = state_segment_path(['stateSegments' => $manifest], $corePath, 'observations');
        if ($activePath !== null) {
            $sources[] = [$activePath, 'marketObservations'];
        }
        $resolvedPath = state_segment_path(['stateSegments' => $manifest], $corePath, 'resolvedObservations');
        if ($resolvedPath !== null) {
            $sources[] = [$resolvedPath, 'resolvedMarketObservations'];
        }
        if ($sources === []) {
            // States written before segmentation can contain either collection inline.
            $sources = [[$corePath, 'marketObservations'], [$corePath, 'resolvedMarketObservations']];
        }

        $outcomes = [];
        $onRow = static function (array $item) use (&$outcomes): bool {
            $price = $item['finalOutcomePrice'] ?? null;
            if (!is_numeric($price)) {
                return true;
            }
            $price = (float) $price;
            // A non-binary final price is not a settlement of this selected outcome and
            // must not be invented as either a win or a loss.
            if ($price > 0.005 && $price < 0.995) {
                return true;
            }
            $outcome = $price >= 0.995 ? 1 : 0;
            foreach (['tokenId', 'clobTokenId', 'assetId'] as $field) {
                $token = trim((string) ($item[$field] ?? ''));
                if ($token !== '' && strlen($token) <= 256) {
                    $outcomes[$token] = $outcome;
                }
            }
            return true;
        };
        foreach ($sources as [$path, $field]) {
            stream_json_array_members($path, $field, $onRow);
        }
        respond([
            'ok' => true,
            'outcomes' => $outcomes,
            'count' => count($outcomes),
            'generatedAt' => $core['generatedAt'] ?? gmdate('c'),
        ]);
    }

    // The rows behind one row of the performance tables. Those tables are computed over
    // the whole stored archive, while the scraped list is served a capped page of it --
    // which is how a tag could report 937 resolved trades and its own link list 12. This
    // reads the archive itself, applying the very predicates the tables count with, so
    // the list and the statistic are the same set by construction.
    if ($action === 'taxonomy-observations') {
        $kind = strtolower(trim((string) ($_GET['kind'] ?? 'tag')));
        if (!in_array($kind, ['tag', 'category'], true)) {
            respond(['ok' => false, 'error' => 'kind must be tag or category'], 400);
        }
        $value = strtolower(trim((string) ($_GET['value'] ?? '')));
        if ($value === '' || !preg_match('/^[a-z0-9 ._:-]{1,80}$/', $value)) {
            respond(['ok' => false, 'error' => 'A taxonomy value is required'], 400);
        }
        $statuses = array_values(array_unique(array_filter(array_map(
            static fn($status): string => strtoupper(trim((string) $status)),
            explode(',', (string) ($_GET['statuses'] ?? 'RESOLVED')),
        ), static fn($status): bool => in_array($status, ['SCRAPED', 'RESOLVED'], true))));
        if ($statuses === []) {
            $statuses = ['RESOLVED'];
        }
        $minProbability = 0.0;
        if (isset($_GET['probability']) && is_numeric($_GET['probability'])) {
            // The links carry whole percent, matching the stored probability ladder.
            $minProbability = max(0.0, min(1.0, ((float) $_GET['probability']) / 100));
        }
        $maxProbability = null;
        if (isset($_GET['maxProbability']) && is_numeric($_GET['maxProbability'])) {
            $maxProbability = max(0.0, min(1.0, ((float) $_GET['maxProbability']) / 100));
            if ($maxProbability < $minProbability) {
                $maxProbability = $minProbability;
            }
        }
        $rowLimit = 4000;
        if (isset($_GET['limit']) && is_numeric($_GET['limit'])) {
            $rowLimit = (int) max(1, min(8000, (int) $_GET['limit']));
        }

        $files = state_file_paths();
        $corePath = $files['paper'];
        $core = decode_state_file($corePath);
        if ($core === null) {
            respond(['ok' => false, 'error' => 'State file is not available yet'], 404);
        }
        $manifest = is_array($core['stateSegments'] ?? null) ? $core['stateSegments'] : [];
        unset($core['marketObservations'], $core['evaluations'], $core['marketScanHistory']);

        $sources = [];
        $observationsPath = state_segment_path(['stateSegments' => $manifest], $corePath, 'observations');
        if ($observationsPath !== null) {
            $sources[] = [$observationsPath, 'marketObservations'];
        }
        // Deliberately the whole archive, not the capped `resolvedRecent` page the
        // scraped summary reads: the point of this endpoint is the rows that page omits.
        $resolvedPath = state_segment_path(['stateSegments' => $manifest], $corePath, 'resolvedObservations');
        if ($resolvedPath !== null) {
            $sources[] = [$resolvedPath, 'resolvedMarketObservations'];
        }
        if ($sources === []) {
            // A state written before segmentation carries every observation inline.
            $sources[] = [$corePath, 'marketObservations'];
        }

        $firstField = $kind === 'tag' ? 'firstPolymarketTags' : 'firstPolymarketCategories';
        $currentField = $kind === 'tag' ? 'polymarketTags' : 'polymarketCategories';
        $wantsEmpty = ($kind === 'tag' && $value === 'untagged') || ($kind === 'category' && $value === 'uncategorized');
        $wantsResolved = in_array('RESOLVED', $statuses, true);
        $wantsOpen = in_array('SCRAPED', $statuses, true);

        $matched = 0;
        $matchedResolved = 0;
        $matchedOpen = 0;
        $scanned = 0;
        $rows = [];
        // An unlabelled bucket cannot be pre-filtered, but a named one can: a row whose
        // raw text never mentions the label cannot carry it, and skipping the decode for
        // those is what keeps this endpoint answering in seconds over 31,000 rows.
        $accepts = $wantsEmpty ? null : static function (string $raw) use ($value, &$scanned): bool {
            $scanned += 1;
            return stripos($raw, $value) !== false;
        };
        $onRow = static function (array $item) use (
            $firstField,
            $currentField,
            $value,
            $wantsEmpty,
            $wantsResolved,
            $wantsOpen,
            $minProbability,
            $maxProbability,
            $rowLimit,
            &$matched,
            &$matchedResolved,
            &$matchedOpen,
            &$rows,
            &$scanned
        ): bool {
            if ($wantsEmpty) {
                $scanned += 1;
            }
            $entry = simulation_entry_probability($item);
            // The simulation cannot price a row that never carried a live quote, so it
            // counts none of them; listing them would again outnumber the statistic.
            //
            // The upper bound is exclusive, matching scrapedSimulationMatchesRule. This
            // list is opened from a statistics row and must hold exactly what that row
            // counted -- an inclusive bound here would show one extra market for every
            // entry sitting on the round number the band ends at.
            if ($entry === null || $entry < $minProbability || ($maxProbability !== null && $entry >= $maxProbability)) {
                return true;
            }
            // A row with no saved spread is out of the sample, matching the statistics'
            // PAPER_COUNT_UNKNOWN_SPREAD policy. The two must agree whichever way that
            // policy is set: this list is opened from a statistics row and has to hold
            // exactly what the row counted, and a list disagreeing with the number it was
            // opened from is the complaint this endpoint exists to answer.
            if (!observation_spread_is_tradable($item)) {
                return true;
            }
            $labels = simulation_taxonomy_labels($item, $firstField, $currentField);
            if ($wantsEmpty ? $labels !== [] : !in_array($value, $labels, true)) {
                return true;
            }
            $outcome = simulation_outcome($item);
            $isResolved = $outcome !== null;
            if ($isResolved ? !$wantsResolved : !($wantsOpen && simulation_row_is_open($item))) {
                return true;
            }
            $matched += 1;
            if ($isResolved) {
                $matchedResolved += 1;
            } else {
                $matchedOpen += 1;
            }
            if (count($rows) < $rowLimit) {
                $rows[] = compact_market_observation($item);
            }

            return true;
        };

        foreach ($sources as [$path, $field]) {
            stream_json_array_members($path, $field, $onRow, $accepts);
        }

        usort($rows, static function (array $a, array $b): int {
            $left = strtotime((string) ($a['resolvedAt'] ?? $a['endDate'] ?? $a['observedAt'] ?? '')) ?: 0;
            $right = strtotime((string) ($b['resolvedAt'] ?? $b['endDate'] ?? $b['observedAt'] ?? '')) ?: 0;
            return $right <=> $left;
        });

        respond([
            'ok' => true,
            'generatedAt' => $core['generatedAt'] ?? null,
            'kind' => $kind,
            'value' => $value,
            'statuses' => $statuses,
            'minProbability' => $minProbability,
            'maxProbability' => $maxProbability,
            'marketObservations' => $rows,
            'matched' => $matched,
            'matchedResolved' => $matchedResolved,
            'matchedOpen' => $matchedOpen,
            'returned' => count($rows),
            'truncated' => $matched > count($rows),
            'scanned' => $scanned,
            'marketDetailsMode' => 'compact',
        ]);
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

    // Dispatches a portfolio's own runner never saw. A paper portfolio gets these merged
    // into portfolio-run-log below, but a live portfolio reads its run log straight from a
    // published static file that only its runner writes -- so this is where its browser
    // picks them up.
    if ($action === 'dispatch-failures') {
        $key = trim((string) ($_GET['key'] ?? ''));
        if ($key === '' || !preg_match('/^[a-zA-Z0-9_-]{1,64}$/', $key)) {
            respond(['ok' => false, 'error' => 'A valid key is required'], 400);
        }
        $records = execution_dispatch_failure_records($key);
        usort($records, static function (array $left, array $right): int {
            return strtotime((string) ($right['runAt'] ?? '')) <=> strtotime((string) ($left['runAt'] ?? ''));
        });
        respond([
            'ok' => true,
            'key' => $key,
            'records' => array_slice($records, 0, 20),
            'generatedAt' => gmdate('c'),
        ]);
    }

    if ($action === 'portfolio-run-log') {
        $strategyId = trim((string) ($_GET['strategy_id'] ?? ''));
        if ($strategyId === '' || !preg_match('/^[a-zA-Z0-9_-]{1,40}$/', $strategyId)) {
            respond(['ok' => false, 'error' => 'A valid strategy_id is required'], 400);
        }
        $page = max(0, (int) ($_GET['page'] ?? 0));
        // Unlike scraping runs (frequent, so a page is worth a floor of 25), a young
        // portfolio may only have a handful of runs ever -- no floor beyond "at least one".
        $pageSize = min(200, max(1, (int) ($_GET['page_size'] ?? 24)));
        // The strategy id has to be passed: a portfolio's run log lives in its own state
        // segment now, and the core file carries an empty one. Reading the core alone left
        // this endpoint with no fallback at all, so a portfolio whose archive had been
        // deleted answered "no runs recorded yet" even while the state held two dozen.
        $state = state_payload('paper', [], $strategyId);
        $portfolios = is_array($state['paperPortfolios'] ?? null) ? $state['paperPortfolios'] : [];
        $portfolio = is_array($portfolios[$strategyId] ?? null) ? $portfolios[$strategyId] : [];
        $fallback = is_array($portfolio['runLog'] ?? null) ? $portfolio['runLog'] : [];
        $records = portfolio_run_log_records($strategyId, $fallback);
        $offset = $page * $pageSize;
        respond([
            'ok' => true,
            'strategyId' => $strategyId,
            'records' => array_map(
                static fn(array $record): array => compact_portfolio_run_log_list_record($record),
                array_slice($records, $offset, $pageSize),
            ),
            'page' => $page,
            'pageSize' => $pageSize,
            'total' => count($records),
            'hasMore' => $offset + $pageSize < count($records),
        ]);
    }

    if ($action === 'portfolio-run-log-detail') {
        $strategyId = trim((string) ($_GET['strategy_id'] ?? ''));
        $runAt = trim((string) ($_GET['run_at'] ?? ''));
        if ($strategyId === '' || !preg_match('/^[a-zA-Z0-9_-]{1,40}$/', $strategyId) || $runAt === '') {
            respond(['ok' => false, 'error' => 'A valid strategy_id and run_at are required'], 400);
        }
        $state = state_payload('paper', [], $strategyId);
        $portfolios = is_array($state['paperPortfolios'] ?? null) ? $state['paperPortfolios'] : [];
        $portfolio = is_array($portfolios[$strategyId] ?? null) ? $portfolios[$strategyId] : [];
        $fallback = is_array($portfolio['runLog'] ?? null) ? $portfolio['runLog'] : [];
        foreach (portfolio_run_log_records($strategyId, $fallback) as $record) {
            if ((string) ($record['runAt'] ?? '') === $runAt) {
                respond(['ok' => true, 'strategyId' => $strategyId, 'record' => $record]);
            }
        }
        respond(['ok' => false, 'error' => 'Portfolio run log record was not found'], 404);
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
