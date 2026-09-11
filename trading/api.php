<?php

declare(strict_types=1);

// Every created portfolio becomes a strategy the bot runs each pass and a portfolio row
// in the published state, so the number of them is bounded rather than left to whatever
// a form can be submitted enough times to produce.
// Custom portfolios are dynamically configured strategies; keeping a practical bound
// protects a scheduled pass from unbounded work while still leaving room for archived
// experiments and the active portfolios a user actually wants to compare.
const CUSTOM_PAPER_PORTFOLIO_LIMIT = 24;
// Archived portfolios are bounded separately, and much more loosely, because they cost
// nothing the limit above exists to bound. A portfolio can be archived but never deleted,
// so with one shared cap archiving was a one-way ratchet: eleven archived experiments and
// thirteen active ones filled all 24, "+ Portfolio" stopped working, and there was no way
// back short of editing the stored config by hand. Archived rows are filtered out of every
// scheduled pass, so they add no work -- only stored records, which is what this bounds.
const ARCHIVED_PAPER_PORTFOLIO_LIMIT = 48;
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
function state_segments_for_summary(string $summary, string $scope = 'active'): array
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
            // One page of ONE catalogue, never both at once.
            //
            // Measured from a phone on LTE: the first scraped response was 11.56 MB and the
            // dashboard gives it ten seconds, so it timed out and the Scraping log showed
            // "0 recorded scraping runs" -- the history was in that response and never
            // arrived. The page limit is 1200 rows, but the first page also carried all
            // 3000 resolved markets, because sending them on EVERY page would have been
            // worse. Both are true; the way out is to page the resolved archive too and
            // walk it after the active catalogue, so no single response carries both.
            //
            // observationTotals still reports the true totals either way, so the tab labels
            // keep growing while the list serves a page of it.
            //
            // Still resolvedRecent rather than resolvedObservations: that name is the capped
            // page, and the paper bot deliberately refuses to rebuild its state from it. A
            // reader that reassembled the archive from a page would publish the page back as
            // the whole archive and lose every older resolved market permanently.
            return $scope === 'resolved'
                ? ['resolvedRecent', 'scanHistory']
                : ['observations', 'scanHistory'];
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

