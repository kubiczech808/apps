<?php

declare(strict_types=1);

/*
 * MySQL persistence for Trading. The public API keeps the current object-shaped
 * payloads, while this layer owns transactions, documents and queryable market rows.
 * JSON is retained only as payload data for fields that are not queried yet; it is not
 * a file and does not require decoding the whole catalogue to filter or page it.
 */

function trading_storage_is_configured(): bool
{
    $config = app_config();
    return extension_loaded('pdo_mysql')
        && $config['db_host'] !== ''
        && $config['db_name'] !== ''
        && $config['db_user'] !== ''
        && $config['db_password'] !== '';
}

function trading_storage_pdo(): ?PDO
{
    static $pdo = false;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    if ($pdo === null || !trading_storage_is_configured()) {
        return null;
    }
    $config = app_config();
    $port = ctype_digit($config['db_port']) ? (int) $config['db_port'] : 3306;
    try {
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
    } catch (Throwable) {
        $pdo = null;
    }
    return $pdo instanceof PDO ? $pdo : null;
}

function trading_storage_bootstrap(PDO $pdo): void
{
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS trading_storage_meta (
            meta_key VARCHAR(100) NOT NULL PRIMARY KEY,
            meta_value LONGTEXT NOT NULL,
            updated_at DATETIME(6) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS trading_documents (
            document_key VARCHAR(191) NOT NULL PRIMARY KEY,
            document_type VARCHAR(64) NOT NULL,
            payload MEDIUMBLOB NOT NULL,
            checksum CHAR(64) NOT NULL,
            version BIGINT UNSIGNED NOT NULL DEFAULT 1,
            created_at DATETIME(6) NOT NULL,
            updated_at DATETIME(6) NOT NULL
        ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS trading_observations (
            observation_key CHAR(64) NOT NULL PRIMARY KEY,
            lifecycle VARCHAR(24) NOT NULL,
            source_id VARCHAR(191) NULL,
            token_id VARCHAR(191) NULL,
            event_slug VARCHAR(191) NULL,
            market_slug VARCHAR(191) NULL,
            outcome_label VARCHAR(191) NULL,
            market_type VARCHAR(16) NULL,
            end_at DATETIME NULL,
            observed_at DATETIME NULL,
            resolved_at DATETIME NULL,
            market_probability DECIMAL(12,9) NULL,
            net_yield DECIMAL(18,9) NULL,
            annualized_return DECIMAL(24,9) NULL,
            volume_usdc DECIMAL(24,6) NULL,
            tags_json LONGTEXT NULL,
            payload MEDIUMBLOB NOT NULL,
            payload_checksum CHAR(64) NOT NULL,
            created_at DATETIME(6) NOT NULL,
            updated_at DATETIME(6) NOT NULL,
            KEY trading_observations_lifecycle_end (lifecycle, end_at),
            KEY trading_observations_lifecycle_updated (lifecycle, updated_at)
        ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS trading_event_log (
            event_key CHAR(64) NOT NULL PRIMARY KEY,
            stream VARCHAR(64) NOT NULL,
            portfolio_id VARCHAR(80) NULL,
            occurred_at DATETIME NULL,
            payload MEDIUMBLOB NOT NULL,
            created_at DATETIME(6) NOT NULL,
            KEY trading_event_log_stream_time (stream, occurred_at),
            KEY trading_event_log_portfolio_time (portfolio_id, occurred_at)
        ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    // Trades as their own queryable rows, which is what statistics and reposting need and
    // what a state document cannot give. That document is one compressed object replaced
    // wholesale on every sync, so a trade cannot be looked up, counted per portfolio, or
    // asked when it became closed without decoding the whole account.
    //
    // One row per trade, identified by the ROUND TRIP rather than by the token alone: the
    // same token bought again after an earlier position closed is a second trade, and keying
    // on the token would have the second overwrite the first and lose it.
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS trading_trades (
            trade_key CHAR(64) NOT NULL PRIMARY KEY,
            account VARCHAR(16) NOT NULL,
            portfolio_id VARCHAR(80) NOT NULL,
            status VARCHAR(32) NOT NULL,
            closed TINYINT(1) NOT NULL DEFAULT 0,
            token_id VARCHAR(191) NULL,
            condition_id VARCHAR(191) NULL,
            round_trip INT NOT NULL DEFAULT 1,
            question VARCHAR(512) NULL,
            outcome VARCHAR(191) NULL,
            event_slug VARCHAR(191) NULL,
            opened_at DATETIME NULL,
            closed_at DATETIME NULL,
            end_at DATETIME NULL,
            entry_price DECIMAL(12,9) NULL,
            exit_price DECIMAL(12,9) NULL,
            shares DECIMAL(24,6) NULL,
            stake_usdc DECIMAL(24,6) NULL,
            realized_pnl_usdc DECIMAL(24,6) NULL,
            unrealized_pnl_usdc DECIMAL(24,6) NULL,
            payload MEDIUMBLOB NOT NULL,
            payload_checksum CHAR(64) NOT NULL,
            created_at DATETIME(6) NOT NULL,
            updated_at DATETIME(6) NOT NULL,
            KEY trading_trades_portfolio_status (portfolio_id, closed, closed_at),
            KEY trading_trades_portfolio_opened (portfolio_id, opened_at),
            KEY trading_trades_token (token_id),
            KEY trading_trades_account_updated (account, updated_at)
        ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    trading_storage_optimize_schema($pdo);
}

/**
 * Identity of one trade: the account, the portfolio that placed it, the market, and which
 * round trip on that market it is. Falling back to the condition and outcome keeps a row
 * identifiable when a feed reports a redemption against the condition rather than the token.
 */
function trading_storage_trade_key(array $trade): string
{
    $tokenId = trim((string) ($trade['tokenId'] ?? $trade['assetId'] ?? ''));
    $conditionId = trim((string) ($trade['conditionId'] ?? ''));
    $outcome = trim((string) ($trade['outcome'] ?? ''));
    if ($tokenId !== '') {
        $identity = 'token:' . $tokenId;
    } elseif ($conditionId !== '') {
        $identity = 'condition:' . $conditionId . ':' . $outcome;
    } else {
        $identity = 'row:' . trim((string) ($trade['id'] ?? ''));
    }
    return hash('sha256', implode("\x1F", [
        (string) ($trade['account'] ?? ''),
        (string) ($trade['portfolioId'] ?? ''),
        $identity,
        (string) max(1, (int) ($trade['roundTrip'] ?? 1)),
    ]));
}

/**
 * Write a trade, or update the one already stored. The row is created the first time the
 * trade is seen open and updated in place when it closes -- that transition is the point, so
 * nothing here ever inserts a second row for a trade that already exists.
 */
function trading_storage_trade_upsert(array $trade): void
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        throw new RuntimeException('Trading MySQL storage is unavailable.');
    }
    trading_storage_bootstrap($pdo);
    $encoded = trading_storage_encode($trade);
    $closed = ($trade['closed'] ?? null) === true
        || in_array(strtoupper((string) ($trade['status'] ?? '')), ['CLOSED', 'REDEEMED', 'RESOLVED', 'SOLD'], true);
    $now = trading_storage_now();
    $statement = $pdo->prepare(
        'INSERT INTO trading_trades (
            trade_key, account, portfolio_id, status, closed, token_id, condition_id, round_trip,
            question, outcome, event_slug, opened_at, closed_at, end_at, entry_price, exit_price,
            shares, stake_usdc, realized_pnl_usdc, unrealized_pnl_usdc, payload, payload_checksum,
            created_at, updated_at
         ) VALUES (
            :key, :account, :portfolioId, :status, :closed, :tokenId, :conditionId, :roundTrip,
            :question, :outcome, :eventSlug, :openedAt, :closedAt, :endAt, :entryPrice, :exitPrice,
            :shares, :stake, :realized, :unrealized, :payload, :checksum, :createdAt, :updatedAt
         )
         ON DUPLICATE KEY UPDATE
            status = VALUES(status),
            closed = VALUES(closed),
            condition_id = COALESCE(VALUES(condition_id), condition_id),
            question = COALESCE(VALUES(question), question),
            outcome = COALESCE(VALUES(outcome), outcome),
            event_slug = COALESCE(VALUES(event_slug), event_slug),
            -- The open time is the one fact a later pass must never move. A resync that
            -- cannot date the open would otherwise stamp today over the real entry, and the
            -- holding period of every old trade would collapse to nothing.
            opened_at = COALESCE(opened_at, VALUES(opened_at)),
            closed_at = COALESCE(VALUES(closed_at), closed_at),
            end_at = COALESCE(VALUES(end_at), end_at),
            entry_price = COALESCE(VALUES(entry_price), entry_price),
            exit_price = COALESCE(VALUES(exit_price), exit_price),
            shares = COALESCE(VALUES(shares), shares),
            stake_usdc = COALESCE(VALUES(stake_usdc), stake_usdc),
            realized_pnl_usdc = COALESCE(VALUES(realized_pnl_usdc), realized_pnl_usdc),
            -- Unrealized is the one figure that must be allowed to fall back to nothing: it
            -- is a mark on an OPEN position, and a closed trade has none.
            unrealized_pnl_usdc = VALUES(unrealized_pnl_usdc),
            payload = VALUES(payload),
            payload_checksum = VALUES(payload_checksum),
            updated_at = VALUES(updated_at)'
    );
    $statement->execute([
        'key' => trading_storage_trade_key($trade),
        'account' => substr((string) ($trade['account'] ?? 'live'), 0, 16),
        'portfolioId' => substr((string) ($trade['portfolioId'] ?? ''), 0, 80),
        'status' => substr((string) ($trade['status'] ?? ($closed ? 'CLOSED' : 'OPEN')), 0, 32),
        'closed' => $closed ? 1 : 0,
        'tokenId' => substr((string) ($trade['tokenId'] ?? $trade['assetId'] ?? ''), 0, 191) ?: null,
        'conditionId' => substr((string) ($trade['conditionId'] ?? ''), 0, 191) ?: null,
        'roundTrip' => max(1, (int) ($trade['roundTrip'] ?? 1)),
        'question' => substr((string) ($trade['question'] ?? ''), 0, 512) ?: null,
        'outcome' => substr((string) ($trade['outcome'] ?? ''), 0, 191) ?: null,
        'eventSlug' => substr((string) ($trade['eventSlug'] ?? $trade['slug'] ?? ''), 0, 191) ?: null,
        'openedAt' => trading_storage_datetime($trade['openedAt'] ?? $trade['date'] ?? null),
        'closedAt' => trading_storage_datetime($trade['closedAt'] ?? $trade['resolvedAt'] ?? null),
        'endAt' => trading_storage_datetime($trade['endDate'] ?? null),
        'entryPrice' => trading_storage_number($trade, ['entryPrice', 'avgPrice']),
        'exitPrice' => trading_storage_number($trade, ['exitPrice', 'closePrice', 'currentPrice']),
        'shares' => trading_storage_number($trade, ['shares', 'size']),
        'stake' => trading_storage_number($trade, ['totalCostUsdc', 'stakeUsdc']),
        'realized' => trading_storage_number($trade, ['realizedPnlUsdc', 'pnlUsdc']),
        'unrealized' => trading_storage_number($trade, ['unrealizedPnlUsdc', 'openPnlUsdc']),
        'payload' => trading_storage_pack_encoded($encoded),
        'checksum' => hash('sha256', $encoded),
        'createdAt' => $now,
        'updatedAt' => $now,
    ]);
}

/**
 * What is actually stored, per portfolio. Deliberately a count rather than the rows, so
 * "are the trades in the database" can be asked cheaply and often.
 */
function trading_storage_trade_summary(): array
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        return [];
    }
    trading_storage_bootstrap($pdo);
    $statement = $pdo->query(
        'SELECT account, portfolio_id,
                COUNT(*) AS total,
                SUM(closed = 0) AS open_rows,
                SUM(closed = 1) AS closed_rows,
                SUM(realized_pnl_usdc) AS realized,
                MIN(opened_at) AS first_opened_at,
                MAX(updated_at) AS last_updated_at
         FROM trading_trades
         GROUP BY account, portfolio_id
         ORDER BY total DESC'
    );
    if ($statement === false) {
        return [];
    }
    $rows = [];
    foreach ($statement->fetchAll() as $row) {
        $rows[] = [
            'account' => (string) ($row['account'] ?? ''),
            'portfolioId' => (string) ($row['portfolio_id'] ?? ''),
            'total' => (int) ($row['total'] ?? 0),
            'open' => (int) ($row['open_rows'] ?? 0),
            'closed' => (int) ($row['closed_rows'] ?? 0),
            'realizedPnlUsdc' => $row['realized'] === null ? null : round((float) $row['realized'], 6),
            'firstOpenedAt' => $row['first_opened_at'] === null ? null : (string) $row['first_opened_at'],
            'lastUpdatedAt' => $row['last_updated_at'] === null ? null : (string) $row['last_updated_at'],
        ];
    }
    return $rows;
}

