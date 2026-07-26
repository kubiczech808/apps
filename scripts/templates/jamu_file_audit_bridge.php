<?php
/**
 * Ephemeral JAMU file-count audit bridge.
 * Inert without the one-time nonce and header; self-removes after authorized use.
 */

$nonce = '__JAMU_FILE_AUDIT_NONCE__';

if (($_GET['jamu_bridge'] ?? '') !== 'file_audit') {
    http_response_code(404);
    exit;
}
if (!hash_equals($nonce, (string) ($_GET['jamu_nonce'] ?? ''))) {
    http_response_code(403);
    exit;
}
if (!hash_equals($nonce, (string) ($_SERVER['HTTP_X_JAMU_FILE_AUDIT_TOKEN'] ?? ''))) {
    http_response_code(403);
    exit;
}

register_shutdown_function(static function (): void {
    if (is_file(__FILE__)) {
        @unlink(__FILE__);
    }
});

set_time_limit(180);
ignore_user_abort(true);

require_once __DIR__ . '/wp-load.php';

function jamu_file_audit_prefixes(string $relative, int $max_depth = 5): array
{
    $parts = array_values(array_filter(explode('/', trim($relative, '/')), static fn ($part): bool => $part !== ''));
    $prefixes = [];
    $limit = min($max_depth, count($parts));
    for ($depth = 1; $depth <= $limit; $depth++) {
        $prefixes[] = implode('/', array_slice($parts, 0, $depth));
    }
    return $prefixes;
}

function jamu_file_audit_top(array $counter, int $limit = 80): array
{
    arsort($counter);
    $rows = [];
    foreach (array_slice($counter, 0, $limit, true) as $path => $count) {
        $rows[] = ['path' => (string) $path, 'count' => (int) $count];
    }
    return $rows;
}

function jamu_file_audit_active_plugin_slugs(): array
{
    $plugins = (array) get_option('active_plugins', []);
    if (is_multisite()) {
        $plugins = array_merge($plugins, array_keys((array) get_site_option('active_sitewide_plugins', [])));
    }
    $slugs = [];
    foreach ($plugins as $plugin_file) {
        $plugin_file = trim((string) $plugin_file, '/');
        if (str_contains($plugin_file, '/')) {
            $slugs[] = explode('/', $plugin_file, 2)[0];
        }
    }
    return array_values(array_unique($slugs));
}

function jamu_file_audit_candidate(string $relative, bool $is_dir, array $active_plugin_slugs): array
{
    $lower = strtolower(trim($relative, '/'));
    $parts = $lower === '' ? [] : explode('/', $lower);
    if ($lower === '') {
        return ['', ''];
    }
    if (str_contains($lower, '/cache/') || str_ends_with($lower, '/cache') || str_starts_with($lower, 'wp-content/cache') || str_starts_with($lower, 'wp-content/upgrade')) {
        return ['low', 'cache_or_upgrade'];
    }
    foreach (['backup', 'backups', 'updraft', 'ai1wm-backups'] as $needle) {
        if (str_contains($lower, $needle)) {
            return ['medium', 'backup_like'];
        }
    }
    if (str_contains($lower, '.jamu-multilingual-incoming-') || str_contains($lower, '.jamu-multilingual-previous-')) {
        return ['low', 'stale_jamu_deploy_temp'];
    }
    foreach (['.zip', '.tar', '.tar.gz', '.tgz', '.bak', '.old', '.log'] as $suffix) {
        if (str_ends_with($lower, $suffix)) {
            return ['medium', 'archive_or_log_file'];
        }
    }
    if (count($parts) >= 3 && $parts[0] === 'wp-content' && $parts[1] === 'plugins') {
        $slug = $parts[2];
        if ($slug !== '' && !in_array($slug, $active_plugin_slugs, true)) {
            return ['medium', 'inactive_plugin_directory'];
        }
    }
    if (count($parts) >= 3 && $parts[0] === 'wp-content' && $parts[1] === 'uploads') {
        return ['high', 'uploads_media'];
    }
    if ((count($parts) >= 2 && $parts[0] === 'wp-content' && $parts[1] === 'themes') || in_array($parts[0] ?? '', ['wp-admin', 'wp-includes'], true)) {
        return ['high', 'wordpress_runtime'];
    }
    return ['', ''];
}

function jamu_file_audit_increment(array &$counter, string $key, int $by = 1): void
{
    if ($key === '') {
        return;
    }
    if (!isset($counter[$key])) {
        $counter[$key] = 0;
    }
    $counter[$key] += $by;
}

$root = wp_normalize_path(ABSPATH);
$active_plugin_slugs = jamu_file_audit_active_plugin_slugs();

