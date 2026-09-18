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
        // Every timestamp is WRITTEN in UTC by trading_storage_now(), and every NOW() in
        // this file is compared against one. Without this the session keeps the server's
        // own zone -- Europe/Prague, two hours ahead in summer -- so a row written this
        // second reads as two hours old, and everything measured against NOW() is wrong by
        // exactly the offset.
        //
        // Measured before the fix: 40 sampled rows, every one reporting age 122 minutes.
        // Not a distribution -- one value, which is what a clock offset looks like and a
        // real lag never does. It was read as "the mirror has not written for two hours".
        // The mirror was writing the whole time.
        $pdo->exec("SET time_zone = '+00:00'");
    } catch (Throwable) {
        $pdo = null;
    }
    return $pdo instanceof PDO ? $pdo : null;
}

/**
 * The moment before which an observation is no longer part of the CURRENT catalogue.
 *
 * Computed in PHP, in UTC, and bound as a parameter rather than written as NOW() - INTERVAL.
 * The session zone above makes those agree, but this is the one comparison the bots' whole
 * candidate list hangs on: if it is ever wrong the catalogue silently empties, and no query
 * should depend on two clocks agreeing when it can depend on one.
 */
function trading_storage_catalogue_fresh_since(): string
{
    return gmdate('Y-m-d H:i:s', time() - (trading_storage_catalogue_fresh_minutes() * 60));
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
            -- The shape a portfolio actually asks in: the current catalogue, inside a
            -- probability band, resolving before a horizon. Without it every portfolio scan
            -- reads the whole lifecycle and filters afterwards, which is the cost that made
            -- serving reads from here collapse the host.
            KEY trading_observations_scope (lifecycle, updated_at, market_probability, end_at)
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
 * Identity of one trade: the account, the market, which round trip on that market it is, and
 * -- for paper only -- the portfolio that placed it. Falling back to the condition and outcome
 * keeps a row identifiable when a feed reports a redemption against the condition rather than
 * the token.
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
    $account = strtolower(trim((string) ($trade['account'] ?? '')));
    // The portfolio belongs in the identity only where it genuinely distinguishes one trade
    // from another.
    //
    // Paper: several paper portfolios hold the same token at the same time on purpose, so two
    // rows differing only by portfolio really are two trades and the id belongs here.
    //
    // Live: there is ONE wallet. A token in a given round trip is one on-chain position
    // whichever portfolio opened it, and the owner is derived afterwards from the order
    // history -- so it can still be unknown the first time the position is seen. Keying on it
    // would file that position twice, once unattributed and again under its real owner once
    // that is worked out. Here the portfolio is a property of the trade, filled in by a later
    // pass, and the account column is what separates live from paper.
    $owner = $account === 'live' ? '' : (string) ($trade['portfolioId'] ?? '');
    return hash('sha256', implode("\x1F", [
        (string) ($trade['account'] ?? ''),
        $owner,
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
            -- A live position is often stored before anyone knows which portfolio opened it;
            -- the owner is derived later from the order history. So an incoming id fills an
            -- empty one in place, and an empty incoming id never blanks an id already known.
            portfolio_id = COALESCE(NULLIF(VALUES(portfolio_id), :emptyOwner), portfolio_id),
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
        // Bound rather than written inline so the empty-string marker is one value in one
        // place; the column is NOT NULL, so unattributed is stored as the empty string.
        'emptyOwner' => '',
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
 * The stored trades themselves, for a named set of keys.
 *
 * Separate from the key reader above because the two questions have very different costs.
 * "Which trades are in here" is a handful of columns over every row; "give me these back"
 * decodes a payload blob each, and only the rows a restore is actually going to put back
 * are worth that. Chunked for the same reason: a 562-row IN clause with a MEDIUMBLOB
 * behind every match is not a query this hosting should be asked to answer at once.
 */
function trading_storage_trade_payloads_for(string $account, string $portfolioId, array $keys): array
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO || $keys === []) {
        return [];
    }
    trading_storage_bootstrap($pdo);
    $rows = [];
    foreach (array_chunk(array_values($keys), 100) as $chunk) {
        $placeholders = implode(',', array_fill(0, count($chunk), '?'));
        $statement = $pdo->prepare(
            'SELECT trade_key, payload FROM trading_trades
             WHERE account = ? AND portfolio_id = ? AND trade_key IN (' . $placeholders . ')'
        );
        if ($statement === false) {
            continue;
        }
        $statement->execute(array_merge([$account, $portfolioId], $chunk));
        foreach ($statement->fetchAll() as $row) {
            $decoded = trading_storage_unpack($row['payload'] ?? null);
            if (is_array($decoded)) {
                $rows[(string) ($row['trade_key'] ?? '')] = $decoded;
            }
        }
    }
    return $rows;
}

/**
 * The stored trade keys for one portfolio, with just enough of each row to describe it.
 *
 * Added to answer the question a restore has to answer first: does the database hold what
 * the published state lost, and does it also hold what the published state currently has?
 * The second half is the dangerous one -- restoring from a source that is missing today's
 * trades would trade one loss for another -- and it can only be checked key by key.
 *
 * The payload blob is deliberately not selected. 6,447 rows of it will not fit in 128 MB,
 * and none of it is needed to compare two sets.
 */
function trading_storage_trade_keys_for(string $account, string $portfolioId): array
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        return [];
    }
    trading_storage_bootstrap($pdo);
    $statement = $pdo->prepare(
        'SELECT trade_key, status, token_id, round_trip, opened_at, closed_at
         FROM trading_trades
         WHERE account = :account AND portfolio_id = :portfolio'
    );
    if ($statement === false) {
        return [];
    }
    $statement->execute([':account' => $account, ':portfolio' => $portfolioId]);
    $rows = [];
    foreach ($statement->fetchAll() as $row) {
        $rows[(string) ($row['trade_key'] ?? '')] = [
            'status' => (string) ($row['status'] ?? ''),
            'tokenId' => (string) ($row['token_id'] ?? ''),
            'roundTrip' => (int) ($row['round_trip'] ?? 1),
            'openedAt' => $row['opened_at'] ?? null,
            'closedAt' => $row['closed_at'] ?? null,
        ];
    }
    return $rows;
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
            // Retired 2026-09-18. Its columns (lifecycle, updated_at) are an exact leftmost
            // prefix of trading_observations_scope (lifecycle, updated_at, market_probability,
            // end_at), so every query it could serve the wider index serves as well. That is a
            // property of B-tree indexing, not a judgement about this application, and the
            // index inventory found it by comparing column lists rather than by guessing.
            'trading_observations_lifecycle_updated',
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
    // CREATE TABLE IF NOT EXISTS never touches a table that already exists, so an index
    // added to the schema above reaches production only by being added here as well.
    foreach ([
        // The shape a portfolio actually asks in: the current catalogue, inside a probability
        // band, resolving before a horizon. Without it every portfolio scan reads the whole
        // lifecycle and filters afterwards -- the cost that made serving reads from here
        // collapse the host.
        'trading_observations_scope' => '(`lifecycle`, `updated_at`, `market_probability`, `end_at`)',
    ] as $index => $columns) {
        $statement = $pdo->prepare(
            'SELECT 1 FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = "trading_observations"
               AND INDEX_NAME = :index LIMIT 1'
        );
        $statement->execute(['index' => $index]);
        if ($statement->fetchColumn() === false) {
            $pdo->exec('ALTER TABLE `trading_observations` ADD INDEX `' . $index . '` ' . $columns);
        }
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
 * What the database already knows about each stored market, in four numbers.
 *
 * Read-only: one SELECT of five columns, no payload is decoded and nothing is written.
 *
 * This exists to stop the mirror re-sending a catalogue that has not changed. Measured on a
 * market scan of 18.9.: the whole job took 204 seconds, of which the scan itself was 37 and
 * the MySQL mirror was 90 -- 27 POSTs of 300 observations each, roughly 16 MB uploaded, on
 * every pass, ten minutes apart, for a catalogue that mostly stands still.
 *
 * It re-sends because the PAYLOAD always differs: every row carries its own observedAt, and
 * that ticks on every scrape even when the price, the volume and the end date are exactly
 * what they were. So the payload checksum is useless for this question and the material
 * fields have to be compared instead, which is what these four are.
 *
 * They come from COLUMNS rather than from the payload deliberately. The caller compares its
 * own values against these with a tolerance, so neither side has to reproduce the other's
 * JSON encoding -- an encoding mismatch would silently mark everything as changed and put
 * the whole cost straight back while appearing to work.
 */
function trading_storage_observation_fingerprints(PDO $pdo, int $days = 7, int $limit = 20000): array
{
    trading_storage_bootstrap($pdo);
    $days = max(1, min(90, $days));
    $limit = max(1, min(50000, $limit));
    $statement = $pdo->prepare(
        'SELECT observation_key, lifecycle, market_probability, volume_usdc, end_at
         FROM trading_observations
         WHERE updated_at >= (UTC_TIMESTAMP() - INTERVAL :days DAY)
         ORDER BY updated_at DESC
         LIMIT ' . $limit
    );
    $statement->execute(['days' => $days]);
    $fingerprints = [];
    foreach ($statement->fetchAll() as $row) {
        $key = (string) ($row['observation_key'] ?? '');
        if ($key === '') {
            continue;
        }
        $fingerprints[$key] = [
            // Ordered so the caller reads them positionally and the response stays small:
            // a named object per row would roughly triple it at eight thousand rows.
            $row['market_probability'] === null ? null : (float) $row['market_probability'],
            $row['volume_usdc'] === null ? null : (float) $row['volume_usdc'],
            $row['end_at'] === null ? null : (string) $row['end_at'],
            (string) ($row['lifecycle'] ?? ''),
        ];
    }
    return $fingerprints;
}

/**
 * Can the database assemble every paper portfolio's trades inside this hosting's memory?
 *
 * Read-only: it loads each stored portfolio document, counts what is in it, and releases it
 * again. Nothing is written and nothing is returned but the counts.
 *
 * This is the one measurement the cutover turns on. The paper bot rebuilds its whole state
 * from summary=refresh, and served from the database that read answers with `state:paper` --
 * the portfolios and their parameters, with each portfolio's trades sitting in a document of
 * its own that the read names none of. On 2026-09-12 it came back with thirty-six portfolios
 * and no trades, the bot accepted it and published it back over the files, and every paper
 * history was lost. api.php refuses that read from the database now, and the refusal states
 * what would lift it: "until the database path can assemble every portfolio's trades within
 * this hosting's memory".
 *
 * That is a number, not an opinion, and this returns it. Documents are loaded ONE AT A TIME
 * and released, which is how the real assembly would have to work, so the peak here is the
 * peak that read would pay -- not the cost of holding all of them at once.
 */
function trading_storage_refresh_assembly_cost(PDO $pdo): array
{
    trading_storage_bootstrap($pdo);
    $baseline = memory_get_usage(true);
    $statement = $pdo->query(
        "SELECT document_key FROM trading_documents WHERE document_key LIKE 'paper-portfolio:%' ORDER BY document_key"
    );
    $keys = [];
    foreach ($statement->fetchAll() as $row) {
        $key = (string) ($row['document_key'] ?? '');
        if ($key !== '') {
            $keys[] = $key;
        }
    }
    $documents = 0;
    $trades = 0;
    $decodedBytes = 0;
    $largest = ['key' => null, 'trades' => 0];
    $missing = [];
    foreach ($keys as $key) {
        $document = trading_storage_document_get($key);
        if (!is_array($document)) {
            $missing[] = $key;
            continue;
        }
        $documents++;
        // The shape the state read merges: the portfolio sits under paperPortfolio, or is
        // the document itself on the older writes.
        $portfolio = is_array($document['paperPortfolio'] ?? null) ? $document['paperPortfolio'] : $document;
        $count = is_array($portfolio['trades'] ?? null) ? count($portfolio['trades']) : 0;
        $trades += $count;
        if ($count > $largest['trades']) {
            $largest = ['key' => $key, 'trades' => $count];
        }
        // What the assembled response would weigh, measured on the DECODED document rather
        // than on the stored blob: the blob is compressed and the response is not.
        $decodedBytes += strlen((string) json_encode($portfolio));
        unset($document, $portfolio);
    }
    $limit = (string) ini_get('memory_limit');
    $limitBytes = 0;
    if (preg_match('/^(\d+)([KMG]?)$/i', trim($limit), $match)) {
        $limitBytes = (int) $match[1] * match (strtoupper($match[2])) {
            'G' => 1073741824, 'M' => 1048576, 'K' => 1024, default => 1,
        };
    }
    $peak = memory_get_peak_usage(true);
    return [
        'documentsFound' => count($keys),
        'documentsLoaded' => $documents,
        'documentsMissing' => $missing,
        'trades' => $trades,
        'largestPortfolio' => $largest,
        // What one assembled refresh response would weigh, uncompressed.
        'assembledBytes' => $decodedBytes,
        'baselineBytes' => $baseline,
        'peakBytes' => $peak,
        'memoryLimit' => $limit,
        'memoryLimitBytes' => $limitBytes,
        // The judgement, stated here rather than left to whoever reads the numbers. The
        // response has to be BUILT as well as streamed, so the assembled payload has to fit
        // beside the peak -- and a measurement that only just fits is not a pass, because
        // this host serves other requests at the same time.
        'headroomBytes' => $limitBytes > 0 ? $limitBytes - ($peak + $decodedBytes) : null,
        'fits' => $limitBytes > 0 && ($peak + $decodedBytes) < (int) ($limitBytes * 0.6),
    ];
}

/**
 * Every table in the schema, largest first -- not only the four Trading ones.
 *
 * Read-only: one SELECT against information_schema, no row of any table is touched.
 *
 * Asked, with the hosting quota at 1785 MB of 2000: "nase mysql databaze nema tolik dat, ale
 * jeji velikost je neumerne vysoka ... nemame tam miliony zaznamu, takze myslim, ze je spis
 * chyba v datech nez v mnozstvi."
 *
 * trading_storage_table_stats answers that for the Trading tables and nothing else, so with
 * it alone a schema shared with another application reads as "Trading is small, the quota is
 * full" and the search stops with no suspect. The quota is charged on the whole schema, so
 * the whole schema is what has to be listed before anything is blamed.
 *
 * freeBytes is reported beside the data because the two have opposite remedies: bytes held
 * by rows are removed by deleting or compacting rows, bytes held as free space are already
 * unused and come back only from rebuilding the table.
 */
function trading_storage_schema_footprint(PDO $pdo): array
{
    $statement = $pdo->query(
        'SELECT table_name, engine, table_rows, data_length, index_length, data_free
         FROM information_schema.TABLES
         WHERE table_schema = DATABASE()
         ORDER BY (data_length + index_length + data_free) DESC'
    );
    $tables = [];
    $totals = ['rows' => 0, 'dataBytes' => 0, 'indexBytes' => 0, 'freeBytes' => 0];
    foreach ($statement->fetchAll() as $row) {
        $name = (string) ($row['table_name'] ?? '');
        if ($name === '') {
            continue;
        }
        $entry = [
            'table' => $name,
            'engine' => (string) ($row['engine'] ?? ''),
            'rows' => (int) ($row['table_rows'] ?? 0),
            'dataBytes' => (int) ($row['data_length'] ?? 0),
            'indexBytes' => (int) ($row['index_length'] ?? 0),
            'freeBytes' => (int) ($row['data_free'] ?? 0),
            // What this table costs the quota, which is the only number the hosting cares
            // about. Free space is inside the tablespace and is charged for like any other.
            'totalBytes' => (int) ($row['data_length'] ?? 0)
                + (int) ($row['index_length'] ?? 0)
                + (int) ($row['data_free'] ?? 0),
            // Named here rather than inferred by every caller: a Trading table is one this
            // application created, and everything else in the schema belongs to something
            // else and must not be touched from here.
            'trading' => str_starts_with($name, 'trading_'),
        ];
        $tables[] = $entry;
        $totals['rows'] += $entry['rows'];
        $totals['dataBytes'] += $entry['dataBytes'];
        $totals['indexBytes'] += $entry['indexBytes'];
        $totals['freeBytes'] += $entry['freeBytes'];
    }
    $totals['totalBytes'] = $totals['dataBytes'] + $totals['indexBytes'] + $totals['freeBytes'];
    $tradingTotals = ['rows' => 0, 'dataBytes' => 0, 'indexBytes' => 0, 'freeBytes' => 0, 'totalBytes' => 0];
    foreach ($tables as $entry) {
        if ($entry['trading'] !== true) {
            continue;
        }
        foreach (['rows', 'dataBytes', 'indexBytes', 'freeBytes', 'totalBytes'] as $field) {
            $tradingTotals[$field] += $entry[$field];
        }
    }
    return [
        'tables' => $tables,
        'totals' => $totals,
        'tradingTotals' => $tradingTotals,
        'tableCount' => count($tables),
    ];
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

/**
 * Every index on the Trading tables, its columns in order, and which of them another index
 * already covers.
 *
 * Read-only: one SELECT against information_schema.STATISTICS. No index is created, dropped
 * or altered here.
 *
 * trading_observations carries 92 MB of secondary index against 518 MB of data, and unlike
 * the payload -- where the measurement found that every field is read somewhere -- index
 * redundancy is PROVABLE from the column lists alone. An index whose columns are a leftmost
 * prefix of another index's columns can serve no query the wider one cannot, so dropping it
 * changes no plan. That is a property of B-tree indexing, not a judgement about this
 * application, which is what makes it safe to state without reading a single query.
 *
 * Stated as a candidate rather than an instruction even so. A UNIQUE index is never reported
 * as redundant however its columns look: it enforces a constraint, and the wider index does
 * not.
 */
function trading_storage_index_inventory(PDO $pdo): array
{
    trading_storage_bootstrap($pdo);
    $statement = $pdo->query(
        'SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, CARDINALITY
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE "trading\\_%"
         ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX'
    );
    $indexes = [];
    foreach ($statement->fetchAll() as $row) {
        $table = (string) ($row['TABLE_NAME'] ?? '');
        $name = (string) ($row['INDEX_NAME'] ?? '');
        if ($table === '' || $name === '') {
            continue;
        }
        $key = $table . "\x1f" . $name;
        if (!isset($indexes[$key])) {
            $indexes[$key] = [
                'table' => $table,
                'index' => $name,
                'unique' => (int) ($row['NON_UNIQUE'] ?? 1) === 0,
                'columns' => [],
                'cardinality' => (int) ($row['CARDINALITY'] ?? 0),
            ];
        }
        $indexes[$key]['columns'][] = (string) ($row['COLUMN_NAME'] ?? '');
    }

    // A leftmost prefix of another index on the same table, and neither unique.
    $list = array_values($indexes);
    foreach ($list as $position => $entry) {
        $list[$position]['coveredBy'] = null;
        if ($entry['unique']) {
            continue;
        }
        foreach ($list as $other) {
            if ($other['table'] !== $entry['table'] || $other['index'] === $entry['index']) {
                continue;
            }
            if (count($other['columns']) <= count($entry['columns'])) {
                continue;
            }
            if (array_slice($other['columns'], 0, count($entry['columns'])) === $entry['columns']) {
                $list[$position]['coveredBy'] = $other['index'];
                break;
            }
        }
    }
    return $list;
}

/**
 * How much of a table is content and how much is empty space inside its pages.
 *
 * This is the question the earlier measurements could not answer. The footprint says
 * trading_observations costs 2,720 bytes of data per row; the payload anatomy says the packed
 * payload is 1,061 of them. The gap is 1,659 bytes per row that no field accounts for, and
 * there are only two explanations: the structured columns really are that big, or the rows
 * are sitting in half-empty pages.
 *
 * information_schema cannot tell them apart. DATA_FREE counts only whole extents that belong
 * to no page at all -- it reported 4%, which is why fragmentation looked ruled out. Space
 * wasted INSIDE a page is invisible to it, and after months of random inserts and updates that
 * is where InnoDB space goes.
 *
 * So this adds up what the columns actually weigh, from the declared types rather than from
 * LENGTH() on everything (LENGTH() of a DATETIME is the 19 characters of its text form, not
 * the 5 bytes it occupies -- measuring it that way would invent content that is not there),
 * and compares that with what the table is charged for. The ratio is the answer:
 *
 *   near 1.0  -> the table is full of content and only deleting rows can shrink it
 *   near 2.0  -> half of what the hosting charges for is empty space a rebuild would return
 *
 * Read-only. It reads information_schema and runs one aggregate per table. Nothing is
 * written, no table is altered, and the reclaim figure is an estimate offered for a decision,
 * not an action taken.
 */
function trading_storage_row_density(PDO $pdo): array
{
    trading_storage_bootstrap($pdo);

    // A freshly rebuilt InnoDB B-tree leaf is filled to 15/16 of the page; everything after
    // that is the cost of living. Quoted here once so the estimate below has a stated basis.
    $rebuiltFill = 15 / 16;

    $columns = $pdo->query(
        'SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, NUMERIC_PRECISION, NUMERIC_SCALE,
                DATETIME_PRECISION, CHARACTER_OCTET_LENGTH
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE "trading\\_%"
         ORDER BY TABLE_NAME, ORDINAL_POSITION'
    )->fetchAll();

    $byTable = [];
    foreach ($columns as $column) {
        $table = (string) ($column['TABLE_NAME'] ?? '');
        if ($table === '') {
            continue;
        }
        $byTable[$table][] = $column;
    }

    $sizes = $pdo->query(
        'SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, DATA_FREE
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE "trading\\_%"'
    )->fetchAll();
    $sizeByTable = [];
    foreach ($sizes as $row) {
        $sizeByTable[(string) ($row['TABLE_NAME'] ?? '')] = $row;
    }

    $report = [];
    foreach ($byTable as $table => $definitions) {
        $terms = [];
        $nullable = 0;
        $fixedBytes = 0;
        foreach ($definitions as $definition) {
            $name = (string) ($definition['COLUMN_NAME'] ?? '');
            $type = strtolower((string) ($definition['DATA_TYPE'] ?? ''));
            if ($name === '') {
                continue;
            }
            if (strtoupper((string) ($definition['IS_NULLABLE'] ?? '')) === 'YES') {
                $nullable++;
            }
            $quoted = '`' . str_replace('`', '``', $name) . '`';
            switch ($type) {
                case 'char':
                case 'varchar':
                case 'text':
                case 'tinytext':
                case 'mediumtext':
                case 'longtext':
                case 'blob':
                case 'tinyblob':
                case 'mediumblob':
                case 'longblob':
                case 'varbinary':
                case 'binary':
                case 'json':
                    // The only types whose size varies per row, so the only ones worth a scan.
                    // The declared maximum says nothing: a VARCHAR(191) holding a 12-character
                    // slug costs 13 bytes, not 191.
                    $prefix = in_array($type, ['tinytext', 'tinyblob'], true) ? 1
                        : (in_array($type, ['mediumtext', 'mediumblob'], true) ? 3
                            : (in_array($type, ['longtext', 'longblob', 'json'], true) ? 4
                                : ((int) ($definition['CHARACTER_OCTET_LENGTH'] ?? 0) > 255 ? 2 : 1)));
                    $terms[] = 'COALESCE(LENGTH(' . $quoted . '), 0) + ' . $prefix;
                    break;
                case 'datetime':
                    // 5 bytes, plus one per two digits of fractional precision.
                    $fixedBytes += 5 + (int) ceil(((int) ($definition['DATETIME_PRECISION'] ?? 0)) / 2);
                    break;
                case 'timestamp':
                    $fixedBytes += 4 + (int) ceil(((int) ($definition['DATETIME_PRECISION'] ?? 0)) / 2);
                    break;
                case 'date':
                    $fixedBytes += 3;
                    break;
                case 'time':
                    $fixedBytes += 3 + (int) ceil(((int) ($definition['DATETIME_PRECISION'] ?? 0)) / 2);
                    break;
                case 'decimal':
                    // Four bytes per nine digits, integer part and fraction counted separately.
                    $scale = (int) ($definition['NUMERIC_SCALE'] ?? 0);
                    $whole = max(0, (int) ($definition['NUMERIC_PRECISION'] ?? 0) - $scale);
                    foreach ([$whole, $scale] as $digits) {
                        $fixedBytes += intdiv($digits, 9) * 4;
                        $fixedBytes += [0, 1, 1, 2, 2, 3, 3, 4, 4, 4][$digits % 9];
                    }
                    break;
                case 'tinyint': $fixedBytes += 1; break;
                case 'smallint': $fixedBytes += 2; break;
                case 'mediumint': $fixedBytes += 3; break;
                case 'int': $fixedBytes += 4; break;
                case 'bigint': $fixedBytes += 8; break;
                case 'float': $fixedBytes += 4; break;
                case 'double': $fixedBytes += 8; break;
                default:
                    // An unrecognised type is measured rather than guessed at, and named so the
                    // reader knows the arithmetic did not silently skip a column.
                    $terms[] = 'COALESCE(LENGTH(' . $quoted . '), 0)';
                    break;
            }
        }

        // InnoDB's per-record cost: a 5-byte header, a 6-byte transaction id, a 7-byte roll
        // pointer and the NULL bitmap.
        $recordOverhead = 5 + 6 + 7 + (int) ceil($nullable / 8);

        $variable = 0;
        $rows = 0;
        if ($terms !== []) {
            $statement = $pdo->query(
                'SELECT COUNT(*) AS c, COALESCE(SUM(' . implode(' + ', $terms) . '), 0) AS b '
                . 'FROM `' . str_replace('`', '``', $table) . '`'
            );
            $measured = $statement->fetch() ?: [];
            $rows = (int) ($measured['c'] ?? 0);
            $variable = (int) ($measured['b'] ?? 0);
        }

        $size = $sizeByTable[$table] ?? [];
        $dataBytes = (int) ($size['DATA_LENGTH'] ?? 0);
        $freeBytes = (int) ($size['DATA_FREE'] ?? 0);
        $logicalBytes = $variable + ($rows * ($fixedBytes + $recordOverhead));
        // COUNT(*) is exact where TABLE_ROWS is an estimate, so the exact number is the one
        // the per-row figures are divided by.
        $physicalPerRow = $rows > 0 ? $dataBytes / $rows : 0.0;
        $logicalPerRow = $rows > 0 ? $logicalBytes / $rows : 0.0;
        $rebuiltBytes = $logicalBytes > 0 ? (int) round($logicalBytes / $rebuiltFill) : 0;

        $report[] = [
            'table' => $table,
            'rows' => $rows,
            'dataBytes' => $dataBytes,
            'freeBytes' => $freeBytes,
            'logicalBytes' => $logicalBytes,
            'fixedBytesPerRow' => $fixedBytes,
            'recordOverheadPerRow' => $recordOverhead,
            'logicalBytesPerRow' => round($logicalPerRow, 1),
            'physicalBytesPerRow' => round($physicalPerRow, 1),
            // Above 1.0 means the table is charged for more than it holds. It cannot fall
            // below 1.0 unless the arithmetic above is wrong, which is worth knowing too.
            'overheadRatio' => $logicalBytes > 0 ? round($dataBytes / $logicalBytes, 3) : null,
            'estimatedRebuiltBytes' => $rebuiltBytes,
            // Free extents come back from a rebuild as well, so they are part of the same
            // answer -- but never counted twice: they are already outside DATA_LENGTH.
            'estimatedReclaimBytes' => $rebuiltBytes > 0
                ? max(0, $dataBytes - $rebuiltBytes) + $freeBytes
                : 0,
        ];
    }

    usort($report, static fn (array $left, array $right) => $right['dataBytes'] <=> $left['dataBytes']);
    return [
        'tables' => $report,
        'rebuiltFill' => round($rebuiltFill, 4),
        'totalReclaimBytes' => array_sum(array_column($report, 'estimatedReclaimBytes')),
    ];
}

/**
 * What an observation row is actually made OF, field by field, and what it would weigh if it
 * kept only what anything reads.
 *
 * Read-only: it samples payloads, decodes them in memory and writes nothing.
 *
 * Reported, with the database at 815 MB and still climbing: "velikost databaze je prilis
 * velika a stale dale narusta velkou rychlosti". Already measured and already ruled out:
 * fragmentation (4% free), compression (the payloads are packed, a re-pack saves nothing),
 * and sheer row count (224 000 rows is not millions). What is left is the size of a row --
 * 2.8 kB of it -- and that has never been looked inside.
 *
 * So this opens it. Per top-level field: how many sampled rows carry it and how many bytes
 * it costs across them, ranked. Beside that, the size of the same rows projected onto the
 * fields the statistics actually read -- the entry quote, the settlement, the tags, the
 * dates, the entry book, the volume and the identifiers. The difference between those two
 * numbers is what slimming would return, stated before anything is changed.
 *
 * Sampled from BOTH ends of the key space rather than the first N rows. The first N share a
 * key prefix, which on a hash key means an arbitrary but CORRELATED slice -- and a sample
 * that is accidentally all one market type would answer a different question than the one
 * asked.
 */
function trading_storage_observation_payload_anatomy(PDO $pdo, int $sampleLimit = 200, array $keep = []): array
{
    trading_storage_bootstrap($pdo);
    $sampleLimit = max(10, min(1000, $sampleLimit));
    $half = (int) max(5, floor($sampleLimit / 2));

    // Which fields are READ is decided by the caller, from evidence, not here from memory.
    //
    // The first version of this function carried a hand-written list of "what the statistics
    // read" and labelled everything outside it unread. That produced a headline -- 69% of
    // every row is carried and never consulted, 426 MB recoverable -- which was simply
    // false: riskGroupLabels is rendered in the risk column, marketDataUpdatedAt is the
    // "Scraped" column, scheduledEventDate is where the bot derives the horizon,
    // binaryYesTokenId decides whether a market is binary, and marketId is what blocks a
    // second position in the same live market. Slimming on that list would have broken the
    // dashboard and the bot.
    //
    // So the list now comes from grepping the runtime files, and an empty list means this
    // reports sizes and claims nothing about what is safe to drop.
    $keepSet = array_fill_keys($keep, true);

    $rows = [];
    foreach ([
        'SELECT payload FROM trading_observations WHERE lifecycle = ? ORDER BY updated_at DESC LIMIT ' . $half,
        'SELECT payload FROM trading_observations WHERE lifecycle = ? ORDER BY updated_at ASC LIMIT ' . $half,
    ] as $sql) {
        foreach (['SCRAPED', 'RESOLVED'] as $lifecycle) {
            $statement = $pdo->prepare($sql);
            $statement->execute([$lifecycle]);
            while (($payload = $statement->fetchColumn()) !== false) {
                if (is_string($payload)) {
                    $rows[] = $payload;
                }
            }
        }
    }

    $fields = [];
    $sampled = 0;
    $storedBytes = 0;
    $decodedBytes = 0;
    $keptBytes = 0;
    foreach ($rows as $payload) {
        $storedBytes += strlen($payload);
        $decoded = trading_storage_unpack($payload);
        if (!is_array($decoded)) {
            continue;
        }
        $sampled++;
        $decodedBytes += strlen((string) json_encode($decoded));
        $projection = [];
        foreach ($decoded as $field => $value) {
            // The cost of a field is its key plus its encoded value, which is what removing
            // it would actually return.
            $cost = strlen((string) $field) + 3 + strlen((string) json_encode($value));
            if (!isset($fields[$field])) {
                $fields[$field] = ['rows' => 0, 'bytes' => 0];
            }
            $fields[$field]['rows'] += 1;
            $fields[$field]['bytes'] += $cost;
            if (isset($keepSet[$field])) {
                $projection[$field] = $value;
            }
        }
        $keptBytes += strlen((string) json_encode($projection));
    }

    uasort($fields, static fn (array $left, array $right): int => $right['bytes'] <=> $left['bytes']);
    $ranked = [];
    foreach ($fields as $field => $stats) {
        $ranked[] = [
            'field' => $field,
            'rows' => $stats['rows'],
            'bytes' => $stats['bytes'],
            'bytesPerRow' => $sampled > 0 ? (int) round($stats['bytes'] / $sampled) : 0,
            'read' => isset($keepSet[$field]),
        ];
    }

    return [
        'sampledRows' => $sampled,
        'storedBytes' => $storedBytes,
        'decodedBytes' => $decodedBytes,
        'keptBytes' => $keptBytes,
        'storedBytesPerRow' => $sampled > 0 ? (int) round($storedBytes / $sampled) : 0,
        'keptBytesPerRow' => $sampled > 0 ? (int) round($keptBytes / $sampled) : 0,
        // What the packed row would weigh if it held only the read fields, which is the
        // number the table's size scales with -- the stored column is packed, not raw.
        'keptShare' => $decodedBytes > 0 ? round($keptBytes / $decodedBytes, 4) : null,
        'fields' => $ranked,
        'readFields' => $keep,
        'keepListSupplied' => $keep !== [],
    ];
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

/**
 * Move run-log events older than $days out of MySQL and into a gzipped NDJSON archive.
 *
 * Asked for: keep at most a week of run log in the database, archive the rest so it takes
 * little space, and be able to restore it if it is ever needed.
 *
 * The database is the scarce resource here -- one 2000 MB quota shared with every other
 * application on the hosting -- while a gzipped file on disk is cheap, and this codebase
 * already keeps portfolio run logs that way. So the row is written to the archive FIRST and
 * only deleted once the archive has it: a crash between the two leaves a duplicate in the
 * archive, which the importer upserts away, rather than a hole in the history.
 *
 * Attribution does not depend on these rows any more. Which portfolio placed a trade is
 * stamped onto the trade itself in trading_trades and kept in the executor's own
 * orderOwnership ledger, so archiving the narrative does not take the answer with it.
 */
/**
 * Put an archived month back into the table. The other half of archiving, and the half that
 * makes it archiving rather than deletion: every write is the same idempotent upsert the
 * live ingest uses, so restoring a file twice costs nothing and restoring one whose rows are
 * still present changes nothing.
 */
function trading_storage_restore_events(string $file): array
{
    $root = realpath(__DIR__ . '/data/event-archive');
    $path = $root === false ? false : realpath($root . '/' . $file);
    // Resolved and then checked against the archive root, so a name with .. in it cannot
    // reach a file outside it.
    if ($root === false || $path === false || !str_starts_with($path, $root . '/')) {
        throw new InvalidArgumentException('That archive file is not in the event archive.');
    }
    $handle = gzopen($path, 'rb');
    if ($handle === false) {
        throw new RuntimeException('Could not read the archive ' . basename($path));
    }
    $restored = 0;
    while (($line = gzgets($handle)) !== false) {
        $row = json_decode(trim($line), true);
        if (!is_array($row) || !is_array($row['payload'] ?? null)) {
            continue;
        }
        trading_storage_event_append(
            (string) ($row['stream'] ?? 'state-run-log'),
            isset($row['portfolioId']) && $row['portfolioId'] !== null ? (string) $row['portfolioId'] : null,
            $row['payload'],
            isset($row['occurredAt']) ? (string) $row['occurredAt'] : null,
        );
        $restored++;
    }
    gzclose($handle);
    return ['file' => $file, 'restored' => $restored];
}

/**
 * What is in the archive, so restoring does not require guessing a filename.
 */
function trading_storage_archive_listing(): array
{
    $root = __DIR__ . '/data/event-archive';
    $files = [];
    foreach (glob($root . '/*/*.ndjson.gz') ?: [] as $path) {
        $files[] = [
            'file' => str_replace($root . '/', '', $path),
            'bytes' => filesize($path) ?: 0,
            'modifiedAt' => gmdate('c', filemtime($path) ?: time()),
        ];
    }
    usort($files, static fn (array $left, array $right): int => strcmp($left['file'], $right['file']));
    return $files;
}

/**
 * Restore snapshots moved out of MySQL by the retired observation-retention job.
 *
 * The archive is append-only and may contain duplicate lines after an interrupted old
 * retention pass. INSERT IGNORE therefore restores only missing keys and deliberately
 * leaves any newer row written by the active MySQL importer untouched.
 */
function trading_storage_restore_observation_archives(PDO $pdo, int $limit = 250): array
{
    trading_storage_bootstrap($pdo);
    $limit = max(1, min(500, $limit));
    $root = __DIR__ . '/data/observation-archive';
    $files = glob($root . '/*/*.ndjson.gz') ?: [];
    sort($files, SORT_STRING);
    if ($files === []) {
        return ['scanned' => 0, 'restored' => 0, 'alreadyPresent' => 0, 'done' => true];
    }
    if (trading_storage_meta_get('observation-archive-restored-at') !== null) {
        return ['scanned' => 0, 'restored' => 0, 'alreadyPresent' => 0, 'done' => true];
    }

    $cursor = json_decode((string) (trading_storage_meta_get('observation-archive-restore-cursor') ?? ''), true);
    $fileIndex = is_array($cursor) ? max(0, (int) ($cursor['fileIndex'] ?? 0)) : 0;
    $lineOffset = is_array($cursor) ? max(0, (int) ($cursor['lineOffset'] ?? 0)) : 0;
    if ($fileIndex >= count($files)) {
        return ['scanned' => 0, 'restored' => 0, 'alreadyPresent' => 0, 'done' => true];
    }

    $insert = $pdo->prepare(
        'INSERT IGNORE INTO trading_observations (
           observation_key, lifecycle, source_id, token_id, event_slug, market_slug, outcome_label, market_type,
           end_at, observed_at, resolved_at, market_probability, net_yield, annualized_return, volume_usdc,
           tags_json, payload, payload_checksum, created_at, updated_at
         ) VALUES (
           :key, :lifecycle, :sourceId, :tokenId, :eventSlug, :marketSlug, :outcome, :marketType,
           :endAt, :observedAt, :resolvedAt, :probability, :netYield, :annualizedReturn, :volume,
           :tags, :payload, :checksum, :createdAt, :updatedAt
         )'
    );
    $scanned = $restored = $alreadyPresent = 0;
    $done = true;
    for (; $fileIndex < count($files); $fileIndex++, $lineOffset = 0) {
        $handle = gzopen($files[$fileIndex], 'rb');
        if ($handle === false) {
            throw new RuntimeException('Could not read the observation archive ' . basename($files[$fileIndex]));
        }
        $lineNumber = 0;
        while ($lineNumber < $lineOffset && gzgets($handle) !== false) {
            $lineNumber++;
        }
        while (($line = gzgets($handle)) !== false) {
            $lineNumber++;
            $scanned++;
            $row = json_decode(trim($line), true);
            $payload = is_array($row) && is_array($row['payload'] ?? null) ? $row['payload'] : null;
            $key = is_array($row) ? trim((string) ($row['observationKey'] ?? '')) : '';
            $lifecycle = strtoupper(is_array($row) ? (string) ($row['lifecycle'] ?? '') : '');
            $updatedAt = is_array($row) ? trim((string) ($row['updatedAt'] ?? '')) : '';
            if (is_array($payload) && $key !== '' && in_array($lifecycle, ['SCRAPED', 'RESOLVED'], true)
                && strtotime($updatedAt) !== false) {
                $columns = trading_storage_observation_columns($payload);
                // Archive metadata is the source of truth for the row identity and age.
                $columns['key'] = $key;
                $columns['lifecycle'] = $lifecycle;
                $columns['createdAt'] = $updatedAt;
                $columns['updatedAt'] = $updatedAt;
                $insert->execute($columns);
                if ($insert->rowCount() > 0) {
                    $restored++;
                } else {
                    $alreadyPresent++;
                }
            }
            if ($scanned >= $limit) {
                $done = false;
                break;
            }
        }
        gzclose($handle);
        if (!$done) {
            trading_storage_meta_put('observation-archive-restore-cursor', json_encode([
                'fileIndex' => $fileIndex,
                'lineOffset' => $lineNumber,
            ], JSON_UNESCAPED_SLASHES));
            break;
        }
    }
    if ($done) {
        trading_storage_meta_put('observation-archive-restore-cursor', '');
        trading_storage_meta_put('observation-archive-restored-at', gmdate('c'));
    }
    return compact('scanned', 'restored', 'alreadyPresent', 'done');
}

function trading_storage_archive_events(PDO $pdo, int $days = 7, int $limit = 500): array
{
    trading_storage_bootstrap($pdo);
    $days = max(1, min(365, $days));
    $limit = max(1, min(2000, $limit));
    $cutoff = gmdate('Y-m-d H:i:s', time() - $days * 86400);
    $statement = $pdo->prepare(
        'SELECT event_key, stream, portfolio_id, occurred_at, payload FROM trading_event_log
         WHERE stream IN (:live, :paper) AND occurred_at IS NOT NULL AND occurred_at < :cutoff
         ORDER BY occurred_at ASC LIMIT ' . $limit
    );
    $statement->execute(['live' => 'state-run-log', 'paper' => 'portfolio-run-log', 'cutoff' => $cutoff]);
    $rows = $statement->fetchAll();
    if (!$rows) {
        return ['cutoff' => $cutoff, 'archived' => 0, 'deleted' => 0, 'files' => [], 'done' => true];
    }

    $root = __DIR__ . '/data/event-archive';
    $handles = [];
    $files = [];
    $archived = 0;
    foreach ($rows as $row) {
        $decoded = trading_storage_unpack($row['payload']);
        if (!is_array($decoded)) {
            // Unreadable payloads are not archived and not deleted either: losing a row we
            // could not read is the one outcome worse than keeping it.
            continue;
        }
        $stream = preg_replace('/[^a-z0-9_-]/', '', (string) $row['stream']);
        $month = substr((string) $row['occurred_at'], 0, 7);
        $name = $root . '/' . $stream . '/' . $month . '.ndjson.gz';
        if (!isset($handles[$name])) {
            if (!is_dir(dirname($name))) {
                mkdir(dirname($name), 0775, true);
            }
            $handle = gzopen($name, 'ab9');
            if ($handle === false) {
                throw new RuntimeException('Could not open the event archive ' . basename($name));
            }
            $handles[$name] = $handle;
            $files[] = str_replace($root . '/', '', $name);
        }
        // The portfolio and the occurred_at travel with the payload, because the archive has
        // to be restorable on its own -- the table columns are not in the JSON otherwise.
        $line = json_encode([
            'stream' => $row['stream'],
            'portfolioId' => $row['portfolio_id'],
            'occurredAt' => $row['occurred_at'],
            'payload' => $decoded,
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($line)) {
            continue;
        }
        gzwrite($handles[$name], $line . "\n");
        $archived++;
    }
    foreach ($handles as $handle) {
        gzclose($handle);
    }

    // Deleted only after every archive file is closed, so the bytes are on disk before the
    // rows leave the table.
    $deleted = 0;
    if ($archived > 0) {
        $keys = array_column($rows, 'event_key');
        $placeholders = implode(',', array_fill(0, count($keys), '?'));
        $delete = $pdo->prepare('DELETE FROM trading_event_log WHERE event_key IN (' . $placeholders . ')');
        $delete->execute($keys);
        $deleted = $delete->rowCount();
    }
    return [
        'cutoff' => $cutoff,
        'archived' => $archived,
        'deleted' => $deleted,
        'files' => array_values(array_unique($files)),
        'done' => count($rows) < $limit,
    ];
}

function trading_storage_rebuild_compacted_table(PDO $pdo, string $table): array
{
    trading_storage_bootstrap($pdo);
    // Rebuilding is not payload compaction and must not borrow its whitelist: every Trading
    // table can be repacked, only three of them have a payload column to rewrite. It stays a
    // whitelist, because the name is interpolated into DDL.
    if (!in_array($table, [
        'trading_observations',
        'trading_event_log',
        'trading_trades',
        'trading_documents',
        'trading_storage_meta',
    ], true)) {
        throw new InvalidArgumentException('Unknown Trading storage table.');
    }
    // OPTIMIZE TABLE on InnoDB is ALTER TABLE ... FORCE: the B-tree is built again from the
    // rows, so pages come back at their fill factor instead of wherever months of inserts and
    // updates left them. It needs room for a second copy while it runs, and if it is cut short
    // InnoDB rolls it back and the original table stands -- the work is lost, the data is not.
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

/**
 * Serve THIS request from the database without switching anything on for anyone else.
 *
 * The cutover cannot be talked into being safe; it has to be measured, and until now the
 * only way to measure the database read path on real data was to flip the switch for every
 * visitor at once. That is the wrong order: the last attempt at serving reads from here
 * collapsed the host on the catalogue decode, and "flip it and watch" means the watching
 * happens on the user's dashboard.
 *
 * So one request at a time can be told to read from the database, and nothing about the
 * stored state changes. The caller must hold the trigger key and the request must be a GET,
 * which is what keeps it a measurement: every write path that consults this function is
 * reached only by a POST, so a preview can read the database but can never make it the
 * target of a write.
 */
function trading_storage_preview_reads(bool $enable): void
{
    $GLOBALS['trading_storage_preview_reads'] = $enable;
}

function trading_storage_is_active(): bool
{
    if (($GLOBALS['trading_storage_preview_reads'] ?? false) === true) {
        return true;
    }
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

/**
 * How much of the event log each stream is actually using.
 *
 * The table grew 117 MB in fifteen minutes and the per-table figure could not say which
 * stream did it, so the retention rules were being aimed by guesswork. Rows AND bytes,
 * because a stream can be large either by having many rows or by having fat ones, and the
 * fix is different in each case: more aggressive archiving for the first, a slimmer payload
 * for the second.
 */
function trading_storage_event_stream_stats(): array
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        return [];
    }
    trading_storage_bootstrap($pdo);
    $statement = $pdo->query(
        'SELECT stream,
                COUNT(*) AS rows_total,
                SUM(LENGTH(payload)) AS bytes_total,
                MAX(LENGTH(payload)) AS bytes_max,
                MIN(occurred_at) AS oldest,
                MAX(occurred_at) AS newest
         FROM trading_event_log
         GROUP BY stream
         ORDER BY bytes_total DESC'
    );
    $stats = [];
    foreach ($statement->fetchAll() as $row) {
        $stats[] = [
            'stream' => (string) ($row['stream'] ?? ''),
            'rows' => (int) ($row['rows_total'] ?? 0),
            'bytes' => (int) ($row['bytes_total'] ?? 0),
            'largestRowBytes' => (int) ($row['bytes_max'] ?? 0),
            'oldest' => $row['oldest'] ?? null,
            'newest' => $row['newest'] ?? null,
        ];
    }
    return $stats;
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

/**
 * When this market settles, read from the same two fields the horizon rule reads.
 *
 * end_at used to be filled from endDate, and endDate is not the settlement date: for a
 * sports fixture the scanner substitutes the kickoff into it, and for a market with a long
 * window it can sit days past the resolution the rule actually weighs. So a horizon clause
 * built on that column disagreed with observation_hours_to_resolution() -- the rule kept a
 * market, the clause dropped it, and the portfolio simply saw fewer candidates.
 *
 * The rule reads resolutionEndDate, and failing that the frozen daysToResolution. This
 * anchors that day count to the scan rather than to the read, which can only make the stored
 * moment EARLIER than the rule's, and earlier is the safe direction under an upper bound.
 * When the rule can answer with neither, the column is NULL -- NULL is admitted, which is
 * exactly what a rule that cannot apply its horizon does.
 */
function trading_storage_resolution_datetime(array $item): ?string
{
    $resolution = trading_storage_datetime($item['resolutionEndDate'] ?? null);
    if ($resolution !== null) {
        return $resolution;
    }
    $days = $item['daysToResolution'] ?? null;
    if (is_numeric($days)) {
        return gmdate('Y-m-d H:i:s', time() + (int) round(((float) $days) * 86400));
    }
    return null;
}

/**
 * One observation as the columns the table stores it in.
 *
 * Extracted from the upsert so it can be executed on its own. These columns are the only
 * thing a narrowed query can ask about -- the rules themselves live inside the payload --
 * so whether a bound is safe depends entirely on whether the column means the same thing
 * the rule means. That is a question a test can answer only if it can call this.
 */
function trading_storage_observation_columns(array $item): array
{
    $payload = trading_storage_encode($item);
    $tags = $item['polymarketTags'] ?? $item['tags'] ?? $item['firstTags'] ?? [];
    return [
        'key' => trading_storage_observation_key($item),
        'lifecycle' => trading_storage_lifecycle($item),
        'sourceId' => isset($item['id']) ? (string) $item['id'] : null,
        'tokenId' => isset($item['tokenId']) ? (string) $item['tokenId'] : (isset($item['firstTokenId']) ? (string) $item['firstTokenId'] : null),
        'eventSlug' => isset($item['eventSlug']) ? (string) $item['eventSlug'] : null,
        'marketSlug' => isset($item['slug']) ? (string) $item['slug'] : null,
        'outcome' => isset($item['outcome']) ? (string) $item['outcome'] : (isset($item['firstOutcome']) ? (string) $item['firstOutcome'] : null),
        'marketType' => isset($item['marketType']) ? (string) $item['marketType'] : null,
        'endAt' => trading_storage_resolution_datetime($item),
        'observedAt' => trading_storage_datetime($item['observedAt'] ?? $item['firstObservedAt'] ?? null),
        'resolvedAt' => trading_storage_datetime($item['resolvedAt'] ?? $item['updatedAt'] ?? null),
        'probability' => trading_storage_number($item, ['marketProbability', 'firstMarketProbability']),
        'netYield' => trading_storage_number($item, ['netYield']),
        'annualizedReturn' => trading_storage_number($item, ['marketAnnualizedReturn', 'potentialAnnualizedReturn', 'annualizedReturn']),
        // Read in the order the liquidity RULE reads it, not in a richer order of its own.
        // resolvedVolumeUsdc used to come first, so a market carrying both stored its
        // resolved volume while execution_scope_matches_observation() weighed volumeUsdc --
        // and a floor of 30000 then excluded rows that pass the floor.
        'volume' => trading_storage_number($item, ['volumeUsdc', 'liquidity', 'resolvedVolumeUsdc', 'volume']),
        'tags' => trading_storage_encode(is_array($tags) ? $tags : [$tags]),
        'payload' => trading_storage_pack_encoded($payload),
        'checksum' => hash('sha256', $payload),
        'createdAt' => trading_storage_now(),
        'updatedAt' => trading_storage_now(),
    ];
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
           lifecycle = IF(payload_checksum = VALUES(payload_checksum), lifecycle, VALUES(lifecycle)),
           source_id = IF(payload_checksum = VALUES(payload_checksum), source_id, VALUES(source_id)),
           token_id = IF(payload_checksum = VALUES(payload_checksum), token_id, VALUES(token_id)),
           event_slug = IF(payload_checksum = VALUES(payload_checksum), event_slug, VALUES(event_slug)),
           market_slug = IF(payload_checksum = VALUES(payload_checksum), market_slug, VALUES(market_slug)),
           outcome_label = IF(payload_checksum = VALUES(payload_checksum), outcome_label, VALUES(outcome_label)),
           market_type = IF(payload_checksum = VALUES(payload_checksum), market_type, VALUES(market_type)),
           end_at = IF(payload_checksum = VALUES(payload_checksum), end_at, VALUES(end_at)),
           observed_at = IF(payload_checksum = VALUES(payload_checksum), observed_at, VALUES(observed_at)),
           resolved_at = IF(payload_checksum = VALUES(payload_checksum), resolved_at, VALUES(resolved_at)),
           market_probability = IF(payload_checksum = VALUES(payload_checksum), market_probability, VALUES(market_probability)),
           net_yield = IF(payload_checksum = VALUES(payload_checksum), net_yield, VALUES(net_yield)),
           annualized_return = IF(payload_checksum = VALUES(payload_checksum), annualized_return, VALUES(annualized_return)),
           volume_usdc = IF(payload_checksum = VALUES(payload_checksum), volume_usdc, VALUES(volume_usdc)),
           tags_json = IF(payload_checksum = VALUES(payload_checksum), tags_json, VALUES(tags_json)),
           payload = IF(payload_checksum = VALUES(payload_checksum), payload, VALUES(payload)),
           updated_at = IF(payload_checksum = VALUES(payload_checksum), updated_at, VALUES(updated_at)),
           payload_checksum = IF(payload_checksum = VALUES(payload_checksum), payload_checksum, VALUES(payload_checksum))'
    );
    $count = 0;
    $pdo->beginTransaction();
    try {
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }
            $statement->execute(trading_storage_observation_columns($item));
            $count += 1;
        }
        $pdo->commit();
    } catch (Throwable $error) {
        $pdo->rollBack();
        throw $error;
    }
    return $count;
}

/**
 * How old the stored observations are, per lifecycle.
 *
 * The published catalogue is a window -- 8135 active markets -- while the database holds
 * everything it has ever been sent, 23003. That gap is the history the migration exists to
 * keep, not a fault, and deleting it was the wrong answer.
 *
 * What it does raise is a freshness question. A row whose LAST snapshot said "active,
 * accepting orders" goes on saying so however long ago that snapshot was taken, and the
 * paper bots pick candidates from the same list the dashboard renders. So this reports the
 * distribution rather than one count, because the answer decides something real: if nearly
 * every active row was seen in the last day, serving the whole set costs nothing; if most
 * are weeks old, the candidate list needs an age bound and the row needs to say its age.
 */
function trading_storage_observation_freshness(): array
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        return [];
    }
    trading_storage_bootstrap($pdo);
    $statement = $pdo->query(
        'SELECT lifecycle,
                COUNT(*) AS rows_total,
                SUM(updated_at >= NOW() - INTERVAL 1 DAY) AS within_1d,
                SUM(updated_at >= NOW() - INTERVAL 7 DAY) AS within_7d,
                SUM(updated_at >= NOW() - INTERVAL 30 DAY) AS within_30d,
                MIN(updated_at) AS oldest,
                MAX(updated_at) AS newest
         FROM trading_observations
         GROUP BY lifecycle
         ORDER BY rows_total DESC'
    );
    $stats = [];
    foreach ($statement->fetchAll() as $row) {
        $stats[] = [
            'lifecycle' => (string) ($row['lifecycle'] ?? ''),
            'rows' => (int) ($row['rows_total'] ?? 0),
            'within1Day' => (int) ($row['within_1d'] ?? 0),
            'within7Days' => (int) ($row['within_7d'] ?? 0),
            'within30Days' => (int) ($row['within_30d'] ?? 0),
            'oldest' => $row['oldest'] ?? null,
            'newest' => $row['newest'] ?? null,
        ];
    }
    return $stats;
}