/**
 * The first migration stored uncompressed JSON in every row and indexed several
 * fields that no SQL read currently queries. The retained JSON files remain the
 * recoverable source, while MySQL stores the compact working mirror.
 */
function trading_storage_optimize_schema(PDO $pdo): void
{
    static $complete = false;
    if ($complete) {
        return;
    }
    $complete = true;
    foreach ([
        ['trading_documents', 'payload'],
        ['trading_observations', 'payload'],
        ['trading_event_log', 'payload'],
    ] as [$table, $column]) {
        $statement = $pdo->prepare(
            'SELECT DATA_TYPE FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column'
        );
        $statement->execute(['table' => $table, 'column' => $column]);
        $type = strtolower((string) $statement->fetchColumn());
        if ($type !== 'mediumblob') {
            $pdo->exec('ALTER TABLE `' . $table . '` MODIFY `' . $column . '` MEDIUMBLOB NOT NULL, ROW_FORMAT=DYNAMIC');
        }
    }
    foreach ([
        'trading_documents' => ['trading_documents_type_updated'],
        'trading_observations' => [
            'trading_observations_lifecycle_probability',
            'trading_observations_lifecycle_return',
            'trading_observations_token',
            'trading_observations_event',
            'trading_observations_updated',
        ],
    ] as $table => $indexes) {
        foreach ($indexes as $index) {
            $statement = $pdo->prepare(
                'SELECT 1 FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND INDEX_NAME = :index LIMIT 1'
            );
            $statement->execute(['table' => $table, 'index' => $index]);
            if ($statement->fetchColumn() !== false) {
                $pdo->exec('ALTER TABLE `' . $table . '` DROP INDEX `' . $index . '`');
            }
        }
    }
    $statement = $pdo->prepare(
        'SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = "trading_observations"
           AND INDEX_NAME = "trading_observations_lifecycle_updated" LIMIT 1'
    );
    $statement->execute();
    if ($statement->fetchColumn() === false) {
        $pdo->exec('ALTER TABLE `trading_observations` ADD INDEX `trading_observations_lifecycle_updated` (`lifecycle`, `updated_at`)');
    }
}

