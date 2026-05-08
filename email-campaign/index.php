<?php

declare(strict_types=1);

session_start();
require __DIR__ . '/src/Database.php';
require __DIR__ . '/src/SmtpMailer.php';

$configPath = __DIR__ . '/config.php';
$baseConfig = file_exists($configPath) ? require $configPath : require __DIR__ . '/config.example.php';
$databaseConfig = $baseConfig['database'] ?? ['driver' => 'sqlite', 'path' => $baseConfig['database_path'] ?? (__DIR__ . '/storage/app.sqlite')];
$dbWarning = null;
try {
    $db = new Database($databaseConfig);
} catch (Throwable $e) {
    $dbWarning = 'MySQL pripojeni selhalo, aplikace docasne bezi nad SQLite. Detail: ' . $e->getMessage();
    $db = new Database(['driver' => 'sqlite', 'path' => __DIR__ . '/storage/app.sqlite']);
}
$pdo = $db->pdo();
$migrationNotice = null;
if (($databaseConfig['driver'] ?? '') === 'mysql' && $dbWarning === null) {
    try {
        if (migrateSqliteDataToMysqlIfEmpty($pdo, __DIR__ . '/storage/app.sqlite')) {
            $migrationNotice = 'Data byla prenesena z puvodni SQLite databaze do MySQL.';
        }
    } catch (Throwable $e) {
        $dbWarning = 'MySQL bezi, ale migrace dat ze SQLite selhala: ' . $e->getMessage();
    }
}
$config = effectiveConfig($pdo, $baseConfig);
$flash = $_SESSION['flash'] ?? null;
unset($_SESSION['flash']);
if ($dbWarning && !$flash) {
    $flash = ['error', $dbWarning];
} elseif ($migrationNotice && !$flash) {
    $flash = ['ok', $migrationNotice];
}

if (isset($_GET['open'])) {
    trackOpen($pdo, (string)$_GET['open']);
    exit;
}

if (isset($_GET['click'], $_GET['u'])) {
    trackClick($pdo, (string)$_GET['click'], (string)$_GET['u']);
    exit;
}

if (isset($_GET['cron'])) {
    header('Content-Type: text/plain; charset=utf-8');
    if ($config['cron_token'] === '' || !hash_equals((string)$config['cron_token'], (string)$_GET['cron'])) {
        http_response_code(403);
        exit("Forbidden\n");
    }
    echo sendBatch($pdo, $config);
    exit;
}

if (!isConfigured($config)) {
    if (($_POST['action'] ?? '') === 'setup') {
        try {
            saveSetup($pdo);
            $_SESSION['auth'] = true;
            $_SESSION['flash'] = ['ok', 'Aplikace je pripravena.'];
            header('Location: ./');
            exit;
        } catch (Throwable $e) {
            $flash = ['error', $e->getMessage()];
        }
    }
    renderSetup($flash);
    exit;
}

if (isset($_POST['password'])) {
    if (password_verify((string)$_POST['password'], (string)$config['app_password_hash'])) {
        $_SESSION['auth'] = true;
        header('Location: ./?route=dashboard');
        exit;
    }
    $flash = ['error', 'Nespravne heslo.'];
}

if (isset($_GET['logout'])) {
    session_destroy();
    header('Location: ./');
    exit;
}

if (empty($_SESSION['auth'])) {
    renderLogin($flash);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && !isset($_POST['password'])) {
    try {
        $message = handlePost($pdo, $config);
        $_SESSION['flash'] = ['ok', $message ?: 'Hotovo.'];
        $returnView = currentView();
        header('Location: ' . routeUrl($returnView));
        exit;
    } catch (Throwable $e) {
        $flash = ['error', $e->getMessage()];
    }
}

try {
    renderApp($pdo, $flash);
} catch (Throwable $e) {
    renderFatal($e, $flash);
}

function handlePost(PDO $pdo, array $config): ?string
{
    $action = $_POST['action'] ?? '';
    if ($action === 'save_settings') {
        saveSettings($pdo);
        return 'Nastaveni ulozeno.';
    }

    if ($action === 'test_smtp') {
        (new SmtpMailer($config))->testConnection();
        return 'SMTP pripojeni a prihlaseni funguje.';
    }

    if ($action === 'test_imap') {
        testImapConnection($config['imap']);
        return 'IMAP pripojeni a prihlaseni funguje.';
    }

    if ($action === 'save_campaign') {
        $id = (int)($_POST['id'] ?? 0);
        $data = [
            max(1, (int)$_POST['list_id']),
            trim((string)$_POST['name']),
            trim((string)$_POST['subject']),
            cleanHtml((string)$_POST['body_html']),
            max(1, min(500, (int)$_POST['daily_limit'])),
            max(1, min(100, (int)$_POST['batch_limit'])),
            isset($_POST['auto_daily_limit']) ? 1 : 0,
            in_array($_POST['status'] ?? 'draft', ['draft', 'active', 'paused'], true) ? $_POST['status'] : 'draft',
            date('c'),
        ];
        if ($id > 0) {
            $stmt = $pdo->prepare('UPDATE campaigns SET list_id=?, name=?, subject=?, body_html=?, daily_limit=?, batch_limit=?, auto_daily_limit=?, status=?, updated_at=? WHERE id=?');
            $stmt->execute([...$data, $id]);
            return 'Kampan ulozena.';
        }
        $stmt = $pdo->prepare('INSERT INTO campaigns (list_id, name, subject, body_html, daily_limit, batch_limit, auto_daily_limit, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        $stmt->execute([...$data, date('c')]);
        return 'Kampan vytvorena.';
    }

    if ($action === 'import_recipients') {
        return importRecipients($pdo);
    }

    if ($action === 'test_send') {
        $campaign = findCampaign($pdo, (int)$_POST['campaign_id']);
        $email = trim((string)$_POST['test_email']);
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new RuntimeException('Testovaci email neni platny.');
        }
        (new SmtpMailer($config))->send($email, '[TEST] ' . $campaign['subject'], $campaign['body_html'], ['email' => $email, 'name' => 'Test']);
        return 'Testovaci email odeslan.';
    }

    if ($action === 'send_batch') {
        return trim(sendBatch($pdo, $config, (int)$_POST['campaign_id']));
    }

    return null;
}

