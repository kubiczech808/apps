<?php
/**
 * Ephemeral, read-only JAMU frontend performance audit bridge.
 *
 * It is inert without the signed request header. For an authorized request it
 * lets the requested page run normally, discards its rendered HTML at shutdown
 * and returns only coarse execution metrics. The invoking audit removes the
 * temporary file after all requested pages have been sampled.
 */

defined('ABSPATH') || exit;

$jamu_performance_token = (string) ($_SERVER['HTTP_X_JAMU_BRIDGE'] ?? $_SERVER['HTTP_X_JAMU_PERFORMANCE_AUDIT'] ?? '');
if ($jamu_performance_token === ''
    || !hash_equals('__JAMU_TOKEN_HASH__', hash('sha256', $jamu_performance_token))) {
    return;
}

ob_start();

add_action('shutdown', static function (): void {
    global $wpdb, $wp_scripts, $wp_styles, $wp_object_cache;

    $num_queries = isset($wpdb->num_queries) ? (int) $wpdb->num_queries : null;
    $elapsed = function_exists('timer_stop') ? (float) timer_stop(0, 3) : null;
    $headers = headers_list();
    $set_cookie_count = 0;
    foreach ($headers as $header) {
        if (str_starts_with(strtolower($header), 'set-cookie:')) {
            $set_cookie_count++;
        }
    }

    $option_summary = [];
    if (isset($wpdb) && isset($wpdb->options)) {
        $rows = $wpdb->get_results(
            "SELECT option_name, option_value FROM {$wpdb->options} WHERE option_name LIKE 'wpo_%' OR option_name LIKE 'wp_optimize_%' ORDER BY option_name ASC LIMIT 80",
            ARRAY_A
        );
        foreach ((array) $rows as $row) {
            $name = (string) ($row['option_name'] ?? '');
            $value = maybe_unserialize($row['option_value'] ?? '');
            $summary = ['name' => $name, 'bytes' => strlen((string) ($row['option_value'] ?? ''))];
            if (is_array($value)) {
                $summary['keys'] = array_slice(array_map('strval', array_keys($value)), 0, 30);
                foreach (['enable_page_caching', 'enable_cache', 'enabled', 'enable_gzip_compression', 'enable_browser_caching', 'enable_minification'] as $key) {
                    if (array_key_exists($key, $value) && is_scalar($value[$key])) {
                        $summary[$key] = (bool) $value[$key];
                    }
                }
            } elseif (is_scalar($value)) {
                $summary['scalar'] = in_array((string) $value, ['0', '1', 'yes', 'no', 'on', 'off'], true)
                    ? (string) $value
                    : null;
            }
            $option_summary[] = $summary;
        }
    }

    $autoload_bytes = null;
    if (isset($wpdb) && isset($wpdb->options)) {
        $autoload_bytes = (int) $wpdb->get_var(
            "SELECT COALESCE(SUM(LENGTH(option_value)), 0) FROM {$wpdb->options} WHERE autoload IN ('yes', 'on', 'auto-on', 'auto')"
        );
    }

    $htaccess = ABSPATH . '.htaccess';
    $htaccess_contents = is_readable($htaccess) ? (string) file_get_contents($htaccess) : '';
    $payload = [
        'schema' => 1,
        'uri' => esc_url_raw((string) ($_SERVER['REQUEST_URI'] ?? '')),
        'context' => [
            'home' => function_exists('is_front_page') && is_front_page(),
            'product' => function_exists('is_product') && is_product(),
            'cart' => function_exists('is_cart') && is_cart(),
            'checkout' => function_exists('is_checkout') && is_checkout(),
        ],
        'metrics' => [
            'wordpress_seconds' => $elapsed,
            'database_queries' => $num_queries,
            'memory_peak_bytes' => memory_get_peak_usage(true),
            'scripts_enqueued' => isset($wp_scripts->queue) ? count((array) $wp_scripts->queue) : null,
            'styles_enqueued' => isset($wp_styles->queue) ? count((array) $wp_styles->queue) : null,
            'set_cookie_headers' => $set_cookie_count,
        ],
        'cache' => [
            'wp_cache_constant' => defined('WP_CACHE') ? (bool) WP_CACHE : false,
            'advanced_cache_dropin' => is_readable(WP_CONTENT_DIR . '/advanced-cache.php'),
            'object_cache_dropin' => is_readable(WP_CONTENT_DIR . '/object-cache.php'),
            'external_object_cache' => function_exists('wp_using_ext_object_cache') && wp_using_ext_object_cache(),
            'object_cache_class' => is_object($wp_object_cache) ? get_class($wp_object_cache) : gettype($wp_object_cache),
            'htaccess_exists' => is_readable($htaccess),
            'htaccess_has_expires_rules' => stripos($htaccess_contents, 'expiresbytype') !== false,
            'htaccess_has_cache_control_rules' => stripos($htaccess_contents, 'cache-control') !== false,
            'wp_optimize_options' => $option_summary,
        ],
        'database' => [
            'autoloaded_options_bytes' => $autoload_bytes,
        ],
    ];

    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    nocache_headers();
    header('Content-Type: application/json; charset=UTF-8', true);
    echo wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}, PHP_INT_MAX);

