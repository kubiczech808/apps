<?php

final class Database
{
    private PDO $pdo;

    public function __construct(string $path)
    {
        $dir = dirname($path);
        if (!is_dir($dir)) {
            mkdir($dir, 0775, true);
        }

        $this->pdo = new PDO('sqlite:' . $path);
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->migrate();
    }

    public function pdo(): PDO
    {
        return $this->pdo;
    }

    private function migrate(): void
    {
        $this->pdo->exec("
            CREATE TABLE IF NOT EXISTS contact_lists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS recipients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                list_id INTEGER NOT NULL DEFAULT 1,
                email TEXT NOT NULL UNIQUE,
                subject_name TEXT DEFAULT '',
                website TEXT DEFAULT '',
                name TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS import_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                list_id INTEGER NOT NULL,
                list_name TEXT NOT NULL,
                file_name TEXT DEFAULT '',
                inserted_count INTEGER NOT NULL DEFAULT 0,
                updated_count INTEGER NOT NULL DEFAULT 0,
                skipped_count INTEGER NOT NULL DEFAULT 0,
                total_rows INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS campaigns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                list_id INTEGER NOT NULL DEFAULT 1,
                name TEXT NOT NULL,
                subject TEXT NOT NULL,
                body_html TEXT NOT NULL,
                daily_limit INTEGER NOT NULL DEFAULT 100,
                batch_limit INTEGER NOT NULL DEFAULT 10,
                auto_daily_limit INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'draft',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS send_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_id INTEGER NOT NULL,
                recipient_id INTEGER,
                email TEXT NOT NULL,
                tracking_token TEXT DEFAULT '',
                status TEXT NOT NULL,
                message TEXT DEFAULT '',
                sent_at TEXT NOT NULL,
                opened_at TEXT DEFAULT '',
                clicked_at TEXT DEFAULT '',
                click_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS tracking_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                send_log_id INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                target_url TEXT DEFAULT '',
                user_agent TEXT DEFAULT '',
                ip_hash TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        ");
        $this->pdo->exec("INSERT OR IGNORE INTO contact_lists (id, name, created_at) VALUES (1, 'Vychozi seznam', '" . date('c') . "')");
        $this->ensureColumn('recipients', 'list_id', 'INTEGER NOT NULL DEFAULT 1');
        $this->ensureColumn('recipients', 'subject_name', "TEXT DEFAULT ''");
        $this->ensureColumn('recipients', 'website', "TEXT DEFAULT ''");
        $this->ensureColumn('campaigns', 'list_id', 'INTEGER NOT NULL DEFAULT 1');
        $this->ensureColumn('campaigns', 'batch_limit', 'INTEGER NOT NULL DEFAULT 10');
        $this->ensureColumn('campaigns', 'auto_daily_limit', 'INTEGER NOT NULL DEFAULT 1');
        $this->ensureColumn('send_logs', 'tracking_token', "TEXT DEFAULT ''");
        $this->ensureColumn('send_logs', 'opened_at', "TEXT DEFAULT ''");
        $this->ensureColumn('send_logs', 'clicked_at', "TEXT DEFAULT ''");
        $this->ensureColumn('send_logs', 'click_count', 'INTEGER NOT NULL DEFAULT 0');
    }

    private function ensureColumn(string $table, string $column, string $definition): void
    {
        $columns = $this->pdo->query('PRAGMA table_info(' . $table . ')')->fetchAll(PDO::FETCH_ASSOC);
        foreach ($columns as $existing) {
            if ($existing['name'] === $column) {
                return;
            }
        }
        $this->pdo->exec('ALTER TABLE ' . $table . ' ADD COLUMN ' . $column . ' ' . $definition);
    }
}
