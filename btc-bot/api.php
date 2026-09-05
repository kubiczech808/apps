<?php
/**
 * BTC price-action bot — server side.
 *
 * Deliberately small. It holds no strategy and places no orders; it is the one
 * place the Raspberry Pi runner, the GitHub Actions fallback and the browser
 * can all reach, so it arbitrates between them and stores what they agree on.
 *
 * Responsibilities, and nothing else:
 *   state     serve the published run state (settings merged in from their own
 *             file, which the bot may read but never overwrite)
 *   publish   accept a new run state from a runner
 *   lease     hand exactly one runner the right to act for a while
 *   settings  accept an edit from the dashboard
 *   command   queue an operator action for the next pass to carry out
 *
 * Everything requires the shared key. The state names an account balance and
 * open positions, so there is no read that is safe to leave open on a public
 * domain.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const DATA_DIR = __DIR__ . '/data';
const STATE_FILE = DATA_DIR . '/bot-state.json';
const SETTINGS_FILE = DATA_DIR . '/settings.json';
const LEASE_FILE = DATA_DIR . '/lease.json';
const COMMANDS_FILE = DATA_DIR . '/commands.json';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function fail(int $status, string $message): void
{
    http_response_code($status);
    echo json_encode(['ok' => false, 'error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function ok(array $payload = []): void
{
    echo json_encode(['ok' => true] + $payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function config(): array
{
    static $config = null;
    if ($config === null) {
        $path = __DIR__ . '/config.php';
        $config = is_readable($path) ? (require $path) : [];
        if (!is_array($config)) {
            $config = [];
        }
    }
    return $config;
}

/**
 * Is the configured key one that is published in the repository?
 *
 * Kept in step with PUBLIC_DEV_KEYS in src/keys.mjs — the runner enforces the
 * same rule, and the two lists must agree or one of them becomes a way in.
 */
function keyIsPublic(): bool
{
    return in_array((string) (config()['bot_key'] ?? ''), ['ahoj1234567890'], true);
}

/**
 * Constant-time key check.
 *
 * hash_equals rather than === so a wrong key cannot be discovered one byte at a
 * time by timing the response, and the key is read from a header rather than a
 * query parameter so it does not end up in the hosting's access log.
 */
function requireKey(): void
{
    $expected = (string) (config()['bot_key'] ?? '');
    if ($expected === '') {
        fail(503, 'The server has no bot key configured yet — deploy has not run or the secret is missing.');
    }
    $provided = (string) ($_SERVER['HTTP_X_BOT_KEY'] ?? '');
    if ($provided === '' || !hash_equals($expected, $provided)) {
        fail(401, 'Invalid or missing X-Bot-Key.');
    }
}

function readJsonFile(string $path, $fallback = null)
{
    if (!is_readable($path)) {
        return $fallback;
    }
    $raw = file_get_contents($path);
    if ($raw === false || $raw === '') {
        return $fallback;
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : $fallback;
}

/**
 * Write through a temporary file in the same directory, then rename.
 *
 * rename() is atomic within a filesystem, so a reader never sees half a
 * document — which matters because the dashboard polls this file while a runner
 * is writing it, and a truncated read would look exactly like the bot losing
 * all its positions.
 */
function writeJsonFile(string $path, array $value): void
{
    if (!is_dir(DATA_DIR) && !mkdir(DATA_DIR, 0775, true) && !is_dir(DATA_DIR)) {
        fail(500, 'Data directory could not be created.');
    }
    $temporary = $path . '.tmp' . bin2hex(random_bytes(4));
    $encoded = json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($encoded === false || file_put_contents($temporary, $encoded, LOCK_EX) === false) {
        @unlink($temporary);
        fail(500, 'Could not write ' . basename($path) . '.');
    }
    if (!rename($temporary, $path)) {
        @unlink($temporary);
        fail(500, 'Could not replace ' . basename($path) . '.');
    }
}

function requestBody(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    if (strlen($raw) > MAX_BODY_BYTES) {
        fail(413, 'Payload too large.');
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        fail(400, 'Body must be a JSON object.');
    }
    return $decoded;
}

function requirePost(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        fail(405, 'This action requires POST.');
    }
}

$action = (string) ($_GET['action'] ?? 'state');