function migrateSqliteDataToMysqlIfEmpty(PDO $mysql, string $sqlitePath): bool
{
    if (!file_exists($sqlitePath)) {
        return false;
    }

    if (!databaseIsPortableTargetEmpty($mysql, 'mysql')) {
        return false;
    }

    $sqlite = new PDO('sqlite:' . $sqlitePath);
    $sqlite->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $sqlite->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

    if (databaseIsPortableTargetEmpty($sqlite, 'sqlite')) {
        return false;
    }

    $tables = ['settings', 'contact_lists', 'recipients', 'import_runs', 'campaigns', 'send_logs', 'tracking_events'];
    $mysql->beginTransaction();
    try {
        foreach (array_reverse($tables) as $table) {
            $mysql->exec('DELETE FROM ' . $table);
        }

        copySettingsTable($sqlite, $mysql);
        copyWholeTable($sqlite, $mysql, 'contact_lists');
        $recipientIdMap = copyRecipientsTable($sqlite, $mysql);
        foreach (['import_runs', 'campaigns'] as $table) {
            copyWholeTable($sqlite, $mysql, $table);
        }
        copySendLogsTable($sqlite, $mysql, $recipientIdMap);
        copyWholeTable($sqlite, $mysql, 'tracking_events');

        $mysql->commit();
        return true;
    } catch (Throwable $e) {
        $mysql->rollBack();
        throw $e;
    }
}

function databaseIsPortableTargetEmpty(PDO $pdo, string $driver): bool
{
    $settingsColumn = $driver === 'mysql' ? 'setting_key' : 'key';
    $checks = [
        "SELECT COUNT(*) FROM settings WHERE $settingsColumn IS NOT NULL",
        'SELECT COUNT(*) FROM recipients',
        'SELECT COUNT(*) FROM import_runs',
        'SELECT COUNT(*) FROM campaigns',
        'SELECT COUNT(*) FROM send_logs',
        'SELECT COUNT(*) FROM tracking_events',
    ];
    foreach ($checks as $sql) {
        if ((int)$pdo->query($sql)->fetchColumn() > 0) {
            return false;
        }
    }
    return true;
}

function copySettingsTable(PDO $sqlite, PDO $mysql): void
{
    $rows = $sqlite->query('SELECT key, value FROM settings')->fetchAll(PDO::FETCH_ASSOC);
    $stmt = $mysql->prepare('INSERT INTO settings (setting_key, value) VALUES (?, ?)');
    foreach ($rows as $row) {
        $stmt->execute([$row['key'], $row['value']]);
    }
}

function copyWholeTable(PDO $source, PDO $target, string $table): void
{
    $rows = $source->query('SELECT * FROM ' . $table)->fetchAll(PDO::FETCH_ASSOC);
    if (!$rows) {
        return;
    }
    $columns = array_keys($rows[0]);
    $columnSql = implode(', ', $columns);
    $placeholders = implode(', ', array_fill(0, count($columns), '?'));
    $stmt = $target->prepare('INSERT INTO ' . $table . ' (' . $columnSql . ') VALUES (' . $placeholders . ')');
    foreach ($rows as $row) {
        $stmt->execute(array_map(static fn($column) => $row[$column], $columns));
    }
}

function copyRecipientsTable(PDO $source, PDO $target): array
{
    $rows = $source->query('SELECT * FROM recipients ORDER BY id ASC')->fetchAll(PDO::FETCH_ASSOC);
    $idMap = [];
    $emailMap = [];
    $insert = $target->prepare('INSERT INTO recipients (id, list_id, email, subject_name, website, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    $update = $target->prepare('
        UPDATE recipients
        SET list_id=?,
            subject_name=CASE WHEN ? != "" THEN ? ELSE subject_name END,
            website=CASE WHEN ? != "" THEN ? ELSE website END,
            name=CASE WHEN ? != "" THEN ? ELSE name END,
            status=?
        WHERE id=?
    ');

    foreach ($rows as $row) {
        $emailKey = strtolower(trim((string)$row['email']));
        if ($emailKey === '') {
            continue;
        }
        if (!isset($emailMap[$emailKey])) {
            $emailMap[$emailKey] = (int)$row['id'];
            $idMap[(int)$row['id']] = (int)$row['id'];
            $insert->execute([
                $row['id'],
                $row['list_id'],
                $row['email'],
                $row['subject_name'],
                $row['website'],
                $row['name'],
                $row['status'],
                $row['created_at'],
            ]);
            continue;
        }

        $keptId = $emailMap[$emailKey];
        $idMap[(int)$row['id']] = $keptId;
        $update->execute([
            $row['list_id'],
            $row['subject_name'],
            $row['subject_name'],
            $row['website'],
            $row['website'],
            $row['name'],
            $row['name'],
            $row['status'],
            $keptId,
        ]);
    }

    return $idMap;
}

function copySendLogsTable(PDO $source, PDO $target, array $recipientIdMap): void
{
    $rows = $source->query('SELECT * FROM send_logs')->fetchAll(PDO::FETCH_ASSOC);
    if (!$rows) {
        return;
    }
    $columns = array_keys($rows[0]);
    $columnSql = implode(', ', $columns);
    $placeholders = implode(', ', array_fill(0, count($columns), '?'));
    $stmt = $target->prepare('INSERT INTO send_logs (' . $columnSql . ') VALUES (' . $placeholders . ')');
    foreach ($rows as $row) {
        if (!empty($row['recipient_id'])) {
            $row['recipient_id'] = $recipientIdMap[(int)$row['recipient_id']] ?? $row['recipient_id'];
        }
        $stmt->execute(array_map(static fn($column) => $row[$column], $columns));
    }
}

function effectiveConfig(PDO $pdo, array $config): array
{
    $settings = loadSettings($pdo);
    foreach (['app_password_hash', 'cron_token', 'from_email', 'from_name'] as $key) {
        if (!empty($settings[$key])) {
            $config[$key] = $settings[$key];
        }
    }
    foreach (['host', 'port', 'username', 'password', 'encryption'] as $key) {
        $settingKey = 'smtp_' . $key;
        if (array_key_exists($settingKey, $settings) && $settings[$settingKey] !== '') {
            $config['smtp'][$key] = $key === 'port' ? (int)$settings[$settingKey] : $settings[$settingKey];
        }
    }
    $config['imap'] = [
        'host' => $settings['imap_host'] ?? '',
        'port' => (int)($settings['imap_port'] ?? 993),
        'username' => $settings['imap_username'] ?? '',
        'password' => $settings['imap_password'] ?? '',
        'encryption' => $settings['imap_encryption'] ?? 'ssl',
    ];
    return $config;
}

function loadSettings(PDO $pdo): array
{
    $settings = [];
    $rows = $pdo->query('SELECT * FROM settings')->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as $row) {
        $key = array_key_exists('key', $row) ? $row['key'] : ($row['KEY'] ?? null);
        if ($key === null && array_key_exists('setting_key', $row)) {
            $key = $row['setting_key'];
        }
        if ($key !== null) {
            $settings[(string)$key] = (string)$row['value'];
        }
    }
    return $settings;
}

function isConfigured(array $config): bool
{
    return (string)$config['app_password_hash'] !== '';
}

function saveSetup(PDO $pdo): void
{
    $password = (string)($_POST['new_password'] ?? '');
    if (strlen($password) < 10) {
        throw new RuntimeException('Heslo musi mit alespon 10 znaku.');
    }
    $token = bin2hex(random_bytes(24));
    setSetting($pdo, 'app_password_hash', password_hash($password, PASSWORD_DEFAULT));
    setSetting($pdo, 'cron_token', $token);
}