$total_files = 0;
$total_dirs = 0;
$total_bytes = 0;
$file_prefix_counts = [];
$dir_prefix_counts = [];
$byte_prefix_counts = [];
$extension_counts = [];
$plugin_file_counts = [];
$plugin_byte_counts = [];
$candidate_counts = [];
$candidate_bytes = [];
$candidate_meta = [];
$errors = [];

$flags = FilesystemIterator::SKIP_DOTS;
$iterator = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($root, $flags),
    RecursiveIteratorIterator::SELF_FIRST
);

foreach ($iterator as $item) {
    try {
        $path = wp_normalize_path($item->getPathname());
        $relative = ltrim(substr($path, strlen($root)), '/');
        if ($relative === '') {
            continue;
        }
        $is_dir = $item->isDir();
        if ($is_dir) {
            $total_dirs++;
            foreach (jamu_file_audit_prefixes($relative) as $prefix) {
                jamu_file_audit_increment($dir_prefix_counts, $prefix);
            }
            [$risk, $reason] = jamu_file_audit_candidate($relative, true, $active_plugin_slugs);
            if ($risk !== '' && !isset($candidate_meta[$relative])) {
                $candidate_meta[$relative] = ['risk' => $risk, 'reason' => $reason];
            }
            continue;
        }
        if (!$item->isFile()) {
            continue;
        }
        $total_files++;
        $size = (int) $item->getSize();
        $total_bytes += $size;
        $extension = strtolower(pathinfo($relative, PATHINFO_EXTENSION));
        jamu_file_audit_increment($extension_counts, $extension !== '' ? '.' . $extension : '[no extension]');
        $prefixes = jamu_file_audit_prefixes($relative);
        foreach ($prefixes as $prefix) {
            jamu_file_audit_increment($file_prefix_counts, $prefix);
            jamu_file_audit_increment($byte_prefix_counts, $prefix, $size);
        }
        $parts = explode('/', $relative);
        if (count($parts) >= 3 && $parts[0] === 'wp-content' && $parts[1] === 'plugins') {
            jamu_file_audit_increment($plugin_file_counts, $parts[2]);
            jamu_file_audit_increment($plugin_byte_counts, $parts[2], $size);
        }
        [$risk, $reason] = jamu_file_audit_candidate($relative, false, $active_plugin_slugs);
        if ($risk !== '' && $prefixes) {
            $candidate_path = $prefixes[min(count($prefixes), 3) - 1];
            jamu_file_audit_increment($candidate_counts, $candidate_path);
            jamu_file_audit_increment($candidate_bytes, $candidate_path, $size);
            if (!isset($candidate_meta[$candidate_path])) {
                $candidate_meta[$candidate_path] = ['risk' => $risk, 'reason' => $reason];
            }
        }
    } catch (Throwable $exception) {
        $errors[] = ['path' => isset($relative) ? $relative : '', 'error' => substr($exception->getMessage(), 0, 240)];
    }
}

arsort($plugin_file_counts);
$plugin_summary = [];
foreach (array_slice($plugin_file_counts, 0, 80, true) as $slug => $files) {
    $plugin_summary[] = [
        'slug' => (string) $slug,
        'files' => (int) $files,
        'bytes' => (int) ($plugin_byte_counts[$slug] ?? 0),
        'active' => in_array($slug, $active_plugin_slugs, true),
    ];
}

arsort($candidate_counts);
$candidate_summary = [];
foreach (array_slice($candidate_counts, 0, 80, true) as $path => $files) {
    $meta = $candidate_meta[$path] ?? ['risk' => '', 'reason' => ''];
    $candidate_summary[] = [
        'path' => (string) $path,
        'files' => (int) $files,
        'bytes' => (int) ($candidate_bytes[$path] ?? 0),
        'risk' => $meta['risk'],
        'reason' => $meta['reason'],
    ];
}

$report = [
    'generated_at' => gmdate('c'),
    'site' => home_url('/'),
    'wordpress_root' => $root,
    'total_files' => $total_files,
    'total_dirs' => $total_dirs,
    'total_bytes' => $total_bytes,
    'active_plugin_slugs' => $active_plugin_slugs,
    'top_file_prefixes' => jamu_file_audit_top($file_prefix_counts),
    'top_dir_prefixes' => jamu_file_audit_top($dir_prefix_counts),
    'top_byte_prefixes' => jamu_file_audit_top($byte_prefix_counts),
    'extension_counts' => jamu_file_audit_top($extension_counts),
    'plugin_file_counts' => $plugin_summary,
    'cleanup_candidates_read_only' => $candidate_summary,
    'errors' => array_slice($errors, 0, 80),
    'scope' => 'server-side read-only file count audit; no target files changed',
];

header('Content-Type: application/json; charset=utf-8');
echo wp_json_encode($report, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