function trading_storage_table_stats(PDO $pdo): array
{
    $tables = [
        'trading_storage_meta',
        'trading_documents',
        'trading_observations',
        'trading_event_log',
    ];
    $statement = $pdo->prepare(
        'SELECT table_name, table_rows, data_length, index_length, data_free
         FROM information_schema.TABLES
         WHERE table_schema = DATABASE() AND table_name IN ('
            . implode(', ', array_fill(0, count($tables), '?')) . ')'
    );
    $statement->execute($tables);
    $stats = [];
    foreach ($statement->fetchAll() as $row) {
        $name = (string) ($row['table_name'] ?? '');
        if ($name === '') {
            continue;
        }
        $stats[$name] = [
            'rows' => (int) ($row['table_rows'] ?? 0),
            'dataBytes' => (int) ($row['data_length'] ?? 0),
            'indexBytes' => (int) ($row['index_length'] ?? 0),
            'freeBytes' => (int) ($row['data_free'] ?? 0),
        ];
    }
    return $stats;
}

/**
 * Rebuild only the Trading tables when they are provably empty. This releases
 * InnoDB pages reserved by the first oversized import without ever discarding
 * retained records from a non-empty table.
 */
function trading_storage_compact_empty_tables(PDO $pdo): array
{
    trading_storage_bootstrap($pdo);
    $tables = [
        'trading_documents',
        'trading_observations',
        'trading_event_log',
    ];
    foreach ($tables as $table) {
        $count = (int) $pdo->query('SELECT COUNT(*) FROM `' . $table . '`')->fetchColumn();
        if ($count !== 0) {
            throw new RuntimeException('Trading storage compaction requires empty tables.');
        }
    }
    foreach ($tables as $table) {
        $pdo->query('OPTIMIZE TABLE `' . $table . '`')->fetchAll();
    }
    return trading_storage_table_stats($pdo);
}

function trading_storage_compression_preview(PDO $pdo, int $sampleLimit = 160): array
{
    trading_storage_bootstrap($pdo);
    $sampleLimit = max(1, min(500, $sampleLimit));
    $tables = [
        'trading_documents' => 'document_key',
        'trading_observations' => 'observation_key',
        'trading_event_log' => 'event_key',
    ];
    $preview = [];
    foreach ($tables as $table => $key) {
        $statement = $pdo->query('SELECT `payload` FROM `' . $table . '` ORDER BY `' . $key . '` LIMIT ' . $sampleLimit);
        $currentBytes = 0;
        $compressedBytes = 0;
        $readable = 0;
        while (($payload = $statement->fetchColumn()) !== false) {
            if (!is_string($payload)) {
                continue;
            }
            $currentBytes += strlen($payload);
            $decoded = trading_storage_unpack($payload);
            if (!is_array($decoded)) {
                continue;
            }
            $compressedBytes += strlen(trading_storage_pack($decoded));
            $readable++;
        }
        $preview[$table] = [
            'sampleRows' => $readable,
            'currentBytes' => $currentBytes,
            'compressedBytes' => $compressedBytes,
        ];
    }
    return $preview;
}

function trading_storage_compaction_table(string $table): array
{
    $tables = [
        'trading_documents' => 'document_key',
        'trading_observations' => 'observation_key',
        'trading_event_log' => 'event_key',
    ];
    if (!array_key_exists($table, $tables)) {
        throw new InvalidArgumentException('Unknown Trading storage table.');
    }
    return [$table, $tables[$table]];
}

/**
 * Rewrites a bounded primary-key range into the current compressed payload
 * format. The decoded JSON is identical and every batch is transactional, so a
 * timeout merely resumes from the returned cursor instead of losing a record.
 */
function trading_storage_compact_payload_batch(PDO $pdo, string $table, string $after = '', int $limit = 400): array
{
    trading_storage_bootstrap($pdo);
    [$table, $key] = trading_storage_compaction_table($table);
    $limit = max(1, min(1000, $limit));
    $statement = $pdo->prepare(
        'SELECT `' . $key . '` AS row_key, payload FROM `' . $table . '`
         WHERE `' . $key . '` > :after ORDER BY `' . $key . '` ASC LIMIT ' . $limit
    );
    $statement->execute(['after' => $after]);
    $rows = $statement->fetchAll();
    $update = $pdo->prepare('UPDATE `' . $table . '` SET payload = COMPRESS(payload) WHERE `' . $key . '` = :key');
    $processed = 0;
    $rewritten = 0;
    $skipped = 0;
    $last = $after;
    $pdo->beginTransaction();
    try {
        foreach ($rows as $row) {
            $last = (string) ($row['row_key'] ?? $last);
            $payload = $row['payload'] ?? null;
            $processed++;
            // JSON is minified by trading_storage_encode(), so an opening object or
            // array byte proves this is an old uncompressed row. Let MariaDB compress
            // it in place; decoding multi-megabyte documents in PHP is unnecessary.
            if (!is_string($payload) || ($payload[0] !== '{' && $payload[0] !== '[')) {
                $skipped++;
                continue;
            }
            $update->execute(['key' => $last]);
            $rewritten++;
        }
        $pdo->commit();
    } catch (Throwable $error) {
        $pdo->rollBack();
        throw $error;
    }
    return [
        'table' => $table,
        'processed' => $processed,
        'rewritten' => $rewritten,
        'skipped' => $skipped,
        'nextAfter' => $last,
        'done' => $processed < $limit,
    ];
}

/**
 * A run-log event reduced to what the stored history is read back FOR: which portfolio
 * ordered which token at what price, and what the run decided.
 *
 * The same shape ingest-trading-state.py now sends, restated here because the rows already
 * in the table were written before it did -- and the difference is not small. Measured:
 * 21315 rows at roughly ten kilobytes each, because the whole record travelled, including
 * topCandidates, topRejected and the entire prevalidation shortlist. All of that is a
 * snapshot of markets that also sits in the published execution state the dashboard reads.
 */
function trading_storage_slim_run_log_payload(array $payload): array
{
    $attempts = [];
    foreach ((is_array($payload['attempts'] ?? null) ? $payload['attempts'] : []) as $attempt) {
        if (!is_array($attempt)) {
            continue;
        }
        $attempts[] = array_filter([
            'action' => $attempt['action'] ?? null,
            'tokenId' => $attempt['tokenId'] ?? null,
            'orderPrice' => $attempt['orderPrice'] ?? null,
            'shares' => $attempt['shares'] ?? null,
            'question' => $attempt['question'] ?? null,
            'outcome' => $attempt['outcome'] ?? null,
        ], static fn (mixed $value): bool => $value !== null);
    }
    $slim = array_filter([
        'id' => $payload['id'] ?? null,
        'runAt' => $payload['runAt'] ?? $payload['generatedAt'] ?? null,
        'generatedAt' => $payload['generatedAt'] ?? null,
        'strategyId' => $payload['strategyId'] ?? null,
        'strategyLabel' => $payload['strategyLabel'] ?? null,
        'action' => $payload['action'] ?? null,
        'reason' => $payload['reason'] ?? null,
    ], static fn (mixed $value): bool => $value !== null && $value !== '');
    // Kept even when empty: "this run ordered nothing" is a fact the attribution reader
    // relies on, and an absent key would be read as a row that was never slimmed.
    $slim['attempts'] = $attempts;
    return $slim;
}

/**
 * Rewrite already-stored run-log events in the slim shape, in batches.
 *
 * Rewriting rather than deleting, because the attribution history is the reason the stream
 * exists -- deleting it to save space would throw away the only durable record of which
 * portfolio placed which trade, which is the thing this whole storage move is for.
 *
 * Cursor-paged on the primary key rather than OFFSET, because OFFSET on a two hundred
 * megabyte table re-reads everything it skips. Idempotent: a row already slim is rewritten
 * to the identical bytes and simply costs nothing.
 */
function trading_storage_slim_stored_events(PDO $pdo, string $cursor = '', int $limit = 200): array
{
    trading_storage_bootstrap($pdo);
    $limit = max(1, min(1000, $limit));
    $statement = $pdo->prepare(
        'SELECT event_key, payload FROM trading_event_log
         WHERE stream IN (:live, :paper) AND event_key > :cursor
         ORDER BY event_key ASC LIMIT ' . $limit
    );
    $statement->execute(['live' => 'state-run-log', 'paper' => 'portfolio-run-log', 'cursor' => $cursor]);
    $rows = $statement->fetchAll();
    if (!$rows) {
        return ['scanned' => 0, 'rewritten' => 0, 'bytesBefore' => 0, 'bytesAfter' => 0, 'cursor' => $cursor, 'done' => true];
    }
    $update = $pdo->prepare('UPDATE trading_event_log SET payload = :payload WHERE event_key = :key');
    $scanned = 0;
    $rewritten = 0;
    $before = 0;
    $after = 0;
    $cursorOut = $cursor;
    foreach ($rows as $row) {
        $scanned++;
        $cursorOut = (string) $row['event_key'];
        $packed = $row['payload'];
        $before += is_string($packed) ? strlen($packed) : 0;
        $decoded = trading_storage_unpack($packed);
        if (!is_array($decoded)) {
            $after += is_string($packed) ? strlen($packed) : 0;
            continue;
        }
        $slimPacked = trading_storage_pack(trading_storage_slim_run_log_payload($decoded));
        $after += strlen($slimPacked);
        // Only write when it actually shrinks. A row that is already slim, or one whose slim
        // form is somehow larger, is left exactly as it is.
        if (strlen($slimPacked) < strlen((string) $packed)) {
            $update->execute(['payload' => $slimPacked, 'key' => $cursorOut]);
            $rewritten++;
        }
    }
    return [
        'scanned' => $scanned,
        'rewritten' => $rewritten,
        'bytesBefore' => $before,
        'bytesAfter' => $after,
        'cursor' => $cursorOut,
        'done' => $scanned < $limit,
    ];
}

function trading_storage_rebuild_compacted_table(PDO $pdo, string $table): array
{
    trading_storage_bootstrap($pdo);
    [$table] = trading_storage_compaction_table($table);
    $pdo->query('OPTIMIZE TABLE `' . $table . '`')->fetchAll();
    return trading_storage_table_stats($pdo);
}

function trading_storage_now(): string
{
    return gmdate('Y-m-d H:i:s.u');
}

function trading_storage_encode(array $payload): string
{
    $encoded = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if (!is_string($encoded)) {
        throw new RuntimeException('Trading storage payload could not be encoded.');
    }
    return $encoded;
}

function trading_storage_pack(array $payload): string
{
    return trading_storage_pack_encoded(trading_storage_encode($payload));
}

function trading_storage_pack_encoded(string $encoded): string
{
    $packed = gzcompress($encoded, 6);
    if (!is_string($packed)) {
        throw new RuntimeException('Trading storage payload could not be compressed.');
    }
    return $packed;
}

function trading_storage_event_compact_value(mixed $value, int $depth = 0): mixed
{
    if (is_string($value)) {
        return strlen($value) > 4096 ? substr($value, 0, 4096) . ' [truncated]' : $value;
    }
    if (!is_array($value)) {
        return $value;
    }
    if ($depth >= 5) {
        return '[truncated nested payload]';
    }
    $ignoredKeys = [
        'audit', 'auditTrail', 'marketObservations', 'resolvedMarketObservations',
        'rawMarkets', 'rawMarket', 'rawResponse', 'responseBody', 'response',
        'orderBook', 'orderbook', 'marketData', 'history', 'historicalData',
    ];
    $isList = array_is_list($value);
    $result = [];
    $limit = $isList ? 60 : 100;
    $seen = 0;
    foreach ($value as $key => $child) {
        if (!$isList && in_array((string) $key, $ignoredKeys, true)) {
            continue;
        }
        if ($seen >= $limit) {
            $result['_storageTruncated'] = count($value) - $seen;
            break;
        }
        $result[$key] = trading_storage_event_compact_value($child, $depth + 1);
        $seen++;
    }
    return $result;
}

function trading_storage_event_compact_payload(array $payload): array
{
    $compact = trading_storage_event_compact_value($payload);
    if (!is_array($compact)) {
        return $payload;
    }
    $encoded = trading_storage_encode($compact);
    if (strlen($encoded) <= 98304) {
        return $compact;
    }
    return array_filter([
        'id' => $payload['id'] ?? null,
        'runAt' => $payload['runAt'] ?? $payload['changedAt'] ?? $payload['date'] ?? null,
        'action' => $payload['action'] ?? $payload['status'] ?? null,
        'status' => $payload['status'] ?? null,
        'reason' => $payload['reason'] ?? null,
        'note' => $payload['note'] ?? null,
        'market' => $payload['market'] ?? $payload['marketTitle'] ?? null,
        'outcome' => $payload['outcome'] ?? null,
        'storagePayloadTruncated' => true,
    ], static fn (mixed $value): bool => $value !== null && $value !== '');
}

function trading_storage_event_identity(array $payload, string $encoded): string
{
    foreach (['id', 'runId', 'workflowRunId', 'eventId'] as $key) {
        if (is_scalar($payload[$key] ?? null) && (string) $payload[$key] !== '') {
            return $key . ':' . (string) $payload[$key];
        }
    }
    $stable = [
        $payload['runAt'] ?? $payload['changedAt'] ?? $payload['date'] ?? null,
        $payload['action'] ?? $payload['status'] ?? null,
        $payload['portfolioId'] ?? $payload['strategyId'] ?? null,
        $payload['marketId'] ?? $payload['eventSlug'] ?? $payload['slug'] ?? null,
        $payload['outcome'] ?? null,
    ];
    foreach ($stable as $value) {
        if ($value !== null && $value !== '') {
            return hash('sha256', trading_storage_encode(['stable' => $stable]));
        }
    }
    return hash('sha256', $encoded);
}

function trading_storage_unpack(mixed $payload): ?array
{
    if (!is_string($payload)) {
        return null;
    }
    // Existing rows from before the compact schema remain readable if any survived
    // an interrupted migration: only successfully decompressed data is treated as
    // packed, otherwise it is the original JSON text.
    $unpacked = @gzuncompress($payload);
    // MySQL COMPRESS prepends the uncompressed byte length before the same zlib
    // stream. Maintenance uses it for legacy rows so the server can compress large
    // documents without first materialising them in PHP memory.
    if (!is_string($unpacked) && strlen($payload) > 4) {
        $mysqlHeader = unpack('Vlength', substr($payload, 0, 4));
        $mysqlUnpacked = @gzuncompress(substr($payload, 4));
        if (is_string($mysqlUnpacked)
            && is_array($mysqlHeader)
            && (int) ($mysqlHeader['length'] ?? -1) === strlen($mysqlUnpacked)) {
            $unpacked = $mysqlUnpacked;
        }
    }
    $decoded = json_decode(is_string($unpacked) ? $unpacked : $payload, true);
    return is_array($decoded) ? $decoded : null;
}

function trading_storage_document_get(string $key): ?array
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        return null;
    }
    try {
        trading_storage_bootstrap($pdo);
        $statement = $pdo->prepare('SELECT payload FROM trading_documents WHERE document_key = :key');
        $statement->execute(['key' => $key]);
        $payload = $statement->fetchColumn();
        return trading_storage_unpack($payload);
    } catch (Throwable) {
        return null;
    }
}

