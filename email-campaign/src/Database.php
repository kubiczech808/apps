<?php

final class Database
{
    private PDO $pdo;
    private string $driver;

    public function __construct($database)
    {
        if (is_array($database)) {
            $this->driver = $database['driver'] ?? 'sqlite';
        } else {
            $this->driver = 'sqlite';
            $database = ['path' => (string)$database];
        }

        if ($this->driver === 'mysql') {
            $host = $database['host'] ?? 'localhost';
            $port = (int)($database['port'] ?? 3306);
            $name = $database['name'] ?? '';
            $charset = $database['charset'] ?? 'utf8mb4';
            $dsn = "mysql:host=$host;port=$port;dbname=$name;charset=$charset";
            $this->pdo = new PDO($dsn, $database['username'] ?? '', $database['password'] ?? '');
        } else {
            $path = $database['path'] ?? __DIR__ . '/../storage/app.sqlite';
            $dir = dirname($path);
            if (!is_dir($dir)) {
                mkdir($dir, 0775, true);
            }
            $this->pdo = new PDO('sqlite:' . $path);
        }

        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->migrate();
    }

    public function pdo(): PDO
    {
        return $this->pdo;
    }

    public function driver(): string
    {
        return $this->driver;
    }

    private function migrate(): void
    {
        if ($this->driver === 'mysql') {
            $this->migrateMysql();
        } else {
            $this->migrateSqlite();
        }
        $this->seedDefaultList();
        $this->ensureColumn('recipients', 'list_id', 'INTEGER NOT NULL DEFAULT 1');
        $this->ensureColumn('recipients', 'subject_name', $this->textColumn("''"));
        $this->ensureColumn('recipients', 'website', $this->textColumn("''"));
        $this->ensureColumn('recipients', 'address', $this->textColumn("''"));
        $this->ensureColumn('campaigns', 'list_id', 'INTEGER NOT NULL DEFAULT 1');
        $this->ensureColumn('campaigns', 'batch_limit', 'INTEGER NOT NULL DEFAULT 10');
        $this->ensureColumn('campaigns', 'auto_daily_limit', 'INTEGER NOT NULL DEFAULT 1');
        $this->ensureColumn('send_logs', 'tracking_token', $this->textColumn("''"));
        $this->ensureColumn('send_logs', 'opened_at', $this->textColumn("''"));
        $this->ensureColumn('send_logs', 'clicked_at', $this->textColumn("''"));
        $this->ensureColumn('send_logs', 'click_count', 'INTEGER NOT NULL DEFAULT 0');
    }

    private function migrateSqlite(): void
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
                address TEXT DEFAULT '',
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
    }

    private function migrateMysql(): void
    {
        $statements = [
            "CREATE TABLE IF NOT EXISTS contact_lists (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                created_at VARCHAR(40) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS recipients (
                id INT AUTO_INCREMENT PRIMARY KEY,
                list_id INT NOT NULL DEFAULT 1,
                email VARCHAR(320) NOT NULL UNIQUE,
                subject_name VARCHAR(255) NOT NULL DEFAULT '',
                website VARCHAR(500) NOT NULL DEFAULT '',
                address VARCHAR(500) NOT NULL DEFAULT '',
                name VARCHAR(255) NOT NULL DEFAULT '',
                status VARCHAR(40) NOT NULL DEFAULT 'active',
                created_at VARCHAR(40) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS import_runs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                list_id INT NOT NULL,
                list_name VARCHAR(255) NOT NULL,
                file_name VARCHAR(255) NOT NULL DEFAULT '',
                inserted_count INT NOT NULL DEFAULT 0,
                updated_count INT NOT NULL DEFAULT 0,
                skipped_count INT NOT NULL DEFAULT 0,
                total_rows INT NOT NULL DEFAULT 0,
                created_at VARCHAR(40) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS campaigns (
                id INT AUTO_INCREMENT PRIMARY KEY,
                list_id INT NOT NULL DEFAULT 1,
                name VARCHAR(255) NOT NULL,
                subject VARCHAR(255) NOT NULL,
                body_html MEDIUMTEXT NOT NULL,
                daily_limit INT NOT NULL DEFAULT 100,
                batch_limit INT NOT NULL DEFAULT 10,
                auto_daily_limit INT NOT NULL DEFAULT 1,
                status VARCHAR(40) NOT NULL DEFAULT 'draft',
                created_at VARCHAR(40) NOT NULL,
                updated_at VARCHAR(40) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS send_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                campaign_id INT NOT NULL,
                recipient_id INT NULL,
                email VARCHAR(320) NOT NULL,
                tracking_token VARCHAR(80) NOT NULL DEFAULT '',
                status VARCHAR(40) NOT NULL,
                message VARCHAR(500) NOT NULL DEFAULT '',
                sent_at VARCHAR(40) NOT NULL,
                opened_at VARCHAR(40) NOT NULL DEFAULT '',
                clicked_at VARCHAR(40) NOT NULL DEFAULT '',
                click_count INT NOT NULL DEFAULT 0
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS tracking_events (
                id INT AUTO_INCREMENT PRIMARY KEY,
                send_log_id INT NOT NULL,
                event_type VARCHAR(40) NOT NULL,
                target_url VARCHAR(1000) NOT NULL DEFAULT '',
                user_agent VARCHAR(500) NOT NULL DEFAULT '',
                ip_hash VARCHAR(80) NOT NULL DEFAULT '',
                created_at VARCHAR(40) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS settings (
                setting_key VARCHAR(191) PRIMARY KEY,
                value TEXT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        ];
        foreach ($statements as $statement) {
            $this->pdo->exec($statement);
        }
    }

    private function seedDefaultList(): void
    {
        $stmt = $this->pdo->prepare('SELECT id FROM contact_lists WHERE id=?');
        $stmt->execute([1]);
        if ($stmt->fetchColumn()) {
            return;
        }
        $insert = $this->pdo->prepare('INSERT INTO contact_lists (id, name, created_at) VALUES (?, ?, ?)');
        $insert->execute([1, 'Vychozi seznam', date('c')]);
    }

    private function textColumn(string $default): string
    {
        return $this->driver === 'mysql'
            ? "VARCHAR(500) NOT NULL DEFAULT $default"
            : "TEXT DEFAULT $default";
    }

    private function ensureColumn(string $table, string $column, string $definition): void
    {
        if ($this->driver === 'mysql') {
            $stmt = $this->pdo->prepare('SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?');
            $stmt->execute([$table, $column]);
            if ((int)$stmt->fetchColumn() > 0) {
                return;
            }
        } else {
            $columns = $this->pdo->query('PRAGMA table_info(' . $table . ')')->fetchAll(PDO::FETCH_ASSOC);
            foreach ($columns as $existing) {
                if ($existing['name'] === $column) {
                    return;
                }
            }
        }
        $this->pdo->exec('ALTER TABLE ' . $table . ' ADD COLUMN ' . $column . ' ' . $definition);
    }
}