/**
 * The markets one portfolio could trade, narrowed by the database rather than by PHP.
 *
 * The catalogue used to be shipped whole and filtered afterwards: every portfolio pass
 * decoded 8000 payloads to keep a few dozen. That is why the JSON file needs a retention cap
 * at all -- one file has to stay small enough to send -- and it is why serving reads from
 * MySQL collapsed the host, because the same whole-catalogue read simply moved.
 *
 * Asked in the shape a portfolio is actually described in: a probability band, a resolution
 * horizon, a liquidity floor. Those three are columns and the index covers them, so the
 * database returns the candidates instead of the catalogue. The rules that live inside the
 * payload -- the spread, the market shape, whether a fixture has kicked off -- still run in
 * PHP afterwards, but on the handful of rows that survived rather than on all of them.
 *
 * Every bound is optional: a portfolio that does not set one gets no clause for it.
 */
/**
 * The bounds of a scoped read, declared once: the SQL clause and the same test in PHP.
 *
 * The contract this table exists to keep is that the query returns a SUPERSET of what
 * execution_scope_matches_observation() keeps. A clause that is a hair too tight hides
 * markets a portfolio would have traded and nothing downstream can tell -- no error, no
 * empty page, just fewer candidates. So the clause cannot be checked by reading it.
 *
 * Writing the WHERE here and a copy of it in a test would only move the problem: the copy
 * is what gets checked and the query is what runs. Instead each bound carries both forms,
 * the query is built from `sql`, and the test drives `admits` over the very columns
 * trading_storage_observation_columns() would store. One declaration, both readers.
 */