function trading_storage_document_put(string $key, string $type, array $payload): void
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        throw new RuntimeException('Trading MySQL storage is unavailable.');
    }
    trading_storage_bootstrap($pdo);
    $encoded = trading_storage_encode($payload);
    $now = trading_storage_now();
    $statement = $pdo->prepare(
        'INSERT INTO trading_documents (document_key, document_type, payload, checksum, version, created_at, updated_at)
         VALUES (:key, :type, :payload, :checksum, 1, :createdAt, :updatedAt)
         ON DUPLICATE KEY UPDATE document_type = VALUES(document_type), payload = VALUES(payload),
           checksum = VALUES(checksum), version = version + 1, updated_at = VALUES(updated_at)'
    );
    $statement->execute([
        'key' => $key,
        'type' => $type,
        'payload' => trading_storage_pack_encoded($encoded),
        'checksum' => hash('sha256', $encoded),
        'createdAt' => $now,
        'updatedAt' => $now,
    ]);
}

function trading_storage_meta_get(string $key): ?string
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        return null;
    }
    try {
        trading_storage_bootstrap($pdo);
        $statement = $pdo->prepare('SELECT meta_value FROM trading_storage_meta WHERE meta_key = :key');
        $statement->execute(['key' => $key]);
        $value = $statement->fetchColumn();
        return is_string($value) ? $value : null;
    } catch (Throwable) {
        return null;
    }
}

