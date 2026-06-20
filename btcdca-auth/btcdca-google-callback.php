<?php

declare(strict_types=1);

session_start();

$configPath = __DIR__ . '/../btcdca-google-config.php';
if (!is_file($configPath)) {
    renderAuthError('Google login is not configured.');
}

$config = require $configPath;

try {
    $google = requireGoogleConfig($config);
    if (($_GET['error'] ?? '') !== '') {
        throw new RuntimeException('Google login was cancelled.');
    }

    verifyState((string)($_GET['state'] ?? ''), $google['auth_secret']);
    $code = (string)($_GET['code'] ?? '');
    if ($code === '') {
        throw new RuntimeException('Google did not return an authorization code.');
    }

    $tokens = httpPostJson('https://oauth2.googleapis.com/token', [
        'code' => $code,
        'client_id' => $google['client_id'],
        'client_secret' => $google['client_secret'],
        'redirect_uri' => $google['redirect_uri'],
        'grant_type' => 'authorization_code',
    ]);
    $accessToken = (string)($tokens['access_token'] ?? '');
    if ($accessToken === '') {
        throw new RuntimeException('Google did not return an access token.');
    }

    $profile = httpGetJson('https://openidconnect.googleapis.com/v1/userinfo', [
        'Authorization: Bearer ' . $accessToken,
    ]);
    $email = strtolower(trim((string)($profile['email'] ?? '')));
    $verified = $profile['email_verified'] ?? false;
    if (!filter_var($email, FILTER_VALIDATE_EMAIL) || !($verified === true || $verified === 'true' || $verified === 1 || $verified === '1')) {
        throw new RuntimeException('Google account email is not verified.');
    }

    $pdo = db($config);
    $user = findUserByEmail($pdo, $email);
    if (!$user) {
        $user = createUserFromGoogle($pdo, $profile, $email);
    }
    if (!$user) {
        throw new RuntimeException('Could not create or find a BTC-DCA account for ' . $email . '.');
    }

    startUserSession($user, $email, $profile);
    header('Location: ' . successRedirect());
    exit;
} catch (Throwable $e) {
    renderAuthError($e->getMessage());
}

function requireGoogleConfig(array $config): array
{
    $google = [
        'client_id' => trim((string)($config['google_client_id'] ?? '')),
        'client_secret' => trim((string)($config['google_client_secret'] ?? '')),
        'redirect_uri' => trim((string)($config['google_redirect_uri'] ?? '')),
        'auth_secret' => trim((string)($config['auth_secret'] ?? '')),
    ];
    foreach ($google as $value) {
        if ($value === '') {
            throw new RuntimeException('Google login is not configured.');
        }
    }
    return $google;
}

function verifyState(string $state, string $secret): void
{
    $parts = explode('.', $state, 2);
    if (count($parts) !== 2) {
        throw new RuntimeException('Invalid Google login state.');
    }
    [$body, $signature] = $parts;
    $expected = base64UrlEncode(hash_hmac('sha256', $body, $secret, true));
    if (!hash_equals($expected, $signature)) {
        throw new RuntimeException('Invalid Google login signature.');
    }
    $payload = json_decode(base64UrlDecode($body), true);
    $sessionNonce = (string)($_SESSION['btcdca_google_nonce'] ?? '');
    unset($_SESSION['btcdca_google_nonce']);
    if (!is_array($payload) || $sessionNonce === '' || !hash_equals($sessionNonce, (string)($payload['nonce'] ?? ''))) {
        throw new RuntimeException('Google login expired. Please try again.');
    }
    if (time() - (int)($payload['iat'] ?? 0) > 600) {
        throw new RuntimeException('Google login expired. Please try again.');
    }
}

