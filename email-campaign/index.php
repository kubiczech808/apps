<?php

declare(strict_types=1);

session_start();
require __DIR__ . '/src/Database.php';
require __DIR__ . '/src/SmtpMailer.php';

$configPath = __DIR__ . '/config.php';
$baseConfig = file_exists($configPath) ? require $configPath : require __DIR__ . '/config.example.php';
$db = new Database($baseConfig['database_path']);
$pdo = $db->pdo();
$config = effectiveConfig($pdo, $baseConfig);
$flash = null;

if (isset($_GET['cron'])) {
    header('Content-Type: text/plain; charset=utf-8');
    if (!hash_equals((string)$config['cron_token'], (string)$_GET['cron'])) {
        http_response_code(403);
        exit("Forbidden\n");
    }
    echo sendBatch($pdo, $config);
    exit;
}

if (isset($_POST['password'])) {
    if (password_verify((string)$_POST['password'], (string)$config['app_password_hash'])) {
        $_SESSION['auth'] = true;
        header('Location: ./');
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
        handlePost($pdo, $config);
        header('Location: ./?ok=1');
        exit;
    } catch (Throwable $e) {
        $flash = ['error', $e->getMessage()];
    }
}

if (isset($_GET['ok'])) {
    $flash = ['ok', 'Hotovo.'];
}

renderApp($pdo, $flash);

function handlePost(PDO $pdo, array $config): void
{
    $action = $_POST['action'] ?? '';
    if ($action === 'save_settings') {
        saveSettings($pdo);
        return;
    }

    if ($action === 'save_campaign') {
        $id = (int)($_POST['id'] ?? 0);
        $data = [
            trim((string)$_POST['name']),
            trim((string)$_POST['subject']),
            cleanHtml((string)$_POST['body_html']),
            max(1, min(500, (int)$_POST['daily_limit'])),
            in_array($_POST['status'] ?? 'draft', ['draft', 'active', 'paused'], true) ? $_POST['status'] : 'draft',
            date('c'),
        ];
        if ($id > 0) {
            $stmt = $pdo->prepare('UPDATE campaigns SET name=?, subject=?, body_html=?, daily_limit=?, status=?, updated_at=? WHERE id=?');
            $stmt->execute([...$data, $id]);
            return;
        }
        $stmt = $pdo->prepare('INSERT INTO campaigns (name, subject, body_html, daily_limit, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
        $stmt->execute([...$data, date('c')]);
        return;
    }

    if ($action === 'import_recipients') {
        importRecipients($pdo);
        return;
    }

    if ($action === 'test_send') {
        $campaign = findCampaign($pdo, (int)$_POST['campaign_id']);
        $email = trim((string)$_POST['test_email']);
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new RuntimeException('Testovaci email neni platny.');
        }
        (new SmtpMailer($config))->send($email, '[TEST] ' . $campaign['subject'], $campaign['body_html'], ['email' => $email, 'name' => 'Test']);
        return;
    }

    if ($action === 'send_batch') {
        sendBatch($pdo, $config, (int)$_POST['campaign_id']);
        return;
    }
}

