<?php

declare(strict_types=1);

define('BTCDCA_GOOGLE_AUTH_LIB_ONLY', true);
require_once __DIR__ . '/btcdca-google-callback.php';

$flow = (string)($_POST['flow'] ?? 'login');
$flow = $flow === 'signup' ? 'signup' : 'login';
$_SESSION['btcdca_google_flow'] = $flow;

try {
    $configPath = __DIR__ . '/../btcdca-google-config.php';
    if (!is_file($configPath)) {
        throw new RuntimeException('Google login is not configured.');
    }
    $config = require $configPath;
    $google = requireGoogleConfig($config);

    $credential = trim((string)($_POST['credential'] ?? ''));
    if ($credential === '') {
        throw new RuntimeException('Google did not return an identity token.');
    }

    $profile = httpGetJson('https://oauth2.googleapis.com/tokeninfo?id_token=' . rawurlencode($credential), []);
    $audience = (string)($profile['aud'] ?? '');
    if (!hash_equals($google['client_id'], $audience)) {
        throw new RuntimeException('Google identity token was issued for a different client.');
    }
    $issuer = (string)($profile['iss'] ?? '');
    if ($issuer !== 'accounts.google.com' && $issuer !== 'https://accounts.google.com') {
        throw new RuntimeException('Google identity token issuer is invalid.');
    }

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

    unset($_SESSION['btcdca_google_error'], $_SESSION['btcdca_google_flow']);
    startUserSession($user, $email, $profile);
    header('Location: ' . successRedirect());
    exit;
} catch (Throwable $e) {
    $_SESSION['btcdca_google_error'] = $e->getMessage();
    unset($_SESSION['btcdca_google_flow']);
    header('Location: ' . ($flow === 'signup' ? '/signup-user.php' : '/login-user.php'));
    exit;
}
