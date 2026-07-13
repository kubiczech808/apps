<?php

declare(strict_types=1);

const APP_VERSION = '2026-07-05-sender-window-limit';

date_default_timezone_set('Europe/Prague');

session_start();
require __DIR__ . '/src/Database.php';
require __DIR__ . '/src/SmtpMailer.php';

$configPath = __DIR__ . '/config.php';
$baseConfig = file_exists($configPath) ? require $configPath : require __DIR__ . '/config.example.php';
$isMysqlDatabase = true;
$dbWarning = null;
try {
    $databaseConfig = productionDatabaseConfig($baseConfig);
    $runDatabaseMigrations = shouldRunDatabaseMigrations();
    $db = new Database($databaseConfig, $runDatabaseMigrations);
    verifyProductionDatabase($db->pdo());
    if ($runDatabaseMigrations && !isWorkerEndpoint() && !isTrackingEndpoint()) {
        $_SESSION['schema_version'] = APP_VERSION;
    }
} catch (Throwable $e) {
    error_log('Email campaign MySQL startup failed: ' . $e->getMessage());
    renderDatabaseBootFailure($e);
    exit;
}
$pdo = $db->pdo();
if (!empty($runDatabaseMigrations) && isset($_GET['cron'])) {
    try {
        backfillRecipientSources($pdo, 1500);
    } catch (Throwable $e) {
        $dbWarning = trim(($dbWarning ? $dbWarning . ' ' : '') . 'Doplneni zdroju kontaktu selhalo: ' . $e->getMessage());
    }
}
if (shouldRunStartupMaintenance()) {
    try {
        syncContactedBeforeFromLogs($pdo);
        ensureScrapingContainers($pdo);
        backfillCampaignSendRuns($pdo);
        reconcileCampaignSendRunCounts($pdo);
        reconcileCampaignSendRunStatuses($pdo);
        markStaleCampaignRunsQueued($pdo);
        markStaleScrapingRunsQueued($pdo);
        reconcileInterruptedScrapingRuns($pdo);
        reconcileDuplicateScrapingRuns($pdo);
    } catch (Throwable $e) {
        if ($isMysqlDatabase && databasePermissionDenied($e)) {
            $dbWarning = trim(($dbWarning ? $dbWarning . ' ' : '') . 'Startovni udrzba databaze byla preskocena kvuli docasne DB chybe: ' . $e->getMessage());
        } else {
            $dbWarning = trim(($dbWarning ? $dbWarning . ' ' : '') . 'Startovni udrzba databaze selhala: ' . $e->getMessage());
        }
    }
}
$migrationNotice = null;
try {
    $config = effectiveConfig($pdo, $baseConfig);
} catch (Throwable $e) {
    if ($isMysqlDatabase && databasePermissionDenied($e)) {
        renderDatabaseBootFailure($e);
        exit;
    }
    $dbWarning = trim(($dbWarning ? $dbWarning . ' ' : '') . 'Nastaveni aplikace se nepodarilo nacist z databaze: ' . $e->getMessage());
    $config = $baseConfig;
}
$flash = $_SESSION['flash'] ?? null;
unset($_SESSION['flash']);
if ($dbWarning && !$flash) {
    $flash = ['error', $dbWarning];
} elseif ($migrationNotice && !$flash) {
    $flash = ['ok', $migrationNotice];
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'change_language') {
    handleLanguageChange($pdo);
}

if (($_GET['auth'] ?? '') === 'google') {
    try {
        startGoogleAuth($config);
    } catch (Throwable $e) {
        $_SESSION['flash'] = ['error', $e->getMessage()];
        header('Location: ./');
    }
    exit;
}

if (($_GET['auth'] ?? '') === 'google_callback') {
    try {
        handleGoogleAuthCallback($pdo, $config);
    } catch (Throwable $e) {
        $_SESSION['flash'] = ['error', $e->getMessage()];
        header('Location: ./');
    }
    exit;
}

if (isset($_GET['open'])) {
    trackOpen($pdo, (string)$_GET['open']);
    exit;
}

if (isset($_GET['click'], $_GET['u'])) {
    trackClick($pdo, (string)$_GET['click'], (string)$_GET['u']);
    exit;
}

if (isset($_GET['unsubscribe'])) {
    unsubscribeRecipient($pdo, (string)$_GET['unsubscribe']);
    exit;
}

if (isset($_GET['cron'])) {
    header('Content-Type: text/plain; charset=utf-8');
    if ($config['cron_token'] === '' || !hash_equals((string)$config['cron_token'], (string)$_GET['cron'])) {
        http_response_code(403);
        exit("Forbidden\n");
    }
    if (function_exists('set_time_limit')) {
        @set_time_limit(110);
    }
    echo sendBatch($pdo, $config);
    echo "\n" . syncImapReplies($pdo, $config);
    echo "\n" . runCronImports($pdo);
    echo "\n" . runCronScraping($pdo);
    exit;
}

if (($_GET['worker'] ?? '') === 'imports') {
    header('Content-Type: text/plain; charset=utf-8');
    $workerToken = scrapingWorkerToken($pdo, false);
    if ($workerToken === '' || !hash_equals($workerToken, (string)($_GET['token'] ?? ''))) {
        http_response_code(403);
        exit("Forbidden\n");
    }
    echo runImportWorker($pdo);
    exit;
}

if (($_GET['worker'] ?? '') === 'scraping') {
    header('Content-Type: text/plain; charset=utf-8');
    $workerToken = scrapingWorkerToken($pdo, false);
    if ($workerToken === '' || !hash_equals($workerToken, (string)($_GET['token'] ?? ''))) {
        http_response_code(403);
        exit("Forbidden\n");
    }
    echo runScrapingWorker($pdo);
    exit;
}

if (($_GET['worker'] ?? '') === 'campaigns') {
    header('Content-Type: text/plain; charset=utf-8');
    $workerToken = scrapingWorkerToken($pdo, false);
    if ($workerToken === '' || !hash_equals($workerToken, (string)($_GET['token'] ?? ''))) {
        http_response_code(403);
        exit("Forbidden\n");
    }
    echo runCampaignWorker($pdo, $config, (int)($_GET['campaign_id'] ?? 0), (int)($_GET['run_id'] ?? 0));
    exit;
}

if (!isConfigured($config)) {
    if (($_POST['action'] ?? '') === 'setup') {
        try {
            saveSetup($pdo);
            $_SESSION['auth'] = true;
            $_SESSION['auth_email'] = strtolower(trim((string)$_POST['admin_email']));
            $_SESSION['auth_provider'] = 'password';
            $_SESSION['flash'] = ['ok', 'Aplikace je pripravena.'];
            header('Location: ./');
            exit;
        } catch (Throwable $e) {
            $flash = ['error', $e->getMessage()];
        }
    }
    renderSetup($flash, $config);
    exit;
}

if (($_POST['action'] ?? '') === 'login') {
    $loginEmail = strtolower(trim((string)($_POST['email'] ?? '')));
    $adminEmail = strtolower(trim((string)($config['admin_email'] ?? '')));
    if ($loginEmail !== '' && $adminEmail !== '' && hash_equals($adminEmail, $loginEmail) && password_verify((string)$_POST['password'], (string)$config['app_password_hash'])) {
        $_SESSION['auth'] = true;
        $_SESSION['auth_email'] = $adminEmail;
        $_SESSION['auth_provider'] = 'password';
        header('Location: ./?route=dashboard');
        exit;
    }
    $flash = ['error', 'Nespravny email nebo heslo.'];
}

if (isset($_GET['logout'])) {
    session_destroy();
    header('Location: ./');
    exit;
}

if (empty($_SESSION['auth'])) {
    renderLogin($flash, $config);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') !== 'login') {
    try {
        $message = handlePost($pdo, $config);
        $_SESSION['flash'] = ['ok', $message ?: 'Hotovo.'];
        $returnView = currentView();
        header('Location: ' . postReturnUrl($pdo, $returnView));
        exit;
    } catch (Throwable $e) {
        if ($isMysqlDatabase && databasePermissionDenied($e)) {
            renderDatabaseBootFailure($e);
            exit;
        }
        $flash = ['error', $e->getMessage()];
    }
}

try {
    renderApp($pdo, $flash);
} catch (Throwable $e) {
    if ($isMysqlDatabase && databasePermissionDenied($e)) {
        renderDatabaseBootFailure($e);
        exit;
    }
    renderFatal($e, $flash);
}

function handlePost(PDO $pdo, array $config): ?string
{
    $action = $_POST['action'] ?? '';
    if ($action === 'save_smtp_settings') {
        saveSmtpSettings($pdo);
        return 'SMTP nastaveni ulozeno.';
    }

    if ($action === 'save_imap_settings') {
        saveImapSettings($pdo);
        return 'IMAP nastaveni ulozeno.';
    }

    if ($action === 'save_account_settings') {
        saveAccountSettings($pdo, $config);
        return 'Prihlaseni ulozeno.';
    }

    if ($action === 'test_smtp') {
        (new SmtpMailer($config))->testConnection();
        return 'SMTP pripojeni a prihlaseni funguje.';
    }

    if ($action === 'check_email_auth_dns') {
        $report = emailAuthDnsReport($config);
        setSetting($pdo, 'email_auth_dns_report', json_encode($report, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        return emailAuthDnsReportMessage($report);
    }

    if ($action === 'test_imap') {
        testImapConnection($config['imap']);
        return 'IMAP pripojeni a prihlaseni funguje.';
    }

    if ($action === 'sync_imap_replies') {
        return trim(syncImapReplies($pdo, $config));
    }

    if ($action === 'save_campaign') {
        $id = (int)($_POST['id'] ?? 0);
        $dailyLimit = max(1, min(500, (int)$_POST['daily_limit']));
        $scheduleTime = normalizeScheduleTime((string)($_POST['schedule_time'] ?? '09:00'));
        $campaignListId = max(1, (int)$_POST['list_id']);
        if (!contactListExists($pdo, $campaignListId)) {
            throw new RuntimeException('Vybrana databaze kontaktu neni dostupna.');
        }
        $data = [
            $campaignListId,
            trim((string)$_POST['name']),
            trim((string)$_POST['subject']),
            cleanHtml((string)$_POST['body_html']),
            $dailyLimit,
            $dailyLimit,
            isset($_POST['auto_daily_limit']) ? 1 : 0,
            isset($_POST['include_previously_contacted']) ? 1 : 0,
            $scheduleTime,
            in_array($_POST['status'] ?? 'draft', ['draft', 'active', 'paused'], true) ? $_POST['status'] : 'draft',
            date('c'),
        ];
        if ($id > 0) {
            $currentCampaign = findCampaign($pdo, $id);
            $resetSchedule = campaignScheduleConfigChanged($currentCampaign, [
                'list_id' => $data[0],
                'daily_limit' => $data[4],
                'auto_daily_limit' => $data[6],
                'include_previously_contacted' => $data[7],
                'schedule_time' => $data[8],
                'status' => $data[9],
            ]);
            $lastScheduledSql = $resetSchedule ? ', last_scheduled_at=""' : '';
            $stmt = $pdo->prepare('UPDATE campaigns SET list_id=?, name=?, subject=?, body_html=?, daily_limit=?, batch_limit=?, auto_daily_limit=?, include_previously_contacted=?, schedule_time=?, status=?, updated_at=?' . $lastScheduledSql . ' WHERE id=?');
            $stmt->execute([...$data, $id]);
            return 'Kampan ulozena.';
        }
        $stmt = $pdo->prepare('INSERT INTO campaigns (list_id, name, subject, body_html, daily_limit, batch_limit, auto_daily_limit, include_previously_contacted, schedule_time, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        $stmt->execute([...$data, date('c')]);
        return 'Kampan vytvorena.';
    }

    if ($action === 'toggle_campaign_status') {
        return toggleCampaignStatus($pdo, (int)($_POST['campaign_id'] ?? 0));
    }

    if ($action === 'import_recipients') {
        return importRecipients($pdo);
    }

    if ($action === 'create_contact_database') {
        createContactDatabase($pdo, trim((string)($_POST['database_name'] ?? '')));
        return 'Databaze kontaktu vytvorena.';
    }

    if ($action === 'rename_contact_database') {
        renameContactDatabase($pdo, (int)($_POST['database_id'] ?? 0), trim((string)($_POST['database_name'] ?? '')));
        return 'Databaze kontaktu prejmenovana.';
    }

    if ($action === 'archive_contact_database') {
        archiveContactDatabase($pdo, (int)($_POST['database_id'] ?? 0));
        return 'Databaze kontaktu archivovana a skryta napric aplikaci.';
    }

    if ($action === 'add_manual_contact') {
        return addManualContact($pdo);
    }

    if ($action === 'delete_contact') {
        deleteContact($pdo);
        return 'Kontakt odstranen.';
    }

    if ($action === 'create_scraping_job') {
        return createScrapingContainer($pdo);
    }

    if ($action === 'start_scraping_run') {
        return startScrapingRun($pdo, (int)($_POST['container_id'] ?? 0));
    }

    if ($action === 'run_scraping_container_once') {
        return queueScrapingContainerRun($pdo, (int)($_POST['container_id'] ?? 0));
    }

    if ($action === 'save_scraping_schedule') {
        return saveScrapingSchedule($pdo, (int)($_POST['container_id'] ?? 0));
    }

    if ($action === 'toggle_scraping_schedule') {
        return toggleScrapingSchedule($pdo, (int)($_POST['container_id'] ?? 0));
    }

    if ($action === 'delete_scraping_container') {
        deleteScrapingContainer($pdo, (int)($_POST['container_id'] ?? 0));
        return 'Scraping kontejner odstranen.';
    }

    if ($action === 'run_scraping_job') {
        return runScrapingJob($pdo, (int)($_POST['job_id'] ?? 0), 8);
    }

    if ($action === 'cancel_scraping_job') {
        cancelScrapingJob($pdo, (int)($_POST['job_id'] ?? 0));
        return 'Scraping beh prerusen. Jiz vlozene a aktualizovane kontakty zustaly ulozene.';
    }

    if ($action === 'pause_scraping_job') {
        setScrapingJobStatus($pdo, (int)($_POST['job_id'] ?? 0), 'paused');
        return 'Scraping job pozastaven.';
    }

    if ($action === 'resume_scraping_job') {
        setScrapingJobStatus($pdo, (int)($_POST['job_id'] ?? 0), 'queued');
        return 'Scraping job obnoven.';
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
        return queueCampaignBatch($pdo, (int)$_POST['campaign_id']);
    }

    return null;
}

function databasePermissionDenied(Throwable $e): bool
{
    return preg_match('/command denied|access denied.*for table|SELECT command denied/i', $e->getMessage()) === 1;
}

function productionDatabaseConfig(array $baseConfig): array
{
    $databaseConfig = $baseConfig['database'] ?? [];
    if (($databaseConfig['driver'] ?? '') !== 'mysql') {
        throw new RuntimeException('Aplikace je nakonfigurovana bez produkcni MySQL databaze.');
    }
    foreach (['name', 'username', 'password'] as $key) {
        if (!array_key_exists($key, $databaseConfig) || trim((string)$databaseConfig[$key]) === '') {
            throw new RuntimeException('V konfiguraci chybi MySQL hodnota database.' . $key . '.');
        }
    }
    $databaseConfig['host'] = $databaseConfig['host'] ?? 'localhost';
    $databaseConfig['port'] = (int)($databaseConfig['port'] ?? 3306);
    $databaseConfig['charset'] = $databaseConfig['charset'] ?? 'utf8mb4';
    return $databaseConfig;
}

function verifyProductionDatabase(PDO $pdo): void
{
    if (!isMysql($pdo)) {
        throw new RuntimeException('Aplikace smi bezet pouze nad MySQL/MariaDB databazi.');
    }
    $pdo->query('SELECT COUNT(*) FROM contact_databases')->fetchColumn();
}

function isBackgroundEndpoint(): bool
{
    return isset($_GET['cron']) || isWorkerEndpoint();
}

function isWorkerEndpoint(): bool
{
    return in_array((string)($_GET['worker'] ?? ''), ['imports', 'scraping', 'campaigns'], true);
}

function isTrackingEndpoint(): bool
{
    return isset($_GET['open']) || (isset($_GET['click']) && isset($_GET['u']));
}

function shouldRunDatabaseMigrations(): bool
{
    return !isWorkerEndpoint()
        && !isTrackingEndpoint()
        && (isset($_GET['cron']) || empty($_SESSION['auth']) || (string)($_SESSION['schema_version'] ?? '') !== APP_VERSION);
}

function shouldRunStartupMaintenance(): bool
{
    return isset($_GET['cron']);
}

function renderDatabaseBootFailure(Throwable $e): void
{
    http_response_code(500);
    $headline = databasePermissionDenied($e) ? 'MySQL uzivatel nema prava k databazi.' : 'MySQL databaze neni dostupna.';
    ob_start();
    ?><!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chyba databaze</title><link rel="stylesheet" href="<?= h(assetUrl('assets/app.css')) ?>"></head><body><header><strong>Email rozesilac</strong></header><main><section class="panel narrow"><div class="flash error"><?= h($headline) ?> Detail: <?= h($e->getMessage()) ?></div><p class="note">Aplikace je nastavena pouze na produkcni MySQL/MariaDB databazi. Zkontroluj prosim hodnoty APP_DATABASE_NAME, APP_DATABASE_USERNAME a APP_DATABASE_PASSWORD v GitHub Secrets a hlavne prava DB uzivatele pro SELECT/INSERT/UPDATE/DELETE/CREATE/ALTER nad touto databazi.</p></section></main></body></html><?php
    echo localizeHtml((string)ob_get_clean());
}

function effectiveConfig(PDO $pdo, array $config): array
{
    $settings = loadSettings($pdo);
    foreach (['app_password_hash', 'admin_email', 'cron_token', 'from_email', 'from_name'] as $key) {
        if ($key === 'cron_token' && !empty($config[$key])) {
            continue;
        }
        if (!empty($settings[$key])) {
            $config[$key] = $settings[$key];
        }
    }
    if (empty($config['admin_email'])) {
        $config['admin_email'] = $settings['from_email'] ?? ($config['from_email'] ?? '');
    }
    foreach (['host', 'port', 'username', 'password', 'encryption', 'dkim_selector'] as $key) {
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
    $configuredLanguage = trim((string)($settings['ui_language'] ?? ($config['ui_language'] ?? '')));
    if ($configuredLanguage !== '') {
        $config['ui_language'] = normalizeUiLanguage($configuredLanguage);
    }
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
    return (string)$config['app_password_hash'] !== '' && trim((string)($config['admin_email'] ?? '')) !== '';
}

function googleAuthConfig(array $config): array
{
    $google = is_array($config['google'] ?? null) ? $config['google'] : [];
    $clientId = trim((string)($google['client_id'] ?? ''));
    $clientSecret = trim((string)($google['client_secret'] ?? ''));
    $authSecret = trim((string)($google['auth_secret'] ?? ''));
    $redirectUri = trim((string)($google['redirect_uri'] ?? ''));
    $appUrl = trim((string)($google['app_url'] ?? ''));
    return [
        'client_id' => $clientId !== '' ? $clientId : trim((string)(getenv('BTCDCA_GOOGLE_CLIENT_ID') ?: '')),
        'client_secret' => $clientSecret !== '' ? $clientSecret : trim((string)(getenv('BTCDCA_GOOGLE_SECRET') ?: '')),
        'auth_secret' => $authSecret !== '' ? $authSecret : trim((string)(getenv('BTCDCA_AUTH_SECRET') ?: '')),
        'redirect_uri' => $redirectUri !== '' ? $redirectUri : 'https://www.btc-dca.com/app/auth/google/callback',
        'app_url' => rtrim($appUrl !== '' ? $appUrl : 'https://www.btc-dca.com', '/'),
    ];
}

function googleAuthEnabled(array $config): bool
{
    $google = googleAuthConfig($config);
    return $google['client_id'] !== '' && $google['client_secret'] !== '' && $google['auth_secret'] !== '';
}

function requireGoogleAuthConfig(array $config): array
{
    $google = googleAuthConfig($config);
    foreach (['client_id', 'client_secret', 'auth_secret', 'redirect_uri'] as $key) {
        if ($google[$key] === '') {
            throw new RuntimeException('Google prihlaseni neni nakonfigurovane.');
        }
    }
    return $google;
}

function startGoogleAuth(array $config): void
{
    $google = requireGoogleAuthConfig($config);
    $intent = isConfigured($config) ? 'login' : 'setup';
    $nonce = bin2hex(random_bytes(16));
    $_SESSION['google_oauth_nonce'] = $nonce;
    $_SESSION['google_oauth_intent'] = $intent;
    $state = signGoogleState([
        'nonce' => $nonce,
        'intent' => $intent,
        'iat' => time(),
    ], $google['auth_secret']);
    $params = [
        'client_id' => $google['client_id'],
        'redirect_uri' => $google['redirect_uri'],
        'response_type' => 'code',
        'scope' => 'openid email profile',
        'state' => $state,
        'prompt' => 'select_account',
    ];
    header('Location: https://accounts.google.com/o/oauth2/v2/auth?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986));
}

function handleGoogleAuthCallback(PDO $pdo, array $config): void
{
    $google = requireGoogleAuthConfig($config);
    if (($_GET['error'] ?? '') !== '') {
        throw new RuntimeException('Google prihlaseni bylo zruseno nebo odmitnuto.');
    }
    $state = verifyGoogleState((string)($_GET['state'] ?? ''), $google['auth_secret']);
    $sessionNonce = (string)($_SESSION['google_oauth_nonce'] ?? '');
    unset($_SESSION['google_oauth_nonce'], $_SESSION['google_oauth_intent']);
    if ($sessionNonce === '' || !hash_equals($sessionNonce, (string)($state['nonce'] ?? ''))) {
        throw new RuntimeException('Google prihlaseni vyprselo. Zkus to prosim znovu.');
    }
    $code = (string)($_GET['code'] ?? '');
    if ($code === '') {
        throw new RuntimeException('Google nevratil autorizacni kod.');
    }
    $tokens = googleHttpPostJson('https://oauth2.googleapis.com/token', [
        'code' => $code,
        'client_id' => $google['client_id'],
        'client_secret' => $google['client_secret'],
        'redirect_uri' => $google['redirect_uri'],
        'grant_type' => 'authorization_code',
    ]);
    $accessToken = (string)($tokens['access_token'] ?? '');
    if ($accessToken === '') {
        throw new RuntimeException('Google nevratil access token.');
    }
    $profile = googleHttpGetJson('https://openidconnect.googleapis.com/v1/userinfo', [
        'Authorization: Bearer ' . $accessToken,
    ]);
    $email = strtolower(trim((string)($profile['email'] ?? '')));
    $verified = $profile['email_verified'] ?? false;
    if (!filter_var($email, FILTER_VALIDATE_EMAIL) || !($verified === true || $verified === 'true' || $verified === 1 || $verified === '1')) {
        throw new RuntimeException('Google ucet nema overeny email.');
    }

    if (!isConfigured($config)) {
        setSetting($pdo, 'admin_email', $email);
        setSetting($pdo, 'app_password_hash', password_hash(bin2hex(random_bytes(32)), PASSWORD_DEFAULT));
        if (trim((string)($config['cron_token'] ?? '')) === '') {
            setSetting($pdo, 'cron_token', bin2hex(random_bytes(24)));
        }
        $_SESSION['auth'] = true;
        $_SESSION['auth_email'] = $email;
        $_SESSION['auth_provider'] = 'google';
        $_SESSION['flash'] = ['ok', 'Administrace byla vytvorena pres Google ucet. Heslo muzes nastavit v konfiguraci.'];
        header('Location: ./?route=dashboard');
        return;
    }

    $adminEmail = strtolower(trim((string)($config['admin_email'] ?? '')));
    if ($adminEmail === '' || !hash_equals($adminEmail, $email)) {
        throw new RuntimeException('Google ucet ' . $email . ' neni povoleny pro tuto administraci.');
    }
    $_SESSION['auth'] = true;
    $_SESSION['auth_email'] = $adminEmail;
    $_SESSION['auth_provider'] = 'google';
    header('Location: ./?route=dashboard');
}

function signGoogleState(array $payload, string $secret): string
{
    $body = googleBase64UrlEncode(json_encode($payload, JSON_UNESCAPED_SLASHES) ?: '{}');
    $signature = googleBase64UrlEncode(hash_hmac('sha256', $body, $secret, true));
    return $body . '.' . $signature;
}

function verifyGoogleState(string $state, string $secret): array
{
    $parts = explode('.', $state, 2);
    if (count($parts) !== 2) {
        throw new RuntimeException('Neplatny Google OAuth state.');
    }
    [$body, $signature] = $parts;
    $expected = googleBase64UrlEncode(hash_hmac('sha256', $body, $secret, true));
    if (!hash_equals($expected, $signature)) {
        throw new RuntimeException('Neplatny podpis Google OAuth state.');
    }
    $payload = json_decode(googleBase64UrlDecode($body), true);
    if (!is_array($payload) || time() - (int)($payload['iat'] ?? 0) > 600) {
        throw new RuntimeException('Google prihlaseni vyprselo. Zkus to prosim znovu.');
    }
    return $payload;
}

function googleBase64UrlEncode(string $value): string
{
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

function googleBase64UrlDecode(string $value): string
{
    $padding = strlen($value) % 4;
    if ($padding > 0) {
        $value .= str_repeat('=', 4 - $padding);
    }
    return base64_decode(strtr($value, '-_', '+/')) ?: '';
}

function googleHttpPostJson(string $url, array $fields): array
{
    return googleHttpJson($url, 'POST', [
        'Content-Type: application/x-www-form-urlencoded',
    ], http_build_query($fields, '', '&', PHP_QUERY_RFC3986));
}

function googleHttpGetJson(string $url, array $headers): array
{
    return googleHttpJson($url, 'GET', $headers, null);
}

function googleHttpJson(string $url, string $method, array $headers, ?string $body): array
{
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 15);
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        if ($method === 'POST') {
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $response = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);
        curl_close($ch);
        if ($response === false) {
            throw new RuntimeException('Google OAuth request selhal: ' . $error);
        }
    } else {
        $context = stream_context_create([
            'http' => [
                'method' => $method,
                'header' => implode("\r\n", $headers),
                'content' => $body ?? '',
                'timeout' => 15,
                'ignore_errors' => true,
            ],
        ]);
        $response = file_get_contents($url, false, $context);
        $status = 0;
        foreach ($http_response_header ?? [] as $header) {
            if (preg_match('#^HTTP/\S+\s+(\d+)#', $header, $matches)) {
                $status = (int)$matches[1];
                break;
            }
        }
        if ($response === false) {
            throw new RuntimeException('Google OAuth request selhal.');
        }
    }
    $json = json_decode((string)$response, true);
    if (!is_array($json)) {
        throw new RuntimeException('Google vratil necitelnou odpoved.');
    }
    if ($status < 200 || $status >= 300) {
        $message = (string)($json['error_description'] ?? $json['error'] ?? 'Google OAuth request selhal.');
        throw new RuntimeException($message);
    }
    return $json;
}

function saveSetup(PDO $pdo): void
{
    $email = strtolower(trim((string)($_POST['admin_email'] ?? '')));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        throw new RuntimeException('Admin email neni platny.');
    }
    $password = (string)($_POST['new_password'] ?? '');
    if (strlen($password) < 10) {
        throw new RuntimeException('Heslo musi mit alespon 10 znaku.');
    }
    $token = bin2hex(random_bytes(24));
    setSetting($pdo, 'admin_email', $email);
    setSetting($pdo, 'app_password_hash', password_hash($password, PASSWORD_DEFAULT));
    setSetting($pdo, 'cron_token', $token);
}

function saveSmtpSettings(PDO $pdo): void
{
    foreach (['from_email', 'from_name', 'smtp_host', 'smtp_port', 'smtp_username', 'smtp_encryption', 'smtp_dkim_selector'] as $key) {
        setSetting($pdo, $key, trim((string)($_POST[$key] ?? '')));
    }
    $smtpPassword = trim((string)($_POST['smtp_password'] ?? ''));
    if ($smtpPassword !== '') {
        setSetting($pdo, 'smtp_password', $smtpPassword);
    }
}

function saveImapSettings(PDO $pdo): void
{
    foreach (['imap_host', 'imap_port', 'imap_username', 'imap_encryption'] as $key) {
        setSetting($pdo, $key, trim((string)($_POST[$key] ?? '')));
    }
    $imapPassword = trim((string)($_POST['imap_password'] ?? ''));
    if ($imapPassword !== '') {
        setSetting($pdo, 'imap_password', $imapPassword);
    }
}

function emailAuthDomain(array $config): string
{
    $fromEmail = trim((string)($config['from_email'] ?? ''));
    $domain = strtolower((string)substr(strrchr($fromEmail, '@') ?: '', 1));
    return preg_match('/^[a-z0-9.-]+\.[a-z]{2,}$/i', $domain) ? $domain : '';
}

function emailAuthDnsReport(array $config): array
{
    $domain = emailAuthDomain($config);
    $selector = strtolower(trim((string)($config['smtp']['dkim_selector'] ?? '')));
    $checkedAt = date('c');
    if ($domain === '') {
        return [
            'checked_at' => $checkedAt,
            'domain' => '',
            'dkim_selector' => $selector,
            'spf' => ['status' => 'fail', 'message' => 'Odesilaci domena nejde zjistit z emailu odesilatele.', 'records' => []],
            'dkim' => ['status' => 'warn', 'message' => 'Nejprve nastav platny email odesilatele.', 'records' => []],
            'dmarc' => ['status' => 'fail', 'message' => 'Nejprve nastav platny email odesilatele.', 'records' => []],
        ];
    }
    if (!function_exists('dns_get_record')) {
        $message = 'PHP funkce dns_get_record neni na hostingu dostupna, DNS kontrolu nejde provest primo v aplikaci.';
        return [
            'checked_at' => $checkedAt,
            'domain' => $domain,
            'dkim_selector' => $selector,
            'spf' => ['status' => 'warn', 'message' => $message, 'records' => []],
            'dkim' => ['status' => 'warn', 'message' => $message, 'records' => []],
            'dmarc' => ['status' => 'warn', 'message' => $message, 'records' => []],
        ];
    }

    $spfRecords = emailAuthTxtRecords($domain);
    $spfMatches = array_values(array_filter($spfRecords, static fn($record) => stripos($record, 'v=spf1') === 0));
    $spf = $spfMatches
        ? ['status' => 'ok', 'message' => 'SPF zaznam nalezen.', 'records' => $spfMatches]
        : ['status' => 'fail', 'message' => 'SPF zaznam pro domenu nenalezen.', 'records' => $spfRecords];

    $dmarcHost = '_dmarc.' . $domain;
    $dmarcRecords = emailAuthTxtRecords($dmarcHost);
    $dmarcMatches = array_values(array_filter($dmarcRecords, static fn($record) => stripos($record, 'v=DMARC1') === 0));
    if (!$dmarcMatches) {
        $dmarc = ['status' => 'fail', 'message' => 'DMARC zaznam nenalezen na ' . $dmarcHost . '.', 'records' => $dmarcRecords];
    } elseif (preg_match('/;\s*p\s*=\s*none\b/i', $dmarcMatches[0])) {
        $dmarc = ['status' => 'warn', 'message' => 'DMARC existuje, ale politika je p=none. Pro ostre rozesilky je lepsi quarantine nebo reject.', 'records' => $dmarcMatches];
    } else {
        $dmarc = ['status' => 'ok', 'message' => 'DMARC zaznam nalezen.', 'records' => $dmarcMatches];
    }

    if ($selector === '') {
        $dkim = ['status' => 'warn', 'message' => 'DKIM selector neni nastaven. Dopln ho podle poskytovatele SMTP.', 'records' => []];
    } else {
        $dkimHost = $selector . '._domainkey.' . $domain;
        $dkimRecords = emailAuthTxtRecords($dkimHost);
        $dkimMatches = array_values(array_filter($dkimRecords, static fn($record) => stripos($record, 'v=DKIM1') === 0 || preg_match('/(^|;)\s*p\s*=/i', $record)));
        $dkim = $dkimMatches
            ? ['status' => 'ok', 'message' => 'DKIM zaznam nalezen pro selector ' . $selector . '.', 'records' => $dkimMatches]
            : ['status' => 'fail', 'message' => 'DKIM zaznam nenalezen na ' . $dkimHost . '.', 'records' => $dkimRecords];
    }

    return [
        'checked_at' => $checkedAt,
        'domain' => $domain,
        'dkim_selector' => $selector,
        'spf' => $spf,
        'dkim' => $dkim,
        'dmarc' => $dmarc,
    ];
}

function emailAuthTxtRecords(string $host): array
{
    if (!function_exists('dns_get_record')) {
        return [];
    }
    $records = @dns_get_record($host, DNS_TXT);
    if (!is_array($records)) {
        return [];
    }
    $txt = [];
    foreach ($records as $record) {
        if (isset($record['txt'])) {
            $txt[] = trim((string)$record['txt']);
        }
    }
    return array_values(array_filter(array_unique($txt), static fn($value) => $value !== ''));
}

function latestEmailAuthReport(PDO $pdo): array
{
    $settings = loadSettings($pdo);
    $json = (string)($settings['email_auth_dns_report'] ?? '');
    $report = json_decode($json, true);
    return is_array($report) ? $report : [];
}

function emailAuthDnsReportMessage(array $report): string
{
    $parts = [];
    foreach (['spf' => 'SPF', 'dkim' => 'DKIM', 'dmarc' => 'DMARC'] as $key => $label) {
        $item = $report[$key] ?? [];
        $parts[] = $label . ': ' . emailAuthStatusLabel((string)($item['status'] ?? 'unknown')) . ' - ' . (string)($item['message'] ?? '');
    }
    return 'Overeni DNS pro ' . (string)($report['domain'] ?? '') . ': ' . implode(' | ', $parts);
}

function emailAuthStatusLabel(string $status): string
{
    if ($status === 'ok') {
        return 'v poradku';
    }
    if ($status === 'warn') {
        return 'pozor';
    }
    if ($status === 'fail') {
        return 'chyba';
    }
    return 'neovereno';
}

function emailAuthBadge(array $report, string $key): string
{
    $status = (string)($report[$key]['status'] ?? 'unknown');
    $label = strtoupper($key) . ': ' . emailAuthStatusLabel($status);
    $class = $status === 'ok' ? 'good' : ($status === 'warn' || $status === 'fail' ? 'warn' : 'muted');
    return '<span class="badge ' . $class . '">' . h($label) . '</span>';
}

function saveAccountSettings(PDO $pdo, array $config): void
{
    $currentAdminEmail = strtolower(trim((string)($config['admin_email'] ?? '')));
    $adminEmail = strtolower(trim((string)($_POST['admin_email'] ?? $currentAdminEmail)));
    $newPassword = (string)($_POST['new_password'] ?? '');
    $accountChanged = $adminEmail !== $currentAdminEmail || $newPassword !== '';
    if ($accountChanged) {
        if (!filter_var($adminEmail, FILTER_VALIDATE_EMAIL)) {
            throw new RuntimeException('Admin email neni platny.');
        }
        $currentPassword = (string)($_POST['current_password'] ?? '');
        $googleSession = !empty($_SESSION['auth'])
            && (string)($_SESSION['auth_provider'] ?? '') === 'google'
            && hash_equals($currentAdminEmail, strtolower(trim((string)($_SESSION['auth_email'] ?? ''))));
        if (!$googleSession && !password_verify($currentPassword, (string)($config['app_password_hash'] ?? ''))) {
            throw new RuntimeException('Pro zmenu prihlasovacich udaju zadej soucasne heslo.');
        }
        if ($newPassword !== '' && strlen($newPassword) < 10) {
            throw new RuntimeException('Nove heslo musi mit alespon 10 znaku.');
        }
    }
    if ($accountChanged) {
        setSetting($pdo, 'admin_email', $adminEmail);
        $_SESSION['auth_email'] = $adminEmail;
    }
    if ($newPassword !== '') {
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

function syncImapReplies(PDO $pdo, array $config): string
{
    $imap = $config['imap'] ?? [];
    if (!imapConfigured($imap)) {
        return "IMAP odpovedi: nenastaveno.\n";
    }
    $started = time();
    $lastSync = (string)(loadSettings($pdo)['imap_last_sync_at'] ?? '');
    $sinceTime = $lastSync !== '' ? max((int)strtotime($lastSync) - 259200, time() - 2592000) : time() - 2592000;
    $since = date('d-M-Y', $sinceTime);
    try {
        $socket = imapOpenAuthenticated($imap);
        imapCommand($socket, 'a2', 'SELECT INBOX');
        $searchResponse = imapCommand($socket, 'a3', 'SEARCH SINCE ' . $since);
        $ids = array_slice(imapSearchIds($searchResponse), -250);
        $checked = 0;
        $matched = 0;
        $marked = 0;
        foreach ($ids as $id) {
            if (time() - $started > 20) {
                break;
            }
            $header = imapCommand($socket, 'a4', 'FETCH ' . (int)$id . ' (BODY.PEEK[HEADER.FIELDS (FROM DATE SUBJECT)])');
            $fromEmail = imapHeaderEmail($header);
            if (imapLooksLikeBounce($header, $fromEmail)) {
                $body = imapCommand($socket, 'a4b', 'FETCH ' . (int)$id . ' (BODY.PEEK[TEXT])');
                $bouncedEmail = extractBounceEmail($header . "\n" . $body);
                if ($bouncedEmail !== '') {
                    $result = markBounceFromEmail($pdo, $bouncedEmail, imapHeaderDate($header) ?: date('c'), 'IMAP bounce');
                    $matched += $result['matched'] ? 1 : 0;
                    $marked += $result['marked'] ? 1 : 0;
                    $checked++;
                    continue;
                }
            }
            if ($fromEmail === '') {
                continue;
            }
            $checked++;
            $replyAt = imapHeaderDate($header) ?: date('c');
            $result = markReplyFromEmail($pdo, $fromEmail, $replyAt);
            $matched += $result['matched'] ? 1 : 0;
            $marked += $result['marked'] ? 1 : 0;
        }
        imapCommand($socket, 'a5', 'LOGOUT');
        fclose($socket);
        setSetting($pdo, 'imap_last_sync_at', date('c'));
        return 'IMAP odpovedi: zkontrolovano ' . $checked . ' zprav, nalezeno ' . $matched . ' kontaktu, nove oznaceno ' . $marked . ".\n";
    } catch (Throwable $e) {
        return 'IMAP odpovedi: synchronizace selhala: ' . $e->getMessage() . "\n";
    }
}

function imapLooksLikeBounce(string $header, string $fromEmail): bool
{
    return preg_match('/mailer-daemon|postmaster|delivery status|delivery failure|undeliver|returned mail|mail delivery subsystem/i', $header . ' ' . $fromEmail) === 1;
}

function extractBounceEmail(string $text): string
{
    foreach ([
        '/Final-Recipient:\s*rfc822;\s*([^\s<>;]+)/i',
        '/Original-Recipient:\s*rfc822;\s*([^\s<>;]+)/i',
        '/X-Failed-Recipients:\s*([^\s<>;]+)/i',
    ] as $pattern) {
        if (preg_match($pattern, $text, $m)) {
            return extractEmail((string)$m[1]);
        }
    }
    return '';
}

function imapConfigured(array $imap): bool
{
    return trim((string)($imap['host'] ?? '')) !== ''
        && trim((string)($imap['username'] ?? '')) !== ''
        && trim((string)($imap['password'] ?? '')) !== '';
}

function imapOpenAuthenticated(array $imap)
{
    $scheme = ($imap['encryption'] ?? 'ssl') === 'ssl' ? 'ssl://' : '';
    $socket = stream_socket_client($scheme . $imap['host'] . ':' . (int)$imap['port'], $errno, $errstr, 15);
    if (!$socket) {
        throw new RuntimeException("IMAP connection failed: $errstr");
    }
    stream_set_timeout($socket, 15);
    $hello = fgets($socket, 2048) ?: '';
    if (strpos($hello, '* OK') === false) {
        fclose($socket);
        throw new RuntimeException('IMAP server nevratil OK pozdrav.');
    }
    if (($imap['encryption'] ?? 'ssl') === 'tls') {
        imapCommand($socket, 'a0', 'STARTTLS');
        if (!stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
            fclose($socket);
            throw new RuntimeException('STARTTLS se nepodarilo zapnout.');
        }
    }
    imapCommand($socket, 'a1', 'LOGIN "' . addcslashes((string)$imap['username'], "\\\"") . '" "' . addcslashes((string)$imap['password'], "\\\"") . '"');
    return $socket;
}

function imapCommand($socket, string $tag, string $command): string
{
    fwrite($socket, $tag . ' ' . $command . "\r\n");
    $response = '';
    while (($line = fgets($socket, 8192)) !== false) {
        $response .= $line;
        if (strpos($line, $tag . ' ') === 0) {
            break;
        }
    }
    if (!preg_match('/^' . preg_quote($tag, '/') . '\s+OK\b/m', $response)) {
        throw new RuntimeException(trim($response) ?: 'IMAP prikaz selhal.');
    }
    return $response;
}

function imapSearchIds(string $response): array
{
    if (!preg_match('/^\* SEARCH\s*(.*)$/mi', $response, $m)) {
        return [];
    }
    $ids = array_filter(array_map('intval', preg_split('/\s+/', trim((string)$m[1])) ?: []));
    sort($ids);
    return $ids;
}

function imapHeaderEmail(string $header): string
{
    $header = imapUnfoldHeader($header);
    if (!preg_match('/^From:\s*(.+)$/mi', $header, $m)) {
        return '';
    }
    return extractEmail((string)$m[1]);
}

function imapHeaderDate(string $header): string
{
    $header = imapUnfoldHeader($header);
    if (!preg_match('/^Date:\s*(.+)$/mi', $header, $m)) {
        return '';
    }
    $time = strtotime(trim((string)$m[1]));
    return $time ? date('c', $time) : '';
}

function imapUnfoldHeader(string $header): string
{
    return preg_replace("/\r?\n[ \t]+/", ' ', $header) ?? $header;
}

function extractEmail(string $value): string
{
    if (preg_match('/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i', $value, $m)) {
        return strtolower($m[0]);
    }
    return '';
}

function markReplyFromEmail(PDO $pdo, string $email, string $replyAt): array
{
    $stmt = $pdo->prepare('
        SELECT id
        FROM send_logs
        WHERE LOWER(email)=?
          AND status="sent"
          AND sent_at<=?
        ORDER BY sent_at DESC, id DESC
        LIMIT 1
    ');
    $stmt->execute([strtolower($email), $replyAt]);
    $sendLogId = (int)$stmt->fetchColumn();
    if ($sendLogId < 1) {
        return ['matched' => false, 'marked' => false];
    }
    $exists = $pdo->prepare('SELECT replied_at FROM send_logs WHERE id=?');
    $exists->execute([$sendLogId]);
    if ((string)$exists->fetchColumn() !== '') {
        return ['matched' => true, 'marked' => false];
    }
    $update = $pdo->prepare('UPDATE send_logs SET replied_at=? WHERE id=?');
    $update->execute([$replyAt, $sendLogId]);
    recordTrackingEvent($pdo, $sendLogId, 'reply', 'imap:' . strtolower($email));
    return ['matched' => true, 'marked' => true];
}

function markBounceFromEmail(PDO $pdo, string $email, string $bounceAt, string $message): array
{
    $stmt = $pdo->prepare('
        SELECT id, recipient_id
        FROM send_logs
        WHERE LOWER(email)=?
          AND status="sent"
          AND sent_at<=?
        ORDER BY sent_at DESC, id DESC
        LIMIT 1
    ');
    $stmt->execute([strtolower($email), $bounceAt]);
    $log = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$log) {
        return ['matched' => false, 'marked' => false];
    }
    $updateLog = $pdo->prepare('UPDATE send_logs SET status="failed", message=? WHERE id=? AND status="sent"');
    $updateLog->execute([substr('Bounce: ' . $message, 0, 500), (int)$log['id']]);
    if ((int)($log['recipient_id'] ?? 0) > 0) {
        $pdo->prepare('UPDATE recipients SET status="bounced", updated_at=? WHERE id=?')->execute([date('c'), (int)$log['recipient_id']]);
    }
    addSuppression($pdo, strtolower($email), 'bounce', 'imap');
    recordTrackingEvent($pdo, (int)$log['id'], 'bounce', 'imap:' . strtolower($email));
    return ['matched' => true, 'marked' => $updateLog->rowCount() > 0];
}

function importRecipients(PDO $pdo): string
{
    if (!isset($_FILES['csv']) || $_FILES['csv']['error'] !== UPLOAD_ERR_OK) {
        throw new RuntimeException('CSV soubor se nepodarilo nahrat.');
    }
    $listId = selectedPostListId($pdo);
    $dir = __DIR__ . '/storage/imports';
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
        throw new RuntimeException('Nepodarilo se pripravit uloziste importu.');
    }
    $originalName = basename((string)($_FILES['csv']['name'] ?? 'import.csv'));
    $now = date('c');
    $stmt = $pdo->prepare('INSERT INTO import_runs (list_id, list_name, file_name, inserted_count, updated_count, skipped_count, total_rows, status, storage_path, processed_rows, last_message, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 0, 0, "queued", "", 0, ?, ?, ?)');
    $stmt->execute([$listId, contactListName($pdo, $listId), $originalName, 'Soubor nahran, import ceka na zpracovani.', $now, $now]);
    $importRunId = (int)$pdo->lastInsertId();
    $targetPath = $dir . '/import-' . $importRunId . '-' . preg_replace('/[^a-zA-Z0-9._-]+/', '-', $originalName);
    if (!move_uploaded_file($_FILES['csv']['tmp_name'], $targetPath)) {
        $pdo->prepare('UPDATE import_runs SET status="failed", last_message=?, updated_at=?, finished_at=? WHERE id=?')
            ->execute(['Soubor se nepodarilo ulozit na server.', date('c'), date('c'), $importRunId]);
        throw new RuntimeException('Soubor se nepodarilo ulozit na server.');
    }
    $pdo->prepare('UPDATE import_runs SET storage_path=?, updated_at=? WHERE id=?')->execute([$targetPath, date('c'), $importRunId]);
    triggerImportWorker($pdo);
    return 'Import #' . $importRunId . ' byl nahran a bezi na pozadi. Prubeh uvidis v historii importu.';
}

function triggerImportWorker(PDO $pdo): void
{
    $token = scrapingWorkerToken($pdo, true);
    if ($token === '') {
        return;
    }
    fireAndForgetGet(appBaseUrl() . '?worker=imports&token=' . rawurlencode($token));
}

function runCronImports(PDO $pdo): string
{
    markStaleImportRunsQueued($pdo);
    if (activeImportRunsExist($pdo)) {
        triggerImportWorker($pdo);
        return "Import: aktivni import byl predan workeru na pozadi.\n";
    }
    return "Import: zadny aktivni import.\n";
}

function runImportWorker(PDO $pdo): string
{
    markStaleImportRunsQueued($pdo);
    if (function_exists('set_time_limit')) {
        @set_time_limit(110);
    }
    $started = time();
    $messages = [];
    do {
        $messages[] = trim(runImportQueue($pdo, 250));
        if (!activeImportRunsExist($pdo)) {
            break;
        }
    } while (time() - $started < 90);
    return implode("\n", array_filter($messages)) . "\n";
}

function activeImportRunsExist(PDO $pdo): bool
{
    $stmt = $pdo->query('SELECT COUNT(*) FROM import_runs WHERE status="queued"');
    return (int)$stmt->fetchColumn() > 0;
}

function markStaleImportRunsQueued(PDO $pdo): void
{
    $threshold = date('c', time() - 180);
    $stmt = $pdo->prepare('UPDATE import_runs SET status="queued", last_message=?, updated_at=? WHERE status="running" AND updated_at<?');
    $stmt->execute(['Predchozi davka importu skoncila, import ceka na dalsi spusteni.', date('c'), $threshold]);
}

function runImportQueue(PDO $pdo, int $rows): string
{
    $stmt = $pdo->query('SELECT * FROM import_runs WHERE status="queued" ORDER BY id ASC LIMIT 1');
    $run = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$run) {
        return 'Import: zadny aktivni import.';
    }
    return processImportRunBatch($pdo, $run, $rows);
}

function processImportRunBatch(PDO $pdo, array $run, int $limit): string
{
    $claim = $pdo->prepare('UPDATE import_runs SET status="running", last_message=?, updated_at=? WHERE id=? AND status="queued"');
    $claim->execute(['Import se zpracovava.', date('c'), (int)$run['id']]);
    if ($claim->rowCount() === 0) {
        return 'Import #' . (int)$run['id'] . ': zpracovava jina davka.';
    }
    $path = (string)($run['storage_path'] ?? '');
    if ($path === '' || !is_file($path)) {
        updateImportRun($pdo, (int)$run['id'], ['status' => 'failed', 'last_message' => 'Importni soubor nebyl nalezen.', 'finished_at' => date('c')]);
        return 'Import #' . (int)$run['id'] . ': soubor nebyl nalezen.';
    }
    $handle = fopen($path, 'rb');
    if (!$handle) {
        updateImportRun($pdo, (int)$run['id'], ['status' => 'failed', 'last_message' => 'CSV soubor nejde otevrit.', 'finished_at' => date('c')]);
        return 'Import #' . (int)$run['id'] . ': soubor nejde otevrit.';
    }
    $first = fgetcsv($handle, 0, ',');
    if ($first === false) {
        fclose($handle);
        updateImportRun($pdo, (int)$run['id'], ['status' => 'finished', 'last_message' => 'CSV je prazdne.', 'finished_at' => date('c')]);
        return 'Import #' . (int)$run['id'] . ': prazdny soubor.';
    }
    $headers = array_map(fn($v) => strtolower(trim((string)$v)), $first);
    $emailIndex = headerIndex($headers, ['email', 'e-mail', 'mail']);
    $nameIndex = headerIndex($headers, ['name', 'jmeno', 'jméno']);
    $subjectIndex = headerIndex($headers, ['subject_name', 'subject', 'nazev', 'název', 'firma', 'subjekt', 'centrum', 'studio']);
    $websiteIndex = headerIndex($headers, ['website', 'web', 'url', 'www', 'webovka']);
    $addressIndex = headerIndex($headers, ['address', 'adresa', 'ulice', 'sidlo']);
    $contactedIndex = headerIndex($headers, ['contacted', 'contacted_before', 'already_contacted', 'osloven', 'osloveno', 'kampan_poslana', 'kampan_odeslana', 'sent']);
    if ($emailIndex === false) {
        $contactedIndex = 4;
    }
    $processedRows = (int)($run['processed_rows'] ?? 0);
    $rowNum = 0;
    if ($emailIndex === false) {
        $pendingFirst = $first;
    } else {
        $pendingFirst = null;
    }
    while ($rowNum < $processedRows && (($pendingFirst !== null) || (($skip = fgetcsv($handle, 0, ',')) !== false))) {
        if ($pendingFirst !== null) {
            $pendingFirst = null;
        }
        $rowNum++;
    }

    $listId = (int)$run['list_id'];
    $sourceLabel = contactSourceFromImportRun($run);
    $existingStmt = $pdo->prepare('SELECT list_id, subject_name, website, address, name, contacted_before, source_label, source_url FROM recipients WHERE list_id=? AND email=?');
    $insertStmt = $pdo->prepare('INSERT INTO recipients (list_id, email, subject_name, website, address, name, contacted_before, status, created_at, updated_at, source_label, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, "active", ?, ?, ?, "")');
    $updateStmt = $pdo->prepare('UPDATE recipients SET subject_name=?, website=?, address=?, name=?, contacted_before=?, source_label=?, source_url=?, status="active", updated_at=? WHERE list_id=? AND email=?');
    $detailRows = [];
    $inserted = 0;
    $updated = 0;
    $skipped = 0;
    $done = false;
    $processedNow = 0;
    while ($processedNow < $limit) {
        if ($pendingFirst !== null) {
            $row = $pendingFirst;
            $pendingFirst = null;
        } else {
            $row = fgetcsv($handle, 0, ',');
        }
        if ($row === false) {
            $done = true;
            break;
        }
        $rowNum++;
        $processedNow++;
        $email = trim((string)($row[$emailIndex === false ? 0 : $emailIndex] ?? ''));
        $name = trim((string)($nameIndex === false ? '' : ($row[$nameIndex] ?? '')));
        $subjectName = trim((string)($row[$subjectIndex === false ? 1 : $subjectIndex] ?? ''));
        $website = normalizeWebsite(trim((string)($row[$websiteIndex === false ? 2 : $websiteIndex] ?? '')));
        $address = trim((string)($row[$addressIndex === false ? 3 : $addressIndex] ?? ''));
        $contactedBefore = $contactedIndex === false ? 0 : boolish((string)($row[$contactedIndex] ?? ''));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $skipped++;
            $detailRows[] = importDetailRow($rowNum, 'skipped', 'Neplatny nebo prazdny email.', $email, $subjectName, $website, $address, $row);
            continue;
        }
        $existingStmt->execute([$listId, $email]);
        $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
        if (!$existing) {
            $now = date('c');
            $insertStmt->execute([$listId, $email, $subjectName, $website, $address, $name, $contactedBefore, $now, $now, $sourceLabel]);
            $inserted++;
            $detailRows[] = importDetailRow($rowNum, 'inserted', 'Novy kontakt vlozen.', $email, $subjectName, $website, $address, $row);
            continue;
        }
        $fill = recipientFillUpdate($existing, [
            'subject_name' => $subjectName,
            'website' => $website,
            'address' => $address,
            'name' => $name,
            'contacted_before' => $contactedBefore,
            'source_label' => $sourceLabel,
            'source_url' => '',
        ]);
        if ($fill['changes']) {
            $values = $fill['values'];
            $updateStmt->execute([$values['subject_name'], $values['website'], $values['address'], $values['name'], $values['contacted_before'], $values['source_label'], $values['source_url'], date('c'), $listId, $email]);
            $updated++;
            $detailRows[] = importDetailRow($rowNum, 'updated', recipientUpdateMessage($fill['changes']), $email, $values['subject_name'], $values['website'], $values['address'], $row);
        } else {
            $skipped++;
            $detailRows[] = importDetailRow($rowNum, 'skipped', 'Duplicitni email bez chybejicich udaju k doplneni.', $email, $subjectName, $website, $address, $row);
        }
    }
    fclose($handle);
    saveImportDetailRows($pdo, (int)$run['id'], $detailRows);
    $newProcessed = $processedRows + $processedNow;
    $fields = [
        'status' => $done ? 'finished' : 'queued',
        'inserted_count' => (int)$run['inserted_count'] + $inserted,
        'updated_count' => (int)$run['updated_count'] + $updated,
        'skipped_count' => (int)$run['skipped_count'] + $skipped,
        'processed_rows' => $newProcessed,
        'total_rows' => $newProcessed,
        'last_message' => $done ? 'Import dokoncen.' : 'Import bezi na pozadi.',
    ];
    if ($done) {
        $fields['finished_at'] = date('c');
    }
    updateImportRun($pdo, (int)$run['id'], $fields);
    return 'Import #' . (int)$run['id'] . ': zpracovano ' . $newProcessed . ', vlozeno +' . $inserted . ', aktualizovano +' . $updated . ', preskoceno +' . $skipped . '.';
}

function updateImportRun(PDO $pdo, int $id, array $fields): void
{
    $fields['updated_at'] = date('c');
    $sets = [];
    $values = [];
    foreach ($fields as $field => $value) {
        $sets[] = $field . '=?';
        $values[] = $value;
    }
    $values[] = $id;
    $stmt = $pdo->prepare('UPDATE import_runs SET ' . implode(', ', $sets) . ' WHERE id=?');
    $stmt->execute($values);
}

function addManualContact(PDO $pdo): string
{
    $listId = selectedPostListId($pdo);
    $contact = [
        'email' => trim((string)($_POST['email'] ?? '')),
        'subject_name' => trim((string)($_POST['subject_name'] ?? '')),
        'website' => trim((string)($_POST['website'] ?? '')),
        'address' => trim((string)($_POST['address'] ?? '')),
        'name' => '',
        'contacted_before' => isset($_POST['contacted_before']) ? 1 : 0,
        'source_label' => 'Rucni vlozeni',
        'source_url' => '',
    ];
    if (!filter_var($contact['email'], FILTER_VALIDATE_EMAIL)) {
        throw new RuntimeException('Email kontaktu neni platny.');
    }
    $upsert = upsertRecipient($pdo, $listId, $contact);
    $result = $upsert['result'];
    if ($result === 'skipped') {
        return 'Kontakt uz existuje a nebylo co aktualizovat.';
    }
    return $result === 'inserted' ? 'Kontakt vlozen.' : $upsert['message'];
}

function deleteContact(PDO $pdo): void
{
    $listId = selectedPostListId($pdo);
    $email = trim((string)($_POST['email'] ?? ''));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        throw new RuntimeException('Kontakt pro odstraneni neni platny.');
    }
    $stmt = $pdo->prepare('UPDATE recipients SET status="deleted", updated_at=? WHERE list_id=? AND email=?');
    $stmt->execute([date('c'), $listId, $email]);
    if ($stmt->rowCount() === 0) {
        throw new RuntimeException('Kontakt nebyl nalezen.');
    }
}

function tableExists(PDO $pdo, string $table): bool
{
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?');
    $stmt->execute([$table]);
    return (int)$stmt->fetchColumn() > 0;
}

function syncContactedBeforeFromLogs(PDO $pdo): void
{
    if (!tableExists($pdo, 'send_logs') || !tableExists($pdo, 'recipients')) {
        return;
    }
    $pdo->exec('
        UPDATE recipients
        SET contacted_before=1
        WHERE COALESCE(contacted_before, 0)=0
          AND id IN (
              SELECT recipient_id
              FROM send_logs
              WHERE status="sent" AND recipient_id IS NOT NULL
          )
    ');
}

function backfillCampaignSendRuns(PDO $pdo): void
{
    if (!tableExists($pdo, 'send_logs') || !tableExists($pdo, 'campaign_send_runs')) {
        return;
    }
    $rows = $pdo->query('
        SELECT campaign_id,
               MIN(sent_at) first_sent_at,
               MAX(sent_at) last_sent_at,
               COUNT(*) total_count,
               SUM(CASE WHEN status="sent" THEN 1 ELSE 0 END) sent_count,
               SUM(CASE WHEN status="failed" THEN 1 ELSE 0 END) failed_count
        FROM send_logs
        WHERE COALESCE(run_id, 0)=0
        GROUP BY campaign_id
        ORDER BY campaign_id ASC
    ')->fetchAll(PDO::FETCH_ASSOC);
    if (!$rows) {
        return;
    }
    $insert = $pdo->prepare('
        INSERT INTO campaign_send_runs
            (campaign_id, run_type, status, message, planned_count, sent_count, failed_count, created_at, started_at, updated_at, finished_at)
        VALUES (?, "historical", ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ');
    $update = $pdo->prepare('UPDATE send_logs SET run_id=? WHERE COALESCE(run_id, 0)=0 AND campaign_id=?');
    foreach ($rows as $row) {
        $campaignId = (int)$row['campaign_id'];
        if ($campaignId < 1) {
            continue;
        }
        $first = (string)($row['first_sent_at'] ?: date('c'));
        $last = (string)($row['last_sent_at'] ?: $first);
        $total = (int)$row['total_count'];
        $sent = (int)$row['sent_count'];
        $failed = (int)$row['failed_count'];
        $status = campaignRunCompletionStatus($total, $sent, $failed);
        $message = 'Historicky doplneny log rozesilky: ' . $sent . ' odeslano' . ($failed > 0 ? ', chyb ' . $failed : '') . '.';
        $insert->execute([$campaignId, $status, $message, $total, $sent, $failed, $first, $first, $last, $last]);
        $update->execute([(int)$pdo->lastInsertId(), $campaignId]);
    }
}

function reconcileCampaignSendRunStatuses(PDO $pdo): void
{
    if (!tableExists($pdo, 'campaign_send_runs')) {
        return;
    }
    $pdo->exec('
        UPDATE campaign_send_runs
        SET status="failed",
            message=CASE
                WHEN message="" THEN "Rozesilka skoncila chybou u vsech vybranych kontaktu."
                ELSE message
            END
        WHERE status="finished"
          AND planned_count>0
          AND sent_count=0
          AND failed_count>=planned_count
    ');
}

function reconcileCampaignSendRunCounts(PDO $pdo): void
{
    if (!tableExists($pdo, 'campaign_send_runs') || !tableExists($pdo, 'send_logs')) {
        return;
    }
    $rows = $pdo->query('
        SELECT run_id,
               COUNT(*) total_count,
               SUM(CASE WHEN status="sent" THEN 1 ELSE 0 END) sent_count,
               SUM(CASE WHEN status="failed" THEN 1 ELSE 0 END) failed_count,
               MAX(sent_at) last_sent_at
        FROM send_logs
        WHERE COALESCE(run_id, 0)>0
        GROUP BY run_id
    ')->fetchAll(PDO::FETCH_ASSOC);
    if (!$rows) {
        return;
    }
    $update = $pdo->prepare('
        UPDATE campaign_send_runs
        SET sent_count=?,
            failed_count=?,
            planned_count=CASE WHEN planned_count<? THEN ? ELSE planned_count END,
            updated_at=CASE WHEN ? != "" THEN ? ELSE updated_at END
        WHERE id=?
    ');
    foreach ($rows as $row) {
        $total = (int)($row['total_count'] ?? 0);
        $sent = (int)($row['sent_count'] ?? 0);
        $failed = (int)($row['failed_count'] ?? 0);
        $last = (string)($row['last_sent_at'] ?? '');
        $update->execute([$sent, $failed, $total, $total, $last, $last, (int)$row['run_id']]);
    }
}

function campaignRunCompletionStatus(int $planned, int $sent, int $failed): string
{
    if ($planned > 0 && $sent === 0 && $failed >= $planned) {
        return 'failed';
    }
    return 'finished';
}

function importDetailRow(int $rowNumber, string $result, string $reason, string $email, string $subjectName, string $website, string $address, array $raw): array
{
    return [
        'row_num' => $rowNumber,
        'result' => $result,
        'reason' => $reason,
        'email' => $email,
        'subject_name' => $subjectName,
        'website' => $website,
        'address' => $address,
        'raw_data' => json_encode(array_values($raw), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '[]',
    ];
}

function contactSourceFromImportRun(array $run): string
{
    $fileName = trim((string)($run['file_name'] ?? ''));
    if (stripos($fileName, 'scraping:') === 0) {
        return trim(substr($fileName, strlen('scraping:')));
    }
    return $fileName !== '' ? $fileName : 'Manualni import';
}

function contactSourceFromScrapingJob(array $job): string
{
    $sources = scrapingSources();
    $source = $sources[(string)($job['source'] ?? '')] ?? (string)($job['source'] ?? '');
    $keyword = trim((string)($job['keyword'] ?? ''));
    return trim($source . ($keyword !== '' ? ' / ' . $keyword : ''));
}

function backfillRecipientSources(PDO $pdo, int $limit = 1500): void
{
    if (!tableExists($pdo, 'recipients') || !tableExists($pdo, 'import_runs') || !tableExists($pdo, 'import_run_items')) {
        return;
    }
    $settings = loadSettings($pdo);
    $lastImportItemId = max(0, (int)($settings['recipient_source_backfill_import_item_id'] ?? 0));
    $lastScrapingItemId = max(0, (int)($settings['recipient_source_backfill_scraping_item_id'] ?? 0));
    $rows = $pdo->query('
        SELECT iri.id, ir.list_id, ir.file_name, iri.email, iri.raw_data
        FROM import_run_items iri
        JOIN import_runs ir ON ir.id=iri.import_run_id
        WHERE iri.id>' . $lastImportItemId . ' AND iri.email!="" AND iri.result IN ("inserted", "updated")
        ORDER BY iri.id ASC
        LIMIT ' . max(1, $limit) . '
    ')->fetchAll(PDO::FETCH_ASSOC);
    $stmt = $pdo->prepare('
        UPDATE recipients
        SET source_label=CASE WHEN source_label="" THEN ? ELSE source_label END,
            source_url=CASE WHEN source_url="" THEN ? ELSE source_url END,
            updated_at=COALESCE(NULLIF(updated_at, ""), created_at)
        WHERE list_id=? AND email=? AND (source_label="" OR (source_url="" AND ?!=""))
    ');
    foreach ($rows as $row) {
        $email = trim((string)$row['email']);
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            continue;
        }
        $sourceUrl = stripos((string)($row['file_name'] ?? ''), 'scraping:') === 0 ? importItemSourceUrl($row) : '';
        $stmt->execute([
            contactSourceFromImportRun($row),
            $sourceUrl,
            (int)$row['list_id'],
            $email,
            $sourceUrl,
        ]);
        $lastImportItemId = max($lastImportItemId, (int)$row['id']);
    }
    setSetting($pdo, 'recipient_source_backfill_import_item_id', (string)$lastImportItemId);
    if (!tableExists($pdo, 'scraping_jobs') || !tableExists($pdo, 'scraping_job_items')) {
        return;
    }
    $scrapingRows = $pdo->query('
        SELECT i.id, j.list_id, j.source, j.keyword, i.email, i.url
        FROM scraping_job_items i
        JOIN scraping_jobs j ON j.id=i.job_id
        WHERE i.id>' . $lastScrapingItemId . ' AND i.email!="" AND i.status IN ("inserted", "updated")
        ORDER BY i.id ASC
        LIMIT ' . max(1, $limit) . '
    ')->fetchAll(PDO::FETCH_ASSOC);
    foreach ($scrapingRows as $row) {
        $email = trim((string)$row['email']);
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            continue;
        }
        $sourceUrl = (string)($row['url'] ?? '');
        $stmt->execute([
            contactSourceFromScrapingJob($row),
            $sourceUrl,
            (int)$row['list_id'],
            $email,
            $sourceUrl,
        ]);
        $lastScrapingItemId = max($lastScrapingItemId, (int)$row['id']);
    }
    setSetting($pdo, 'recipient_source_backfill_scraping_item_id', (string)$lastScrapingItemId);
}

function importUpdateReason(array $existing, int $listId, string $subjectName, string $website, string $address, string $name, ?int $contactedBefore = null): string
{
    $changes = [];
    if ((int)$existing['list_id'] !== $listId) {
        $changes[] = 'seznam';
    }
    if ($subjectName !== (string)$existing['subject_name']) {
        $changes[] = 'subjekt';
    }
    if ($website !== (string)$existing['website']) {
        $changes[] = 'web';
    }
    if ($address !== (string)$existing['address']) {
        $changes[] = 'adresa';
    }
    if ($name !== (string)$existing['name']) {
        $changes[] = 'jmeno';
    }
    if ($contactedBefore !== null && $contactedBefore !== (int)($existing['contacted_before'] ?? 0)) {
        $changes[] = 'osloven';
    }
    return $changes ? 'Aktualizovana pole: ' . implode(', ', $changes) . '.' : 'Kontakt aktualizovan.';
}

function recipientFillUpdate(array $existing, array $incoming): array
{
    $fields = [
        'subject_name' => 'subjekt',
        'website' => 'web',
        'address' => 'adresa',
        'name' => 'jmeno',
        'source_label' => 'zdroj',
        'source_url' => 'zdrojova URL',
    ];
    $values = [
        'subject_name' => (string)($existing['subject_name'] ?? ''),
        'website' => (string)($existing['website'] ?? ''),
        'address' => (string)($existing['address'] ?? ''),
        'name' => (string)($existing['name'] ?? ''),
        'source_label' => (string)($existing['source_label'] ?? ''),
        'source_url' => (string)($existing['source_url'] ?? ''),
        'contacted_before' => (int)($existing['contacted_before'] ?? 0),
    ];
    $changes = [];
    foreach ($fields as $field => $label) {
        $current = trim($values[$field]);
        $next = trim((string)($incoming[$field] ?? ''));
        if ($current === '' && $next !== '') {
            $values[$field] = $next;
            $changes[] = $label;
        }
    }
    $incomingContacted = !empty($incoming['contacted_before']) ? 1 : 0;
    if ($values['contacted_before'] === 0 && $incomingContacted === 1) {
        $values['contacted_before'] = 1;
        $changes[] = 'drive osloven';
    }
    return ['values' => $values, 'changes' => $changes];
}

function recipientUpdateMessage(array $changes): string
{
    return $changes ? 'Doplneno: ' . implode(', ', $changes) . '.' : 'Duplicita bez chybejicich udaju k doplneni.';
}

function saveImportDetailRows(PDO $pdo, int $importRunId, array $rows): void
{
    if (!$rows) {
        return;
    }
    $stmt = $pdo->prepare('INSERT INTO import_run_items (import_run_id, row_num, result, reason, email, subject_name, website, address, raw_data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    foreach ($rows as $row) {
        $stmt->execute([
            $importRunId,
            $row['row_num'],
            $row['result'],
            substr($row['reason'], 0, 500),
            $row['email'],
            $row['subject_name'],
            $row['website'],
            $row['address'],
            $row['raw_data'],
            date('c'),
        ]);
    }
}

function ensureScrapingContainers(PDO $pdo): void
{
    $jobs = $pdo->query('SELECT * FROM scraping_jobs WHERE container_id=0 ORDER BY id ASC')->fetchAll(PDO::FETCH_ASSOC);
    if (!$jobs) {
        return;
    }
    $find = $pdo->prepare('SELECT id FROM scraping_containers WHERE list_id=? AND source=? AND keyword=? AND status!="deleted" ORDER BY id ASC LIMIT 1');
    $insert = $pdo->prepare('INSERT INTO scraping_containers (list_id, source, keyword, status, created_at, updated_at) VALUES (?, ?, ?, "active", ?, ?)');
    $update = $pdo->prepare('UPDATE scraping_jobs SET container_id=? WHERE id=?');
    foreach ($jobs as $job) {
        $find->execute([(int)$job['list_id'], (string)$job['source'], (string)$job['keyword']]);
        $containerId = (int)$find->fetchColumn();
        if ($containerId === 0) {
            $created = (string)($job['created_at'] ?? date('c'));
            $insert->execute([(int)$job['list_id'], (string)$job['source'], (string)$job['keyword'], $created, date('c')]);
            $containerId = (int)$pdo->lastInsertId();
        }
        $update->execute([$containerId, (int)$job['id']]);
    }
}

function markStaleScrapingRunsQueued(PDO $pdo): void
{
    $threshold = date('c', time() - 120);
    $stmt = $pdo->prepare('UPDATE scraping_jobs SET status="queued", last_message=?, updated_at=? WHERE status="running" AND updated_at<?');
    $stmt->execute(['Predchozi davka skoncila, beh ceka na dalsi spusteni.', date('c'), $threshold]);
}

function reconcileInterruptedScrapingRuns(PDO $pdo): void
{
    $now = date('c');
    $stmt = $pdo->prepare('
        UPDATE scraping_jobs
        SET status="cancelled",
            last_message=CASE WHEN last_message="" THEN "Preruseno uzivatelem. Jiz vlozene a aktualizovane kontakty zustaly ulozene." ELSE last_message END,
            finished_at=CASE WHEN finished_at="" THEN ? ELSE finished_at END,
            updated_at=?
        WHERE status IN ("queued", "running", "paused")
          AND (
              last_message LIKE "Preruseno uzivatelem.%"
              OR EXISTS (
                  SELECT 1
                  FROM scraping_job_items i
                  WHERE i.job_id=scraping_jobs.id
                    AND i.status="cancelled"
                    AND i.message="Preruseno pred zpracovanim."
              )
          )
    ');
    $stmt->execute([$now, $now]);
}

function normalizeScrapingKeyword(string $keyword): string
{
    $keyword = trim(preg_replace('/\s+/', ' ', $keyword) ?? '');
    return function_exists('mb_strtolower') ? mb_strtolower($keyword, 'UTF-8') : strtolower($keyword);
}

function scrapingScheduleFrequency(array $container): string
{
    return (string)($container['schedule_frequency'] ?? 'daily') === 'weekly' ? 'weekly' : 'daily';
}

function scrapingScheduleWeekday(array $container): int
{
    return max(1, min(7, (int)($container['schedule_weekday'] ?? 1)));
}

function scrapingWeekdays(): array
{
    return [
        1 => 'pondeli',
        2 => 'utery',
        3 => 'streda',
        4 => 'ctvrtek',
        5 => 'patek',
        6 => 'sobota',
        7 => 'nedele',
    ];
}

function scrapingScheduleLabel(array $container): string
{
    $time = (string)($container['schedule_time'] ?? '09:00');
    if (scrapingScheduleFrequency($container) === 'weekly') {
        $days = scrapingWeekdays();
        return 'Tydne ' . ($days[scrapingScheduleWeekday($container)] ?? 'pondeli') . ' ' . $time;
    }
    return 'Denne ' . $time;
}

function scrapingScheduleIsDue(array $container): bool
{
    $frequency = scrapingScheduleFrequency($container);
    $last = trim((string)($container['last_scheduled_at'] ?? ''));
    $updated = trim((string)($container['updated_at'] ?? ''));
    $changedAfterLast = $last === '' || ($updated !== '' && strcmp($updated, $last) > 0);
    if ($frequency === 'weekly') {
        if (scrapingScheduleWeekday($container) !== (int)date('N')) {
            return false;
        }
        if ($last === '') {
            return true;
        }
        $lastTime = strtotime($last);
        return $changedAfterLast || !$lastTime || date('o-W', $lastTime) !== date('o-W');
    }
    return $last === '' || substr($last, 0, 10) !== date('Y-m-d') || $changedAfterLast;
}

function scrapingJobParamKey(array $job): string
{
    return (int)($job['list_id'] ?? 0) . '|' . (string)($job['source'] ?? '') . '|' . normalizeScrapingKeyword((string)($job['keyword'] ?? ''));
}

function scrapingRunPriority(array $job): array
{
    $contacts = (int)($job['inserted_count'] ?? 0) + (int)($job['updated_count'] ?? 0);
    $statusScore = (string)($job['status'] ?? '') === 'running' ? 2 : ((string)($job['status'] ?? '') === 'queued' ? 1 : 0);
    return [
        $contacts,
        (int)($job['processed_count'] ?? 0),
        (int)($job['discovered_count'] ?? 0),
        $statusScore,
        (int)($job['id'] ?? 0),
    ];
}

function activeScrapingRunForParams(PDO $pdo, array $container): int
{
    $stmt = $pdo->prepare('SELECT id, keyword FROM scraping_jobs WHERE list_id=? AND source=? AND status IN ("queued","running","paused") ORDER BY id DESC');
    $stmt->execute([(int)$container['list_id'], (string)$container['source']]);
    $wanted = normalizeScrapingKeyword((string)$container['keyword']);
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $job) {
        if (normalizeScrapingKeyword((string)$job['keyword']) === $wanted) {
            return (int)$job['id'];
        }
    }
    return 0;
}

function reconcileDuplicateScrapingRuns(PDO $pdo): void
{
    $jobs = $pdo->query('SELECT * FROM scraping_jobs WHERE status IN ("queued","running","paused") ORDER BY id DESC')->fetchAll(PDO::FETCH_ASSOC);
    if (count($jobs) < 2) {
        return;
    }

    $groups = [];
    foreach ($jobs as $job) {
        $groups[scrapingJobParamKey($job)][] = $job;
    }

    $cancel = $pdo->prepare('UPDATE scraping_jobs SET status="cancelled", last_message=?, finished_at=?, updated_at=? WHERE id=?');
    foreach ($groups as $group) {
        if (count($group) < 2) {
            continue;
        }
        usort($group, function (array $a, array $b): int {
            $aPriority = scrapingRunPriority($a);
            $bPriority = scrapingRunPriority($b);
            foreach ($aPriority as $index => $value) {
                $other = $bPriority[$index] ?? 0;
                if ($value === $other) {
                    continue;
                }
                return $value < $other ? 1 : -1;
            }
            return 0;
        });
        array_shift($group);
        foreach ($group as $duplicate) {
            $now = date('c');
            $cancel->execute(['Zruseno: duplicitni beh stejneho scrapingu.', $now, $now, (int)$duplicate['id']]);
        }
    }
}

function createScrapingContainer(PDO $pdo): string
{
    $source = (string)($_POST['source'] ?? 'firmy_cz');
    if (!array_key_exists($source, scrapingSources())) {
        throw new RuntimeException('Neznamy zdroj dat.');
    }
    $keyword = trim((string)($_POST['keyword'] ?? ''));
    if ($keyword === '') {
        throw new RuntimeException('Zadej klicove slovo pro scraping.');
    }
    $listId = selectedPostListId($pdo);
    $find = $pdo->prepare('SELECT id, keyword FROM scraping_containers WHERE list_id=? AND source=? AND status!="deleted" ORDER BY id ASC');
    $find->execute([$listId, $source]);
    $wanted = normalizeScrapingKeyword($keyword);
    foreach ($find->fetchAll(PDO::FETCH_ASSOC) as $existing) {
        if (normalizeScrapingKeyword((string)$existing['keyword']) === $wanted) {
            return 'Scraping kontejner se stejnymi parametry uz existuje.';
        }
    }
    $now = date('c');
    $stmt = $pdo->prepare('INSERT INTO scraping_containers (list_id, source, keyword, status, created_at, updated_at) VALUES (?, ?, ?, "active", ?, ?)');
    $stmt->execute([$listId, $source, $keyword, $now, $now]);
    return 'Scraping kontejner vytvoren. Spust novy beh ve sloupci Akce.';
}

function startScrapingRun(PDO $pdo, int $containerId): string
{
    $container = findScrapingContainer($pdo, $containerId);
    if ($container['status'] !== 'active') {
        throw new RuntimeException('Scraping kontejner neni aktivni.');
    }
    $existingJobId = activeScrapingRunForParams($pdo, $container);
    if ($existingJobId > 0) {
        triggerScrapingWorker($pdo);
        return 'Scraping uz je rozpracovany jako beh #' . $existingJobId . '.';
    }
    $jobId = createScrapingRun($pdo, $container);
    triggerScrapingWorker($pdo);
    return 'Novy scraping beh #' . $jobId . ' vytvoren.';
}

function createScrapingRun(PDO $pdo, array $container, string $message = 'Beh ceka na spusteni.', string $runType = 'manual'): int
{
    $existingJobId = activeScrapingRunForParams($pdo, $container);
    if ($existingJobId > 0) {
        return $existingJobId;
    }
    $runType = $runType === 'scheduled' ? 'scheduled' : 'manual';
    $now = date('c');
    $stmt = $pdo->prepare('INSERT INTO scraping_jobs (container_id, list_id, source, keyword, status, max_pages, max_sites, last_message, run_type, discovery_done, created_at, updated_at) VALUES (?, ?, ?, ?, "queued", ?, ?, ?, ?, 0, ?, ?)');
    $stmt->execute([(int)$container['id'], (int)$container['list_id'], (string)$container['source'], (string)$container['keyword'], 0, 0, $message, $runType, $now, $now]);
    return (int)$pdo->lastInsertId();
}

function queueScrapingContainerRun(PDO $pdo, int $containerId): string
{
    $container = findScrapingContainer($pdo, $containerId);
    if ($container['status'] !== 'active') {
        throw new RuntimeException('Scraping kontejner neni aktivni.');
    }
    $existingJobId = activeScrapingRunForParams($pdo, $container);
    if ($existingJobId > 0) {
        triggerScrapingWorker($pdo);
        return 'Scraping uz je rozpracovany jako beh #' . $existingJobId . '. Bezi na pozadi, prubeh najdes v logu kontejneru.';
    }
    $jobId = createScrapingRun($pdo, $container, 'Jednorazovy beh zalozen z administrace.', 'manual');
    triggerScrapingWorker($pdo);
    return 'Scraping beh #' . $jobId . ' byl zalozen a spusten na pozadi.';
}

function saveScrapingSchedule(PDO $pdo, int $containerId): string
{
    $container = findScrapingContainer($pdo, $containerId);
    $time = trim((string)($_POST['schedule_time'] ?? '09:00'));
    if (!preg_match('/^\d{2}:\d{2}$/', $time)) {
        throw new RuntimeException('Cas planu musi byt ve formatu HH:MM.');
    }
    [$hour, $minute] = array_map('intval', explode(':', $time));
    if ($hour > 23 || $minute > 59) {
        throw new RuntimeException('Cas planu neni platny.');
    }
    $newTime = sprintf('%02d:%02d', $hour, $minute);
    $frequency = in_array((string)($_POST['schedule_frequency'] ?? 'daily'), ['daily', 'weekly'], true) ? (string)$_POST['schedule_frequency'] : 'daily';
    $weekday = max(1, min(7, (int)($_POST['schedule_weekday'] ?? 1)));
    $changed = $newTime !== (string)($container['schedule_time'] ?? '')
        || $frequency !== scrapingScheduleFrequency($container)
        || $weekday !== scrapingScheduleWeekday($container);
    if ($changed) {
        $stmt = $pdo->prepare('UPDATE scraping_containers SET schedule_time=?, schedule_frequency=?, schedule_weekday=?, last_scheduled_at="", updated_at=? WHERE id=?');
        $stmt->execute([$newTime, $frequency, $weekday, date('c'), $containerId]);
        return 'Plan scrapingu ulozen. Posledni planovane spusteni bylo resetovano, aby se nove nastaveni mohlo vyhodnotit znovu.';
    }
    $stmt = $pdo->prepare('UPDATE scraping_containers SET schedule_time=?, schedule_frequency=?, schedule_weekday=?, updated_at=? WHERE id=?');
    $stmt->execute([$newTime, $frequency, $weekday, date('c'), $containerId]);
    return 'Plan scrapingu ulozen.';
}

function toggleScrapingSchedule(PDO $pdo, int $containerId): string
{
    $container = findScrapingContainer($pdo, $containerId);
    $enabled = (int)($container['schedule_enabled'] ?? 0) === 1 ? 0 : 1;
    if ($enabled === 1) {
        $stmt = $pdo->prepare('UPDATE scraping_containers SET schedule_enabled=?, last_scheduled_at="", updated_at=? WHERE id=?');
        $stmt->execute([$enabled, date('c'), $containerId]);
    } else {
        $stmt = $pdo->prepare('UPDATE scraping_containers SET schedule_enabled=?, updated_at=? WHERE id=?');
        $stmt->execute([$enabled, date('c'), $containerId]);
    }
    return $enabled === 1 ? 'Plan scrapingu aktivovan.' : 'Plan scrapingu pozastaven.';
}

function scheduleDueScrapingRuns(PDO $pdo): string
{
    $nowTime = date('H:i');
    $stmt = $pdo->prepare('
        SELECT c.*
        FROM scraping_containers c
        JOIN contact_databases cl ON cl.id=c.list_id
        WHERE c.status="active"
          AND c.schedule_enabled=1
          AND c.schedule_time<=?
          AND COALESCE(cl.archived, 0)=0
        ORDER BY c.schedule_time ASC, c.id ASC
        LIMIT 50
    ');
    $stmt->execute([$nowTime]);
    $containers = array_values(array_filter($stmt->fetchAll(PDO::FETCH_ASSOC), 'scrapingScheduleIsDue'));
    $containers = array_slice($containers, 0, 5);
    if (!$containers) {
        return "Scraping plan: nic ke spusteni.\n";
    }
    $messages = [];
    $mark = $pdo->prepare('UPDATE scraping_containers SET last_scheduled_at=?, updated_at=? WHERE id=?');
    $triggerWorker = false;
    foreach ($containers as $container) {
        $existingJobId = activeScrapingRunForParams($pdo, $container);
        if ($existingJobId > 0) {
            $messages[] = 'Kontejner #' . (int)$container['id'] . ': ma rozpracovany beh #' . $existingJobId . ', plan zustava cekat.';
            $triggerWorker = true;
            continue;
        }
        $jobId = createScrapingRun($pdo, $container, 'Automaticky planovany beh.', 'scheduled');
        $mark->execute([date('c'), date('c'), (int)$container['id']]);
        $messages[] = 'Kontejner #' . (int)$container['id'] . ' (' . scrapingScheduleLabel($container) . '): zalozen planovany beh #' . $jobId . '.';
        $triggerWorker = true;
    }
    if ($triggerWorker) {
        triggerScrapingWorker($pdo);
    }
    return "Scraping plan: " . implode(' ', $messages) . "\n";
}

function runCronScraping(PDO $pdo): string
{
    $messages = [trim(scheduleDueScrapingRuns($pdo))];
    if (activeScrapingJobsExist($pdo)) {
        triggerScrapingWorker($pdo);
        $messages[] = 'Scraping: aktivni beh byl predan workeru na pozadi.';
    } else {
        $messages[] = 'Scraping: zadny aktivni job.';
    }
    return implode("\n", array_filter($messages)) . "\n";
}

function scrapingContainerHasOpenRun(PDO $pdo, int $containerId): bool
{
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM scraping_jobs WHERE container_id=? AND status IN ("queued","running","paused")');
    $stmt->execute([$containerId]);
    return (int)$stmt->fetchColumn() > 0;
}

function deleteScrapingContainer(PDO $pdo, int $containerId): void
{
    $container = findScrapingContainer($pdo, $containerId);
    if (scrapingContainerHasOpenRun($pdo, $containerId)) {
        throw new RuntimeException('Kontejner nejde odstranit, dokud ma rozpracovany beh. Nejprve ho pozastav nebo nech dobehnout.');
    }
    $stmt = $pdo->prepare('UPDATE scraping_containers SET status="deleted", updated_at=? WHERE id=?');
    $stmt->execute([date('c'), (int)$container['id']]);
}

function findScrapingContainer(PDO $pdo, int $containerId): array
{
    $stmt = $pdo->prepare('SELECT * FROM scraping_containers WHERE id=?');
    $stmt->execute([$containerId]);
    $container = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$container) {
        throw new RuntimeException('Scraping kontejner nenalezen.');
    }
    return $container;
}

function runScrapingQueue(PDO $pdo, int $steps): string
{
    markStaleScrapingRunsQueued($pdo);
    reconcileInterruptedScrapingRuns($pdo);
    reconcileDuplicateScrapingRuns($pdo);
    $jobs = $pdo->query('
        SELECT j.*
        FROM scraping_jobs j
        JOIN contact_databases cl ON cl.id=j.list_id
        WHERE j.status IN ("queued","running")
          AND COALESCE(cl.archived, 0)=0
        ORDER BY j.id ASC
        LIMIT 20
    ')->fetchAll(PDO::FETCH_ASSOC);
    if (!$jobs) {
        return "Scraping: zadny aktivni job.\n";
    }
    $messages = [];
    $seen = [];
    foreach ($jobs as $job) {
        $key = scrapingJobParamKey($job);
        if (isset($seen[$key])) {
            continue;
        }
        $seen[$key] = true;
        $messages[] = trim(runScrapingJob($pdo, (int)$job['id'], $steps));
        if (count($messages) >= 3) {
            break;
        }
    }
    return implode("\n", $messages) . "\n";
}

function runScrapingWorker(PDO $pdo): string
{
    ignore_user_abort(true);
    if (function_exists('set_time_limit')) {
        @set_time_limit(70);
    }
    $now = time();
    $lockUntil = (int)(loadSettings($pdo)['scraping_worker_lock_until'] ?? 0);
    if ($lockUntil > $now) {
        return "Scraping worker: uz bezi.\n";
    }
    setSetting($pdo, 'scraping_worker_lock_until', (string)($now + 75));
    $started = time();
    $messages = [];
    try {
        do {
            $messages[] = trim(runScrapingQueue($pdo, 8));
            setSetting($pdo, 'scraping_worker_lock_until', (string)(time() + 75));
            if (!activeScrapingJobsExist($pdo)) {
                break;
            }
            usleep(250000);
        } while (time() - $started < 45);
    } finally {
        setSetting($pdo, 'scraping_worker_lock_until', '');
    }
    if (activeScrapingJobsExist($pdo)) {
        triggerScrapingWorker($pdo);
    }
    return implode("\n", array_filter($messages)) . "\n";
}

function activeScrapingJobsExist(PDO $pdo): bool
{
    $count = (int)$pdo->query('
        SELECT COUNT(*)
        FROM scraping_jobs j
        JOIN contact_databases cl ON cl.id=j.list_id
        WHERE j.status IN ("queued","running")
          AND COALESCE(cl.archived, 0)=0
    ')->fetchColumn();
    return $count > 0;
}

function triggerScrapingWorker(PDO $pdo): void
{
    $token = scrapingWorkerToken($pdo, true);
    fireAndForgetGet(appBaseUrl() . '?worker=scraping&token=' . rawurlencode($token));
}

function scrapingWorkerToken(PDO $pdo, bool $create): string
{
    $settings = loadSettings($pdo);
    $token = (string)($settings['scraping_worker_token'] ?? '');
    if ($token === '' && $create) {
        $token = bin2hex(random_bytes(24));
        setSetting($pdo, 'scraping_worker_token', $token);
    }
    return $token;
}

function fireAndForgetGet(string $url): void
{
    $parts = parse_url($url);
    if (!$parts || empty($parts['host'])) {
        return;
    }
    $scheme = strtolower((string)($parts['scheme'] ?? 'https'));
    $host = (string)$parts['host'];
    $port = (int)($parts['port'] ?? ($scheme === 'https' ? 443 : 80));
    $path = (string)($parts['path'] ?? '/');
    if (!empty($parts['query'])) {
        $path .= '?' . $parts['query'];
    }
    $target = ($scheme === 'https' ? 'ssl://' : '') . $host;
    $socket = @fsockopen($target, $port, $errno, $errstr, 1.0);
    if (!$socket) {
        return;
    }
    stream_set_timeout($socket, 1);
    fwrite($socket, "GET $path HTTP/1.1\r\nHost: $host\r\nConnection: Close\r\nUser-Agent: EmailCampaignWorker/1.0\r\n\r\n");
    fclose($socket);
}

function runScrapingJob(PDO $pdo, int $jobId, int $steps = 8): string
{
    $job = findScrapingJob($pdo, $jobId);
    if (in_array($job['status'], ['paused', 'finished', 'failed', 'cancelled'], true)) {
        return 'Scraping job neni aktivni.';
    }

    $startFields = ['status' => 'running'];
    if (trim((string)($job['started_at'] ?? '')) === '') {
        $startFields['started_at'] = date('c');
    }
    updateScrapingJob($pdo, $jobId, $startFields);
    $messages = [];
    try {
        for ($i = 0; $i < $steps; $i++) {
            $job = findScrapingJob($pdo, $jobId);
            if (in_array($job['status'], ['paused', 'finished', 'failed', 'cancelled'], true)) {
                break;
            }
            $item = nextScrapingItem($pdo, $jobId);
            $discoveryDone = (int)($job['discovery_done'] ?? 0) === 1;
            if (!$discoveryDone && queuedScrapingItemCount($pdo, $jobId) < scrapingDiscoveryBuffer((string)$job['source'])) {
                $messages[] = discoverScrapingPage($pdo, $job);
                $job = findScrapingJob($pdo, $jobId);
                if (in_array($job['status'], ['finished', 'failed', 'paused', 'cancelled'], true)) {
                    break;
                }
                $item = nextScrapingItem($pdo, $jobId);
                $discoveryDone = (int)($job['discovery_done'] ?? 0) === 1;
                if (!$item && !$discoveryDone) {
                    continue;
                }
            }
            if ($item) {
                $messages[] = processScrapingItem($pdo, $job, $item);
                continue;
            }

            if ($discoveryDone) {
                finishScrapingJob($pdo, $jobId, 'Dokonceno: zdroj i vsechny nalezene kontakty jsou zpracovane.');
                break;
            }
            $messages[] = discoverScrapingPage($pdo, $job);
        }
    } catch (Throwable $e) {
        failScrapingJob($pdo, $jobId, 'Chyba behu: ' . $e->getMessage());
        throw $e;
    }

    refreshScrapingJobCounters($pdo, $jobId);
    $job = findScrapingJob($pdo, $jobId);
    if ($job['status'] === 'running') {
        updateScrapingJob($pdo, $jobId, [
            'status' => 'queued',
        ]);
    }
    return 'Scraping job #' . $jobId . ': ' . implode(' ', array_filter($messages));
}

function runScrapingJobToCompletion(PDO $pdo, int $jobId): string
{
    if (function_exists('set_time_limit')) {
        @set_time_limit(0);
    }
    $started = time();
    $rounds = 0;
    do {
        $rounds++;
        runScrapingJob($pdo, $jobId, 50);
        $job = findScrapingJob($pdo, $jobId);
        if (in_array($job['status'], ['finished', 'failed', 'paused', 'cancelled'], true)) {
            return 'Jednorazovy scraping skoncil: ' . scrapingJobOutcomeText($job);
        }
        if ($job['status'] === 'queued' && str_starts_with((string)($job['last_message'] ?? ''), 'Docasna chyba zdroje:')) {
            return 'Jednorazovy scraping zustal ve fronte: ' . (string)$job['last_message'];
        }
        if ($rounds >= 200 || time() - $started > 240) {
            updateScrapingJob($pdo, $jobId, [
                'status' => 'queued',
                'last_message' => 'Nedokonceno: beh pokracuje ve fronte kvuli casovemu limitu hostingu.',
            ]);
            return 'Jednorazovy scraping bezi dal ve fronte kvuli casovemu limitu hostingu.';
        }
    } while (true);
}

function findScrapingJob(PDO $pdo, int $jobId): array
{
    $stmt = $pdo->prepare('SELECT * FROM scraping_jobs WHERE id=?');
    $stmt->execute([$jobId]);
    $job = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$job) {
        throw new RuntimeException('Scraping job nenalezen.');
    }
    return $job;
}

function nextScrapingItem(PDO $pdo, int $jobId): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM scraping_job_items WHERE job_id=? AND status="queued" ORDER BY id ASC LIMIT 1');
    $stmt->execute([$jobId]);
    $item = $stmt->fetch(PDO::FETCH_ASSOC);
    return $item ?: null;
}

function queuedScrapingItemCount(PDO $pdo, int $jobId): int
{
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM scraping_job_items WHERE job_id=? AND status="queued"');
    $stmt->execute([$jobId]);
    return (int)$stmt->fetchColumn();
}

function scrapingDiscoveryBuffer(string $source = ''): int
{
    return [
        'dasoertliche_de' => 250,
        'dastelefonbuch_de' => 250,
        'gelbeseiten_de' => 300,
        'pkt_pl' => 300,
        'merchantcircle_us' => 250,
        'yellowpages_ca' => 250,
    ][$source] ?? 10000;
}

function recentNoEmailScrapingCacheDays(string $source): int
{
    return [
        'dasoertliche_de' => 30,
        'dastelefonbuch_de' => 21,
        'gelbeseiten_de' => 21,
        'pkt_pl' => 21,
        'merchantcircle_us' => 21,
        'yellowpages_ca' => 21,
    ][$source] ?? 14;
}

function completeScrapingContactFromKnownUrl(PDO $pdo, array $job, string $url): ?array
{
    if ($url === '') {
        return null;
    }
    $stmt = $pdo->prepare('
        SELECT email, subject_name, website, address
        FROM recipients
        WHERE list_id=?
          AND source_url=?
          AND status="active"
          AND COALESCE(archived, 0)=0
          AND email!=""
          AND subject_name!=""
          AND website!=""
          AND address!=""
        ORDER BY id DESC
        LIMIT 1
    ');
    $stmt->execute([(int)$job['list_id'], $url]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function recentNoEmailScrapingItem(PDO $pdo, array $job, string $url): ?array
{
    if ($url === '') {
        return null;
    }
    $days = recentNoEmailScrapingCacheDays((string)$job['source']);
    if ($days < 1) {
        return null;
    }
    $stmt = $pdo->prepare('
        SELECT i.id, i.processed_at, i.message
        FROM scraping_job_items i
        JOIN scraping_jobs j ON j.id=i.job_id
        WHERE j.list_id=?
          AND j.source=?
          AND i.url=?
          AND i.job_id<>?
          AND i.status="skipped"
          AND i.email=""
          AND i.processed_at>=?
        ORDER BY i.id DESC
        LIMIT 1
    ');
    $stmt->execute([
        (int)$job['list_id'],
        (string)$job['source'],
        $url,
        (int)$job['id'],
        date('c', time() - ($days * 86400)),
    ]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function skipCachedScrapingItem(PDO $pdo, array $job, array $item): ?string
{
    $url = (string)$item['url'];
    $known = completeScrapingContactFromKnownUrl($pdo, $job, $url);
    if ($known) {
        $message = 'Preskoceno: URL uz je u kompletniho kontaktu ' . (string)$known['email'] . '.';
        markScrapingItem($pdo, (int)$item['id'], 'skipped', $known, $message);
        incrementScrapingJob($pdo, (int)$job['id'], 'processed_count', 'skipped_count', $message);
        return 'Cache: kompletni kontakt ' . (string)$known['email'] . '.';
    }

    $recentNoEmail = recentNoEmailScrapingItem($pdo, $job, $url);
    if ($recentNoEmail) {
        $message = 'Preskoceno: stejna URL byla nedavno zpracovana bez emailu.';
        markScrapingItem($pdo, (int)$item['id'], 'skipped', [], $message);
        incrementScrapingJob($pdo, (int)$job['id'], 'processed_count', 'skipped_count', $message);
        return 'Cache: bez emailu ' . $url;
    }

    return null;
}

function scrapingHttpTimeouts(string $url): array
{
    $host = strtolower((string)(parse_url($url, PHP_URL_HOST) ?: ''));
    if (in_array($host, ['dasoertliche.de', 'www.dasoertliche.de'], true)) {
        return ['connect' => 6, 'total' => 12, 'attempts' => 2];
    }
    return ['connect' => 10, 'total' => 25, 'attempts' => 3];
}

function discoverScrapingPage(PDO $pdo, array $job): string
{
    $page = (int)$job['current_page'];
    $urls = [];
    $sourceMessages = [];
    $successfulFetch = false;
    $hasNextPage = false;
    $directProcessed = 0;
    foreach (scrapingSearchUrls((string)$job['source'], (string)$job['keyword'], $page) as $search) {
        try {
            $searchResponse = fetchScrapingSearch($search);
            $html = $searchResponse['html'];
            $successfulFetch = true;
            if (($searchResponse['has_next'] ?? null) === true || searchResultHasNextPage($html, (string)$job['source'], $search['url'], $page)) {
                $hasNextPage = true;
            }
            if (in_array((string)$job['source'], ['herold_at', 'panoramafirm_pl'], true)) {
                $contacts = (string)$job['source'] === 'panoramafirm_pl'
                    ? extractPanoramaFirmListingContacts($html, $search['url'])
                    : extractHeroldListingContacts($html, $search['url']);
                foreach ($contacts as $contact) {
                    if (recordScrapingContactItem($pdo, $job, $contact, (string)$contact['_source_url'])) {
                        $directProcessed++;
                    }
                }
                $sourceMessages[] = $search['label'] . ': nalezeno ' . count($contacts) . ' kontaktu ve vysledcich.';
                if ($contacts) {
                    break;
                }
            }
            $urls = extractCandidateUrls($html, $search['url'], (string)$job['source']);
            $sourceMessages[] = $search['label'] . ': nalezeno ' . count($urls) . ' URL.';
            if ($urls) {
                break;
            }
        } catch (Throwable $e) {
            $sourceMessages[] = $search['label'] . ': ' . $e->getMessage();
        }
    }
    if (!$urls && $sourceMessages) {
        if (!$successfulFetch) {
            $message = 'Docasna chyba zdroje: nepodarilo se nacist vyhledavaci stranku ' . $page . '. ' . implode(' ', $sourceMessages);
            updateScrapingJob($pdo, (int)$job['id'], [
                'status' => 'queued',
                'last_message' => substr($message, 0, 500),
            ]);
            return $message;
        }
        if ($directProcessed > 0) {
            $fields = [
                'current_page' => $page + 1,
                'discovered_count' => (int)$job['discovered_count'] + $directProcessed,
            ];
            if (!$hasNextPage) {
                $fields['discovery_done'] = 1;
            }
            updateScrapingJob($pdo, (int)$job['id'], $fields);
            return 'Stranka ' . $page . ': +' . $directProcessed . ' kontaktu z vysledku, bez detailnich URL.';
        }
        updateScrapingJob($pdo, (int)$job['id'], [
            'discovery_done' => 1,
            'last_message' => 'Zdroj uz nevratil dalsi vysledky, dobiha zpracovani nalezenych detailu.',
        ]);
        if (queuedScrapingItemCount($pdo, (int)$job['id']) === 0) {
            finishScrapingJob($pdo, (int)$job['id'], 'Dokonceno: dalsi zdroje nevratily zadne URL.');
        }
        return 'Stranka ' . $page . ': zdroj nevratil dalsi vysledky.';
    }
    $added = 0;
    $sql = isMysql($pdo)
        ? 'INSERT IGNORE INTO scraping_job_items (job_id, url, status, created_at) VALUES (?, ?, "queued", ?)'
        : 'INSERT OR IGNORE INTO scraping_job_items (job_id, url, status, created_at) VALUES (?, ?, "queued", ?)';
    $stmt = $pdo->prepare($sql);
    foreach ($urls as $candidate) {
        $stmt->execute([(int)$job['id'], $candidate, date('c')]);
        $added += $stmt->rowCount() > 0 ? 1 : 0;
    }
    if ($added === 0 && $directProcessed === 0) {
        if ($hasNextPage) {
            updateScrapingJob($pdo, (int)$job['id'], [
                'current_page' => $page + 1,
                'last_message' => 'Stranka ' . $page . ' neobsahovala nove URL, zdroj ale ukazuje dalsi stranku.',
            ]);
            return 'Stranka ' . $page . ': zadne nove URL, pokracuji dalsi stranou.';
        }
        updateScrapingJob($pdo, (int)$job['id'], [
            'discovery_done' => 1,
            'last_message' => 'Zdroj na strance ' . $page . ' nevratil zadne nove URL, dobiha zpracovani nalezenych detailu.',
        ]);
        if (queuedScrapingItemCount($pdo, (int)$job['id']) === 0) {
            finishScrapingJob($pdo, (int)$job['id'], 'Zdroj na strance ' . $page . ' nevratil zadne nove URL. Scraping dokoncen.');
        }
        return 'Stranka ' . $page . ': zadne nove URL.';
    }
    $updateFields = [
        'current_page' => $page + 1,
        'discovered_count' => (int)$job['discovered_count'] + $added + $directProcessed,
    ];
    if (in_array((string)$job['source'], ['firmy_cz', 'herold_at', 'dastelefonbuch_de', 'dasoertliche_de', 'gelbeseiten_de', 'pkt_pl', 'panoramafirm_pl', 'merchantcircle_us', 'yellowpages_ca'], true) && !$hasNextPage) {
        $updateFields['discovery_done'] = 1;
        $updateFields['last_message'] = 'Posledni stranka zdroje byla nactena, dobiha zpracovani nalezenych detailu.';
    }
    updateScrapingJob($pdo, (int)$job['id'], $updateFields);
    $parts = [];
    if ($added > 0) {
        $parts[] = '+' . $added . ' URL';
    }
    if ($directProcessed > 0) {
        $parts[] = '+' . $directProcessed . ' kontaktu z vysledku';
    }
    return 'Stranka ' . $page . ': ' . implode(', ', $parts) . '.';
}

function searchResultHasNextPage(string $html, string $source, string $baseUrl, int $page): bool
{
    if ($source === 'firmy_cz') {
        return searchResultLinksToPage($html, $baseUrl, $page + 1, 'firmy.cz');
    }
    if ($source === 'herold_at') {
        return preg_match('#href=(["\'])[^"\']*/gelbe-seiten/[^"\']+/seite/' . ($page + 1) . '/?\1#i', $html) === 1;
    }
    if ($source === 'dastelefonbuch_de') {
        return preg_match('/<a\b[^>]*class=(["\'])(?:(?!\1).)*\bnext\b(?:(?!\1).)*\1[^>]*href=(["\'])(.*?)\2/i', $html) === 1
            || preg_match('/<a\b[^>]*href=(["\'])https?:\/\/www\.dastelefonbuch\.de\/Suche\/[^"\']+\/' . ($page + 1) . '\1/i', $html) === 1;
    }
    if ($source === 'dasoertliche_de') {
        $nextRecFrom = ($page * 25) + 1;
        return preg_match('/href=(["\'])[^"\']*recFrom=' . $nextRecFrom . '(?:&|&amp;|["\'])/i', $html) === 1;
    }
    if ($source === 'gelbeseiten_de') {
        return preg_match('/id=(["\'])mod-LoadMore\1/i', $html) === 1
            || preg_match('/id=(["\'])loadMore_anzahl\1[^>]*value=(["\'])[1-9]\d*\2/i', $html) === 1;
    }
    if ($source === 'pkt_pl') {
        return preg_match('/<link\b[^>]*rel=(["\'])next\1[^>]*href=(["\'])(.*?)\2/i', $html) === 1
            || preg_match('/<a\b[^>]*href=(["\'])\/szukaj\/[^"\']+\/' . ($page + 1) . '\1/i', $html) === 1;
    }
    if ($source === 'panoramafirm_pl') {
        return preg_match('/href=(["\'])\/[^"\']+\/firmy,' . ($page + 1) . '\.html\1/i', $html) === 1
            || preg_match('/href=(["\'])https?:\/\/panoramafirm\.pl\/[^"\']+\/firmy,' . ($page + 1) . '\.html\1/i', $html) === 1
            || panoramaFirmTotalResults($html) > ($page * 25);
    }
    if ($source === 'merchantcircle_us') {
        $expectedStart = $page * 20;
        return preg_match('/href=(["\'])[^"\']*[?&]start=' . $expectedStart . '(?:&|&amp;|#|\1)/i', $html) === 1
            || preg_match('/<a\b[^>]*class=(["\'])(?:(?!\1).)*\bnext\b(?:(?!\1).)*\1[^>]*href=(["\'])(.*?)\2/i', $html) === 1;
    }
    if ($source === 'yellowpages_ca') {
        return preg_match('#href=(["\'])[^"\']*/search/si/' . ($page + 1) . '/#i', $html) === 1
            || preg_match('/href=(["\'])[^"\']*[?&]page=' . ($page + 1) . '(?:&|&amp;|#|\1)/i', $html) === 1
            || preg_match('/<a\b[^>]*class=(["\'])(?:(?!\1).)*\bnext\b(?:(?!\1).)*\1[^>]*href=(["\'])(.*?)\2/i', $html) === 1;
    }
    if ($source !== 'zoznam_sk') {
        return false;
    }
    if (!preg_match_all('/<a\b[^>]*>/i', $html, $matches)) {
        return false;
    }
    $expectedOffset = $page * 20;
    foreach ($matches[0] as $tag) {
        if (stripos($tag, 'next') === false && stripos($tag, 'of=') === false) {
            continue;
        }
        if (!preg_match('/href=(["\'])(.*?)\1/i', $tag, $hrefMatch)) {
            continue;
        }
        $url = normalizeUrl(html_entity_decode($hrefMatch[2], ENT_QUOTES, 'UTF-8'), $baseUrl);
        parse_str(parse_url($url, PHP_URL_QUERY) ?: '', $query);
        $offset = isset($query['of']) ? (int)$query['of'] : 0;
        if ($offset >= $expectedOffset) {
            return true;
        }
    }
    return false;
}

function searchResultLinksToPage(string $html, string $baseUrl, int $expectedPage, string $hostNeedle): bool
{
    if (!preg_match_all('/href=(["\'])(.*?)\1/i', $html, $matches)) {
        return false;
    }
    foreach ($matches[2] ?? [] as $href) {
        $url = normalizeUrl(html_entity_decode($href, ENT_QUOTES, 'UTF-8'), $baseUrl);
        if ($url === '') {
            continue;
        }
        $host = strtolower((string)(parse_url($url, PHP_URL_HOST) ?: ''));
        if ($hostNeedle !== '' && !str_contains($host, strtolower($hostNeedle))) {
            continue;
        }
        parse_str((string)(parse_url($url, PHP_URL_QUERY) ?: ''), $query);
        if ((int)($query['page'] ?? 0) === $expectedPage) {
            return true;
        }
    }
    return false;
}

function recordScrapingContactItem(PDO $pdo, array $job, array $contact, string $url): bool
{
    $itemId = insertScrapingJobItem($pdo, (int)$job['id'], $url);
    if ($itemId < 1) {
        return false;
    }
    if (($contact['email'] ?? '') === '' || !filter_var((string)$contact['email'], FILTER_VALIDATE_EMAIL)) {
        markScrapingItem($pdo, $itemId, 'skipped', $contact, 'Email nenalezen.');
        incrementScrapingJob($pdo, (int)$job['id'], 'processed_count', 'skipped_count', 'Email nenalezen.');
        return true;
    }
    $contact['source_label'] = contactSourceFromScrapingJob($job);
    $contact['source_url'] = $url;
    $upsert = upsertRecipient($pdo, (int)$job['list_id'], $contact);
    $result = $upsert['result'];
    $message = $upsert['message'] !== '' ? $upsert['message'] : scrapingResultMessage($result);
    markScrapingItem($pdo, $itemId, $result, $contact, $message);
    incrementScrapingJob($pdo, (int)$job['id'], 'processed_count', $result . '_count', $message . ' ' . $contact['email']);
    return true;
}

function insertScrapingJobItem(PDO $pdo, int $jobId, string $url): int
{
    $sql = isMysql($pdo)
        ? 'INSERT IGNORE INTO scraping_job_items (job_id, url, status, created_at) VALUES (?, ?, "queued", ?)'
        : 'INSERT OR IGNORE INTO scraping_job_items (job_id, url, status, created_at) VALUES (?, ?, "queued", ?)';
    $stmt = $pdo->prepare($sql);
    $stmt->execute([$jobId, $url, date('c')]);
    if ($stmt->rowCount() > 0) {
        return (int)$pdo->lastInsertId();
    }
    $find = $pdo->prepare('SELECT id, status FROM scraping_job_items WHERE job_id=? AND url=? LIMIT 1');
    $find->execute([$jobId, $url]);
    $existing = $find->fetch(PDO::FETCH_ASSOC);
    return $existing && (string)$existing['status'] === 'queued' ? (int)$existing['id'] : 0;
}

function processScrapingItem(PDO $pdo, array $job, array $item): string
{
    try {
        $cached = skipCachedScrapingItem($pdo, $job, $item);
        if ($cached !== null) {
            return $cached;
        }
        $html = httpGet((string)$item['url']);
        $contact = extractContactFromHtml($html, (string)$item['url']);
        if (($contact['email'] === '' || !filter_var($contact['email'], FILTER_VALIDATE_EMAIL))
            && in_array((string)$job['source'], ['merchantcircle_us', 'yellowpages_ca'], true)) {
            $contact = enrichDirectoryContactFromBusinessWebsite($contact);
        }
        if ($contact['email'] === '' || !filter_var($contact['email'], FILTER_VALIDATE_EMAIL)) {
            markScrapingItem($pdo, (int)$item['id'], 'skipped', $contact, 'Email nenalezen.');
            incrementScrapingJob($pdo, (int)$job['id'], 'processed_count', 'skipped_count', 'Email nenalezen.');
            return 'Bez emailu: ' . $item['url'];
        }
        $contact['source_label'] = contactSourceFromScrapingJob($job);
        $contact['source_url'] = (string)$item['url'];
        $upsert = upsertRecipient($pdo, (int)$job['list_id'], $contact);
        $result = $upsert['result'];
        $message = $upsert['message'] !== '' ? $upsert['message'] : scrapingResultMessage($result);
        markScrapingItem($pdo, (int)$item['id'], $result, $contact, $message);
        incrementScrapingJob($pdo, (int)$job['id'], 'processed_count', $result . '_count', $message . ' ' . $contact['email']);
        return $contact['email'] . ' ' . $result . '.';
    } catch (Throwable $e) {
        markScrapingItem($pdo, (int)$item['id'], 'failed', [], $e->getMessage());
        incrementScrapingJob($pdo, (int)$job['id'], 'processed_count', 'skipped_count', 'Chyba: ' . $e->getMessage());
        return 'Chyba URL: ' . $item['url'];
    }
}

function scrapingResultMessage(string $result): string
{
    return [
        'inserted' => 'Novy kontakt vlozen.',
        'updated' => 'Doplneny chybejici udaje.',
        'skipped' => 'Duplicita bez chybejicich udaju k doplneni.',
    ][$result] ?? 'Kontakt zpracovan.';
}

function upsertRecipient(PDO $pdo, int $listId, array $contact): array
{
    $email = trim((string)($contact['email'] ?? ''));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        return ['result' => 'skipped', 'message' => 'Neplatny email.'];
    }
    $subjectName = trim((string)($contact['subject_name'] ?? ''));
    $website = normalizeWebsite(trim((string)($contact['website'] ?? '')));
    $address = trim((string)($contact['address'] ?? ''));
    $name = trim((string)($contact['name'] ?? ''));
    $contactedBefore = !empty($contact['contacted_before']) ? 1 : 0;
    $sourceLabel = trim((string)($contact['source_label'] ?? ''));
    $sourceUrl = trim((string)($contact['source_url'] ?? ''));

    $existingStmt = $pdo->prepare('SELECT list_id, subject_name, website, address, name, contacted_before, source_label, source_url FROM recipients WHERE list_id=? AND email=?');
    $existingStmt->execute([$listId, $email]);
    $existing = $existingStmt->fetch(PDO::FETCH_ASSOC);
    if (!$existing) {
        $insertStmt = $pdo->prepare('INSERT INTO recipients (list_id, email, subject_name, website, address, name, contacted_before, status, created_at, updated_at, source_label, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, "active", ?, ?, ?, ?)');
        $now = date('c');
        $insertStmt->execute([$listId, $email, $subjectName, $website, $address, $name, $contactedBefore, $now, $now, $sourceLabel, $sourceUrl]);
        return ['result' => 'inserted', 'message' => 'Novy kontakt vlozen.'];
    }

    $fill = recipientFillUpdate($existing, [
        'subject_name' => $subjectName,
        'website' => $website,
        'address' => $address,
        'name' => $name,
        'contacted_before' => $contactedBefore,
        'source_label' => $sourceLabel,
        'source_url' => $sourceUrl,
    ]);
    if (!$fill['changes']) {
        return ['result' => 'skipped', 'message' => recipientUpdateMessage([])];
    }
    $values = $fill['values'];
    $updateStmt = $pdo->prepare('UPDATE recipients SET subject_name=?, website=?, address=?, name=?, contacted_before=?, source_label=?, source_url=?, status="active", updated_at=? WHERE list_id=? AND email=?');
    $updateStmt->execute([$values['subject_name'], $values['website'], $values['address'], $values['name'], $values['contacted_before'], $values['source_label'], $values['source_url'], date('c'), $listId, $email]);
    return ['result' => 'updated', 'message' => recipientUpdateMessage($fill['changes'])];
}

function scrapingSources(): array
{
    return [
        'firmy_cz' => 'Firmy.cz',
        'herold_at' => 'Herold.at',
        'zoznam_sk' => 'Zoznam.sk',
        'dastelefonbuch_de' => 'DasTelefonbuch.de',
        'dasoertliche_de' => 'DasOertliche.de',
        'gelbeseiten_de' => 'GelbeSeiten.de',
        'pkt_pl' => 'Pkt.pl',
        'panoramafirm_pl' => 'PanoramaFirm.pl',
        'merchantcircle_us' => 'MerchantCircle',
        'yellowpages_ca' => 'YellowPages.ca',
    ];
}

function scrapingSearchUrls(string $source, string $keyword, int $page): array
{
    if ($source === 'firmy_cz') {
        $query = ['q' => $keyword];
        if ($page > 1) {
            $query['page'] = $page;
        }
        return [
            [
                'label' => 'Firmy.cz',
                'url' => 'https://www.firmy.cz/?' . http_build_query($query),
            ],
        ];
    }

    if ($source === 'herold_at') {
        $slug = heroldKeywordSlug($keyword);
        $urls = [
            [
                'label' => 'Herold.at',
                'url' => 'https://www.herold.at/gelbe-seiten/' . $slug . '/',
            ],
        ];
        if ($page > 1) {
            $urls = [
                [
                    'label' => 'Herold.at',
                    'url' => 'https://www.herold.at/gelbe-seiten/' . $slug . '/seite/' . $page . '/',
                ],
                [
                    'label' => 'Herold.at fallback',
                    'url' => 'https://www.herold.at/gelbe-seiten/' . $slug . '/' . $page . '/',
                ],
            ];
        }
        return $urls;
    }

    if ($source === 'zoznam_sk') {
        return [
            [
                'label' => 'Zoznam.sk',
                'url' => 'https://www.zoznam.sk/hladaj.fcgi?' . zoznamSearchQuery($keyword, $page),
            ],
        ];
    }

    if ($source === 'dastelefonbuch_de') {
        $path = '/Suche/' . rawurlencode(normalizeScrapingKeyword($keyword));
        if ($page > 1) {
            $path .= '/' . $page;
        }
        return [
            [
                'label' => 'DasTelefonbuch.de',
                'url' => 'https://www.dastelefonbuch.de' . $path,
            ],
        ];
    }

    if ($source === 'dasoertliche_de') {
        $query = [
            'kw' => normalizeScrapingKeyword($keyword),
            'form_name' => 'search_nat',
        ];
        if ($page > 1) {
            $query['recFrom'] = (($page - 1) * 25) + 1;
        }
        return [
            [
                'label' => 'DasOertliche.de',
                'url' => 'https://www.dasoertliche.de/?' . http_build_query($query),
            ],
        ];
    }

    if ($source === 'gelbeseiten_de') {
        $keyword = normalizeScrapingKeyword($keyword);
        if ($page === 1) {
            return [
                [
                    'label' => 'GelbeSeiten.de',
                    'url' => 'https://www.gelbeseiten.de/suche/' . rawurlencode($keyword) . '/bundesweit',
                ],
            ];
        }
        return [
            [
                'label' => 'GelbeSeiten.de',
                'url' => 'https://www.gelbeseiten.de/ajaxsuche',
                'method' => 'POST',
                'body' => [
                    'umkreis' => '-1',
                    'verwandt' => 'false',
                    'WAS' => $keyword,
                    'position' => (string)(51 + (($page - 2) * 10)),
                    'anzahl' => '10',
                ],
                'referer' => 'https://www.gelbeseiten.de/suche/' . rawurlencode($keyword) . '/bundesweit',
            ],
        ];
    }

    if ($source === 'pkt_pl') {
        $path = '/szukaj/' . rawurlencode(normalizeScrapingKeyword($keyword));
        if ($page > 1) {
            $path .= '/' . $page;
        }
        return [
            [
                'label' => 'Pkt.pl',
                'url' => 'https://www.pkt.pl' . $path,
            ],
        ];
    }

    if ($source === 'panoramafirm_pl') {
        $path = '/' . rawurlencode(normalizeScrapingKeyword($keyword));
        if ($page > 1) {
            $path .= '/firmy,' . $page . '.html';
        }
        return [
            [
                'label' => 'PanoramaFirm.pl',
                'url' => 'https://panoramafirm.pl' . $path,
            ],
        ];
    }

    if ($source === 'merchantcircle_us') {
        $query = [
            'pagesize' => 20,
            'q' => normalizeScrapingKeyword($keyword),
            'qn' => 'United States',
        ];
        if ($page > 1) {
            $query['start'] = ($page - 1) * 20;
        }
        return [
            [
                'label' => 'MerchantCircle',
                'url' => 'https://www.merchantcircle.com/search?' . http_build_query($query),
            ],
        ];
    }

    if ($source === 'yellowpages_ca') {
        $keyword = normalizeScrapingKeyword($keyword);
        if ($keyword === '') {
            throw new RuntimeException('Klicove slovo pro YellowPages.ca neni platne.');
        }
        return [
            [
                'label' => 'YellowPages.ca',
                'url' => 'https://www.yellowpages.ca/search/si/' . max(1, $page) . '/' . rawurlencode($keyword) . '/Canada',
            ],
        ];
    }

    throw new RuntimeException('Zdroj zatim nema parser.');
}

function heroldKeywordSlug(string $keyword): string
{
    $keyword = normalizeScrapingKeyword($keyword);
    $keyword = strtr($keyword, [
        'ä' => 'ae',
        'ö' => 'oe',
        'ü' => 'ue',
        'ß' => 'ss',
    ]);
    $keyword = preg_replace('/[^a-z0-9]+/i', '-', $keyword) ?? '';
    $keyword = trim($keyword, '-');
    if ($keyword === '') {
        throw new RuntimeException('Klicove slovo pro Herold.at neni platne.');
    }
    return rawurlencode($keyword);
}

function zoznamSearchQuery(string $keyword, int $page): string
{
    $keyword = normalizeScrapingKeyword($keyword);
    if ($keyword === '') {
        throw new RuntimeException('Klicove slovo pro Zoznam.sk neni platne.');
    }
    $legacyKeyword = $keyword;
    if (function_exists('iconv')) {
        $converted = @iconv('UTF-8', 'Windows-1250//IGNORE', $keyword);
        if ($converted !== false && $converted !== '') {
            $legacyKeyword = $converted;
        }
    }
    $query = 'co=odkazy&s=' . rawurlencode($legacyKeyword) . '&s-utf8=' . rawurlencode($keyword);
    if ($page > 1) {
        $query .= '&of=' . (($page - 1) * 20);
    }
    return $query;
}

function httpFailureSummary(string $url, int $status = 0, string $body = '', string $error = ''): string
{
    $parts = [];
    if ($status > 0) {
        $parts[] = 'status ' . $status;
    }
    if ($error !== '') {
        $parts[] = trim($error);
    }
    if ($body !== '' && preg_match('/<title[^>]*>(.*?)<\/title>/is', $body, $match)) {
        $title = trim(preg_replace('/\s+/', ' ', html_entity_decode(strip_tags($match[1]), ENT_QUOTES, 'UTF-8')));
        if ($title !== '') {
            $parts[] = 'title "' . substr($title, 0, 120) . '"';
        }
    }
    $parts[] = $url;
    return implode(', ', array_filter($parts, static fn($part) => $part !== ''));
}

function httpGet(string $url): string
{
    $timeouts = scrapingHttpTimeouts($url);
    $attempts = max(1, (int)$timeouts['attempts']);
    $connectTimeout = max(1, (int)$timeouts['connect']);
    $totalTimeout = max(1, (int)$timeouts['total']);
    if (function_exists('curl_init')) {
        $lastError = '';
        for ($attempt = 1; $attempt <= $attempts; $attempt++) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_MAXREDIRS => 4,
                CURLOPT_CONNECTTIMEOUT => $connectTimeout,
                CURLOPT_TIMEOUT => $totalTimeout,
                CURLOPT_ENCODING => '',
                CURLOPT_IPRESOLVE => CURL_IPRESOLVE_V4,
                CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
                CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                CURLOPT_REFERER => originUrl($url),
                CURLOPT_HTTPHEADER => [
                    'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language: cs-CZ,cs;q=0.9,de-DE;q=0.8,de;q=0.7,en;q=0.6',
                    'Cache-Control: no-cache',
                    'Connection: close',
                ],
            ]);
            $body = curl_exec($ch);
            $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $error = curl_error($ch);
            curl_close($ch);
            if ($body !== false && $status < 400) {
                return normalizeDownloadedHtml((string)$body);
            }
            $lastError = httpFailureSummary($url, $status, $body === false ? '' : (string)$body, $error);
            usleep(250000 * $attempt);
        }
        throw new RuntimeException('HTTP stazeni selhalo: ' . $lastError);
    }

    $context = stream_context_create(['http' => [
        'timeout' => $totalTimeout,
        'header' => "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36\r\nAccept-Language: cs-CZ,cs;q=0.9,de-DE;q=0.8,de;q=0.7,en;q=0.6\r\nConnection: close\r\n",
    ]]);
    $body = @file_get_contents($url, false, $context);
    $status = 0;
    if (isset($http_response_header) && is_array($http_response_header)) {
        foreach ($http_response_header as $header) {
            if (preg_match('/^HTTP\/\S+\s+(\d+)/', $header, $match)) {
                $status = (int)$match[1];
            }
        }
    }
    if ($body === false) {
        throw new RuntimeException('HTTP stazeni selhalo: ' . httpFailureSummary($url, $status, '', 'bez odpovedi'));
    }
    if ($status >= 400) {
        throw new RuntimeException('HTTP stazeni selhalo: ' . httpFailureSummary($url, $status, (string)$body));
    }
    return normalizeDownloadedHtml($body);
}

function fetchScrapingSearch(array $search): array
{
    $method = strtoupper((string)($search['method'] ?? 'GET'));
    $html = $method === 'POST'
        ? httpPostForm((string)$search['url'], (array)($search['body'] ?? []), (string)($search['referer'] ?? ''))
        : httpGet((string)$search['url']);

    $trimmed = ltrim($html);
    if ($trimmed !== '' && $trimmed[0] === '{') {
        $decoded = json_decode($trimmed, true);
        if (is_array($decoded) && isset($decoded['html'])) {
            return [
                'html' => normalizeDownloadedHtml((string)$decoded['html']),
                'has_next' => isset($decoded['anzahlMehrTreffer']) ? ((int)$decoded['anzahlMehrTreffer'] > 0) : null,
            ];
        }
    }

    return ['html' => $html, 'has_next' => null];
}

function httpPostForm(string $url, array $fields, string $referer = ''): string
{
    $body = http_build_query($fields);
    if (function_exists('curl_init')) {
        $lastError = '';
        for ($attempt = 1; $attempt <= 3; $attempt++) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_MAXREDIRS => 4,
                CURLOPT_CONNECTTIMEOUT => 10,
                CURLOPT_TIMEOUT => 25,
                CURLOPT_ENCODING => '',
                CURLOPT_IPRESOLVE => CURL_IPRESOLVE_V4,
                CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $body,
                CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                CURLOPT_REFERER => $referer !== '' ? $referer : originUrl($url),
                CURLOPT_HTTPHEADER => [
                    'Accept: application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language: cs-CZ,cs;q=0.9,de-DE;q=0.8,de;q=0.7,en;q=0.6',
                    'Cache-Control: no-cache',
                    'Connection: close',
                    'Content-Type: application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With: XMLHttpRequest',
                ],
            ]);
            $response = curl_exec($ch);
            $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $error = curl_error($ch);
            curl_close($ch);
            if ($response !== false && $status < 400) {
                return normalizeDownloadedHtml((string)$response);
            }
            $lastError = httpFailureSummary($url, $status, $response === false ? '' : (string)$response, $error);
            usleep(250000 * $attempt);
        }
        throw new RuntimeException('HTTP POST selhal: ' . $lastError);
    }

    $headers = "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36\r\n"
        . "Accept: application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n"
        . "Accept-Language: cs-CZ,cs;q=0.9,de-DE;q=0.8,de;q=0.7,en;q=0.6\r\n"
        . "Content-Type: application/x-www-form-urlencoded; charset=UTF-8\r\n"
        . "X-Requested-With: XMLHttpRequest\r\n"
        . "Connection: close\r\n";
    if ($referer !== '') {
        $headers .= 'Referer: ' . $referer . "\r\n";
    }
    $context = stream_context_create(['http' => [
        'method' => 'POST',
        'timeout' => 25,
        'header' => $headers,
        'content' => $body,
    ]]);
    $response = @file_get_contents($url, false, $context);
    $status = 0;
    if (isset($http_response_header) && is_array($http_response_header)) {
        foreach ($http_response_header as $header) {
            if (preg_match('/^HTTP\/\S+\s+(\d+)/', $header, $match)) {
                $status = (int)$match[1];
            }
        }
    }
    if ($response === false) {
        throw new RuntimeException('HTTP POST selhal: ' . httpFailureSummary($url, $status, '', 'bez odpovedi'));
    }
    if ($status >= 400) {
        throw new RuntimeException('HTTP POST selhal: ' . httpFailureSummary($url, $status, (string)$response));
    }
    return normalizeDownloadedHtml($response);
}

function normalizeDownloadedHtml(string $body): string
{
    if (!preg_match('/charset\s*=\s*(["\']?)(windows-1250|cp1250)\1/i', $body)) {
        return $body;
    }
    if (function_exists('iconv')) {
        $converted = @iconv('Windows-1250', 'UTF-8//IGNORE', $body);
        if ($converted !== false && $converted !== '') {
            return $converted;
        }
    }
    if (function_exists('mb_convert_encoding')) {
        $converted = @mb_convert_encoding($body, 'UTF-8', 'Windows-1250');
        if (is_string($converted) && $converted !== '') {
            return $converted;
        }
    }
    return $body;
}

function extractCandidateUrls(string $html, string $baseUrl, string $source = ''): array
{
    if ($source === 'zoznam_sk') {
        return extractZoznamCandidateUrls($html, $baseUrl);
    }
    preg_match_all('/href=(["\'])(.*?)\1/i', $html, $matches);
    $urls = [];
    foreach ($matches[2] ?? [] as $href) {
        $url = normalizeSearchResultUrl(normalizeUrl(html_entity_decode($href, ENT_QUOTES, 'UTF-8'), $baseUrl));
        $detailUrl = normalizeScrapingDetailUrl($url, $source);
        if ($detailUrl === '') {
            continue;
        }
        $urls[$detailUrl] = true;
    }
    if ($source === 'panoramafirm_pl') {
        foreach (panoramaFirmJsonLdBusinesses($html) as $business) {
            $detailUrl = normalizePanoramaFirmDetailUrl((string)($business['url'] ?? ''));
            if ($detailUrl !== '') {
                $urls[$detailUrl] = true;
            }
        }
    }
    return array_keys($urls);
}

function extractZoznamCandidateUrls(string $html, string $baseUrl): array
{
    preg_match_all('/<li\b[^>]*>.*?<\/li>/is', $html, $matches);
    $urls = [];
    foreach ($matches[0] ?? [] as $block) {
        if (stripos($block, 'row link') === false) {
            continue;
        }
        $detailUrl = '';
        preg_match_all('/href=(["\'])(.*?)\1/i', $block, $hrefMatches);
        foreach ($hrefMatches[2] ?? [] as $href) {
            $candidate = normalizeSearchResultUrl(normalizeUrl(html_entity_decode($href, ENT_QUOTES, 'UTF-8'), $baseUrl));
            $detailUrl = normalizeZoznamDetailUrl($candidate);
            if ($detailUrl !== '') {
                break;
            }
        }
        if ($detailUrl !== '') {
            $urls[$detailUrl] = true;
            continue;
        }

        $externalUrl = '';
        if (preg_match('/<h2\b[^>]*>.*?<a\b[^>]*href=(["\'])(.*?)\1/is', $block, $titleMatch)) {
            $externalUrl = normalizeZoznamExternalResultUrl(normalizeUrl(html_entity_decode($titleMatch[2], ENT_QUOTES, 'UTF-8'), $baseUrl));
        }
        if ($externalUrl === '' && preg_match('/<a\b[^>]*class=(["\'])(?:(?!\1).)*catalog-list-link(?:(?!\1).)*\1[^>]*href=(["\'])(.*?)\2/is', $block, $linkMatch)) {
            $externalUrl = normalizeZoznamExternalResultUrl(normalizeUrl(html_entity_decode($linkMatch[3], ENT_QUOTES, 'UTF-8'), $baseUrl));
        }
        if ($externalUrl !== '') {
            $urls[$externalUrl] = true;
        }
    }
    return array_keys($urls);
}

function normalizeScrapingDetailUrl(string $url, string $source = ''): string
{
    if ($source === 'firmy_cz') {
        return normalizeFirmyDetailUrl($url);
    }
    if ($source === 'herold_at') {
        return normalizeHeroldDetailUrl($url);
    }
    if ($source === 'zoznam_sk') {
        return normalizeZoznamDetailUrl($url);
    }
    if ($source === 'dastelefonbuch_de') {
        return normalizeDasTelefonbuchDetailUrl($url);
    }
    if ($source === 'dasoertliche_de') {
        return normalizeDasOertlicheDetailUrl($url);
    }
    if ($source === 'gelbeseiten_de') {
        return normalizeGelbeSeitenDetailUrl($url);
    }
    if ($source === 'pkt_pl') {
        return normalizePktDetailUrl($url);
    }
    if ($source === 'panoramafirm_pl') {
        return normalizePanoramaFirmDetailUrl($url);
    }
    if ($source === 'merchantcircle_us') {
        return normalizeMerchantCircleDetailUrl($url);
    }
    if ($source === 'yellowpages_ca') {
        return normalizeYellowPagesCaDetailUrl($url);
    }
    return normalizeFirmyDetailUrl($url) ?: normalizeHeroldDetailUrl($url) ?: normalizeZoznamDetailUrl($url) ?: normalizeDasTelefonbuchDetailUrl($url) ?: normalizeDasOertlicheDetailUrl($url) ?: normalizeGelbeSeitenDetailUrl($url) ?: normalizePktDetailUrl($url) ?: normalizePanoramaFirmDetailUrl($url) ?: normalizeMerchantCircleDetailUrl($url) ?: normalizeYellowPagesCaDetailUrl($url);
}

function normalizeFirmyDetailUrl(string $url): string
{
    if ($url === '' || !preg_match('/^https?:\/\//i', $url)) {
        return '';
    }
    $parts = parse_url($url);
    $host = strtolower((string)($parts['host'] ?? ''));
    $path = (string)($parts['path'] ?? '');
    if (!in_array($host, ['firmy.cz', 'www.firmy.cz'], true) || !preg_match('#^/detail/\d+-[^/]+\.html$#i', $path)) {
        return '';
    }
    return 'https://www.firmy.cz' . $path;
}

function normalizeHeroldDetailUrl(string $url): string
{
    if ($url === '' || !preg_match('/^https?:\/\//i', $url)) {
        return '';
    }
    $parts = parse_url($url);
    $host = strtolower((string)($parts['host'] ?? ''));
    $path = (string)($parts['path'] ?? '');
    if (!in_array($host, ['herold.at', 'www.herold.at'], true)) {
        return '';
    }
    if (!preg_match('#^/gelbe-seiten/[^/]+/[A-Za-z0-9]+/[^/]+/?$#', $path)) {
        return '';
    }
    return 'https://www.herold.at' . rtrim($path, '/') . '/';
}

function normalizeZoznamDetailUrl(string $url): string
{
    if ($url === '' || !preg_match('/^https?:\/\//i', $url)) {
        return '';
    }
    $parts = parse_url($url);
    $host = strtolower((string)($parts['host'] ?? ''));
    $path = (string)($parts['path'] ?? '');
    if (!in_array($host, ['zoznam.sk', 'www.zoznam.sk'], true)) {
        return '';
    }
    if (!preg_match('#^/firma/\d+/[^/]+/?$#i', $path)) {
        return '';
    }
    return 'https://www.zoznam.sk' . rtrim($path, '/');
}

function normalizeZoznamExternalResultUrl(string $url): string
{
    if ($url === '' || !preg_match('/^https?:\/\//i', $url)) {
        return '';
    }
    $parts = parse_url($url);
    $host = strtolower((string)($parts['host'] ?? ''));
    if ($host === '' || preg_match('/(^|\.)zoznam\.sk$/i', $host) || preg_match('/(^|\.)topky\.sk$/i', $host)) {
        return '';
    }
    return strtok($url, '#') ?: $url;
}

function normalizeDasTelefonbuchDetailUrl(string $url): string
{
    if ($url === '' || !preg_match('/^https?:\/\//i', $url)) {
        return '';
    }
    $parts = parse_url($url);
    $host = strtolower((string)($parts['host'] ?? ''));
    $path = (string)($parts['path'] ?? '');
    if ($host !== 'adresse.dastelefonbuch.de' || !preg_match('#\.html$#i', $path)) {
        return '';
    }
    return 'https://adresse.dastelefonbuch.de' . $path;
}

function normalizeDasOertlicheDetailUrl(string $url): string
{
    if ($url === '' || !preg_match('/^https?:\/\//i', $url)) {
        return '';
    }
    $parts = parse_url($url);
    $host = strtolower((string)($parts['host'] ?? ''));
    if (!in_array($host, ['dasoertliche.de', 'www.dasoertliche.de'], true)) {
        return '';
    }
    parse_str((string)($parts['query'] ?? ''), $query);
    if (($query['form_name'] ?? '') !== 'detail' || empty($query['id'])) {
        return '';
    }
    return 'https://www.dasoertliche.de/?form_name=detail&id=' . rawurlencode((string)$query['id']);
}

function normalizeGelbeSeitenDetailUrl(string $url): string
{
    if ($url === '' || !preg_match('/^https?:\/\//i', $url)) {
        return '';
    }
    $parts = parse_url($url);
    $host = strtolower((string)($parts['host'] ?? ''));
    $path = (string)($parts['path'] ?? '');
    if (!in_array($host, ['gelbeseiten.de', 'www.gelbeseiten.de'], true) || !preg_match('#^/gsbiz/[a-f0-9-]+/?$#i', $path)) {
        return '';
    }
    return 'https://www.gelbeseiten.de' . rtrim($path, '/');
}

function normalizePktDetailUrl(string $url): string
{
    if ($url === '' || !preg_match('/^https?:\/\//i', $url)) {
        return '';
    }
    $parts = parse_url($url);
    $host = strtolower((string)($parts['host'] ?? ''));
    $path = (string)($parts['path'] ?? '');
    if (!in_array($host, ['pkt.pl', 'www.pkt.pl'], true) || !preg_match('#^/firma/[^/]+-\d+/?$#i', $path)) {
        return '';
    }
    return 'https://www.pkt.pl' . rtrim($path, '/');
}

function normalizePanoramaFirmDetailUrl(string $url): string
{
    if ($url === '' || !preg_match('/^https?:\/\//i', $url)) {
        return '';
    }
    $parts = parse_url($url);
    $host = strtolower((string)($parts['host'] ?? ''));
    $path = (string)($parts['path'] ?? '');
    if (!in_array($host, ['panoramafirm.pl', 'www.panoramafirm.pl'], true) || !preg_match('#_cd\.html$#iu', $path)) {
        return '';
    }
    return 'https://panoramafirm.pl' . $path;
}

function normalizeMerchantCircleDetailUrl(string $url): string
{
    if ($url === '' || !preg_match('/^https?:\/\//i', $url)) {
        return '';
    }
    $parts = parse_url($url);
    $host = strtolower((string)($parts['host'] ?? ''));
    $path = (string)($parts['path'] ?? '');
    if (!in_array($host, ['merchantcircle.com', 'www.merchantcircle.com'], true)) {
        return '';
    }
    if (!preg_match('#^/[a-z0-9][a-z0-9-]*-[a-z]{2}/?$#i', $path)) {
        return '';
    }
    if (preg_match('#^/(?:search|directory|root|business-action|business_homepage|consumer|static|contact|about|privacy|terms)(?:/|$)#i', $path)) {
        return '';
    }
    return 'https://www.merchantcircle.com' . rtrim($path, '/');
}

function normalizeYellowPagesCaDetailUrl(string $url): string
{
    if ($url === '' || !preg_match('/^https?:\/\//i', $url)) {
        return '';
    }
    $parts = parse_url($url);
    $host = strtolower((string)($parts['host'] ?? ''));
    $path = (string)($parts['path'] ?? '');
    if (!in_array($host, ['yellowpages.ca', 'www.yellowpages.ca', 'm.yellowpages.ca', 'yp.ca', 'www.yp.ca', 'pagesjaunes.ca', 'www.pagesjaunes.ca'], true)) {
        return '';
    }
    if (!preg_match('#^/bus/[^?#]+\.html$#i', $path)) {
        return '';
    }
    $canonicalHost = str_contains($host, 'pagesjaunes.ca') ? 'www.pagesjaunes.ca' : 'www.yellowpages.ca';
    return 'https://' . $canonicalHost . $path;
}

function normalizeSearchResultUrl(string $url): string
{
    if ($url === '') {
        return '';
    }
    $host = parse_url($url, PHP_URL_HOST) ?: '';
    $query = [];
    parse_str(parse_url($url, PHP_URL_QUERY) ?: '', $query);
    foreach (['url', 'u', 'q', 'uddg'] as $key) {
        if (!empty($query[$key]) && is_string($query[$key]) && preg_match('/^https?:\/\//i', $query[$key])) {
            return html_entity_decode($query[$key], ENT_QUOTES, 'UTF-8');
        }
    }
    if (stripos($host, 'google.') !== false || stripos($host, 'duckduckgo.') !== false) {
        return '';
    }
    return $url;
}

function extractContactFromHtml(string $html, string $url): array
{
    if (normalizeFirmyDetailUrl($url) !== '') {
        return extractFirmyDetailContact($html, $url);
    }
    if (normalizeHeroldDetailUrl($url) !== '') {
        return extractHeroldDetailContact($html, $url);
    }
    if (normalizeZoznamDetailUrl($url) !== '') {
        return extractZoznamDetailContact($html, $url);
    }
    if (normalizeDasTelefonbuchDetailUrl($url) !== '') {
        return extractDasTelefonbuchDetailContact($html, $url);
    }
    if (normalizeDasOertlicheDetailUrl($url) !== '') {
        return extractDirectoryDetailContact($html, $url, ['dasoertliche.de', 'dtme.de', 'hinnerwisch-verlag.de']);
    }
    if (normalizeGelbeSeitenDetailUrl($url) !== '') {
        return extractDirectoryDetailContact($html, $url, ['gelbeseiten.de', 'golocal.de']);
    }
    if (normalizePktDetailUrl($url) !== '') {
        return extractDirectoryDetailContact($html, $url, ['pkt.pl']);
    }
    if (normalizePanoramaFirmDetailUrl($url) !== '') {
        return extractDirectoryDetailContact($html, $url, ['panoramafirm.pl', 'wenet.pl', 'wenetpolska.pl', 'biznesfinder.pl', 'panoramadanych.pl']);
    }
    if (normalizeMerchantCircleDetailUrl($url) !== '') {
        return extractDirectoryDetailContact($html, $url, ['merchantcircle.com', 'static1.merchantcircle.com', 'static2.merchantcircle.com', 'static3.merchantcircle.com', 'static4.merchantcircle.com']);
    }
    if (normalizeYellowPagesCaDetailUrl($url) !== '') {
        return extractDirectoryDetailContact($html, $url, ['yellowpages.ca', 'yp.ca', 'pagesjaunes.ca']);
    }
    $text = html_entity_decode(strip_tags($html), ENT_QUOTES, 'UTF-8');
    preg_match('/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i', $text, $emailMatch);
    preg_match('/<title[^>]*>(.*?)<\/title>/is', $html, $titleMatch);
    $title = trim(preg_replace('/\s+/', ' ', html_entity_decode(strip_tags($titleMatch[1] ?? ''), ENT_QUOTES, 'UTF-8')));
    $address = extractAddressFromText($text);
    $website = extractWebsiteFromText($text, $url);

    return [
        'email' => strtolower(trim($emailMatch[0] ?? '')),
        'subject_name' => $title,
        'website' => $website,
        'address' => $address,
        'name' => '',
    ];
}

function extractFirmyDetailContact(string $html, string $url): array
{
    $json = firmyJsonLd($html);
    $email = '';
    if (preg_match('/href=(["\'])mailto:([^"\']+)\1/i', $html, $mailMatch)) {
        $email = html_entity_decode(rawurldecode(trim($mailMatch[2])), ENT_QUOTES, 'UTF-8');
        $email = preg_replace('/\?.*$/', '', $email) ?? $email;
    }
    if ($email === '' && !empty($json['email'])) {
        $email = (string)$json['email'];
    }
    if ($email === '') {
        preg_match('/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i', html_entity_decode(strip_tags($html), ENT_QUOTES, 'UTF-8'), $emailMatch);
        $email = (string)($emailMatch[0] ?? '');
    }

    $subjectName = trim((string)($json['name'] ?? ''));
    if ($subjectName === '' && preg_match('/<h1[^>]*>(.*?)<\/h1>/is', $html, $headingMatch)) {
        $subjectName = trim(preg_replace('/\s+/', ' ', html_entity_decode(strip_tags($headingMatch[1]), ENT_QUOTES, 'UTF-8')));
    }
    if ($subjectName === '' && preg_match('/<title[^>]*>(.*?)<\/title>/is', $html, $titleMatch)) {
        $subjectName = trim(preg_replace('/\s+/', ' ', html_entity_decode(strip_tags($titleMatch[1]), ENT_QUOTES, 'UTF-8')));
        $subjectName = trim(preg_replace('/\s*[•|]\s*Firmy\.cz.*$/u', '', $subjectName));
    }

    $website = extractFirmyWebsite($html, (string)($json['url'] ?? ''));
    $address = firmyAddress($json);
    if ($address === '') {
        $address = extractAddressFromText(html_entity_decode(strip_tags($html), ENT_QUOTES, 'UTF-8'));
    }

    return [
        'email' => strtolower(trim($email)),
        'subject_name' => $subjectName,
        'website' => $website,
        'address' => $address,
        'name' => '',
    ];
}

function extractHeroldDetailContact(string $html, string $url): array
{
    $text = html_entity_decode(strip_tags($html), ENT_QUOTES, 'UTF-8');
    $email = '';
    if (preg_match('/href=(["\'])mailto:([^"\']+)\1/i', $html, $mailMatch)) {
        $email = html_entity_decode(rawurldecode(trim($mailMatch[2])), ENT_QUOTES, 'UTF-8');
        $email = preg_replace('/\?.*$/', '', $email) ?? $email;
    }
    if ($email === '' && preg_match('/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i', $text, $emailMatch)) {
        $email = (string)$emailMatch[0];
    }

    $subjectName = '';
    if (preg_match('/<h1[^>]*>(.*?)<\/h1>/is', $html, $headingMatch)) {
        $subjectName = trim(preg_replace('/\s+/', ' ', html_entity_decode(strip_tags($headingMatch[1]), ENT_QUOTES, 'UTF-8')));
    }
    if ($subjectName === '' && preg_match('/<title[^>]*>(.*?)<\/title>/is', $html, $titleMatch)) {
        $subjectName = trim(preg_replace('/\s+/', ' ', html_entity_decode(strip_tags($titleMatch[1]), ENT_QUOTES, 'UTF-8')));
        $subjectName = trim(preg_replace('/\s+in\s+\d{4}.*$/u', '', $subjectName));
        $subjectName = trim(preg_replace('/\s*\|\s*herold\.at.*$/iu', '', $subjectName));
    }

    $website = extractHeroldWebsite($html);
    $address = extractHeroldAddress($html, $subjectName);
    if ($address === '') {
        $address = extractAddressFromText($text);
    }

    return [
        'email' => strtolower(trim($email)),
        'subject_name' => $subjectName,
        'website' => $website,
        'address' => $address,
        'name' => '',
    ];
}

function extractZoznamDetailContact(string $html, string $url): array
{
    $json = firmyJsonLd($html);
    $text = html_entity_decode(strip_tags($html), ENT_QUOTES, 'UTF-8');
    $email = '';
    if (preg_match('/href=(["\'])mailto:([^"\']+)\1/i', $html, $mailMatch)) {
        $email = html_entity_decode(rawurldecode(trim($mailMatch[2])), ENT_QUOTES, 'UTF-8');
        $email = preg_replace('/\?.*$/', '', $email) ?? $email;
    }
    if ($email === '' && !empty($json['email'])) {
        $email = (string)$json['email'];
    }
    if ($email === '' && preg_match('/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i', $text, $emailMatch)) {
        $email = (string)$emailMatch[0];
    }

    $subjectName = trim((string)($json['name'] ?? ''));
    if ($subjectName === '' && preg_match('/<h1[^>]*>(.*?)<\/h1>/is', $html, $headingMatch)) {
        $subjectName = trim(preg_replace('/\s+/', ' ', html_entity_decode(strip_tags($headingMatch[1]), ENT_QUOTES, 'UTF-8')));
    }
    if ($subjectName === '' && preg_match('/<title[^>]*>(.*?)<\/title>/is', $html, $titleMatch)) {
        $subjectName = trim(preg_replace('/\s+/', ' ', html_entity_decode(strip_tags($titleMatch[1]), ENT_QUOTES, 'UTF-8')));
        $subjectName = trim(preg_replace('/\s*\|\s*Zoznam\.sk.*$/iu', '', $subjectName));
    }

    $website = extractZoznamWebsite($html, (string)($json['url'] ?? ''));
    $address = zoznamAddress($json);
    if ($address === '') {
        $address = extractZoznamAddress($html);
    }
    if ($address === '') {
        $address = extractAddressFromText($text);
    }

    return [
        'email' => strtolower(trim($email)),
        'subject_name' => $subjectName,
        'website' => $website,
        'address' => $address,
        'name' => '',
    ];
}

function extractDasTelefonbuchDetailContact(string $html, string $url): array
{
    $text = html_entity_decode(strip_tags($html), ENT_QUOTES, 'UTF-8');
    $email = '';
    if (preg_match('/href=(["\'])mailto:([^"\']+)\1/i', $html, $mailMatch)) {
        $email = html_entity_decode(rawurldecode(trim($mailMatch[2])), ENT_QUOTES, 'UTF-8');
        $email = preg_replace('/\?.*$/', '', $email) ?? $email;
    }
    if ($email === '') {
        $email = extractCloudflareProtectedEmail($html);
    }
    if ($email === '' && preg_match('/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i', $text, $emailMatch)) {
        $email = (string)$emailMatch[0];
    }

    $subjectName = '';
    if (preg_match('/<h1\b[^>]*itemprop=(["\'])name\1[^>]*>(.*?)<\/h1>/is', $html, $headingMatch)
        || preg_match('/<h1[^>]*>(.*?)<\/h1>/is', $html, $headingMatch)) {
        $subjectName = trim(preg_replace('/\s+/', ' ', html_entity_decode(strip_tags($headingMatch[2] ?? $headingMatch[1]), ENT_QUOTES, 'UTF-8')));
    }
    if ($subjectName === '' && preg_match('/<title[^>]*>(.*?)<\/title>/is', $html, $titleMatch)) {
        $subjectName = trim(preg_replace('/\s+/', ' ', html_entity_decode(strip_tags($titleMatch[1]), ENT_QUOTES, 'UTF-8')));
        $subjectName = trim(preg_replace('/\s+in\s+.+$/u', '', $subjectName));
    }

    $website = extractDasTelefonbuchWebsite($html);
    $address = extractDasTelefonbuchAddress($html);
    if ($address === '') {
        $address = extractAddressFromText($text);
    }

    return [
        'email' => strtolower(trim($email)),
        'subject_name' => $subjectName,
        'website' => $website,
        'address' => $address,
        'name' => '',
    ];
}

function extractDirectoryDetailContact(string $html, string $url, array $sourceHosts): array
{
    $json = firmyJsonLd($html);
    $text = html_entity_decode(strip_tags($html), ENT_QUOTES, 'UTF-8');
    $email = extractMailtoEmail($html, $sourceHosts);
    if ($email === '') {
        $email = extractCloudflareProtectedEmail($html);
    }
    if ($email === '') {
        $email = extractUsefulEmail($html, $sourceHosts);
    }

    $subjectName = trim((string)($json['name'] ?? ''));
    if ($subjectName === '' && preg_match('/<h1[^>]*>(.*?)<\/h1>/is', $html, $headingMatch)) {
        $subjectName = trim(preg_replace('/\s+/', ' ', html_entity_decode(strip_tags($headingMatch[1]), ENT_QUOTES, 'UTF-8')));
    }
    if ($subjectName === '' && preg_match('/<meta\b[^>]*property=(["\'])og:title\1[^>]*content=(["\'])(.*?)\2/is', $html, $metaMatch)) {
        $subjectName = trim(preg_replace('/\s+/', ' ', html_entity_decode(strip_tags($metaMatch[3]), ENT_QUOTES, 'UTF-8')));
    }
    if ($subjectName === '' && preg_match('/<title[^>]*>(.*?)<\/title>/is', $html, $titleMatch)) {
        $subjectName = trim(preg_replace('/\s+/', ' ', html_entity_decode(strip_tags($titleMatch[1]), ENT_QUOTES, 'UTF-8')));
    }
    $subjectName = trim(preg_replace('/\s*(?:\||-)\s*(?:GelbeSeiten\.de|Das Oertliche|Das Ortliche|DasOertliche\.de|pkt\.pl|Panorama Firm|MerchantCircle|YellowPages\.ca|Yellow Pages|YP\.ca|PagesJaunes\.ca|Pages Jaunes).*$/iu', '', $subjectName) ?? $subjectName);

    $website = extractDirectoryWebsite($html, $url, $sourceHosts, (string)($json['url'] ?? ''));
    $address = directoryAddress($json);
    if ($address === '') {
        $address = extractAddressFromText($text);
    }

    return [
        'email' => strtolower(trim($email)),
        'subject_name' => $subjectName,
        'website' => $website,
        'address' => $address,
        'name' => '',
    ];
}

function extractMailtoEmail(string $html, array $sourceHosts = []): string
{
    if (preg_match('/(?:href|data-link)=(["\'])mailto:([^"\']+)\1/i', $html, $mailMatch)) {
        $email = html_entity_decode(rawurldecode(trim($mailMatch[2])), ENT_QUOTES, 'UTF-8');
        $email = preg_replace('/\?.*$/', '', $email) ?? $email;
        if (emailMatchesSourceHosts($email, $sourceHosts)) {
            return '';
        }
        return filter_var($email, FILTER_VALIDATE_EMAIL) ? $email : '';
    }
    return '';
}

function emailMatchesSourceHosts(string $email, array $sourceHosts): bool
{
    $domain = strtolower((string)substr(strrchr(strtolower(trim($email)), '@') ?: '', 1));
    if ($domain === '') {
        return false;
    }
    foreach ($sourceHosts as $sourceHost) {
        $sourceHost = strtolower((string)$sourceHost);
        if ($domain === $sourceHost || str_ends_with($domain, '.' . $sourceHost)) {
            return true;
        }
    }
    return false;
}

function extractUsefulEmail(string $html, array $sourceHosts = []): string
{
    $text = html_entity_decode($html, ENT_QUOTES, 'UTF-8');
    preg_match_all('/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i', $text, $matches);
    foreach ($matches[0] ?? [] as $candidate) {
        $candidate = strtolower(trim($candidate));
        if (!filter_var($candidate, FILTER_VALIDATE_EMAIL)) {
            continue;
        }
        if (preg_match('/\.(png|jpe?g|gif|webp|svg|ico|css|js)$/i', $candidate)) {
            continue;
        }
        if (preg_match('/@(example|domain|invalid|localhost)\./i', $candidate)) {
            continue;
        }
        if (emailMatchesSourceHosts($candidate, $sourceHosts)) {
            continue;
        }
        return $candidate;
    }
    return '';
}

function enrichDirectoryContactFromBusinessWebsite(array $contact): array
{
    $website = normalizeWebsite(trim((string)($contact['website'] ?? '')));
    if ($website === '') {
        return $contact;
    }
    try {
        $siteContact = extractContactFromHtml(httpGet($website), $website);
    } catch (Throwable $e) {
        return $contact;
    }
    $siteEmail = strtolower(trim((string)($siteContact['email'] ?? '')));
    if ($siteEmail === '' || !filter_var($siteEmail, FILTER_VALIDATE_EMAIL)) {
        return $contact;
    }
    $contact['email'] = $siteEmail;
    foreach (['subject_name', 'address', 'name'] as $field) {
        if (trim((string)($contact[$field] ?? '')) === '' && trim((string)($siteContact[$field] ?? '')) !== '') {
            $contact[$field] = $siteContact[$field];
        }
    }
    $contact['website'] = $website;
    return $contact;
}

function extractDirectoryWebsite(string $html, string $baseUrl, array $sourceHosts, string $jsonUrl = ''): string
{
    if ($jsonUrl !== '' && isExternalDirectoryUrl($jsonUrl, $sourceHosts)) {
        return cleanupWebsiteUrl($jsonUrl);
    }
    if (preg_match('/data-webseiteLink=(["\'])([A-Za-z0-9+\/=]+)\1/i', $html, $encodedMatch)) {
        $decoded = base64_decode($encodedMatch[2], true);
        if (is_string($decoded) && isExternalDirectoryUrl($decoded, $sourceHosts)) {
            return cleanupWebsiteUrl($decoded);
        }
    }
    preg_match_all('/href=(["\'])(.*?)\1/i', $html, $matches);
    foreach ($matches[2] ?? [] as $href) {
        $href = html_entity_decode($href, ENT_QUOTES, 'UTF-8');
        if (stripos($href, 'mailto:') === 0 || stripos($href, 'tel:') === 0) {
            continue;
        }
        $url = normalizeSearchResultUrl(normalizeUrl($href, $baseUrl));
        if (isExternalDirectoryUrl($url, $sourceHosts)) {
            return cleanupWebsiteUrl($url);
        }
    }
    return '';
}

function isExternalDirectoryUrl(string $url, array $sourceHosts): bool
{
    if ($url === '' || !preg_match('/^https?:\/\//i', $url)) {
        return false;
    }
    $host = strtolower((string)(parse_url($url, PHP_URL_HOST) ?: ''));
    if ($host === '') {
        return false;
    }
    foreach ($sourceHosts as $sourceHost) {
        $sourceHost = strtolower((string)$sourceHost);
        if ($host === $sourceHost || str_ends_with($host, '.' . $sourceHost)) {
            return false;
        }
    }
    return !preg_match('/(?:google|facebook|instagram|linkedin|youtube|tiktok|pinterest|apple|play\.google|consentmanager|doubleclick|adition|wipe)\./i', $host);
}

function directoryAddress(array $json): string
{
    $address = $json['address'] ?? [];
    if (!is_array($address)) {
        return '';
    }
    $city = trim(implode(' ', array_filter([
        trim((string)($address['postalCode'] ?? '')),
        trim((string)($address['addressLocality'] ?? '')),
    ])));
    $parts = array_filter([
        trim((string)($address['streetAddress'] ?? '')),
        $city,
    ]);
    return implode(', ', $parts);
}

function extractCloudflareProtectedEmail(string $html): string
{
    if (preg_match('/data-cfemail=(["\'])([a-f0-9]+)\1/i', $html, $match)) {
        return decodeCloudflareEmail($match[2]);
    }
    if (preg_match('#/cdn-cgi/l/email-protection\#([a-f0-9]+)#i', $html, $match)) {
        return decodeCloudflareEmail($match[1]);
    }
    return '';
}

function decodeCloudflareEmail(string $hex): string
{
    if ($hex === '' || strlen($hex) < 4 || strlen($hex) % 2 !== 0 || !ctype_xdigit($hex)) {
        return '';
    }
    $key = hexdec(substr($hex, 0, 2));
    $email = '';
    for ($i = 2; $i < strlen($hex); $i += 2) {
        $email .= chr(hexdec(substr($hex, $i, 2)) ^ $key);
    }
    return filter_var($email, FILTER_VALIDATE_EMAIL) ? $email : '';
}

function extractDasTelefonbuchWebsite(string $html): string
{
    preg_match_all('/<a\b[^>]*href=(["\'])(.*?)\1[^>]*>/is', $html, $matches);
    foreach ($matches[0] ?? [] as $index => $tag) {
        $href = (string)($matches[2][$index] ?? '');
        $url = normalizeUrl(html_entity_decode($href, ENT_QUOTES, 'UTF-8'), 'https://adresse.dastelefonbuch.de/');
        if ($url === '' || !preg_match('/^https?:\/\//i', $url)) {
            continue;
        }
        $host = strtolower((string)(parse_url($url, PHP_URL_HOST) ?: ''));
        if ($host === '' || str_contains($host, 'dastelefonbuch.de') || str_contains($host, 'telefonbuch.de') || str_contains($host, 'google.') || str_contains($host, 'facebook.')) {
            continue;
        }
        if (stripos($tag, 'itemprop="url"') !== false || stripos($tag, "itemprop='url'") !== false || stripos($tag, 'DS URL') !== false) {
            return cleanupWebsiteUrl($url);
        }
    }
    return '';
}

function extractDasTelefonbuchAddress(string $html): string
{
    if (!preg_match('/<address\b[^>]*itemprop=(["\'])address\1[^>]*>(.*?)<\/address>/is', $html, $match)
        && !preg_match('/<address\b[^>]*>(.*?)<\/address>/is', $html, $match)) {
        return '';
    }
    $block = (string)($match[2] ?? $match[1] ?? '');
    $block = preg_replace('#<br\s*/?>#i', "\n", $block) ?? $block;
    $text = html_entity_decode(strip_tags($block), ENT_QUOTES, 'UTF-8');
    $lines = preg_split('/\R+/', $text) ?: [];
    $parts = [];
    foreach ($lines as $line) {
        $line = trim(preg_replace('/\s+/', ' ', $line) ?? '');
        if ($line !== '') {
            $parts[] = $line;
        }
    }
    return implode(', ', $parts);
}

function extractZoznamWebsite(string $html, string $jsonUrl): string
{
    if ($jsonUrl !== '') {
        return cleanupWebsiteUrl($jsonUrl);
    }
    preg_match_all('/href=(["\'])(.*?)\1/i', $html, $matches);
    foreach ($matches[2] ?? [] as $href) {
        $url = normalizeUrl(html_entity_decode($href, ENT_QUOTES, 'UTF-8'), 'https://www.zoznam.sk/');
        $url = normalizeSearchResultUrl($url);
        if ($url === '' || !preg_match('/^https?:\/\//i', $url)) {
            continue;
        }
        $host = strtolower((string)(parse_url($url, PHP_URL_HOST) ?: ''));
        if ($host === '' || str_contains($host, 'zoznam.sk') || str_contains($host, 'google.') || str_contains($host, 'facebook.')) {
            continue;
        }
        return cleanupWebsiteUrl($url);
    }
    return '';
}

function zoznamAddress(array $json): string
{
    $address = $json['address'] ?? [];
    if (!is_array($address)) {
        return '';
    }
    $city = trim(implode(' ', array_filter([
        trim((string)($address['postalCode'] ?? '')),
        trim((string)($address['addressLocality'] ?? '')),
    ])));
    $parts = array_filter([
        trim((string)($address['streetAddress'] ?? '')),
        $city,
    ]);
    return implode(', ', $parts);
}

function extractZoznamAddress(string $html): string
{
    $lines = htmlTextLines($html);
    foreach ($lines as $index => $line) {
        if (!preg_match('/^Adresa:?$/iu', $line)) {
            continue;
        }
        for ($i = $index + 1; $i < min(count($lines), $index + 5); $i++) {
            $candidate = trim((string)$lines[$i]);
            if ($candidate === '' || preg_match('/^(Web|E-mail|Email|Telefon|Mobil):?$/iu', $candidate)) {
                continue;
            }
            return $candidate;
        }
    }
    return '';
}

function extractHeroldListingContacts(string $html, string $baseUrl): array
{
    $lines = htmlTextLines($html);
    $contacts = [];
    $seen = [];
    foreach ($lines as $index => $line) {
        if (!preg_match('/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i', $line, $emailMatch)) {
            continue;
        }
        $email = strtolower(trim((string)$emailMatch[0]));
        if (isset($seen[$email])) {
            continue;
        }
        $seen[$email] = true;
        $contactIndex = heroldPreviousLineIndex($lines, $index, '/^Kontakt:?$/iu', 10);
        $detailIndex = $contactIndex >= 0 ? heroldPreviousLineIndex($lines, $contactIndex, '/^Mehr Details$/iu', 18) : -1;
        $subjectName = heroldListingSubject($lines, $detailIndex >= 0 ? $detailIndex : $index);
        $website = '';
        $address = '';
        for ($i = $index + 1; $i < min(count($lines), $index + 8); $i++) {
            if ($website === '' && preg_match('/https?:\/\/[^\s]+/i', $lines[$i], $urlMatch)) {
                $candidate = cleanupWebsiteUrl($urlMatch[0]);
                $host = strtolower((string)(parse_url($candidate, PHP_URL_HOST) ?: ''));
                if ($host !== '' && !str_contains($host, 'herold.at')) {
                    $website = $candidate;
                }
            }
            if ($address === '' && isLikelyHeroldAddress($lines[$i])) {
                $address = $lines[$i];
            }
        }
        $sourceUrl = rtrim($baseUrl, '/') . '#contact-' . substr(sha1($email), 0, 12);
        $contacts[] = [
            'email' => $email,
            'subject_name' => $subjectName,
            'website' => $website,
            'address' => $address,
            'name' => '',
            '_source_url' => $sourceUrl,
        ];
    }
    return $contacts;
}

function extractPanoramaFirmListingContacts(string $html, string $baseUrl): array
{
    $contacts = [];
    $seen = [];
    foreach (panoramaFirmJsonLdBusinesses($html) as $business) {
        $email = strtolower(trim((string)($business['email'] ?? '')));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || isset($seen[$email])) {
            continue;
        }
        $detailUrl = normalizePanoramaFirmDetailUrl((string)($business['url'] ?? ''));
        if ($detailUrl === '') {
            $detailUrl = rtrim($baseUrl, '/') . '#contact-' . substr(sha1($email), 0, 12);
        }
        $seen[$email] = true;
        $contacts[] = [
            'email' => $email,
            'subject_name' => trim((string)($business['name'] ?? '')),
            'website' => panoramaFirmBusinessWebsite($business),
            'address' => directoryAddress($business),
            'name' => '',
            '_source_url' => $detailUrl,
        ];
    }
    return $contacts;
}

function panoramaFirmJsonLdBusinesses(string $html): array
{
    preg_match_all('#<script[^>]+type=(["\'])application/ld\+json\1[^>]*>(.*?)</script>#is', $html, $matches);
    $businesses = [];
    foreach ($matches[2] ?? [] as $raw) {
        $decoded = json_decode(html_entity_decode(trim($raw), ENT_QUOTES, 'UTF-8'), true);
        if (!is_array($decoded)) {
            continue;
        }
        $items = isset($decoded[0]) && is_array($decoded[0]) ? $decoded : [$decoded];
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }
            $type = $item['@type'] ?? '';
            $types = is_array($type) ? $type : [$type];
            if (in_array('LocalBusiness', $types, true) && normalizePanoramaFirmDetailUrl((string)($item['url'] ?? '')) !== '') {
                $businesses[] = $item;
            }
        }
    }
    return $businesses;
}

function panoramaFirmBusinessWebsite(array $business): string
{
    $sameAs = $business['sameAs'] ?? [];
    $urls = is_array($sameAs) ? $sameAs : [$sameAs];
    foreach ($urls as $url) {
        $url = cleanupWebsiteUrl((string)$url);
        if ($url === '') {
            continue;
        }
        $host = strtolower((string)(parse_url($url, PHP_URL_HOST) ?: ''));
        if ($host !== '' && !preg_match('/(^|\.)panoramafirm\.pl$/i', $host)) {
            return $url;
        }
    }
    return '';
}

function panoramaFirmTotalResults(string $html): int
{
    if (preg_match('/content=(["\'])(\d[\d\s]*)\s+firm\s+z\s+bran[żz]y/i', $html, $match)) {
        return (int)preg_replace('/\D+/', '', $match[2]);
    }
    if (preg_match('/-\s*(\d[\d\s]*)\s+firm\b/iu', html_entity_decode(strip_tags($html), ENT_QUOTES, 'UTF-8'), $match)) {
        return (int)preg_replace('/\D+/', '', $match[1]);
    }
    return 0;
}

function heroldPreviousLineIndex(array $lines, int $from, string $pattern, int $limit): int
{
    for ($i = $from - 1; $i >= max(0, $from - $limit); $i--) {
        if (preg_match($pattern, (string)$lines[$i])) {
            return $i;
        }
    }
    return -1;
}

function heroldListingSubject(array $lines, int $beforeIndex): string
{
    $start = max(0, $beforeIndex - 12);
    $marker = -1;
    for ($i = $beforeIndex - 1; $i >= $start; $i--) {
        if (preg_match('/^(Verifiziert|Nicht verifiziert|TIP TOP\b.*)$/iu', (string)$lines[$i])) {
            $marker = $i;
            break;
        }
    }
    $from = $marker >= 0 ? $marker + 1 : $start;
    for ($i = $from; $i < $beforeIndex; $i++) {
        $candidate = trim((string)$lines[$i]);
        if (isLikelyHeroldListingSubject($candidate)) {
            return $candidate;
        }
    }
    return '';
}

function isLikelyHeroldListingSubject(string $line): bool
{
    if ($line === '' || strlen($line) > 130) {
        return false;
    }
    if (preg_match('/^(Image:|Mehr Details|Kontakt:?|Jetzt geoeffnet|Jetzt geöffnet|Termin buchen|Online Buchung|Verifiziert|Nicht verifiziert|TIP TOP\b)/iu', $line)) {
        return false;
    }
    if (preg_match('/^\d{4}\s+\p{L}/u', $line) || preg_match('/^\d+[.,]\d+\s*\(\d+\)$/u', $line)) {
        return false;
    }
    if (preg_match('/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i', $line) || preg_match('/https?:\/\//i', $line)) {
        return false;
    }
    return !isLikelyHeroldAddress($line);
}

function extractHeroldWebsite(string $html): string
{
    preg_match_all('/href=(["\'])(.*?)\1/i', $html, $matches);
    foreach ($matches[2] ?? [] as $href) {
        $url = normalizeUrl(html_entity_decode($href, ENT_QUOTES, 'UTF-8'), 'https://www.herold.at/');
        $url = normalizeSearchResultUrl($url);
        if ($url === '' || !preg_match('/^https?:\/\//i', $url)) {
            continue;
        }
        $host = strtolower((string)(parse_url($url, PHP_URL_HOST) ?: ''));
        if ($host === '' || str_contains($host, 'herold.at') || str_contains($host, 'karriere.herold.at') || str_contains($host, 'login.herold.at')) {
            continue;
        }
        return cleanupWebsiteUrl($url);
    }
    return '';
}

function extractHeroldAddress(string $html, string $subjectName): string
{
    $lines = htmlTextLines($html);
    $subjectIndex = -1;
    foreach ($lines as $index => $line) {
        if ($subjectName !== '' && trim($line) === $subjectName) {
            $subjectIndex = $index;
            break;
        }
    }
    if ($subjectIndex >= 0) {
        for ($i = $subjectIndex + 1; $i < min(count($lines), $subjectIndex + 8); $i++) {
            if (isLikelyHeroldAddress($lines[$i])) {
                return $lines[$i];
            }
        }
    }
    foreach ($lines as $line) {
        if (isLikelyHeroldAddress($line)) {
            return $line;
        }
    }
    return '';
}

function htmlTextLines(string $html): array
{
    $html = preg_replace('#<(script|style)\b[^>]*>.*?</\1>#is', '', $html) ?? $html;
    $html = preg_replace('#<(br|p|div|li|h1|h2|h3|section|article|address)\b[^>]*>#i', "\n", $html) ?? $html;
    $text = html_entity_decode(strip_tags($html), ENT_QUOTES, 'UTF-8');
    $lines = preg_split('/\R+/', $text) ?: [];
    $clean = [];
    foreach ($lines as $line) {
        $line = trim(preg_replace('/\s+/', ' ', $line) ?? '');
        if ($line !== '') {
            $clean[] = $line;
        }
    }
    return $clean;
}

function isLikelyHeroldAddress(string $line): bool
{
    if (strlen($line) > 180 || !preg_match('/\b\d{4}\b/', $line)) {
        return false;
    }
    if (preg_match('/Bewertung|Bewertungen|Datenstand|Seite\s+\d+|Rufnummer|Telefon|Kontakt|Öffnungszeiten|Oeffnungszeiten/i', $line)) {
        return false;
    }
    return preg_match('/\p{L}{2,}.*\d+[a-zA-Z\/-]*.*\b\d{4}\b/u', $line) === 1 || preg_match('/\b\d{4}\b\s+\p{L}{2,}/u', $line) === 1;
}

function firmyJsonLd(string $html): array
{
    preg_match_all('#<script[^>]+type=(["\'])application/ld\+json\1[^>]*>(.*?)</script>#is', $html, $matches);
    foreach ($matches[2] ?? [] as $raw) {
        $decoded = json_decode(html_entity_decode(trim($raw), ENT_QUOTES, 'UTF-8'), true);
        if (!is_array($decoded)) {
            continue;
        }
        $candidates = isset($decoded[0]) && is_array($decoded[0]) ? $decoded : [$decoded];
        foreach ($candidates as $candidate) {
            $type = $candidate['@type'] ?? '';
            $types = is_array($type) ? $type : [$type];
            if (array_intersect($types, ['LocalBusiness', 'Organization', 'Place'])) {
                return $candidate;
            }
            if (!empty($candidate['name']) && (!empty($candidate['address']) || !empty($candidate['url']))) {
                return $candidate;
            }
        }
    }
    return [];
}

function extractFirmyWebsite(string $html, string $jsonUrl): string
{
    if (preg_match('/class=(["\'])[^"\']*\bdetailWebUrl\b[^"\']*\1[^>]*href=(["\'])(.*?)\2/is', $html, $match)) {
        return cleanupWebsiteUrl(html_entity_decode($match[3], ENT_QUOTES, 'UTF-8'));
    }
    if ($jsonUrl !== '') {
        return cleanupWebsiteUrl($jsonUrl);
    }
    return '';
}

function cleanupWebsiteUrl(string $url): string
{
    $url = normalizeWebsite(trim($url));
    if ($url === '') {
        return '';
    }
    $parts = parse_url($url);
    if (!$parts || empty($parts['host'])) {
        return $url;
    }
    $query = [];
    parse_str((string)($parts['query'] ?? ''), $query);
    foreach (array_keys($query) as $key) {
        if (stripos($key, 'utm_') === 0) {
            unset($query[$key]);
        }
    }
    $clean = ($parts['scheme'] ?? 'https') . '://' . $parts['host'];
    if (!empty($parts['path'])) {
        $clean .= $parts['path'];
    }
    if ($query) {
        $clean .= '?' . http_build_query($query);
    }
    if (!empty($parts['fragment'])) {
        $clean .= '#' . $parts['fragment'];
    }
    return $clean;
}

function firmyAddress(array $json): string
{
    $address = $json['address'] ?? [];
    if (!is_array($address)) {
        return '';
    }
    $parts = array_filter([
        trim((string)($address['streetAddress'] ?? '')),
        trim((string)($address['addressLocality'] ?? '')),
    ]);
    return implode(', ', $parts);
}

function extractWebsiteFromText(string $text, string $sourceUrl): string
{
    preg_match_all('/(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9\-]{1,63}(?:\.[a-z0-9][a-z0-9\-]{1,63})+\b(?:\/[^\s]*)?/i', $text, $matches);
    foreach ($matches[0] ?? [] as $candidate) {
        $candidate = trim($candidate, " \t\n\r\0\x0B.,;:)");
        $host = parse_url(normalizeWebsite($candidate), PHP_URL_HOST) ?: '';
        if ($host === '' || stripos($host, 'firmy.cz') !== false || stripos($host, 'seznam.cz') !== false) {
            continue;
        }
        return normalizeWebsite($candidate);
    }
    return originUrl($sourceUrl);
}

function extractAddressFromText(string $text): string
{
    $compact = trim(preg_replace('/\s+/', ' ', $text));
    if (preg_match('/([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][^,\n]{2,60}\s+\d+[a-zA-Z]?(?:\/\d+)?\s*,\s*[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][^,\n]{2,60})/u', $compact, $match)) {
        return trim($match[1]);
    }
    return '';
}

function normalizeUrl(string $href, string $baseUrl): string
{
    $href = trim($href);
    if ($href === '' || strpos($href, '#') === 0 || stripos($href, 'mailto:') === 0 || stripos($href, 'tel:') === 0) {
        return '';
    }
    if (strpos($href, '//') === 0) {
        return 'https:' . $href;
    }
    if (preg_match('/^https?:\/\//i', $href)) {
        return strtok($href, '#') ?: $href;
    }
    $parts = parse_url($baseUrl);
    if (!$parts || empty($parts['scheme']) || empty($parts['host'])) {
        return '';
    }
    $base = $parts['scheme'] . '://' . $parts['host'];
    if (strpos($href, '/') === 0) {
        return $base . $href;
    }
    $path = isset($parts['path']) ? dirname($parts['path']) : '';
    return $base . rtrim($path, '/') . '/' . $href;
}

function originUrl(string $url): string
{
    $parts = parse_url($url);
    if (!$parts || empty($parts['scheme']) || empty($parts['host'])) {
        return $url;
    }
    return $parts['scheme'] . '://' . $parts['host'] . '/';
}

function updateScrapingJob(PDO $pdo, int $jobId, array $fields): void
{
    $fields['updated_at'] = date('c');
    $newStatus = isset($fields['status']) ? (string)$fields['status'] : '';
    $sets = [];
    $values = [];
    foreach ($fields as $field => $value) {
        $sets[] = $field . '=?';
        $values[] = $value;
    }
    $values[] = $jobId;
    $guard = 'status NOT IN ("finished", "failed", "cancelled")';
    if ($newStatus === 'cancelled') {
        $guard = '1=1';
    } elseif (in_array($newStatus, ['finished', 'failed'], true)) {
        $guard = 'status!="cancelled"';
    }
    $stmt = $pdo->prepare('UPDATE scraping_jobs SET ' . implode(', ', $sets) . ' WHERE id=? AND ' . $guard);
    $stmt->execute($values);
}

function incrementScrapingJob(PDO $pdo, int $jobId, string $processedColumn, string $resultColumn, string $message): void
{
    $allowed = ['processed_count', 'inserted_count', 'updated_count', 'skipped_count'];
    if (!in_array($processedColumn, $allowed, true) || !in_array($resultColumn, $allowed, true)) {
        throw new RuntimeException('Neplatny citac scraping jobu.');
    }
    $stmt = $pdo->prepare("UPDATE scraping_jobs SET $processedColumn=$processedColumn+1, $resultColumn=$resultColumn+1, updated_at=? WHERE id=?");
    $stmt->execute([date('c'), $jobId]);
}

function markScrapingItem(PDO $pdo, int $itemId, string $status, array $contact, string $message): void
{
    $stmt = $pdo->prepare('UPDATE scraping_job_items SET status=?, email=?, subject_name=?, website=?, address=?, message=?, processed_at=? WHERE id=?');
    $stmt->execute([
        $status,
        (string)($contact['email'] ?? ''),
        (string)($contact['subject_name'] ?? ''),
        (string)($contact['website'] ?? ''),
        (string)($contact['address'] ?? ''),
        substr($message, 0, 500),
        date('c'),
        $itemId,
    ]);
}

function finishScrapingJob(PDO $pdo, int $jobId, string $message): void
{
    refreshScrapingJobCounters($pdo, $jobId);
    $job = findScrapingJob($pdo, $jobId);
    if ($job['status'] !== 'finished') {
        logScrapingImportRun($pdo, $job);
    }
    updateScrapingJob($pdo, $jobId, ['status' => 'finished', 'last_message' => scrapingJobOutcomeText($job), 'finished_at' => date('c')]);
}

function failScrapingJob(PDO $pdo, int $jobId, string $message): void
{
    updateScrapingJob($pdo, $jobId, ['status' => 'failed', 'last_message' => substr('Selhalo: ' . preg_replace('/^Chyba behu:\s*/', '', $message), 0, 500), 'finished_at' => date('c')]);
}

function scrapingJobOutcomeText(array $job): string
{
    $contacts = (int)$job['inserted_count'] + (int)$job['updated_count'];
    return 'Dokonceno: nalezeno ' . (int)$job['discovered_count'] . ' URL, zpracovano ' . (int)$job['processed_count'] . ', kontakty ' . $contacts . ', preskoceno ' . (int)$job['skipped_count'] . '.';
}

function scrapingJobLogMessage(array $job): string
{
    if ($job['status'] === 'finished') {
        return scrapingJobOutcomeText($job);
    }
    if ($job['status'] === 'failed') {
        $message = trim((string)$job['last_message']);
        if ($message === '') {
            return 'Selhalo.';
        }
        return $message !== '' && stripos($message, 'Selhalo:') === 0 ? $message : 'Selhalo: ' . $message;
    }
    if ($job['status'] === 'cancelled') {
        $message = trim((string)$job['last_message']);
        return $message !== '' ? $message : 'Preruseno.';
    }
    return '';
}

function logScrapingImportRun(PDO $pdo, array $job): void
{
    $sources = scrapingSources();
    $fileName = 'scraping: ' . ($sources[$job['source']] ?? $job['source']) . ' / ' . $job['keyword'];
    $stmt = $pdo->prepare('INSERT INTO import_runs (list_id, list_name, file_name, inserted_count, updated_count, skipped_count, total_rows, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([
        (int)$job['list_id'],
        contactListName($pdo, (int)$job['list_id']),
        $fileName,
        (int)$job['inserted_count'],
        (int)$job['updated_count'],
        (int)$job['skipped_count'],
        (int)$job['processed_count'],
        date('c'),
    ]);
    saveScrapingImportDetails($pdo, (int)$pdo->lastInsertId(), (int)$job['id']);
}

function saveScrapingImportDetails(PDO $pdo, int $importRunId, int $jobId): void
{
    $stmt = $pdo->prepare('SELECT * FROM scraping_job_items WHERE job_id=? AND status!="queued" ORDER BY id ASC');
    $stmt->execute([$jobId]);
    $items = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $rows = [];
    $rowNumber = 0;
    foreach ($items as $item) {
        $rowNumber++;
        $result = in_array($item['status'], ['inserted', 'updated'], true) ? $item['status'] : 'skipped';
        $reason = $item['message'] ?: ($result === 'skipped' ? 'Kontakt nebyl vlozen.' : 'Kontakt ulozen.');
        $rows[] = importDetailRow(
            $rowNumber,
            $result,
            $reason,
            (string)$item['email'],
            (string)$item['subject_name'],
            (string)$item['website'],
            (string)$item['address'],
            [(string)$item['url'], (string)$item['status'], (string)$item['message']]
        );
    }
    saveImportDetailRows($pdo, $importRunId, $rows);
}

function setScrapingJobStatus(PDO $pdo, int $jobId, string $status): void
{
    findScrapingJob($pdo, $jobId);
    updateScrapingJob($pdo, $jobId, ['status' => $status, 'last_message' => 'Stav zmenen na ' . $status . '.']);
}

function cancelScrapingJob(PDO $pdo, int $jobId): void
{
    $job = findScrapingJob($pdo, $jobId);
    if (!in_array((string)$job['status'], ['queued', 'running', 'paused'], true)) {
        return;
    }

    $now = date('c');
    $message = 'Preruseno uzivatelem. Jiz vlozene a aktualizovane kontakty zustaly ulozene.';
    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare('UPDATE scraping_jobs SET status=?, last_message=?, finished_at=?, updated_at=? WHERE id=? AND status IN ("queued", "running", "paused")');
        $stmt->execute(['cancelled', $message, $now, $now, $jobId]);

        $items = $pdo->prepare('UPDATE scraping_job_items SET status=?, message=?, processed_at=? WHERE job_id=? AND status="queued"');
        $items->execute(['cancelled', 'Preruseno pred zpracovanim.', $now, $jobId]);
        refreshScrapingJobCounters($pdo, $jobId);
        if ((int)($job['container_id'] ?? 0) > 0) {
            $container = $pdo->prepare('
                UPDATE scraping_containers
                SET last_scheduled_at=CASE WHEN schedule_enabled=1 THEN ? ELSE last_scheduled_at END,
                    updated_at=?
                WHERE id=?
            ');
            $container->execute([$now, $now, (int)$job['container_id']]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
}

function refreshScrapingJobCounters(PDO $pdo, int $jobId): void
{
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM scraping_job_items WHERE job_id=?');
    $stmt->execute([$jobId]);
    $discovered = (int)$stmt->fetchColumn();
    $stmt = $pdo->prepare('UPDATE scraping_jobs SET discovered_count=?, updated_at=? WHERE id=?');
    $stmt->execute([$discovered, date('c'), $jobId]);
}

function isMysql(PDO $pdo): bool
{
    return $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql';
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

function boolish(string $value): int
{
    $value = strtolower(trim($value));
    if ($value === '') {
        return 0;
    }
    return in_array($value, ['1', 'true', 'yes', 'y', 'ano', 'a', 'osloven', 'osloveno', 'sent', 'odeslano', 'poslano'], true) ? 1 : 0;
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

function websiteLabel(string $url): string
{
    $host = parse_url($url, PHP_URL_HOST);
    return $host ? preg_replace('/^www\./i', '', $host) : $url;
}

function resolveContactList(PDO $pdo, string $name): int
{
    $name = $name !== '' ? $name : 'Vychozi seznam';
    $find = $pdo->prepare('SELECT id FROM contact_databases WHERE name=? AND COALESCE(archived, 0)=0');
    $find->execute([$name]);
    $existing = (int)$find->fetchColumn();
    if ($existing > 0) {
        return $existing;
    }
    $stmt = $pdo->prepare('INSERT INTO contact_databases (name, created_at) VALUES (?, ?)');
    $stmt->execute([$name, date('c')]);
    return (int)$pdo->lastInsertId();
}

function createContactDatabase(PDO $pdo, string $name): int
{
    if ($name === '') {
        throw new RuntimeException('Zadej nazev databaze kontaktu.');
    }
    return resolveContactList($pdo, $name);
}

function renameContactDatabase(PDO $pdo, int $id, string $name): void
{
    if ($id < 1 || !contactListExists($pdo, $id)) {
        throw new RuntimeException('Databaze kontaktu nenalezena.');
    }
    if ($name === '') {
        throw new RuntimeException('Zadej novy nazev databaze kontaktu.');
    }
    $stmt = $pdo->prepare('UPDATE contact_databases SET name=? WHERE id=?');
    $stmt->execute([$name, $id]);
}

function archiveContactDatabase(PDO $pdo, int $id): void
{
    if ($id < 1 || !contactListExists($pdo, $id)) {
        throw new RuntimeException('Databaze kontaktu nenalezena.');
    }
    $now = date('c');
    $pdo->beginTransaction();
    try {
        $nameStmt = $pdo->prepare('SELECT name FROM contact_databases WHERE id=? AND COALESCE(archived, 0)=0');
        $nameStmt->execute([$id]);
        $name = (string)$nameStmt->fetchColumn();
        if ($name === '') {
            throw new RuntimeException('Databaze kontaktu nenalezena.');
        }
        $suffix = ' [archiv #' . $id . ']';
        $archivedName = substr($name, 0, max(1, 255 - strlen($suffix))) . $suffix;
        $pdo->prepare('UPDATE contact_databases SET name=?, archived=1, archived_at=? WHERE id=?')->execute([$archivedName, $now, $id]);
        $pdo->prepare('UPDATE recipients SET archived=1, updated_at=? WHERE list_id=?')->execute([$now, $id]);
        $pdo->prepare('UPDATE campaigns SET status="paused", updated_at=? WHERE list_id=? AND status="active"')->execute([$now, $id]);
        $pdo->prepare('UPDATE scraping_containers SET status="deleted", updated_at=? WHERE list_id=? AND status!="deleted"')->execute([$now, $id]);
        $pdo->prepare('
            UPDATE scraping_jobs
            SET status="cancelled",
                last_message="Preruseno: databaze kontaktu byla archivovana.",
                finished_at=CASE WHEN finished_at="" THEN ? ELSE finished_at END,
                updated_at=?
            WHERE list_id=?
              AND status IN ("queued", "running", "paused")
        ')->execute([$now, $now, $id]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
}

function selectedPostListId(PDO $pdo): int
{
    $id = (int)($_POST['database_id'] ?? $_POST['list_id'] ?? 0);
    if ($id > 0 && contactListExists($pdo, $id)) {
        return $id;
    }
    if ($id > 0) {
        throw new RuntimeException('Vybrana databaze kontaktu neni dostupna.');
    }
    return resolveContactList($pdo, trim((string)($_POST['list_name'] ?? '')));
}

function selectedRequestListId(PDO $pdo): int
{
    $id = (int)($_GET['database_id'] ?? $_GET['list_id'] ?? 0);
    return $id > 0 && contactListExists($pdo, $id) ? $id : 0;
}

function contactDatabaseUrl(int $id): string
{
    return routeUrl('contacts') . '&database_id=' . $id;
}

function contactMetricUrl(int $listId, string $metric): string
{
    return contactPageUrl($listId, ['metric' => $metric]);
}

function contactPageUrl(int $listId, array $params = []): string
{
    $query = array_merge([
        'route' => 'contacts',
        'database_id' => $listId,
    ], $params);
    foreach ($query as $key => $value) {
        if ($value === '' || $value === null) {
            unset($query[$key]);
        }
    }
    return './?' . http_build_query($query);
}

function contactSortUrl(int $listId, array $page, string $sort): string
{
    $dir = ($page['sort'] ?? '') === $sort && ($page['dir'] ?? 'asc') === 'asc' ? 'desc' : 'asc';
    return contactPageUrl($listId, [
        'q' => $page['q'] ?? '',
        'metric' => $page['metric'] ?? '',
        'sort' => $sort,
        'dir' => $dir,
        'per_page' => $page['per_page'] ?? 100,
    ]);
}

function contactSortHeader(int $listId, array $page, string $sort, string $label): string
{
    $active = ($page['sort'] ?? '') === $sort;
    $dir = (string)($page['dir'] ?? 'asc');
    $next = $active && $dir === 'asc' ? 'desc' : 'asc';
    $arrow = $active ? ($dir === 'asc' ? '&uarr;' : '&darr;') : '&varr;';
    $class = 'contact-sort-link' . ($active ? ' is-active' : '');
    $aria = $active ? ($dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return '<a class="' . $class . '" aria-sort="' . $aria . '" title="Radit podle: ' . h($label) . ', dalsi smer ' . h($next) . '" href="' . h(contactSortUrl($listId, $page, $sort)) . '"><span>' . h($label) . '</span><span class="sort-arrow" aria-hidden="true">' . $arrow . '</span></a>';
}

function contactPaginationUrl(int $listId, array $page, int $targetPage): string
{
    return contactPageUrl($listId, [
        'q' => $page['q'] ?? '',
        'metric' => $page['metric'] ?? '',
        'sort' => $page['sort'] ?? 'created_at',
        'dir' => $page['dir'] ?? 'desc',
        'per_page' => $page['per_page'] ?? 100,
        'page' => $targetPage,
    ]);
}

function contactListExists(PDO $pdo, int $id): bool
{
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM contact_databases WHERE id=? AND COALESCE(archived, 0)=0');
    $stmt->execute([$id]);
    return (int)$stmt->fetchColumn() > 0;
}

function contactListName(PDO $pdo, int $id): string
{
    $stmt = $pdo->prepare('SELECT name FROM contact_databases WHERE id=?');
    $stmt->execute([$id]);
    return (string)($stmt->fetchColumn() ?: 'Vychozi seznam');
}

function findContactList(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM contact_databases WHERE id=? AND COALESCE(archived, 0)=0');
    $stmt->execute([$id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function normalizeScheduleTime(string $time): string
{
    $time = trim($time) ?: '09:00';
    if (!preg_match('/^\d{2}:\d{2}$/', $time)) {
        throw new RuntimeException('Cas planu musi byt ve formatu HH:MM.');
    }
    [$hour, $minute] = array_map('intval', explode(':', $time));
    if ($hour > 23 || $minute > 59) {
        throw new RuntimeException('Cas planu neni platny.');
    }
    return sprintf('%02d:%02d', $hour, $minute);
}

function toggleCampaignStatus(PDO $pdo, int $campaignId): string
{
    $campaign = findCampaign($pdo, $campaignId);
    $newStatus = $campaign['status'] === 'active' ? 'paused' : 'active';
    $lastScheduledSql = $newStatus === 'active' ? ', last_scheduled_at=""' : '';
    $stmt = $pdo->prepare('UPDATE campaigns SET status=?, updated_at=?' . $lastScheduledSql . ' WHERE id=?');
    $stmt->execute([$newStatus, date('c'), $campaignId]);
    return $newStatus === 'active' ? 'Kampan spustena.' : 'Kampan pozastavena.';
}

function campaignScheduleConfigChanged(array $current, array $next): bool
{
    foreach ($next as $key => $value) {
        $old = $current[$key] ?? null;
        if (is_int($value)) {
            if ((int)$old !== $value) {
                return true;
            }
            continue;
        }
        if ((string)$old !== (string)$value) {
            return true;
        }
    }
    return false;
}

function queueCampaignBatch(PDO $pdo, int $campaignId): string
{
    $campaign = findCampaign($pdo, $campaignId);
    $runId = createCampaignSendRun($pdo, $campaignId, 'manual', 'queued', 'Rucni odesilani kampane "' . (string)$campaign['name'] . '" bylo spusteno na pozadi.');
    triggerCampaignWorker($pdo, $campaignId, $runId);
    return 'Odesilani kampane bezi na pozadi. Prubeh uvidis v poslednim odeslani.';
}

function triggerCampaignWorker(PDO $pdo, int $campaignId, int $runId = 0): void
{
    $token = scrapingWorkerToken($pdo, true);
    if ($token === '') {
        return;
    }
    fireAndForgetGet(appBaseUrl() . '?worker=campaigns&campaign_id=' . $campaignId . '&run_id=' . $runId . '&token=' . rawurlencode($token));
}

function runCampaignWorker(PDO $pdo, array $config, int $campaignId, int $runId = 0): string
{
    ignore_user_abort(true);
    if (function_exists('set_time_limit')) {
        @set_time_limit(0);
    }
    $now = time();
    $lockUntil = (int)(loadSettings($pdo)['campaign_worker_lock_until'] ?? 0);
    if ($lockUntil > $now) {
        return "Campaign worker: uz bezi, davka zustava ve fronte.\n";
    }
    setSetting($pdo, 'campaign_worker_lock_until', (string)($now + 900));
    try {
        $runType = $runId > 0 ? campaignSendRunType($pdo, $runId, 'manual') : 'manual';
        $message = trim(sendBatch($pdo, $config, $campaignId > 0 ? $campaignId : null, $runId, $runType));
        return $message . "\n";
    } catch (Throwable $e) {
        if ($runId > 0) {
            updateCampaignSendRun($pdo, $runId, ['status' => 'failed', 'message' => 'Odesilani na pozadi selhalo: ' . $e->getMessage(), 'finished_at' => date('c')]);
        }
        throw $e;
    } finally {
        setSetting($pdo, 'campaign_worker_lock_until', '');
        triggerNextQueuedCampaignRun($pdo);
    }
}

function createCampaignSendRun(PDO $pdo, int $campaignId, string $runType, string $status = 'running', string $message = ''): int
{
    $now = date('c');
    $startedAt = $status === 'running' ? $now : '';
    $stmt = $pdo->prepare('INSERT INTO campaign_send_runs (campaign_id, run_type, status, message, created_at, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([$campaignId, $runType, $status, substr($message, 0, 500), $now, $startedAt, $now]);
    return (int)$pdo->lastInsertId();
}

function updateCampaignSendRun(PDO $pdo, int $runId, array $fields): void
{
    if ($runId < 1) {
        return;
    }
    $fields['updated_at'] = date('c');
    $sets = [];
    $values = [];
    foreach ($fields as $field => $value) {
        $sets[] = $field . '=?';
        $values[] = is_string($value) && $field === 'message' ? substr($value, 0, 500) : $value;
    }
    $values[] = $runId;
    $stmt = $pdo->prepare('UPDATE campaign_send_runs SET ' . implode(', ', $sets) . ' WHERE id=?');
    $stmt->execute($values);
}

function campaignSendRunType(PDO $pdo, int $runId, string $fallback): string
{
    $stmt = $pdo->prepare('SELECT run_type FROM campaign_send_runs WHERE id=?');
    $stmt->execute([$runId]);
    $type = (string)$stmt->fetchColumn();
    return $type !== '' ? $type : $fallback;
}

function findCampaignSendRun(PDO $pdo, int $runId): array
{
    $stmt = $pdo->prepare('SELECT * FROM campaign_send_runs WHERE id=?');
    $stmt->execute([$runId]);
    $run = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$run) {
        throw new RuntimeException('Beh rozesilky nenalezen.');
    }
    return $run;
}

function campaignRecipientFilterSql(bool $includePreviouslyContacted): string
{
    $previouslyContactedFilter = $includePreviouslyContacted ? '' : '
        AND COALESCE(r.contacted_before, 0)=0
        AND NOT EXISTS (SELECT 1 FROM send_logs any_sent WHERE any_sent.recipient_id=r.id AND any_sent.status="sent")
    ';
    return '
        FROM recipients r
        WHERE r.status="active"
          AND COALESCE(r.archived, 0)=0
          AND r.list_id=?
          AND EXISTS (SELECT 1 FROM contact_databases cl WHERE cl.id=r.list_id AND COALESCE(cl.archived, 0)=0)
          AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.email=LOWER(r.email))
        ' . $previouslyContactedFilter . '
          AND NOT EXISTS (SELECT 1 FROM send_logs l WHERE l.campaign_id=? AND l.recipient_id=r.id)
    ';
}

function countEligibleCampaignRecipients(PDO $pdo, array $campaign, bool $includePreviouslyContacted): int
{
    $stmt = $pdo->prepare('SELECT COUNT(*) ' . campaignRecipientFilterSql($includePreviouslyContacted));
    $stmt->execute([(int)($campaign['list_id'] ?? 1), (int)$campaign['id']]);
    return (int)$stmt->fetchColumn();
}

function campaignRetryAfter(): string
{
    return date('c', time() + campaignCronIntervalMinutes() * 60);
}

function campaignSendDelaySeconds(array $config): float
{
    $delay = (float)($config['campaign_send_delay_seconds'] ?? 2);
    return max(1.0, min(15.0, $delay));
}

function waitBeforeNextCampaignEmail(array $config): void
{
    $delay = campaignSendDelaySeconds($config);
    $jitter = random_int(0, 1000) / 1000;
    usleep((int)(($delay + $jitter) * 1000000));
}

function sendBatch(PDO $pdo, array $config, ?int $campaignId = null, int $runId = 0, string $runType = 'manual'): string
{
    if ($campaignId === null) {
        return sendScheduledCampaigns($pdo, $config);
    }
    $campaign = findCampaign($pdo, $campaignId);
    return sendCampaignBatch($pdo, $config, $campaign, $runId, $runType);
}

function sendScheduledCampaigns(PDO $pdo, array $config): string
{
    markStaleCampaignRunsQueued($pdo);
    reconcileCampaignSendRunStatuses($pdo);
    $messages = [];
    if (campaignQueuedRunCount($pdo) > 0) {
        triggerNextQueuedCampaignRun($pdo);
        $messages[] = 'Existujici davka ve fronte byla predana workeru.';
    }
    $nowTime = date('H:i');
    $stmt = $pdo->prepare('
        SELECT *
        FROM campaigns c
        WHERE c.status="active"
          AND c.schedule_time<=?
          AND EXISTS (SELECT 1 FROM contact_databases cl WHERE cl.id=c.list_id AND COALESCE(cl.archived, 0)=0)
        ORDER BY schedule_time ASC, id ASC
        LIMIT 20
    ');
    $stmt->execute([$nowTime]);
    $campaigns = $stmt->fetchAll(PDO::FETCH_ASSOC);
    if (!$campaigns) {
        return ($messages ? implode("\n", $messages) : 'No campaign due.') . "\n";
    }
    foreach ($campaigns as $campaign) {
        if (!campaignIsDueForScheduledRun($campaign)) {
            continue;
        }
        if (campaignHasOpenSendRun($pdo, (int)$campaign['id'])) {
            triggerNextQueuedCampaignRun($pdo);
            $messages[] = 'Kampan "' . (string)$campaign['name'] . '" uz ma rozpracovanou davku.';
            continue;
        }
        $capacity = campaignRemainingWindowSlots($pdo, $campaign);
        if ($capacity['remaining'] < 1) {
            $reset = $capacity['reset_at'] ? ' Obnovi se ' . formatDateTime((string)$capacity['reset_at']) . '.' : '';
            $messages[] = 'Kampan "' . (string)$campaign['name'] . '": ' . campaignWindowLimitMessage($capacity) . $reset;
            continue;
        }
        $runId = createCampaignSendRun($pdo, (int)$campaign['id'], 'scheduled', 'queued', 'Planovana davka kampane "' . (string)$campaign['name'] . '" byla zarazena na pozadi.');
        triggerCampaignWorker($pdo, (int)$campaign['id'], $runId);
        $messages[] = 'Kampan "' . (string)$campaign['name'] . '" zarazena k odeslani na pozadi.';
    }
    return ($messages ? implode("\n", $messages) : 'No campaign due.') . "\n";
}

function sendCampaignBatch(PDO $pdo, array $config, array $campaign, int $runId = 0, string $runType = 'manual'): string
{
    if (!$campaign) {
        return "No active campaign.\n";
    }
    if ($runId < 1) {
        $runId = createCampaignSendRun($pdo, (int)$campaign['id'], $runType, 'running', 'Odesilani davky zahajeno.');
    } else {
        $existingRun = findCampaignSendRun($pdo, $runId);
        $startFields = ['status' => 'running', 'message' => 'Odesilani davky zahajeno.'];
        if (trim((string)($existingRun['started_at'] ?? '')) === '') {
            $startFields['started_at'] = date('c');
        }
        updateCampaignSendRun($pdo, $runId, $startFields);
    }

    $run = findCampaignSendRun($pdo, $runId);
    $capacity = campaignRemainingWindowSlots($pdo, $campaign);
    if ($capacity['remaining'] < 1) {
        $message = campaignWindowLimitMessage($capacity) . ' Dalsi pokus probehne po obnoveni limitu.';
        updateCampaignSendRun($pdo, $runId, [
            'status' => 'queued',
            'message' => $message,
            'next_send_after' => (string)($capacity['reset_at'] ?: campaignRetryAfter()),
        ]);
        return $message . "\n";
    }

    $includePreviouslyContacted = (int)($campaign['include_previously_contacted'] ?? 0) === 1;
    $planned = (int)($run['planned_count'] ?? 0);
    if ($planned < 1) {
        $eligible = countEligibleCampaignRecipients($pdo, $campaign, $includePreviouslyContacted);
        $planned = min((int)$capacity['remaining'], $eligible);
        updateCampaignSendRun($pdo, $runId, [
            'planned_count' => $planned,
            'message' => 'Vybrano ' . $planned . ' kontaktu pro odeslani s prodlevou mezi kontakty.',
        ]);
        $run = findCampaignSendRun($pdo, $runId);
    }

    $sentSoFar = (int)($run['sent_count'] ?? 0);
    $failedSoFar = (int)($run['failed_count'] ?? 0);
    $remainingInRun = max(0, $planned - $sentSoFar - $failedSoFar);
    if ($planned < 1 || $remainingInRun < 1) {
        $status = campaignRunCompletionStatus($planned, $sentSoFar, $failedSoFar);
        $message = $planned < 1
            ? 'Neni koho oslovit.'
            : 'Postupna rozesilka dokoncena: ' . $sentSoFar . ' odeslano' . ($failedSoFar > 0 ? ', chyb ' . $failedSoFar : '') . '.';
        updateCampaignSendRun($pdo, $runId, ['status' => $status, 'message' => $message, 'next_send_after' => '', 'finished_at' => date('c')]);
        if ($runType === 'scheduled') {
            markCampaignScheduledCompleted($pdo, (int)$campaign['id'], $runId);
        }
        return $message . "\n";
    }

    $limit = min((int)$capacity['remaining'], $remainingInRun);
    $stmt = $pdo->prepare('SELECT r.* ' . campaignRecipientFilterSql($includePreviouslyContacted) . ' ORDER BY r.id ASC LIMIT ?');
    $stmt->bindValue(1, (int)($campaign['list_id'] ?? 1), PDO::PARAM_INT);
    $stmt->bindValue(2, (int)$campaign['id'], PDO::PARAM_INT);
    $stmt->bindValue(3, $limit, PDO::PARAM_INT);
    $stmt->execute();
    $recipients = $stmt->fetchAll(PDO::FETCH_ASSOC);
    if (!$recipients) {
        $status = campaignRunCompletionStatus($planned, $sentSoFar, $failedSoFar);
        $message = 'Postupna rozesilka dokoncena: dalsi vhodne kontakty uz nejsou k dispozici.';
        updateCampaignSendRun($pdo, $runId, ['status' => $status, 'message' => $message, 'next_send_after' => '', 'finished_at' => date('c')]);
        if ($runType === 'scheduled') {
            markCampaignScheduledCompleted($pdo, (int)$campaign['id'], $runId);
        }
        return $message . "\n";
    }

    $mailer = new SmtpMailer($config);
    try {
        $mailer->testConnection();
    } catch (Throwable $e) {
        $message = 'Technicka chyba SMTP pripojeni, davka nebyla odeslana: ' . $e->getMessage();
        updateCampaignSendRun($pdo, $runId, ['status' => 'failed', 'message' => $message, 'finished_at' => date('c')]);
        return $message . "\n";
    }
    $log = $pdo->prepare('INSERT INTO send_logs (run_id, campaign_id, recipient_id, email, tracking_token, status, message, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    $markContacted = $pdo->prepare('UPDATE recipients SET contacted_before=1, updated_at=? WHERE id=?');
    $sent = 0;
    $failed = 0;
    $recipientCount = count($recipients);
    foreach ($recipients as $index => $recipient) {
        $token = bin2hex(random_bytes(18));
        try {
            $trackedHtml = addTracking($campaign['body_html'], $token);
            $mailer->send($recipient['email'], $campaign['subject'], $trackedHtml, $recipient);
            $log->execute([$runId, $campaign['id'], $recipient['id'], $recipient['email'], $token, 'sent', '', date('c')]);
            $markContacted->execute([date('c'), (int)$recipient['id']]);
            $sent++;
        } catch (Throwable $e) {
            $errorMessage = $e->getMessage();
            if (isTechnicalSendError($errorMessage)) {
                $message = 'Technicka chyba SMTP odesilani, davka byla zastavena: ' . $errorMessage;
                updateCampaignSendRun($pdo, $runId, [
                    'status' => 'failed',
                    'message' => $message,
                    'sent_count' => $sentSoFar + $sent,
                    'failed_count' => $failedSoFar + $failed,
                    'finished_at' => date('c'),
                ]);
                return $message . "\n";
            }
            $log->execute([$runId, $campaign['id'], $recipient['id'], $recipient['email'], $token, 'failed', substr($errorMessage, 0, 500), date('c')]);
            $failed++;
        }
        updateCampaignSendRun($pdo, $runId, [
            'sent_count' => $sentSoFar + $sent,
            'failed_count' => $failedSoFar + $failed,
            'message' => 'Odesilani probiha: ' . ($sentSoFar + $sent) . ' z ' . $planned . ' odeslano' . (($failedSoFar + $failed) > 0 ? ', chyb ' . ($failedSoFar + $failed) : '') . '.',
        ]);
        setSetting($pdo, 'campaign_worker_lock_until', (string)(time() + 900));
        if ($index < $recipientCount - 1) {
            waitBeforeNextCampaignEmail($config);
        }
    }

    $sentTotal = $sentSoFar + $sent;
    $failedTotal = $failedSoFar + $failed;
    $done = ($sentTotal + $failedTotal) >= $planned;
    if ($done) {
        $message = 'Rozesilka dokoncena: ' . $sentTotal . ' odeslano' . ($failedTotal > 0 ? ', chyb ' . $failedTotal : '') . '. Prodleva mezi kontakty byla cca ' . campaignSendDelaySeconds($config) . ' s + nahodny rozptyl.';
        $status = campaignRunCompletionStatus($planned, $sentTotal, $failedTotal);
        updateCampaignSendRun($pdo, $runId, [
            'status' => $status,
            'message' => $message,
            'sent_count' => $sentTotal,
            'failed_count' => $failedTotal,
            'next_send_after' => '',
            'finished_at' => date('c'),
        ]);
        if ($runType === 'scheduled') {
            markCampaignScheduledCompleted($pdo, (int)$campaign['id'], $runId);
        }
        return $message . "\n";
    }

    $next = campaignRetryAfter();
    $message = 'Rozesilka odeslala ' . $sentTotal . ' z ' . $planned . ($failedTotal > 0 ? ', chyb ' . $failedTotal : '') . '. Zbytek pocka na dalsi pokus kvuli limitu nebo dostupnosti kontaktu.';
    updateCampaignSendRun($pdo, $runId, [
        'status' => 'queued',
        'message' => $message,
        'sent_count' => $sentTotal,
        'failed_count' => $failedTotal,
        'next_send_after' => $next,
    ]);
    return $message . "\n";
}

function campaignRemainingWindowSlots(PDO $pdo, array $campaign, ?array $pace = null): array
{
    $windowStart = date('c', time() - 86400);
    $sentStmt = $pdo->prepare('SELECT COUNT(*) sent_count, MIN(sent_at) first_sent_at FROM send_logs WHERE campaign_id=? AND (status="sent" OR message LIKE "Bounce:%") AND sent_at>=?');
    $sentStmt->execute([(int)$campaign['id'], $windowStart]);
    $row = $sentStmt->fetch(PDO::FETCH_ASSOC) ?: [];
    $campaignSentInWindow = (int)($row['sent_count'] ?? 0);
    $campaignFirstSentAt = (string)($row['first_sent_at'] ?? '');
    $campaignFirstSentTime = $campaignFirstSentAt !== '' ? strtotime($campaignFirstSentAt) : false;

    $senderStmt = $pdo->prepare('
        SELECT COUNT(*) sent_count, MIN(l.sent_at) first_sent_at
        FROM send_logs l
        JOIN campaigns c ON c.id=l.campaign_id
        JOIN contact_databases cl ON cl.id=c.list_id
        WHERE (l.status="sent" OR l.message LIKE "Bounce:%")
          AND l.sent_at>=?
          AND COALESCE(cl.archived, 0)=0
    ');
    $senderStmt->execute([$windowStart]);
    $senderRow = $senderStmt->fetch(PDO::FETCH_ASSOC) ?: [];
    $senderSentInWindow = (int)($senderRow['sent_count'] ?? 0);
    $senderFirstSentAt = (string)($senderRow['first_sent_at'] ?? '');
    $senderFirstSentTime = $senderFirstSentAt !== '' ? strtotime($senderFirstSentAt) : false;

    $pace = $pace ?: campaignDailyLimit($pdo, $campaign);
    $limit = (int)$pace['limit'];
    $senderLimit = senderDailyLimit($pdo, $campaign, $pace);
    $campaignRemaining = max(0, $limit - $campaignSentInWindow);
    $senderRemaining = max(0, $senderLimit - $senderSentInWindow);
    $resetTime = null;
    if ($campaignRemaining < 1 && $campaignFirstSentTime) {
        $resetTime = $campaignFirstSentTime + 86400;
    }
    if ($senderRemaining < 1 && $senderFirstSentTime) {
        $senderResetTime = $senderFirstSentTime + 86400;
        $resetTime = $resetTime === null ? $senderResetTime : min($resetTime, $senderResetTime);
    }
    return [
        'limit' => $limit,
        'sent' => $campaignSentInWindow,
        'remaining' => min($campaignRemaining, $senderRemaining),
        'campaign_limit' => $limit,
        'campaign_sent' => $campaignSentInWindow,
        'campaign_remaining' => $campaignRemaining,
        'sender_limit' => $senderLimit,
        'sender_sent' => $senderSentInWindow,
        'sender_remaining' => $senderRemaining,
        'reset_at' => $resetTime ? date('c', $resetTime) : '',
        'campaign_reset_at' => $campaignFirstSentTime ? date('c', $campaignFirstSentTime + 86400) : '',
        'sender_reset_at' => $senderFirstSentTime ? date('c', $senderFirstSentTime + 86400) : '',
    ];
}

function campaignWindowLimitMessage(array $capacity): string
{
    if ((int)($capacity['campaign_remaining'] ?? 0) < 1) {
        return 'Limit teto kampane za poslednich 24 hodin je vycerpany, plan zustava otevreny.';
    }
    if ((int)($capacity['sender_remaining'] ?? 0) < 1) {
        return 'Kapacita odesilaci schranky za poslednich 24 hodin je vycerpana, plan zustava otevreny.';
    }
    return 'Limit za poslednich 24 hodin je vycerpany, plan zustava otevreny.';
}

function isTechnicalSendError(string $message): bool
{
    return preg_match('/\b535\b|authentication failed|auth failed|invalid credentials|SMTP connection failed|STARTTLS|Connection timed out|Connection refused|Could not connect|stream_socket_client/i', $message) === 1;
}

function campaignIsDueForScheduledRun(array $campaign): bool
{
    $scheduleTime = normalizeScheduleTime((string)($campaign['schedule_time'] ?? '09:00'));
    $scheduledAt = strtotime(date('Y-m-d') . ' ' . $scheduleTime . ':00');
    if ($scheduledAt === false || $scheduledAt > time()) {
        return false;
    }
    $last = trim((string)($campaign['last_scheduled_at'] ?? ''));
    $lastAt = $last !== '' ? strtotime($last) : false;
    if ($lastAt === false) {
        return true;
    }
    $nextDueAt = $lastAt + 86400 + campaignScheduleBufferSeconds();
    if (time() >= $nextDueAt) {
        return true;
    }
    return false;
}

function campaignHasOpenSendRun(PDO $pdo, int $campaignId): bool
{
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM campaign_send_runs WHERE campaign_id=? AND status IN ("queued","running")');
    $stmt->execute([$campaignId]);
    return (int)$stmt->fetchColumn() > 0;
}

function campaignQueuedRunCount(PDO $pdo): int
{
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM campaign_send_runs WHERE status="queued" AND (next_send_after="" OR next_send_after<=?)');
    $stmt->execute([date('c')]);
    return (int)$stmt->fetchColumn();
}

function markStaleCampaignRunsQueued(PDO $pdo): void
{
    if (!tableExists($pdo, 'campaign_send_runs')) {
        return;
    }
    $threshold = date('c', time() - 1800);
    $stmt = $pdo->prepare('UPDATE campaign_send_runs SET status="queued", message=?, updated_at=? WHERE status="running" AND updated_at<?');
    $stmt->execute(['Beh byl po delsi necinnosti vracen do fronty.', date('c'), $threshold]);
}

function triggerNextQueuedCampaignRun(PDO $pdo): void
{
    $stmt = $pdo->prepare('
        SELECT id, campaign_id
        FROM campaign_send_runs
        WHERE status="queued"
          AND (next_send_after="" OR next_send_after<=?)
        ORDER BY id ASC
        LIMIT 1
    ');
    $stmt->execute([date('c')]);
    $run = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$run) {
        return;
    }
    triggerCampaignWorker($pdo, (int)$run['campaign_id'], (int)$run['id']);
}

function markCampaignScheduledCompleted(PDO $pdo, int $campaignId, int $runId = 0): void
{
    $now = date('c');
    $referenceAt = '';
    if ($runId > 0) {
        $stmt = $pdo->prepare('SELECT MAX(sent_at) FROM send_logs WHERE run_id=? AND status="sent"');
        $stmt->execute([$runId]);
        $referenceAt = (string)$stmt->fetchColumn();
    }
    $referenceTime = $referenceAt !== '' ? strtotime($referenceAt) : false;
    if ($referenceTime !== false) {
        $scheduleTime = date('H:i', $referenceTime + campaignScheduleBufferSeconds());
        $stmt = $pdo->prepare('UPDATE campaigns SET last_scheduled_at=?, schedule_time=?, updated_at=? WHERE id=?');
        $stmt->execute([$referenceAt, $scheduleTime, $now, $campaignId]);
        return;
    }
    $stmt = $pdo->prepare('UPDATE campaigns SET last_scheduled_at=?, updated_at=? WHERE id=?');
    $stmt->execute([$now, $now, $campaignId]);
}

function campaignCronIntervalMinutes(): int
{
    global $config;
    return max(1, min(120, (int)($config['campaign_cron_interval_minutes'] ?? 5)));
}

function campaignScheduleBufferSeconds(): int
{
    return campaignCronIntervalMinutes() * 2 * 60;
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

function unsubscribeRecipient(PDO $pdo, string $token): void
{
    $log = findSendLogByToken($pdo, $token);
    if (!$log || empty($log['recipient_id'])) {
        http_response_code(404);
        echo 'Odhlaseni nebylo nalezeno.';
        return;
    }
    $now = date('c');
    $stmt = $pdo->prepare('SELECT email FROM recipients WHERE id=?');
    $stmt->execute([(int)$log['recipient_id']]);
    $email = strtolower((string)($stmt->fetchColumn() ?: $log['email']));
    $pdo->prepare('UPDATE recipients SET status="unsubscribed", unsubscribed_at=?, updated_at=? WHERE id=?')
        ->execute([$now, $now, (int)$log['recipient_id']]);
    addSuppression($pdo, $email, 'unsubscribe', 'link');
    recordTrackingEvent($pdo, (int)$log['id'], 'unsubscribe', 'link:' . $email);
    header('Content-Type: text/html; charset=utf-8');
    ob_start();
    ?><!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Odhlaseno</title><link rel="stylesheet" href="<?= h(assetUrl('assets/app.css')) ?>"></head><body><main><section class="panel narrow"><h1>Odhlaseno</h1><p>Tento kontakt uz nebude zahrnuty do dalsich rozesilek.</p></section></main><?php renderLanguageFooter($pdo); ?></body></html><?php
    echo localizeHtml((string)ob_get_clean(), $pdo);
}

function addSuppression(PDO $pdo, string $email, string $reason, string $source): void
{
    $email = strtolower(trim($email));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        return;
    }
    if (isMysql($pdo)) {
        $stmt = $pdo->prepare('INSERT INTO suppression_list (email, reason, source, created_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE reason=VALUES(reason), source=VALUES(source)');
        $stmt->execute([$email, $reason, $source, date('c')]);
        return;
    }
    $stmt = $pdo->prepare('INSERT OR REPLACE INTO suppression_list (email, reason, source, created_at) VALUES (?, ?, ?, ?)');
    $stmt->execute([$email, $reason, $source, date('c')]);
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
    $defaultSenderLimit = senderHistoricalDailyLimit($pdo);
    if ((int)($campaign['auto_daily_limit'] ?? 1) !== 1) {
        $senderLimit = min(250, max($manual, $defaultSenderLimit));
        return [
            'limit' => $manual,
            'sender_limit' => $senderLimit,
            'reason' => 'Rucni limit kampane.',
            'conclusion' => 'Pro dalsi beh se pouzije rucne nastaveny limit ' . $manual . '/24 h.',
            'sending_days' => 0,
            'healthy_days' => 0,
            'healthy_milestones' => 0,
            'growth_limit' => $senderLimit,
            'manual_limit' => $manual,
            'failure_rate' => 0.0,
            'bounce_rate' => 0.0,
            'recent_total' => 0,
            'recent_sent' => 0,
            'recent_failed' => 0,
            'recent_bounced' => 0,
            'recent_replied' => 0,
        ];
    }

    $stmt = $pdo->prepare('
        SELECT substr(sent_at,1,10) day, status, message, replied_at
        FROM send_logs
        WHERE campaign_id=?
        ORDER BY sent_at ASC, id ASC
    ');
    $stmt->execute([(int)$campaign['id']]);
    $daysByDate = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $log) {
        $day = (string)($log['day'] ?? '');
        if ($day === '') {
            continue;
        }
        if (!isset($daysByDate[$day])) {
            $daysByDate[$day] = ['day' => $day, 'sent' => 0, 'failed' => 0, 'bounced' => 0, 'replied' => 0, 'unsubscribed' => 0];
        }
        if ((string)$log['status'] === 'sent') {
            $daysByDate[$day]['sent']++;
        } elseif ((string)$log['status'] === 'failed' && !isTechnicalSendError((string)($log['message'] ?? ''))) {
            $daysByDate[$day]['failed']++;
            if (stripos((string)($log['message'] ?? ''), 'Bounce:') === 0) {
                $daysByDate[$day]['bounced']++;
            }
        }
        if ((string)($log['replied_at'] ?? '') !== '') {
            $daysByDate[$day]['replied']++;
        }
    }
    $bounceStmt = $pdo->prepare('
        SELECT substr(te.created_at,1,10) day, COUNT(*) count
        FROM tracking_events te
        JOIN send_logs l ON l.id=te.send_log_id
        WHERE l.campaign_id=? AND te.event_type="bounce"
        GROUP BY substr(te.created_at,1,10)
    ');
    $bounceStmt->execute([(int)$campaign['id']]);
    foreach ($bounceStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $day = (string)($row['day'] ?? '');
        if ($day === '') {
            continue;
        }
        if (!isset($daysByDate[$day])) {
            $daysByDate[$day] = ['day' => $day, 'sent' => 0, 'failed' => 0, 'bounced' => 0, 'replied' => 0, 'unsubscribed' => 0];
        }
        $daysByDate[$day]['bounced'] = max((int)$daysByDate[$day]['bounced'], (int)$row['count']);
    }
    $days = array_values($daysByDate);
    $sendingDays = count(array_filter($days, fn($day) => (int)$day['sent'] > 0));
    $healthyDays = count(array_filter($days, function (array $day): bool {
        $sent = (int)$day['sent'];
        if ($sent < 20) {
            return false;
        }
        return ((int)$day['failed'] / max(1, $sent)) < 0.03
            && ((int)$day['bounced'] / max(1, $sent)) < 0.02;
    }));
    $recent = array_slice($days, -3);
    $recentSent = array_sum(array_map(fn($day) => (int)$day['sent'], $recent));
    $recentFailed = array_sum(array_map(fn($day) => (int)$day['failed'], $recent));
    $recentBounced = array_sum(array_map(fn($day) => (int)$day['bounced'], $recent));
    $recentReplied = array_sum(array_map(fn($day) => (int)$day['replied'], $recent));
    $recentTotal = $recentSent + $recentFailed;
    $failureRate = $recentTotal > 0 ? $recentFailed / $recentTotal : 0.0;
    $bounceRate = $recentSent > 0 ? $recentBounced / $recentSent : 0.0;
    $rateSummary = ' Vyhodnocuje se poslednich ' . count($recent) . ' evidovanych dni teto kampane: '
        . 'odeslano ' . $recentSent
        . ', netechnicke chyby ' . $recentFailed . ' (' . number_format($failureRate * 100, 1, '.', '') . ' %)'
        . ', bounce ' . $recentBounced . ' (' . number_format($bounceRate * 100, 1, '.', '') . ' % z odeslanych)'
        . ', odpovedi ' . $recentReplied . '. ';
    $ruleSummary = 'Pravidla: rust +25 % po kazdych 3 zdravych odesilacich dnech; zdravy den ma alespon 20 odeslanych, netechnicke chyby pod 3 % a bounce pod 2 %. '
        . 'Snizeni: bounce >= 2 % drzi limit max. 100; netechnicke chyby >= 5 % drzi max. 100; >= 10 % limit puli. Technicke SMTP/auth chyby se do chybovosti nepocitaji. Odhlaseni se nevyhodnocuje, protoze aplikace do obchodnich sdeleni nevklada odhlasovaci link.';

    $healthyMilestones = max(0, (int)floor($healthyDays / 3));
    $growthLimit = (int)round(100 * pow(1.25, $healthyMilestones));
    $senderLimit = min(max($growthLimit, $defaultSenderLimit), 250);
    $limit = min($senderLimit, $manual);
    $reason = 'Auto: start 100 za 24 h, po kazdych 3 zdravych odesilacich dnech rust cca 25 %, technicky strop 250 nebo rucni maximum kampane.' . $rateSummary . $ruleSummary;
    $conclusionReason = '';

    if ($recentSent >= 20 && $bounceRate >= 0.02) {
        $senderLimit = min($senderLimit, 100);
        $limit = min($limit, $senderLimit);
        $reason = 'Auto: bounce je zvyseny, limit se drzi na max. 100 za 24 h.' . $rateSummary . $ruleSummary;
        $conclusionReason = 'bounce za posledni evidovane dny je ' . number_format($bounceRate * 100, 1, '.', '') . ' %, tedy na hranici 2 % nebo vyse';
    } elseif ($recentTotal >= 20 && $failureRate >= 0.1) {
        $senderLimit = max(25, (int)floor($senderLimit * 0.5));
        $limit = min($limit, $senderLimit);
        $reason = 'Auto: vysoka chybovost za posledni dny, limit je docasne snizeny.' . $rateSummary . $ruleSummary;
        $conclusionReason = 'netechnicka chybovost za posledni evidovane dny je ' . number_format($failureRate * 100, 1, '.', '') . ' %, tedy alespon 10 %';
    } elseif ($recentTotal >= 20 && $failureRate >= 0.05) {
        $senderLimit = max(50, min($senderLimit, 100));
        $limit = min($limit, $senderLimit);
        $reason = 'Auto: zvysena chybovost za posledni dny, limit se drzi konzervativne.' . $rateSummary . $ruleSummary;
        $conclusionReason = 'netechnicka chybovost za posledni evidovane dny je ' . number_format($failureRate * 100, 1, '.', '') . ' %, tedy alespon 5 %';
    } elseif ($recentSent >= 50 && $recentReplied > 0 && $limit > 100) {
        $reason .= ' Posledni davky maji odpovedi, rust je povolen.';
    }
    if ($conclusionReason === '') {
        if ($growthLimit > $manual && $manual <= 250) {
            $conclusionReason = 'vypocteny rust by dovolil ' . $growthLimit . '/24 h, ale pole Max za 24 h je nastavene na ' . $manual;
        } elseif ($growthLimit > 250) {
            $conclusionReason = 'vypocteny rust by dovolil ' . $growthLimit . '/24 h, ale technicky strop aplikace je 250';
        } elseif ($growthLimit > 100) {
            $conclusionReason = 'kampan ma ' . $healthyDays . ' zdravych odesilacich dni, tedy ' . $healthyMilestones . ' splnene bloky po 3 dnech';
        } else {
            $remainingHealthy = max(0, 3 - ($healthyDays % 3));
            $conclusionReason = $healthyDays > 0
                ? 'zatim chybi jeste ' . $remainingHealthy . ' zdravy odesilaci den do dalsiho navyseni'
                : 'zatim nejsou evidovane 3 zdrave odesilaci dny';
        }
    }
    $conclusion = 'Pro dalsi beh se pouzije limit ' . max(1, $limit) . '/24 h, protoze ' . $conclusionReason . '.';

    return [
        'limit' => max(1, $limit),
        'sender_limit' => max(1, $senderLimit),
        'reason' => $reason,
        'conclusion' => $conclusion,
        'sending_days' => $sendingDays,
        'healthy_days' => $healthyDays,
        'healthy_milestones' => $healthyMilestones,
        'growth_limit' => $growthLimit,
        'manual_limit' => $manual,
        'failure_rate' => $failureRate,
        'bounce_rate' => $bounceRate,
        'recent_total' => $recentTotal,
        'recent_sent' => $recentSent,
        'recent_failed' => $recentFailed,
        'recent_bounced' => $recentBounced,
        'recent_replied' => $recentReplied,
    ];
}

function senderHistoricalDailyLimit(PDO $pdo): int
{
    $campaignLimit = (int)$pdo->query('SELECT COALESCE(MAX(daily_limit), 0) FROM campaigns')->fetchColumn();
    $historyLimit = (int)$pdo->query('
        SELECT COALESCE(MAX(day_count), 0)
        FROM (
            SELECT substr(l.sent_at,1,10) day, COUNT(*) day_count
            FROM send_logs l
            JOIN campaigns c ON c.id=l.campaign_id
            JOIN contact_databases cl ON cl.id=c.list_id
            WHERE l.status="sent"
              AND COALESCE(cl.archived, 0)=0
            GROUP BY substr(l.sent_at,1,10)
        ) sent_days
    ')->fetchColumn();
    return min(250, max(100, $campaignLimit, $historyLimit));
}

function senderDailyLimit(PDO $pdo, array $campaign, array $pace): int
{
    $candidate = max(
        (int)($pace['sender_limit'] ?? 0),
        (int)($pace['growth_limit'] ?? 0),
        senderHistoricalDailyLimit($pdo)
    );
    $limit = min(250, max(1, $candidate));
    $recentSent = (int)($pace['recent_sent'] ?? 0);
    $recentTotal = (int)($pace['recent_total'] ?? 0);
    $bounceRate = (float)($pace['bounce_rate'] ?? 0.0);
    $failureRate = (float)($pace['failure_rate'] ?? 0.0);
    if ($recentSent >= 20 && $bounceRate >= 0.02) {
        return min($limit, 100);
    }
    if ($recentTotal >= 20 && $failureRate >= 0.1) {
        return max(25, (int)floor($limit * 0.5));
    }
    if ($recentTotal >= 20 && $failureRate >= 0.05) {
        return max(50, min($limit, 100));
    }
    return $limit;
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

function assetUrl(string $path): string
{
    $fullPath = __DIR__ . '/' . ltrim($path, '/');
    $version = file_exists($fullPath) ? (string)filemtime($fullPath) : APP_VERSION;
    return $path . '?v=' . rawurlencode($version);
}

function supportedUiLanguages(): array
{
    return [
        'cs' => ['label' => 'Cestina', 'flag' => '🇨🇿'],
        'en' => ['label' => 'English', 'flag' => '🇬🇧'],
        'de' => ['label' => 'Deutsch', 'flag' => '🇩🇪'],
    ];
}

function normalizeUiLanguage(string $language): string
{
    $language = strtolower(str_replace('_', '-', trim($language)));
    $language = substr($language, 0, 2);
    return array_key_exists($language, supportedUiLanguages()) ? $language : 'cs';
}

function defaultUiLanguage(): string
{
    $header = strtolower((string)($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''));
    foreach (explode(',', $header) as $part) {
        $candidate = trim(explode(';', $part)[0] ?? '');
        if ($candidate === '') {
            continue;
        }
        $language = normalizeUiLanguage($candidate);
        if ($language !== 'cs' || str_starts_with(strtolower($candidate), 'cs')) {
            return $language;
        }
    }
    return 'cs';
}

function currentUiLanguage(?PDO $pdo = null, array $config = []): string
{
    if (!empty($_SESSION['auth']) && !empty($config['ui_language'])) {
        $language = normalizeUiLanguage((string)$config['ui_language']);
        $_SESSION['ui_language'] = $language;
        return $language;
    }
    if (!empty($_SESSION['ui_language'])) {
        return normalizeUiLanguage((string)$_SESSION['ui_language']);
    }
    if (!empty($_COOKIE['ui_language'])) {
        return normalizeUiLanguage((string)$_COOKIE['ui_language']);
    }
    return defaultUiLanguage();
}

function uiLanguageCookiePath(): string
{
    $dir = str_replace('\\', '/', dirname((string)($_SERVER['SCRIPT_NAME'] ?? '/')));
    if ($dir === '' || $dir === '.' || $dir === '/') {
        return '/';
    }
    return rtrim($dir, '/') . '/';
}

function safeLanguageReturnUrl(): string
{
    $return = trim((string)($_POST['return_to'] ?? ($_SERVER['REQUEST_URI'] ?? './')));
    if ($return === '' || preg_match('#^[a-z][a-z0-9+.-]*:#i', $return) || substr($return, 0, 2) === '//') {
        return './';
    }
    return $return;
}

function handleLanguageChange(PDO $pdo): void
{
    $language = normalizeUiLanguage((string)($_POST['lang'] ?? ''));
    $_SESSION['ui_language'] = $language;
    setcookie('ui_language', $language, [
        'expires' => time() + 365 * 24 * 60 * 60,
        'path' => uiLanguageCookiePath(),
        'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
        'httponly' => false,
        'samesite' => 'Lax',
    ]);
    if (!empty($_SESSION['auth'])) {
        setSetting($pdo, 'ui_language', $language);
    }
    header('Location: ' . safeLanguageReturnUrl(), true, 303);
    exit;
}

function renderLanguageFooter(?PDO $pdo = null, array $config = []): void
{
    $current = currentUiLanguage($pdo, $config);
    $returnTo = (string)($_SERVER['REQUEST_URI'] ?? './');
    ?>
    <footer class="app-footer">
        <form method="post" class="language-switcher" autocomplete="off">
            <input type="hidden" name="action" value="change_language">
            <input type="hidden" name="return_to" value="<?= h($returnTo) ?>">
            <span>Jazyk rozhrani</span>
            <?php foreach (supportedUiLanguages() as $code => $language): ?>
                <button type="submit" name="lang" value="<?= h($code) ?>" class="flag-button <?= $current === $code ? 'active' : '' ?>" aria-label="<?= h($language['label']) ?>" title="<?= h($language['label']) ?>" <?= $current === $code ? 'aria-current="true"' : '' ?>><span aria-hidden="true"><?= h($language['flag']) ?></span></button>
            <?php endforeach; ?>
        </form>
    </footer>
    <?php
}

function localizeHtml(string $html, ?PDO $pdo = null, array $config = []): string
{
    $language = currentUiLanguage($pdo, $config);
    $html = preg_replace('#<html\s+lang="[^"]*"#i', '<html lang="' . h($language) . '"', $html, 1) ?? $html;
    if ($language === 'cs') {
        return $html;
    }
    $map = uiTranslationMap($language);
    if (!$map) {
        return $html;
    }
    $parts = preg_split('#(<[^>]+>)#u', $html, -1, PREG_SPLIT_DELIM_CAPTURE);
    if ($parts === false) {
        return translateHtmlAttributes(translateHtmlText($html, $map, $language), $map);
    }
    $out = '';
    $skipStack = [];
    foreach ($parts as $part) {
        if ($part === '') {
            continue;
        }
        if ($part[0] === '<') {
            $tagName = htmlTagName($part);
            if ($tagName !== null && htmlIsClosingTag($part)) {
                if ($skipStack && $tagName === end($skipStack)) {
                    array_pop($skipStack);
                }
                $out .= $part;
                continue;
            }
            $skipActive = !empty($skipStack);
            $out .= $skipActive ? $part : translateHtmlAttributes($part, $map);
            if ($tagName !== null && !htmlIsVoidTag($tagName) && ($skipActive || htmlStartsNoTranslateRegion($part, $tagName))) {
                $skipStack[] = $tagName;
            }
            continue;
        }
        $out .= $skipStack ? $part : translateHtmlText($part, $map, $language);
    }
    return $out;
}

function translateHtmlText(string $text, array $map, string $language): string
{
    $text = strtr($text, $map);
    $yesNo = [
        'en' => ['ano' => 'yes', 'ne' => 'no'],
        'de' => ['ano' => 'ja', 'ne' => 'nein'],
    ][$language] ?? ['ano' => 'ano', 'ne' => 'ne'];
    return preg_replace_callback(
        '#(?<![\p{L}\p{N}_])(ano|ne)(?![\p{L}\p{N}_])#u',
        static function (array $matches) use ($yesNo): string {
            return $yesNo[$matches[1]];
        },
        $text
    ) ?? $text;
}

function htmlTagName(string $tag): ?string
{
    return preg_match('#^</?\s*([a-z0-9]+)#i', $tag, $matches) ? strtolower($matches[1]) : null;
}

function htmlIsClosingTag(string $tag): bool
{
    return preg_match('#^</#', $tag) === 1;
}

function htmlIsVoidTag(string $tagName): bool
{
    return in_array($tagName, ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'], true);
}

function htmlStartsNoTranslateRegion(string $tag, string $tagName): bool
{
    if (in_array($tagName, ['script', 'style', 'textarea'], true)) {
        return true;
    }
    if ($tagName !== 'div' || preg_match('#\bclass\s*=\s*(["\'])(.*?)\1#i', $tag, $matches) !== 1) {
        return false;
    }
    return in_array('editor', preg_split('#\s+#', trim($matches[2])) ?: [], true);
}

function translateHtmlAttributes(string $tag, array $map): string
{
    return preg_replace_callback(
        '#\b(placeholder|aria-label|title|alt)="([^"]*)"#u',
        static fn(array $matches): string => $matches[1] . '="' . strtr($matches[2], $map) . '"',
        $tag
    ) ?? $tag;
}

function uiTranslationMap(string $language): array
{
    if ($language === 'de') {
        $map = [
            'Aplikace je nastavena pouze na produkcni MySQL/MariaDB databazi. Zkontroluj prosim hodnoty APP_DATABASE_NAME, APP_DATABASE_USERNAME a APP_DATABASE_PASSWORD v GitHub Secrets a hlavne prava DB uzivatele pro SELECT/INSERT/UPDATE/DELETE/CREATE/ALTER nad touto databazi.' => 'Die Anwendung ist nur fuer die produktive MySQL/MariaDB-Datenbank konfiguriert. Bitte pruefe APP_DATABASE_NAME, APP_DATABASE_USERNAME und APP_DATABASE_PASSWORD in GitHub Secrets sowie die Datenbankrechte fuer SELECT/INSERT/UPDATE/DELETE/CREATE/ALTER auf dieser Datenbank.',
            'Jednotlive casti nastaveni se meni oddelene, aby se prihlasovaci udaje nikdy neprepsaly omylem.' => 'Die einzelnen Einstellungsbereiche werden getrennt bearbeitet, damit Zugangsdaten nicht versehentlich ueberschrieben werden.',
            'Prehled pripravenych kampani, jejich planu, limitu a stavu osloveni.' => 'Uebersicht der vorbereiteten Kampagnen, Plaene, Limits und Kontaktstatus.',
            'Backend prochazi stranky vysledku postupne, dokud zdroj vraci dalsi zaznamy. Podporovane jsou Firmy.cz, Herold.at, Zoznam.sk, DasTelefonbuch.de, DasOertliche.de, GelbeSeiten.de, Pkt.pl, PanoramaFirm.pl, MerchantCircle a YellowPages.ca. Z nalezenych detailu pak hleda email, nazev, web a adresu.' => 'Das Backend durchsucht die Ergebnisseiten fortlaufend, solange die Quelle weitere Eintraege liefert. Unterstuetzt werden Firmy.cz, Herold.at, Zoznam.sk, DasTelefonbuch.de, DasOertliche.de, GelbeSeiten.de, Pkt.pl, PanoramaFirm.pl, MerchantCircle und YellowPages.ca. Aus den Detailseiten werden E-Mail, Name, Website und Adresse gelesen.',
            'Kazdy kontejner drzi zdroj, klicove slovo a cilovou databazi. Kliknutim na radek otevres logy konkretniho kontejneru.' => 'Jeder Container speichert Quelle, Suchbegriff und Zieldatenbank. Mit einem Klick auf die Zeile oeffnest du die Logs des Containers.',
            'Kliknutim na radek otevres konkretni databazi kontaktu.' => 'Mit einem Klick auf die Zeile oeffnest du die jeweilige Kontaktdatenbank.',
            'Tento kontakt uz nebude zahrnuty do dalsich rozesilek.' => 'Dieser Kontakt wird in weiteren Aussendungen nicht mehr beruecksichtigt.',
            'Aplikace zustala dostupna, ale pri nacitani prihlasene casti narazila na chybu. Tento text pomuze opravit konkretni misto bez obecne HTTP 500.' => 'Die Anwendung ist erreichbar geblieben, aber beim Laden des angemeldeten Bereichs ist ein Fehler aufgetreten. Diese Meldung hilft, die konkrete Stelle ohne allgemeinen HTTP 500 zu beheben.',
            'Vytvor prvni administracni ucet. Emailove pripojeni nastavis po prihlaseni.' => 'Erstelle das erste Administratorkonto. Die E-Mail-Verbindung richtest du nach der Anmeldung ein.',
            'Zahrnout kontakty oslovene jinou kampani nebo oznacene jako oslovene pri importu' => 'Kontakte einschliessen, die von einer anderen Kampagne kontaktiert oder beim Import als kontaktiert markiert wurden',
            'Automaticky ridit limit za 24 h podle dorucitelnosti' => '24-Stunden-Limit automatisch nach Zustellbarkeit steuern',
            'Stejnemu kontaktu se neposle znovu; hlida se kombinace ID kampane a ID kontaktu v logu odeslani.' => 'Derselbe Kontakt erhaelt dieselbe Kampagne nicht erneut; geprueft wird die Kombination aus Kampagnen-ID und Kontakt-ID im Versandlog.',
            'Tabulka nize zobrazuje poslednich 50 behu; soucet viditelnych radku proto nemusi odpovidat celkovemu souhrnu.' => 'Die Tabelle unten zeigt die letzten 50 Laeufe; die Summe der sichtbaren Zeilen muss daher nicht der Gesamtuebersicht entsprechen.',
            'Soucasne heslo je potreba pouze pri zmene admin emailu nebo hesla.' => 'Das aktuelle Passwort wird nur beim Aendern der Admin-E-Mail oder des Passworts benoetigt.',
            'Selector najdes u poskytovatele emailu. Kontrola overuje DNS zaznamy domeny odesilatele, ne samotny podpis konkretni zpravy.' => 'Den Selector findest du beim E-Mail-Anbieter. Die Pruefung kontrolliert DNS-Eintraege der Absenderdomain, nicht die Signatur einer konkreten Nachricht.',
            'Prehled behu, ktere prave bezi nebo cekaji ve fronte napric vsemi scraping kontejnery.' => 'Uebersicht der Laeufe, die gerade laufen oder ueber alle Scraping-Container hinweg warten.',
            'Ted nebezi ani neceka zadny scraping beh.' => 'Aktuell laeuft oder wartet kein Scraping-Lauf.',
            'Zatim neni zalozeny zadny scraping kontejner.' => 'Es wurde noch kein Scraping-Container erstellt.',
            'Soubor se nahraje a import pobezi na pozadi. Prubeh uvidis v historii importu.' => 'Die Datei wird hochgeladen und der Import laeuft im Hintergrund. Den Fortschritt siehst du in der Importhistorie.',
            'Kontakt uz byl drive osloven' => 'Kontakt wurde bereits frueher kontaktiert',
            'Email, nazev, web, adresa nebo zdroj' => 'E-Mail, Name, Website, Adresse oder Quelle',
            'Zpet na databaze kontaktu' => 'Zurueck zu Kontaktdatenbanken',
            'Zpet na vsechny kontejnery' => 'Zurueck zu allen Containern',
            'Zpet na databazi' => 'Zurueck zur Datenbank',
            'Plan scrapingu' => 'Scraping-Plan',
            'Vytvorit koncept' => 'Entwurf erstellen',
            'Importovat kontakty' => 'Kontakte importieren',
            'Ulozit kontakt' => 'Kontakt speichern',
            'Zrusit filtr' => 'Filter entfernen',
            'Test v aplikaci overuje DNS zaznamy. Neumi sam vygenerovat DKIM klic ani poznat vsechny spravne ' => 'Der Test in der Anwendung prueft DNS-Eintraege. Er kann keinen DKIM-Schluessel erzeugen und kennt nicht alle richtigen ',
            'Pro ostre rozesilky je lepsi postupne prejit na ' => 'Fuer produktive Aussendungen ist es besser, schrittweise auf ',
            'Na domene ma byt jen jeden SPF zaznam zacinajici ' => 'Auf der Domain sollte es nur einen SPF-Eintrag geben, der mit ',
            'Musi povolit server/sluzbu, pres kterou odesilame SMTP.' => 'Er muss den Server oder Dienst erlauben, ueber den per SMTP gesendet wird.',
            'Selector a verejny klic musi dodat poskytovatel mailboxu/SMTP.' => 'Selector und oeffentlicher Schluessel muessen vom Mailbox-/SMTP-Anbieter kommen.',
            'Bez selectoru aplikace nevi, jaky DKIM zaznam hledat.' => 'Ohne Selector weiss die Anwendung nicht, welchen DKIM-Eintrag sie suchen soll.',
            'SMTP nastaveni ulozeno.' => 'SMTP-Einstellungen gespeichert.',
            'IMAP nastaveni ulozeno.' => 'IMAP-Einstellungen gespeichert.',
            'Prihlaseni ulozeno.' => 'Anmeldedaten gespeichert.',
            'SMTP pripojeni a prihlaseni funguje.' => 'SMTP-Verbindung und Anmeldung funktionieren.',
            'IMAP pripojeni a prihlaseni funguje.' => 'IMAP-Verbindung und Anmeldung funktionieren.',
            'Kampan ulozena.' => 'Kampagne gespeichert.',
            'Kampan vytvorena.' => 'Kampagne erstellt.',
            'Kampan spustena.' => 'Kampagne gestartet.',
            'Kampan pozastavena.' => 'Kampagne pausiert.',
            'Databaze kontaktu vytvorena.' => 'Kontaktdatenbank erstellt.',
            'Databaze kontaktu prejmenovana.' => 'Kontaktdatenbank umbenannt.',
            'Databaze kontaktu archivovana a skryta napric aplikaci.' => 'Kontaktdatenbank archiviert und in der gesamten Anwendung ausgeblendet.',
            'Kontakt odstranen.' => 'Kontakt entfernt.',
            'Scraping kontejner odstranen.' => 'Scraping-Container entfernt.',
            'Scraping job pozastaven.' => 'Scraping-Job pausiert.',
            'Scraping job obnoven.' => 'Scraping-Job fortgesetzt.',
            'Testovaci email neni platny.' => 'Test-E-Mail ist nicht gueltig.',
            'Testovaci email odeslan.' => 'Test-E-Mail gesendet.',
            'Odesilani kampane bezi na pozadi. Prubeh uvidis v poslednim odeslani.' => 'Der Kampagnenversand laeuft im Hintergrund. Den Fortschritt siehst du bei den letzten Sendungen.',
            'Vybrana databaze kontaktu neni dostupna.' => 'Die ausgewaehlte Kontaktdatenbank ist nicht verfuegbar.',
            'Email kontaktu neni platny.' => 'Kontakt-E-Mail ist nicht gueltig.',
            'Kontakt uz existuje a nebylo co aktualizovat.' => 'Der Kontakt existiert bereits und es gab nichts zu aktualisieren.',
            'Kontakt pro odstraneni neni platny.' => 'Der zu entfernende Kontakt ist nicht gueltig.',
            'Kontakt nebyl nalezen.' => 'Kontakt wurde nicht gefunden.',
            'Cas planu musi byt ve formatu HH:MM.' => 'Die Planzeit muss im Format HH:MM sein.',
            'Cas planu neni platny.' => 'Die Planzeit ist nicht gueltig.',
            'Plan scrapingu ulozen.' => 'Scraping-Plan gespeichert.',
            'Scraping kontejner neni aktivni.' => 'Scraping-Container ist nicht aktiv.',
            'Scraping kontejner nenalezen.' => 'Scraping-Container wurde nicht gefunden.',
            'Neznamy zdroj dat.' => 'Unbekannte Datenquelle.',
            'Zadej klicove slovo pro scraping.' => 'Gib einen Suchbegriff fuer Scraping ein.',
            'Scraping kontejner se stejnymi parametry uz existuje.' => 'Ein Scraping-Container mit denselben Parametern existiert bereits.',
            'Zadej nazev databaze kontaktu.' => 'Gib einen Namen fuer die Kontaktdatenbank ein.',
            'Zadej novy nazev databaze kontaktu.' => 'Gib einen neuen Namen fuer die Kontaktdatenbank ein.',
            'pro tuto kampan' => 'fuer diese Kampagne',
            'touto kampani' => 'durch diese Kampagne',
            'pred dalsim odeslanim' => 'vor dem naechsten Versand',
            'aktivni dostupne kontakty' => 'aktive verfuegbare Kontakte',
            'nejblizsi obnova' => 'naechste Erneuerung',
            'Prazdne = nemenit' => 'Leer = nicht aendern',
            'Nechat prazdne = nemenit' => 'Leer lassen = nicht aendern',
            'Jen pri zmene prihlaseni' => 'Nur bei Aenderung der Anmeldung',
            'Napriklad: masaze, massage, Massagen, masaz' => 'Zum Beispiel: masaze, massage, Massagen, masaz',
            'Vysvetleni limitu a zpusobilych kontaktu' => 'Erklaerung von Limit und geeigneten Kontakten',
            'Doplneni zdroju kontaktu selhalo' => 'Ergaenzung der Kontaktquellen fehlgeschlagen',
            'Startovni udrzba databaze byla preskocena kvuli docasne DB chybe' => 'Startwartung der Datenbank wurde wegen eines temporaeren DB-Fehlers uebersprungen',
            'Startovni udrzba databaze selhala' => 'Startwartung der Datenbank fehlgeschlagen',
            'Nastaveni aplikace se nepodarilo nacist z databaze' => 'Anwendungseinstellungen konnten nicht aus der Datenbank geladen werden',
            'Aplikace je pripravena.' => 'Die Anwendung ist bereit.',
            'Nespravny email nebo heslo.' => 'Falsche E-Mail oder falsches Passwort.',
            'Administraci se nepodarilo nacist' => 'Administration konnte nicht geladen werden',
            'MySQL uzivatel nema prava k databazi.' => 'Der MySQL-Benutzer hat keine Datenbankrechte.',
            'MySQL databaze neni dostupna.' => 'Die MySQL-Datenbank ist nicht verfuegbar.',
            'Odhlaseni nebylo nalezeno.' => 'Abmeldung wurde nicht gefunden.',
            'Admin email neni platny.' => 'Admin-E-Mail ist nicht gueltig.',
            'Pro zmenu prihlasovacich udaju zadej soucasne heslo.' => 'Gib das aktuelle Passwort ein, um Anmeldedaten zu aendern.',
            'Nove heslo musi mit alespon 10 znaku.' => 'Das neue Passwort muss mindestens 10 Zeichen haben.',
            'Kampan nenalezena.' => 'Kampagne nicht gefunden.',
            'Hotovo.' => 'Fertig.',
            'Chyba databaze' => 'Datenbankfehler',
            'Chyba aplikace' => 'Anwendungsfehler',
            'Email rozesilac' => 'E-Mail-Kampagnen',
            'Nastaveni aplikace' => 'Anwendung einrichten',
            'Pokracovat pres Google' => 'Mit Google fortfahren',
            'Vytvorit pres Google' => 'Mit Google erstellen',
            'Vytvorit administraci' => 'Administration erstellen',
            'Admin heslo' => 'Admin-Passwort',
            'Admin email' => 'Admin-E-Mail',
            'Prihlasit' => 'Anmelden',
            'Odhlasit' => 'Abmelden',
            'Zkusit znovu' => 'Erneut versuchen',
            'Jazyk rozhrani' => 'Sprache der Oberflaeche',
            'Cestina' => 'Tschechisch',
            'English' => 'Englisch',
            'Deutsch' => 'Deutsch',
            'Verze' => 'Version',
            'Prehled' => 'Uebersicht',
            'Kontakty' => 'Kontakte',
            'Kampane' => 'Kampagnen',
            'Konfigurace' => 'Einstellungen',
            'Stav kampane' => 'Kampagnenstatus',
            'Stav kampani' => 'Kampagnenstatus',
            'Kampan' => 'Kampagne',
            'Stav' => 'Status',
            'Databaze kontaktu' => 'Kontaktdatenbank',
            'Databaze' => 'Datenbank',
            'Planovano' => 'Geplant',
            'Osloveno' => 'Kontaktiert',
            'Otevreno' => 'Geoeffnet',
            'Odpovedeli' => 'Geantwortet',
            'Odpovedi' => 'Antworten',
            'Kliknuli' => 'Geklickt',
            'Kliky' => 'Klicks',
            'Za 24 h odeslano' => 'In 24 h gesendet',
            'Schranka zbyva / 24 h' => 'Postfach verbleibend / 24 h',
            'Zbyva kampani 24 h' => 'Kampagne verbleibend 24 h',
            'obnovi se' => 'erneuert sich',
            'zatim bez odeslani' => 'bisher ohne Versand',
            'Bez kampane' => 'Keine Kampagne',
            'Nova kampan' => 'Neue Kampagne',
            'Zatim neni zalozena zadna kampan.' => 'Es wurde noch keine Kampagne erstellt.',
            'Nazev' => 'Name',
            'Predmet' => 'Betreff',
            'Plan' => 'Plan',
            'Zbyva' => 'Verbleibt',
            'Akce' => 'Aktionen',
            'Pozastavit' => 'Pausieren',
            'Spustit hned' => 'Jetzt starten',
            'Spustit' => 'Starten',
            'Koncept' => 'Entwurf',
            'Aktivni' => 'Aktiv',
            'Pozastaveno' => 'Pausiert',
            'Max za 24 h' => 'Max. pro 24 h',
            'Cas denniho odesilani' => 'Taegliche Versandzeit',
            'Zpusobili' => 'Geeignet',
            'Vyrazeno' => 'Ausgeschlossen',
            'Stejna kampan' => 'Gleiche Kampagne',
            'Cilova databaze' => 'Zieldatenbank',
            'Limit pro dalsi beh' => 'Limit fuer den naechsten Lauf',
            'Teto kampani zbyva' => 'Diese Kampagne hat verbleibend',
            'Odesilaci schrance zbyva' => 'Absenderpostfach hat verbleibend',
            'dalsi obnova' => 'naechste Erneuerung',
            'Rezim editoru' => 'Editor-Modus',
            'Nahled' => 'Vorschau',
            'Obrazek' => 'Bild',
            'Ulozit kampan' => 'Kampagne speichern',
            'Odeslat test' => 'Test senden',
            'Vysvetleni kampane' => 'Kampagnenerklaerung',
            'Zavrit' => 'Schliessen',
            'Posledni odeslani' => 'Letzte Sendungen',
            'Souhrn vsech behu' => 'Zusammenfassung aller Laeufe',
            'behu' => 'Laeufe',
            'Celkem' => 'Insgesamt',
            'kontaktu' => 'Kontakte',
            'k osloveni' => 'zu kontaktieren',
            'odeslanych emailu' => 'gesendete E-Mails',
            'unikatnich oslovenych kontaktu' => 'eindeutig kontaktierte Kontakte',
            'chyb' => 'Fehler',
            'Kdy' => 'Wann',
            'Kontakt' => 'Kontakt',
            'Otevrel' => 'Geoeffnet',
            'Kliknul' => 'Geklickt',
            'Odpovedel' => 'Geantwortet',
            'Soubor' => 'Datei',
            'Radku' => 'Zeilen',
            'Detail' => 'Detail',
            'Filtr' => 'Filter',
            'Spusteno' => 'Gestartet',
            'Typ' => 'Typ',
            'Vybrano' => 'Ausgewaehlt',
            'Odeslano' => 'Gesendet',
            'Chyby' => 'Fehler',
            'Dalsi pokus' => 'Naechster Versuch',
            'Dokonceno' => 'Abgeschlossen',
            'Zprava' => 'Nachricht',
            'Nova databaze' => 'Neue Datenbank',
            'Vytvorit databazi' => 'Datenbank erstellen',
            'Prejmenovat' => 'Umbenennen',
            'Odstranit' => 'Entfernen',
            'Archivovat' => 'Archivieren',
            'K osloveni' => 'Zu kontaktieren',
            'Neosloveno' => 'Nicht kontaktiert',
            'Import kontaktu' => 'Kontaktimport',
            'Rucne vlozit kontakt' => 'Kontakt manuell hinzufuegen',
            'Historie importu' => 'Importhistorie',
            'Detail importu' => 'Importdetail',
            'Pridane kontakty' => 'Hinzugefuegte Kontakte',
            'Aktualizovane kontakty' => 'Aktualisierte Kontakte',
            'Preskocene kontakty' => 'Uebersprungene Kontakte',
            'Zdroj dat' => 'Datenquelle',
            'Zdrojova URL' => 'Quell-URL',
            'Zdroj' => 'Quelle',
            'Adresa' => 'Adresse',
            'Pridano' => 'Hinzugefuegt',
            'Modifikovano' => 'Geaendert',
            'Osloven' => 'Kontaktiert',
            'Smazat' => 'Loeschen',
            'Hledat v kontaktech' => 'In Kontakten suchen',
            'Stranka' => 'Seite',
            'Zpet' => 'Zurueck',
            'Aktivni scraping behy' => 'Aktive Scraping-Laeufe',
            'Scraping kontejnery' => 'Scraping-Container',
            'Novy scraping kontejner' => 'Neuer Scraping-Container',
            'Novy scraping' => 'Neues Scraping',
            'Vytvorit kontejner' => 'Container erstellen',
            'Klicove slovo' => 'Suchbegriff',
            'Cilova databaze kontaktu' => 'Ziel-Kontaktdatenbank',
            'Spusteni' => 'Start',
            'Posledni beh' => 'Letzter Lauf',
            'Vlozeno' => 'Eingefuegt',
            'Aktualizovano' => 'Aktualisiert',
            'Prerusit' => 'Abbrechen',
            'Aktivovat plan' => 'Plan aktivieren',
            'Pozastavit plan' => 'Plan pausieren',
            'Spustit ted' => 'Jetzt starten',
            'Log scraping behu' => 'Scraping-Lauflog',
            'Tento kontejner zatim nema zadny beh.' => 'Dieser Container hat noch keinen Lauf.',
            'Zprac.' => 'Verarb.',
            'Zpracovano' => 'Verarbeitet',
            'Aktualiz.' => 'Aktual.',
            'Presk.' => 'Ueberspr.',
            'Preskoceno' => 'Uebersprungen',
            'Vysledek' => 'Ergebnis',
            'Detail behu' => 'Laufdetail',
            'Frekvence' => 'Frequenz',
            'Denne' => 'Taeglich',
            'Jednou tydne' => 'Woechentlich',
            'Den v tydnu' => 'Wochentag',
            'Cas spusteni' => 'Startzeit',
            'Ulozit plan' => 'Plan speichern',
            'Plan pozastaven' => 'Plan pausiert',
            'Plan zapnut' => 'Plan aktiv',
            'SMTP odesilani' => 'SMTP-Versand',
            'SMTP nastaveni' => 'SMTP-Einstellungen',
            'SMTP server' => 'SMTP-Server',
            'SMTP uzivatel' => 'SMTP-Benutzer',
            'SMTP heslo' => 'SMTP-Passwort',
            'Upravit SMTP' => 'SMTP bearbeiten',
            'Otestovat SMTP' => 'SMTP testen',
            'Ulozit SMTP' => 'SMTP speichern',
            'Odesilatel email' => 'Absender-E-Mail',
            'Odesilatel jmeno' => 'Absendername',
            'Sifrovani' => 'Verschluesselung',
            'Bez' => 'Ohne',
            'SPF / DKIM / DMARC' => 'SPF / DKIM / DMARC',
            'DNS overeni' => 'DNS-Pruefung',
            'Otestovat DNS' => 'DNS testen',
            'Co musi byt nastaveno' => 'Was eingerichtet sein muss',
            'Posledni kontrola' => 'Letzte Pruefung',
            'Domena' => 'Domain',
            'nenastaveno' => 'nicht gesetzt',
            'IMAP odpovedi' => 'IMAP-Antworten',
            'IMAP nastaveni' => 'IMAP-Einstellungen',
            'IMAP server' => 'IMAP-Server',
            'IMAP uzivatel' => 'IMAP-Benutzer',
            'IMAP heslo' => 'IMAP-Passwort',
            'Upravit IMAP' => 'IMAP bearbeiten',
            'Otestovat IMAP' => 'IMAP testen',
            'Ulozit IMAP' => 'IMAP speichern',
            'Synchronizovat odpovedi' => 'Antworten synchronisieren',
            'Prihlaseni do aplikace' => 'Anmeldung zur Anwendung',
            'Upravit prihlaseni' => 'Anmeldung bearbeiten',
            'Ulozit prihlaseni' => 'Anmeldung speichern',
            'Soucasne heslo' => 'Aktuelles Passwort',
            'Nove heslo' => 'Neues Passwort',
            'Zrusit' => 'Abbrechen',
            'Otestovat' => 'Testen',
            'Ulozit' => 'Speichern',
            'Host' => 'Host',
            'Port' => 'Port',
            'Uzivatelske jmeno' => 'Benutzername',
            'Heslo' => 'Passwort',
            'pondeli' => 'Montag',
            'utery' => 'Dienstag',
            'streda' => 'Mittwoch',
            'ctvrtek' => 'Donnerstag',
            'patek' => 'Freitag',
            'sobota' => 'Samstag',
            'nedele' => 'Sonntag',
            'manualni' => 'manuell',
            'naplanovany' => 'geplant',
            'historicky' => 'historisch',
            'jednorazovy' => 'einmalig',
            'rozpracovano' => 'in Bearbeitung',
            'bezi' => 'laeuft',
            'bezi...' => 'laeuft...',
            'hotovo' => 'fertig',
            'chyba' => 'Fehler',
            'zruseno' => 'abgebrochen',
            'ceka' => 'wartet',
            'fronta' => 'Warteschlange',
            'vlozeno' => 'eingefuegt',
            'aktualizovano' => 'aktualisiert',
            'preskoceno' => 'uebersprungen',
            'nezjisteno' => 'unbekannt',
            'nenapojeno' => 'nicht verbunden',
            'Odhlaseno' => 'Abgemeldet',
            'nebo' => 'oder',
        ];
        uksort($map, static fn(string $a, string $b): int => strlen($b) <=> strlen($a));
        return $map;
    }
    if ($language !== 'en') {
        return [];
    }
    $map = [
        'Aplikace je nastavena pouze na produkcni MySQL/MariaDB databazi. Zkontroluj prosim hodnoty APP_DATABASE_NAME, APP_DATABASE_USERNAME a APP_DATABASE_PASSWORD v GitHub Secrets a hlavne prava DB uzivatele pro SELECT/INSERT/UPDATE/DELETE/CREATE/ALTER nad touto databazi.' => 'The application is configured to use only the production MySQL/MariaDB database. Please check APP_DATABASE_NAME, APP_DATABASE_USERNAME and APP_DATABASE_PASSWORD in GitHub Secrets, especially the database user permissions for SELECT/INSERT/UPDATE/DELETE/CREATE/ALTER on this database.',
        'Jednotlive casti nastaveni se meni oddelene, aby se prihlasovaci udaje nikdy neprepsaly omylem.' => 'Each configuration area is edited separately so credentials are not overwritten accidentally.',
        'Prehled pripravenych kampani, jejich planu, limitu a stavu osloveni.' => 'Overview of prepared campaigns, schedules, limits and outreach status.',
        'Backend prochazi stranky vysledku postupne, dokud zdroj vraci dalsi zaznamy. Podporovane jsou Firmy.cz, Herold.at, Zoznam.sk, DasTelefonbuch.de, DasOertliche.de, GelbeSeiten.de, Pkt.pl, PanoramaFirm.pl, MerchantCircle a YellowPages.ca. Z nalezenych detailu pak hleda email, nazev, web a adresu.' => 'The backend walks through result pages until the source stops returning records. Supported sources are Firmy.cz, Herold.at, Zoznam.sk, DasTelefonbuch.de, DasOertliche.de, GelbeSeiten.de, Pkt.pl, PanoramaFirm.pl, MerchantCircle and YellowPages.ca. From detail pages it extracts email, name, website and address.',
        'Kazdy kontejner drzi zdroj, klicove slovo a cilovou databazi. Kliknutim na radek otevres logy konkretniho kontejneru.' => 'Each container stores the source, keyword and target database. Click a row to open logs for that container.',
        'Kliknutim na radek otevres konkretni databazi kontaktu.' => 'Click a row to open that contact database.',
        'Tento kontakt uz nebude zahrnuty do dalsich rozesilek.' => 'This contact will no longer be included in future sends.',
        'Aplikace zustala dostupna, ale pri nacitani prihlasene casti narazila na chybu. Tento text pomuze opravit konkretni misto bez obecne HTTP 500.' => 'The application stayed available, but the authenticated area hit an error while loading. This message helps fix the exact place without a generic HTTP 500.',
        'Vytvor prvni administracni ucet. Emailove pripojeni nastavis po prihlaseni.' => 'Create the first admin account. You can configure email after signing in.',
        'Zahrnout kontakty oslovene jinou kampani nebo oznacene jako oslovene pri importu' => 'Include contacts contacted by another campaign or marked as contacted during import',
        'Automaticky ridit limit za 24 h podle dorucitelnosti' => 'Automatically manage the 24 h limit based on deliverability',
        'Stejnemu kontaktu se neposle znovu; hlida se kombinace ID kampane a ID kontaktu v logu odeslani.' => 'The same contact will not receive the same campaign again; this is checked by campaign ID and contact ID in the send log.',
        'Tabulka nize zobrazuje poslednich 50 behu; soucet viditelnych radku proto nemusi odpovidat celkovemu souhrnu.' => 'The table below shows the last 50 runs, so the sum of visible rows may differ from the overall summary.',
        'Soucasne heslo je potreba pouze pri zmene admin emailu nebo hesla.' => 'The current password is required only when changing the admin email or password.',
        'Selector najdes u poskytovatele emailu. Kontrola overuje DNS zaznamy domeny odesilatele, ne samotny podpis konkretni zpravy.' => 'You can find the selector at your email provider. The check verifies DNS records for the sender domain, not the signature of a specific message.',
        'Prehled behu, ktere prave bezi nebo cekaji ve fronte napric vsemi scraping kontejnery.' => 'Overview of runs that are currently running or waiting across all scraping containers.',
        'Ted nebezi ani neceka zadny scraping beh.' => 'No scraping run is currently running or waiting.',
        'Zatim neni zalozeny zadny scraping kontejner.' => 'No scraping container has been created yet.',
        'Soubor se nahraje a import pobezi na pozadi. Prubeh uvidis v historii importu.' => 'The file will be uploaded and imported in the background. You will see progress in import history.',
        'Kontakt uz byl drive osloven' => 'Contact was already contacted before',
        'Email, nazev, web, adresa nebo zdroj' => 'Email, name, website, address or source',
        'Zpet na databaze kontaktu' => 'Back to Contact Databases',
        'Zpet na vsechny kontejnery' => 'Back to All Containers',
        'Zpet na databazi' => 'Back to Database',
        'Plan scrapingu' => 'Scraping Schedule',
        'Vytvorit koncept' => 'Create Draft',
        'Importovat kontakty' => 'Import Contacts',
        'Ulozit kontakt' => 'Save Contact',
        'Zrusit filtr' => 'Clear Filter',
        'Test v aplikaci overuje DNS zaznamy. Neumi sam vygenerovat DKIM klic ani poznat vsechny spravne ' => 'The in-app test verifies DNS records. It cannot generate a DKIM key or know all correct ',
        'Pro ostre rozesilky je lepsi postupne prejit na ' => 'For live sends, it is better to gradually move to ',
        'Na domene ma byt jen jeden SPF zaznam zacinajici ' => 'The domain should have only one SPF record starting with ',
        'Musi povolit server/sluzbu, pres kterou odesilame SMTP.' => 'It must allow the server/service used for SMTP sending.',
        'Selector a verejny klic musi dodat poskytovatel mailboxu/SMTP.' => 'The selector and public key must be provided by the mailbox/SMTP provider.',
        'Bez selectoru aplikace nevi, jaky DKIM zaznam hledat.' => 'Without a selector, the application does not know which DKIM record to look for.',
        'SMTP nastaveni ulozeno.' => 'SMTP settings saved.',
        'IMAP nastaveni ulozeno.' => 'IMAP settings saved.',
        'Prihlaseni ulozeno.' => 'Login settings saved.',
        'SMTP pripojeni a prihlaseni funguje.' => 'SMTP connection and authentication work.',
        'IMAP pripojeni a prihlaseni funguje.' => 'IMAP connection and authentication work.',
        'Kampan ulozena.' => 'Campaign saved.',
        'Kampan vytvorena.' => 'Campaign created.',
        'Kampan spustena.' => 'Campaign started.',
        'Kampan pozastavena.' => 'Campaign paused.',
        'Databaze kontaktu vytvorena.' => 'Contact database created.',
        'Databaze kontaktu prejmenovana.' => 'Contact database renamed.',
        'Databaze kontaktu archivovana a skryta napric aplikaci.' => 'Contact database archived and hidden across the application.',
        'Kontakt odstranen.' => 'Contact removed.',
        'Scraping kontejner odstranen.' => 'Scraping container removed.',
        'Scraping job pozastaven.' => 'Scraping job paused.',
        'Scraping job obnoven.' => 'Scraping job resumed.',
        'Testovaci email neni platny.' => 'Test email is not valid.',
        'Testovaci email odeslan.' => 'Test email sent.',
        'Odesilani kampane bezi na pozadi. Prubeh uvidis v poslednim odeslani.' => 'Campaign sending is running in the background. You will see progress in recent sends.',
        'Vybrana databaze kontaktu neni dostupna.' => 'Selected contact database is not available.',
        'Email kontaktu neni platny.' => 'Contact email is not valid.',
        'Kontakt uz existuje a nebylo co aktualizovat.' => 'The contact already exists and there was nothing to update.',
        'Kontakt pro odstraneni neni platny.' => 'Contact selected for removal is not valid.',
        'Kontakt nebyl nalezen.' => 'Contact was not found.',
        'Cas planu musi byt ve formatu HH:MM.' => 'Schedule time must use the HH:MM format.',
        'Cas planu neni platny.' => 'Schedule time is not valid.',
        'Plan scrapingu ulozen.' => 'Scraping schedule saved.',
        'Scraping kontejner neni aktivni.' => 'Scraping container is not active.',
        'Scraping kontejner nenalezen.' => 'Scraping container was not found.',
        'Neznamy zdroj dat.' => 'Unknown data source.',
        'Zadej klicove slovo pro scraping.' => 'Enter a keyword for scraping.',
        'Scraping kontejner se stejnymi parametry uz existuje.' => 'A scraping container with the same parameters already exists.',
        'Zadej nazev databaze kontaktu.' => 'Enter a contact database name.',
        'Zadej novy nazev databaze kontaktu.' => 'Enter a new contact database name.',
        'pro tuto kampan' => 'for this campaign',
        'touto kampani' => 'by this campaign',
        'pred dalsim odeslanim' => 'before the next send',
        'aktivni dostupne kontakty' => 'active available contacts',
        'nejblizsi obnova' => 'next reset',
        'Prazdne = nemenit' => 'Empty = keep unchanged',
        'Nechat prazdne = nemenit' => 'Leave empty = keep unchanged',
        'Jen pri zmene prihlaseni' => 'Only when changing login',
        'Napriklad: masaze, massage, Massagen, masaz' => 'Example: masaze, massage, Massagen, masaz',
        'Vysvetleni limitu a zpusobilych kontaktu' => 'Limit and eligible contacts explanation',
        'Doplneni zdroju kontaktu selhalo' => 'Contact source backfill failed',
        'Startovni udrzba databaze byla preskocena kvuli docasne DB chybe' => 'Startup database maintenance was skipped because of a temporary DB error',
        'Startovni udrzba databaze selhala' => 'Startup database maintenance failed',
        'Nastaveni aplikace se nepodarilo nacist z databaze' => 'Application settings could not be loaded from the database',
        'Aplikace je pripravena.' => 'The application is ready.',
        'Nespravny email nebo heslo.' => 'Incorrect email or password.',
        'Administraci se nepodarilo nacist' => 'Administration could not be loaded',
        'MySQL uzivatel nema prava k databazi.' => 'The MySQL user does not have database permissions.',
        'MySQL databaze neni dostupna.' => 'The MySQL database is not available.',
        'Odhlaseni nebylo nalezeno.' => 'Unsubscribe record was not found.',
        'Admin email neni platny.' => 'Admin email is not valid.',
        'Pro zmenu prihlasovacich udaju zadej soucasne heslo.' => 'Enter the current password to change login details.',
        'Nove heslo musi mit alespon 10 znaku.' => 'The new password must have at least 10 characters.',
        'Kampan nenalezena.' => 'Campaign not found.',
        'Hotovo.' => 'Done.',
        'Chyba databaze' => 'Database Error',
        'Chyba aplikace' => 'Application Error',
        'Email rozesilac' => 'Email Campaign',
        'Nastaveni aplikace' => 'Application Setup',
        'Pokracovat pres Google' => 'Continue with Google',
        'Vytvorit pres Google' => 'Create with Google',
        'Vytvorit administraci' => 'Create Admin Account',
        'Admin heslo' => 'Admin Password',
        'Admin email' => 'Admin Email',
        'Prihlasit' => 'Log In',
        'Odhlasit' => 'Log Out',
        'Zkusit znovu' => 'Try Again',
        'Jazyk rozhrani' => 'Interface Language',
        'Cestina' => 'Czech',
        'Verze' => 'Version',
        'Prehled' => 'Dashboard',
        'Kontakty' => 'Contacts',
        'Kampane' => 'Campaigns',
        'Konfigurace' => 'Settings',
        'Stav kampane' => 'Campaign Status',
        'Stav kampani' => 'Campaign Status',
        'Kampan' => 'Campaign',
        'Stav' => 'Status',
        'Databaze kontaktu' => 'Contact Database',
        'Databaze' => 'Database',
        'Planovano' => 'Planned',
        'Osloveno' => 'Contacted',
        'Otevreno' => 'Opened',
        'Odpovedeli' => 'Replied',
        'Odpovedi' => 'Replies',
        'Kliknuli' => 'Clicked',
        'Kliky' => 'Clicks',
        'Za 24 h odeslano' => 'Sent in 24 h',
        'Schranka zbyva / 24 h' => 'Mailbox remaining / 24 h',
        'Zbyva kampani 24 h' => 'Campaign remaining 24 h',
        'obnovi se' => 'resets',
        'zatim bez odeslani' => 'no sends yet',
        'Bez kampane' => 'No Campaign',
        'Nova kampan' => 'New Campaign',
        'Zatim neni zalozena zadna kampan.' => 'No campaign has been created yet.',
        'Nazev' => 'Name',
        'Predmet' => 'Subject',
        'Plan' => 'Schedule',
        'Zbyva' => 'Remaining',
        'Akce' => 'Actions',
        'Pozastavit' => 'Pause',
        'Spustit hned' => 'Run Now',
        'Spustit' => 'Start',
        'Koncept' => 'Draft',
        'Aktivni' => 'Active',
        'Pozastaveno' => 'Paused',
        'Max za 24 h' => 'Max per 24 h',
        'Cas denniho odesilani' => 'Daily sending time',
        'Zpusobili' => 'Eligible',
        'Vyrazeno' => 'Excluded',
        'Stejna kampan' => 'Same Campaign',
        'Cilova databaze' => 'Target Database',
        'Limit pro dalsi beh' => 'Limit for Next Run',
        'Teto kampani zbyva' => 'This campaign has remaining',
        'Odesilaci schrance zbyva' => 'Sending mailbox has remaining',
        'dalsi obnova' => 'next reset',
        'Rezim editoru' => 'Editor Mode',
        'Nahled' => 'Preview',
        'Obrazek' => 'Image',
        'Ulozit kampan' => 'Save Campaign',
        'Odeslat test' => 'Send Test',
        'Vysvetleni kampane' => 'Campaign Explanation',
        'Zavrit' => 'Close',
        'Posledni odeslani' => 'Recent Sends',
        'Souhrn vsech behu' => 'Summary of All Runs',
        'behu' => 'runs',
        'Celkem' => 'Total',
        'kontaktu' => 'contacts',
        'k osloveni' => 'to contact',
        'odeslanych emailu' => 'sent emails',
        'unikatnich oslovenych kontaktu' => 'unique contacted contacts',
        'chyb' => 'errors',
        'Kdy' => 'When',
        'Kontakt' => 'Contact',
        'Otevrel' => 'Opened',
        'Kliknul' => 'Clicked',
        'Odpovedel' => 'Replied',
        'Soubor' => 'File',
        'Radku' => 'Rows',
        'Detail' => 'Detail',
        'Filtr' => 'Filter',
        'Spusteno' => 'Started',
        'Typ' => 'Type',
        'Vybrano' => 'Selected',
        'Odeslano' => 'Sent',
        'Chyby' => 'Errors',
        'Dalsi pokus' => 'Next Attempt',
        'Dokonceno' => 'Finished',
        'Zprava' => 'Message',
        'Nova databaze' => 'New Database',
        'Vytvorit databazi' => 'Create Database',
        'Prejmenovat' => 'Rename',
        'Odstranit' => 'Remove',
        'Archivovat' => 'Archive',
        'K osloveni' => 'To Contact',
        'Neosloveno' => 'Not Contacted',
        'Import kontaktu' => 'Import Contacts',
        'Rucne vlozit kontakt' => 'Add Contact Manually',
        'Historie importu' => 'Import History',
        'Detail importu' => 'Import Detail',
        'Pridane kontakty' => 'Added Contacts',
        'Aktualizovane kontakty' => 'Updated Contacts',
        'Preskocene kontakty' => 'Skipped Contacts',
        'Zdroj dat' => 'Data Source',
        'Zdrojova URL' => 'Source URL',
        'Zdroj' => 'Source',
        'Adresa' => 'Address',
        'Pridano' => 'Added',
        'Modifikovano' => 'Modified',
        'Osloven' => 'Contacted',
        'Smazat' => 'Delete',
        'Hledat v kontaktech' => 'Search Contacts',
        'Stranka' => 'Page',
        'Zpet' => 'Back',
        'Aktivni scraping behy' => 'Active Scraping Runs',
        'Scraping kontejnery' => 'Scraping Containers',
        'Novy scraping kontejner' => 'New Scraping Container',
        'Novy scraping' => 'New Scraping',
        'Vytvorit kontejner' => 'Create Container',
        'Klicove slovo' => 'Keyword',
        'Cilova databaze kontaktu' => 'Target Contact Database',
        'Spusteni' => 'Run Schedule',
        'Posledni beh' => 'Last Run',
        'Vlozeno' => 'Inserted',
        'Aktualizovano' => 'Updated',
        'Prerusit' => 'Stop',
        'Aktivovat plan' => 'Activate Schedule',
        'Pozastavit plan' => 'Pause Schedule',
        'Spustit ted' => 'Run Now',
        'Log scraping behu' => 'Scraping Run Log',
        'Tento kontejner zatim nema zadny beh.' => 'This container does not have any run yet.',
        'Zprac.' => 'Proc.',
        'Zpracovano' => 'Processed',
        'Aktualiz.' => 'Updated',
        'Presk.' => 'Skipped',
        'Preskoceno' => 'Skipped',
        'Vysledek' => 'Result',
        'Detail behu' => 'Run Detail',
        'Frekvence' => 'Frequency',
        'Denne' => 'Daily',
        'Jednou tydne' => 'Weekly',
        'Den v tydnu' => 'Weekday',
        'Cas spusteni' => 'Run Time',
        'Ulozit plan' => 'Save Schedule',
        'Plan pozastaven' => 'Schedule paused',
        'Plan zapnut' => 'Schedule active',
        'SMTP odesilani' => 'SMTP Sending',
        'SMTP nastaveni' => 'SMTP Settings',
        'SMTP server' => 'SMTP Server',
        'SMTP uzivatel' => 'SMTP Username',
        'SMTP heslo' => 'SMTP Password',
        'Upravit SMTP' => 'Edit SMTP',
        'Otestovat SMTP' => 'Test SMTP',
        'Ulozit SMTP' => 'Save SMTP',
        'Odesilatel email' => 'Sender Email',
        'Odesilatel jmeno' => 'Sender Name',
        'Sifrovani' => 'Encryption',
        'Bez' => 'None',
        'SPF / DKIM / DMARC' => 'SPF / DKIM / DMARC',
        'DNS overeni' => 'DNS Verification',
        'Otestovat DNS' => 'Test DNS',
        'Co musi byt nastaveno' => 'What Must Be Configured',
        'Posledni kontrola' => 'Last Check',
        'Domena' => 'Domain',
        'nenastaveno' => 'not set',
        'IMAP odpovedi' => 'IMAP Replies',
        'IMAP nastaveni' => 'IMAP Settings',
        'IMAP server' => 'IMAP Server',
        'IMAP uzivatel' => 'IMAP Username',
        'IMAP heslo' => 'IMAP Password',
        'Upravit IMAP' => 'Edit IMAP',
        'Otestovat IMAP' => 'Test IMAP',
        'Ulozit IMAP' => 'Save IMAP',
        'Synchronizovat odpovedi' => 'Sync Replies',
        'Prihlaseni do aplikace' => 'Application Login',
        'Upravit prihlaseni' => 'Edit Login',
        'Ulozit prihlaseni' => 'Save Login',
        'Soucasne heslo' => 'Current Password',
        'Nove heslo' => 'New Password',
        'Zrusit' => 'Cancel',
        'Otestovat' => 'Test',
        'Ulozit' => 'Save',
        'Host' => 'Host',
        'Port' => 'Port',
        'Uzivatelske jmeno' => 'Username',
        'Heslo' => 'Password',
        'pondeli' => 'Monday',
        'utery' => 'Tuesday',
        'streda' => 'Wednesday',
        'ctvrtek' => 'Thursday',
        'patek' => 'Friday',
        'sobota' => 'Saturday',
        'nedele' => 'Sunday',
        'manualni' => 'manual',
        'naplanovany' => 'scheduled',
        'historicky' => 'historical',
        'jednorazovy' => 'one-time',
        'rozpracovano' => 'in progress',
        'bezi' => 'running',
        'bezi...' => 'running...',
        'hotovo' => 'done',
        'chyba' => 'error',
        'zruseno' => 'cancelled',
        'ceka' => 'waiting',
        'fronta' => 'queue',
        'vlozeno' => 'inserted',
        'aktualizovano' => 'updated',
        'preskoceno' => 'skipped',
        'nezjisteno' => 'unknown',
        'nenapojeno' => 'not connected',
        'Odhlaseno' => 'Unsubscribed',
        'nebo' => 'or',
    ];
    uksort($map, static fn(string $a, string $b): int => strlen($b) <=> strlen($a));
    return $map;
}

function formatDateTime(string $value): string
{
    $time = strtotime($value);
    return $time ? date('d.m.Y H:i', $time) : $value;
}

function renderLogin(?array $flash, array $config): void
{
    $googleEnabled = googleAuthEnabled($config);
    ob_start();
    ?><!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email rozesilac</title><link rel="stylesheet" href="<?= h(assetUrl('assets/app.css')) ?>"></head><body class="login"><main><form method="post" class="panel narrow login-panel"><input type="hidden" name="action" value="login"><h1>Email rozesilac</h1><?php renderFlash($flash); ?><?php if ($googleEnabled): ?><a class="button google-button" href="?auth=google">Pokracovat pres Google</a><div class="auth-divider"><span>nebo</span></div><?php endif; ?><label>Email<input type="email" name="email" autocomplete="username" autofocus required></label><label>Heslo<input type="password" name="password" autocomplete="current-password" required></label><button>Prihlasit</button><p class="version">Verze <?= h(APP_VERSION) ?></p></form></main><?php renderLanguageFooter(null, $config); ?></body></html><?php
    echo localizeHtml((string)ob_get_clean(), null, $config);
}

function renderSetup(?array $flash, array $config): void
{
    $googleEnabled = googleAuthEnabled($config);
    ob_start();
    ?><!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nastaveni aplikace</title><link rel="stylesheet" href="<?= h(assetUrl('assets/app.css')) ?>"></head><body class="login"><main><form method="post" class="panel narrow login-panel"><input type="hidden" name="action" value="setup"><h1>Nastaveni aplikace</h1><?php renderFlash($flash); ?><p>Vytvor prvni administracni ucet. Emailove pripojeni nastavis po prihlaseni.</p><?php if ($googleEnabled): ?><a class="button google-button" href="?auth=google">Vytvorit pres Google</a><div class="auth-divider"><span>nebo</span></div><?php endif; ?><label>Admin email<input type="email" name="admin_email" autocomplete="username" autofocus required></label><label>Admin heslo<input type="password" name="new_password" minlength="10" autocomplete="new-password" required></label><button>Vytvorit administraci</button></form></main><?php renderLanguageFooter(null, $config); ?></body></html><?php
    echo localizeHtml((string)ob_get_clean(), null, $config);
}

function renderFatal(Throwable $e, ?array $flash): void
{
    $message = 'Administraci se nepodarilo nacist: ' . $e->getMessage();
    ob_start();
    ?><!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chyba aplikace</title><link rel="stylesheet" href="<?= h(assetUrl('assets/app.css')) ?>"></head><body><header><strong>Email rozesilac</strong><a href="?logout=1">Odhlasit</a></header><main><section class="panel narrow"><?php renderFlash($flash); ?><div class="flash error"><?= h($message) ?></div><p class="note">Aplikace zustala dostupna, ale pri nacitani prihlasene casti narazila na chybu. Tento text pomuze opravit konkretni misto bez obecne HTTP 500.</p><a class="button" href="./?route=dashboard">Zkusit znovu</a></section></main><?php renderLanguageFooter(); ?></body></html><?php
    echo localizeHtml((string)ob_get_clean());
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
    $map = ['dashboard' => 'overview', 'contacts' => 'contacts', 'campaigns' => 'campaigns', 'scraping' => 'scraping', 'config' => 'config'];
    if (isset($map[$route])) {
        return $map[$route];
    }
    $view = $_GET['view'] ?? 'overview';
    return in_array($view, ['overview', 'contacts', 'campaigns', 'scraping', 'config'], true) ? $view : 'overview';
}

function routeUrl(string $view): string
{
    $map = ['overview' => './?route=dashboard', 'contacts' => './?route=contacts', 'campaigns' => './?route=campaigns', 'scraping' => './?route=scraping', 'config' => './?route=config'];
    return $map[$view] ?? './?route=dashboard';
}

function postReturnUrl(PDO $pdo, string $view): string
{
    $url = routeUrl($view);
    if ($view === 'contacts' && ($_POST['return_to'] ?? '') === 'overview') {
        return $url;
    }
    if ($view === 'contacts') {
        $id = (int)($_POST['database_id'] ?? $_POST['list_id'] ?? 0);
        if ($id > 0 && contactListExists($pdo, $id)) {
            return $url . '&database_id=' . $id;
        }
    }
    if ($view === 'scraping') {
        $id = (int)($_POST['container_id'] ?? 0);
        if ($id > 0) {
            return $url . '&container_id=' . $id;
        }
    }
    return $url;
}

function renderApp(PDO $pdo, ?array $flash): void
{
    global $config;
    $view = currentView();
    $emptyRecipientPage = ['rows' => [], 'total' => 0, 'page' => 1, 'pages' => 1, 'per_page' => 100, 'q' => '', 'metric' => '', 'sort' => 'created_at', 'dir' => 'desc'];
    $campaigns = [];
    $recipients = 0;
    $lists = [];
    $selectedListId = 0;
    $recipientPage = $emptyRecipientPage;
    $recipientRows = [];
    $importRows = [];
    $selectedImportId = 0;
    $selectedImport = null;
    $selectedImportItems = [];
    $sendRuns = [];
    $sendRunSummary = ['run_count' => 0, 'sent_count' => 0, 'failed_count' => 0, 'bounce_count' => 0, 'contacted_contacts' => 0];
    $sendRunItemsByRun = [];
    $scrapingContainers = [];
    $selectedScrapingContainerId = 0;
    $selectedScrapingContainer = null;
    $scrapingJobs = [];
    $activeScrapingJobs = [];
    $scrapingItemsByJob = [];
    $selectedList = null;
    $current = ['id' => 0, 'list_id' => 1, 'name' => '', 'subject' => '', 'body_html' => '<p>Dobry den,</p><p>...</p>', 'daily_limit' => 300, 'batch_limit' => 10, 'auto_daily_limit' => 1, 'include_previously_contacted' => 0, 'schedule_time' => '09:00', 'status' => 'draft'];
    $currentListId = 1;
    $pace = ['limit' => 100, 'reason' => ''];
    $overview = [];

    if ($view === 'overview') {
        $campaigns = campaignRows($pdo);
        $recipients = (int)$pdo->query('
            SELECT COUNT(*)
            FROM recipients r
            JOIN contact_databases cl ON cl.id=r.list_id
            WHERE r.status="active"
              AND COALESCE(r.archived, 0)=0
              AND COALESCE(cl.archived, 0)=0
              AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.email=LOWER(r.email))
        ')->fetchColumn();
        $lists = contactListOptions($pdo);
        $current = $campaigns[0] ?? $current;
        $currentListId = max(1, (int)($current['list_id'] ?? 1));
        $pace = campaignDailyLimit($pdo, $current);
        $overview = overviewStats($pdo, $current, $pace, $config);
    } elseif ($view === 'campaigns') {
        $lists = contactListOptions($pdo);
        backfillCampaignSendRuns($pdo);
        reconcileCampaignSendRunCounts($pdo);
        reconcileCampaignSendRunStatuses($pdo);
        $campaigns = campaignRows($pdo);
        $sendRunSummary = campaignSendRunSummary($pdo);
        $sendRuns = campaignSendRuns($pdo);
        $sendRunItemsByRun = campaignSendRunItemsByRun($pdo, array_map(fn($run) => (int)$run['id'], $sendRuns));
    } elseif ($view === 'contacts') {
        $lists = contactLists($pdo);
        $selectedListId = selectedRequestListId($pdo);
        $recipientPage = $selectedListId > 0 ? recipientPage($pdo, $selectedListId) : $emptyRecipientPage;
        $recipientRows = $recipientPage['rows'];
        $importRows = importRows($pdo, $selectedListId);
        $selectedImportId = max(0, (int)($_GET['import_id'] ?? 0));
        $selectedImport = $selectedImportId > 0 ? findImportRun($pdo, $selectedImportId) : null;
        $selectedImportItems = $selectedImportId > 0 ? importRunItems($pdo, $selectedImportId) : [];
        $selectedList = $selectedListId > 0 ? findContactList($pdo, $selectedListId) : null;
        if ($selectedList) {
            foreach ($lists as $list) {
                if ((int)$list['id'] === $selectedListId) {
                    $selectedList = array_merge($selectedList, $list);
                    break;
                }
            }
        }
    } elseif ($view === 'scraping') {
        reconcileInterruptedScrapingRuns($pdo);
        $lists = contactListOptions($pdo);
        $selectedListId = selectedRequestListId($pdo);
        $scrapingContainers = scrapingContainers($pdo, $selectedListId);
        $selectedScrapingContainerId = max(0, (int)($_GET['container_id'] ?? 0));
        foreach ($scrapingContainers as $container) {
            if ((int)$container['id'] === $selectedScrapingContainerId) {
                $selectedScrapingContainer = $container;
                break;
            }
        }
        if (!$selectedScrapingContainer) {
            $selectedScrapingContainerId = 0;
        }
        $scrapingJobs = scrapingJobs($pdo, $selectedListId, $selectedScrapingContainerId);
        $activeScrapingJobs = activeScrapingJobs($pdo);
        $scrapingItemsByJob = scrapingItemsByJob($pdo, array_map(fn($job) => (int)$job['id'], $scrapingJobs));
    }
    ob_start();
    ?><!doctype html>
<html lang="cs">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Email rozesilac</title>
    <link rel="stylesheet" href="<?= h(assetUrl('assets/app.css')) ?>">
</head>
<body class="view-<?= h($view) ?>">
<header>
    <strong>Email rozesilac</strong>
    <span class="version">Verze <?= h(APP_VERSION) ?></span>
    <a href="?logout=1">Odhlasit</a>
</header>
<nav class="tabs">
    <a class="<?= $view === 'overview' ? 'active' : '' ?>" href="<?= h(routeUrl('overview')) ?>">Prehled</a>
    <a class="<?= $view === 'contacts' ? 'active' : '' ?>" href="<?= h(routeUrl('contacts')) ?>">Kontakty</a>
    <a class="<?= $view === 'campaigns' ? 'active' : '' ?>" href="<?= h(routeUrl('campaigns')) ?>">Kampane</a>
    <a class="<?= $view === 'scraping' ? 'active' : '' ?>" href="<?= h(routeUrl('scraping')) ?>">Scraping</a>
    <a class="<?= $view === 'config' ? 'active' : '' ?>" href="<?= h(routeUrl('config')) ?>">Konfigurace</a>
</nav>
<main>
    <?php renderFlash($flash); ?>

    <?php if ($view === 'overview'): ?>
    <section class="stats">
        <div><span>Kontakty</span><strong><?= $recipients ?></strong></div>
        <div><span>Osloveno</span><strong><a href="<?= h(contactMetricUrl($currentListId, 'contacted')) ?>"><?= h((string)$overview['contacted']) ?></a></strong></div>
        <div><span>Otevreno</span><strong><a href="<?= h(contactMetricUrl($currentListId, 'opened')) ?>"><?= h((string)$overview['opened']) ?></a></strong></div>
        <div><span>Kliknuli</span><strong><a href="<?= h(contactMetricUrl($currentListId, 'clicked')) ?>"><?= h((string)$overview['clicked_contacts']) ?></a></strong></div>
        <div><span>Za 24 h odeslano</span><strong><?= h((string)$overview['sent_today']) ?></strong><small><?= h($config['from_email']) ?></small></div>
        <div><span>Schranka zbyva / 24 h</span><strong><?= h((string)$overview['remaining_today']) ?></strong><small>Limit <?= h((string)$overview['sender_limit_today']) ?><?= $overview['limit_reset_at'] ? ', obnovi se ' . h(formatDateTime((string)$overview['limit_reset_at'])) : ', zatim bez odeslani' ?></small></div>
        <div><span>Odpovedeli</span><strong><a href="<?= h(contactMetricUrl($currentListId, 'replied')) ?>"><?= h((string)$overview['replied_contacts']) ?></a></strong></div>
        <div><span>Open rate</span><strong><?= h($overview['open_rate']) ?> %</strong></div>
        <div><span>Click-through</span><strong><?= h($overview['ctr']) ?> %</strong></div>
    </section>
    <section class="panel">
        <h2>Stav kampane</h2>
        <table><thead><tr><th>Kampan</th><th>Stav</th><th>Databaze</th><th>Planovano</th><th>Osloveno</th><th>Otevreno</th><th>Odpovedeli</th><th>Kliky</th><th>Zbyva kampani 24 h</th></tr></thead><tbody>
            <tr><td><?= h($current['name'] ?: 'Bez kampane') ?></td><td><?= h($current['status'] ?? 'draft') ?></td><td><?= h(listName($lists, (int)($current['list_id'] ?? 1))) ?></td><td><?= h((string)$overview['planned']) ?></td><td><a href="<?= h(contactMetricUrl($currentListId, 'contacted')) ?>"><?= h((string)$overview['campaign_sent']) ?></a></td><td><a href="<?= h(contactMetricUrl($currentListId, 'opened')) ?>"><?= h((string)$overview['campaign_opened']) ?></a></td><td><a href="<?= h(contactMetricUrl($currentListId, 'replied')) ?>"><?= h((string)$overview['campaign_replied']) ?></a></td><td><a href="<?= h(contactMetricUrl($currentListId, 'clicked')) ?>"><?= h((string)$overview['campaign_clicks']) ?></a></td><td><?= h((string)$overview['campaign_remaining_today']) ?> / <?= h((string)$overview['campaign_limit_today']) ?></td></tr>
        </tbody></table>
    </section>
    <?php endif; ?>

    <?php if ($view === 'campaigns'): ?>
    <section class="panel campaign-list-panel">
        <div class="section-header">
            <div>
                <h2>Kampane</h2>
                <p>Prehled pripravenych kampani, jejich planu, limitu a stavu osloveni.</p>
            </div>
            <button type="button" data-dialog-open="new-campaign-dialog">Nova kampan</button>
        </div>
        <table class="campaign-table"><thead><tr><th>Nazev</th><th>Stav</th><th>Databaze</th><th>Plan</th><th>Limit</th><th>Kontakty</th><th>Osloveno</th><th>Odpovedi</th><th>Zbyva</th><th>24 h</th><th>Akce</th></tr></thead><tbody>
        <?php if (!$campaigns): ?>
            <tr><td colspan="11">Zatim neni zalozena zadna kampan.</td></tr>
        <?php endif; ?>
        <?php foreach ($campaigns as $campaign): ?>
            <?php
                $campaignPace = campaignDailyLimit($pdo, $campaign);
                $campaignWindow = campaignRemainingWindowSlots($pdo, $campaign, $campaignPace);
                $campaignTarget = (int)($campaign['target_count'] ?? $campaign['planned_count']);
                $excludedContacts = max(0, (int)$campaign['planned_count'] - $campaignTarget);
                $includePreviously = (int)($campaign['include_previously_contacted'] ?? 0) === 1;
                $limitDialogId = 'campaign-limit-info-' . (int)$campaign['id'];
            ?>
            <tr class="expandable-row" data-detail-target="campaign-detail-<?= h((string)$campaign['id']) ?>" tabindex="0" aria-expanded="false">
                <td><strong><?= h($campaign['name']) ?></strong><br><small><?= h($campaign['subject']) ?></small></td>
                <td><?= statusBadge($campaign['status']) ?></td>
                <td><?= h($campaign['list_name'] ?: listName($lists, (int)$campaign['list_id'])) ?></td>
                <td><?= h($campaign['schedule_time'] ?: '09:00') ?></td>
                <td><?= h((string)$campaignPace['limit']) ?>/24 h</td>
                <td><?= h((string)($campaign['target_count'] ?? $campaign['planned_count'])) ?></td>
                <td><?= h((string)$campaign['sent_count']) ?></td>
                <td><a href="<?= h(contactMetricUrl((int)$campaign['list_id'], 'replied')) ?>"><?= h((string)$campaign['replied_count']) ?></a></td>
                <td><?= h((string)$campaign['remaining_count']) ?></td>
                <td>
                    <?= h((string)$campaignWindow['campaign_sent']) ?>/<?= h((string)$campaignWindow['campaign_limit']) ?>
                    <br><small>kampan zbyva <?= h((string)$campaignWindow['campaign_remaining']) ?></small>
                    <br><small>schranka zbyva <?= h((string)$campaignWindow['sender_remaining']) ?>/<?= h((string)$campaignWindow['sender_limit']) ?></small>
                </td>
                <td>
                    <div class="actions-row">
                        <form method="post" class="inline"><input type="hidden" name="action" value="toggle_campaign_status"><input type="hidden" name="campaign_id" value="<?= h((string)$campaign['id']) ?>"><button><?= $campaign['status'] === 'active' ? 'Pozastavit' : 'Spustit' ?></button></form>
                        <form method="post" class="inline"><input type="hidden" name="action" value="send_batch"><input type="hidden" name="campaign_id" value="<?= h((string)$campaign['id']) ?>"><button>Spustit hned</button></form>
                    </div>
                </td>
            </tr>
            <tr class="detail-row hidden" id="campaign-detail-<?= h((string)$campaign['id']) ?>">
                <td colspan="11">
                    <form method="post" class="campaign-detail-form">
                        <input type="hidden" name="action" value="save_campaign">
                        <input type="hidden" name="id" value="<?= h((string)$campaign['id']) ?>">
                        <input type="hidden" name="body_html" class="body-html" value="<?= h($campaign['body_html']) ?>">
                        <div class="grid two">
                            <label>Databaze kontaktu<select name="list_id"><?php foreach ($lists as $list) echo '<option value="'.h((string)$list['id']).'" '.((int)$campaign['list_id']===(int)$list['id']?'selected':'').'>'.h($list['name']).'</option>'; ?></select></label>
                            <label>Stav<select name="status"><option value="draft" <?= $campaign['status']==='draft'?'selected':'' ?>>Koncept</option><option value="active" <?= $campaign['status']==='active'?'selected':'' ?>>Aktivni</option><option value="paused" <?= $campaign['status']==='paused'?'selected':'' ?>>Pozastaveno</option></select></label>
                            <label>Nazev<input name="name" value="<?= h($campaign['name']) ?>" required></label>
                            <label>Predmet<input name="subject" value="<?= h($campaign['subject']) ?>" required></label>
                            <label>Max za 24 h<input type="number" name="daily_limit" min="1" max="500" value="<?= h((string)$campaign['daily_limit']) ?>"></label>
                            <label>Cas denniho odesilani<input type="time" name="schedule_time" value="<?= h($campaign['schedule_time'] ?: '09:00') ?>"></label>
                        </div>
                        <div class="check-with-info">
                            <label class="check"><input type="checkbox" name="auto_daily_limit" value="1" <?= (int)($campaign['auto_daily_limit'] ?? 1) === 1 ? 'checked' : '' ?>> Automaticky ridit limit za 24 h podle dorucitelnosti</label>
                            <button type="button" class="secondary icon info-icon" data-dialog-open="<?= h($limitDialogId) ?>" aria-label="Vysvetleni limitu a zpusobilych kontaktu" title="Vysvetleni limitu a zpusobilych kontaktu">i</button>
                        </div>
                        <label class="check"><input type="checkbox" name="include_previously_contacted" value="1" <?= (int)($campaign['include_previously_contacted'] ?? 0) === 1 ? 'checked' : '' ?>> Zahrnout kontakty oslovene jinou kampani nebo oznacene jako oslovene pri importu</label>
                        <div class="campaign-metrics">
                            <div><span>Databaze</span><strong><?= h((string)$campaign['planned_count']) ?></strong><small>aktivni dostupne kontakty</small></div>
                            <div><span>Zpusobili</span><strong><?= h((string)$campaignTarget) ?></strong><small>pro tuto kampan</small></div>
                            <div><span>Osloveno</span><strong><?= h((string)$campaign['sent_count']) ?></strong><small>touto kampani</small></div>
                            <div><span>Zbyva</span><strong><?= h((string)$campaign['remaining_count']) ?></strong><small>pred dalsim odeslanim</small></div>
                        </div>
                        <div class="note campaign-limit-note">
                            <strong>Limit pro dalsi beh: <?= h((string)$campaignPace['limit']) ?>/24 h.</strong>
                            Teto kampani zbyva <?= h((string)$campaignWindow['campaign_remaining']) ?> / <?= h((string)$campaignWindow['campaign_limit']) ?>.
                            Odesilaci schrance zbyva <?= h((string)$campaignWindow['sender_remaining']) ?> / <?= h((string)$campaignWindow['sender_limit']) ?><?= $campaignWindow['reset_at'] ? ', dalsi obnova ' . h(formatDateTime((string)$campaignWindow['reset_at'])) : '' ?>.
                            <?= h((string)($campaignPace['conclusion'] ?? '')) ?>
                        </div>
                        <div class="editor-tabs" role="group" aria-label="Rezim editoru">
                            <button type="button" class="active" data-editor-mode="preview">Nahled</button>
                            <button type="button" data-editor-mode="html">HTML</button>
                        </div>
                        <div class="toolbar">
                            <button type="button" data-cmd="bold">B</button>
                            <button type="button" data-cmd="italic">I</button>
                            <button type="button" data-cmd="insertUnorderedList">List</button>
                            <button type="button" data-link>Link</button>
                            <button type="button" data-image-upload>Obrazek</button>
                            <input type="file" class="editor-image-input" accept="image/*" multiple hidden>
                        </div>
                        <div class="editor" contenteditable="true"><?= $campaign['body_html'] ?></div>
                        <textarea class="html-source is-hidden" spellcheck="false" aria-label="HTML telo kampane"><?= h($campaign['body_html']) ?></textarea>
                        <div class="campaign-detail-actions">
                            <button>Ulozit kampan</button>
                        </div>
                    </form>
                    <dialog class="modal info-modal" id="<?= h($limitDialogId) ?>">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h2>Vysvetleni kampane</h2>
                                <button type="button" class="secondary icon" data-dialog-close>Zavrit</button>
                            </div>
                            <section class="info-section">
                                <h3>Kontakty</h3>
                                <dl class="info-grid">
                                    <dt>Cilova databaze</dt>
                                    <dd><?= h((string)$campaign['planned_count']) ?> aktivnich, nearchivovanych kontaktu bez suppression/bounce blokace.</dd>
                                    <dt>Zpusobili pro kampan</dt>
                                    <dd><?= h((string)$campaignTarget) ?> kontaktu. Je to soucet uz oslovenych touto kampani a kontaktu, ktere jeste mohou byt touto kampani osloveny.</dd>
                                    <dt>Vyrazeno</dt>
                                    <dd><?= h((string)$excludedContacts) ?> kontaktu. <?= $includePreviously ? 'Checkbox pro drive oslovene kontakty je zapnuty, proto se nevyrazuji kontakty oslovene jinou kampani ani oznacene jako oslovene pri importu.' : 'Protoze checkbox pro drive oslovene kontakty neni zapnuty, vyrazuji se kontakty oznacene jako uz oslovene pri importu/manualne nebo oslovene libovolnou nasi kampani.' ?></dd>
                                    <dt>Stejna kampan</dt>
                                    <dd>Stejnemu kontaktu se neposle znovu; hlida se kombinace ID kampane a ID kontaktu v logu odeslani.</dd>
                                </dl>
                            </section>
                            <section class="info-section">
                                <h3>Limit za 24 h</h3>
                                <p class="limit-verdict"><?= h((string)($campaignPace['conclusion'] ?? '')) ?></p>
                                <dl class="info-grid">
                                    <dt>Aktualni limit</dt>
                                    <dd>Kampan <?= h((string)$campaignWindow['campaign_remaining']) ?> / <?= h((string)$campaignWindow['campaign_limit']) ?> za 24 h. Odesilaci schranka <?= h((string)$campaignWindow['sender_remaining']) ?> / <?= h((string)$campaignWindow['sender_limit']) ?> za 24 h<?= $campaignWindow['reset_at'] ? ', nejblizsi obnova ' . h(formatDateTime((string)$campaignWindow['reset_at'])) : '' ?>.</dd>
                                    <dt>Posledni 3 dny</dt>
                                    <dd><?= h((string)$campaignPace['recent_sent']) ?> odeslano, <?= h((string)$campaignPace['recent_failed']) ?> netechnickych chyb, <?= h((string)$campaignPace['recent_bounced']) ?> bounce, <?= h((string)$campaignPace['recent_replied']) ?> odpovedi.</dd>
                                    <dt>Zdrave dny</dt>
                                    <dd><?= h((string)$campaignPace['healthy_days']) ?> zdravych odesilacich dni, tedy <?= h((string)($campaignPace['healthy_milestones'] ?? 0)) ?> splnenych bloku po 3 dnech.</dd>
                                    <dt>Rustovy vypocet</dt>
                                    <dd><?= h((string)($campaignPace['growth_limit'] ?? $campaignPace['limit'])) ?>/24 h pred uplatnenim rucniho maxima kampane <?= h((string)($campaignPace['manual_limit'] ?? $campaign['daily_limit'])) ?>/24 h a technickeho stropu 250.</dd>
                                </dl>
                                <p class="info-footnote">Zdravy den ma alespon 20 odeslanych, netechnicke chyby pod 3 % a bounce pod 2 %. Bounce 2 % nebo vyssi drzi limit max. 100; netechnicke chyby 5 % nebo vyssi drzi max. 100; 10 % nebo vyssi limit puli. Technicke SMTP/auth chyby se do chybovosti nepocitaji. Odhlaseni se nevyhodnocuje, protoze aplikace do obchodnich sdeleni nevklada odhlasovaci link.</p>
                            </section>
                        </div>
                    </dialog>
                    <div class="campaign-tools">
                        <form method="post" class="campaign-test-form">
                            <input type="hidden" name="action" value="test_send">
                            <input type="hidden" name="campaign_id" value="<?= h((string)$campaign['id']) ?>">
                            <input type="email" name="test_email" placeholder="test@email.cz" required>
                            <button>Odeslat test</button>
                        </form>
                        <form method="post" class="campaign-run-form"><input type="hidden" name="action" value="send_batch"><input type="hidden" name="campaign_id" value="<?= h((string)$campaign['id']) ?>"><button>Spustit hned</button></form>
                    </div>
                </td>
            </tr>
        <?php endforeach; ?>
        </tbody></table>
    </section>
    <dialog class="modal" id="new-campaign-dialog">
        <form method="post" class="create-campaign-form">
            <input type="hidden" name="action" value="save_campaign">
            <input type="hidden" name="id" value="0">
            <input type="hidden" name="body_html" value="<?= h('<p>Dobry den,</p><p>...</p>') ?>">
            <input type="hidden" name="daily_limit" value="100">
            <input type="hidden" name="schedule_time" value="09:00">
            <input type="hidden" name="auto_daily_limit" value="1">
            <input type="hidden" name="status" value="draft">
            <div class="modal-header">
                <h2>Nova kampan</h2>
                <button type="button" class="secondary icon" data-dialog-close>Zavrit</button>
            </div>
            <label>Nazev<input name="name" placeholder="Napriklad masaze Praha - prvni osloveni" required></label>
            <label>Predmet<input name="subject" placeholder="Predmet emailu" required></label>
            <label>Databaze<select name="list_id"><?php foreach ($lists as $list) echo '<option value="'.h((string)$list['id']).'">'.h($list['name']).'</option>'; ?></select></label>
            <div class="modal-actions">
                <button>Vytvorit koncept</button>
            </div>
        </form>
    </dialog>
    <section class="panel">
        <h2>Posledni odeslani</h2>
        <div class="table-summary">
            Souhrn vsech behu: <?= h((string)$sendRunSummary['run_count']) ?> behu,
            <?= h((string)$sendRunSummary['sent_count']) ?> odeslanych emailu,
            <?= h((string)$sendRunSummary['failed_count']) ?> chyb,
            <?= h((string)$sendRunSummary['bounce_count']) ?> bounce,
            <?= h((string)$sendRunSummary['contacted_contacts']) ?> unikatnich oslovenych kontaktu.
            Tabulka nize zobrazuje poslednich 50 behu; soucet viditelnych radku proto nemusi odpovidat celkovemu souhrnu.
        </div>
        <table class="send-runs-table"><thead><tr><th>Detail</th><th>Spusteno</th><th>Kampan</th><th>Typ</th><th>Stav</th><th>Vybrano</th><th>Odeslano</th><th>Chyby</th><th>Bounce</th><th>Dalsi pokus</th><th>Dokonceno</th><th>Zprava</th></tr></thead><tbody>
        <?php foreach ($sendRuns as $run): ?>
            <?php $runItems = $sendRunItemsByRun[(int)$run['id']] ?? []; ?>
            <tr class="<?= $runItems ? 'expandable-row' : '' ?>" <?php if ($runItems): ?>data-detail-target="send-run-detail-<?= h((string)$run['id']) ?>" tabindex="0" aria-expanded="false"<?php endif; ?>>
                <td></td>
                <td><?= h(formatDateTime((string)($run['started_at'] ?: $run['created_at']))) ?></td>
                <td><?= h($run['campaign'] ?: '-') ?></td>
                <td><?= statusBadge(sendRunTypeLabel($run)) ?></td>
                <td><?= statusBadge(sendRunStatusLabel($run)) ?></td>
                <td><?= h((string)$run['planned_count']) ?></td>
                <td><?= h((string)$run['sent_count']) ?></td>
                <td><?= h((string)$run['failed_count']) ?></td>
                <td><?= h((string)($run['bounce_count'] ?? 0)) ?></td>
                <td><?= h((string)($run['next_send_after'] ? formatDateTime((string)$run['next_send_after']) : '-')) ?></td>
                <td><?= h(formatDateTime((string)$run['finished_at'])) ?></td>
                <td><?= h((string)$run['message']) ?></td>
            </tr>
            <?php if ($runItems): ?>
            <tr class="detail-row hidden" id="send-run-detail-<?= h((string)$run['id']) ?>">
                <td colspan="12">
                    <?php
                        $openedInRun = count(array_filter($runItems, fn($item) => (string)($item['opened_at'] ?? '') !== ''));
                        $clickedInRun = count(array_filter($runItems, fn($item) => (int)($item['click_count'] ?? 0) > 0));
                        $repliedInRun = count(array_filter($runItems, fn($item) => (string)($item['replied_at'] ?? '') !== ''));
                        $bouncedInRun = count(array_filter($runItems, fn($item) => stripos((string)($item['message'] ?? ''), 'Bounce:') === 0 || (int)($item['bounce_count'] ?? 0) > 0));
                    ?>
                    <div class="table-summary"><?= h((string)count($runItems)) ?> kontaktu v tomto behu rozesilky, <?= h((string)$openedInRun) ?> otevreno, <?= h((string)$clickedInRun) ?> kliknulo, <?= h((string)$repliedInRun) ?> odpovedelo, <?= h((string)$bouncedInRun) ?> bounce.</div>
                    <table class="send-run-items-table"><thead><tr><th>Kdy</th><th>Email</th><th>Kontakt</th><th>Stav</th><th>Otevrel</th><th>Kliknul</th><th>Odpovedel</th><th>Bounce</th><th>Zprava</th></tr></thead><tbody>
                    <?php foreach ($runItems as $item): ?>
                        <tr>
                            <td><?= h(formatDateTime((string)$item['sent_at'])) ?></td>
                            <td><?php if ((int)($run['list_id'] ?? 0) > 0): ?><a href="<?= h(contactPageUrl((int)$run['list_id'], ['q' => (string)$item['email']])) ?>"><?= h($item['email']) ?></a><?php else: ?><?= h($item['email']) ?><?php endif; ?></td>
                            <td><?= h($item['subject_name'] ?: '-') ?></td>
                            <td><?= statusBadge((string)$item['status']) ?></td>
                            <td><?= statusBadge((string)($item['opened_at'] ?? '') !== '' ? 'ano' : 'ne') ?></td>
                            <td><?= statusBadge((int)($item['click_count'] ?? 0) > 0 ? ((string)(int)$item['click_count'] . 'x') : 'ne') ?></td>
                            <td><?= statusBadge((string)($item['replied_at'] ?? '') !== '' ? 'ano' : 'ne') ?></td>
                            <td><?= statusBadge((stripos((string)($item['message'] ?? ''), 'Bounce:') === 0 || (int)($item['bounce_count'] ?? 0) > 0) ? 'ano' : 'ne') ?></td>
                            <td><?= h((string)$item['message']) ?></td>
                        </tr>
                    <?php endforeach; ?>
                    </tbody></table>
                </td>
            </tr>
            <?php endif; ?>
        <?php endforeach; ?>
        </tbody></table>
    </section>
    <?php endif; ?>

    <?php if ($view === 'contacts'): ?>
    <?php if (!$selectedList): ?>
    <section class="panel database-list-panel">
        <div class="section-header">
            <div>
                <h2>Databaze kontaktu</h2>
                <p>Kliknutim na radek otevres konkretni databazi kontaktu.</p>
            </div>
            <button type="button" data-dialog-open="new-database-dialog">Nova databaze</button>
        </div>
        <table class="database-table"><thead><tr><th>Databaze</th><th>Kontakty</th><th>Osloveno</th><th>K osloveni</th><th>Akce</th></tr></thead><tbody>
        <?php foreach ($lists as $list): ?>
            <tr class="link-row" data-href="<?= h(contactDatabaseUrl((int)$list['id'])) ?>" tabindex="0">
                <td><strong><?= h($list['name']) ?></strong></td>
                <td><?= h((string)$list['contacts']) ?></td>
                <td><?= h((string)($list['contacted_contacts'] ?? 0)) ?></td>
                <td><?= h((string)($list['uncontacted_contacts'] ?? 0)) ?></td>
                <td>
                    <form method="post" class="inline" onsubmit="return confirm(<?= h(json_encode('Archivovat databazi ' . $list['name'] . '? V aplikaci se skryje vcetne navazanych kontaktu.', JSON_UNESCAPED_UNICODE)) ?>);">
                        <input type="hidden" name="action" value="archive_contact_database">
                        <input type="hidden" name="database_id" value="<?= h((string)$list['id']) ?>">
                        <button type="submit" class="secondary">Archivovat</button>
                    </form>
                </td>
            </tr>
        <?php endforeach; ?>
        </tbody></table>
    </section>
    <dialog class="modal" id="new-database-dialog">
        <form method="post">
            <input type="hidden" name="action" value="create_contact_database">
            <div class="modal-header">
                <h2>Nova databaze kontaktu</h2>
                <button type="button" class="secondary icon" data-dialog-close>Zavrit</button>
            </div>
            <label>Nazev databaze<input name="database_name" placeholder="Napriklad masaze Praha" required></label>
            <div class="modal-actions">
                <button>Vytvorit databazi</button>
            </div>
        </form>
    </dialog>
    <?php else: ?>
    <?php if ($selectedImport): ?>
    <section class="panel">
        <div class="section-header">
            <div>
                <p><a href="<?= h(contactDatabaseUrl($selectedListId)) ?>">Zpet na databazi</a></p>
                <h2>Detail importu #<?= h((string)$selectedImport['id']) ?></h2>
                <p><?= h($selectedImport['file_name']) ?>, <?= h(formatDateTime((string)$selectedImport['created_at'])) ?>.</p>
            </div>
            <?= statusBadge(importRunStatusLabel($selectedImport)) ?>
        </div>
        <div class="note">
            <?= h(importRunMessage($selectedImport)) ?>
            <?php if (!$selectedImportItems): ?>Pro tento import zatim nejsou ulozene radkove detaily.<?php endif; ?>
        </div>
        <?php $importGroups = importItemGroups($selectedImportItems); ?>
        <div class="scraping-result-grid">
            <?php foreach ($importGroups as $group): ?>
                <section class="scraping-result-group is-collapsed <?= h($group['class']) ?>">
                    <h3 tabindex="0" role="button" aria-expanded="false"><?= h($group['label']) ?> <span><?= h((string)count($group['items'])) ?></span></h3>
                    <div class="scraping-result-list">
                        <?php foreach ($group['items'] as $item): ?>
                            <?php $sourceUrl = importItemSourceUrl($item); ?>
                            <article class="scraping-result-item">
                                <div class="scraping-result-title">
                                    <strong><?= h($item['subject_name'] ?: $item['email'] ?: ('Radek ' . $item['row_num'])) ?></strong>
                                    <?= statusBadge(importResultLabel((string)$item['result'])) ?>
                                </div>
                                <div class="scraping-result-meta">
                                    <?php if ($item['email'] !== ''): ?><span><?= h($item['email']) ?></span><?php endif; ?>
                                    <?php if ($item['address'] !== ''): ?><span><?= h($item['address']) ?></span><?php endif; ?>
                                    <?php if ($item['website'] !== ''): ?><a href="<?= h($item['website']) ?>" target="_blank" rel="noopener"><?= h($item['website']) ?></a><?php endif; ?>
                                </div>
                                <?php if ($sourceUrl !== ''): ?><div class="scraping-source-url"><span>Zdrojova URL</span><a href="<?= h($sourceUrl) ?>" target="_blank" rel="noopener"><?= h($sourceUrl) ?></a></div><?php endif; ?>
                                <?php if ($item['result'] !== 'inserted'): ?><p><?= h($item['reason']) ?></p><?php endif; ?>
                            </article>
                        <?php endforeach; ?>
                    </div>
                </section>
            <?php endforeach; ?>
        </div>
    </section>
    <?php else: ?>
    <section class="panel">
        <div class="section-header database-detail-header">
            <div>
                <p><a href="<?= h(routeUrl('contacts')) ?>">Zpet na databaze kontaktu</a></p>
                <h2><?= h($selectedList['name']) ?></h2>
                <p>Celkem <?= h((string)($selectedList['contacts'] ?? $recipientPage['total'])) ?> kontaktu, osloveno <?= h((string)($selectedList['contacted_contacts'] ?? 0)) ?>, k osloveni <?= h((string)($selectedList['uncontacted_contacts'] ?? 0)) ?>.</p>
            </div>
            <div class="actions-row">
                <button type="button" data-dialog-open="import-contacts-dialog">Importovat kontakty</button>
                <button type="button" class="secondary" data-dialog-open="manual-contact-dialog">Rucne vlozit kontakt</button>
            </div>
        </div>
        <dialog class="modal" id="import-contacts-dialog">
            <form method="post" enctype="multipart/form-data">
                <input type="hidden" name="action" value="import_recipients">
                <input type="hidden" name="database_id" value="<?= h((string)$selectedListId) ?>">
                <div class="modal-header">
                    <h2>Import kontaktu</h2>
                    <button type="button" class="secondary icon" data-dialog-close>Zavrit</button>
                </div>
                <p>Soubor se nahraje a import pobezi na pozadi. Prubeh uvidis v historii importu.</p>
                <div class="note">
                    <strong>Poradi bez hlavicky:</strong> 1. email, 2. nazev subjektu, 3. webovka, 4. adresa, 5. osloveno.
                    <br><strong>Volitelny sloupec s hlavickou:</strong> osloveno / osloven / contacted / sent. Hodnoty ano, true, 1, yes nebo sent oznaci kontakt jako uz osloveny.
                    <br><strong>Podporovane hlavicky:</strong> email/e-mail/mail, nazev/subjekt/firma/centrum/studio, website/web/url/www/webovka, address/adresa/ulice/sidlo, osloveno/contacted/sent.
                </div>
                <input type="file" name="csv" accept=".csv,text/csv" required>
                <div class="modal-actions">
                    <button>Nahrat a spustit import</button>
                </div>
            </form>
        </dialog>
        <dialog class="modal" id="manual-contact-dialog">
            <form method="post">
                <input type="hidden" name="action" value="add_manual_contact">
                <input type="hidden" name="database_id" value="<?= h((string)$selectedListId) ?>">
                <div class="modal-header">
                    <h2>Rucni vlozeni kontaktu</h2>
                    <button type="button" class="secondary icon" data-dialog-close>Zavrit</button>
                </div>
                <label>Email<input type="email" name="email" required></label>
                <label>Nazev subjektu<input name="subject_name"></label>
                <label>Web<input name="website" placeholder="https://"></label>
                <label>Adresa<input name="address"></label>
                <label class="check"><input type="checkbox" name="contacted_before" value="1"> Kontakt uz byl drive osloven</label>
                <div class="modal-actions">
                    <button>Ulozit kontakt</button>
                </div>
            </form>
        </dialog>
    </section>
    <section class="panel">
        <h2>Historie importu</h2>
        <table class="import-history"><thead><tr><th>Kdy</th><th>Stav</th><th>Soubor</th><th>Radku</th><th>Vlozeno</th><th>Aktualizovano</th><th>Preskoceno</th><th>Detail</th></tr></thead><tbody>
        <?php foreach ($importRows as $import): ?><tr><td><?= h(formatDateTime((string)$import['created_at'])) ?></td><td><?= statusBadge(importRunStatusLabel($import)) ?></td><td><?= h($import['file_name']) ?></td><td><?= h((string)$import['total_rows']) ?></td><td><?= h((string)$import['inserted_count']) ?></td><td><?= h((string)$import['updated_count']) ?></td><td><?= h((string)$import['skipped_count']) ?></td><td><a class="button small" href="<?= h(contactDatabaseUrl($selectedListId) . '&import_id=' . (int)$import['id']) ?>">Zobrazit</a></td></tr><?php endforeach; ?>
        </tbody></table>
    </section>
    <section class="panel">
        <h2>Kontakty</h2>
        <div class="note">
            Osloven znamena, ze kontakt byl uz alespon jednou zahrnuty do nasi odeslane kampane, nebo byl takto oznacen pri importu.
        </div>
        <form class="contact-search" method="get">
            <input type="hidden" name="route" value="contacts">
            <input type="hidden" name="database_id" value="<?= h((string)$selectedListId) ?>">
            <input type="hidden" name="sort" value="<?= h((string)$recipientPage['sort']) ?>">
            <input type="hidden" name="dir" value="<?= h((string)$recipientPage['dir']) ?>">
            <input type="hidden" name="metric" value="<?= h((string)$recipientPage['metric']) ?>">
            <label>Hledat v kontaktech<input name="q" value="<?= h((string)$recipientPage['q']) ?>" placeholder="Email, nazev, web, adresa nebo zdroj" data-contact-search></label>
        </form>
        <div class="contacts-table-wrap" data-contacts-results>
            <?php if (($recipientPage['metric'] ?? '') !== ''): ?>
                <div class="filter-note">Filtr: <?= h(contactMetricLabel((string)$recipientPage['metric'])) ?> <a href="<?= h(contactPageUrl($selectedListId, ['q' => $recipientPage['q'] ?? ''])) ?>">Zrusit filtr</a></div>
            <?php endif; ?>
            <div class="table-summary">
                Zobrazeno <?= h((string)count($recipientRows)) ?> z <?= h((string)$recipientPage['total']) ?> kontaktu.
            </div>
            <div class="table-scroll-top" data-table-scroll-top><div></div></div>
            <div class="table-scroll-main" data-table-scroll-main>
                <table class="contacts-table no-client-sort">
                    <thead><tr>
                        <th>#</th>
                        <th><?= contactSortHeader($selectedListId, $recipientPage, 'email', 'Email') ?></th>
                        <th><?= contactSortHeader($selectedListId, $recipientPage, 'subject', 'Subjekt') ?></th>
                        <th><?= contactSortHeader($selectedListId, $recipientPage, 'contacted', 'Osloven') ?></th>
                        <th><?= contactSortHeader($selectedListId, $recipientPage, 'replied', 'Odpovedel') ?></th>
                        <th><?= contactSortHeader($selectedListId, $recipientPage, 'bounce', 'Bounce') ?></th>
                        <th>Akce</th>
                        <th><?= contactSortHeader($selectedListId, $recipientPage, 'source', 'Zdroj') ?></th>
                        <th><?= contactSortHeader($selectedListId, $recipientPage, 'address', 'Adresa') ?></th>
                        <th><?= contactSortHeader($selectedListId, $recipientPage, 'created_at', 'Pridano') ?></th>
                        <th><?= contactSortHeader($selectedListId, $recipientPage, 'updated_at', 'Modifikovano') ?></th>
                    </tr></thead>
                    <tbody>
                    <?php foreach ($recipientRows as $index => $row): ?>
                        <tr>
                            <td><?= h((string)(((int)$recipientPage['page'] - 1) * (int)$recipientPage['per_page'] + $index + 1)) ?></td>
                            <td><?= h($row['email']) ?></td>
                            <td>
                                <?php if ($row['website']): ?>
                                    <a class="business-link" href="<?= h($row['website']) ?>" target="_blank" rel="noopener"><?= h($row['subject_name'] ?: websiteLabel($row['website'])) ?></a>
                                <?php else: ?>
                                    <strong><?= h($row['subject_name'] ?: '-') ?></strong>
                                <?php endif; ?>
                            </td>
                            <td><?= statusBadge(((int)$row['contacted_before'] > 0 || (int)$row['sent_count'] > 0) ? 'ano' : 'ne') ?></td>
                            <td><?= statusBadge((int)($row['replied_count'] ?? 0) > 0 ? 'ano' : 'ne') ?></td>
                            <td><?= statusBadge((int)($row['bounce_count'] ?? 0) > 0 ? 'ano' : 'ne') ?></td>
                            <td>
                                <form method="post" class="inline" onsubmit="return confirm('Opravdu odstranit kontakt <?= h($row['email']) ?>?');">
                                    <input type="hidden" name="action" value="delete_contact">
                                    <input type="hidden" name="database_id" value="<?= h((string)$selectedListId) ?>">
                                    <input type="hidden" name="email" value="<?= h($row['email']) ?>">
                                    <button class="danger" type="submit">Odstranit</button>
                                </form>
                            </td>
                            <td>
                                <?php if (!empty($row['source_url'])): ?>
                                    <a href="<?= h($row['source_url']) ?>" target="_blank" rel="noopener"><?= h($row['source_label'] ?: 'Zdrojova URL') ?></a>
                                <?php else: ?>
                                    <?= h($row['source_label'] ?: '-') ?>
                                <?php endif; ?>
                            </td>
                            <td><?= h($row['address'] ?? '') ?></td>
                            <td><?= h(formatDateTime((string)$row['created_at'])) ?></td>
                            <td><?= h(formatDateTime((string)$row['updated_at'])) ?></td>
                        </tr>
                    <?php endforeach; ?>
                    </tbody>
                </table>
            </div>
            <?php if ((int)$recipientPage['pages'] > 1): ?>
                <nav class="pagination" aria-label="Strankovani kontaktu">
                    <?php if ((int)$recipientPage['page'] > 1): ?><a class="button small secondary" href="<?= h(contactPaginationUrl($selectedListId, $recipientPage, (int)$recipientPage['page'] - 1)) ?>">Predchozi</a><?php endif; ?>
                    <span>Strana <?= h((string)$recipientPage['page']) ?> / <?= h((string)$recipientPage['pages']) ?></span>
                    <?php if ((int)$recipientPage['page'] < (int)$recipientPage['pages']): ?><a class="button small secondary" href="<?= h(contactPaginationUrl($selectedListId, $recipientPage, (int)$recipientPage['page'] + 1)) ?>">Dalsi</a><?php endif; ?>
                </nav>
            <?php endif; ?>
        </div>
    </section>
    <?php endif; ?>
    <?php endif; ?>
    <?php endif; ?>

    <?php if ($view === 'scraping'): ?>
    <section class="panel">
        <div class="section-header">
            <div>
                <h2>Aktivni scraping behy</h2>
                <p>Prehled behu, ktere prave bezi nebo cekaji ve fronte napric vsemi scraping kontejnery.</p>
            </div>
        </div>
        <table class="active-jobs-table"><thead><tr><th>ID</th><th>Zdroj</th><th>Klicove slovo</th><th>Databaze</th><th>Stav</th><th>Spusteno</th><th>Zprac.</th><th>Vlozeno</th><th>Aktualiz.</th><th>Presk.</th><th>Vysledek</th><th>Akce</th></tr></thead><tbody>
        <?php if (!$activeScrapingJobs): ?>
            <tr><td colspan="12">Ted nebezi ani neceka zadny scraping beh.</td></tr>
        <?php endif; ?>
        <?php foreach ($activeScrapingJobs as $job): ?>
            <tr class="link-row" data-href="<?= h(routeUrl('scraping') . '&container_id=' . (int)$job['container_id']) ?>" tabindex="0">
                <td><?= h((string)$job['id']) ?></td>
                <td><?= h(scrapingSources()[$job['display_source']] ?? $job['display_source']) ?></td>
                <td><?= h($job['display_keyword']) ?></td>
                <td><?= h($job['list_name'] ?: 'Vychozi seznam') ?></td>
                <td><?= statusBadge(scrapingStatusLabel((string)$job['status'], 'job')) ?></td>
                <td><?= h(formatDateTime((string)($job['started_at'] ?: $job['created_at']))) ?></td>
                <td><?= h((string)$job['processed_count']) ?></td>
                <td><?= h((string)$job['inserted_count']) ?></td>
                <td><?= h((string)$job['updated_count']) ?></td>
                <td><?= h((string)$job['skipped_count']) ?></td>
                <td><?= h(scrapingJobLogMessage($job)) ?></td>
                <td class="actions-cell">
                    <form method="post" class="inline">
                        <input type="hidden" name="job_id" value="<?= h((string)$job['id']) ?>">
                        <input type="hidden" name="container_id" value="<?= h((string)$job['container_id']) ?>">
                        <button type="submit" name="action" value="cancel_scraping_job" class="secondary">Prerusit</button>
                    </form>
                </td>
            </tr>
        <?php endforeach; ?>
        </tbody></table>
    </section>
    <section class="panel">
        <div class="section-header">
            <div>
                <h2>Scraping kontejnery</h2>
                <p>Kazdy kontejner drzi zdroj, klicove slovo a cilovou databazi. Kliknutim na radek otevres logy konkretniho kontejneru.</p>
            </div>
            <button type="button" data-dialog-open="new-scraping-dialog">Novy scraping</button>
        </div>
        <table class="container-table"><thead><tr><th>ID</th><th>Zdroj</th><th>Klicove slovo</th><th>Databaze</th><th>Spusteni</th><th>Posledni beh</th><th>Vlozeno</th><th>Aktualizovano</th><th>Akce</th></tr></thead><tbody>
        <?php if (!$scrapingContainers): ?>
            <tr><td colspan="9">Zatim neni zalozeny zadny scraping kontejner.</td></tr>
        <?php endif; ?>
        <?php foreach ($scrapingContainers as $container): ?>
            <tr class="link-row" data-href="<?= h(routeUrl('scraping') . '&container_id=' . (int)$container['id']) ?>" tabindex="0">
                <td><?= h((string)$container['id']) ?></td>
                <td><?= h(scrapingSources()[$container['source']] ?? $container['source']) ?></td>
                <td><?= h($container['keyword']) ?></td>
                <td><?= h($container['list_name'] ?: 'Vychozi seznam') ?></td>
                <td>
                    <div class="schedule-status">
                        <?= statusBadge((int)($container['schedule_enabled'] ?? 0) === 1 ? 'Active' : 'Paused') ?>
                        <span class="schedule-time"><?= h(scrapingScheduleLabel($container)) ?></span>
                        <button type="button" class="secondary icon schedule-edit" data-dialog-open="scraping-settings-<?= h((string)$container['id']) ?>" aria-label="Upravit plan" title="Upravit plan">&#9998;</button>
                    </div>
                    <small>
                        <?php if ((int)($container['schedule_enabled'] ?? 0) === 1): ?>
                            <?= $container['last_scheduled_at'] ? 'Naposledy: ' . h(formatDateTime((string)$container['last_scheduled_at'])) : 'Plan zapnut, zatim nespusten' ?>
                        <?php else: ?>
                            Plan pozastaven
                        <?php endif; ?>
                    </small>
                </td>
                <td><?= $container['last_run_at'] ? h(formatDateTime((string)$container['last_run_at'])) : '-' ?></td>
                <td><?= h((string)$container['total_inserted']) ?></td>
                <td><?= h((string)$container['total_updated']) ?></td>
                <td class="actions-cell">
                    <div class="actions-row">
                        <form method="post" class="inline"><input type="hidden" name="container_id" value="<?= h((string)$container['id']) ?>"><button name="action" value="toggle_scraping_schedule"><?= (int)($container['schedule_enabled'] ?? 0) === 1 ? 'Pozastavit plan' : 'Aktivovat plan' ?></button></form>
                        <form method="post" class="inline"><input type="hidden" name="container_id" value="<?= h((string)$container['id']) ?>"><button name="action" value="run_scraping_container_once">Spustit ted</button></form>
                        <form method="post" class="inline"><input type="hidden" name="container_id" value="<?= h((string)$container['id']) ?>"><button name="action" value="delete_scraping_container">Odstranit</button></form>
                    </div>
                    <dialog class="modal" id="scraping-settings-<?= h((string)$container['id']) ?>">
                        <form method="post">
                            <input type="hidden" name="action" value="save_scraping_schedule">
                            <input type="hidden" name="container_id" value="<?= h((string)$container['id']) ?>">
                            <div class="modal-header">
                                <h2>Plan scrapingu</h2>
                                <button type="button" class="secondary icon" data-dialog-close>Zavrit</button>
                            </div>
                            <p><?= h(scrapingSources()[$container['source']] ?? $container['source']) ?> / <?= h($container['keyword']) ?> / <?= h($container['list_name'] ?: 'Vychozi seznam') ?></p>
                            <label>Frekvence
                                <select name="schedule_frequency">
                                    <option value="daily" <?= scrapingScheduleFrequency($container) === 'daily' ? 'selected' : '' ?>>Denne</option>
                                    <option value="weekly" <?= scrapingScheduleFrequency($container) === 'weekly' ? 'selected' : '' ?>>Jednou tydne</option>
                                </select>
                            </label>
                            <label>Den v tydnu
                                <select name="schedule_weekday">
                                    <?php foreach (scrapingWeekdays() as $dayNumber => $dayLabel): ?>
                                        <option value="<?= h((string)$dayNumber) ?>" <?= scrapingScheduleWeekday($container) === $dayNumber ? 'selected' : '' ?>><?= h(ucfirst($dayLabel)) ?></option>
                                    <?php endforeach; ?>
                                </select>
                            </label>
                            <label>Cas spusteni<input type="time" name="schedule_time" value="<?= h($container['schedule_time'] ?: '09:00') ?>"></label>
                            <div class="modal-actions">
                                <button>Ulozit plan</button>
                            </div>
                        </form>
                    </dialog>
                </td>
            </tr>
        <?php endforeach; ?>
        </tbody></table>
    </section>
    <dialog class="modal" id="new-scraping-dialog">
        <form method="post">
            <input type="hidden" name="action" value="create_scraping_job">
            <div class="modal-header">
                <h2>Novy scraping kontejner</h2>
                <button type="button" class="secondary icon" data-dialog-close>Zavrit</button>
            </div>
            <label>Zdroj dat
                <select name="source">
                    <?php foreach (scrapingSources() as $key => $label): ?><option value="<?= h($key) ?>"><?= h($label) ?></option><?php endforeach; ?>
                </select>
            </label>
            <label>Klicove slovo<input name="keyword" placeholder="Napriklad: masaze, massage, Massagen, masaz" required></label>
            <label>Cilova databaze kontaktu<select name="list_id"><?php foreach ($lists as $list) echo '<option value="'.h((string)$list['id']).'" '.($selectedListId===(int)$list['id']?'selected':'').'>'.h($list['name']).'</option>'; ?></select></label>
            <div class="note">Backend prochazi stranky vysledku postupne, dokud zdroj vraci dalsi zaznamy. Podporovane jsou Firmy.cz, Herold.at, Zoznam.sk, DasTelefonbuch.de, DasOertliche.de, GelbeSeiten.de, Pkt.pl, PanoramaFirm.pl, MerchantCircle a YellowPages.ca. Z nalezenych detailu pak hleda email, nazev, web a adresu.</div>
            <div class="modal-actions">
                <button>Vytvorit kontejner</button>
            </div>
        </form>
    </dialog>
    <?php if ($selectedScrapingContainer): ?>
    <section class="panel">
        <div class="section-header">
            <div>
                <h2>Log scraping behu</h2>
                <p><?= h((scrapingSources()[$selectedScrapingContainer['source']] ?? $selectedScrapingContainer['source']) . ' / ' . $selectedScrapingContainer['keyword'] . ' / ' . ($selectedScrapingContainer['list_name'] ?: 'Vychozi seznam')) ?></p>
            </div>
            <a class="button small secondary" href="<?= h(routeUrl('scraping')) ?>">Zpet na vsechny kontejnery</a>
        </div>
        <table class="log-table"><thead><tr><th>ID</th><th>Typ</th><th>Stav</th><th>Spusteno</th><th>Dokonceno</th><th>Zprac.</th><th>Vlozeno</th><th>Aktualiz.</th><th>Presk.</th><th>Vysledek</th><th>Akce</th></tr></thead><tbody>
        <?php if (!$scrapingJobs): ?>
            <tr><td colspan="11">Tento kontejner zatim nema zadny beh.</td></tr>
        <?php endif; ?>
        <?php foreach ($scrapingJobs as $job): ?>
            <?php $jobItems = $scrapingItemsByJob[(int)$job['id']] ?? []; ?>
            <?php $jobGroups = scrapingItemGroups($jobItems); ?>
            <?php $jobDisplayCounts = scrapingGroupCounts($jobGroups); ?>
            <tr class="<?= $jobItems ? 'expandable-row' : '' ?>" <?php if ($jobItems): ?>data-detail-target="scraping-detail-<?= h((string)$job['id']) ?>" tabindex="0" aria-expanded="false"<?php endif; ?>>
                <td><?= h((string)$job['id']) ?></td>
                <td><?= statusBadge(scrapingRunTypeLabel($job)) ?></td>
                <td><?= statusBadge(scrapingStatusLabel((string)$job['status'], 'job')) ?></td>
                <td><?= h(formatDateTime((string)($job['started_at'] ?: $job['created_at']))) ?></td>
                <td><?= h($job['finished_at'] ? formatDateTime((string)$job['finished_at']) : '-') ?></td>
                <td><?= h((string)$jobDisplayCounts['processed']) ?></td>
                <td><?= h((string)$jobDisplayCounts['inserted']) ?></td>
                <td><?= h((string)$jobDisplayCounts['updated']) ?></td>
                <td><?= h((string)$jobDisplayCounts['skipped']) ?></td>
                <td><?= h(scrapingJobLogMessage($job)) ?></td>
                <td class="actions-cell">
                    <?php if (in_array((string)$job['status'], ['queued', 'running', 'paused'], true)): ?>
                        <form method="post" class="inline">
                            <input type="hidden" name="job_id" value="<?= h((string)$job['id']) ?>">
                            <input type="hidden" name="container_id" value="<?= h((string)$selectedScrapingContainerId) ?>">
                            <button type="submit" name="action" value="cancel_scraping_job" class="secondary">Prerusit</button>
                        </form>
                    <?php else: ?>
                        -
                    <?php endif; ?>
                </td>
            </tr>
            <?php if ($jobItems): ?>
            <tr class="detail-row hidden" id="scraping-detail-<?= h((string)$job['id']) ?>">
                <td colspan="11">
                    <div class="scraping-detail">
                        <div class="scraping-detail-head">
                            <strong>Detail behu #<?= h((string)$job['id']) ?></strong>
                            <span><?= h((string)$jobDisplayCounts['processed']) ?> zpracovano, <?= h((string)$jobDisplayCounts['inserted']) ?> vlozeno, <?= h((string)$jobDisplayCounts['updated']) ?> aktualizovano</span>
                        </div>
                        <div class="scraping-result-grid">
                            <?php foreach ($jobGroups as $group): ?>
                                <?php if (!$group['items']) continue; ?>
                                <section class="scraping-result-group is-collapsed <?= h($group['class']) ?>">
                                    <h3 tabindex="0" role="button" aria-expanded="false"><?= h($group['label']) ?> <span><?= h((string)count($group['items'])) ?></span></h3>
                                    <div class="scraping-result-list">
                                        <?php foreach ($group['items'] as $item): ?>
                                            <article class="scraping-result-item">
                                                <div class="scraping-result-title">
                                                    <strong><?= h(scrapingItemTitle($item)) ?></strong>
                                                    <?= statusBadge(scrapingStatusLabel((string)$item['status'], 'item')) ?>
                                                </div>
                                                <div class="scraping-result-meta">
                                                    <?php if ($item['email'] !== ''): ?><span><?= h($item['email']) ?></span><?php endif; ?>
                                                    <?php if ($item['address'] !== ''): ?><span><?= h($item['address']) ?></span><?php endif; ?>
                                                </div>
                                                <?php if ($item['url'] !== ''): ?><div class="scraping-source-url"><span>Zdrojova URL</span><a href="<?= h($item['url']) ?>" target="_blank" rel="noopener"><?= h($item['url']) ?></a></div><?php endif; ?>
                                                <p><?= h(scrapingItemReason($item)) ?></p>
                                            </article>
                                        <?php endforeach; ?>
                                    </div>
                                </section>
                            <?php endforeach; ?>
                        </div>
                    </div>
                </td>
            </tr>
            <?php endif; ?>
        <?php endforeach; ?>
        </tbody></table>
    </section>
    <?php endif; ?>
    <?php endif; ?>

    <?php if ($view === 'config'): ?>
    <section class="panel">
        <div class="section-header">
            <div>
                <h2>Konfigurace</h2>
                <p>Jednotlive casti nastaveni se meni oddelene, aby se prihlasovaci udaje nikdy neprepsaly omylem.</p>
            </div>
        </div>
        <div class="config-grid">
            <section class="subpanel">
                <h2>SMTP odesilani</h2>
                <p><?= h($config['from_email']) ?> pres <?= h($config['smtp']['host']) ?>:<?= h((string)$config['smtp']['port']) ?></p>
                <div class="actions-row">
                    <button type="button" data-dialog-open="smtp-settings-dialog">Upravit SMTP</button>
                    <form method="post" class="inline"><input type="hidden" name="action" value="test_smtp"><button class="secondary">Otestovat SMTP</button></form>
                </div>
            </section>
            <?php
                $emailAuthReport = latestEmailAuthReport($pdo);
                $authDomain = emailAuthDomain($config);
                $dkimSelector = trim((string)($config['smtp']['dkim_selector'] ?? ''));
                $dkimHost = $authDomain !== ''
                    ? (($dkimSelector !== '' ? $dkimSelector : 'selector') . '._domainkey.' . $authDomain)
                    : 'selector._domainkey.domena.cz';
            ?>
            <section class="subpanel">
                <h2>SPF / DKIM / DMARC</h2>
                <p>Domena: <?= h($authDomain ?: 'nenastaveno') ?><?= $dkimSelector !== '' ? ', DKIM selector: ' . h($dkimSelector) : '' ?></p>
                <div class="dns-auth-badges">
                    <?= emailAuthBadge($emailAuthReport, 'spf') ?>
                    <?= emailAuthBadge($emailAuthReport, 'dkim') ?>
                    <?= emailAuthBadge($emailAuthReport, 'dmarc') ?>
                </div>
                <?php if (!empty($emailAuthReport['checked_at'])): ?>
                    <small>Posledni kontrola: <?= h(formatDateTime((string)$emailAuthReport['checked_at'])) ?></small>
                <?php endif; ?>
                <div class="actions-row">
                    <form method="post" class="inline"><input type="hidden" name="action" value="check_email_auth_dns"><button class="secondary">Otestovat DNS</button></form>
                </div>
                <div class="dns-help">
                    <h3>Co musi byt nastaveno</h3>
                    <dl>
                        <dt>SPF</dt>
                        <dd>TXT zaznam na domene <code><?= h($authDomain ?: 'domena.cz') ?></code>. Musi povolit server/sluzbu, pres kterou odesilame SMTP. Na domene ma byt jen jeden SPF zaznam zacinajici <code>v=spf1</code>; potrebne <code>include:</code> nebo IP ti da poskytovatel emailu.</dd>
                        <dt>DKIM</dt>
                        <dd>TXT zaznam na <code><?= h($dkimHost) ?></code>. Selector a verejny klic musi dodat poskytovatel mailboxu/SMTP. Bez selectoru aplikace nevi, jaky DKIM zaznam hledat.</dd>
                        <dt>DMARC</dt>
                        <dd>TXT zaznam na <code><?= h($authDomain !== '' ? '_dmarc.' . $authDomain : '_dmarc.domena.cz') ?></code>. Pro testovani muze byt <code>p=none</code>, pro ostre rozesilky je lepsi postupne prejit na <code>p=quarantine</code> nebo <code>p=reject</code>.</dd>
                    </dl>
                    <p>Test v aplikaci overuje DNS zaznamy. Neumi sam vygenerovat DKIM klic ani poznat vsechny spravne <code>include:</code> hodnoty pro SPF; ty musi prijit od emailoveho poskytovatele.</p>
                </div>
            </section>
            <section class="subpanel">
                <h2>IMAP odpovedi</h2>
                <p><?= h($config['imap']['host'] ?: 'Nenastaveno') ?><?= $config['imap']['host'] ? ':' . h((string)$config['imap']['port']) : '' ?></p>
                <div class="actions-row">
                    <button type="button" data-dialog-open="imap-settings-dialog">Upravit IMAP</button>
                    <form method="post" class="inline"><input type="hidden" name="action" value="test_imap"><button class="secondary">Otestovat IMAP</button></form>
                    <form method="post" class="inline"><input type="hidden" name="action" value="sync_imap_replies"><button class="secondary">Synchronizovat odpovedi</button></form>
                </div>
            </section>
            <section class="subpanel">
                <h2>Prihlaseni do aplikace</h2>
                <p><?= h((string)($config['admin_email'] ?? '')) ?></p>
                <div class="actions-row">
                    <button type="button" data-dialog-open="account-settings-dialog">Upravit prihlaseni</button>
                </div>
            </section>
        </div>
    </section>
    <dialog class="modal" id="smtp-settings-dialog">
        <form method="post" autocomplete="off">
            <input type="hidden" name="action" value="save_smtp_settings">
            <div class="modal-header">
                <h2>SMTP odesilani</h2>
                <button type="button" class="secondary icon" data-dialog-close>Zavrit</button>
            </div>
            <label>Odesilatel email<input type="email" name="from_email" autocomplete="off" value="<?= h($config['from_email']) ?>" required></label>
            <label>Odesilatel jmeno<input name="from_name" autocomplete="off" value="<?= h($config['from_name']) ?>" required></label>
            <label>SMTP server<input name="smtp_host" autocomplete="off" value="<?= h($config['smtp']['host']) ?>" required></label>
            <div class="row">
                <label>Port<input type="number" name="smtp_port" autocomplete="off" value="<?= h((string)$config['smtp']['port']) ?>" required></label>
                <label>Sifrovani<select name="smtp_encryption"><option value="tls" <?= $config['smtp']['encryption']==='tls'?'selected':'' ?>>TLS</option><option value="ssl" <?= $config['smtp']['encryption']==='ssl'?'selected':'' ?>>SSL</option><option value="" <?= $config['smtp']['encryption']===''?'selected':'' ?>>Bez</option></select></label>
            </div>
            <label>SMTP uzivatel<input name="smtp_username" autocomplete="off" data-lpignore="true" data-1p-ignore="true" value="<?= h($config['smtp']['username']) ?>" required></label>
            <label>SMTP heslo<input type="password" name="smtp_password" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" placeholder="Prazdne = nemenit"></label>
            <label>DKIM selector<input name="smtp_dkim_selector" autocomplete="off" value="<?= h((string)($config['smtp']['dkim_selector'] ?? '')) ?>" placeholder="napr. default, mail, selector1"></label>
            <div class="note">Selector najdes u poskytovatele emailu. Kontrola overuje DNS zaznamy domeny odesilatele, ne samotny podpis konkretni zpravy.</div>
            <div class="modal-actions">
                <button>Ulozit SMTP</button>
                <button type="button" class="secondary" data-dialog-close>Zrusit</button>
            </div>
        </form>
    </dialog>
    <dialog class="modal" id="imap-settings-dialog">
        <form method="post" autocomplete="off">
            <input type="hidden" name="action" value="save_imap_settings">
            <div class="modal-header">
                <h2>IMAP odpovedi</h2>
                <button type="button" class="secondary icon" data-dialog-close>Zavrit</button>
            </div>
            <label>IMAP server<input name="imap_host" autocomplete="off" value="<?= h($config['imap']['host']) ?>"></label>
            <div class="row">
                <label>Port<input type="number" name="imap_port" autocomplete="off" value="<?= h((string)$config['imap']['port']) ?>"></label>
                <label>Sifrovani<select name="imap_encryption"><option value="ssl" <?= $config['imap']['encryption']==='ssl'?'selected':'' ?>>SSL</option><option value="tls" <?= $config['imap']['encryption']==='tls'?'selected':'' ?>>TLS/STARTTLS</option><option value="" <?= $config['imap']['encryption']===''?'selected':'' ?>>Bez</option></select></label>
            </div>
            <label>IMAP uzivatel<input name="imap_username" autocomplete="off" data-lpignore="true" data-1p-ignore="true" value="<?= h($config['imap']['username']) ?>"></label>
            <label>IMAP heslo<input type="password" name="imap_password" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" placeholder="Prazdne = nemenit"></label>
            <div class="modal-actions">
                <button>Ulozit IMAP</button>
                <button type="button" class="secondary" data-dialog-close>Zrusit</button>
            </div>
        </form>
    </dialog>
    <dialog class="modal" id="account-settings-dialog">
        <form method="post" autocomplete="off">
            <input type="hidden" name="action" value="save_account_settings">
            <div class="modal-header">
                <h2>Prihlaseni do aplikace</h2>
                <button type="button" class="secondary icon" data-dialog-close>Zavrit</button>
            </div>
            <label>Admin email<input type="email" name="admin_email" autocomplete="off" data-lpignore="true" data-1p-ignore="true" value="<?= h((string)($config['admin_email'] ?? '')) ?>" required></label>
            <label>Soucasne heslo<input type="password" name="current_password" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" placeholder="Jen pri zmene prihlaseni"></label>
            <label>Nove heslo<input type="password" name="new_password" minlength="10" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" placeholder="Nechat prazdne = nemenit"></label>
            <div class="note">Soucasne heslo je potreba pouze pri zmene admin emailu nebo hesla.</div>
            <div class="modal-actions">
                <button>Ulozit prihlaseni</button>
                <button type="button" class="secondary" data-dialog-close>Zrusit</button>
            </div>
        </form>
    </dialog>
    <?php endif; ?>
</main>
<?php renderLanguageFooter($pdo, $config); ?>
<script src="<?= h(assetUrl('assets/app.js')) ?>"></script>
</body></html><?php
    echo localizeHtml((string)ob_get_clean(), $pdo, $config);
}

function recipientPage(PDO $pdo, int $listId): array
{
    $page = max(1, (int)($_GET['page'] ?? 1));
    $perPage = max(25, min(250, (int)($_GET['per_page'] ?? 100)));
    $query = trim((string)($_GET['q'] ?? ''));
    $metric = (string)($_GET['metric'] ?? '');
    if (!array_key_exists($metric, contactMetricLabels())) {
        $metric = '';
    }
    $sort = (string)($_GET['sort'] ?? 'created_at');
    $dir = strtolower((string)($_GET['dir'] ?? 'desc')) === 'asc' ? 'asc' : 'desc';
    $sorts = [
        'email' => 'r.email',
        'subject' => 'r.subject_name',
        'source' => 'r.source_label',
        'address' => 'r.address',
        'website' => 'r.website',
        'created_at' => 'r.created_at',
        'updated_at' => 'COALESCE(NULLIF(r.updated_at, ""), r.created_at)',
        'contacted' => 'contacted_sort',
        'replied' => 'replied_sort',
        'bounce' => 'bounce_sort',
    ];
    if (!isset($sorts[$sort])) {
        $sort = 'created_at';
    }
    $conditions = ['r.status="active"', 'COALESCE(r.archived, 0)=0', 'r.list_id=?'];
    $values = [$listId];
    if ($query !== '') {
        $conditions[] = '(r.email LIKE ? OR r.subject_name LIKE ? OR r.website LIKE ? OR r.address LIKE ? OR r.source_label LIKE ? OR r.source_url LIKE ?)';
        $like = '%' . $query . '%';
        array_push($values, $like, $like, $like, $like, $like, $like);
    }
    if ($metric === 'contacted') {
        $conditions[] = '(COALESCE(r.contacted_before, 0)>0 OR EXISTS (SELECT 1 FROM send_logs l WHERE l.recipient_id=r.id AND l.status="sent"))';
    } elseif ($metric === 'opened') {
        $conditions[] = 'EXISTS (SELECT 1 FROM send_logs l WHERE l.recipient_id=r.id AND l.opened_at!="")';
    } elseif ($metric === 'clicked') {
        $conditions[] = 'EXISTS (SELECT 1 FROM send_logs l WHERE l.recipient_id=r.id AND l.click_count>0)';
    } elseif ($metric === 'replied') {
        $conditions[] = 'EXISTS (SELECT 1 FROM send_logs l WHERE l.recipient_id=r.id AND l.replied_at!="")';
    }
    $where = 'WHERE ' . implode(' AND ', $conditions);
    $countStmt = $pdo->prepare('SELECT COUNT(*) FROM recipients r ' . $where);
    $countStmt->execute($values);
    $total = (int)$countStmt->fetchColumn();
    $pages = max(1, (int)ceil($total / $perPage));
    $page = min($page, $pages);
    $offset = ($page - 1) * $perPage;
    $order = $sorts[$sort] . ' ' . strtoupper($dir) . ', r.id DESC';
    $stmt = $pdo->prepare('
        SELECT r.email,
               r.subject_name,
               r.website,
               r.address,
               r.source_label,
               r.source_url,
               COALESCE(r.contacted_before, 0) contacted_before,
               cl.name list_name,
               r.created_at,
               COALESCE(NULLIF(r.updated_at, ""), r.created_at) updated_at,
               COALESCE(logs.sent_count, 0) sent_count,
               COALESCE(logs.replied_count, 0) replied_count,
               COALESCE(logs.bounce_count, 0) bounce_count,
               CASE WHEN COALESCE(r.contacted_before, 0)>0 OR COALESCE(logs.sent_count, 0)>0 THEN 1 ELSE 0 END contacted_sort,
               CASE WHEN COALESCE(logs.replied_count, 0)>0 THEN 1 ELSE 0 END replied_sort,
               CASE WHEN COALESCE(logs.bounce_count, 0)>0 THEN 1 ELSE 0 END bounce_sort
        FROM recipients r
        LEFT JOIN contact_databases cl ON cl.id=r.list_id
        LEFT JOIN (
            SELECT l.recipient_id,
                   SUM(CASE WHEN l.status="sent" THEN 1 ELSE 0 END) sent_count,
                   SUM(CASE WHEN l.replied_at!="" THEN 1 ELSE 0 END) replied_count,
                   SUM(CASE WHEN l.message LIKE "Bounce:%" OR COALESCE(events.bounce_events, 0)>0 THEN 1 ELSE 0 END) bounce_count
            FROM send_logs l
            LEFT JOIN (
                SELECT send_log_id,
                       SUM(CASE WHEN event_type="bounce" THEN 1 ELSE 0 END) bounce_events
                FROM tracking_events
                GROUP BY send_log_id
            ) events ON events.send_log_id=l.id
            GROUP BY l.recipient_id
        ) logs ON logs.recipient_id=r.id
        ' . $where . '
        ORDER BY ' . $order . '
        LIMIT ' . $perPage . ' OFFSET ' . $offset . '
    ');
    $stmt->execute($values);
    return [
        'rows' => $stmt->fetchAll(PDO::FETCH_ASSOC),
        'total' => $total,
        'page' => $page,
        'pages' => $pages,
        'per_page' => $perPage,
        'q' => $query,
        'metric' => $metric,
        'sort' => $sort,
        'dir' => $dir,
    ];
}

function contactMetricLabels(): array
{
    return [
        '' => '',
        'contacted' => 'Oslovene kontakty',
        'opened' => 'Kontakty, ktere otevrely email',
        'clicked' => 'Kontakty, ktere klikly',
        'replied' => 'Kontakty, ktere odpovedely',
    ];
}

function contactMetricLabel(string $metric): string
{
    $labels = contactMetricLabels();
    return $labels[$metric] ?? '';
}

function campaignRows(PDO $pdo): array
{
    $windowStart = date('c', time() - 86400);
    $rows = $pdo->query('
        SELECT c.*,
               cl.name list_name,
               COALESCE(planned.count, 0) planned_count,
               COALESCE(eligible.count, 0) eligible_count,
               COALESCE(sent.sent_count, 0) sent_count,
               COALESCE(sent.opened_count, 0) opened_count,
               COALESCE(sent.replied_count, 0) replied_count,
               COALESCE(sent.click_count, 0) click_count,
               COALESCE(today.sent_today, 0) sent_today
        FROM campaigns c
        LEFT JOIN contact_databases cl ON cl.id=c.list_id
        LEFT JOIN (
            SELECT list_id, COUNT(*) count
            FROM recipients r
            WHERE r.status="active"
              AND COALESCE(r.archived, 0)=0
              AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.email=LOWER(r.email))
            GROUP BY list_id
        ) planned ON planned.list_id=c.list_id
        LEFT JOIN (
            SELECT r.list_id, COUNT(*) count
            FROM recipients r
            WHERE r.status="active"
              AND COALESCE(r.archived, 0)=0
              AND COALESCE(r.contacted_before, 0)=0
              AND NOT EXISTS (
                  SELECT 1
                  FROM send_logs any_sent
                  WHERE any_sent.recipient_id=r.id
                    AND any_sent.status="sent"
              )
              AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.email=LOWER(r.email))
            GROUP BY r.list_id
        ) eligible ON eligible.list_id=c.list_id
        LEFT JOIN (
            SELECT campaign_id,
                   COUNT(DISTINCT CASE WHEN status="sent" THEN recipient_id END) sent_count,
                   COUNT(DISTINCT CASE WHEN opened_at!="" THEN recipient_id END) opened_count,
                   COUNT(DISTINCT CASE WHEN status="sent" AND replied_at!="" THEN recipient_id END) replied_count,
                   COALESCE(SUM(click_count), 0) click_count
            FROM send_logs
            GROUP BY campaign_id
        ) sent ON sent.campaign_id=c.id
        LEFT JOIN (
            SELECT campaign_id, COUNT(*) sent_today
            FROM send_logs
            WHERE (status="sent" OR message LIKE "Bounce:%") AND sent_at>=' . $pdo->quote($windowStart) . '
            GROUP BY campaign_id
        ) today ON today.campaign_id=c.id
        WHERE COALESCE(cl.archived, 0)=0
        ORDER BY c.id DESC
    ')->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$row) {
        if ((int)($row['include_previously_contacted'] ?? 0) === 1) {
            $remainingCount = max(0, (int)$row['planned_count'] - (int)$row['sent_count']);
        } else {
            $remainingCount = (int)$row['eligible_count'];
        }
        $row['remaining_count'] = $remainingCount;
        $row['target_count'] = (int)$row['sent_count'] + $remainingCount;
        $pace = campaignDailyLimit($pdo, $row);
        $row['effective_daily_limit'] = (int)$pace['limit'];
        $row['pace_reason'] = $pace['reason'];
        $row['remaining_today'] = max(0, (int)$pace['limit'] - (int)$row['sent_today']);
        $row['sender_daily_limit'] = (int)senderDailyLimit($pdo, $row, $pace);
    }
    unset($row);
    return $rows;
}

function importRows(PDO $pdo, int $listId = 0): array
{
    $where = $listId > 0 ? 'WHERE list_id=' . $listId : '';
    return $pdo->query('
        SELECT *
        FROM import_runs
        ' . $where . '
        ORDER BY id DESC
        LIMIT 30
    ')->fetchAll(PDO::FETCH_ASSOC);
}

function campaignSendRuns(PDO $pdo): array
{
    $rows = $pdo->query('
        SELECT r.*,
               COALESCE(log_counts.sent_count, r.sent_count, 0) computed_sent_count,
               COALESCE(log_counts.failed_count, r.failed_count, 0) computed_failed_count,
               COALESCE(log_counts.bounce_count, 0) computed_bounce_count,
               CASE
                   WHEN COALESCE(r.planned_count, 0)<COALESCE(log_counts.total_count, 0) THEN COALESCE(log_counts.total_count, 0)
                   ELSE COALESCE(r.planned_count, 0)
               END computed_planned_count,
               COALESCE(c.name, "") campaign,
               COALESCE(c.list_id, 0) list_id
        FROM campaign_send_runs r
        LEFT JOIN campaigns c ON c.id=r.campaign_id
        LEFT JOIN contact_databases cl ON cl.id=c.list_id
        LEFT JOIN (
            SELECT l.run_id,
                   COUNT(*) total_count,
                   SUM(CASE WHEN l.status="sent" THEN 1 ELSE 0 END) sent_count,
                   SUM(CASE WHEN l.status="failed" THEN 1 ELSE 0 END) failed_count,
                   SUM(CASE WHEN l.message LIKE "Bounce:%" OR COALESCE(events.bounce_events, 0)>0 THEN 1 ELSE 0 END) bounce_count
            FROM send_logs l
            LEFT JOIN (
                SELECT send_log_id,
                       SUM(CASE WHEN event_type="bounce" THEN 1 ELSE 0 END) bounce_events
                FROM tracking_events
                GROUP BY send_log_id
            ) events ON events.send_log_id=l.id
            WHERE COALESCE(l.run_id, 0)>0
            GROUP BY l.run_id
        ) log_counts ON log_counts.run_id=r.id
        WHERE COALESCE(cl.archived, 0)=0
        ORDER BY r.id DESC
        LIMIT 50
    ')->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$row) {
        $row['sent_count'] = (int)$row['computed_sent_count'];
        $row['failed_count'] = (int)$row['computed_failed_count'];
        $row['bounce_count'] = (int)$row['computed_bounce_count'];
        $row['planned_count'] = (int)$row['computed_planned_count'];
    }
    unset($row);
    return $rows;
}

function campaignSendRunSummary(PDO $pdo): array
{
    $row = $pdo->query('
        SELECT COUNT(DISTINCT r.id) run_count,
               COALESCE(SUM(CASE WHEN l.status="sent" THEN 1 ELSE 0 END), 0) sent_count,
               COALESCE(SUM(CASE WHEN l.status="failed" THEN 1 ELSE 0 END), 0) failed_count,
               COALESCE(SUM(CASE WHEN l.message LIKE "Bounce:%" OR COALESCE(events.bounce_events, 0)>0 THEN 1 ELSE 0 END), 0) bounce_count,
               COUNT(DISTINCT CASE WHEN l.status="sent" AND rec.status="active" AND COALESCE(rec.archived, 0)=0 THEN l.recipient_id END) contacted_contacts
        FROM campaign_send_runs r
        LEFT JOIN campaigns c ON c.id=r.campaign_id
        LEFT JOIN contact_databases cl ON cl.id=c.list_id
        LEFT JOIN send_logs l ON l.run_id=r.id
        LEFT JOIN recipients rec ON rec.id=l.recipient_id
        LEFT JOIN (
            SELECT send_log_id,
                   SUM(CASE WHEN event_type="bounce" THEN 1 ELSE 0 END) bounce_events
            FROM tracking_events
            GROUP BY send_log_id
        ) events ON events.send_log_id=l.id
        WHERE COALESCE(cl.archived, 0)=0
    ')->fetch(PDO::FETCH_ASSOC) ?: [];
    return [
        'run_count' => (int)($row['run_count'] ?? 0),
        'sent_count' => (int)($row['sent_count'] ?? 0),
        'failed_count' => (int)($row['failed_count'] ?? 0),
        'bounce_count' => (int)($row['bounce_count'] ?? 0),
        'contacted_contacts' => (int)($row['contacted_contacts'] ?? 0),
    ];
}

function campaignSendRunItemsByRun(PDO $pdo, array $runIds): array
{
    $runIds = array_values(array_unique(array_filter(array_map('intval', $runIds))));
    if (!$runIds) {
        return [];
    }
    $rows = $pdo->query('
        SELECT l.*,
               COALESCE(r.subject_name, "") subject_name,
               COALESCE(events.bounce_events, 0) bounce_count
        FROM send_logs l
        LEFT JOIN recipients r ON r.id=l.recipient_id
        LEFT JOIN (
            SELECT send_log_id,
                   SUM(CASE WHEN event_type="bounce" THEN 1 ELSE 0 END) bounce_events
            FROM tracking_events
            GROUP BY send_log_id
        ) events ON events.send_log_id=l.id
        WHERE l.run_id IN (' . implode(',', $runIds) . ')
        ORDER BY l.id ASC
    ')->fetchAll(PDO::FETCH_ASSOC);
    $grouped = [];
    foreach ($rows as $row) {
        $runId = (int)$row['run_id'];
        if (!isset($grouped[$runId])) {
            $grouped[$runId] = [];
        }
        $grouped[$runId][] = $row;
    }
    return $grouped;
}

function sendRunTypeLabel(array $run): string
{
    $type = (string)($run['run_type'] ?? '');
    if ($type === 'scheduled') {
        return 'naplanovany';
    }
    if ($type === 'historical') {
        return 'historicky';
    }
    return 'jednorazovy';
}

function sendRunStatusLabel(array $run): string
{
    $status = (string)($run['status'] ?? '');
    if ($status === 'finished'
        && (int)($run['planned_count'] ?? 0) > 0
        && (int)($run['sent_count'] ?? 0) === 0
        && (int)($run['failed_count'] ?? 0) >= (int)($run['planned_count'] ?? 0)
    ) {
        $status = 'failed';
    }
    return [
        'queued' => 'ceka',
        'running' => 'bezi',
        'finished' => 'hotovo',
        'failed' => 'chyba',
    ][$status] ?? $status;
}

function findImportRun(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM import_runs WHERE id=?');
    $stmt->execute([$id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function importRunItems(PDO $pdo, int $id): array
{
    $stmt = $pdo->prepare('
        SELECT *
        FROM import_run_items
        WHERE import_run_id=?
        ORDER BY row_num ASC, id ASC
    ');
    $stmt->execute([$id]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function importResultLabel(string $result): string
{
    $labels = ['inserted' => 'vlozeno', 'updated' => 'aktualizovano', 'skipped' => 'preskoceno'];
    return $labels[$result] ?? $result;
}

function importRunStatusLabel(array $run): string
{
    $status = (string)($run['status'] ?? 'finished');
    return [
        'queued' => 'ceka',
        'running' => 'bezi',
        'finished' => 'hotovo',
        'failed' => 'chyba',
    ][$status] ?? $status;
}

function importRunMessage(array $run): string
{
    $message = trim((string)($run['last_message'] ?? ''));
    $summary = 'Zpracovano ' . (int)($run['total_rows'] ?? 0) . ' radku, vlozeno ' . (int)($run['inserted_count'] ?? 0) . ', aktualizovano ' . (int)($run['updated_count'] ?? 0) . ', preskoceno ' . (int)($run['skipped_count'] ?? 0) . '.';
    return $message !== '' ? $message . ' ' . $summary : $summary;
}

function importItemGroups(array $items): array
{
    $groups = [
        'inserted' => ['label' => 'Pridane kontakty', 'class' => 'result-inserted', 'items' => []],
        'updated' => ['label' => 'Aktualizovane kontakty', 'class' => 'result-updated', 'items' => []],
        'skipped' => ['label' => 'Preskocene kontakty', 'class' => 'result-skipped', 'items' => []],
    ];
    foreach ($items as $item) {
        $result = (string)($item['result'] ?? 'skipped');
        if (!isset($groups[$result])) {
            $result = 'skipped';
        }
        $groups[$result]['items'][] = $item;
    }
    return $groups;
}

function importItemSourceUrl(array $item): string
{
    $raw = json_decode((string)($item['raw_data'] ?? ''), true);
    if (!is_array($raw)) {
        return '';
    }
    $stack = $raw;
    while ($stack) {
        $value = array_shift($stack);
        if (is_array($value)) {
            foreach ($value as $nested) {
                $stack[] = $nested;
            }
            continue;
        }
        $candidate = trim((string)$value);
        if ($candidate !== '' && preg_match('/^https?:\/\//i', $candidate)) {
            return $candidate;
        }
    }
    return '';
}

function scrapingContainers(PDO $pdo, int $listId = 0): array
{
    $where = $listId > 0
        ? 'WHERE c.status!="deleted" AND c.list_id=' . $listId . ' AND COALESCE(cl.archived, 0)=0'
        : 'WHERE c.status!="deleted" AND COALESCE(cl.archived, 0)=0';
    return $pdo->query('
        SELECT c.*,
               cl.name list_name,
               COALESCE((SELECT COALESCE(NULLIF(j2.finished_at, ""), NULLIF(j2.updated_at, ""), j2.created_at) FROM scraping_jobs j2 WHERE j2.container_id=c.id ORDER BY j2.id DESC LIMIT 1), "") last_run_at,
               COALESCE((SELECT SUM(j3.inserted_count) FROM scraping_jobs j3 WHERE j3.container_id=c.id), 0) total_inserted,
               COALESCE((SELECT SUM(j4.updated_count) FROM scraping_jobs j4 WHERE j4.container_id=c.id), 0) total_updated
        FROM scraping_containers c
        LEFT JOIN contact_databases cl ON cl.id=c.list_id
        ' . $where . '
        ORDER BY c.id DESC
        LIMIT 50
    ')->fetchAll(PDO::FETCH_ASSOC);
}

function scrapingJobs(PDO $pdo, int $listId = 0, int $containerId = 0): array
{
    $filters = [];
    if ($listId > 0) {
        $filters[] = 'j.list_id=' . $listId;
    }
    if ($containerId > 0) {
        $filters[] = 'j.container_id=' . $containerId;
    }
    $filters[] = 'COALESCE(cl.archived, 0)=0';
    $where = 'WHERE ' . implode(' AND ', $filters);
    return $pdo->query('
        SELECT j.*,
               cl.name list_name,
               COALESCE(c.source, "") container_source,
               COALESCE(c.keyword, "") container_keyword
        FROM scraping_jobs j
        LEFT JOIN contact_databases cl ON cl.id=j.list_id
        LEFT JOIN scraping_containers c ON c.id=j.container_id
        ' . $where . '
        ORDER BY j.id DESC
        LIMIT 50
    ')->fetchAll(PDO::FETCH_ASSOC);
}

function activeScrapingJobs(PDO $pdo): array
{
    return $pdo->query('
        SELECT j.*,
               cl.name list_name,
               COALESCE(NULLIF(c.source, ""), j.source) display_source,
               COALESCE(NULLIF(c.keyword, ""), j.keyword) display_keyword
        FROM scraping_jobs j
        LEFT JOIN contact_databases cl ON cl.id=j.list_id
        LEFT JOIN scraping_containers c ON c.id=j.container_id
        WHERE j.status IN ("queued", "running")
          AND COALESCE(cl.archived, 0)=0
        ORDER BY CASE WHEN j.status="running" THEN 0 ELSE 1 END, j.updated_at DESC, j.id DESC
        LIMIT 30
    ')->fetchAll(PDO::FETCH_ASSOC);
}

function scrapingItemsByJob(PDO $pdo, array $jobIds): array
{
    $jobIds = array_values(array_unique(array_filter(array_map('intval', $jobIds))));
    if (!$jobIds) {
        return [];
    }
    $rows = $pdo->query('
        SELECT *
        FROM scraping_job_items
        WHERE job_id IN (' . implode(',', $jobIds) . ')
        ORDER BY id ASC
    ')->fetchAll(PDO::FETCH_ASSOC);
    $grouped = [];
    foreach ($rows as $row) {
        $jobId = (int)$row['job_id'];
        if (!isset($grouped[$jobId])) {
            $grouped[$jobId] = [];
        }
        $grouped[$jobId][] = $row;
    }
    return $grouped;
}

function scrapingItemGroups(array $items): array
{
    $groups = [
        'inserted' => ['label' => 'Pridane kontakty', 'class' => 'result-inserted', 'items' => []],
        'updated' => ['label' => 'Aktualizovane kontakty', 'class' => 'result-updated', 'items' => []],
        'skipped' => ['label' => 'Preskocene kontakty', 'class' => 'result-skipped', 'items' => []],
    ];
    foreach ($items as $item) {
        $status = (string)($item['status'] ?? '');
        if ($status === 'queued' || $status === 'cancelled') {
            continue;
        }
        if ($status === 'failed') {
            $status = 'skipped';
        }
        if (!isset($groups[$status])) {
            $status = 'skipped';
        }
        $groups[$status]['items'][] = $item;
    }
    return $groups;
}

function scrapingGroupCounts(array $groups): array
{
    $inserted = count($groups['inserted']['items'] ?? []);
    $updated = count($groups['updated']['items'] ?? []);
    $skipped = count($groups['skipped']['items'] ?? []);
    return [
        'inserted' => $inserted,
        'updated' => $updated,
        'skipped' => $skipped,
        'processed' => $inserted + $updated + $skipped,
    ];
}

function scrapingStatusLabel(string $status, string $context = ''): string
{
    $labels = [
        'queued' => $context === 'item' ? 'nalezeno' : 'bezi',
        'running' => 'bezi',
        'finished' => 'hotovo',
        'failed' => 'chyba',
        'paused' => 'pozastaveno',
        'cancelled' => 'preruseno',
        'inserted' => 'vlozeno',
        'updated' => 'aktualizovano',
        'skipped' => 'preskoceno',
    ];
    return $labels[$status] ?? $status;
}

function scrapingRunTypeLabel(array $job): string
{
    $type = (string)($job['run_type'] ?? '');
    if ($type === 'scheduled') {
        return 'naplanovany';
    }
    if ($type === 'manual') {
        return 'jednorazovy';
    }
    $message = (string)($job['last_message'] ?? '');
    if (stripos($message, 'Automaticky') !== false || stripos($message, 'planovany') !== false) {
        return 'naplanovany';
    }
    return 'jednorazovy';
}

function scrapingItemTitle(array $item): string
{
    $title = trim((string)($item['subject_name'] ?? ''));
    if ($title !== '') {
        return $title;
    }
    $email = trim((string)($item['email'] ?? ''));
    if ($email !== '') {
        return $email;
    }
    $host = parse_url((string)($item['url'] ?? ''), PHP_URL_HOST);
    return $host ?: (string)($item['url'] ?? 'URL');
}

function scrapingItemReason(array $item): string
{
    $status = (string)($item['status'] ?? '');
    $message = trim((string)($item['message'] ?? ''));
    if ($status === 'queued') {
        return 'URL je nalezena, ale jeste nebyla zpracovana.';
    }
    if ($status === 'inserted') {
        return 'Novy kontakt byl vlozen do databaze.';
    }
    if ($status === 'updated') {
        return $message !== '' ? $message : 'Doplneny chybejici udaje.';
    }
    if ($status === 'failed') {
        return $message === '' ? 'Chyba pri zpracovani URL.' : 'Chyba pri zpracovani: ' . $message;
    }
    if (stripos($message, 'Email nenalezen') !== false) {
        return 'Email nenalezen.';
    }
    if ($message === '' || preg_match('/Kontakt\s+skipped/i', $message)) {
        return 'Duplicita bez chybejicich udaju k doplneni.';
    }
    return $message;
}

function contactLists(PDO $pdo): array
{
    $rows = $pdo->query('SELECT id, name FROM contact_databases WHERE COALESCE(archived, 0)=0 ORDER BY id ASC')->fetchAll(PDO::FETCH_ASSOC);
    $contactsStmt = $pdo->prepare('
        SELECT COUNT(*)
        FROM recipients r
        WHERE r.list_id=?
          AND r.status="active"
          AND COALESCE(r.archived, 0)=0
          AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.email=LOWER(r.email))
    ');
    $importedStmt = $pdo->prepare('
        SELECT COUNT(*)
        FROM recipients r
        WHERE r.list_id=?
          AND r.status="active"
          AND COALESCE(r.archived, 0)=0
          AND COALESCE(r.contacted_before, 0)>0
          AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.email=LOWER(r.email))
    ');
    $sentStmt = $pdo->prepare('
        SELECT COUNT(DISTINCT l.recipient_id)
        FROM send_logs l
        JOIN recipients r ON r.id=l.recipient_id
        WHERE l.status="sent"
          AND l.recipient_id IS NOT NULL
          AND r.list_id=?
          AND r.status="active"
          AND COALESCE(r.archived, 0)=0
          AND COALESCE(r.contacted_before, 0)=0
          AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.email=LOWER(r.email))
    ');
    foreach ($rows as &$row) {
        $contactsStmt->execute([(int)$row['id']]);
        $importedStmt->execute([(int)$row['id']]);
        $sentStmt->execute([(int)$row['id']]);
        $row['contacts'] = (int)$contactsStmt->fetchColumn();
        $row['imported_contacted'] = (int)$importedStmt->fetchColumn();
        $row['contacted_contacts'] = (int)$row['imported_contacted'] + (int)$sentStmt->fetchColumn();
        $row['uncontacted_contacts'] = max(0, (int)($row['contacts'] ?? 0) - (int)$row['contacted_contacts']);
    }
    unset($row);
    return $rows;
}

function contactListOptions(PDO $pdo): array
{
    return $pdo->query('SELECT id, name FROM contact_databases WHERE COALESCE(archived, 0)=0 ORDER BY id ASC')->fetchAll(PDO::FETCH_ASSOC);
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
    $total = (int)$pdo->query('
        SELECT COUNT(*)
        FROM recipients r
        JOIN contact_databases cl ON cl.id=r.list_id
        WHERE r.status="active"
          AND COALESCE(r.archived, 0)=0
          AND COALESCE(cl.archived, 0)=0
          AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.email=LOWER(r.email))
    ')->fetchColumn();
    $contacted = (int)$pdo->query('
        SELECT COUNT(DISTINCT LOWER(l.email))
        FROM send_logs l
        JOIN campaigns c ON c.id=l.campaign_id
        JOIN contact_databases cl ON cl.id=c.list_id
        WHERE l.status="sent"
          AND l.email!=""
          AND COALESCE(cl.archived, 0)=0
    ')->fetchColumn();
    $opened = (int)$pdo->query('
        SELECT COUNT(DISTINCT LOWER(l.email))
        FROM send_logs l
        JOIN campaigns c ON c.id=l.campaign_id
        JOIN contact_databases cl ON cl.id=c.list_id
        WHERE l.opened_at!=""
          AND l.email!=""
          AND COALESCE(cl.archived, 0)=0
    ')->fetchColumn();
    $clickedContacts = (int)$pdo->query('
        SELECT COUNT(DISTINCT LOWER(l.email))
        FROM send_logs l
        JOIN campaigns c ON c.id=l.campaign_id
        JOIN contact_databases cl ON cl.id=c.list_id
        WHERE l.click_count>0
          AND l.email!=""
          AND COALESCE(cl.archived, 0)=0
    ')->fetchColumn();
    $repliedContacts = (int)$pdo->query('
        SELECT COUNT(DISTINCT LOWER(l.email))
        FROM send_logs l
        JOIN campaigns c ON c.id=l.campaign_id
        JOIN contact_databases cl ON cl.id=c.list_id
        WHERE l.replied_at!=""
          AND l.email!=""
          AND COALESCE(cl.archived, 0)=0
    ')->fetchColumn();
    $clicks = (int)$pdo->query('
        SELECT COALESCE(SUM(l.click_count),0)
        FROM send_logs l
        JOIN campaigns c ON c.id=l.campaign_id
        JOIN contact_databases cl ON cl.id=c.list_id
        WHERE COALESCE(cl.archived, 0)=0
    ')->fetchColumn();
    $windowStart = date('c', time() - 86400);
    $stmt = $pdo->prepare('
        SELECT COUNT(*) sent_count, MIN(l.sent_at) first_sent_at
        FROM send_logs l
        JOIN campaigns c ON c.id=l.campaign_id
        JOIN contact_databases cl ON cl.id=c.list_id
        WHERE l.status="sent"
          AND l.sent_at>=?
          AND COALESCE(cl.archived, 0)=0
    ');
    $stmt->execute([$windowStart]);
    $sendWindow = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
    $sentToday = (int)($sendWindow['sent_count'] ?? 0);
    $firstSentAt = (string)($sendWindow['first_sent_at'] ?? '');
    $firstSentTime = $firstSentAt !== '' ? strtotime($firstSentAt) : false;
    $senderLimit = senderDailyLimit($pdo, $campaign, $pace);
    $campaignWindow = campaignRemainingWindowSlots($pdo, $campaign, $pace);

    $campaignId = (int)($campaign['id'] ?? 0);
    $plannedFilter = (int)($campaign['include_previously_contacted'] ?? 0) === 1 ? '' : '
        AND COALESCE(r.contacted_before, 0)=0
        AND NOT EXISTS (SELECT 1 FROM send_logs any_sent WHERE any_sent.recipient_id=r.id AND any_sent.status="sent")
    ';
    $plannedStmt = $pdo->prepare('
        SELECT COUNT(*)
        FROM recipients r
        JOIN contact_databases cl ON cl.id=r.list_id
        WHERE r.status="active"
          AND COALESCE(r.archived, 0)=0
          AND COALESCE(cl.archived, 0)=0
          AND r.list_id=?
          AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.email=LOWER(r.email))
    ' . $plannedFilter);
    $plannedStmt->execute([(int)($campaign['list_id'] ?? 1)]);
    $planned = (int)$plannedStmt->fetchColumn();

    $campaignSent = $campaignOpened = $campaignClicks = $campaignReplied = 0;
    if ($campaignId > 0) {
        $metric = $pdo->prepare("SELECT COUNT(*) sent, COUNT(NULLIF(opened_at, '')) opened, COUNT(NULLIF(replied_at, '')) replied, COALESCE(SUM(click_count),0) clicks FROM send_logs WHERE campaign_id=? AND status=\"sent\"");
        $metric->execute([$campaignId]);
        $row = $metric->fetch(PDO::FETCH_ASSOC) ?: [];
        $campaignSent = (int)($row['sent'] ?? 0);
        $campaignOpened = (int)($row['opened'] ?? 0);
        $campaignReplied = (int)($row['replied'] ?? 0);
        $campaignClicks = (int)($row['clicks'] ?? 0);
    }
    if ((int)($campaign['include_previously_contacted'] ?? 0) !== 1) {
        $planned += $campaignSent;
    }

    return [
        'total' => $total,
        'contacted' => $contacted,
        'opened' => $opened,
        'clicked_contacts' => $clickedContacts,
        'replied_contacts' => $repliedContacts,
        'clicks' => $clicks,
        'sent_today' => $sentToday,
        'sender_limit_today' => $senderLimit,
        'remaining_today' => max(0, $senderLimit - $sentToday),
        'campaign_remaining_today' => (int)($campaignWindow['campaign_remaining'] ?? 0),
        'campaign_limit_today' => (int)($campaignWindow['campaign_limit'] ?? $pace['limit']),
        'limit_reset_at' => $firstSentTime ? date('c', $firstSentTime + 86400) : '',
        'planned' => $planned,
        'campaign_sent' => $campaignSent,
        'campaign_opened' => $campaignOpened,
        'campaign_replied' => $campaignReplied,
        'campaign_clicks' => $campaignClicks,
        'open_rate' => $campaignSent > 0 ? number_format($campaignOpened / $campaignSent * 100, 1, '.', '') : '0.0',
        'ctr' => $campaignSent > 0 ? number_format($campaignClicks / $campaignSent * 100, 1, '.', '') : '0.0',
    ];
}

function statusBadge(string $text): string
{
    $class = in_array($text, ['ano', 'smtp prijato', 'vlozeno', 'aktualizovano', 'finished', 'hotovo', 'bezi', 'Active', 'active'], true) || substr($text, -1) === 'x' ? 'good' : 'muted';
    if (in_array($text, ['nezjisteno', 'nenapojeno', 'preskoceno', 'failed', 'chyba', 'paused', 'Paused', 'pozastaveno'], true)) {
        $class = 'warn';
    }
    if (in_array($text, ['cancelled', 'zruseno'], true)) {
        $class = 'muted';
    }
    if (in_array($text, ['bezi', 'ceka'], true)) {
        $class .= ' live';
    }
    return '<span class="badge ' . $class . '">' . h($text) . '</span>';
}