function saveSettings(PDO $pdo): void
{
    $allowed = ['from_email', 'from_name', 'smtp_host', 'smtp_port', 'smtp_username', 'smtp_password', 'smtp_encryption', 'imap_host', 'imap_port', 'imap_username', 'imap_password', 'imap_encryption'];
    foreach ($allowed as $key) {
        if (in_array($key, ['smtp_password', 'imap_password'], true) && ($_POST[$key] ?? '') === '') {
            continue;
        }
        setSetting($pdo, $key, trim((string)($_POST[$key] ?? '')));
    }
    $newPassword = (string)($_POST['new_password'] ?? '');
    if ($newPassword !== '') {
        if (strlen($newPassword) < 10) {
            throw new RuntimeException('Nove heslo musi mit alespon 10 znaku.');
        }
        setSetting($pdo, 'app_password_hash', password_hash($newPassword, PASSWORD_DEFAULT));
    }
}

function setSetting(PDO $pdo, string $key, string $value): void
{
    $keyColumn = settingKeyColumn($pdo);
    $exists = $pdo->prepare('SELECT COUNT(*) FROM settings WHERE ' . $keyColumn . '=?');
    $exists->execute([$key]);
    if ((int)$exists->fetchColumn() > 0) {
        $stmt = $pdo->prepare('UPDATE settings SET value=? WHERE ' . $keyColumn . '=?');
        $stmt->execute([$value, $key]);
        return;
    }
    $insert = $pdo->prepare('INSERT INTO settings (' . $keyColumn . ', value) VALUES (?, ?)');
    $insert->execute([$key, $value]);
}

function settingKeyColumn(PDO $pdo): string
{
    static $column = null;
    if ($column !== null) {
        return $column;
    }
    try {
        $pdo->query('SELECT setting_key FROM settings LIMIT 1');
        $column = 'setting_key';
    } catch (Throwable $e) {
        $column = 'key';
    }
    return $column;
}

function testImapConnection(array $imap): void
{
    if (($imap['host'] ?? '') === '' || ($imap['username'] ?? '') === '' || ($imap['password'] ?? '') === '') {
        throw new RuntimeException('IMAP neni vyplneny.');
    }
    $scheme = ($imap['encryption'] ?? 'ssl') === 'ssl' ? 'ssl://' : '';
    $socket = stream_socket_client($scheme . $imap['host'] . ':' . (int)$imap['port'], $errno, $errstr, 30);
    if (!$socket) {
        throw new RuntimeException("IMAP connection failed: $errstr");
    }
    $hello = fgets($socket, 2048) ?: '';
    if (strpos($hello, '* OK') === false) {
        fclose($socket);
        throw new RuntimeException('IMAP server nevratil OK pozdrav.');
    }
    if (($imap['encryption'] ?? 'ssl') === 'tls') {
        fwrite($socket, "a0 STARTTLS\r\n");
        $tlsResponse = '';
        while (($line = fgets($socket, 2048)) !== false) {
            $tlsResponse .= $line;
            if (strpos($line, 'a0 ') === 0) {
                break;
            }
        }
        if (strpos($tlsResponse, 'a0 OK') === false || !stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
            fclose($socket);
            throw new RuntimeException('IMAP STARTTLS se nezdarilo.');
        }
    }
    fwrite($socket, "a1 LOGIN \"" . addcslashes($imap['username'], "\\\"") . "\" \"" . addcslashes($imap['password'], "\\\"") . "\"\r\n");
    $response = '';
    while (($line = fgets($socket, 2048)) !== false) {
        $response .= $line;
        if (strpos($line, 'a1 ') === 0) {
            break;
        }
    }
    fwrite($socket, "a2 LOGOUT\r\n");
    fclose($socket);
    if (strpos($response, 'a1 OK') === false) {
        throw new RuntimeException('IMAP prihlaseni se nezdarilo.');
    }
}

function importRecipients(PDO $pdo): string
{
    if (!isset($_FILES['csv']) || $_FILES['csv']['error'] !== UPLOAD_ERR_OK) {
        throw new RuntimeException('CSV soubor se nepodarilo nahrat.');
    }
    $handle = fopen($_FILES['csv']['tmp_name'], 'rb');
    if (!$handle) {
        throw new RuntimeException('CSV soubor nejde otevrit.');
    }
    $first = fgetcsv($handle, 0, ',');
    if ($first === false) {
        throw new RuntimeException('CSV je prazdne.');
    }
    $headers = array_map(fn($v) => strtolower(trim((string)$v)), $first);
    $emailIndex = headerIndex($headers, ['email', 'e-mail', 'mail']);
    $nameIndex = headerIndex($headers, ['name', 'jmeno', 'jméno']);
    $subjectIndex = headerIndex($headers, ['subject_name', 'subject', 'nazev', 'název', 'firma', 'subjekt', 'centrum', 'studio']);
    $websiteIndex = headerIndex($headers, ['website', 'web', 'url', 'www', 'webovka']);
    $rows = $emailIndex === false ? [$first] : [];
    while (($row = fgetcsv($handle, 0, ',')) !== false) {
        $rows[] = $row;
    }
    fclose($handle);

    $listId = resolveContactList($pdo, trim((string)($_POST['list_name'] ?? '')));
    $existingStmt = $pdo->prepare('SELECT list_id, subject_name, website, name FROM recipients WHERE email=?');
    $insertStmt = $pdo->prepare('INSERT INTO recipients (list_id, email, subject_name, website, name, status, created_at) VALUES (?, ?, ?, ?, ?, "active", ?)');
    $updateStmt = $pdo->prepare('UPDATE recipients SET list_id=?, subject_name=?, website=?, name=?, status="active" WHERE email=?');
    $inserted = 0;
    $updated = 0;
    $skipped = 0;
    $total = 0;
    foreach ($rows as $row) {
        $total++;
        $email = trim((string)($row[$emailIndex === false ? 0 : $emailIndex] ?? ''));
        $name = trim((string)($nameIndex === false ? '' : ($row[$nameIndex] ?? '')));
        $subjectName = trim((string)($row[$subjectIndex === false ? 1 : $subjectIndex] ?? ''));
        $website = normalizeWebsite(trim((string)($row[$websiteIndex === false ? 2 : $websiteIndex] ?? '')));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $skipped++;
            continue;
        }
        $existingStmt->execute([$email]);
        $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if (!$existing) {
            $insertStmt->execute([$listId, $email, $subjectName, $website, $name, date('c')]);
            $inserted++;
            continue;
        }
        $newSubject = $subjectName !== '' ? $subjectName : (string)$existing['subject_name'];
        $newWebsite = $website !== '' ? $website : (string)$existing['website'];
        $newName = $name !== '' ? $name : (string)$existing['name'];
        $changed = (int)$existing['list_id'] !== $listId || $newSubject !== (string)$existing['subject_name'] || $newWebsite !== (string)$existing['website'] || $newName !== (string)$existing['name'];
        if ($changed) {
            $updateStmt->execute([$listId, $newSubject, $newWebsite, $newName, $email]);
            $updated++;
        } else {
            $skipped++;
        }
    }
    $log = $pdo->prepare('INSERT INTO import_runs (list_id, list_name, file_name, inserted_count, updated_count, skipped_count, total_rows, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    $log->execute([$listId, contactListName($pdo, $listId), $_FILES['csv']['name'] ?? '', $inserted, $updated, $skipped, $total, date('c')]);
    return "Import hotov: vlozeno $inserted, aktualizovano $updated, preskoceno $skipped.";
}