function trading_storage_meta_put(string $key, string $value): void
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        throw new RuntimeException('Trading MySQL storage is unavailable.');
    }
    trading_storage_bootstrap($pdo);
    $statement = $pdo->prepare(
        'INSERT INTO trading_storage_meta (meta_key, meta_value, updated_at) VALUES (:key, :value, :now)
         ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value), updated_at = VALUES(updated_at)'
    );
    $statement->execute(['key' => $key, 'value' => $value, 'now' => trading_storage_now()]);
}

function trading_storage_is_active(): bool
{
    return trading_storage_meta_get('storage-active') === '1';
}

function trading_storage_event_append(string $stream, ?string $portfolioId, array $payload, ?string $occurredAt = null): void
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        throw new RuntimeException('Trading MySQL storage is unavailable.');
    }
    trading_storage_bootstrap($pdo);
    $compactPayload = trading_storage_event_compact_payload($payload);
    $encoded = trading_storage_encode($compactPayload);
    $occurredAt = trading_storage_datetime($occurredAt ?? $payload['changedAt'] ?? $payload['runAt'] ?? $payload['date'] ?? null);
    // Most imported records already have a stable id. The deterministic fallback makes
    // retrying an ingest idempotent instead of duplicating a portfolio's audit trail.
    $identity = trading_storage_event_identity($payload, $encoded);
    $eventKey = hash('sha256', implode("\x1F", [$stream, (string) $portfolioId, (string) $occurredAt, $identity]));
    $statement = $pdo->prepare(
        'INSERT INTO trading_event_log (event_key, stream, portfolio_id, occurred_at, payload, created_at)
         VALUES (:key, :stream, :portfolioId, :occurredAt, :payload, :createdAt)
         ON DUPLICATE KEY UPDATE payload = VALUES(payload), occurred_at = VALUES(occurred_at)'
    );
    $statement->execute([
        'key' => $eventKey,
        'stream' => $stream,
        'portfolioId' => $portfolioId,
        'occurredAt' => $occurredAt,
        'payload' => trading_storage_pack_encoded($encoded),
        'createdAt' => trading_storage_now(),
    ]);
}

