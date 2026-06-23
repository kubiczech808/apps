<?php

declare(strict_types=1);

session_start();

if (!defined('BTCDCA_GOOGLE_AUTH_LIB_ONLY')) {
    $configPath = __DIR__ . '/../btcdca-google-config.php';
    if (!is_file($configPath)) {
        renderAuthError('Google login is not configured.');
    }

    $config = require $configPath;

    try {
        $google = requireGoogleConfig($config);
        $callbackParams = callbackParams();
        if (!$callbackParams) {
            $_SESSION['btcdca_google_error'] = 'Google login did not return an authorization code. Please try again.';
            logEmptyCallback();
            renderFragmentBridge();
        }
        if (($callbackParams['error'] ?? '') !== '') {
            throw new RuntimeException('Google returned an error: ' . safeCallbackValue((string)$callbackParams['error']));
        }

        $state = readState((string)($callbackParams['state'] ?? ''), $google['auth_secret']);
        $_SESSION['btcdca_google_flow'] = (string)($state['flow'] ?? 'login');
        $code = (string)($callbackParams['code'] ?? '');
        if ($code === '') {
            throw new RuntimeException('Google did not return an authorization code. Callback keys: ' . callbackParamSummary($callbackParams));
        }
        unset($_SESSION['btcdca_google_error']);

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
        $isNewUser = !$user;
        if (!$user) {
            $user = createUserFromGoogle($pdo, $profile, $email);
        }
        if (!$user) {
            throw new RuntimeException('Could not create or find a BTC-DCA account for ' . $email . '.');
        }

        startUserSession($user, $email, $profile);
        header('Location: ' . successRedirect($isNewUser));
        exit;
    } catch (Throwable $e) {
        renderAuthError($e->getMessage());
    }
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

function callbackParams(): array
{
    $params = $_GET;
    foreach ($_POST as $key => $value) {
        if (!array_key_exists($key, $params)) {
            $params[$key] = is_array($value) ? reset($value) : $value;
        }
    }
    $queryStrings = [
        (string)($_SERVER['QUERY_STRING'] ?? ''),
        (string)($_SERVER['REDIRECT_QUERY_STRING'] ?? ''),
    ];
    $requestUri = (string)($_SERVER['REQUEST_URI'] ?? '');
    $requestQuery = (string)(parse_url($requestUri, PHP_URL_QUERY) ?: '');
    if ($requestQuery !== '') {
        $queryStrings[] = $requestQuery;
    }

    foreach ($queryStrings as $queryString) {
        if ($queryString === '') {
            continue;
        }
        $parsed = [];
        parse_str($queryString, $parsed);
        foreach ($parsed as $key => $value) {
            if (!array_key_exists($key, $params)) {
                $params[$key] = is_array($value) ? reset($value) : $value;
            }
        }
    }

    return $params;
}

function callbackParamSummary(array $params): string
{
    $keys = array_keys($params);
    sort($keys);
    $safeKeys = [];
    foreach ($keys as $key) {
        $safeKey = preg_replace('/[^a-zA-Z0-9_.-]/', '', (string)$key);
        if ($safeKey !== '') {
            $safeKeys[] = $safeKey;
        }
    }

    $summary = $safeKeys ? implode(', ', $safeKeys) : 'none';
    $details = [];
    foreach (['error', 'error_description'] as $detailKey) {
        $value = trim((string)($params[$detailKey] ?? ''));
        if ($value !== '') {
            $details[] = $detailKey . '=' . safeCallbackValue($value);
        }
    }

    return $details ? $summary . ' (' . implode('; ', $details) . ')' : $summary;
}

function safeCallbackValue(string $value): string
{
    $value = preg_replace('/[^a-zA-Z0-9 ._:-]/', '', $value) ?: '';
    return substr(trim($value), 0, 160);
}

function renderFragmentBridge(): void
{
    header('Content-Type: text/html; charset=UTF-8');
    echo <<<'HTML'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Completing Google login</title>
</head>
<body>
  <p>Completing Google login...</p>
  <script>
    (function () {
      var hash = window.location.hash ? window.location.hash.substring(1) : '';
      if (hash && /(^|&)(code|error|state)=/.test(hash)) {
        window.location.replace(window.location.pathname + '?' + hash);
        return;
      }
      window.location.replace('/login-user');
    }());
  </script>
  <noscript>
    <p>Google login could not be completed. Please enable JavaScript and try again.</p>
    <p><a href="/login-user">Back to login</a></p>
  </noscript>
</body>
</html>
HTML;
    exit;
}

function logEmptyCallback(): void
{
    $line = json_encode([
        'time' => gmdate('c'),
        'event' => 'empty_google_callback',
        'method' => (string)($_SERVER['REQUEST_METHOD'] ?? ''),
        'request_uri' => (string)($_SERVER['REQUEST_URI'] ?? ''),
        'query_string' => (string)($_SERVER['QUERY_STRING'] ?? ''),
        'post_keys' => implode(',', array_keys($_POST)),
        'referer_host' => parse_url((string)($_SERVER['HTTP_REFERER'] ?? ''), PHP_URL_HOST) ?: '',
        'user_agent' => substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 180),
        'session' => substr(session_id(), 0, 12),
    ], JSON_UNESCAPED_SLASHES);
    if ($line !== false) {
        @file_put_contents(__DIR__ . '/../btcdca-google-oauth.log', $line . PHP_EOL, FILE_APPEND | LOCK_EX);
    }
}

function readState(string $state, string $secret): array
{
    $parts = explode('.', $state, 2);
    if (count($parts) !== 2) {
        return ['flow' => 'login'];
    }
    [$body, $signature] = $parts;
    $expected = base64UrlEncode(hash_hmac('sha256', $body, $secret, true));
    if (!hash_equals($expected, $signature)) {
        return unsignedStatePayload($body);
    }
    $payload = json_decode(base64UrlDecode($body), true);
    if (!is_array($payload) || (string)($payload['nonce'] ?? '') === '') {
        return ['flow' => 'login'];
    }
    if (time() - (int)($payload['iat'] ?? 0) > 600) {
        return ['flow' => (string)($payload['flow'] ?? 'login')];
    }
    return $payload;
}

function unsignedStatePayload(string $body): array
{
    $payload = json_decode(base64UrlDecode($body), true);
    if (!is_array($payload)) {
        return ['flow' => 'login'];
    }
    $flow = (string)($payload['flow'] ?? 'login');
    return ['flow' => $flow === 'signup' ? 'signup' : 'login'];
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

function successRedirect(bool $isNewUser = false): string
{
    return $isNewUser ? 'https://www.btc-dca.com/app/overview' : 'https://www.btc-dca.com/app/';
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
    $flow = (string)($_SESSION['btcdca_google_flow'] ?? '');
    unset($_SESSION['btcdca_google_flow']);
    header('Location: ' . ($flow === 'signup' ? '/signup-user' : '/login-user'));
    exit;
}