function headerIndex(array $headers, array $names)
{
    foreach ($names as $name) {
        $idx = array_search($name, $headers, true);
        if ($idx !== false) {
            return $idx;
        }
    }
    return false;
}

function normalizeWebsite(string $website): string
{
    if ($website === '') {
        return '';
    }
    if (!preg_match('/^https?:\/\//i', $website)) {
        return 'https://' . $website;
    }
    return $website;
}

function resolveContactList(PDO $pdo, string $name): int
{
    $name = $name !== '' ? $name : 'Vychozi seznam';
    $find = $pdo->prepare('SELECT id FROM contact_lists WHERE name=?');
    $find->execute([$name]);
    $existing = (int)$find->fetchColumn();
    if ($existing > 0) {
        return $existing;
    }
    $stmt = $pdo->prepare('INSERT INTO contact_lists (name, created_at) VALUES (?, ?)');
    $stmt->execute([$name, date('c')]);
    return (int)$pdo->lastInsertId();
}

function contactListName(PDO $pdo, int $id): string
{
    $stmt = $pdo->prepare('SELECT name FROM contact_lists WHERE id=?');
    $stmt->execute([$id]);
    return (string)($stmt->fetchColumn() ?: 'Vychozi seznam');
}

function sendBatch(PDO $pdo, array $config, ?int $campaignId = null): string
{
    $campaign = $campaignId ? findCampaign($pdo, $campaignId) : $pdo->query('SELECT * FROM campaigns WHERE status="active" ORDER BY id DESC LIMIT 1')->fetch(PDO::FETCH_ASSOC);
    if (!$campaign) {
        return "No active campaign.\n";
    }
    $today = date('Y-m-d');
    $sentStmt = $pdo->prepare('SELECT COUNT(*) FROM send_logs WHERE campaign_id=? AND status="sent" AND substr(sent_at,1,10)=?');
    $sentStmt->execute([$campaign['id'], $today]);
    $sentToday = (int)$sentStmt->fetchColumn();
    $dailyLimit = campaignDailyLimit($pdo, $campaign)['limit'];
    $limit = max(0, $dailyLimit - $sentToday);
    $limit = min($limit, max(1, (int)($campaign['batch_limit'] ?? 10)));
    if ($limit < 1) {
        return "Daily limit already reached.\n";
    }
    $stmt = $pdo->prepare('
        SELECT r.* FROM recipients r
        WHERE r.status="active"
        AND r.list_id=?
        AND NOT EXISTS (SELECT 1 FROM send_logs l WHERE l.campaign_id=? AND l.recipient_id=r.id AND l.status="sent")
        ORDER BY r.id ASC LIMIT ?
    ');
    $stmt->bindValue(1, (int)($campaign['list_id'] ?? 1), PDO::PARAM_INT);
    $stmt->bindValue(2, (int)$campaign['id'], PDO::PARAM_INT);
    $stmt->bindValue(3, $limit, PDO::PARAM_INT);
    $stmt->execute();
    $recipients = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $mailer = new SmtpMailer($config);
    $log = $pdo->prepare('INSERT INTO send_logs (campaign_id, recipient_id, email, tracking_token, status, message, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    $sent = 0;
    foreach ($recipients as $recipient) {
        $token = bin2hex(random_bytes(18));
        try {
            $trackedHtml = addTracking($campaign['body_html'], $token);
            $mailer->send($recipient['email'], $campaign['subject'], $trackedHtml, $recipient);
            $log->execute([$campaign['id'], $recipient['id'], $recipient['email'], $token, 'sent', '', date('c')]);
            $sent++;
            usleep(300000);
        } catch (Throwable $e) {
            $log->execute([$campaign['id'], $recipient['id'], $recipient['email'], $token, 'failed', substr($e->getMessage(), 0, 500), date('c')]);
        }
    }
    return "Sent $sent of " . count($recipients) . " selected recipients.\n";
}

function addTracking(string $html, string $token): string
{
    $base = appBaseUrl();
    $html = preg_replace_callback('/href=(["\'])(.*?)\1/i', function (array $matches) use ($base, $token): string {
        $url = html_entity_decode($matches[2], ENT_QUOTES, 'UTF-8');
        if (!preg_match('/^https?:\/\//i', $url)) {
            return $matches[0];
        }
        $encoded = rtrim(strtr(base64_encode($url), '+/', '-_'), '=');
        return 'href=' . $matches[1] . h($base . '?click=' . $token . '&u=' . $encoded) . $matches[1];
    }, $html) ?? $html;

    $pixel = '<img src="' . h($base . '?open=' . $token) . '" width="1" height="1" alt="" style="display:none;border:0;width:1px;height:1px">';
    if (stripos($html, '</body>') !== false) {
        return str_ireplace('</body>', $pixel . '</body>', $html);
    }
    return $html . $pixel;
}

function appBaseUrl(): string
{
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'www.osobnizkusenosti.cz';
    $path = strtok($_SERVER['REQUEST_URI'] ?? '/email-campaign/', '?') ?: '/email-campaign/';
    if (substr($path, -1) !== '/') {
        $path = dirname($path) . '/';
    }
    return $scheme . '://' . $host . $path;
}

function trackOpen(PDO $pdo, string $token): void
{
    $log = findSendLogByToken($pdo, $token);
    if ($log) {
        $now = date('c');
        $stmt = $pdo->prepare("UPDATE send_logs SET opened_at=CASE WHEN opened_at='' THEN ? ELSE opened_at END WHERE id=?");
        $stmt->execute([$now, $log['id']]);
        recordTrackingEvent($pdo, (int)$log['id'], 'open', '');
    }
    header('Content-Type: image/gif');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    echo base64_decode('R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==');
}

function trackClick(PDO $pdo, string $token, string $encodedUrl): void
{
    $url = base64UrlDecode($encodedUrl);
    if (!preg_match('/^https?:\/\//i', $url)) {
        http_response_code(400);
        exit('Invalid URL');
    }
    $log = findSendLogByToken($pdo, $token);
    if ($log) {
        $now = date('c');
        $stmt = $pdo->prepare("UPDATE send_logs SET clicked_at=CASE WHEN clicked_at='' THEN ? ELSE clicked_at END, click_count=click_count+1 WHERE id=?");
        $stmt->execute([$now, $log['id']]);
        recordTrackingEvent($pdo, (int)$log['id'], 'click', $url);
    }
    header('Location: ' . $url, true, 302);
}

function findSendLogByToken(PDO $pdo, string $token): ?array
{
    if (!preg_match('/^[a-f0-9]{36}$/', $token)) {
        return null;
    }
    $stmt = $pdo->prepare('SELECT * FROM send_logs WHERE tracking_token=? LIMIT 1');
    $stmt->execute([$token]);
    $log = $stmt->fetch(PDO::FETCH_ASSOC);
    return $log ?: null;
}

function recordTrackingEvent(PDO $pdo, int $sendLogId, string $type, string $targetUrl): void
{
    $stmt = $pdo->prepare('INSERT INTO tracking_events (send_log_id, event_type, target_url, user_agent, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    $stmt->execute([
        $sendLogId,
        $type,
        substr($targetUrl, 0, 1000),
        substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 500),
        $ip === '' ? '' : hash('sha256', $ip),
        date('c'),
    ]);
}