if ($action === 'health') {
    ok([
        'service' => 'btc-bot',
        'configured' => (string) (config()['bot_key'] ?? '') !== '',
        // Public here is deliberate: it is not a secret that the key is not a
        // secret, and the dashboard needs it to explain why mainnet is locked.
        'keyIsPublic' => keyIsPublic(),
        'hasState' => is_readable(STATE_FILE),
        'serverTime' => gmdate('c'),
    ]);
}

requireKey();

switch ($action) {
    case 'state': {
        $state = readJsonFile(STATE_FILE, null);
        $settings = readJsonFile(SETTINGS_FILE, null);
        if (is_array($state) && is_array($settings)) {
            // The settings file is the authority. A runner publishes the
            // settings it ran with, and echoing those back would silently undo
            // an edit made from the dashboard between two passes.
            $state['settings'] = $settings;
        }
        ok([
            'state' => $state,
            'settings' => $settings,
            'commands' => readJsonFile(COMMANDS_FILE, []),
            'keyIsPublic' => keyIsPublic(),
        ]);
    }

    case 'publish': {
        requirePost();
        $state = requestBody();
        if (!isset($state['version'])) {
            fail(400, 'State document is missing its version.');
        }
        writeJsonFile(STATE_FILE, $state);
        // A pass consumes the queue as it publishes; clearing it here rather
        // than in a separate call means a command cannot be executed twice by a
        // runner that crashed between the two.
        if (!empty($state['consumedCommands'])) {
            writeJsonFile(COMMANDS_FILE, []);
        }
        ok(['bytes' => filesize(STATE_FILE) ?: 0]);
    }

    case 'lease': {
        requirePost();
        $body = requestBody();
        $owner = (string) ($body['owner'] ?? '');
        $ttl = (int) ($body['ttlMs'] ?? 90000);
        if ($owner === '') {
            fail(400, 'A lease needs an owner.');
        }
        $ttl = max(10000, min($ttl, 900000));

        $now = (int) round(microtime(true) * 1000);
        $current = readJsonFile(LEASE_FILE, null);
        $heldBySomeoneElse = is_array($current)
            && ($current['owner'] ?? '') !== $owner
            && (int) ($current['expiresAt'] ?? 0) > $now;

        if ($heldBySomeoneElse) {
            ok([
                'granted' => false,
                'owner' => (string) $current['owner'],
                'expiresAt' => (int) $current['expiresAt'],
            ]);
        }

        writeJsonFile(LEASE_FILE, ['owner' => $owner, 'expiresAt' => $now + $ttl, 'grantedAt' => $now]);
        ok(['granted' => true, 'owner' => $owner, 'expiresAt' => $now + $ttl]);
    }

    case 'settings': {
        requirePost();
        $settings = requestBody();
        if ($settings === []) {
            fail(400, 'No settings supplied.');
        }
        // A key published in a public repository may guard a simulation; it may
        // not guard an account. The runner refuses to trade live on one too —
        // both, because either check alone leaves the other as a way in. This
        // one exists so the dashboard says why instead of appearing to accept
        // the change and silently staying on paper.
        if (($settings['mode'] ?? '') === 'mainnet' && keyIsPublic()) {
            fail(
                403,
                'Ostrý provoz je zamčený: klíč k dashboardu je ten, který je veřejně v repozitáři. '
                . 'Nastav secret BTC_BOT_KEY (má přednost před odvozeným) a nasaď znovu.'
            );
        }
        $existing = readJsonFile(SETTINGS_FILE, []);
        writeJsonFile(SETTINGS_FILE, array_replace_recursive(is_array($existing) ? $existing : [], $settings));
        ok(['settings' => readJsonFile(SETTINGS_FILE, [])]);
    }

    case 'command': {
        requirePost();
        $body = requestBody();
        $name = (string) ($body['command'] ?? '');
        $allowed = ['close', 'cancel', 'flatten', 'run-now'];
        if (!in_array($name, $allowed, true)) {
            fail(400, 'Unknown command. Allowed: ' . implode(', ', $allowed));
        }
        $queue = readJsonFile(COMMANDS_FILE, []);
        if (!is_array($queue)) {
            $queue = [];
        }
        if (count($queue) >= 20) {
            fail(429, 'Command queue is full; wait for the bot to drain it.');
        }
        $queue[] = [
            'command' => $name,
            'id' => isset($body['id']) ? (string) $body['id'] : null,
            'queuedAt' => gmdate('c'),
        ];
        writeJsonFile(COMMANDS_FILE, $queue);
        ok(['queued' => count($queue)]);
    }

    default:
        fail(404, 'Unknown action: ' . $action);
}