function effectiveConfig(PDO $pdo, array $config): array
{
    $settings = $pdo->query('SELECT key, value FROM settings')->fetchAll(PDO::FETCH_KEY_PAIR);
    foreach (['from_email', 'from_name'] as $key) {
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
    return $config;
}

function saveSettings(PDO $pdo): void
{
    $allowed = ['from_email', 'from_name', 'smtp_host', 'smtp_port', 'smtp_username', 'smtp_password', 'smtp_encryption'];
    $stmt = $pdo->prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    foreach ($allowed as $key) {
        if ($key === 'smtp_password' && ($_POST[$key] ?? '') === '') {
            continue;
        }
        $stmt->execute([$key, trim((string)($_POST[$key] ?? ''))]);
    }
}

function importRecipients(PDO $pdo): void
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
    $emailIndex = array_search('email', $headers, true);
    $nameIndex = array_search('name', $headers, true);
    $rows = $emailIndex === false ? [$first] : [];
    while (($row = fgetcsv($handle, 0, ',')) !== false) {
        $rows[] = $row;
    }
    fclose($handle);

    $stmt = $pdo->prepare('INSERT INTO recipients (email, name, status, created_at) VALUES (?, ?, "active", ?) ON CONFLICT(email) DO UPDATE SET name=excluded.name, status="active"');
    foreach ($rows as $row) {
        $email = trim((string)($row[$emailIndex === false ? 0 : $emailIndex] ?? ''));
        $name = trim((string)($row[$nameIndex === false ? 1 : $nameIndex] ?? ''));
        if (filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $stmt->execute([$email, $name, date('c')]);
        }
    }
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
    $limit = max(0, (int)$campaign['daily_limit'] - $sentToday);
    if ($limit < 1) {
        return "Daily limit already reached.\n";
    }
    $stmt = $pdo->prepare('
        SELECT r.* FROM recipients r
        WHERE r.status="active"
        AND NOT EXISTS (SELECT 1 FROM send_logs l WHERE l.campaign_id=? AND l.recipient_id=r.id AND l.status="sent")
        ORDER BY r.id ASC LIMIT ?
    ');
    $stmt->bindValue(1, (int)$campaign['id'], PDO::PARAM_INT);
    $stmt->bindValue(2, $limit, PDO::PARAM_INT);
    $stmt->execute();
    $recipients = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $mailer = new SmtpMailer($config);
    $log = $pdo->prepare('INSERT INTO send_logs (campaign_id, recipient_id, email, status, message, sent_at) VALUES (?, ?, ?, ?, ?, ?)');
    $sent = 0;
    foreach ($recipients as $recipient) {
        try {
            $mailer->send($recipient['email'], $campaign['subject'], $campaign['body_html'], $recipient);
            $log->execute([$campaign['id'], $recipient['id'], $recipient['email'], 'sent', '', date('c')]);
            $sent++;
            usleep(300000);
        } catch (Throwable $e) {
            $log->execute([$campaign['id'], $recipient['id'], $recipient['email'], 'failed', substr($e->getMessage(), 0, 500), date('c')]);
        }
    }
    return "Sent $sent of " . count($recipients) . " selected recipients.\n";
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

function renderFlash(?array $flash): void
{
    if ($flash) {
        echo '<div class="flash ' . h($flash[0]) . '">' . h($flash[1]) . '</div>';
    }
}

function renderApp(PDO $pdo, ?array $flash): void
{
    global $config;
    $campaigns = $pdo->query('SELECT * FROM campaigns ORDER BY id DESC')->fetchAll(PDO::FETCH_ASSOC);
    $recipients = (int)$pdo->query('SELECT COUNT(*) FROM recipients WHERE status="active"')->fetchColumn();
    $logs = $pdo->query('SELECT l.*, c.name campaign FROM send_logs l LEFT JOIN campaigns c ON c.id=l.campaign_id ORDER BY l.id DESC LIMIT 20')->fetchAll(PDO::FETCH_ASSOC);
    $current = $campaigns[0] ?? ['id' => 0, 'name' => '', 'subject' => '', 'body_html' => '<p>Dobry den {{name}},</p><p>...</p>', 'daily_limit' => 100, 'status' => 'draft'];
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
<main>
    <?php renderFlash($flash); ?>
    <section class="stats">
        <div><span>Prijemci</span><strong><?= $recipients ?></strong></div>
        <div><span>Kampane</span><strong><?= count($campaigns) ?></strong></div>
        <div><span>Dnes limit</span><strong><?= h((string)$current['daily_limit']) ?></strong></div>
    </section>

    <section class="grid">
        <form method="post" class="panel campaign" id="campaignForm">
            <input type="hidden" name="action" value="save_campaign">
            <input type="hidden" name="id" value="<?= h((string)$current['id']) ?>">
            <input type="hidden" name="body_html" id="bodyHtml">
            <h2>Kampan</h2>
            <label>Nazev<input name="name" value="<?= h($current['name']) ?>" required></label>
            <label>Predmet<input name="subject" value="<?= h($current['subject']) ?>" required></label>
            <div class="row">
                <label>Denne max<input type="number" name="daily_limit" min="1" max="500" value="<?= h((string)$current['daily_limit']) ?>"></label>
                <label>Stav<select name="status"><option value="draft" <?= $current['status']==='draft'?'selected':'' ?>>Koncept</option><option value="active" <?= $current['status']==='active'?'selected':'' ?>>Aktivni</option><option value="paused" <?= $current['status']==='paused'?'selected':'' ?>>Pozastaveno</option></select></label>
            </div>
            <div class="toolbar"><button type="button" data-cmd="bold">B</button><button type="button" data-cmd="italic">I</button><button type="button" data-cmd="insertUnorderedList">List</button><button type="button" data-link>Link</button></div>
            <div id="editor" class="editor" contenteditable="true"><?= $current['body_html'] ?></div>
            <button>Ulozit kampan</button>
        </form>

        <div class="side">
            <form method="post" enctype="multipart/form-data" class="panel">
                <input type="hidden" name="action" value="import_recipients">
                <h2>Import prijemcu</h2>
                <p>CSV sloupce: email, name. Bez hlavicky vezmu prvni sloupec jako email.</p>
                <input type="file" name="csv" accept=".csv,text/csv" required>
                <button>Importovat</button>
            </form>

            <form method="post" class="panel">
                <input type="hidden" name="action" value="save_settings">
                <h2>Email ucet</h2>
                <label>Odesilatel email<input type="email" name="from_email" value="<?= h($config['from_email']) ?>" required></label>
                <label>Odesilatel jmeno<input name="from_name" value="<?= h($config['from_name']) ?>" required></label>
                <label>SMTP server<input name="smtp_host" value="<?= h($config['smtp']['host']) ?>" required></label>
                <div class="row">
                    <label>Port<input type="number" name="smtp_port" value="<?= h((string)$config['smtp']['port']) ?>" required></label>
                    <label>Sifrovani<select name="smtp_encryption"><option value="tls" <?= $config['smtp']['encryption']==='tls'?'selected':'' ?>>TLS</option><option value="ssl" <?= $config['smtp']['encryption']==='ssl'?'selected':'' ?>>SSL</option><option value="" <?= $config['smtp']['encryption']===''?'selected':'' ?>>Bez</option></select></label>
                </div>
                <label>SMTP uzivatel<input name="smtp_username" value="<?= h($config['smtp']['username']) ?>" required></label>
                <label>SMTP heslo<input type="password" name="smtp_password" placeholder="Nechat prazdne = nemenit"></label>
                <button>Ulozit email</button>
            </form>

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
</main>
<script src="assets/app.js"></script>
</body></html><?php
}