function base64UrlDecode(string $value): string
{
    $value = strtr($value, '-_', '+/');
    $value .= str_repeat('=', (4 - strlen($value) % 4) % 4);
    return base64_decode($value, true) ?: '';
}

function campaignDailyLimit(PDO $pdo, array $campaign): array
{
    $manual = max(1, (int)$campaign['daily_limit']);
    if ((int)($campaign['auto_daily_limit'] ?? 1) !== 1) {
        return ['limit' => $manual, 'reason' => 'Rucni limit kampane.'];
    }

    $stmt = $pdo->prepare('
        SELECT substr(sent_at,1,10) day,
               SUM(CASE WHEN status="sent" THEN 1 ELSE 0 END) sent,
               SUM(CASE WHEN status="failed" THEN 1 ELSE 0 END) failed
        FROM send_logs
        WHERE campaign_id=?
        GROUP BY substr(sent_at,1,10)
        ORDER BY day ASC
    ');
    $stmt->execute([(int)$campaign['id']]);
    $days = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $sendingDays = count(array_filter($days, fn($day) => (int)$day['sent'] > 0));
    $recent = array_slice($days, -3);
    $recentSent = array_sum(array_map(fn($day) => (int)$day['sent'], $recent));
    $recentFailed = array_sum(array_map(fn($day) => (int)$day['failed'], $recent));
    $recentTotal = $recentSent + $recentFailed;
    $failureRate = $recentTotal > 0 ? $recentFailed / $recentTotal : 0.0;

    $limit = (int)round(100 * pow(1.2, max(0, $sendingDays - 1)));
    $limit = min($limit, $manual, 300);
    $reason = 'Auto: start 100/den, po uspesnych dnech rust cca 20 %, strop podle rucniho maxima.';

    if ($recentTotal >= 20 && $failureRate >= 0.1) {
        $limit = max(25, (int)floor($limit * 0.5));
        $reason = 'Auto: vysoka chybovost za posledni dny, limit je docasne snizeny.';
    } elseif ($recentTotal >= 20 && $failureRate >= 0.05) {
        $limit = max(50, min($limit, 100));
        $reason = 'Auto: zvysena chybovost za posledni dny, limit se drzi konzervativne.';
    }

    return [
        'limit' => max(1, $limit),
        'reason' => $reason,
        'sending_days' => $sendingDays,
        'failure_rate' => $failureRate,
        'recent_total' => $recentTotal,
    ];
}

function findCampaign(PDO $pdo, int $id): array
{
    $stmt = $pdo->prepare('SELECT * FROM campaigns WHERE id=?');
    $stmt->execute([$id]);
    $campaign = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$campaign) {
        throw new RuntimeException('Kampan nenalezena.');
    }
    return $campaign;
}

function cleanHtml(string $html): string
{
    return preg_replace('#<script\b[^>]*>.*?</script>#is', '', $html) ?? '';
}

function h(?string $text): string
{
    return htmlspecialchars((string)$text, ENT_QUOTES, 'UTF-8');
}

function renderLogin(?array $flash): void
{
    ?><!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email rozesilac</title><link rel="stylesheet" href="assets/app.css"></head><body class="login"><main><form method="post" class="panel narrow"><h1>Email rozesilac</h1><?php renderFlash($flash); ?><label>Heslo<input type="password" name="password" autofocus required></label><button>Prihlasit</button></form></main></body></html><?php
}

function renderSetup(?array $flash): void
{
    ?><!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nastaveni aplikace</title><link rel="stylesheet" href="assets/app.css"></head><body class="login"><main><form method="post" class="panel narrow"><input type="hidden" name="action" value="setup"><h1>Nastaveni aplikace</h1><?php renderFlash($flash); ?><p>Vytvor prvni administracni heslo. Email ucet nastavis po prihlaseni.</p><label>Admin heslo<input type="password" name="new_password" minlength="10" autofocus required></label><button>Vytvorit administraci</button></form></main></body></html><?php
}

function renderFatal(Throwable $e, ?array $flash): void
{
    $message = 'Administraci se nepodarilo nacist: ' . $e->getMessage();
    ?><!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chyba aplikace</title><link rel="stylesheet" href="assets/app.css"></head><body><header><strong>Email rozesilac</strong><a href="?logout=1">Odhlasit</a></header><main><section class="panel narrow"><?php renderFlash($flash); ?><div class="flash error"><?= h($message) ?></div><p class="note">Aplikace zustala dostupna, ale pri nacitani prihlasene casti narazila na chybu. Tento text pomuze opravit konkretni misto bez obecne HTTP 500.</p><a class="button" href="./?route=dashboard">Zkusit znovu</a></section></main></body></html><?php
}

function renderFlash(?array $flash): void
{
    if ($flash) {
        echo '<div class="flash ' . h($flash[0]) . '">' . h($flash[1]) . '</div>';
    }
}

function currentView(): string
{
    $route = trim((string)($_GET['route'] ?? ''), '/');
    $map = ['dashboard' => 'overview', 'contacts' => 'contacts', 'campaigns' => 'campaigns', 'config' => 'config'];
    if (isset($map[$route])) {
        return $map[$route];
    }
    $view = $_GET['view'] ?? 'overview';
    return in_array($view, ['overview', 'contacts', 'campaigns', 'config'], true) ? $view : 'overview';
}

function routeUrl(string $view): string
{
    $map = ['overview' => './?route=dashboard', 'contacts' => './?route=contacts', 'campaigns' => './?route=campaigns', 'config' => './?route=config'];
    return $map[$view] ?? './?route=dashboard';
}