function state_payload(
    string $target,
    array $segments = ['observations', 'evaluations'],
    ?string $selectedStrategyId = null,
    int $observationsLimit = 0,
    int $observationsOffset = 0,
    // Whether the active observations are the CURRENT catalogue or everything ever stored.
    // Explicit rather than inferred from the limit, because the two readers that take no
    // limit want opposite things: the execution summary feeds the bots their candidates and
    // must see the catalogue, while the refresh worker merges one quote into the complete set
    // and writes it back -- handing that one a filtered set would delete the rest on publish.
    bool $freshObservationsOnly = false
): array {
    if (trading_storage_is_active()) {
        $document = trading_storage_document_get('state:' . $target);
        if ($document === null) {
            respond(['ok' => false, 'error' => 'Trading database state is not available yet'], 503);
        }
        if (in_array('observations', $segments, true)) {
            // One page of the active catalogue, not all of it. Decoding every row into
            // memory before compacting it is the cost that put a ceiling on the cap: the
            // response size is one problem and the decode is the other, and paging only
            // the response would leave the second one exactly where it was.
            //
            // Zero means the whole lifecycle, which is what every caller other than the
            // scraped list wants -- the refresh worker merges one quote into the complete
            // set and must not be handed a page.
            //
            // And the CURRENT catalogue, not every market ever seen active. The database
            // keeps all of them on purpose -- that history is why it exists -- but while the
            // JSON files served these views the bound was implicit, because the published
            // catalogue is itself a window. Measured before the cutover: 11442 of 23124
            // stored active markets had been refreshed within a day and the rest were last
            // seen seven to eleven days ago, with nothing in between. Serving all of them
            // would have put eleven thousand week-old snapshots in front of the paper bots
            // as tradable candidates.
            $document['marketObservations'] = $observationsLimit > 0
                ? trading_storage_observations_fetch('SCRAPED', $observationsLimit, $observationsOffset, $freshObservationsOnly)
                : trading_storage_observations_fetch('SCRAPED', 0, 0, $freshObservationsOnly);
        }
        if (in_array('resolvedObservations', $segments, true)) {
            $document['marketObservations'] = array_merge(
                is_array($document['marketObservations'] ?? null) ? $document['marketObservations'] : [],
                trading_storage_observations_fetch('RESOLVED'),
            );
        } elseif (in_array('resolvedRecent', $segments, true)) {
            // Paged on the same terms as the active catalogue when the caller asked for a
            // page. Fetching thousands of resolved rows on every request is what made the
            // first scraped response 11.56 MB; a caller that passes no limit still gets the
            // capped page, which is what the views that only show a recent slice need.
            $document['marketObservations'] = array_merge(
                is_array($document['marketObservations'] ?? null) ? $document['marketObservations'] : [],
                $observationsLimit > 0
                    ? trading_storage_observations_fetch('RESOLVED', $observationsLimit, $observationsOffset)
                    : trading_storage_observations_fetch('RESOLVED', 5000),
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

function trading_storage_import_observation_source_batch(string $path, string $field, int $offset, int $limit): array
{
    $offset = max(0, $offset);
    $limit = max(1, min(1000, $limit));
    $skipped = 0;
    $selected = 0;
    $imported = 0;
    $batch = [];
    $flush = static function () use (&$batch, &$imported): void {
        if ($batch === []) {
            return;
        }
        $imported += trading_storage_observations_upsert($batch);
        $batch = [];
    };
    $read = stream_json_array_members($path, $field, static function (array $item) use (&$skipped, &$selected, $offset, $limit, &$batch, $flush): bool {
        if ($skipped < $offset) {
            $skipped++;
            return true;
        }
        $batch[] = $item;
        $selected++;
        if (count($batch) >= 250) {
            $flush();
        }
        return $selected < $limit;
    });
    $flush();
    if (!$read) {
        throw new RuntimeException('Could not stream ' . basename($path) . ' (' . $field . ').');
    }
    return [
        'offset' => $offset,
        'processed' => $selected,
        'imported' => $imported,
        'nextOffset' => $offset + $selected,
        'done' => $selected < $limit,
    ];
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

function trading_storage_json_import_targets(array $config): array
{
    $targets = ['paper', 'live', 'live-execution', 'live-5050-execution'];
    foreach (array_keys(is_array($config['livePortfolios'] ?? null) ? $config['livePortfolios'] : []) as $id) {
        if (is_string($id) && preg_match('/^[a-z][a-zA-Z0-9]{1,30}$/', $id)) {
            $targets[] = 'live-custom-' . $id . '-execution';
        }
    }
    return array_values(array_unique($targets));
}

function trading_storage_import_json_documents_phase(): array
{
    $config = load_portfolio_config();
    $preferences = load_scan_preferences();
    trading_storage_document_put('portfolio-config', 'portfolio-config', $config);
    trading_storage_document_put('scan-preferences', 'preferences', $preferences);
    $files = state_file_paths();
    $counts = ['stateDocuments' => 0, 'paperPortfolioDocuments' => 0, 'events' => 0, 'missingStateFiles' => 0];
    foreach (trading_storage_json_import_targets($config) as $target) {
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
    return $counts;
}

function trading_storage_import_json_observations_phase(string $segment, int $offset, int $limit): array
{
    $files = state_file_paths();
    $path = $files['paper'] ?? null;
    if (!is_string($path) || !is_file($path)) {
        throw new RuntimeException('Paper state file is unavailable.');
    }
    $core = decode_state_file($path, false);
    if (!is_array($core)) {
        throw new RuntimeException('Could not read paper state file.');
    }
    $field = $segment === 'resolved' ? 'resolvedMarketObservations' : 'marketObservations';
    $sourceName = $segment === 'resolved' ? 'resolvedObservations' : 'observations';
    $source = state_segment_path($core, $path, $sourceName);
    if ($source === null && !array_key_exists($field, $core)) {
        throw new RuntimeException('Observation source is unavailable.');
    }
    return trading_storage_import_observation_source_batch($source ?? $path, $field, $offset, $limit);
}

function trading_storage_import_json_events_phase(): array
{
    $events = 0;
    $events += trading_storage_import_ndjson_events('portfolio-config-history', null, [portfolio_config_history_path()]);
    $events += trading_storage_import_ndjson_events('market-scan-history', null, glob(__DIR__ . '/data/market-scan-history/*.ndjson') ?: []);
    foreach (glob(__DIR__ . '/data/portfolio-run-log/*/*.ndjson') ?: [] as $path) {
        $events += trading_storage_import_ndjson_events('portfolio-run-log', basename(dirname($path)), [$path]);
    }
    return ['events' => $events];
}

function trading_storage_import_json_phase(string $phase, int $offset = 0, int $limit = 750): array
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        throw new RuntimeException('Trading MySQL storage is not configured or reachable.');
    }
    trading_storage_bootstrap($pdo);
    return match ($phase) {
        'documents' => trading_storage_import_json_documents_phase(),
        'scraped' => trading_storage_import_json_observations_phase('scraped', $offset, $limit),
        'resolved' => trading_storage_import_json_observations_phase('resolved', $offset, $limit),
        'events' => trading_storage_import_json_events_phase(),
        'finalize' => (static function (): array {
            trading_storage_meta_put('json-imported-at', gmdate('c'));
            $counts = trading_storage_observation_counts();
            trading_storage_meta_put('json-import-counts', json_encode($counts, JSON_UNESCAPED_SLASHES) ?: '{}');
            return ['counts' => $counts, 'active' => trading_storage_is_active()];
        })(),
        default => throw new InvalidArgumentException('Unknown JSON migration phase.'),
    };
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

    // Trades, as rows rather than as part of the state blob. Asked for: every trade written
    // when it opens and updated when it closes, each carrying the portfolio that placed it,
    // kept long-term so statistics and reposting can be built on it. A row that fails to
    // write does not fail the whole ingest -- the state document is the more important half
    // and losing it to one malformed trade would be the worse trade.
    $tradeCount = 0;
    $tradeErrors = [];
    $trades = $payload['trades'] ?? [];
    if (is_array($trades)) {
        if (count($trades) > 2000) {
            throw new InvalidArgumentException('An ingest batch may contain at most 2000 trades.');
        }
        foreach ($trades as $trade) {
            if (!is_array($trade)) {
                continue;
            }
            // Every trade is stored, live and paper alike, told apart by the account column.
            //
            // A PAPER trade always comes out of a named portfolio segment, so one without a
            // portfolio is a defect and is refused rather than filed under an empty string.
            //
            // A LIVE trade is different: there is one wallet, and which portfolio opened a
            // position is derived afterwards from the order history. Refusing those dropped
            // the entire live account on the floor -- thousands of paper rows stored and not
            // one live row. A live trade is now stored with an empty portfolio, and the id is
            // filled in by the pass that works the owner out, which the trade key allows
            // because a live trade is keyed on the position rather than on its portfolio.
            $tradeAccount = strtolower(trim((string) ($trade['account'] ?? '')));
            if ($tradeAccount !== 'live' && trim((string) ($trade['portfolioId'] ?? '')) === '') {
                $tradeErrors[] = 'a paper trade arrived with no portfolioId';
                continue;
            }
            try {
                trading_storage_trade_upsert($trade);
                $tradeCount++;
            } catch (Throwable $error) {
                $tradeErrors[] = trading_storage_safe_migration_error($error);
            }
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
        'trades' => $tradeCount,
        // Reported rather than swallowed: a mirror that writes 0 trades and says nothing is
        // how this whole subsystem went unnoticed for ten days.
        'tradeErrors' => array_slice($tradeErrors, 0, 5),
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
    // Hours is the stored unit; days is derived alongside it so a reader that has not
    // migrated still sees a number. Reading days first would round a 6-hour portfolio's
    // ceiling up to a whole day on its own dashboard card.
    $maxResolutionHours = config_max_resolution_hours($config, DEFAULT_MAX_RESOLUTION_HOURS);
    $maxResolutionDays = (int) max(1, min(365, (int) round($maxResolutionHours / 24.0)));
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
        'maxResolutionHours' => $maxResolutionHours,
        'maxResolutionDays' => $maxResolutionDays,
        'liveEventMode' => config_live_event_mode($config),
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
        'maxResolutionHours' => $maxResolutionHours,
        'maxResolutionDays' => $maxResolutionDays,
        'liveEventMode' => $portfolio['liveEventMode'],
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
        // The active total is the CURRENT catalogue, because that is what the active views
        // serve -- a label larger than the list it heads is the "records disappeared" report
        // in reverse, and the page walk would chase rows that are never sent. The resolved
        // total stays the whole archive: those views read all of it.
        $active = max(0, (int) ($counts['SCRAPED_FRESH'] ?? $counts['SCRAPED'] ?? 0));
        $resolved = max(0, (int) ($counts['RESOLVED'] ?? 0));
        return [
            'active' => $active,
            'scraped' => $active,
            'resolved' => $resolved,
            'all' => $active + $resolved,
            // Kept visible rather than folded away: the difference between the catalogue and
            // everything ever mined is the history the database exists to hold.
            'scrapedStored' => max(0, (int) ($counts['SCRAPED'] ?? 0)),
        ];
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
        // The in-play answer travels with the row for the same reason as on the catalogue
        // row above: the browser explains its own candidate refusals. The kickoff comes
        // with it, because the answer has to be recomputed rather than read off a boolean
        // frozen when the row was evaluated.
        'eventStarted',
        'eventStartTime',
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
        // Whether the fixture has actually kicked off, and the published kickoff it was
        // derived from. A separate question from the horizon -- a match in play still has
        // an hour or two to resolution -- and the browser explains its own candidate
        // refusals, so without these every row reaches it as "unknown" and a portfolio
        // set to in-play markets only looks like it is refusing everything at random.
        'eventStarted',
        'eventStartTime',
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

// Every id observation_market_shape() can return. Kept beside the classifier so the config
// normalizer validates against exactly what it knows, not a hand-kept list that drifts from it.
const MARKET_SHAPE_IDS = ['over-under', 'spread', 'exact-score', 'draw', 'in-event-leg', 'both-teams', 'outright'];

/**
 * Whether this market's price can WALK to a stop, or only JUMP past it -- and so whether a
 * stop loss can protect a position here at ANY setting. Mirrors paper-trading-bot.mjs's
 * marketShape() exactly (over-under reuses observation_is_over_under_market for the same
 * reason the Node copy reuses isOverUnderMarket: one definition of "over-under", not two
 * that can disagree). See that function for the measurement behind it.
 */
function observation_market_shape(array $item): string
{
    if (observation_is_over_under_market($item)) {
        return 'over-under';
    }
    $question = (string) ($item['question'] ?? '');
    $patterns = [
        '/^spread:|\bspread\b|\([-+]\d/i' => 'spread',
        '/exact score/i' => 'exact-score',
        '/\bdraw\b/i' => 'draw',
        '/set \d+ winner|\bgames total\b|map \d+|\bmap handicap\b|first .*(map|set|goal|blood)/i' => 'in-event-leg',
        '/both teams to/i' => 'both-teams',
    ];
    foreach ($patterns as $pattern => $label) {
        if (preg_match($pattern, $question) === 1) {
            return $label;
        }
    }
    return 'outright';
}

/**
 * A config's excludedMarketShapes, whatever it holds, reduced to only the ids the
 * classifier can actually produce -- an unknown value stored by an older or a future
 * client must not silently exclude nothing it did not mean to, nor crash on a value it
 * does not recognize.
 */
function normalize_market_shape_list(mixed $value): array
{
    if (!is_array($value)) {
        return [];
    }
    $shapes = [];
    foreach ($value as $candidate) {
        $shape = strtolower(trim((string) $candidate));
        if (in_array($shape, MARKET_SHAPE_IDS, true) && !isset($shapes[$shape])) {
            $shapes[$shape] = true;
        }
    }
    return array_keys($shapes);
}

/**
 * The one place the retired excludeOverUnderMarkets switch becomes part of the shape list.
 *
 * That boolean and the shape list were two switches for one restriction, sitting next to
 * each other in the form and enforced separately in about twenty places -- and because the
 * live order executor knew nothing about shapes, an over/under exclusion worked on a live
 * portfolio while the other five shape checkboxes silently did nothing there.
 *
 * So the list is now the only source of truth and the boolean is an INPUT to it: a config
 * saved before the merge, or written by an older client, keeps restricting exactly what it
 * always restricted. Everything that stores a config writes the boolean back DERIVED from
 * the list, so unchecking Over/Under in the shape group actually clears it -- honouring a
 * stored true alongside an explicit list would fold the exclusion straight back in and make
 * it impossible to turn off.
 */
function merge_excluded_market_shapes(mixed $shapes, mixed $legacyExcludeOverUnder): array
{
    $merged = normalize_market_shape_list($shapes);
    if ($legacyExcludeOverUnder === true && !in_array('over-under', $merged, true)) {
        $merged[] = 'over-under';
    }
    return $merged;
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

// Whether the fixture is under way, decided from the kickoff the row carries rather than
// from a boolean written when the row was last scanned. "Has it started" is true of a
// moment, not of a row, and a row scanned before kickoff stored false for the whole window
// an in-play portfolio exists to trade.
function observation_event_is_running(array $item): bool
{
    $kickoff = strtotime((string) ($item['eventStartTime'] ?? ''));
    if ($kickoff !== false) {
        return $kickoff <= time();
    }
    return ($item['eventStarted'] ?? null) === true;
}

// Hours until the market's own RESOLUTION date, not its endDate. For a sports fixture those
// are different dates -- the bot substitutes the kickoff into endDate -- so daysToResolution
// measures time to the start of the match rather than to its settlement. A fixture already
// under way read as a negative number and slipped past every ceiling there is. Computed from
// the date rather than the stored day count, which is frozen at scan time and goes stale.
function observation_hours_to_resolution(array $item): ?float
{
    $resolution = strtotime((string) ($item['resolutionEndDate'] ?? ''));
    if ($resolution !== false) {
        return ($resolution - time()) / 3600.0;
    }
    $days = $item['daysToResolution'] ?? null;
    return is_numeric($days) ? (float) $days * 24.0 : null;
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
    $hours = observation_hours_to_resolution($item);
    $maxHours = config_max_resolution_hours(is_array($config) ? $config : []);
    $liveEventMode = config_live_event_mode(is_array($config) ? $config : []);
    $running = observation_event_is_running($item);
    // A running fixture under "include" is admitted whatever the ceiling says: the ceiling
    // caps how long capital is committed, and a match in play is the shortest commitment
    // there is. Under "only" the ceiling is not a rule at all -- that mode admits nothing
    // by its horizon, and the dashboard hides the input, so enforcing one here would be an
    // invisible filter.
    $horizonApplies = $liveEventMode !== 'only' && !($liveEventMode === 'include' && $running);
    if ($horizonApplies && $hours !== null && $maxHours !== null && $hours > $maxHours) {
        return false;
    }
    // A separate question from the horizon: has the event actually started. A row that
    // cannot answer is excluded rather than assumed to be under way.
    if ($liveEventMode === 'only' && !$running) {
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
    // One gate for every shape, over-under included. excludeOverUnderMarkets used to be
    // checked separately right above the shape list, duplicating exactly one of the seven
    // shapes, so the same restriction had two switches that could disagree.
    $excludedShapes = merge_excluded_market_shapes(
        $config['excludedMarketShapes'] ?? [],
        $config['excludeOverUnderMarkets'] ?? false,
    );
    if ($excludedShapes !== [] && in_array(observation_market_shape($item), $excludedShapes, true)) {
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
// The same width for the scraped list, measured rather than chosen: 1200 compacted rows is
// about 3 MB, which the shared host serves in roughly a second. The whole active catalogue
// in one response was 21.32 MB in 2511 ms and it is what held the retention cap at 5000.
const SCRAPED_SCOPE_PAGE_LIMIT = 1200;

/**
 * A portfolio's scope expressed as database bounds.
 *
 * The contract that makes this safe: what comes back MUST be a superset of what
 * execution_scope_matches_observation() would keep. The database narrows on the three rules
 * that are columns -- the probability band, the resolution horizon, the liquidity floor --
 * and every rule that lives inside the payload still runs afterwards on what survived. A
 * bound that cannot be expressed exactly is left out rather than approximated, because a
 * clause that is slightly too tight silently hides tradable markets and nothing downstream
 * could tell.
 */
function execution_scope_storage_criteria(?array $config): array
{
    if (!is_array($config)) {
        return [];
    }
    $criteria = [];
    $minimum = normalize_probability_value($config['minProbability'] ?? null, 0.01);
    if (is_numeric($minimum)) {
        $criteria['minProbability'] = (float) $minimum;
    }
    $maximum = normalize_optional_probability_value($config['maxProbability'] ?? null);
    if ($maximum !== null) {
        $criteria['maxProbability'] = (float) $maximum;
    }
    $liquidity = normalize_optional_money_value($config['minLiquidityUsdc'] ?? null);
    if ($liquidity !== null) {
        $criteria['minLiquidityUsdc'] = (float) $liquidity;
    }
    // The horizon becomes a bound only when it applies to every row. Under "only" it is not
    // a rule at all, and under "include" a fixture already under way is admitted however far
    // its end date is -- both are per-row decisions, so turning either into a WHERE clause
    // would drop markets the portfolio trades.
    $mode = config_live_event_mode($config);
    $hours = config_max_resolution_hours($config);
    if ($mode !== 'only' && $mode !== 'include' && is_numeric($hours) && $hours > 0) {
        $criteria['endBefore'] = gmdate('Y-m-d H:i:s', time() + (int) round(((float) $hours) * 3600));
    }
    return $criteria;
}

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

function compact_state_payload(string $target, array $data, string $summary, ?string $selectedStrategyId = null, int $executionOffset = 0, string $scrapedScope = 'active'): array
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
        $totals = state_observation_totals($data);
        // Nothing is discarded on disk any more: the archive keeps every resolved market so
        // the counts reflect what was really mined. This is purely a response-size guard,
        // and it has to be a real one -- measured on a 5000-row active catalogue, serving
        // the whole resolved archive peaks near 111 MB at 8000 rows and a 128 MB host
        // answers 500 before that. observationTotals reports the true total regardless, so
        // the tab labels keep growing while the list serves pages of it.
        $resolvedServeLimit = 3000;

        // ONE catalogue per response. The first page used to carry its 1200 active rows AND
        // all 3000 resolved ones, which made the very request the dashboard blocks on the
        // largest of the walk: 11.56 MB, against a ten second timeout, over LTE. Now the
        // browser walks the active catalogue and then walks the resolved archive, and every
        // response is one page of one list.
        if ($scrapedScope === 'resolved') {
            $rows = array_values(array_filter(
                $observations,
                static fn($item): bool => is_array($item)
                    && !is_active_scraped_market_observation($item)
                    && is_resolved_scraped_market_observation($item),
            ));
            // Sorted before the page is taken, never within it, or each page would be
            // ordered only against itself and the archive would come out interleaved.
            usort($rows, static function (array $a, array $b): int {
                $left = strtotime((string) ($a['resolvedAt'] ?? $a['endDate'] ?? '')) ?: 0;
                $right = strtotime((string) ($b['resolvedAt'] ?? $b['endDate'] ?? '')) ?: 0;
                return $right <=> $left;
            });
            // Who applied the page: with the database serving, state_payload already asked
            // it for one page and slicing again would empty every offset past the first.
            if (!trading_storage_is_active()) {
                $rows = array_slice($rows, 0, $resolvedServeLimit);
                $rows = array_slice($rows, $executionOffset, SCRAPED_SCOPE_PAGE_LIMIT);
            }
            $scopeTotal = min($resolvedServeLimit, max(0, (int) ($totals['resolved'] ?? 0)));
            $resolvedTruncated = max(0, (int) ($totals['resolved'] ?? 0)) > $resolvedServeLimit;
        } else {
            $rows = array_values(array_filter($observations, static fn($item): bool => is_array($item) && is_active_scraped_market_observation($item)));
            if (!trading_storage_is_active()) {
                $rows = array_slice($rows, $executionOffset, SCRAPED_SCOPE_PAGE_LIMIT);
            }
            // From the COUNT query when the database is serving, so the walk is driven by
            // the true size of the catalogue rather than by how many rows survived this
            // page's filter -- reading it off the page is what would make a thinned page
            // look like the end of the list. On the file fallback the manifest count plays
            // the same part, and a pre-segmentation state counts its own inline rows.
            $scopeTotal = max(0, (int) ($totals['scraped'] ?? $totals['active'] ?? 0));
            $resolvedTruncated = max(0, (int) ($totals['resolved'] ?? 0)) > $resolvedServeLimit;
        }
        $active = $rows;
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
            'observationTotals' => $totals + ['resolvedTruncated' => $resolvedTruncated],
            // Where this page sits, how wide a page is, WHICH catalogue it is a page of, and
            // whether more of that catalogue remains. Without these a caller cannot tell a
            // short page from the end of the list, and the browser would stop walking
            // wherever the row filter happened to thin a page out.
            'scrapedScope' => $scrapedScope === 'resolved' ? 'resolved' : 'active',
            'scrapedScopeOffset' => $executionOffset,
            'scrapedScopeLimit' => SCRAPED_SCOPE_PAGE_LIMIT,
            'scrapedScopeTotal' => $scopeTotal,
            'scrapedScopeTruncated' => $scopeTotal > $executionOffset + SCRAPED_SCOPE_PAGE_LIMIT,
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
                'excludedMarketShapes' => [],
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
                'excludedMarketShapes' => [],
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
                'excludedMarketShapes' => [],
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
                'excludedMarketShapes' => [],
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
            'excludedMarketShapes' => [],
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
            'excludedMarketShapes' => [],
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
        'maxResolutionDays', 'maxResolutionHours', 'liveEventMode', 'requireEventStarted',
        'settlementCloseBid',
        'selectionOrder', 'marketType', 'excludedMarketShapes', 'probabilitySource',
        'minLiquidityUsdc', 'minNetYield', 'executionTrigger', 'executionCronMinutes',
        'useLimitOrders', 'autoRotatePositions', 'stopLossRiskMultiplier', 'reverseOnStopLoss',
        'includeOnlyMarketTags', 'excludedMarketTags', 'automationEnabled', 'archived',
        'dipEntryEnabled', 'dipEntryOpenMin', 'dipEntryOpenMax',
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
 * The dip-entry rule's opening band, as a portfolio stores it.
 *
 * There is no buy band here on purpose: the portfolio's ORDINARY probability range is where
 * the rule buys. Storing it twice was the first shape of this and it was wrong in the way
 * that matters -- the range is what execution_scope_matches_observation and the bot actually
 * filter on, so a portfolio whose range said 70-80 shortlisted favourites however its buy
 * band was set, which is exactly what was reported.
 * The rule itself lives in
 * tools/dip-entry-rule.mjs; this is the PHP copy of its normalizer, and a test holds the
 * two against each other.
 *
 * A band typed the wrong way round is swapped, because that is an ordering slip. Bands in
 * the wrong PLACE relative to each other are not corrected -- the buy band has to sit below
 * the opening band or the rule fires without a collapse -- because silently moving them
 * would invent an intent nobody expressed. The dashboard reports that as a fault instead.
 *
 * @return array{dipEntryEnabled: bool, dipEntryOpenMin: float, dipEntryOpenMax: float}
 */
function normalize_dip_entry_rule(array $input, array $defaults): array
{
    $bound = static function (string $key, float $fallback) use ($input, $defaults): float {
        return normalize_probability_value($input[$key] ?? ($defaults[$key] ?? null), $fallback);
    };
    $openMin = $bound('dipEntryOpenMin', 0.70);
    $openMax = $bound('dipEntryOpenMax', 0.80);
    $enabled = $input['dipEntryEnabled'] ?? ($defaults['dipEntryEnabled'] ?? false);
    return [
        'dipEntryEnabled' => $enabled === true || $enabled === 'true' || $enabled === 1 || $enabled === '1',
        'dipEntryOpenMin' => min($openMin, $openMax),
        'dipEntryOpenMax' => max($openMin, $openMax),
    ];
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

// The horizon a portfolio falls back to when neither it nor the request names one. Seven
// days, the ceiling every portfolio carried before the unit switch.
const DEFAULT_MAX_RESOLUTION_HOURS = 7.0 * 24.0;
const MAX_RESOLUTION_HOURS_CEILING = 365.0 * 24.0;

// The resolution horizon in HOURS. Days could not express 12, 6 or 1 hour at all: it
// rounded to a whole day with a minimum of 1, so everything under a day became 24 hours.
//
// Blank and non-positive both mean "not set" and return null; each caller then decides
// what unset means for it -- no ceiling when serving, the saved default when storing.
// Zero is not a way to ask for events already under way: a horizon of zero hours is a
// market that has already resolved. That is its own setting, liveEventMode.
function normalize_optional_hours_value(mixed $value): ?float
{
    if ($value === null || $value === '' || !is_numeric($value)) {
        return null;
    }
    $hours = (float) $value;
    if ($hours <= 0) {
        return null;
    }
    return max(1.0, min(MAX_RESOLUTION_HOURS_CEILING, round($hours, 2)));
}

// What a portfolio does about events that have already kicked off. Three states, because
// two different things were asked for and they are genuinely different rules: ignore (the
// default, and what every portfolio did before -- a running fixture is judged by the
// horizon like everything else), include (a running fixture is admitted whatever the
// horizon says, since the horizon caps capital turnover and a match in play is the
// shortest turnover there is), and only (nothing but running fixtures).
function normalize_live_event_mode_value(mixed $value): ?string
{
    $mode = strtolower(trim((string) $value));
    return in_array($mode, ['ignore', 'include', 'only'], true) ? $mode : null;
}

// Portfolios saved while this was a single checkbox carry requireEventStarted, which meant
// exactly the "only" state.
function config_live_event_mode(array $row): string
{
    $mode = normalize_live_event_mode_value($row['liveEventMode'] ?? null);
    if ($mode !== null) {
        return $mode;
    }
    return ($row['requireEventStarted'] ?? false) === true ? 'only' : 'ignore';
}

// A row's horizon whatever unit it was stored in. Portfolios saved before the switch carry
// maxResolutionDays and must keep meaning exactly what they meant.
function config_max_resolution_hours(array $row, ?float $fallback = null): ?float
{
    $hours = normalize_optional_hours_value($row['maxResolutionHours'] ?? null);
    if ($hours !== null) {
        return $hours;
    }
    $days = $row['maxResolutionDays'] ?? null;
    if (is_numeric($days) && (float) $days > 0) {
        return normalize_optional_hours_value((float) $days * 24.0);
    }
    return $fallback;
}

// A probability, or 0 for off. Bounded below at 0.5 because "the outcome is certain" is
// the only thing this is for: a portfolio closing at even money is not taking a settlement
// shortcut, it is just selling. Bounded above at 0.999 because at 1.0 nothing would ever
// trigger -- a resolved market is no longer quoted.
/**
 * The probability at which a position is sold regardless of what it cost.
 *
 * Asked for after two stops on one portfolio behaved oppositely: one fired too early and one
 * too late, from the same setting. That is not a misconfiguration, it is what the equal-risk
 * floor does -- the room a position gets before its planned loss matches its potential win
 * depends on the entry, so a 95c entry gets 8.7 points of room and a 72c entry gets 46.3.
 *
 * This floor does not depend on the entry at all. Below it the market has the other side
 * winning, which is the same statement whatever the position cost, and it is what stops a
 * cheap entry riding almost to zero before the equal-risk floor is reached.
 *
 * The two are combined by taking whichever the price meets first on the way down, which is
 * simply the higher of them -- "whichever comes first", as asked.
 *
 * 0 means off, matching how the stop multiplier and the certainty close read.
 */
// Where a stop loss is armed but no floor was chosen. Below 50% the market has the other
// side winning, and 49 is the first level that says so without sitting exactly on the coin
// flip a market hovers around.
const DEFAULT_STOP_LOSS_PROBABILITY_FLOOR = 0.49;

function normalize_stop_loss_probability_floor_value(mixed $value): float
{
    if ($value === null || $value === '' || !is_numeric($value)) {
        return 0.0;
    }
    $floor = (float) $value;
    if ($floor <= 0) {
        return 0.0;
    }
    // Above 0.95 is not a stop, it is an instruction to sell immediately: every position
    // this portfolio opens is bought below that. Bounded rather than accepted literally.
    return max(0.01, min(0.95, round($floor, 4)));
}

function normalize_settlement_close_bid_value(mixed $value): float
{
    if ($value === null || $value === '' || !is_numeric($value)) {
        return 0.0;
    }
    $bid = (float) $value;
    if ($bid <= 0) {
        return 0.0;
    }
    return max(0.5, min(0.999, round($bid, 4)));
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
    // 49% by default wherever a stop loss is armed, asked for after two stops on one
    // portfolio fired one too early and one too late. Applied here rather than written into
    // every stored config, because this normalizer runs on every read: an existing portfolio
    // picks it up without a migration, and one created tomorrow starts with it.
    //
    // Explicit key beats the default, exactly as the multiplier above does: absent means the
    // default, present means what it says. A stored 0 is the owner having turned it off and
    // survives either way, since 0 is not null -- what array_key_exists settles, and ?? does
    // not, is an explicitly stored NULL, which this reads as "off" rather than silently
    // re-arming a stop at the next read. Every read normalizes, so that would be for ever.
    //
    // Tied to the stop loss being armed: a portfolio with no protective exit has not asked
    // for one, and giving it a floor here would arm a stop nobody configured.
    if (array_key_exists('stopLossProbabilityFloor', $input)) {
        $stopLossProbabilityFloor = normalize_stop_loss_probability_floor_value($input['stopLossProbabilityFloor']);
    } elseif (array_key_exists('stopLossProbabilityFloor', $defaults)) {
        $stopLossProbabilityFloor = normalize_stop_loss_probability_floor_value($defaults['stopLossProbabilityFloor']);
    } else {
        $stopLossProbabilityFloor = $stopLossRiskMultiplier > 0 ? DEFAULT_STOP_LOSS_PROBABILITY_FLOOR : 0.0;
    }
    // The bid at which a position is sold rather than held to settlement. A market quoting
    // the outcome as certain still takes hours to resolve on Polymarket, and the capital is
    // locked for all of it. Selling one tick below pays about a cent a share to get it back
    // now. 0 means off, matching stopLossRiskMultiplier's idiom.
    $settlementCloseBid = normalize_settlement_close_bid_value(
        $input['settlementCloseBid'] ?? ($defaults['settlementCloseBid'] ?? null)
    );
    $minProbability = normalize_probability_value($input['minProbability'] ?? null, (float) $defaults['minProbability']);
    $maxProbability = normalize_optional_probability_value($input['maxProbability'] ?? ($defaults['maxProbability'] ?? null));
    if ($maxProbability !== null && $maxProbability < $minProbability) {
        $maxProbability = $minProbability;
    }
    // Hours if the client sent hours, else its days reading, else whatever the portfolio
    // already had -- so an older client that still posts only days cannot blank the
    // horizon, and a portfolio saved before the switch keeps exactly its old ceiling.
    $maxResolutionHours = config_max_resolution_hours(
        $input,
        config_max_resolution_hours($defaults, DEFAULT_MAX_RESOLUTION_HOURS)
    );
    // The mode if the client sent one, else its checkbox reading, else whatever the
    // portfolio already had -- so an older client posting only the boolean cannot silently
    // reset a portfolio set to "include".
    $liveEventMode = normalize_live_event_mode_value($input['liveEventMode'] ?? null)
        ?? (array_key_exists('requireEventStarted', $input)
            ? (($input['requireEventStarted'] === true) ? 'only' : 'ignore')
            : config_live_event_mode($defaults));
    // The shape list the client sent, else the portfolio's own, with the retired
    // excludeOverUnderMarkets boolean folded in. The boolean is read from $input ONLY, never
    // from $defaults: the stored value is now derived from this very list, so falling back
    // to it would fold a cleared exclusion straight back in and Over/Under could never be
    // unchecked again.
    $excludedMarketShapes = merge_excluded_market_shapes(
        $input['excludedMarketShapes'] ?? $defaults['excludedMarketShapes'] ?? [],
        ($input['excludeOverUnderMarkets'] ?? false) === true,
    );
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
        // Hours is the stored unit; days is written alongside it, derived, so a reader that
        // has not migrated yet still sees a sane number instead of nothing.
        'maxResolutionHours' => $maxResolutionHours,
        'maxResolutionDays' => (int) max(1, min(365, (int) round($maxResolutionHours / 24.0))),
        'settlementCloseBid' => $settlementCloseBid,
        // Sold at this probability whatever the entry cost. Combined with the equal-risk
        // floor by taking whichever the price meets first on the way down.
        'stopLossProbabilityFloor' => $stopLossProbabilityFloor,
        'liveEventMode' => $liveEventMode,
        // Derived and kept only while readers that predate the three states are still in
        // circulation. liveEventMode is the stored setting.
        'requireEventStarted' => $liveEventMode === 'only',
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
        // Which market SHAPES this portfolio refuses -- over-under, spread, exact-score,
        // draw, in-event-leg, both-teams, outright. A shape is how the price MOVES: whether
        // it can walk down to a stop or only jump past it. That is a different axis from
        // marketType above, which is how many outcomes the market has, and the two do not
        // collapse into one control: an over/under is binary and a jump, an outright
        // two-team match is binary and a walk, a tournament winner is multi and a walk, an
        // exact score is multi and a jump. Absent means every shape is tradable.
        //
        // excludeOverUnderMarkets was a second switch for one of these seven, and is now
        // folded in rather than stored independently -- see merge_excluded_market_shapes.
        'excludedMarketShapes' => $excludedMarketShapes,
        // Derived, never an input of its own from here on, so a reader that predates the
        // merge still sees the restriction and unchecking Over/Under in the shape group
        // actually clears it.
        'excludeOverUnderMarkets' => in_array('over-under', $excludedMarketShapes, true),
        // The dip-entry rule: buy a favourite that has collapsed inside a fixture already
        // under way. Two bands rather than one threshold -- where the market OPENED, and
        // where it is trading NOW -- because the pattern is a fall, not a level. Off by
        // default on every portfolio, and self-contained: tools/dip-entry-rule.mjs holds
        // the rule, these five keys hold its configuration, and removing both removes the
        // feature. See that file for why it needs its own watch rather than the scraped
        // catalogue, which cannot see a fallen favourite at all.
        ...normalize_dip_entry_rule(is_array($input) ? $input : [], $defaults),
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
    // Counted apart, because the two are bounded for different reasons: an ACTIVE portfolio
    // is a strategy every scheduled pass runs, while an ARCHIVED one is only a stored
    // record. Sharing one cap meant archiving consumed the run budget it had just stopped
    // using, and since nothing can delete a portfolio the cap could only ever be reached.
    $customCount = 0;
    $archivedCount = 0;
    foreach ($paperInput as $rawId => $strategyInput) {
        if (isset($config['paper'][$rawId]) || !is_array($strategyInput)) {
            continue;
        }
        $id = normalize_custom_paper_portfolio_id($rawId);
        if ($id === null) {
            continue;
        }
        $isArchived = ($strategyInput['archived'] ?? false) === true;
        if ($isArchived) {
            if ($archivedCount >= ARCHIVED_PAPER_PORTFOLIO_LIMIT) {
                continue;
            }
            $archivedCount += 1;
        } else {
            if ($customCount >= CUSTOM_PAPER_PORTFOLIO_LIMIT) {
                continue;
            }
            $customCount += 1;
        }
        $config['paper'][$id] = normalize_strategy_config($strategyInput, custom_paper_portfolio_defaults($id));
        // Stated rather than inferred from "not one of the four shipped ids", so the
        // browser and the bot agree on which portfolios the user owns outright.
        $config['paper'][$id]['custom'] = true;
    }
    $config['live'] = normalize_strategy_config($liveInput, $defaults['live']);
    // The base live portfolio used to be pinned visible here -- archived forced back to
    // false on every save -- because it represents the connected wallet and hiding it
    // would hide real exposure. That reasoning rested on archiving abandoning the
    // positions, which it no longer does: an archived portfolio's holdings stay under the
    // exit worker's watch, so archiving is now only a dashboard decision and the person
    // whose wallet it is can make it.
    //
    // Worth knowing before making it: this portfolio is the catch-all for every live row
    // no run log claims -- 327 of 333 closed rows on this account -- so archiving it takes
    // that history off the dashboard as well. The money stays managed either way.
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
    if (!is_array($row)) {
        return null;
    }
    // Archiving deliberately absent, exactly like automation below. Archiving is a display
    // decision -- take this portfolio off my dashboard -- and it used to return null here,
    // which silently took every position the portfolio still held out of the worker's watch
    // list: no stop loss, no certainty close, a position free to run to zero unattended.
    // That is the same fault the automation switch had, reported on "Will Wrexham AFC win",
    // and hiding a row is even less of a reason to abandon it than switching it off.
    //
    // What still stops an archived portfolio is OPENING positions, which is decided
    // elsewhere; nothing here re-enables entries.

    // Switching a portfolio off stops it OPENING positions. It does not abandon the money
    // already committed.
    //
    // This used to return null here, which took every position the portfolio held out of
    // the worker's watch list entirely -- so a switched-off portfolio had no stop loss and
    // no certainty close, and a position could run to zero unattended. Reported on "Will
    // Wrexham AFC win on 2026-09-05?": priced at 100% for the outcome held, portfolio off,
    // and "in the policy payload now: no".
    //
    // The paper side has always drawn the line here: refreshTrades marks and manages every
    // portfolio's open positions on every pass, and only the ENTRY path
    // (strategyMatchesExecutionTrigger) consults the switch. Live now matches it.
    //
    // What the switch does still stop is the reversal, below: buying the opposite outcome
    // after a stop fires is opening a position, which is the one thing "off" must prevent.
    $automationEnabled = ($row['automationEnabled'] ?? true) !== false;
    $multiplier = normalize_stop_loss_risk_multiplier_value(
        $row['stopLossRiskMultiplier'] ?? (($row['stopLossEnabled'] ?? false) ? 1.0 : 0.0),
        0.0
    );
    // Two independent reasons to watch a position, and either one is enough. Requiring a
    // stop loss here would mean a portfolio that only wants its settled positions closed
    // early was never watched at all -- the worker only ever looks at what this names.
    $settlementCloseBid = normalize_settlement_close_bid_value($row['settlementCloseBid'] ?? null);
    $probabilityFloor = normalize_stop_loss_probability_floor_value($row['stopLossProbabilityFloor'] ?? null);
    // A third independent reason to watch a position. A portfolio that sets only this one
    // still has a stop, and requiring one of the other two here would leave it unwatched --
    // the same fault the settlement close had before it was added to this line.
    if ($multiplier <= 0 && $settlementCloseBid <= 0 && $probabilityFloor <= 0) {
        return null;
    }
    return [
        'portfolioId' => $portfolioId,
        'stopLossRiskMultiplier' => $multiplier,
        // Runs on a switched-off portfolio too, and that is the owner's rule rather than an
        // oversight. I gated this on automation yesterday, arguing that buying the opposite
        // outcome opens a position and "off" must prevent that. The rule is narrower than I
        // read it: switching a portfolio off stops it EVALUATING and OPENING new positions
        // of its own -- what the run log shows. The reversal is not that. It is part of how
        // the stop loss closes a position the portfolio already had, and a stop that sells
        // but cannot take the other side is half a stop.
        'reverseOnStopLoss' => (bool) ($row['reverseOnStopLoss'] ?? false),
        'automationEnabled' => $automationEnabled,
        // The bid at which the position is sold rather than held to settlement. 0 means the
        // portfolio does not take that shortcut.
        'settlementCloseBid' => $settlementCloseBid,
        // The probability at which the position is sold regardless of what it cost. Unlike
        // the multiplier's floor this does not move with the entry, which is what stops a
        // cheap entry riding almost to zero before the equal-risk floor is reached.
        'stopLossProbabilityFloor' => $probabilityFloor,
        // Named so the worker never infers a stop from a policy that exists only for the
        // settlement close: a 0 multiplier must not be read as "use the default". The
        // probability floor is its own trigger and does not need the multiplier armed.
        'stopLossEnabled' => $multiplier > 0,
        'enabled' => true,
    ];
}

/**
 * Why a portfolio has no active stop-loss policy, in the words the dashboard shows.
 * Returns null when it does have one.
 */
function live_stop_loss_policy_absence_reason(array $config, string $portfolioId): ?string
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
    if (!is_array($row)) {
        return 'portfolio is not configured';
    }
    // Archiving deliberately absent from this list too, for the reason given in
    // live_stop_loss_policy_config: an archived portfolio's open positions are still
    // watched, so "archived" is no longer a reason one goes unwatched.
    // Automation deliberately absent from this list. Switching a portfolio off stops it
    // opening positions; it does not stop the rules that manage what it already holds, so
    // it is no longer a reason a position goes unwatched.
    $multiplier = normalize_stop_loss_risk_multiplier_value(
        $row['stopLossRiskMultiplier'] ?? (($row['stopLossEnabled'] ?? false) ? 1.0 : 0.0),
        0.0
    );
    if ($multiplier > 0) {
        return null;
    }
    return normalize_settlement_close_bid_value($row['settlementCloseBid'] ?? null) > 0
        ? null
        : 'neither a stop loss nor a certainty close is configured';
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

// Which run records say "this portfolio sent an order for this token". Ownership only --
// it decides whose stop loss protects the position, never whether one exists.
//
// PENDING_MATCH belongs here and its absence was a critical fault. It is written when the
// exchange takes an order whose match is queued, which is the normal answer for the
// fill-and-kill orders an in-play portfolio sends: "Underway Live" opens almost entirely
// this way. Naming that case separately from SUBMITTED was right for the run log and
// wrong here, and it silently un-owned every position that portfolio opened -- dropping
// them out of the policy payload, so nothing watched them and no stop could fire.
//
// The lesson is in the asymmetry: a queued order is NOT a position, which is why the run
// log must not call it one -- but it IS this portfolio's order, which is all ownership
// asks. A position that does not exist yet needs no stop; one that appears later needs its
// own portfolio's, and this is the only record that says whose it is.
const LIVE_EXECUTION_SUBMITTED_ACTIONS = [
    'SUBMITTED',
    'CANCELED_AND_SUBMITTED',
    'ROTATED_OPENED',
    'PENDING_MATCH',
];

function live_execution_record_was_submitted(array $record): bool
{
    $action = strtoupper(trim((string) ($record['action'] ?? ($record['batchLog']['action'] ?? ''))));
    return in_array($action, LIVE_EXECUTION_SUBMITTED_ACTIONS, true);
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

/**
 * Ready-to-fire dip-entry plans, one per portfolio and token.
 *
 * The dip-entry rule buys a favourite that has collapsed inside a fixture already under
 * way, and the trough lasts minutes. Nothing that has to start a GitHub runner can act on
 * that, so the decision is split the same way the stop loss already is: everything slow is
 * computed HERE, and the RPi worker -- which is already round the loop every second, with
 * the signing key and the entry claim -- does nothing at fire time but place the order.
 *
 * "Pre-prepared" means literally that. Each plan carries the size, the price ceiling, the
 * tick size and a diversification verdict, all decided before the price ever reaches the
 * band. The worker's only remaining questions are the two that cannot be answered early:
 * is the book inside the buy band right now, and is there cash.
 *
 * The watch entry is built while the market is STILL THE FAVOURITE, which is what makes
 * this work at all: at 70-80% the row is in the catalogue, and at 35% it is not -- both the
 * scan's retention and is_active_scraped_market_observation() keep only the leading outcome
 * above 0.50. So the token is picked up on the way in and followed down by the worker, which
 * holds the watch set itself. This endpoint is deliberately stateless.
 */
function live_dip_entry_watch_payload(): array
{
    $config = load_portfolio_config();
    $portfolioIds = ['live', 'live5050'];
    foreach ((array) ($config['livePortfolios'] ?? []) as $id => $row) {
        if (is_array($row)) {
            $portfolioIds[] = 'live-custom-' . (string) $id;
        }
    }
    // Paper portfolios watch too, and that is the whole point of this half: the rule fires
    // on a trough that lasts minutes, and the paper bot runs hourly, so a paper portfolio
    // could never test it from its own cadence. It contributes its tokens to the SAME
    // one-second poll the live portfolios use, and what the poll finds is recorded as a hit
    // for the bot to open a simulated position from at the price the dip actually reached.
    //
    // Nothing about the scraped catalogue changes for this. A collapsed favourite is not in
    // the catalogue at all -- above 50% it is a row, at 35% it is not -- so the token is
    // picked up here while it is still the favourite and followed down by the worker.
    foreach ((array) ($config['paper'] ?? []) as $id => $row) {
        if (is_array($row)) {
            $portfolioIds[] = 'paper-' . (string) $id;
        }
    }

    $active = [];
    foreach ($portfolioIds as $portfolioId) {
        $paperId = str_starts_with($portfolioId, 'paper-') ? substr($portfolioId, strlen('paper-')) : null;
        $portfolio = $paperId === null
            ? execution_scope_strategy_config($portfolioId === 'live5050' ? 'live5050' : $portfolioId)
            : (is_array($config['paper'][$paperId] ?? null) ? $config['paper'][$paperId] : null);
        if (!is_array($portfolio)) {
            continue;
        }
        $rule = normalize_dip_entry_rule($portfolio, []);
        // Off, archived or automation-off portfolios contribute nothing to watch. An
        // experiment that keeps trading after it is switched off is not switched off.
        if (!$rule['dipEntryEnabled'] || ($portfolio['archived'] ?? false) === true) {
            continue;
        }
        if (($portfolio['automationEnabled'] ?? true) !== true) {
            continue;
        }
        // The same refusal the rule reports on the dashboard: a probability range reaching
        // into the opening band would fire on a market that never fell. No maximum is the
        // same fault -- an open-ended range necessarily overlaps.
        $buyMax = normalize_optional_probability_value($portfolio['maxProbability'] ?? null);
        if ($buyMax === null || $buyMax >= $rule['dipEntryOpenMin']) {
            continue;
        }
        $buyMin = normalize_probability_value($portfolio['minProbability'] ?? null, 0.01);
        $active[$portfolioId] = [
            'portfolio' => $portfolio,
            'rule' => $rule,
            'buyMin' => $buyMin,
            'buyMax' => $buyMax,
            // What the worker does when the price arrives: place an order, or record a hit
            // for the paper bot. Decided here rather than by the worker parsing an id.
            'accountType' => $paperId === null ? 'live' : 'paper',
        ];
    }
    if ($active === []) {
        return ['ok' => true, 'generatedAt' => gmdate('c'), 'cashUsdc' => null, 'plans' => [], 'portfolios' => []];
    }

    $live = decode_state_file(live_state_path(), false);
    $live = is_array($live) ? $live : [];
    $cash = is_numeric($live['portfolio']['cashUsdc'] ?? null) ? (float) $live['portfolio']['cashUsdc'] : null;
    // What the wallet is already exposed to. A dip entry must not double an existing
    // position or collide with a resting bid, and the worker cannot work that out at fire
    // time -- so it is decided here, while there is time to be careful about it.
    $heldTokens = [];
    $heldConditions = [];
    foreach ([$live['positions'] ?? [], $live['openOrders'] ?? []] as $rows) {
        foreach (is_array($rows) ? $rows : [] as $row) {
            if (!is_array($row)) {
                continue;
            }
            $token = trim((string) ($row['tokenId'] ?? $row['assetId'] ?? ''));
            if ($token !== '') {
                $heldTokens[$token] = true;
            }
            $condition = trim((string) ($row['conditionId'] ?? ''));
            if ($condition !== '') {
                $heldConditions[$condition] = true;
            }
        }
    }

    $state = state_payload('paper', ['observations']);
    $observations = is_array($state['marketObservations'] ?? null) ? $state['marketObservations'] : [];
    $plans = [];
    foreach ($observations as $item) {
        if (!is_array($item)) {
            continue;
        }
        // Underway only, and the rule says so rather than the portfolio's resolution
        // filter: before kick-off a collapsed price is not a collapse, it is a different
        // market.
        if (!observation_event_is_running($item)) {
            continue;
        }
        $opened = null;
        foreach (['firstMarketProbability', 'marketProbability', 'marketPrice'] as $field) {
            if (is_numeric($item[$field] ?? null)) {
                $opened = (float) $item[$field];
                break;
            }
        }
        if ($opened === null) {
            continue;
        }
        $tokenId = trim((string) ($item['tokenId'] ?? $item['clobTokenIds'][0] ?? ''));
        if ($tokenId === '') {
            continue;
        }
        $conditionId = trim((string) ($item['conditionId'] ?? ''));
        foreach ($active as $portfolioId => $entry) {
            $rule = $entry['rule'];
            if ($opened < $rule['dipEntryOpenMin'] || $opened > $rule['dipEntryOpenMax']) {
                continue;
            }
            // Every other filter this portfolio has, applied now rather than at fire time.
            // execution_scope_matches_observation reads the portfolio's own probability
            // range, which the row still satisfies while it is the favourite -- and that is
            // the point: the tags, shape, market type, liquidity and spread checks are all
            // settled here, on the way in.
            // Shortlisted on the OPENING band, deliberately, not on the portfolio's own
            // probability range. The market is picked up while it is STILL the favourite --
            // at 70-80%, which is where the catalogue has it -- and followed down; the
            // range is where it will be BOUGHT, hours later, by which time this row is
            // gone from the catalogue entirely. Applying the range here would reject every
            // market the rule exists to find.
            $scope = array_merge($entry['portfolio'], [
                'minProbability' => $rule['dipEntryOpenMin'],
                'maxProbability' => $rule['dipEntryOpenMax'],
            ]);
            if (!execution_scope_matches_observation($item, $scope)) {
                continue;
            }
            // Diversification, decided here so the worker has nothing to work out at fire
            // time. Only for LIVE: these are the shared wallet's holdings, and a paper
            // portfolio has its own -- the paper bot applies its own risk rules when it
            // opens the simulated position, and borrowing the wallet's here would refuse a
            // paper entry because some live portfolio happens to hold the market.
            $blocked = '';
            if ($entry['accountType'] === 'live') {
                if (isset($heldTokens[$tokenId])) {
                    $blocked = 'the wallet already holds or has a resting order on this token';
                } elseif ($conditionId !== '' && isset($heldConditions[$conditionId])) {
                    $blocked = 'the wallet already has a position in this market';
                }
            }
            $stake = normalize_optional_money_value($entry['portfolio']['stakeUsdc'] ?? null);
            $plans[] = [
                'portfolioId' => $portfolioId,
                'accountType' => $entry['accountType'],
                'tokenId' => $tokenId,
                'conditionId' => $conditionId,
                'question' => (string) ($item['question'] ?? ''),
                'outcome' => (string) ($item['outcome'] ?? ''),
                'openProbability' => round($opened, 4),
                // The band the worker fires inside. Its ceiling is also the highest price
                // the order may pay, so a book that has already recovered cannot be bought
                // at the recovered price by a worker that was a second late.
                'buyMin' => $entry['buyMin'],
                'buyMax' => $entry['buyMax'],
                'stakeUsdc' => $stake,
                'tickSize' => is_numeric($item['tickSize'] ?? null) ? (float) $item['tickSize'] : 0.01,
                // Carried so a portfolio's minimum-volume floor still applies when the row
                // reaches the paper bot as a recorded hit -- by then the market is out of
                // the catalogue and there is nothing else to read it from.
                'volumeUsdc' => is_numeric($item['volumeUsdc'] ?? null)
                    ? (float) $item['volumeUsdc']
                    : (is_numeric($item['liquidity'] ?? null) ? (float) $item['liquidity'] : null),
                'endDate' => (string) ($item['resolutionEndDate'] ?? $item['endDate'] ?? ''),
                'negRisk' => ($item['negRisk'] ?? null) === true,
                // Empty means clear to fire. Published rather than filtered out, so the
                // worker's log can say why a watched market was not bought.
                'blockedReason' => $blocked,
                'preparedAt' => gmdate('c'),
            ];
        }
    }

    return [
        'ok' => true,
        'generatedAt' => gmdate('c'),
        // The worker will not place an order without cash for it. Published so the refusal
        // is one number rather than a second account fetch inside the fast path.
        'cashUsdc' => $cash,
        'plans' => $plans,
        'portfolios' => array_keys($active),
    ];
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

    // Ownership is established before any policy is applied, and for EVERY live portfolio
    // including those with no active stop loss. Skipping the unprotected ones here, as this
    // used to, made their positions look unowned two passes further down -- where the
    // fallback would hand them the main Live portfolio's cap. A switched-off portfolio's
    // position would then have been sold under a policy its own portfolio never set.
    $ownerOf = [];
    $ownedAt = [];
    $policyByPortfolio = [];
    foreach ($portfolioIds as $portfolioId) {
        $policyByPortfolio[$portfolioId] = live_stop_loss_policy_config($config, $portfolioId);
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
                // A token can be seen in an older strategy state after it has been
                // traded again. The newest accepted order owns it.
                if (isset($ownerOf[$tokenId]) && strcmp((string) ($ownedAt[$tokenId] ?? ''), $updatedAt) > 0) {
                    continue;
                }
                $ownerOf[$tokenId] = $portfolioId;
                $ownedAt[$tokenId] = $updatedAt;
            }
        }
    }

    $policies = [];
    $excluded = [];
    foreach ($ownerOf as $tokenId => $portfolioId) {
        $policy = $policyByPortfolio[$portfolioId] ?? null;
        if ($policy !== null) {
            $policies[$tokenId] = array_merge($policy, [
                'tokenId' => $tokenId,
                'updatedAt' => (string) ($ownedAt[$tokenId] ?? ''),
            ]);
            continue;
        }
        // Named rather than merely omitted. The worker treats any position it does not
        // find in this list as covered by defaultPolicy, so leaving a token out is not a
        // way to leave it alone -- it is a way to give it somebody else's stop. An
        // explicit exclusion is the only instruction that means "hands off this one".
        $excluded[$tokenId] = [
            'tokenId' => $tokenId,
            'portfolioId' => $portfolioId,
            'enabled' => false,
            'reason' => live_stop_loss_policy_absence_reason($config, $portfolioId) ?? 'no stop loss is configured',
            'updatedAt' => (string) ($ownedAt[$tokenId] ?? ''),
        ];
    }

    // Everything above derives the watchlist from the RUN LOGS: a token is watched only
    // while the run that ordered it is still retained. That log is bounded and compacted,
    // so a position stops being watched once its run scrolls out -- while the position is
    // still open and still holding real money. Measured on production: 2 of 12 open
    // positions were absent from this payload, including a 4.99 USDC stake.
    //
    // The account's own open positions are the authoritative list of what needs
    // protecting, so they are added here. The run-log pass above is kept, and kept first,
    // because it is what ATTRIBUTES a token to the portfolio that ordered it -- a position
    // already attributed keeps its owner's policy, including its multiplier. Only
    // positions no attribution reached fall through to the default.
    $liveState = decode_state_file(state_file_paths()['live'] ?? '', false);
    $positions = is_array($liveState['positions'] ?? null) ? $liveState['positions'] : [];
    $fallback = live_stop_loss_policy_config($config, 'live');
    $adoptedFromPositions = 0;
    $unattributed = 0;
    foreach ($positions as $position) {
        if (!is_array($position)) {
            continue;
        }
        $tokenId = trim((string) ($position['tokenId'] ?? $position['assetId'] ?? ''));
        if ($tokenId === '' || isset($policies[$tokenId])) {
            continue;
        }
        // A position whose own portfolio has no active stop loss is not unattributed --
        // it is deliberately unprotected, and the exclusion above says so by name. The
        // fallback must not quietly adopt it.
        if (isset($excluded[$tokenId])) {
            continue;
        }
        $unattributed++;
        if ($fallback === null) {
            // No default policy means the main live portfolio has no stop loss configured.
            // Inventing one for a position it does not own would apply a cap the operator
            // never set, so the position stays unwatched and the count below says so.
            continue;
        }
        $policies[$tokenId] = array_merge($fallback, [
            'tokenId' => $tokenId,
            // No run claimed it, so there is no order time to carry. The empty stamp keeps
            // the "newest accepted order wins" comparison above working: any later
            // attributed order sorts above this.
            'updatedAt' => '',
            'source' => 'open-position',
        ]);
        $adoptedFromPositions++;
    }

    // The original Live strategy predates per-order execution state. When enabled,
    // it deliberately protects otherwise unlabelled positions on the same connected
    // account as well. Custom live portfolios are never used as this fallback.
    return [
        'ok' => true,
        'generatedAt' => gmdate('c'),
        'policies' => array_values($policies),
        // Positions the worker must leave alone even though defaultPolicy would otherwise
        // reach them: their own portfolio is switched off, archived, or has no stop loss.
        'excluded' => array_values($excluded),
        // Stated so a gap is visible rather than silent: how many open positions no run
        // log accounted for, and how many of those the default could actually cover.
        'openPositions' => count($positions),
        'positionsWithoutRunLogAttribution' => $unattributed,
        'positionsAdoptedFromAccount' => $adoptedFromPositions,
        'positionsLeftUnwatched' => $unattributed - $adoptedFromPositions,
        'positionsExcludedByOwner' => count($excluded),
        'defaultPolicy' => $fallback,
    ];
}

function workflow_target_key(string $target): string
{
    if (paper_strategy_from_target($target) !== null) {
        return 'paper';
    }
    return custom_live_portfolio_id_from_target($target) !== null ? 'live' : $target;
}

/**
 * A CLOB order has no client supplied idempotency key. Keep a tiny, independent
 * ledger on the host so every live entry route reserves a token before it sends a
 * signed BUY. The account snapshot is intentionally not that lock: two runners can
 * both have read the same snapshot before either newly submitted order is visible.
 */
/**
 * Dips the RPi worker actually saw, for the paper bot to open simulated positions from.
 *
 * This is the paper half of the rule and the reason it exists at all. The trough lasts
 * minutes; the paper bot runs hourly, so it can never witness one. The worker is already
 * round the loop every second with these tokens in its batch, so it records WHEN the price
 * entered the band and AT WHAT PRICE, and the bot opens the position from that record on its
 * next run -- a simulated entry at the price the dip actually reached rather than at
 * whatever the market has drifted to an hour later.
 *
 * Append-only with a TTL. Nothing here is authoritative about a portfolio's state: it is a
 * record of observations, and the bot decides what to do with them under its own rules.
 */
function dip_entry_hits_path(): string
{
    return __DIR__ . '/data/dip-entry-hits.json';
}

const DIP_ENTRY_HIT_TTL_SECONDS = 172800;
const DIP_ENTRY_HIT_LIMIT = 500;

function read_dip_entry_hits(): array
{
    $stored = decode_state_file(dip_entry_hits_path(), false);
    $hits = is_array($stored['hits'] ?? null) ? $stored['hits'] : [];
    $cutoff = time() - DIP_ENTRY_HIT_TTL_SECONDS;
    $kept = [];
    foreach ($hits as $hit) {
        if (!is_array($hit)) {
            continue;
        }
        $at = strtotime((string) ($hit['at'] ?? ''));
        if ($at === false || $at < $cutoff) {
            continue;
        }
        $kept[] = $hit;
    }
    return $kept;
}

function record_dip_entry_hit(array $input): array
{
    $tokenId = trim((string) ($input['tokenId'] ?? ''));
    $portfolioId = trim((string) ($input['portfolioId'] ?? ''));
    $price = is_numeric($input['price'] ?? null) ? (float) $input['price'] : null;
    if ($tokenId === '' || $portfolioId === '' || $price === null || $price <= 0 || $price >= 1) {
        return ['ok' => false, 'reason' => 'tokenId, portfolioId and a price between 0 and 1 are required'];
    }
    $hits = read_dip_entry_hits();
    // One hit per portfolio and token, ever. The worker already refuses to fire twice, but
    // it restarts, and a second record would become a second simulated position in a market
    // the portfolio entered once.
    foreach ($hits as $hit) {
        if ((string) ($hit['tokenId'] ?? '') === $tokenId && (string) ($hit['portfolioId'] ?? '') === $portfolioId) {
            return ['ok' => true, 'recorded' => false, 'reason' => 'already recorded'];
        }
    }
    $hits[] = [
        'portfolioId' => $portfolioId,
        'tokenId' => $tokenId,
        'conditionId' => trim((string) ($input['conditionId'] ?? '')),
        'question' => (string) ($input['question'] ?? ''),
        'outcome' => (string) ($input['outcome'] ?? ''),
        'slug' => (string) ($input['slug'] ?? ''),
        // The price the dip actually reached, which is what the simulated entry pays. The
        // whole value of recording this is that it is not the price an hour later.
        'price' => round($price, 6),
        'openProbability' => is_numeric($input['openProbability'] ?? null) ? round((float) $input['openProbability'], 4) : null,
        'volumeUsdc' => is_numeric($input['volumeUsdc'] ?? null) ? (float) $input['volumeUsdc'] : null,
        'endDate' => (string) ($input['endDate'] ?? ''),
        'at' => gmdate('c'),
    ];
    if (count($hits) > DIP_ENTRY_HIT_LIMIT) {
        $hits = array_slice($hits, -DIP_ENTRY_HIT_LIMIT);
    }
    $path = dip_entry_hits_path();
    $dir = dirname($path);
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
        return ['ok' => false, 'reason' => 'unable to create the data directory'];
    }
    $encoded = json_encode(
        ['generatedAt' => gmdate('c'), 'hits' => $hits],
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
    );
    if (!is_string($encoded) || file_put_contents($path, $encoded . "\n", LOCK_EX) === false) {
        return ['ok' => false, 'reason' => 'unable to persist the dip entry hit'];
    }
    return ['ok' => true, 'recorded' => true];
}

function live_entry_claim_path(): string
{
    return __DIR__ . '/data/live-entry-claims.json';
}

// Why a live position was sold, keyed by the token it was sold from.
//
// Reported: the closed-positions list shows no record that a stop loss ever fired. It
// could not: the exit worker records every fill in its own state file ON THE PI, which is
// never published, and the account sync that produces the dashboard's closed positions
// learns only from Polymarket -- where a protective sell and a manual one are the same
// event. So the reason lived on a machine nobody reads and the screen showed a position
// that had simply vanished.
//
// This is the reason travelling with the fill, written by the worker at the moment it
// knows it, and attached to the closed position when the state is served.
function live_exit_record_path(): string
{
    return __DIR__ . '/data/live-exit-records.json';
}

function live_exit_records(): array
{
    $stored = decode_state_file(live_exit_record_path(), false);
    return is_array($stored['records'] ?? null) ? $stored['records'] : [];
}

function live_exit_record_request(array $payload): array
{
    $tokenId = preg_replace('/[^0-9]/', '', (string) ($payload['tokenId'] ?? ''));
    if ($tokenId === '') {
        return ['ok' => false, 'error' => 'tokenId is required'];
    }
    // "stop-declined" is a stop that fired and deliberately did NOT sell, because the book had
    // gapped below the band the stop will sell in. It is the one exit outcome that leaves the
    // position OPEN, and without a record of it a position sitting open with its stop long
    // since reached is indistinguishable from one the stop never noticed -- which is exactly
    // what was asked for: "uvedes v poznamce ... na jake urovni s jakym p/l byla snaha o stop
    // loss a jak to proc dopadlo".
    $reason = strtolower(trim((string) ($payload['reason'] ?? 'stop')));
    if (!in_array($reason, ['stop', 'settlement', 'stop-declined'], true)) {
        $reason = 'stop';
    }
    $record = [
        'tokenId' => $tokenId,
        'reason' => $reason,
        'at' => gmdate('c'),
        'portfolioId' => preg_replace('/[^A-Za-z0-9_-]/', '', (string) ($payload['portfolioId'] ?? '')),
        'question' => compact_text($payload['question'] ?? '', 200),
        'outcome' => compact_text($payload['outcome'] ?? '', 60),
        'exitPrice' => is_numeric($payload['exitPrice'] ?? null) ? round((float) $payload['exitPrice'], 6) : null,
        'stopPrice' => is_numeric($payload['stopPrice'] ?? null) ? round((float) $payload['stopPrice'], 6) : null,
        'bestBid' => is_numeric($payload['bestBid'] ?? null) ? round((float) $payload['bestBid'], 6) : null,
        'bestAsk' => is_numeric($payload['bestAsk'] ?? null) ? round((float) $payload['bestAsk'], 6) : null,
        'shares' => is_numeric($payload['shares'] ?? null) ? round((float) $payload['shares'], 6) : null,
        'orderId' => preg_replace('/[^A-Za-z0-9x-]/', '', (string) ($payload['orderId'] ?? '')),
    ];
    if ($reason === 'stop-declined') {
        // The lowest price this stop would have sold at, the worst the book has shown since,
        // and how long it has been refusing. Together they are the answer to "why is this
        // still open" -- and to whether the band is set where it should be.
        $record['gapFloor'] = is_numeric($payload['gapFloor'] ?? null) ? round((float) $payload['gapFloor'], 6) : null;
        $record['worstBid'] = is_numeric($payload['worstBid'] ?? null) ? round((float) $payload['worstBid'], 6) : null;
        $record['declinedSince'] = compact_text($payload['declinedSince'] ?? '', 40);
        $record['declinedPasses'] = is_numeric($payload['declinedPasses'] ?? null) ? (int) $payload['declinedPasses'] : null;
        // Which rule refused. "gapped" means the price fell far below the level; the others
        // mean the book could not absorb the sell at all -- no ask, too wide a spread, or not
        // enough capital behind the bid. They look identical on the row (a position still
        // open with its stop reached) and they mean opposite things about the market.
        $declineKind = strtolower(trim((string) ($payload['declineKind'] ?? 'gapped')));
        $record['declineKind'] = in_array($declineKind, ['gapped', 'one-sided', 'wide-spread', 'thin-depth', 'before-kickoff'], true)
            ? $declineKind
            : 'gapped';
        $record['declineSpread'] = is_numeric($payload['declineSpread'] ?? null)
            ? round((float) $payload['declineSpread'], 6) : null;
        // The scheduled kickoff, when the clock is what refused. Without it the row says a
        // stop did not sell and cannot say the match had not begun.
        $record['declineKickoffAt'] = compact_text($payload['declineKickoffAt'] ?? '', 40);
        $record['declineReason'] = compact_text($payload['declineReason'] ?? '', 400);
        $record['unrealizedPnlUsdc'] = is_numeric($payload['unrealizedPnlUsdc'] ?? null)
            ? round((float) $payload['unrealizedPnlUsdc'], 6) : null;
        $record['riskTargetUsdc'] = is_numeric($payload['riskTargetUsdc'] ?? null)
            ? round((float) $payload['riskTargetUsdc'], 6) : null;
    }

    // What the stop did AFTER selling, recorded against the position it sold. The reversal
    // is the second half of that stop, and it is only knowable once the exit has already
    // been written -- so it arrives as a separate post that annotates the existing record
    // rather than replacing it. Asked for: the closed trade should say, in its own row,
    // that the opposite position was opened.
    $reversal = null;
    if (is_array($payload['reversal'] ?? null)) {
        $status = strtoupper(trim((string) ($payload['reversal']['status'] ?? '')));
        $reversal = [
            'status' => in_array($status, ['OPENED', 'SKIPPED', 'PENDING'], true) ? $status : 'PENDING',
            'at' => gmdate('c'),
            'outcome' => compact_text($payload['reversal']['outcome'] ?? '', 60),
            'shares' => is_numeric($payload['reversal']['shares'] ?? null)
                ? round((float) $payload['reversal']['shares'], 6) : null,
            'price' => is_numeric($payload['reversal']['price'] ?? null)
                ? round((float) $payload['reversal']['price'], 6) : null,
            'orderId' => preg_replace('/[^A-Za-z0-9x-]/', '', (string) ($payload['reversal']['orderId'] ?? '')),
            // Why it did not open, when it did not. This is the half a reader actually
            // needs: "the stop reversed" is visible from the new position either way.
            'reason' => compact_text($payload['reversal']['reason'] ?? '', 200),
        ];
    }

    $path = live_exit_record_path();
    $directory = dirname($path);
    if (!is_dir($directory) && !@mkdir($directory, 0775, true) && !is_dir($directory)) {
        return ['ok' => false, 'error' => 'Live exit record storage is unavailable.'];
    }
    $handle = @fopen($path, 'c+');
    if ($handle === false) {
        return ['ok' => false, 'error' => 'Live exit record storage is unavailable.'];
    }
    try {
        if (!flock($handle, LOCK_EX)) {
            return ['ok' => false, 'error' => 'Live exit record storage could not acquire its lock.'];
        }
        rewind($handle);
        $raw = stream_get_contents($handle);
        $stored = json_decode(is_string($raw) ? $raw : '', true);
        $records = is_array($stored['records'] ?? null) ? $stored['records'] : [];
        // Keyed by token, so a retried exit updates its record rather than adding a second
        // one for the same position. Bounded and aged out: this is an annotation on closed
        // trades, not an audit log, and the trades themselves are already retained.
        // A reversal post annotates the exit already stored; a repeated exit post refreshes
        // the exit's own fields and carries any reversal forward. Either way the two halves
        // of one stop end up on one record instead of overwriting each other.
        $existing = is_array($records[$tokenId] ?? null) ? $records[$tokenId] : null;
        // A decline is a not-yet, so it must never bury a sale that already happened. The
        // worker stops watching a sold position and would not post one, but the record is
        // what a closed row reads to explain itself and a single stray post would silently
        // turn "sold by the stop at 0.44" back into "still waiting".
        if ($reason === 'stop-declined'
            && is_array($existing)
            && in_array((string) ($existing['reason'] ?? ''), ['stop', 'settlement'], true)) {
            return ['ok' => true, 'record' => $existing, 'skipped' => 'a completed exit is already recorded'];
        }
        if ($reversal !== null) {
            $record = $existing ?? $record;
            $record['reversal'] = $reversal;
        } elseif ($existing !== null && is_array($existing['reversal'] ?? null)) {
            $record['reversal'] = $existing['reversal'];
        }
        $records[$tokenId] = $record;
        $cutoff = time() - (120 * 86400);
        foreach ($records as $key => $entry) {
            $at = is_array($entry) ? strtotime((string) ($entry['at'] ?? '')) : false;
            if ($at !== false && $at < $cutoff) {
                unset($records[$key]);
            }
        }
        if (count($records) > 2000) {
            uasort($records, static fn ($left, $right): int => strcmp((string) ($right['at'] ?? ''), (string) ($left['at'] ?? '')));
            $records = array_slice($records, 0, 2000, true);
        }
        $encoded = json_encode(['records' => $records], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        rewind($handle);
        ftruncate($handle, 0);
        fwrite($handle, (string) $encoded);
        fflush($handle);
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
    return ['ok' => true, 'record' => $record];
}

// The account sync knows a position is gone; only the exit worker knows why. This is where
// the two meet, so a closed position can say "sold by the stop loss at 0.10" instead of
// simply disappearing from the open list.
function live_state_with_exit_reasons(array $payload): array
{
    $state = is_array($payload['state'] ?? null) ? $payload['state'] : $payload;
    $positions = is_array($state['positions'] ?? null) ? $state['positions'] : [];
    if ($positions === []) {
        return $payload;
    }
    $records = live_exit_records();
    if ($records === []) {
        return $payload;
    }
    foreach ($positions as $index => $position) {
        if (!is_array($position)) {
            continue;
        }
        $tokenId = trim((string) ($position['tokenId'] ?? $position['assetId'] ?? ''));
        $record = $tokenId === '' ? null : ($records[$tokenId] ?? null);
        if (!is_array($record)) {
            continue;
        }
        // Annotation only. Whether the position is open or closed remains Polymarket's
        // answer -- a recorded exit that has not settled yet must not make a position look
        // closed before the account says it is.
        $positions[$index]['exitReason'] = $record['reason'] ?? 'stop';
        $positions[$index]['exitRecordedAt'] = $record['at'] ?? null;
        $positions[$index]['exitPrice'] = $record['exitPrice'] ?? null;
        $positions[$index]['exitStopPrice'] = $record['stopPrice'] ?? null;
        $positions[$index]['exitBestBid'] = $record['bestBid'] ?? null;
        $positions[$index]['exitBestAsk'] = $record['bestAsk'] ?? null;
        $positions[$index]['exitOrderId'] = $record['orderId'] ?? null;
        // A stop that fired and declined to sell. The position is still open, so these ride
        // along on an OPEN row -- the one case where an exit record describes something that
        // has NOT happened, and the reason the row can explain why.
        if (($record['reason'] ?? '') === 'stop-declined') {
            $positions[$index]['exitGapFloor'] = $record['gapFloor'] ?? null;
            $positions[$index]['exitWorstBid'] = $record['worstBid'] ?? null;
            $positions[$index]['exitDeclinedSince'] = $record['declinedSince'] ?? null;
            $positions[$index]['exitDeclinedPasses'] = $record['declinedPasses'] ?? null;
            $positions[$index]['exitRiskTargetUsdc'] = $record['riskTargetUsdc'] ?? null;
            $positions[$index]['exitDeclineKind'] = $record['declineKind'] ?? 'gapped';
            $positions[$index]['exitDeclineSpread'] = $record['declineSpread'] ?? null;
            $positions[$index]['exitDeclineKickoffAt'] = $record['declineKickoffAt'] ?? null;
            $positions[$index]['exitDeclineReason'] = $record['declineReason'] ?? null;
        }
        // The second half of the stop, so the closed row can explain that the opposite
        // position was opened out of this one.
        if (is_array($record['reversal'] ?? null)) {
            $positions[$index]['exitReversal'] = $record['reversal'];
        }
    }
    if (is_array($payload['state'] ?? null)) {
        $payload['state']['positions'] = $positions;
        return $payload;
    }
    $payload['positions'] = $positions;
    return $payload;
}

function live_entry_claim_key(string $tokenId, string $side): string
{
    return strtoupper($side) . ':' . $tokenId;
}

function live_entry_claims_mutate(callable $mutator): array
{
    $path = live_entry_claim_path();
    $directory = dirname($path);
    if (!is_dir($directory) && !@mkdir($directory, 0775, true) && !is_dir($directory)) {
        throw new RuntimeException('Live entry guard storage is unavailable.');
    }
    $handle = @fopen($path, 'c+');
    if ($handle === false) {
        throw new RuntimeException('Live entry guard storage is unavailable.');
    }
    try {
        if (!flock($handle, LOCK_EX)) {
            throw new RuntimeException('Live entry guard could not acquire its lock.');
        }
        rewind($handle);
        $raw = stream_get_contents($handle);
        $stored = json_decode(is_string($raw) ? $raw : '', true);
        $claims = is_array($stored['claims'] ?? null) ? $stored['claims'] : [];
        // Housekeeping so this file cannot grow without limit, and nothing more. It is
        // emphatically NOT the guard: a claim stops blocking its outcome as soon as the
        // account has been read and shows nothing behind it, which is usually within
        // minutes. Anything still here after three months is a row for a token nobody has
        // asked about since, not a lock anyone is waiting on.
        $cutoff = time() - (90 * 86400);
        foreach ($claims as $key => $claim) {
            $claimedAt = is_array($claim) ? strtotime((string) ($claim['claimedAt'] ?? '')) : false;
            if ($claimedAt !== false && $claimedAt < $cutoff) {
                unset($claims[$key]);
            }
        }
        $result = $mutator($claims);
        if (!is_array($result)) {
            throw new RuntimeException('Live entry guard returned an invalid result.');
        }
        $payload = json_encode([
            'updatedAt' => gmdate('c'),
            'claims' => $claims,
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($payload)) {
            throw new RuntimeException('Live entry guard could not encode its state.');
        }
        ftruncate($handle, 0);
        rewind($handle);
        if (fwrite($handle, $payload) === false || !fflush($handle)) {
            throw new RuntimeException('Live entry guard could not persist its state.');
        }
        flock($handle, LOCK_UN);
        return $result;
    } finally {
        fclose($handle);
    }
}

/**
 * What the account itself says about this outcome, which is the question the entry guard
 * is actually asking: is this position open right now.
 *
 * The guard exists so the same position is not opened twice at one moment. It used to
 * answer that by remembering, for ninety days, that somebody had once submitted an order
 * -- which is a different question, and a worse one. An order that was killed bought
 * nothing and blocked its outcome for three months; an order that filled was already
 * covered by the executor's own held/resting checks, so the memory added nothing.
 *
 * `observedAt` is what makes the guard honest without a clock: it says WHEN the account
 * last spoke, so a claim can be judged against whether the account has been read since it
 * was made, rather than against how long ago it happened.
 */
function live_entry_claim_account_state(string $tokenId): array
{
    $liveState = decode_state_file(state_file_paths()['live'] ?? '', false);
    $held = false;
    foreach ((array) ($liveState['positions'] ?? []) as $position) {
        if (is_array($position) && trim((string) ($position['tokenId'] ?? $position['assetId'] ?? '')) === $tokenId) {
            $held = true;
            break;
        }
    }
    $resting = false;
    foreach ((array) ($liveState['openOrders'] ?? []) as $order) {
        if (!is_array($order)) {
            continue;
        }
        // A resting SELL is an exit, not a second entry, and must not block a buy.
        if (str_contains(strtoupper((string) ($order['side'] ?? '')), 'SELL')) {
            continue;
        }
        if (trim((string) ($order['tokenId'] ?? $order['assetId'] ?? '')) === $tokenId) {
            $resting = true;
            break;
        }
    }
    return [
        'held' => $held,
        'resting' => $resting,
        'observedAt' => trim((string) ($liveState['generatedAt'] ?? $liveState['updatedAt'] ?? '')),
    ];
}

function live_entry_claim_request(array $payload): array
{
    $operation = strtolower(trim((string) ($payload['operation'] ?? 'claim')));
    $tokenId = trim((string) ($payload['tokenId'] ?? ''));
    $side = strtoupper(trim((string) ($payload['side'] ?? 'BUY')));
    $portfolioId = trim((string) ($payload['portfolioId'] ?? ''));
    $claimId = trim((string) ($payload['claimId'] ?? ''));
    if (!preg_match('/^\d{8,100}$/', $tokenId) || $side !== 'BUY' || !preg_match('/^[a-zA-Z0-9_-]{1,64}$/', $portfolioId)) {
        respond(['ok' => false, 'error' => 'Invalid live entry guard request.'], 400);
    }
    if (!preg_match('/^[a-zA-Z0-9_-]{16,96}$/', $claimId)) {
        respond(['ok' => false, 'error' => 'Invalid live entry guard claim id.'], 400);
    }
    $key = live_entry_claim_key($tokenId, $side);
    // Read outside the lock: it is a different file, and holding the claim lock across it
    // would serialise every entry behind one state read.
    $account = $operation === 'claim'
        ? live_entry_claim_account_state($tokenId)
        : ['held' => false, 'resting' => false, 'observedAt' => ''];
    return live_entry_claims_mutate(static function (array &$claims) use ($operation, $key, $tokenId, $side, $portfolioId, $claimId, $account): array {
        $existing = is_array($claims[$key] ?? null) ? $claims[$key] : null;
        if ($operation === 'claim') {
            $claimSummary = $existing === null ? null : [
                'status' => (string) ($existing['status'] ?? 'claimed'),
                'claimedAt' => (string) ($existing['claimedAt'] ?? ''),
                'portfolioId' => (string) ($existing['portfolioId'] ?? ''),
            ];
            // The duplicate this guard exists to prevent, asked of the account rather than
            // of a memory: the outcome is already open, or a buy for it is already resting.
            if ($account['held'] || $account['resting']) {
                return [
                    'ok' => true,
                    'claimed' => false,
                    'reason' => $account['held']
                        ? 'The account already holds this outcome.'
                        : 'A BUY for this outcome is already resting on the book.',
                    'claim' => $claimSummary,
                    'account' => $account,
                ];
            }
            if ($existing !== null) {
                // A claim with nothing behind it, and the difference is causal rather than
                // clocked: has the account been read SINCE this claim was made? If it has,
                // and it shows neither a position nor a resting order, then whatever was
                // submitted did not become anything -- a killed fill-and-kill leaves
                // exactly this -- and the claim has nothing left to protect.
                //
                // If it has not, the submission is still in flight and this really would be
                // the second order for one outcome, which is the case worth refusing.
                $claimedAt = strtotime((string) ($existing['claimedAt'] ?? ''));
                $observedAt = $account['observedAt'] !== '' ? strtotime($account['observedAt']) : false;
                if ($claimedAt === false || $observedAt === false || $observedAt <= $claimedAt) {
                    return [
                        'ok' => true,
                        'claimed' => false,
                        'reason' => 'A live BUY for this outcome is in flight and the account has not been read since.',
                        'claim' => $claimSummary,
                        'account' => $account,
                    ];
                }
            }
            $claims[$key] = [
                'tokenId' => $tokenId,
                'side' => $side,
                'portfolioId' => $portfolioId,
                'claimId' => $claimId,
                'status' => 'claimed',
                'claimedAt' => gmdate('c'),
            ];
            return ['ok' => true, 'claimed' => true, 'claim' => ['status' => 'claimed']];
        }
        if ($existing === null || !hash_equals((string) ($existing['claimId'] ?? ''), $claimId)) {
            return ['ok' => true, 'updated' => false];
        }
        if ($operation === 'confirm') {
            $claims[$key]['status'] = 'accepted';
            $claims[$key]['acceptedAt'] = gmdate('c');
            return ['ok' => true, 'updated' => true];
        }
        if ($operation === 'release') {
            unset($claims[$key]);
            return ['ok' => true, 'updated' => true];
        }
        respond(['ok' => false, 'error' => 'Unknown live entry guard operation.'], 400);
    });
}

try {
    $action = $_GET['action'] ?? 'markets';

    if ($action === 'live-exit-record') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond(['ok' => false, 'error' => 'POST is required'], 405);
        }
        require_trading_trigger_key();
        respond(live_exit_record_request(request_payload()));
    }

    if ($action === 'live-entry-claim') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            respond(['ok' => false, 'error' => 'POST is required'], 405);
        }
        require_trading_trigger_key();
        respond(live_entry_claim_request(request_payload()));
    }

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
            // Which stream is using the event log, so retention can be aimed at the one that
            // is actually growing rather than at whichever is easiest to reach.
            'eventStreams' => [],
            // How old the stored markets are. The published catalogue is a window and the
            // database keeps everything, so the two counts differ by design -- what decides
            // whether that is safe to serve is the age of what it holds, not the size.
            'observationFreshness' => [],
            'generatedAt' => gmdate('c'),
        ];
        if ($storage['schemaReady'] === true) {
            try {
                $status['active'] = trading_storage_is_active();
                $status['jsonImportedAt'] = trading_storage_meta_get('json-imported-at');
                $status['lastMigrationError'] = trading_storage_meta_get('last-migration-error');
                $status['lastIngestAt'] = trading_storage_meta_get('last-ingest-at');
                $status['counts'] = trading_storage_observation_counts();
                $status['eventStreams'] = trading_storage_event_stream_stats();
                $status['observationFreshness'] = trading_storage_observation_freshness();
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
        $storageRequest = request_payload();
        $operation = strtolower(trim((string) ($storageRequest['operation'] ?? 'status')));
        $pdo = trading_storage_pdo();
        if (!$pdo instanceof PDO) {
            respond(['ok' => false, 'error' => 'Trading MySQL storage is not configured or reachable.'], 503);
        }
        trading_storage_bootstrap($pdo);
        if ($operation === 'bootstrap') {
            respond(['ok' => true, 'operation' => 'bootstrap', 'storage' => trading_storage_diagnostics()]);
        }
        if ($operation === 'compact-preview') {
            respond([
                'ok' => true,
                'operation' => 'compact-preview',
                'preview' => trading_storage_compression_preview($pdo),
                'storage' => trading_storage_diagnostics(),
            ]);
        }
        if ($operation === 'compact-batch') {
            $result = trading_storage_compact_payload_batch(
                $pdo,
                (string) ($storageRequest['table'] ?? ''),
                (string) ($storageRequest['after'] ?? ''),
                (int) ($storageRequest['limit'] ?? 400),
            );
            respond(['ok' => true, 'operation' => 'compact-batch', 'batch' => $result]);
        }
        // Rewrite the run-log events that were stored fat, before this hosting runs out of
        // database. Measured: the whole MySQL instance is at 1785 MB of a 2000 MB quota, and
        // trading_event_log alone holds 222 MB of it in 21315 rows -- roughly ten kilobytes
        // each, nearly all of it a market snapshot that also sits in the published state.
        //
        // Rewriting, not deleting: the attribution history is the reason the stream exists.
        if ($operation === 'slim-events') {
            $result = trading_storage_slim_stored_events(
                $pdo,
                (string) ($storageRequest['cursor'] ?? ''),
                (int) ($storageRequest['limit'] ?? 200),
            );
            respond(['ok' => true, 'operation' => 'slim-events', 'result' => $result]);
        }
        // Asked for: keep at most a week of run log in the database and archive the rest so
        // it takes little space, with the ability to restore it. The database is the scarce
        // resource -- one 2000 MB quota shared with every other application on this hosting
        // -- and a gzipped file on disk is not.
        if ($operation === 'archive-events') {
            $result = trading_storage_archive_events(
                $pdo,
                (int) ($storageRequest['days'] ?? 7),
                (int) ($storageRequest['limit'] ?? 500),
            );
            respond(['ok' => true, 'operation' => 'archive-events', 'result' => $result]);
        }
        if ($operation === 'archive-list') {
            respond(['ok' => true, 'operation' => 'archive-list', 'files' => trading_storage_archive_listing()]);
        }
        if ($operation === 'archive-restore') {
            $result = trading_storage_restore_events((string) ($storageRequest['file'] ?? ''));
            respond(['ok' => true, 'operation' => 'archive-restore', 'result' => $result]);
        }
        if ($operation === 'rebuild-table') {
            $tables = trading_storage_rebuild_compacted_table($pdo, (string) ($storageRequest['table'] ?? ''));
            respond(['ok' => true, 'operation' => 'rebuild-table', 'tables' => $tables, 'storage' => trading_storage_diagnostics()]);
        }
        if ($operation === 'compact-empty') {
            $before = trading_storage_table_stats($pdo);
            $nonEmpty = array_filter($before, static fn (array $table): bool => (int) ($table['rows'] ?? 0) > 0);
            if ($nonEmpty !== []) {
                respond([
                    'ok' => false,
                    'error' => 'Trading tables are not empty; compaction was not run.',
                    'tables' => $before,
                ], 409);
            }
            try {
                $tables = trading_storage_compact_empty_tables($pdo);
                respond([
                    'ok' => true,
                    'operation' => 'compact-empty',
                    'tables' => $tables,
                    'storage' => trading_storage_diagnostics(),
                ]);
            } catch (Throwable) {
                respond([
                    'ok' => false,
                    'error' => 'Hosting could not rebuild the empty Trading tables.',
                    'tables' => trading_storage_table_stats($pdo),
                ], 503);
            }
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
        if ($operation === 'migrate-json-batch') {
            try {
                $result = trading_storage_import_json_phase(
                    (string) ($storageRequest['phase'] ?? ''),
                    (int) ($storageRequest['offset'] ?? 0),
                    (int) ($storageRequest['limit'] ?? 750),
                );
                respond(['ok' => true, 'operation' => 'migrate-json-batch', 'result' => $result]);
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

    // Read-only, like the exit policy beside it: the RPi worker asks what to watch and
    // what it may pay, and everything slow about that answer is decided here. No key is
    // required because nothing is written and nothing secret is published -- the plans are
    // token ids, bands and sizes, all of which are already in the dashboard.
    if ($action === 'dip-entry-watch') {
        respond(live_dip_entry_watch_payload());
    }

    // What the worker saw. Read by the paper bot on its hourly run, which opens a simulated
    // position at the price the dip actually reached -- the reason the record exists at all,
    // since an hourly bot can never witness a trough that lasts minutes.
    if ($action === 'dip-entry-hits') {
        respond(['ok' => true, 'generatedAt' => gmdate('c'), 'hits' => read_dip_entry_hits()]);
    }

    // Are the trades actually in the database, per portfolio. Public and read-only: it
    // returns counts, never the trades themselves, and it is the standing answer to "is the
    // long-term record being kept" -- the question that went unasked while the mirror was
    // writing nothing for ten days.
    // Does asking the database in a portfolio's own shape return the same markets as reading
    // the whole catalogue and filtering it? Read-only, and it runs whichever source is live,
    // so the comparison can be made BEFORE reads are switched over rather than after.
    //
    // The narrowed query is only safe if its result is a superset of what the payload rules
    // keep, so this reports the difference both ways: a market the catalogue path keeps and
    // the query misses is a bug in the bounds, and that is the number to watch.
    if ($action === 'execution-scope-probe') {
        $strategyId = isset($_GET['strategy_id']) ? (string) $_GET['strategy_id'] : null;
        if ($strategyId !== null && !preg_match('/^[A-Za-z0-9_-]{1,64}$/', $strategyId)) {
            respond(['ok' => false, 'error' => 'strategy_id is not a valid id'], 400);
        }
        $scopeConfig = execution_scope_strategy_config($strategyId);
        $criteria = execution_scope_storage_criteria($scopeConfig);

        $startedCatalogue = microtime(true);
        $catalogueState = state_payload('paper', ['observations'], null, 0, 0, true);
        $catalogueRows = is_array($catalogueState['marketObservations'] ?? null)
            ? $catalogueState['marketObservations']
            : [];
        $catalogueKept = array_values(array_filter($catalogueRows, static function ($item) use ($scopeConfig): bool {
            return is_array($item) && ($scopeConfig === null
                ? is_active_scraped_market_observation($item)
                : execution_scope_matches_observation($item, $scopeConfig));
        }));
        $catalogueSeconds = microtime(true) - $startedCatalogue;

        $startedQuery = microtime(true);
        $queryRows = trading_storage_observations_for_scope($criteria, 5000);
        $queryKept = array_values(array_filter($queryRows, static function ($item) use ($scopeConfig): bool {
            return is_array($item) && ($scopeConfig === null
                ? is_active_scraped_market_observation($item)
                : execution_scope_matches_observation($item, $scopeConfig));
        }));
        $querySeconds = microtime(true) - $startedQuery;

        $keyOf = static fn ($item): string => is_array($item)
            ? (string) ($item['tokenId'] ?? $item['id'] ?? $item['marketKey'] ?? '')
            : '';
        $catalogueKeys = array_values(array_filter(array_map($keyOf, $catalogueKept)));
        $queryKeys = array_values(array_filter(array_map($keyOf, $queryKept)));
        $missedByQuery = array_values(array_diff($catalogueKeys, $queryKeys));

        respond([
            'ok' => true,
            'generatedAt' => gmdate('c'),
            'strategyId' => $strategyId,
            'storageActive' => trading_storage_is_active(),
            'criteria' => $criteria,
            'catalogue' => [
                'read' => count($catalogueRows),
                'kept' => count($catalogueKept),
                'seconds' => round($catalogueSeconds, 3),
            ],
            'scopedQuery' => [
                'read' => count($queryRows),
                'kept' => count($queryKept),
                'seconds' => round($querySeconds, 3),
            ],
            // The number that decides it. Anything above zero means the bounds are tighter
            // than the rules and the query is hiding markets the portfolio would trade.
            'missedByQuery' => count($missedByQuery),
            'missedSample' => array_slice($missedByQuery, 0, 10),
            'extraFromQuery' => max(0, count($queryKeys) - (count($catalogueKeys) - count($missedByQuery))),
        ]);
    }

    if ($action === 'trade-rows-summary') {
        $rows = [];
        try {
            $rows = trading_storage_trade_summary();
        } catch (Throwable) {
            $rows = [];
        }
        respond([
            'ok' => true,
            'generatedAt' => gmdate('c'),
            'storageActive' => trading_storage_is_active(),
            'total' => array_sum(array_map(static fn (array $row): int => (int) $row['total'], $rows)),
            'portfolios' => $rows,
        ]);
    }

    // Which live portfolio ordered which token, over the WHOLE recorded history.
    //
    // Reported: closed positions older than about a day disappear from a live portfolio's
    // list and its statistics stop adding up. Ownership was re-derived from the published
    // execution state, whose run log holds 160 runs -- measured at 1.1 to 2.8 days per
    // portfolio. Past that, 211 of 352 closed rows on the account were claimed by nobody and
    // fell to base Live with their stake and their P/L.
    //
    // The history was never actually lost. Every live execution run mirrors its whole run log
    // into the `state-run-log` event stream (ingest-trading-state.py), and that append is
    // idempotent -- the event key hashes stream, target, time and identity, with ON DUPLICATE
    // KEY UPDATE -- so re-sending the same 160 rows on every run stores each one exactly once
    // and keeps it. What was missing was a way to read it back out.
    //
    // This is a RECORD, not an inference: every entry is an order the executor itself logged,
    // under the target whose runner logged it. Nothing here guesses from price bands, which
    // could not separate these portfolios anyway.
    if ($action === 'live-order-ownership') {
        $ownershipConfig = load_portfolio_config();
        $targets = ['live' => 'live-execution', 'live-5050' => 'live-5050-execution'];
        foreach (array_keys(is_array($ownershipConfig['livePortfolios'] ?? null) ? $ownershipConfig['livePortfolios'] : []) as $id) {
            if (is_string($id) && preg_match('/^[a-z][a-zA-Z0-9]{1,30}$/', $id)) {
                $targets['live-custom-' . $id] = 'live-custom-' . $id . '-execution';
            }
        }
        $orders = [];
        $runCounts = [];
        $oldest = null;
        foreach ($targets as $mode => $target) {
            $records = trading_storage_is_active()
                ? trading_storage_event_records('state-run-log', $target, 5000)
                : [];
            $runCounts[$mode] = count($records);
            foreach ($records as $record) {
                if (!is_array($record)) {
                    continue;
                }
                $at = (string) ($record['runAt'] ?? $record['generatedAt'] ?? '');
                if ($at !== '' && ($oldest === null || strcmp($at, $oldest) < 0)) {
                    $oldest = $at;
                }
                foreach ((is_array($record['attempts'] ?? null) ? $record['attempts'] : []) as $attempt) {
                    if (!is_array($attempt)) {
                        continue;
                    }
                    // The same two exclusions the dashboard applies to a run log it reads
                    // itself: a refused order and a dry run never owned anything.
                    $attemptAction = strtoupper((string) ($attempt['action'] ?? ''));
                    if (str_contains($attemptAction, 'REJECT') || str_starts_with($attemptAction, 'DRY_RUN')) {
                        continue;
                    }
                    $tokenId = trim((string) ($attempt['tokenId'] ?? ''));
                    if ($tokenId === '') {
                        continue;
                    }
                    $price = is_numeric($attempt['orderPrice'] ?? null) ? round((float) $attempt['orderPrice'], 6) : null;
                    // Keyed on token AND price, the same pairing the dashboard matches a fill
                    // back on. The newest order for a pair wins, so a token re-entered after
                    // another portfolio closed out belongs to whoever ordered it last.
                    $key = $tokenId . '@' . ($price === null ? '-' : (string) $price);
                    if (isset($orders[$key]) && strcmp((string) $orders[$key]['at'], $at) >= 0) {
                        continue;
                    }
                    $orders[$key] = ['tokenId' => $tokenId, 'price' => $price, 'mode' => $mode, 'at' => $at];
                }
            }
        }
        respond([
            'ok' => true,
            'generatedAt' => gmdate('c'),
            'storageActive' => trading_storage_is_active(),
            'runsPerMode' => $runCounts,
            'oldestRunAt' => $oldest,
            'orders' => array_values($orders),
        ]);
    }

    // Written by the RPi worker only. Trigger-key protected like every other write from it:
    // a public endpoint that appends to a list the paper bot trades from would let anyone
    // put a position in a portfolio.
    if ($action === 'dip-entry-record') {
        require_trading_trigger_key();
        $payload = json_decode((string) file_get_contents('php://input'), true);
        $result = record_dip_entry_hit(is_array($payload) ? $payload : []);
        respond($result, ($result['ok'] ?? false) ? 200 : 400);
    }

    if ($action === 'state') {
        $target = (string) ($_GET['target'] ?? '');
        $summary = (string) ($_GET['summary'] ?? '');
        $strategyId = isset($_GET['strategy_id']) ? (string) $_GET['strategy_id'] : null;
        // Which page to serve. The execution and scraped summaries both read it; every
        // other view ignores it.
        $executionOffset = max(0, (int) ($_GET['offset'] ?? 0));
        // The scraped list is the one view that reads the whole active catalogue, so it is
        // the one that has to be paged: measured on production it carried 8001 rows in a
        // 21.32 MB response, which is what stopped the retention cap from being raised.
        // Requesting a page bounds the decode as well as the response -- paging only the
        // output would leave the memory cost, which is the other half of the ceiling.
        $observationsLimit = $summary === 'scraped' ? SCRAPED_SCOPE_PAGE_LIMIT : 0;
        $observationsOffset = $summary === 'scraped' ? $executionOffset : 0;
        // Which of the two catalogues this page belongs to. The browser walks the active one
        // and then walks the resolved archive, so that no single response carries both --
        // the first one used to carry 1200 active rows AND all 3000 resolved, 11.56 MB
        // against the ten second timeout the dashboard gives it.
        $scrapedScope = ((string) ($_GET['scope'] ?? '')) === 'resolved' ? 'resolved' : 'active';
        // Load the segments this summary reads before decoding anything else. The
        // dashboard is by far the most requested view and needs none of them.
        // The two views that present markets as tradable: the opportunities list and the
        // shortlist the paper bots pick from. Both must see the current catalogue rather than
        // every market ever stored -- while the JSON files served them that bound was
        // implicit, because the published catalogue is itself a window.
        $freshObservationsOnly = in_array($summary, ['scraped', 'execution'], true);
        $payload = state_payload(
            $target,
            state_segments_for_summary($summary, $scrapedScope),
            $strategyId,
            $observationsLimit,
            $observationsOffset,
            $freshObservationsOnly
        );
        if ($target === 'paper') {
            $payload = paper_state_with_consistent_portfolios($payload, $summary, $strategyId);
            $payload = compact_state_payload($target, $payload, $summary, $strategyId, $executionOffset, $scrapedScope);
        }
        if ($target === 'live') {
            $payload = live_state_with_exit_reasons($payload);
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