function trading_storage_scope_clauses(): array
{
    $numeric = static fn ($value): bool => is_numeric($value);
    return [
        'minProbability' => [
            'sql' => 'market_probability >= :minProbability',
            'param' => 'minProbability',
            'applies' => $numeric,
            'bind' => static fn ($value): float => (float) $value,
            'admits' => static function (array $columns, $value): bool {
                $stored = $columns['probability'] ?? null;
                return $stored === null ? false : (float) $stored >= (float) $value;
            },
        ],
        'maxProbability' => [
            'sql' => 'market_probability <= :maxProbability',
            'param' => 'maxProbability',
            'applies' => $numeric,
            'bind' => static fn ($value): float => (float) $value,
            'admits' => static function (array $columns, $value): bool {
                $stored = $columns['probability'] ?? null;
                return $stored === null ? false : (float) $stored <= (float) $value;
            },
        ],
        // A row with no end date is KEPT rather than excluded: a market whose resolution time
        // is unknown is not the same as one that resolves too late, and the payload rules
        // decide it properly. Excluding it here would hide it with no way to see that it had.
        'endBefore' => [
            'sql' => '(end_at IS NULL OR end_at <= :endBefore)',
            'param' => 'endBefore',
            'applies' => static fn ($value): bool => is_string($value) && $value !== '',
            'bind' => static fn ($value): string => (string) $value,
            'admits' => static function (array $columns, $value): bool {
                $stored = $columns['endAt'] ?? null;
                return $stored === null ? true : (string) $stored <= (string) $value;
            },
        ],
        'minLiquidityUsdc' => [
            'sql' => '(volume_usdc IS NULL OR volume_usdc >= :minLiquidity)',
            'param' => 'minLiquidity',
            'applies' => $numeric,
            'bind' => static fn ($value): float => (float) $value,
            'admits' => static function (array $columns, $value): bool {
                $stored = $columns['volume'] ?? null;
                return $stored === null ? true : (float) $stored >= (float) $value;
            },
        ],
    ];
}