function renderApp(PDO $pdo, ?array $flash): void
{
    global $config;
    $campaigns = $pdo->query('SELECT * FROM campaigns ORDER BY id DESC')->fetchAll(PDO::FETCH_ASSOC);
    $recipients = (int)$pdo->query('SELECT COUNT(*) FROM recipients WHERE status="active"')->fetchColumn();
    $recipientRows = recipientRows($pdo);
    $importRows = importRows($pdo);
    $logs = $pdo->query('SELECT l.*, c.name campaign FROM send_logs l LEFT JOIN campaigns c ON c.id=l.campaign_id ORDER BY l.id DESC LIMIT 20')->fetchAll(PDO::FETCH_ASSOC);
    $lists = contactLists($pdo);
    $current = $campaigns[0] ?? ['id' => 0, 'list_id' => 1, 'name' => '', 'subject' => '', 'body_html' => '<p>Dobry den,</p><p>...</p>', 'daily_limit' => 300, 'batch_limit' => 10, 'auto_daily_limit' => 1, 'status' => 'draft'];
    $pace = campaignDailyLimit($pdo, $current);
    $view = currentView();
    $overview = overviewStats($pdo, $current, $pace, $config);
    ?><!doctype html>
<html lang="cs">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Email rozesilac</title>
    <link rel="stylesheet" href="assets/app.css">
</head>
<body>
<header>
    <strong>Email rozesilac</strong>
    <a href="?logout=1">Odhlasit</a>
</header>
<nav class="tabs">
    <a class="<?= $view === 'overview' ? 'active' : '' ?>" href="<?= h(routeUrl('overview')) ?>">Prehled</a>
    <a class="<?= $view === 'contacts' ? 'active' : '' ?>" href="<?= h(routeUrl('contacts')) ?>">Kontakty</a>
    <a class="<?= $view === 'campaigns' ? 'active' : '' ?>" href="<?= h(routeUrl('campaigns')) ?>">Kampane</a>
    <a class="<?= $view === 'config' ? 'active' : '' ?>" href="<?= h(routeUrl('config')) ?>">Konfigurace</a>
</nav>
<main>
    <?php renderFlash($flash); ?>

    <?php if ($view === 'overview'): ?>
    <section class="stats">
        <div><span>Kontakty</span><strong><?= $recipients ?></strong></div>
        <div><span>Osloveno</span><strong><?= h((string)$overview['contacted']) ?></strong></div>
        <div><span>Otevreno</span><strong><?= h((string)$overview['opened']) ?></strong></div>
        <div><span>Kliknuti</span><strong><?= h((string)$overview['clicks']) ?></strong></div>
        <div><span>Dnes odeslano</span><strong><?= h((string)$overview['sent_today']) ?></strong><small><?= h($config['from_email']) ?></small></div>
        <div><span>Dnes zbyva</span><strong><?= h((string)$overview['remaining_today']) ?></strong></div>
        <div><span>Dnes limit</span><strong><?= h((string)$pace['limit']) ?></strong></div>
        <div><span>Open rate</span><strong><?= h($overview['open_rate']) ?> %</strong></div>
        <div><span>Click-through</span><strong><?= h($overview['ctr']) ?> %</strong></div>
    </section>
    <section class="panel">
        <h2>Stav kampane</h2>
        <table><thead><tr><th>Kampan</th><th>Stav</th><th>Seznam</th><th>Planovano</th><th>Osloveno</th><th>Otevreno</th><th>Kliky</th><th>Zbyva dnes</th></tr></thead><tbody>
            <tr><td><?= h($current['name'] ?: 'Bez kampane') ?></td><td><?= h($current['status'] ?? 'draft') ?></td><td><?= h(listName($lists, (int)($current['list_id'] ?? 1))) ?></td><td><?= h((string)$overview['planned']) ?></td><td><?= h((string)$overview['campaign_sent']) ?></td><td><?= h((string)$overview['campaign_opened']) ?></td><td><?= h((string)$overview['campaign_clicks']) ?></td><td><?= h((string)$overview['remaining_today']) ?></td></tr>
        </tbody></table>
    </section>
    <?php endif; ?>

    <?php if ($view === 'campaigns'): ?>
    <section class="grid">
        <form method="post" class="panel campaign" id="campaignForm">
            <input type="hidden" name="action" value="save_campaign">
            <input type="hidden" name="id" value="<?= h((string)$current['id']) ?>">
            <input type="hidden" name="body_html" id="bodyHtml">
            <h2>Kampan</h2>
            <label>Seznam kontaktu<select name="list_id"><?php foreach ($lists as $list) echo '<option value="'.h((string)$list['id']).'" '.((int)$current['list_id']===(int)$list['id']?'selected':'').'>'.h($list['name']).'</option>'; ?></select></label>
            <label>Nazev<input name="name" value="<?= h($current['name']) ?>" required></label>
            <label>Predmet<input name="subject" value="<?= h($current['subject']) ?>" required></label>
            <div class="row">
                <label>Max denne<input type="number" name="daily_limit" min="1" max="500" value="<?= h((string)$current['daily_limit']) ?>"></label>
                <label>Na spusteni<input type="number" name="batch_limit" min="1" max="100" value="<?= h((string)($current['batch_limit'] ?? 10)) ?>"></label>
            </div>
            <label class="check"><input type="checkbox" name="auto_daily_limit" value="1" <?= (int)($current['auto_daily_limit'] ?? 1) === 1 ? 'checked' : '' ?>> Automaticky ridit denni limit podle dorucitelnosti</label>
            <div class="note">
                Aktualni limit: <strong><?= h((string)$pace['limit']) ?>/den</strong>. <?= h($pace['reason']) ?>
                Sleduji odesilaci dny a SMTP chyby; otevreni, spam stiznosti a reputaci schranky zatim aplikace neumi merit.
            </div>
            <div class="row">
                <label>Stav<select name="status"><option value="draft" <?= $current['status']==='draft'?'selected':'' ?>>Koncept</option><option value="active" <?= $current['status']==='active'?'selected':'' ?>>Aktivni</option><option value="paused" <?= $current['status']==='paused'?'selected':'' ?>>Pozastaveno</option></select></label>
            </div>
            <div class="toolbar"><button type="button" data-cmd="bold">B</button><button type="button" data-cmd="italic">I</button><button type="button" data-cmd="insertUnorderedList">List</button><button type="button" data-link>Link</button></div>
            <div id="editor" class="editor" contenteditable="true"><?= $current['body_html'] ?></div>
            <button>Ulozit kampan</button>
        </form>

        <div class="side">
            <form method="post" class="panel">
                <input type="hidden" name="action" value="test_send">
                <h2>Test</h2>
                <select name="campaign_id"><?php foreach ($campaigns as $c) echo '<option value="'.h((string)$c['id']).'">'.h($c['name']).'</option>'; ?></select>
                <input type="email" name="test_email" placeholder="test@email.cz" required>
                <button>Odeslat test</button>
            </form>

            <form method="post" class="panel">
                <input type="hidden" name="action" value="send_batch">
                <h2>Rozesilka</h2>
                <select name="campaign_id"><?php foreach ($campaigns as $c) echo '<option value="'.h((string)$c['id']).'">'.h($c['name']).' - '.h($c['status']).'</option>'; ?></select>
                <button>Odeslat davku</button>
            </form>
        </div>
    </section>
    <section class="panel">
        <h2>Posledni odeslani</h2>
        <table><thead><tr><th>Kdy</th><th>Kampan</th><th>Email</th><th>Stav</th><th>Zprava</th></tr></thead><tbody>
        <?php foreach ($logs as $log): ?><tr><td><?= h($log['sent_at']) ?></td><td><?= h($log['campaign']) ?></td><td><?= h($log['email']) ?></td><td><?= h($log['status']) ?></td><td><?= h($log['message']) ?></td></tr><?php endforeach; ?>
        </tbody></table>
    </section>
    <?php endif; ?>

    <?php if ($view === 'contacts'): ?>
    <section class="grid">
        <form method="post" enctype="multipart/form-data" class="panel">
            <input type="hidden" name="action" value="import_recipients">
            <h2>Import kontaktu</h2>
            <p>CSV muze mit hlavicku, nebo pevne poradi sloupcu bez hlavicky. Email je unikatni identifikator; duplicitni email se aktualizuje novymi udaji.</p>
            <div class="note">
                <strong>Poradi bez hlavicky:</strong> 1. email, 2. nazev subjektu, 3. webovka.
                <br><strong>Podporovane hlavicky:</strong> email/e-mail/mail, nazev/subjekt/firma/centrum/studio, website/web/url/www/webovka.
                <pre>email,nazev,web
info@studio.cz,Studio Klid,https://studio.cz</pre>
            </div>
            <label>Seznam kontaktu<input name="list_name" value="Vychozi seznam" required></label>
            <input type="file" name="csv" accept=".csv,text/csv" required>
            <button>Importovat</button>
        </form>
        <section class="panel">
            <h2>Seznamy</h2>
            <table><thead><tr><th>Seznam</th><th>Kontakty</th></tr></thead><tbody>
            <?php foreach ($lists as $list): ?><tr><td><?= h($list['name']) ?></td><td><?= h((string)$list['contacts']) ?></td></tr><?php endforeach; ?>
            </tbody></table>
        </section>
    </section>
    <section class="panel">
        <h2>Historie importu</h2>
        <table><thead><tr><th>Kdy</th><th>Seznam</th><th>Soubor</th><th>Radku</th><th>Vlozeno</th><th>Aktualizovano</th><th>Preskoceno</th></tr></thead><tbody>
        <?php foreach ($importRows as $import): ?><tr><td><?= h($import['created_at']) ?></td><td><?= h($import['list_name']) ?></td><td><?= h($import['file_name']) ?></td><td><?= h((string)$import['total_rows']) ?></td><td><?= h((string)$import['inserted_count']) ?></td><td><?= h((string)$import['updated_count']) ?></td><td><?= h((string)$import['skipped_count']) ?></td></tr><?php endforeach; ?>
        </tbody></table>
    </section>
    <section class="panel">
        <h2>Kontakty</h2>
        <div class="note">
            Osloven znamena, ze SMTP server email prijal. Otevreni merime pres pixel a kliky pres sledovane odkazy; nektere emailove aplikace obrazky blokuji nebo prednacitaji, proto jsou to orientacni metriky. Dalsi krok pro odpovedi je IMAP napojeni schranky.
        </div>
        <table>
            <thead><tr><th>Email</th><th>Subjekt</th><th>Web</th><th>Seznam</th><th>Osloven</th><th>Doruceni</th><th>Otevrel</th><th>Kliknul</th><th>Odpovedel</th><th>Posledni aktivita</th></tr></thead>
            <tbody>
            <?php foreach ($recipientRows as $row): ?>
                <tr>
                    <td><?= h($row['email']) ?></td>
                    <td><?= h($row['subject_name']) ?></td>
                    <td><?php if ($row['website']): ?><a href="<?= h($row['website']) ?>" target="_blank" rel="noopener"><?= h($row['website']) ?></a><?php endif; ?></td>
                    <td><?= h($row['list_name'] ?: 'Vychozi seznam') ?></td>
                    <td><?= statusBadge((int)$row['sent_count'] > 0 ? 'ano' : 'ne') ?></td>
                    <td><?= statusBadge((int)$row['sent_count'] > 0 ? 'smtp prijato' : 'nezjisteno') ?></td>
                    <td><?= statusBadge($row['opened_at'] ? 'ano' : 'ne') ?></td>
                    <td><?= statusBadge((int)$row['click_count'] > 0 ? ((int)$row['click_count'] . 'x') : 'ne') ?></td>
                    <td><?= statusBadge('nenapojeno') ?></td>
                    <td><?= h($row['last_activity'] ?: '') ?></td>
                </tr>
            <?php endforeach; ?>
            </tbody>
        </table>
    </section>
    <?php endif; ?>

    <?php if ($view === 'config'): ?>
    <section class="panel">
        <form method="post">
            <input type="hidden" name="action" value="save_settings">
            <h2>Email a IMAP</h2>
            <div class="grid two">
                <div>
                    <h2>SMTP odesilani</h2>
                    <label>Odesilatel email<input type="email" name="from_email" value="<?= h($config['from_email']) ?>" required></label>
                    <label>Odesilatel jmeno<input name="from_name" value="<?= h($config['from_name']) ?>" required></label>
                    <label>SMTP server<input name="smtp_host" value="<?= h($config['smtp']['host']) ?>" required></label>
                    <div class="row">
                        <label>Port<input type="number" name="smtp_port" value="<?= h((string)$config['smtp']['port']) ?>" required></label>
                        <label>Sifrovani<select name="smtp_encryption"><option value="tls" <?= $config['smtp']['encryption']==='tls'?'selected':'' ?>>TLS</option><option value="ssl" <?= $config['smtp']['encryption']==='ssl'?'selected':'' ?>>SSL</option><option value="" <?= $config['smtp']['encryption']===''?'selected':'' ?>>Bez</option></select></label>
                    </div>
                    <label>SMTP uzivatel<input name="smtp_username" value="<?= h($config['smtp']['username']) ?>" required></label>
                    <label>SMTP heslo<input type="password" name="smtp_password" placeholder="Nechat prazdne = nemenit"></label>
                </div>
                <div>
                    <h2>IMAP odpovedi</h2>
                    <label>IMAP server<input name="imap_host" value="<?= h($config['imap']['host']) ?>"></label>
                    <div class="row">
                        <label>Port<input type="number" name="imap_port" value="<?= h((string)$config['imap']['port']) ?>"></label>
                        <label>Sifrovani<select name="imap_encryption"><option value="ssl" <?= $config['imap']['encryption']==='ssl'?'selected':'' ?>>SSL</option><option value="tls" <?= $config['imap']['encryption']==='tls'?'selected':'' ?>>TLS/STARTTLS</option><option value="" <?= $config['imap']['encryption']===''?'selected':'' ?>>Bez</option></select></label>
                    </div>
                    <label>IMAP uzivatel<input name="imap_username" value="<?= h($config['imap']['username']) ?>"></label>
                    <label>IMAP heslo<input type="password" name="imap_password" placeholder="Nechat prazdne = nemenit"></label>
                    <div class="note">IMAP pouzijeme pro rozpoznavani odpovedi podle emailu odesilatele. Samotne parovani odpovedi bude dalsi krok po overeni pripojeni.</div>
                </div>
            </div>
            <label>Nove admin heslo<input type="password" name="new_password" minlength="10" placeholder="Nechat prazdne = nemenit"></label>
            <button>Ulozit konfiguraci</button>
        </form>
    </section>
    <section class="grid two">
        <form method="post" class="panel"><input type="hidden" name="action" value="test_smtp"><h2>SMTP konektivita</h2><p>Overi pripojeni, STARTTLS/SSL a prihlaseni. Email neodesila.</p><button>Otestovat SMTP</button></form>
        <form method="post" class="panel"><input type="hidden" name="action" value="test_imap"><h2>IMAP konektivita</h2><p>Overi pripojeni a prihlaseni do prijate posty.</p><button>Otestovat IMAP</button></form>
    </section>
    <?php endif; ?>
</main>
<script src="assets/app.js"></script>
</body></html><?php
}

