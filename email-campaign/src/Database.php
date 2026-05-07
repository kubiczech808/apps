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
            CREATE TABLE IF NOT EXISTS recipients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                name TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS campaigns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
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
                status TEXT NOT NULL,
                message TEXT DEFAULT '',
                sent_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        ");
        $this->ensureColumn('campaigns', 'batch_limit', 'INTEGER NOT NULL DEFAULT 10');
        $this->ensureColumn('campaigns', 'auto_daily_limit', 'INTEGER NOT NULL DEFAULT 1');
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