/**
 * Would the scoped query return this row? Answered on the stored columns alone.
 *
 * The other half of the contract, for tests and for the probe: given the columns a row is
 * written with and the criteria a portfolio compiles to, does every bound admit it. Nothing
 * here consults the payload, because the query cannot either.
 */
function trading_storage_scope_admits(array $columns, array $criteria): bool
{
    foreach (trading_storage_scope_clauses() as $name => $clause) {
        $value = $criteria[$name] ?? null;
        if (!$clause['applies']($value)) {
            continue;
        }
        if (!$clause['admits']($columns, $value)) {
            return false;
        }
    }
    return true;
}

/**
 * The stored columns for named rows, so a miss can be explained instead of guessed at.
 *
 * When the scoped query drops a market the rules keep, the useful question is which bound
 * did it -- the freshness window, the band, the horizon, the floor -- or whether the row
 * reached the database at all. Guessing that from outside is how three wrong fixes for the
 * certainty close got shipped, so this returns the values themselves.
 *
 * Looked up by primary key and capped: the ids come from a probe's own missed list, and
 * token_id carries no index, so a lookup on it would scan the whole table.
 */
function trading_storage_observation_scope_diagnostics(array $observationKeys): array
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        return [];
    }
    $keys = array_values(array_unique(array_filter(
        array_map(static fn ($value): string => (string) $value, $observationKeys),
        static fn (string $value): bool => $value !== '',
    )));
    if ($keys === []) {
        return [];
    }
    $keys = array_slice($keys, 0, 40);
    trading_storage_bootstrap($pdo);
    $statement = $pdo->prepare(
        'SELECT observation_key, lifecycle, market_probability, end_at, volume_usdc,'
        . ' TIMESTAMPDIFF(MINUTE, updated_at, NOW(6)) AS age_minutes'
        . ' FROM trading_observations WHERE observation_key IN ('
        . implode(',', array_fill(0, count($keys), '?')) . ')'
    );
    $statement->execute($keys);
    $rows = [];
    foreach ($statement->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $rows[(string) ($row['observation_key'] ?? '')] = [
            'lifecycle' => (string) ($row['lifecycle'] ?? ''),
            'probability' => $row['market_probability'] === null ? null : (float) $row['market_probability'],
            'endAt' => $row['end_at'] ?? null,
            'volume' => $row['volume_usdc'] === null ? null : (float) $row['volume_usdc'],
            'ageMinutes' => $row['age_minutes'] === null ? null : (int) $row['age_minutes'],
        ];
    }
    return $rows;
}