function trading_storage_event_records(string $stream, ?string $portfolioId = null, int $limit = 500): array
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        return [];
    }
    trading_storage_bootstrap($pdo);
    $limit = max(1, min(5000, $limit));
    $sql = 'SELECT payload FROM trading_event_log WHERE stream = :stream';
    $params = ['stream' => $stream];
    if ($portfolioId !== null) {
        $sql .= ' AND portfolio_id = :portfolioId';
        $params['portfolioId'] = $portfolioId;
    }
    $sql .= ' ORDER BY occurred_at DESC, created_at DESC LIMIT ' . $limit;
    $statement = $pdo->prepare($sql);
    $statement->execute($params);
    $records = [];
    while (($payload = $statement->fetchColumn()) !== false) {
        $decoded = trading_storage_unpack($payload);
        if (is_array($decoded)) {
            $records[] = $decoded;
        }
    }
    return $records;
}

function trading_storage_observation_key(array $item): string
{
    foreach (['id', 'observationId'] as $key) {
        if (is_scalar($item[$key] ?? null) && (string) $item[$key] !== '') {
            return hash('sha256', 'id:' . (string) $item[$key]);
        }
    }
    $parts = [
        (string) ($item['tokenId'] ?? $item['firstTokenId'] ?? ''),
        (string) ($item['eventSlug'] ?? $item['slug'] ?? ''),
        (string) ($item['outcome'] ?? $item['firstOutcome'] ?? ''),
    ];
    return hash('sha256', implode("\x1F", $parts));
}

