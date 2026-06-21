<?php

declare(strict_types=1);

session_start();

$configPath = __DIR__ . '/../btcdca-google-config.php';
if (!is_file($configPath)) {
    http_response_code(500);
    exit('Google login is not configured.');
}

$config = require $configPath;
$clientId = trim((string)($config['google_client_id'] ?? ''));
$redirectUri = trim((string)($config['google_redirect_uri'] ?? ''));
$authSecret = trim((string)($config['auth_secret'] ?? ''));

if ($clientId === '' || $redirectUri === '' || $authSecret === '') {
    http_response_code(500);
    exit('Google login is not configured.');
}

$flow = (string)($_GET['flow'] ?? 'login');
$flow = $flow === 'signup' ? 'signup' : 'login';

$statePayload = base64UrlEncode(json_encode([
    'nonce' => bin2hex(random_bytes(16)),
    'iat' => time(),
    'flow' => $flow,
], JSON_UNESCAPED_SLASHES) ?: '{}');
$stateSignature = base64UrlEncode(hash_hmac('sha256', $statePayload, $authSecret, true));

$params = [
    'client_id' => $clientId,
    'redirect_uri' => $redirectUri,
    'response_type' => 'code',
    'scope' => 'openid email profile',
    'state' => $statePayload . '.' . $stateSignature,
    'prompt' => 'select_account',
];

header('Location: https://accounts.google.com/o/oauth2/v2/auth?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986));
exit;

function base64UrlEncode(string $value): string
{
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}