function trading_storage_observations_for_scope(array $criteria, int $limit = 400, bool $freshOnly = true, int $offset = 0): array
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        return [];
    }
    trading_storage_bootstrap($pdo);
    $where = ['lifecycle = :lifecycle'];
    $params = ['lifecycle' => 'SCRAPED'];
    if ($freshOnly) {
        $where[] = 'updated_at >= :freshSince';
        $params['freshSince'] = trading_storage_catalogue_fresh_since();
    }
    foreach (trading_storage_scope_clauses() as $name => $clause) {
        if (!$clause['applies']($criteria[$name] ?? null)) {
            continue;
        }
        $where[] = $clause['sql'];
        $params[$clause['param']] = $clause['bind']($criteria[$name]);
    }
    // Ordered the way the executor ranks: the best return first, then the nearer resolution.
    // Taking the page BEFORE the ranking is what once served the executor an arbitrary slice
    // of storage order, so the order belongs in the query, not after it.
    // The tie-break is what makes the order TOTAL, and paging needs that: annualized_return
    // has thousands of ties -- every market with no return recorded shares NULL -- and the
    // database is free to order tied rows differently on each page. A walk over a
    // non-total order silently repeats some rows and misses others.
    $sql = 'SELECT payload FROM trading_observations WHERE ' . implode(' AND ', $where)
        . ' ORDER BY annualized_return DESC, end_at ASC, observation_key ASC'
        . ' LIMIT ' . max(1, min(5000, $limit))
        // OFFSET is only legal after LIMIT, so an offset alone would quietly serve the
        // scope again from row zero -- a walk that never advances.
        . ($offset > 0 ? ' OFFSET ' . max(0, $offset) : '');
    $statement = $pdo->prepare($sql);
    $statement->execute($params);
    $rows = [];
    while (($payload = $statement->fetchColumn()) !== false) {
        $decoded = trading_storage_unpack($payload);
        if (is_array($decoded)) {
            $rows[] = $decoded;
        }
    }
    return $rows;
}

