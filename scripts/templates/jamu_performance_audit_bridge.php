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

// SAVEQUERIES is read at query time by wpdb. Enabling it in this short-lived,
// authenticated MU bridge gives a one-request aggregate only; SQL text and
// customer data are never returned in the audit payload.
if (!defined('SAVEQUERIES')) {
    define('SAVEQUERIES', true);
}

$jamu_performance_token = (string) ($_SERVER['HTTP_X_JAMU_BRIDGE'] ?? $_SERVER['HTTP_X_JAMU_PERFORMANCE_AUDIT'] ?? '');
if ($jamu_performance_token === ''
    || !hash_equals('__JAMU_TOKEN_HASH__', hash('sha256', $jamu_performance_token))) {
    return;
}

// Verify the bridge can be reached on this host before running the full
// shutdown profiler. This path is used only by the audit workflow.
if (($_GET['jamu_bridge'] ?? '') === 'performance-audit-probe') {
    add_action('wp_loaded', static function (): void {
        nocache_headers();
        header('Content-Type: application/json; charset=UTF-8', true);
        echo wp_json_encode(['bridge' => 'performance-audit', 'reachable' => true]);
        exit;
    }, PHP_INT_MAX);
    return;
}

ob_start();

$jamu_plugin_load_started = microtime(true);
$jamu_plugin_loads = [];
add_action('plugin_loaded', static function (string $plugin) use (&$jamu_plugin_load_started, &$jamu_plugin_loads): void {
    $now = microtime(true);
    $jamu_plugin_loads[] = [
        'plugin' => basename(dirname($plugin)) . '/' . basename($plugin),
        'milliseconds' => round(($now - $jamu_plugin_load_started) * 1000, 1),
    ];
    $jamu_plugin_load_started = $now;
}, PHP_INT_MAX);

$jamu_http_started = [];
$jamu_http_calls = [];
add_filter('pre_http_request', static function (mixed $preempt, array $args, string $url) use (&$jamu_http_started): mixed {
    $jamu_http_started[$url] = microtime(true);
    return $preempt;
}, PHP_INT_MIN, 3);
add_action('http_api_debug', static function (mixed $response, string $context, string $class, array $args, string $url) use (&$jamu_http_started, &$jamu_http_calls): void {
    if ($context !== 'response') {
        return;
    }
    $started = $jamu_http_started[$url] ?? null;
    $host = (string) wp_parse_url($url, PHP_URL_HOST);
    $jamu_http_calls[] = [
        'host' => $host,
        'milliseconds' => $started ? round((microtime(true) - $started) * 1000, 1) : null,
        'ok' => !is_wp_error($response),
    ];
    unset($jamu_http_started[$url]);
}, PHP_INT_MAX, 5);

// WordPress does not expose per-hook timing without a profiler. This records
// only intervals over 20 ms between hook boundaries for this one request. It
// contains hook names and durations, never the hook arguments.
$jamu_last_hook = null;
$jamu_last_hook_started = microtime(true);
$jamu_slow_hook_intervals = [];
add_action('all', static function (string $hook) use (&$jamu_last_hook, &$jamu_last_hook_started, &$jamu_slow_hook_intervals): void {
    $now = microtime(true);
    $milliseconds = ($now - $jamu_last_hook_started) * 1000;
    if ($jamu_last_hook !== null && $milliseconds >= 20) {
        $jamu_slow_hook_intervals[] = ['after_hook' => $jamu_last_hook, 'milliseconds' => round($milliseconds, 1)];
    }
    $jamu_last_hook = $hook;
    $jamu_last_hook_started = $now;
}, PHP_INT_MIN, 1);

add_action('shutdown', static function () use (&$jamu_plugin_loads, &$jamu_http_calls, &$jamu_last_hook, &$jamu_last_hook_started, &$jamu_slow_hook_intervals): void {
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

    $query_total_seconds = 0.0;
    $query_callers = [];
    foreach ((array) ($wpdb->queries ?? []) as $query) {
        $seconds = isset($query[1]) ? (float) $query[1] : 0.0;
        $caller = isset($query[2]) ? (string) $query[2] : 'unknown';
        $query_total_seconds += $seconds;
        if (!isset($query_callers[$caller])) {
            $query_callers[$caller] = ['queries' => 0, 'seconds' => 0.0];
        }
        $query_callers[$caller]['queries']++;
        $query_callers[$caller]['seconds'] += $seconds;
    }
    uasort($query_callers, static fn (array $left, array $right): int => $right['seconds'] <=> $left['seconds']);
    $slow_query_callers = [];
    foreach (array_slice($query_callers, 0, 12, true) as $caller => $stats) {
        $slow_query_callers[] = [
            'caller' => substr($caller, 0, 180),
            'queries' => $stats['queries'],
            'milliseconds' => round($stats['seconds'] * 1000, 1),
        ];
    }
    usort($jamu_plugin_loads, static fn (array $left, array $right): int => $right['milliseconds'] <=> $left['milliseconds']);
    usort($jamu_http_calls, static fn (array $left, array $right): int => ($right['milliseconds'] ?? 0) <=> ($left['milliseconds'] ?? 0));
    $final_hook_milliseconds = (microtime(true) - $jamu_last_hook_started) * 1000;
    if ($jamu_last_hook !== null && $final_hook_milliseconds >= 20) {
        $jamu_slow_hook_intervals[] = ['after_hook' => $jamu_last_hook, 'milliseconds' => round($final_hook_milliseconds, 1)];
    }
    usort($jamu_slow_hook_intervals, static fn (array $left, array $right): int => $right['milliseconds'] <=> $left['milliseconds']);

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
            'recorded_query_seconds' => round($query_total_seconds, 3),
            'slow_callers' => $slow_query_callers,
        ],
        'runtime' => [
            'slow_plugin_load_intervals' => array_slice($jamu_plugin_loads, 0, 12),
            'http_calls' => array_slice($jamu_http_calls, 0, 12),
            'slow_hook_intervals' => array_slice($jamu_slow_hook_intervals, 0, 20),
        ],
    ];

    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    nocache_headers();
    header('Content-Type: application/json; charset=UTF-8', true);
    echo wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
// Run before WordPress flushes output buffers at shutdown priority 1.
}, 0);