function trading_storage_lifecycle(array $item): string
{
    $status = strtoupper((string) ($item['status'] ?? $item['selectionStatus'] ?? 'SCRAPED'));
    return in_array($status, ['RESOLVED', 'CLOSED', 'EXPIRED', 'FINALIZED', 'SETTLED'], true) ? 'RESOLVED' : 'SCRAPED';
}

function trading_storage_datetime(mixed $value): ?string
{
    if (!is_string($value) || trim($value) === '') {
        return null;
    }
    $timestamp = strtotime($value);
    return $timestamp === false ? null : gmdate('Y-m-d H:i:s', $timestamp);
}

function trading_storage_number(array $item, array $keys): ?float
{
    foreach ($keys as $key) {
        if (is_numeric($item[$key] ?? null)) {
            return (float) $item[$key];
        }
    }
    return null;
}

function trading_storage_observations_upsert(array $items): int
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        throw new RuntimeException('Trading MySQL storage is unavailable.');
    }
    trading_storage_bootstrap($pdo);
    $statement = $pdo->prepare(
        'INSERT INTO trading_observations (
           observation_key, lifecycle, source_id, token_id, event_slug, market_slug, outcome_label, market_type,
           end_at, observed_at, resolved_at, market_probability, net_yield, annualized_return, volume_usdc,
           tags_json, payload, payload_checksum, created_at, updated_at
         ) VALUES (
           :key, :lifecycle, :sourceId, :tokenId, :eventSlug, :marketSlug, :outcome, :marketType,
           :endAt, :observedAt, :resolvedAt, :probability, :netYield, :annualizedReturn, :volume,
           :tags, :payload, :checksum, :createdAt, :updatedAt
         ) ON DUPLICATE KEY UPDATE
           lifecycle = VALUES(lifecycle), source_id = VALUES(source_id), token_id = VALUES(token_id),
           event_slug = VALUES(event_slug), market_slug = VALUES(market_slug), outcome_label = VALUES(outcome_label),
           market_type = VALUES(market_type), end_at = VALUES(end_at), observed_at = VALUES(observed_at),
           resolved_at = VALUES(resolved_at), market_probability = VALUES(market_probability),
           net_yield = VALUES(net_yield), annualized_return = VALUES(annualized_return), volume_usdc = VALUES(volume_usdc),
           tags_json = VALUES(tags_json), payload = VALUES(payload), payload_checksum = VALUES(payload_checksum),
           updated_at = VALUES(updated_at)'
    );
    $count = 0;
    $pdo->beginTransaction();
    try {
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }
            $payload = trading_storage_encode($item);
            $tags = $item['polymarketTags'] ?? $item['tags'] ?? $item['firstTags'] ?? [];
            $statement->execute([
                'key' => trading_storage_observation_key($item),
                'lifecycle' => trading_storage_lifecycle($item),
                'sourceId' => isset($item['id']) ? (string) $item['id'] : null,
                'tokenId' => isset($item['tokenId']) ? (string) $item['tokenId'] : (isset($item['firstTokenId']) ? (string) $item['firstTokenId'] : null),
                'eventSlug' => isset($item['eventSlug']) ? (string) $item['eventSlug'] : null,
                'marketSlug' => isset($item['slug']) ? (string) $item['slug'] : null,
                'outcome' => isset($item['outcome']) ? (string) $item['outcome'] : (isset($item['firstOutcome']) ? (string) $item['firstOutcome'] : null),
                'marketType' => isset($item['marketType']) ? (string) $item['marketType'] : null,
                'endAt' => trading_storage_datetime($item['endDate'] ?? null),
                'observedAt' => trading_storage_datetime($item['observedAt'] ?? $item['firstObservedAt'] ?? null),
                'resolvedAt' => trading_storage_datetime($item['resolvedAt'] ?? $item['updatedAt'] ?? null),
                'probability' => trading_storage_number($item, ['marketProbability', 'firstMarketProbability']),
                'netYield' => trading_storage_number($item, ['netYield']),
                'annualizedReturn' => trading_storage_number($item, ['marketAnnualizedReturn', 'potentialAnnualizedReturn', 'annualizedReturn']),
                'volume' => trading_storage_number($item, ['resolvedVolumeUsdc', 'volumeUsdc', 'volume', 'liquidity']),
                'tags' => trading_storage_encode(is_array($tags) ? $tags : [$tags]),
                'payload' => trading_storage_pack_encoded($payload),
                'checksum' => hash('sha256', $payload),
                'createdAt' => trading_storage_now(),
                'updatedAt' => trading_storage_now(),
            ]);
            $count += 1;
        }
        $pdo->commit();
    } catch (Throwable $error) {
        $pdo->rollBack();
        throw $error;
    }
    return $count;
}