function trading_storage_observations_fetch(string $lifecycle, int $limit = 0, int $offset = 0, bool $freshOnly = false): array
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        return [];
    }
    trading_storage_bootstrap($pdo);
    // The tie-break is what makes the order total, and paging needs it: updated_at alone has
    // thousands of ties on this table -- one scan writes a whole page inside a single
    // transaction -- and the database is free to return tied rows in a different order for
    // each page. A walk over a non-total order silently misses and repeats rows.
    //
    // It was written as `id`, and this table has no id column: its key is observation_key.
    // So every call threw "Unknown column 'id' in 'ORDER BY'" -- on the main read path, the
    // one the cutover switches the dashboard and the bots onto. Nothing noticed because
    // nothing calls it while reads come from JSON. Found by timing the read against the
    // database before switching rather than after.
    //
    // freshOnly is what the CURRENT catalogue means once the database is serving. Nothing is
    // deleted -- the history stays and the archive views read all of it -- but a market last
    // seen eleven days ago is not part of the catalogue the bots choose candidates from.
    $sql = 'SELECT payload FROM trading_observations WHERE lifecycle = :lifecycle'
        . ($freshOnly ? ' AND updated_at >= :freshSince' : '')
        . ' ORDER BY updated_at DESC, observation_key DESC';
    if ($limit > 0) {
        $sql .= ' LIMIT ' . min(100000, $limit);
        // OFFSET is only legal after LIMIT, so an offset on its own would quietly serve
        // the whole table from row zero -- the failure this paging exists to avoid.
        if ($offset > 0) {
            $sql .= ' OFFSET ' . max(0, $offset);
        }
    }
    $statement = $pdo->prepare($sql);
    $bindings = ['lifecycle' => $lifecycle];
    if ($freshOnly) {
        $bindings['freshSince'] = trading_storage_catalogue_fresh_since();
    }
    $statement->execute($bindings);
    $rows = [];
    while (($payload = $statement->fetchColumn()) !== false) {
        $decoded = trading_storage_unpack($payload);
        if (is_array($decoded)) {
            $rows[] = $decoded;
        }
    }
    return $rows;
}