function recipientRows(PDO $pdo): array
{
    return $pdo->query('
        SELECT r.email,
               r.subject_name,
               r.website,
               cl.name list_name,
               r.created_at,
               COALESCE(logs.sent_count, 0) sent_count,
               logs.sent_at,
               logs.opened_at,
               logs.clicked_at,
               COALESCE(logs.click_count, 0) click_count,
               COALESCE(logs.last_activity, "") last_activity
        FROM recipients r
        LEFT JOIN contact_lists cl ON cl.id=r.list_id
        LEFT JOIN (
            SELECT recipient_id,
                   SUM(CASE WHEN status="sent" THEN 1 ELSE 0 END) sent_count,
                   MAX(CASE WHEN status="sent" THEN sent_at ELSE "" END) sent_at,
                   MAX(opened_at) opened_at,
                   MAX(clicked_at) clicked_at,
                   SUM(COALESCE(click_count, 0)) click_count,
                   MAX(CASE
                       WHEN clicked_at != "" THEN clicked_at
                       WHEN opened_at != "" THEN opened_at
                       WHEN status="sent" THEN sent_at
                       ELSE ""
                   END) last_activity
            FROM send_logs
            GROUP BY recipient_id
        ) logs ON logs.recipient_id=r.id
        WHERE r.status="active"
        ORDER BY last_activity DESC, r.id DESC
        LIMIT 250
    ')->fetchAll(PDO::FETCH_ASSOC);
}

function importRows(PDO $pdo): array
{
    return $pdo->query('
        SELECT *
        FROM import_runs
        ORDER BY id DESC
        LIMIT 30
    ')->fetchAll(PDO::FETCH_ASSOC);
}

function contactLists(PDO $pdo): array
{
    return $pdo->query('
        SELECT cl.id, cl.name, COUNT(r.id) contacts
        FROM contact_lists cl
        LEFT JOIN recipients r ON r.list_id=cl.id AND r.status="active"
        GROUP BY cl.id
        ORDER BY cl.id ASC
    ')->fetchAll(PDO::FETCH_ASSOC);
}

function listName(array $lists, int $id): string
{
    foreach ($lists as $list) {
        if ((int)$list['id'] === $id) {
            return $list['name'];
        }
    }
    return 'Vychozi seznam';
}

function overviewStats(PDO $pdo, array $campaign, array $pace, array $config): array
{
    $total = (int)$pdo->query('SELECT COUNT(*) FROM recipients WHERE status="active"')->fetchColumn();
    $contacted = (int)$pdo->query('SELECT COUNT(DISTINCT recipient_id) FROM send_logs WHERE status="sent" AND recipient_id IS NOT NULL')->fetchColumn();
    $opened = (int)$pdo->query("SELECT COUNT(DISTINCT recipient_id) FROM send_logs WHERE opened_at!='' AND recipient_id IS NOT NULL")->fetchColumn();
    $clickedContacts = (int)$pdo->query('SELECT COUNT(DISTINCT recipient_id) FROM send_logs WHERE click_count>0 AND recipient_id IS NOT NULL')->fetchColumn();
    $clicks = (int)$pdo->query('SELECT COALESCE(SUM(click_count),0) FROM send_logs')->fetchColumn();
    $today = date('Y-m-d');
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM send_logs WHERE status="sent" AND substr(sent_at,1,10)=?');
    $stmt->execute([$today]);
    $sentToday = (int)$stmt->fetchColumn();

    $campaignId = (int)($campaign['id'] ?? 0);
    $plannedStmt = $pdo->prepare('SELECT COUNT(*) FROM recipients WHERE status="active" AND list_id=?');
    $plannedStmt->execute([(int)($campaign['list_id'] ?? 1)]);
    $planned = (int)$plannedStmt->fetchColumn();

    $campaignSent = $campaignOpened = $campaignClicks = 0;
    if ($campaignId > 0) {
        $metric = $pdo->prepare("SELECT COUNT(*) sent, COUNT(NULLIF(opened_at, '')) opened, COALESCE(SUM(click_count),0) clicks FROM send_logs WHERE campaign_id=? AND status=\"sent\"");
        $metric->execute([$campaignId]);
        $row = $metric->fetch(PDO::FETCH_ASSOC) ?: [];
        $campaignSent = (int)($row['sent'] ?? 0);
        $campaignOpened = (int)($row['opened'] ?? 0);
        $campaignClicks = (int)($row['clicks'] ?? 0);
    }

    return [
        'total' => $total,
        'contacted' => $contacted,
        'opened' => $opened,
        'clicked_contacts' => $clickedContacts,
        'clicks' => $clicks,
        'sent_today' => $sentToday,
        'remaining_today' => max(0, (int)$pace['limit'] - $sentToday),
        'planned' => $planned,
        'campaign_sent' => $campaignSent,
        'campaign_opened' => $campaignOpened,
        'campaign_clicks' => $campaignClicks,
        'open_rate' => $campaignSent > 0 ? number_format($campaignOpened / $campaignSent * 100, 1, '.', '') : '0.0',
        'ctr' => $campaignSent > 0 ? number_format($campaignClicks / $campaignSent * 100, 1, '.', '') : '0.0',
    ];
}

function statusBadge(string $text): string
{
    $class = in_array($text, ['ano', 'smtp prijato'], true) || substr($text, -1) === 'x' ? 'good' : 'muted';
    if (in_array($text, ['nezjisteno', 'nenapojeno'], true)) {
        $class = 'warn';
    }
    return '<span class="badge ' . $class . '">' . h($text) . '</span>';
}
