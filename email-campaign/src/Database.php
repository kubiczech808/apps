<?php

final class Database
{
    private PDO $pdo;
    private string $driver;

    public function __construct($database, bool $runMigrations = true)
    {
        if (!is_array($database) || ($database['driver'] ?? '') !== 'mysql') {
            throw new RuntimeException('Email campaign app vyzaduje MySQL/MariaDB konfiguraci.');
        }
        $this->driver = 'mysql';

        $host = $database['host'] ?? 'localhost';
        $port = (int)($database['port'] ?? 3306);
        $name = $database['name'] ?? '';
        $charset = $database['charset'] ?? 'utf8mb4';
        $dsn = "mysql:host=$host;port=$port;dbname=$name;charset=$charset";
        $this->pdo = new PDO($dsn, $database['username'] ?? '', $database['password'] ?? '', [
            PDO::ATTR_PERSISTENT => false,
        ]);

        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        if ($runMigrations) {
            $this->migrate();
        }
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
        $this->migrateMysql();
        $this->safeMigrationStep(fn() => $this->copyLegacyContactLists(), 'contact_databases.legacy_copy');
        $this->seedDefaultList();
        $this->safeMigrationStep(fn() => $this->ensureKnownContactDatabases(), 'contact_databases.known_ids');
        $this->safeMigrationStep(fn() => $this->ensureColumn('contact_databases', 'archived', 'INTEGER NOT NULL DEFAULT 0'), 'contact_databases.archived');
        $this->safeMigrationStep(fn() => $this->ensureColumn('contact_databases', 'archived_at', $this->textColumn("''")), 'contact_databases.archived_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('recipients', 'list_id', 'INTEGER NOT NULL DEFAULT 1'), 'recipients.list_id');
        $this->safeMigrationStep(fn() => $this->ensureColumn('recipients', 'subject_name', $this->textColumn("''")), 'recipients.subject_name');
        $this->safeMigrationStep(fn() => $this->ensureColumn('recipients', 'website', $this->textColumn("''")), 'recipients.website');
        $this->safeMigrationStep(fn() => $this->ensureColumn('recipients', 'address', $this->textColumn("''")), 'recipients.address');
        $this->safeMigrationStep(fn() => $this->ensureColumn('recipients', 'updated_at', $this->textColumn("''")), 'recipients.updated_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('recipients', 'contacted_before', 'INTEGER NOT NULL DEFAULT 0'), 'recipients.contacted_before');
        $this->safeMigrationStep(fn() => $this->ensureColumn('recipients', 'unsubscribed_at', $this->textColumn("''")), 'recipients.unsubscribed_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('recipients', 'source_label', $this->textColumn("''")), 'recipients.source_label');
        $this->safeMigrationStep(fn() => $this->ensureColumn('recipients', 'source_url', $this->textColumn("''")), 'recipients.source_url');
        $this->safeMigrationStep(fn() => $this->ensureColumn('recipients', 'archived', 'INTEGER NOT NULL DEFAULT 0'), 'recipients.archived');
        $this->safeMigrationStep(fn() => $this->ensureRecipientEmailScope(), 'recipients.unique_scope');
        $this->safeMigrationStep(fn() => $this->ensureColumn('campaigns', 'list_id', 'INTEGER NOT NULL DEFAULT 1'), 'campaigns.list_id');
        $this->safeMigrationStep(fn() => $this->ensureColumn('campaigns', 'batch_limit', 'INTEGER NOT NULL DEFAULT 10'), 'campaigns.batch_limit');
        $this->safeMigrationStep(fn() => $this->ensureColumn('campaigns', 'auto_daily_limit', 'INTEGER NOT NULL DEFAULT 1'), 'campaigns.auto_daily_limit');
        $this->safeMigrationStep(fn() => $this->ensureColumn('campaigns', 'include_previously_contacted', 'INTEGER NOT NULL DEFAULT 0'), 'campaigns.include_previously_contacted');
        $this->safeMigrationStep(fn() => $this->ensureColumn('campaigns', 'schedule_time', $this->textColumn("'09:00'")), 'campaigns.schedule_time');
        $this->safeMigrationStep(fn() => $this->ensureColumn('campaigns', 'last_scheduled_at', $this->textColumn("''")), 'campaigns.last_scheduled_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('send_logs', 'tracking_token', $this->textColumn("''")), 'send_logs.tracking_token');
        $this->safeMigrationStep(fn() => $this->ensureColumn('send_logs', 'opened_at', $this->textColumn("''")), 'send_logs.opened_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('send_logs', 'clicked_at', $this->textColumn("''")), 'send_logs.clicked_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('send_logs', 'click_count', 'INTEGER NOT NULL DEFAULT 0'), 'send_logs.click_count');
        $this->safeMigrationStep(fn() => $this->ensureColumn('send_logs', 'run_id', 'INTEGER NOT NULL DEFAULT 0'), 'send_logs.run_id');
        $this->safeMigrationStep(fn() => $this->ensureColumn('send_logs', 'replied_at', $this->textColumn("''")), 'send_logs.replied_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('campaign_send_runs', 'next_send_after', $this->textColumn("''")), 'campaign_send_runs.next_send_after');
        $this->safeMigrationStep(fn() => $this->ensureColumn('import_runs', 'status', $this->textColumn("'finished'")), 'import_runs.status');
        $this->safeMigrationStep(fn() => $this->ensureColumn('import_runs', 'storage_path', $this->textColumn("''")), 'import_runs.storage_path');
        $this->safeMigrationStep(fn() => $this->ensureColumn('import_runs', 'processed_rows', 'INTEGER NOT NULL DEFAULT 0'), 'import_runs.processed_rows');
        $this->safeMigrationStep(fn() => $this->ensureColumn('import_runs', 'last_message', $this->textColumn("''")), 'import_runs.last_message');
        $this->safeMigrationStep(fn() => $this->ensureColumn('import_runs', 'updated_at', $this->textColumn("''")), 'import_runs.updated_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('import_runs', 'finished_at', $this->textColumn("''")), 'import_runs.finished_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('scraping_jobs', 'container_id', 'INTEGER NOT NULL DEFAULT 0'), 'scraping_jobs.container_id');
        $this->safeMigrationStep(fn() => $this->ensureColumn('scraping_jobs', 'started_at', $this->textColumn("''")), 'scraping_jobs.started_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('scraping_jobs', 'run_type', $this->textColumn("'manual'")), 'scraping_jobs.run_type');
        $this->safeMigrationStep(fn() => $this->ensureColumn('scraping_jobs', 'discovery_done', 'INTEGER NOT NULL DEFAULT 0'), 'scraping_jobs.discovery_done');
        $this->safeMigrationStep(fn() => $this->ensureColumn('scraping_jobs', 'location_scope', $this->textColumn("'cela_cr'")), 'scraping_jobs.location_scope');
        $this->safeMigrationStep(fn() => $this->ensureColumn('scraping_jobs', 'target_location', $this->textColumn("''")), 'scraping_jobs.target_location');
        $this->safeMigrationStep(fn() => $this->ensureColumn('scraping_containers', 'schedule_enabled', 'INTEGER NOT NULL DEFAULT 0'), 'scraping_containers.schedule_enabled');
        $this->safeMigrationStep(fn() => $this->ensureColumn('scraping_containers', 'schedule_time', $this->textColumn("'09:00'")), 'scraping_containers.schedule_time');
        $this->safeMigrationStep(fn() => $this->ensureColumn('scraping_containers', 'schedule_frequency', $this->textColumn("'daily'")), 'scraping_containers.schedule_frequency');
        $this->safeMigrationStep(fn() => $this->ensureColumn('scraping_containers', 'schedule_weekday', 'INTEGER NOT NULL DEFAULT 1'), 'scraping_containers.schedule_weekday');
        $this->safeMigrationStep(fn() => $this->ensureColumn('scraping_containers', 'last_scheduled_at', $this->textColumn("''")), 'scraping_containers.last_scheduled_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('scraping_containers', 'location_scope', $this->textColumn("'cela_cr'")), 'scraping_containers.location_scope');
        $this->safeMigrationStep(fn() => $this->ensureColumn('scraping_containers', 'target_location', $this->textColumn("''")), 'scraping_containers.target_location');
        $this->safeMigrationStep(fn() => $this->ensureSuppressionTable(), 'suppression_list');
        $this->safeMigrationStep(fn() => $this->ensureOnboardingTables(), 'onboarding_tables');
        $this->safeMigrationStep(fn() => $this->ensureOnboardingEventsTable(), 'onboarding_events');
        $this->safeMigrationStep(fn() => $this->ensureAiResearchTables(), 'ai_research_tables');
        $this->safeMigrationStep(fn() => $this->ensureAiResearchOutreachColumns(), 'ai_research_outreach_columns');
        $this->safeMigrationStep(fn() => $this->ensureAppUsersTable(), 'app_users');
        foreach (['contact_databases', 'campaigns', 'import_runs', 'scraping_containers', 'scraping_jobs', 'ai_research_runs'] as $ownedTable) {
            $this->safeMigrationStep(fn() => $this->ensureColumn($ownedTable, 'owner_user_id', 'INTEGER NOT NULL DEFAULT 0'), $ownedTable . '.owner_user_id');
        }
        $this->safeMigrationStep(fn() => $this->ensureContactDatabaseOwnerScope(), 'contact_databases.owner_scope');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_leads', 'invite_sent_at', $this->textColumn("''")), 'onboarding_leads.invite_sent_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_leads', 'invite_last_sent_at', $this->textColumn("''")), 'onboarding_leads.invite_last_sent_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_leads', 'invite_send_count', 'INTEGER NOT NULL DEFAULT 0'), 'onboarding_leads.invite_send_count');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_leads', 'invite_clicked_at', $this->textColumn("''")), 'onboarding_leads.invite_clicked_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_leads', 'invite_last_clicked_at', $this->textColumn("''")), 'onboarding_leads.invite_last_clicked_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_leads', 'invite_click_count', 'INTEGER NOT NULL DEFAULT 0'), 'onboarding_leads.invite_click_count');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_leads', 'invite_last_user_agent', $this->textColumn("''")), 'onboarding_leads.invite_last_user_agent');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_leads', 'invite_last_ip_hash', $this->textColumn("''")), 'onboarding_leads.invite_last_ip_hash');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_leads', 'wizard_last_step', $this->textColumn("''")), 'onboarding_leads.wizard_last_step');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_leads', 'wizard_last_step_at', $this->textColumn("''")), 'onboarding_leads.wizard_last_step_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_leads', 'wizard_max_step', $this->textColumn("''")), 'onboarding_leads.wizard_max_step');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_leads', 'wizard_max_step_at', $this->textColumn("''")), 'onboarding_leads.wizard_max_step_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_leads', 'wizard_completed_at', $this->textColumn("''")), 'onboarding_leads.wizard_completed_at');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_contacts', 'source_label', $this->textColumn("''")), 'onboarding_contacts.source_label');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_contacts', 'source_url', $this->textColumn("''")), 'onboarding_contacts.source_url');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_contacts', 'fit_reason', $this->textColumn("''")), 'onboarding_contacts.fit_reason');
        $this->safeMigrationStep(fn() => $this->ensureColumn('onboarding_contacts', 'target_segment', $this->textColumn("''")), 'onboarding_contacts.target_segment');
        $this->safeMigrationStep(fn() => $this->ensureOperationalIndexes(), 'operational_indexes');
    }

    private function safeMigrationStep(callable $step, string $label): void
    {
        try {
            $step();
        } catch (Throwable $e) {
            if ($this->isPermissionError($e)) {
                throw $e;
            }
            error_log('Email campaign migration warning [' . $label . ']: ' . $e->getMessage());
        }
    }

    private function isPermissionError(Throwable $e): bool
    {
        return preg_match('/command denied|access denied.*for table|SELECT command denied|denied to user/i', $e->getMessage()) === 1;
    }

    private function migrateMysql(): void
    {
        $statements = [
            "CREATE TABLE IF NOT EXISTS contact_databases (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                archived INT NOT NULL DEFAULT 0,
                archived_at VARCHAR(40) NOT NULL DEFAULT '',
                created_at VARCHAR(40) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS recipients (
                id INT AUTO_INCREMENT PRIMARY KEY,
                list_id INT NOT NULL DEFAULT 1,
                email VARCHAR(320) NOT NULL,
                subject_name VARCHAR(255) NOT NULL DEFAULT '',
                website VARCHAR(500) NOT NULL DEFAULT '',
                address VARCHAR(500) NOT NULL DEFAULT '',
                name VARCHAR(255) NOT NULL DEFAULT '',
                contacted_before INT NOT NULL DEFAULT 0,
                status VARCHAR(40) NOT NULL DEFAULT 'active',
                created_at VARCHAR(40) NOT NULL,
                updated_at VARCHAR(40) NOT NULL DEFAULT '',
                unsubscribed_at VARCHAR(40) NOT NULL DEFAULT '',
                source_label VARCHAR(500) NOT NULL DEFAULT '',
                source_url VARCHAR(500) NOT NULL DEFAULT '',
                archived INT NOT NULL DEFAULT 0,
                UNIQUE KEY recipient_list_email (list_id, email)
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
                status VARCHAR(40) NOT NULL DEFAULT 'finished',
                storage_path VARCHAR(500) NOT NULL DEFAULT '',
                processed_rows INT NOT NULL DEFAULT 0,
                last_message VARCHAR(500) NOT NULL DEFAULT '',
                created_at VARCHAR(40) NOT NULL,
                updated_at VARCHAR(40) NOT NULL DEFAULT '',
                finished_at VARCHAR(40) NOT NULL DEFAULT ''
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS import_run_items (
                id INT AUTO_INCREMENT PRIMARY KEY,
                import_run_id INT NOT NULL,
                row_num INT NOT NULL,
                result VARCHAR(40) NOT NULL,
                reason VARCHAR(500) NOT NULL DEFAULT '',
                email VARCHAR(320) NOT NULL DEFAULT '',
                subject_name VARCHAR(255) NOT NULL DEFAULT '',
                website VARCHAR(500) NOT NULL DEFAULT '',
                address VARCHAR(500) NOT NULL DEFAULT '',
                raw_data TEXT NOT NULL,
                created_at VARCHAR(40) NOT NULL,
                INDEX import_run_id_idx (import_run_id),
                INDEX result_idx (result)
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
                include_previously_contacted INT NOT NULL DEFAULT 0,
                schedule_time VARCHAR(5) NOT NULL DEFAULT '09:00',
                last_scheduled_at VARCHAR(40) NOT NULL DEFAULT '',
                status VARCHAR(40) NOT NULL DEFAULT 'draft',
                created_at VARCHAR(40) NOT NULL,
                updated_at VARCHAR(40) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS send_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                run_id INT NOT NULL DEFAULT 0,
                campaign_id INT NOT NULL,
                recipient_id INT NULL,
                email VARCHAR(320) NOT NULL,
                tracking_token VARCHAR(80) NOT NULL DEFAULT '',
                status VARCHAR(40) NOT NULL,
                message VARCHAR(500) NOT NULL DEFAULT '',
                sent_at VARCHAR(40) NOT NULL,
                opened_at VARCHAR(40) NOT NULL DEFAULT '',
                clicked_at VARCHAR(40) NOT NULL DEFAULT '',
                click_count INT NOT NULL DEFAULT 0,
                replied_at VARCHAR(40) NOT NULL DEFAULT ''
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS campaign_send_runs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                campaign_id INT NOT NULL,
                run_type VARCHAR(40) NOT NULL DEFAULT 'manual',
                status VARCHAR(40) NOT NULL DEFAULT 'queued',
                message VARCHAR(500) NOT NULL DEFAULT '',
                planned_count INT NOT NULL DEFAULT 0,
                sent_count INT NOT NULL DEFAULT 0,
                failed_count INT NOT NULL DEFAULT 0,
                created_at VARCHAR(40) NOT NULL,
                started_at VARCHAR(40) NOT NULL DEFAULT '',
                updated_at VARCHAR(40) NOT NULL,
                next_send_after VARCHAR(40) NOT NULL DEFAULT '',
                finished_at VARCHAR(40) NOT NULL DEFAULT ''
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
            "CREATE TABLE IF NOT EXISTS app_sessions (
                id VARCHAR(128) PRIMARY KEY,
                data MEDIUMBLOB NOT NULL,
                updated_at INT NOT NULL,
                expires_at INT NOT NULL,
                INDEX app_sessions_expires_idx (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS scraping_containers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                list_id INT NOT NULL,
                source VARCHAR(80) NOT NULL,
                keyword VARCHAR(255) NOT NULL,
                location_scope VARCHAR(40) NOT NULL DEFAULT 'cela_cr',
                target_location VARCHAR(255) NOT NULL DEFAULT '',
                status VARCHAR(40) NOT NULL DEFAULT 'active',
                schedule_enabled INT NOT NULL DEFAULT 0,
                schedule_time VARCHAR(5) NOT NULL DEFAULT '09:00',
                schedule_frequency VARCHAR(20) NOT NULL DEFAULT 'daily',
                schedule_weekday INT NOT NULL DEFAULT 1,
                last_scheduled_at VARCHAR(40) NOT NULL DEFAULT '',
                created_at VARCHAR(40) NOT NULL,
                updated_at VARCHAR(40) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS suppression_list (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(320) NOT NULL UNIQUE,
                reason VARCHAR(80) NOT NULL DEFAULT '',
                source VARCHAR(80) NOT NULL DEFAULT '',
                created_at VARCHAR(40) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS scraping_jobs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                container_id INT NOT NULL DEFAULT 0,
                list_id INT NOT NULL,
                source VARCHAR(80) NOT NULL,
                keyword VARCHAR(255) NOT NULL,
                location_scope VARCHAR(40) NOT NULL DEFAULT 'cela_cr',
                target_location VARCHAR(255) NOT NULL DEFAULT '',
                status VARCHAR(40) NOT NULL DEFAULT 'queued',
                current_page INT NOT NULL DEFAULT 1,
                max_pages INT NOT NULL DEFAULT 5,
                max_sites INT NOT NULL DEFAULT 100,
                discovered_count INT NOT NULL DEFAULT 0,
                processed_count INT NOT NULL DEFAULT 0,
                inserted_count INT NOT NULL DEFAULT 0,
                updated_count INT NOT NULL DEFAULT 0,
                skipped_count INT NOT NULL DEFAULT 0,
                last_message VARCHAR(500) NOT NULL DEFAULT '',
                run_type VARCHAR(40) NOT NULL DEFAULT 'manual',
                discovery_done INT NOT NULL DEFAULT 0,
                created_at VARCHAR(40) NOT NULL,
                started_at VARCHAR(40) NOT NULL DEFAULT '',
                updated_at VARCHAR(40) NOT NULL,
                finished_at VARCHAR(40) NOT NULL DEFAULT ''
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            "CREATE TABLE IF NOT EXISTS scraping_job_items (
                id INT AUTO_INCREMENT PRIMARY KEY,
                job_id INT NOT NULL,
                url VARCHAR(1000) NOT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'queued',
                email VARCHAR(320) NOT NULL DEFAULT '',
                subject_name VARCHAR(255) NOT NULL DEFAULT '',
                website VARCHAR(500) NOT NULL DEFAULT '',
                address VARCHAR(500) NOT NULL DEFAULT '',
                message VARCHAR(500) NOT NULL DEFAULT '',
                created_at VARCHAR(40) NOT NULL,
                processed_at VARCHAR(40) NOT NULL DEFAULT '',
                UNIQUE KEY job_url (job_id, url(700))
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        ];
        foreach ($statements as $statement) {
            $this->pdo->exec($statement);
        }
    }

    private function seedDefaultList(): void
    {
        $stmt = $this->pdo->prepare('SELECT id FROM contact_databases WHERE id=?');
        $stmt->execute([1]);
        if ($stmt->fetchColumn()) {
            return;
        }
        $insert = $this->pdo->prepare('INSERT INTO contact_databases (id, name, created_at) VALUES (?, ?, ?)');
        $insert->execute([1, 'Vychozi seznam', date('c')]);
    }

    private function copyLegacyContactLists(): void
    {
        if (!$this->tableExists('contact_lists')) {
            return;
        }
        $count = (int)$this->pdo->query('SELECT COUNT(*) FROM contact_databases')->fetchColumn();
        if ($count > 0) {
            return;
        }
        $rows = $this->pdo->query('SELECT id, name, created_at FROM contact_lists ORDER BY id ASC')->fetchAll(PDO::FETCH_ASSOC);
        $insert = $this->pdo->prepare('INSERT INTO contact_databases (id, name, created_at) VALUES (?, ?, ?)');
        foreach ($rows as $row) {
            $insert->execute([(int)$row['id'], (string)$row['name'], (string)$row['created_at']]);
        }
    }

    private function ensureKnownContactDatabases(): void
    {
        $known = [];
        foreach (['recipients', 'campaigns', 'scraping_containers', 'scraping_jobs', 'import_runs'] as $table) {
            if (!$this->tableExists($table)) {
                continue;
            }
            $column = $table === 'import_runs' ? 'list_id, list_name' : 'list_id';
            $rows = $this->pdo->query('SELECT DISTINCT ' . $column . ' FROM ' . $this->quoteIdentifier($table) . ' WHERE list_id>0')->fetchAll(PDO::FETCH_ASSOC);
            foreach ($rows as $row) {
                $id = (int)$row['list_id'];
                if ($id < 1 || isset($known[$id])) {
                    continue;
                }
                $name = trim((string)($row['list_name'] ?? ''));
                $known[$id] = $name !== '' ? $name : 'Databaze #' . $id;
            }
        }
        if (!$known) {
            return;
        }
        $exists = $this->pdo->prepare('SELECT id FROM contact_databases WHERE id=?');
        $insert = $this->pdo->prepare('INSERT INTO contact_databases (id, name, created_at) VALUES (?, ?, ?)');
        foreach ($known as $id => $name) {
            $exists->execute([$id]);
            if ($exists->fetchColumn()) {
                continue;
            }
            $insert->execute([$id, $name, date('c')]);
        }
    }

    private function textColumn(string $default): string
    {
        return "VARCHAR(500) NOT NULL DEFAULT $default";
    }

    private function ensureColumn(string $table, string $column, string $definition): void
    {
        $stmt = $this->pdo->prepare('SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?');
        $stmt->execute([$table, $column]);
        if ((int)$stmt->fetchColumn() > 0) {
            return;
        }
        $this->pdo->exec('ALTER TABLE ' . $this->quoteIdentifier($table) . ' ADD COLUMN ' . $this->quoteIdentifier($column) . ' ' . $definition);
    }

    private function ensureRecipientEmailScope(): void
    {
        if ($this->driver === 'mysql') {
            $stmt = $this->pdo->query("
                SELECT INDEX_NAME
                FROM INFORMATION_SCHEMA.STATISTICS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='recipients'
                  AND NON_UNIQUE=0
                GROUP BY INDEX_NAME
                HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='email'
            ");
            foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $indexName) {
                $this->pdo->exec('ALTER TABLE recipients DROP INDEX ' . $this->quoteIdentifier((string)$indexName));
            }
            $exists = $this->pdo->query("
                SELECT COUNT(*)
                FROM INFORMATION_SCHEMA.STATISTICS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='recipients'
                  AND INDEX_NAME='recipient_list_email'
            ")->fetchColumn();
            if ((int)$exists === 0) {
                $this->pdo->exec('ALTER TABLE recipients ADD UNIQUE KEY recipient_list_email (list_id, email)');
            }
        }
    }

    private function ensureContactDatabaseOwnerScope(): void
    {
        $stmt = $this->pdo->query("
            SELECT INDEX_NAME
            FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA=DATABASE()
              AND TABLE_NAME='contact_databases'
              AND NON_UNIQUE=0
            GROUP BY INDEX_NAME
            HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='name'
        ");
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $indexName) {
            $this->pdo->exec('ALTER TABLE contact_databases DROP INDEX ' . $this->quoteIdentifier((string)$indexName));
        }
        $exists = $this->pdo->query("
            SELECT COUNT(*)
            FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA=DATABASE()
              AND TABLE_NAME='contact_databases'
              AND INDEX_NAME='contact_databases_owner_name'
        ")->fetchColumn();
        if ((int)$exists === 0) {
            $this->pdo->exec('ALTER TABLE contact_databases ADD UNIQUE KEY contact_databases_owner_name (owner_user_id, name)');
        }
    }

    private function ensureSuppressionTable(): void
    {
        $this->pdo->exec("CREATE TABLE IF NOT EXISTS suppression_list (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(320) NOT NULL UNIQUE,
                reason VARCHAR(80) NOT NULL DEFAULT '',
                source VARCHAR(80) NOT NULL DEFAULT '',
                created_at VARCHAR(40) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    }

    private function ensureOnboardingTables(): void
    {
        $this->pdo->exec("CREATE TABLE IF NOT EXISTS onboarding_leads (
                id INT AUTO_INCREMENT PRIMARY KEY,
                token VARCHAR(96) NOT NULL UNIQUE,
                account_email VARCHAR(320) NOT NULL,
                business_name VARCHAR(255) NOT NULL DEFAULT '',
                business_type VARCHAR(255) NOT NULL DEFAULT '',
                audience_label VARCHAR(255) NOT NULL DEFAULT '',
                status VARCHAR(40) NOT NULL DEFAULT 'new',
                selected_contact_ids MEDIUMTEXT NULL,
                email_subject VARCHAR(255) NOT NULL DEFAULT '',
                email_body_html MEDIUMTEXT NULL,
                from_email VARCHAR(320) NOT NULL DEFAULT '',
                from_name VARCHAR(255) NOT NULL DEFAULT '',
                smtp_host VARCHAR(255) NOT NULL DEFAULT '',
                smtp_port INT NOT NULL DEFAULT 587,
                smtp_username VARCHAR(320) NOT NULL DEFAULT '',
                smtp_password VARCHAR(500) NOT NULL DEFAULT '',
                smtp_encryption VARCHAR(20) NOT NULL DEFAULT 'tls',
                smtp_validated INT NOT NULL DEFAULT 0,
                stripe_customer_id VARCHAR(255) NOT NULL DEFAULT '',
                stripe_session_id VARCHAR(255) NOT NULL DEFAULT '',
                stripe_subscription_id VARCHAR(255) NOT NULL DEFAULT '',
                payment_status VARCHAR(40) NOT NULL DEFAULT 'pending',
                trial_days INT NOT NULL DEFAULT 7,
                monthly_price_usd DECIMAL(8,2) NOT NULL DEFAULT 19.00,
                list_id INT NOT NULL DEFAULT 0,
                campaign_id INT NOT NULL DEFAULT 0,
                invite_sent_at VARCHAR(40) NOT NULL DEFAULT '',
                invite_last_sent_at VARCHAR(40) NOT NULL DEFAULT '',
                invite_send_count INT NOT NULL DEFAULT 0,
                invite_clicked_at VARCHAR(40) NOT NULL DEFAULT '',
                invite_last_clicked_at VARCHAR(40) NOT NULL DEFAULT '',
                invite_click_count INT NOT NULL DEFAULT 0,
                invite_last_user_agent VARCHAR(500) NOT NULL DEFAULT '',
                invite_last_ip_hash VARCHAR(80) NOT NULL DEFAULT '',
                wizard_last_step VARCHAR(40) NOT NULL DEFAULT '',
                wizard_last_step_at VARCHAR(40) NOT NULL DEFAULT '',
                wizard_max_step VARCHAR(40) NOT NULL DEFAULT '',
                wizard_max_step_at VARCHAR(40) NOT NULL DEFAULT '',
                wizard_completed_at VARCHAR(40) NOT NULL DEFAULT '',
                created_at VARCHAR(40) NOT NULL,
                updated_at VARCHAR(40) NOT NULL,
                INDEX onboarding_leads_email_idx (account_email)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $this->pdo->exec("CREATE TABLE IF NOT EXISTS onboarding_contacts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                lead_id INT NOT NULL,
                email VARCHAR(320) NOT NULL,
                subject_name VARCHAR(255) NOT NULL DEFAULT '',
                website VARCHAR(500) NOT NULL DEFAULT '',
                contact_name VARCHAR(255) NOT NULL DEFAULT '',
                address VARCHAR(500) NOT NULL DEFAULT '',
                phone VARCHAR(80) NOT NULL DEFAULT '',
                source_label VARCHAR(500) NOT NULL DEFAULT '',
                source_url VARCHAR(500) NOT NULL DEFAULT '',
                fit_reason VARCHAR(500) NOT NULL DEFAULT '',
                target_segment VARCHAR(500) NOT NULL DEFAULT '',
                status VARCHAR(40) NOT NULL DEFAULT 'found',
                created_at VARCHAR(40) NOT NULL,
                UNIQUE KEY onboarding_lead_email (lead_id, email),
                INDEX onboarding_contacts_lead_idx (lead_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    }

    private function ensureOnboardingEventsTable(): void
    {
        $this->pdo->exec("CREATE TABLE IF NOT EXISTS onboarding_events (
                id INT AUTO_INCREMENT PRIMARY KEY,
                lead_id INT NOT NULL,
                account_email VARCHAR(320) NOT NULL DEFAULT '',
                event_type VARCHAR(40) NOT NULL,
                step VARCHAR(40) NOT NULL DEFAULT '',
                source VARCHAR(80) NOT NULL DEFAULT '',
                user_agent VARCHAR(500) NOT NULL DEFAULT '',
                ip_hash VARCHAR(80) NOT NULL DEFAULT '',
                created_at VARCHAR(40) NOT NULL,
                INDEX onboarding_events_lead_idx (lead_id, created_at),
                INDEX onboarding_events_type_idx (event_type, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    }

    private function ensureAiResearchTables(): void
    {
        $this->pdo->exec("CREATE TABLE IF NOT EXISTS ai_research_runs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                seed_recipient_id INT NOT NULL DEFAULT 0,
                seed_email VARCHAR(320) NOT NULL DEFAULT '',
                seed_business VARCHAR(255) NOT NULL DEFAULT '',
                seed_website VARCHAR(500) NOT NULL DEFAULT '',
                seed_address VARCHAR(500) NOT NULL DEFAULT '',
                seed_source_label VARCHAR(500) NOT NULL DEFAULT '',
                seed_source_url VARCHAR(500) NOT NULL DEFAULT '',
                status VARCHAR(40) NOT NULL DEFAULT 'done',
                audience_label VARCHAR(500) NOT NULL DEFAULT '',
                rationale TEXT NOT NULL,
                email_angle TEXT NOT NULL,
                scraping_keyword VARCHAR(255) NOT NULL DEFAULT '',
                filters_json MEDIUMTEXT NOT NULL,
                plan_json MEDIUMTEXT NOT NULL,
                email_subject VARCHAR(255) NOT NULL DEFAULT '',
                email_body_html MEDIUMTEXT NULL,
                found_count INT NOT NULL DEFAULT 0,
                accepted_count INT NOT NULL DEFAULT 0,
                message VARCHAR(500) NOT NULL DEFAULT '',
                created_at VARCHAR(40) NOT NULL,
                updated_at VARCHAR(40) NOT NULL,
                INDEX ai_research_seed_idx (seed_recipient_id),
                INDEX ai_research_status_idx (status, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $this->pdo->exec("CREATE TABLE IF NOT EXISTS ai_research_contacts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                run_id INT NOT NULL,
                email VARCHAR(320) NOT NULL DEFAULT '',
                subject_name VARCHAR(255) NOT NULL DEFAULT '',
                website VARCHAR(500) NOT NULL DEFAULT '',
                address VARCHAR(500) NOT NULL DEFAULT '',
                phone VARCHAR(80) NOT NULL DEFAULT '',
                source_label VARCHAR(500) NOT NULL DEFAULT '',
                source_url VARCHAR(500) NOT NULL DEFAULT '',
                status VARCHAR(40) NOT NULL DEFAULT 'accepted',
                fit_reason VARCHAR(500) NOT NULL DEFAULT '',
                email_subject VARCHAR(255) NOT NULL DEFAULT '',
                email_body_html MEDIUMTEXT NULL,
                created_at VARCHAR(40) NOT NULL,
                INDEX ai_research_contacts_run_idx (run_id),
                INDEX ai_research_contacts_email_idx (email)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
        $this->ensureColumn('ai_research_runs', 'scraping_keyword', "VARCHAR(255) NOT NULL DEFAULT ''");

        // Provozni log automatiky. Vzdy obsahuje i jeden naplanovany zaznam dopredu,
        // aby bylo videt, kdy a na cem se bude pracovat, i kdyz se dlouho nic nedeje.
        $this->pdo->exec("CREATE TABLE IF NOT EXISTS ai_research_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                status VARCHAR(20) NOT NULL DEFAULT 'planned',
                kind VARCHAR(40) NOT NULL DEFAULT 'new_seed',
                planned_at VARCHAR(40) NOT NULL DEFAULT '',
                started_at VARCHAR(40) NOT NULL DEFAULT '',
                finished_at VARCHAR(40) NOT NULL DEFAULT '',
                run_id INT NOT NULL DEFAULT 0,
                subject VARCHAR(255) NOT NULL DEFAULT '',
                model VARCHAR(80) NOT NULL DEFAULT '',
                requests INT NOT NULL DEFAULT 0,
                tokens INT NOT NULL DEFAULT 0,
                duration_seconds INT NOT NULL DEFAULT 0,
                message TEXT NOT NULL,
                created_at VARCHAR(40) NOT NULL,
                INDEX ai_research_logs_status_idx (status, id),
                INDEX ai_research_logs_created_idx (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    }

    private function ensureAiResearchOutreachColumns(): void
    {
        $this->ensureColumn('ai_research_runs', 'seed_outreach_status', "VARCHAR(40) NOT NULL DEFAULT 'ready'");
        $this->ensureColumn('ai_research_runs', 'seed_outreach_token', "VARCHAR(80) NOT NULL DEFAULT ''");
        $this->ensureColumn('ai_research_runs', 'seed_outreach_sent_at', "VARCHAR(40) NOT NULL DEFAULT ''");
        $this->ensureColumn('ai_research_runs', 'seed_outreach_unsubscribed_at', "VARCHAR(40) NOT NULL DEFAULT ''");
    }

    private function ensureAppUsersTable(): void
    {
        $this->pdo->exec("CREATE TABLE IF NOT EXISTS app_users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(320) NOT NULL,
                password_hash VARCHAR(255) NOT NULL DEFAULT '',
                role VARCHAR(40) NOT NULL DEFAULT 'admin',
                can_access_research TINYINT(1) NOT NULL DEFAULT 0,
                is_active TINYINT(1) NOT NULL DEFAULT 1,
                password_reset_token_hash VARCHAR(128) NOT NULL DEFAULT '',
                password_reset_requested_at VARCHAR(40) NOT NULL DEFAULT '',
                password_reset_expires_at VARCHAR(40) NOT NULL DEFAULT '',
                password_reset_used_at VARCHAR(40) NOT NULL DEFAULT '',
                created_at VARCHAR(40) NOT NULL,
                updated_at VARCHAR(40) NOT NULL,
                UNIQUE KEY app_users_email_unique (email),
                INDEX app_users_reset_idx (password_reset_token_hash, password_reset_expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    }

    private function ensureOperationalIndexes(): void
    {
        $this->ensureMysqlIndex('recipients', 'recipients_list_source_url_idx', 'CREATE INDEX recipients_list_source_url_idx ON recipients (list_id, source_url(191))');
        $this->ensureMysqlIndex('scraping_job_items', 'scraping_items_url_status_idx', 'CREATE INDEX scraping_items_url_status_idx ON scraping_job_items (url(191), status, processed_at)');
        $this->ensureMysqlIndex('scraping_jobs', 'scraping_jobs_list_source_idx', 'CREATE INDEX scraping_jobs_list_source_idx ON scraping_jobs (list_id, source, id)');
    }

    private function ensureMysqlIndex(string $table, string $index, string $createSql): void
    {
        $stmt = $this->pdo->prepare('
            SELECT COUNT(*)
            FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA=DATABASE()
              AND TABLE_NAME=?
              AND INDEX_NAME=?
        ');
        $stmt->execute([$table, $index]);
        if ((int)$stmt->fetchColumn() > 0) {
            return;
        }
        $this->pdo->exec($createSql);
    }

    private function tableExists(string $table): bool
    {
        $stmt = $this->pdo->prepare('SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?');
        $stmt->execute([$table]);
        return (int)$stmt->fetchColumn() > 0;
    }

    private function quoteIdentifier(string $identifier): string
    {
        return '`' . str_replace('`', '``', $identifier) . '`';
    }
}