/**
 * How long an observation counts as part of the CURRENT catalogue.
 *
 * The database keeps every market it has been sent -- that history is the point of it. The
 * views are a different question: a row whose last snapshot said "active, accepting orders"
 * goes on saying so however old that snapshot is, and the paper bots pick their candidates
 * from the same list the dashboard renders. While the JSON files served those views the
 * bound was implicit, because the published catalogue is itself a window.
 *
 * Measured on 23124 stored active markets: 11442 were refreshed within a day, the same 11442
 * within seven days, and the remaining 11682 were last seen between seven and eleven days
 * ago. Nothing at all falls between one day and seven, so any cutoff inside that gap
 * separates the live catalogue from the historical one with days of margin either side.
 * Three days sits in the middle of it.
 */
function trading_storage_catalogue_fresh_minutes(): int
{
    $configured = (int) (getenv('TRADING_CATALOGUE_FRESH_MINUTES') ?: 0);
    if ($configured > 0) {
        // Never tighter than a day: the scanner covers different tag slices on different
        // passes, and a bound shorter than its own cycle would hide live markets.
        return max(1440, min(525600, $configured));
    }
    return 4320;
}

function trading_storage_observation_counts(): array
{
    $pdo = trading_storage_pdo();
    if (!$pdo instanceof PDO) {
        return ['SCRAPED' => 0, 'RESOLVED' => 0, 'SCRAPED_FRESH' => 0, 'RESOLVED_FRESH' => 0];
    }
    trading_storage_bootstrap($pdo);
    // Both numbers from one pass. The stored total is what was mined and is what the archive
    // views report; the fresh count is the current catalogue and has to match what the active
    // views actually serve, or the browser walks towards a total it can never reach and keeps
    // asking for pages that come back empty.
    $rows = $pdo->query(
        'SELECT lifecycle, COUNT(*) AS total,
                SUM(updated_at >= (NOW(6) - INTERVAL ' . trading_storage_catalogue_fresh_minutes() . ' MINUTE)) AS fresh
         FROM trading_observations GROUP BY lifecycle'
    )->fetchAll();
    $counts = ['SCRAPED' => 0, 'RESOLVED' => 0, 'SCRAPED_FRESH' => 0, 'RESOLVED_FRESH' => 0];
    foreach ($rows as $row) {
        $lifecycle = strtoupper((string) ($row['lifecycle'] ?? ''));
        if (array_key_exists($lifecycle, $counts)) {
            $counts[$lifecycle] = (int) ($row['total'] ?? 0);
            $counts[$lifecycle . '_FRESH'] = (int) ($row['fresh'] ?? 0);
        }
    }
    return $counts;
}