function trading_storage_observations_fetch(string $lifecycle, int $limit = 0, int $offset = 0): array
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        return [];
    }
    trading_storage_bootstrap($pdo);
    // The id tie-break is what makes the order total, and paging needs it: updated_at
    // alone has thousands of ties on this table -- one scan writes a whole page inside a
    // single transaction -- and the database is free to return tied rows in a different
    // order for each page. A walk over a non-total order silently misses and repeats rows.
    $sql = 'SELECT payload FROM trading_observations WHERE lifecycle = :lifecycle'
        . ' ORDER BY updated_at DESC, id DESC';
    if ($limit > 0) {
        $sql .= ' LIMIT ' . min(100000, $limit);
        // OFFSET is only legal after LIMIT, so an offset on its own would quietly serve
        // the whole table from row zero -- the failure this paging exists to avoid.
        if ($offset > 0) {
            $sql .= ' OFFSET ' . max(0, $offset);
        }
    }
    $statement = $pdo->prepare($sql);
    $statement->execute(['lifecycle' => $lifecycle]);
    $rows = [];
    while (($payload = $statement->fetchColumn()) !== false) {
        $decoded = trading_storage_unpack($payload);
        if (is_array($decoded)) {
            $rows[] = $decoded;
        }
    }
    return $rows;
}

function trading_storage_observation_counts(): array
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        return ['SCRAPED' => 0, 'RESOLVED' => 0];
    }
    trading_storage_bootstrap($pdo);
    $rows = $pdo->query('SELECT lifecycle, COUNT(*) AS total FROM trading_observations GROUP BY lifecycle')->fetchAll();
    $counts = ['SCRAPED' => 0, 'RESOLVED' => 0];
    foreach ($rows as $row) {
        $lifecycle = strtoupper((string) ($row['lifecycle'] ?? ''));
        if (array_key_exists($lifecycle, $counts)) {
            $counts[$lifecycle] = (int) ($row['total'] ?? 0);
        }
    }
    return $counts;
}