function db(array $config): PDO
{
    $dsn = 'mysql:host=' . ($config['db_host'] ?? 'LOCALHOST')
        . ';port=' . (int)($config['db_port'] ?? 3306)
        . ';dbname=' . ($config['db_name'] ?? '')
        . ';charset=utf8mb4';
    $pdo = new PDO($dsn, (string)($config['db_user'] ?? ''), (string)($config['db_password'] ?? ''), [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    return $pdo;
}

function findUserByEmail(PDO $pdo, string $email): ?array
{
    foreach (candidateTables($pdo) as $table) {
        $columns = tableColumns($pdo, $table);
        $emailColumn = firstExisting($columns, ['email', 'user_email', 'mail']);
        if ($emailColumn === null) {
            continue;
        }
        $stmt = $pdo->prepare('SELECT * FROM `' . str_replace('`', '``', $table) . '` WHERE `' . str_replace('`', '``', $emailColumn) . '`=? LIMIT 1');
        $stmt->execute([$email]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            $row['__table'] = $table;
            $row['__columns'] = $columns;
            return $row;
        }
    }
    return null;
}

function createUserFromGoogle(PDO $pdo, array $profile, string $email): ?array
{
    foreach (candidateTables($pdo) as $table) {
        $columns = tableColumns($pdo, $table);
        $emailColumn = firstExisting($columns, ['email', 'user_email', 'mail']);
        if ($emailColumn === null) {
            continue;
        }
        $data = buildInsertData($columns, $emailColumn, $email, $profile);
        if (!canInsertUser($pdo, $table, $data)) {
            continue;
        }
        $names = array_keys($data);
        $sql = 'INSERT INTO `' . str_replace('`', '``', $table) . '` (`'
            . implode('`,`', array_map(static function ($name) {
                return str_replace('`', '``', $name);
            }, $names))
            . '`) VALUES (' . implode(',', array_fill(0, count($names), '?')) . ')';
        try {
            $stmt = $pdo->prepare($sql);
            $stmt->execute(array_values($data));
        } catch (Throwable $e) {
            continue;
        }
        return findUserByEmail($pdo, $email);
    }
    return null;
}

function buildInsertData(array $columns, string $emailColumn, string $email, array $profile): array
{
    $now = date('Y-m-d H:i:s');
    $name = trim((string)($profile['name'] ?? ''));
    $given = trim((string)($profile['given_name'] ?? ''));
    $family = trim((string)($profile['family_name'] ?? ''));
    $passwordHash = password_hash(bin2hex(random_bytes(24)), PASSWORD_DEFAULT);
    $data = [$emailColumn => $email];
    foreach ($columns as $column => $meta) {
        if (array_key_exists($column, $data)) {
            continue;
        }
        $lower = strtolower($column);
        if (in_array($lower, ['name', 'full_name', 'display_name'], true)) {
            $data[$column] = $name !== '' ? $name : $email;
        } elseif (in_array($lower, ['username', 'user_name', 'login'], true)) {
            $data[$column] = preg_replace('/[^a-z0-9_.-]/i', '', strstr($email, '@', true) ?: $email) ?: $email;
        } elseif (in_array($lower, ['first_name', 'firstname'], true)) {
            $data[$column] = $given;
        } elseif (in_array($lower, ['last_name', 'lastname'], true)) {
            $data[$column] = $family;
        } elseif (in_array($lower, ['password', 'pass', 'password_hash', 'user_pass'], true)) {
            $data[$column] = $passwordHash;
        } elseif (in_array($lower, ['created_at', 'created', 'date_created', 'registered_at'], true)) {
            $data[$column] = $now;
        } elseif (in_array($lower, ['updated_at', 'updated', 'modified_at'], true)) {
            $data[$column] = $now;
        } elseif (in_array($lower, ['status', 'account_status'], true)) {
            $data[$column] = 'active';
        } elseif (in_array($lower, ['role', 'user_role'], true)) {
            $data[$column] = 'user';
        } elseif (in_array($lower, ['verified', 'email_verified', 'is_verified'], true)) {
            $data[$column] = 1;
        }
    }
    return $data;
}

function canInsertUser(PDO $pdo, string $table, array $data): bool
{
    $stmt = $pdo->prepare('
        SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?
    ');
    $stmt->execute([$table]);
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $column) {
        $name = (string)$column['COLUMN_NAME'];
        $extra = strtolower((string)$column['EXTRA']);
        if (isset($data[$name]) || (string)$column['IS_NULLABLE'] === 'YES' || $column['COLUMN_DEFAULT'] !== null || strpos($extra, 'auto_increment') !== false) {
            continue;
        }
        return false;
    }
    return true;
}

function candidateTables(PDO $pdo): array
{
    $preferred = ['users', 'user', 'accounts', 'members', 'customers'];
    $rows = $pdo->query("
        SELECT DISTINCT TABLE_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE()
          AND COLUMN_NAME IN ('email', 'user_email', 'mail')
    ")->fetchAll(PDO::FETCH_COLUMN);
    $tables = array_values(array_unique(array_merge($preferred, array_map('strval', $rows))));
    return array_values(array_filter($tables, static function ($table) use ($pdo) {
        return tableExists($pdo, $table);
    }));
}

function tableExists(PDO $pdo, string $table): bool
{
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?');
    $stmt->execute([$table]);
    return (int)$stmt->fetchColumn() > 0;
}

function tableColumns(PDO $pdo, string $table): array
{
    $stmt = $pdo->prepare('
        SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?
    ');
    $stmt->execute([$table]);
    $columns = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $column) {
        $columns[(string)$column['COLUMN_NAME']] = $column;
    }
    return $columns;
}

function firstExisting(array $columns, array $names): ?string
{
    foreach ($names as $name) {
        if (array_key_exists($name, $columns)) {
            return $name;
        }
    }
    return null;
}

function startUserSession(array $user, string $email, array $profile): void
{
    $id = (string)($user['id'] ?? $user['user_id'] ?? $user['ID'] ?? '');
    $name = (string)($user['name'] ?? $user['full_name'] ?? $profile['name'] ?? $email);
    $_SESSION['user_id'] = $id;
    $_SESSION['id'] = $id;
    $_SESSION['email'] = $email;
    $_SESSION['user_email'] = $email;
    $_SESSION['name'] = $name;
    $_SESSION['user_name'] = $name;
    $_SESSION['loggedin'] = true;
    $_SESSION['logged_in'] = true;
    $_SESSION['login'] = true;
    $_SESSION['auth'] = true;
    $_SESSION['auth_provider'] = 'google';
}

function successRedirect(): string
{
    $loginSource = @file_get_contents(__DIR__ . '/login-user.php') ?: '';
    if (preg_match_all('/header\s*\(\s*[\'"]Location:\s*([^\'"]+)/i', $loginSource, $matches)) {
        foreach ($matches[1] as $target) {
            $target = trim((string)$target);
            if ($target !== '' && stripos($target, 'login-user.php') === false) {
                return $target;
            }
        }
    }
    foreach (['dashboard.php', 'portfolio.php', 'user-dashboard.php', 'index.php'] as $target) {
        if (is_file(__DIR__ . '/' . $target)) {
            return $target;
        }
    }
    return 'https://www.btc-dca.com/';
}

function httpPostJson(string $url, array $fields): array
{
    return httpJson($url, 'POST', ['Content-Type: application/x-www-form-urlencoded'], http_build_query($fields, '', '&', PHP_QUERY_RFC3986));
}

function httpGetJson(string $url, array $headers): array
{
    return httpJson($url, 'GET', $headers, null);
}

function httpJson(string $url, string $method, array $headers, ?string $body): array
{
    $ch = curl_init($url);
    if (!$ch) {
        throw new RuntimeException('Could not initialize HTTP request.');
    }
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
        throw new RuntimeException('HTTP request failed: ' . $error);
    }
    $json = json_decode((string)$response, true);
    if (!is_array($json)) {
        throw new RuntimeException('Invalid HTTP response.');
    }
    if ($status < 200 || $status >= 300) {
        throw new RuntimeException((string)($json['error_description'] ?? $json['error'] ?? 'HTTP request failed.'));
    }
    return $json;
}

function base64UrlEncode(string $value): string
{
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

function base64UrlDecode(string $value): string
{
    $value = strtr($value, '-_', '+/');
    $value .= str_repeat('=', (4 - strlen($value) % 4) % 4);
    return base64_decode($value, true) ?: '';
}

function renderAuthError(string $message): void
{
    $_SESSION['btcdca_google_error'] = $message;
    header('Location: /login-user.php');
    exit;
}
