<?php
/**
 * Ephemeral JAMU apply bridge.
 * Inert without the one-time request header and self-removes after success.
 */

defined('ABSPATH') || exit;

$jamu_presented = (string) ($_SERVER['HTTP_X_JAMU_BRIDGE'] ?? '');
if ($jamu_presented === '' || !hash_equals('__JAMU_TOKEN_HASH__', hash('sha256', $jamu_presented))) {
    return;
}

add_action('wp_loaded', static function (): void {
    if (($_GET['jamu_bridge'] ?? '') !== 'apply_translations') {
        return;
    }

    nocache_headers();
    header('Content-Type: application/json; charset=UTF-8');

    $payload_path = WP_CONTENT_DIR . '/' . ltrim('__JAMU_PAYLOAD_RELATIVE__', '/');

    register_shutdown_function(static function () use ($payload_path): void {
        @unlink($payload_path);
        @unlink(__FILE__);
    });

    $send = static function (array $payload, int $status = 200): void {
        status_header($status);
        echo wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    };

    if (!function_exists('activate_plugin') || !function_exists('is_plugin_active')) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }

    $plugin_file = 'jamu-multilingual/jamu-multilingual.php';
    $plugin_path = WP_PLUGIN_DIR . '/' . $plugin_file;
    if (!is_readable($plugin_path)) {
        $send(['ok' => false, 'error' => 'JAMU multilingual plugin is not uploaded.'], 500);
    }

    if (!is_plugin_active($plugin_file)) {
        $activated = activate_plugin($plugin_file, '', false, true);
        if (is_wp_error($activated)) {
            $send(['ok' => false, 'error' => $activated->get_error_message()], 500);
        }
    }

    if (!class_exists('\\Jamu\\Multilingual\\Repository')) {
        require_once $plugin_path;
    }
    if (!class_exists('\\Jamu\\Multilingual\\Repository') || !class_exists('\\Jamu\\Multilingual\\Installer')) {
        $send(['ok' => false, 'error' => 'JAMU plugin classes are unavailable after activation.'], 500);
    }

    \Jamu\Multilingual\Installer::activate();

    if (!is_readable($payload_path)) {
        $send(['ok' => false, 'error' => 'Translation payload is missing.'], 500);
    }

    $payload = json_decode((string) file_get_contents($payload_path), true);
    if (!is_array($payload) || !is_array($payload['translations'] ?? null)) {
        $send(['ok' => false, 'error' => 'Invalid translation payload.'], 400);
    }

    $sanitize_markup = static function (string $value): string {
        $comments = [];
        $placeholder_prefix = 'jamu_ml_block_comment_';
        $value = preg_replace_callback('/<!--\s*\/?wp:[\s\S]*?-->/', static function (array $match) use (&$comments, $placeholder_prefix): string {
            $placeholder = $placeholder_prefix . count($comments) . '_';
            $comments[$placeholder] = $match[0];
            return $placeholder;
        }, $value) ?? $value;

        $value = wp_kses_post($value);
        return strtr($value, $comments);
    };

    $sanitize_translation = static function (array $row) use ($sanitize_markup): array {
        return [
            'object_type' => sanitize_key($row['object_type'] ?? ''),
            'object_subtype' => sanitize_key($row['object_subtype'] ?? ''),
            'object_id' => absint($row['object_id'] ?? 0),
            'language' => sanitize_key($row['language'] ?? ''),
            'route_path' => sanitize_text_field($row['route_path'] ?? ''),
            'slug' => sanitize_title($row['slug'] ?? ''),
            'title' => sanitize_text_field($row['title'] ?? ''),
            'excerpt' => $sanitize_markup((string) ($row['excerpt'] ?? '')),
            'content' => $sanitize_markup((string) ($row['content'] ?? '')),
            'seo_title' => sanitize_text_field($row['seo_title'] ?? ''),
            'meta_description' => sanitize_textarea_field($row['meta_description'] ?? ''),
            'data' => is_array($row['data'] ?? null) ? $row['data'] : [],
            'status' => ($row['status'] ?? '') === 'publish' ? 'publish' : 'draft',
        ];
    };

    $repository = new \Jamu\Multilingual\Repository();
    $saved = 0;
    $errors = [];
    $counts = ['en' => 0, 'de' => 0, 'pl' => 0];

    foreach ($payload['translations'] as $row) {
        if (!is_array($row)) {
            continue;
        }
        $translation = $sanitize_translation($row);
        $result = $repository->save($translation);
        if (is_wp_error($result)) {
            $errors[] = $result->get_error_message();
            continue;
        }
        if ($result) {
            $saved++;
            if (isset($counts[$translation['language']])) {
                $counts[$translation['language']]++;
            }
        }
    }

    flush_rewrite_rules(false);
    update_option('jamu_ml_last_import', [
        'imported_at' => gmdate('c'),
        'saved' => $saved,
        'counts' => $counts,
        'generator' => $payload['generator'] ?? '',
    ], false);

    $response = [
        'ok' => $errors === [],
        'site' => home_url('/'),
        'plugin_active' => is_plugin_active($plugin_file),
        'saved' => $saved,
        'counts' => $counts,
        'errors' => array_values(array_unique($errors)),
    ];
    $send($response, $errors === [] ? 200 : 500);
}, 999);
