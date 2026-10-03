<?php
/**
 * Ephemeral JAMU storefront performance apply bridge.
 *
 * It uses the installed WP-Optimize public API, is inert without a one-time
 * authenticated request and removes itself after returning its compact report.
 */

defined('ABSPATH') || exit;

$jamu_presented = (string) ($_SERVER['HTTP_X_JAMU_BRIDGE'] ?? '');
if ($jamu_presented === '' || !hash_equals('__JAMU_TOKEN_HASH__', hash('sha256', $jamu_presented))) {
    return;
}

add_action('wp_loaded', static function (): void {
    if (($_GET['jamu_bridge'] ?? '') !== 'performance-apply') {
        return;
    }

    nocache_headers();
    header('Content-Type: application/json; charset=UTF-8');

    register_shutdown_function(static function (): void {
        @unlink(__FILE__);
    });

    $send = static function (array $payload, int $status = 200): void {
        status_header($status);
        echo wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    };

    if (!class_exists('WPO_Cache_Config') || !class_exists('WP_Optimize_Cache_Commands') || !function_exists('WP_Optimize')) {
        $send(['ok' => false, 'error' => 'WP-Optimize page-cache API is unavailable.'], 500);
    }

    if (!class_exists('Jamu\\Multilingual\\Performance')) {
        $send(['ok' => false, 'error' => 'JAMU cache-safety integration is unavailable.'], 500);
    }

    $config = WPO_Cache_Config::instance();
    $before = $config->get();

    // This is only a rollback snapshot of existing cache configuration. It
    // contains no credentials or customer data, and page caching was disabled
    // before this change.
    update_option('jamu_ml_wpo_cache_backup', [
        'saved_at' => gmdate('c'),
        'cache_config' => $before,
    ], false);

    $settings = $before;
    $settings['enable_page_caching'] = true;
    $settings['page_cache_length_value'] = 12;
    $settings['page_cache_length_unit'] = 'hours';
    $settings['enable_mobile_caching'] = false;
    $settings['enable_user_caching'] = false;
    $settings['enable_sitemap_preload'] = false;
    $settings['enable_schedule_preload'] = false;
    $settings['auto_preload_purged_contents'] = true;

    // WooCommerce pages with a cart, checkout state, account details or
    // order-received content must always be generated dynamically. The list
    // covers the existing Czech routes and their JAMU-localized counterparts.
    $dynamic_routes = [
        '/kosik/*',
        '/pokladna/*',
        '/muj-ucet/*',
        '/en/cart/*',
        '/en/checkout/*',
        '/en/my-account/*',
        '/de/warenkorb/*',
        '/de/kasse/*',
        '/de/mein-konto/*',
        '/pl/koszyk/*',
        '/pl/kasa/*',
        '/pl/moje-konto/*',
    ];
    $existing_routes = is_array($settings['cache_exception_urls'] ?? null) ? $settings['cache_exception_urls'] : [];
    $settings['cache_exception_urls'] = array_values(array_unique(array_merge($existing_routes, $dynamic_routes)));

    $existing_tags = is_array($settings['cache_exception_conditional_tags'] ?? null) ? $settings['cache_exception_conditional_tags'] : [];
    $settings['cache_exception_conditional_tags'] = array_values(array_unique(array_merge($existing_tags, ['is_account_page()'])));

    $result = (new WP_Optimize_Cache_Commands())->save_cache_settings(['cache-settings' => $settings]);
    $stored = $config->get();
    $page_cache_enabled = !empty($result['enabled']) && !empty($stored['enable_page_caching']);

    if (!$page_cache_enabled) {
        $error = is_array($result['error'] ?? null) ? (string) ($result['error']['message'] ?? '') : '';
        $send([
            'ok' => false,
            'page_cache' => ['enabled' => false],
        'error' => substr($error !== '' ? $error : 'WP-Optimize did not enable page caching.', 0, 500),
        ], 500);
    }

    $browser = WP_Optimize()->get_browser_cache()->enable_browser_cache_command_handler([
        'browser_cache_expire_days' => 28,
        'browser_cache_expire_hours' => 0,
    ]);

    // Do not retain anything generated during activation. The verification
    // phase intentionally warms only a few public pages and cache preloading
    // remains disabled to control hosting file usage.
    if (function_exists('wpo_cache_flush')) {
        wpo_cache_flush();
    }

    $currency_cookie = 'yay_currency_widget';
    $cache_cookies = is_array($stored['wpo_cache_cookies'] ?? null) ? $stored['wpo_cache_cookies'] : [];
    $browser_error = is_array($browser) ? (string) ($browser['error_message'] ?? '') : '';

    $send([
        'ok' => in_array($currency_cookie, $cache_cookies, true),
        'page_cache' => [
            'enabled' => true,
            'ttl_hours' => (int) ($stored['page_cache_length_value'] ?? 0),
            'preload_enabled' => !empty($stored['enable_sitemap_preload']) || !empty($stored['enable_schedule_preload']),
            'dynamic_route_count' => count($settings['cache_exception_urls']),
        ],
        'currency_cache_cookie' => in_array($currency_cookie, $cache_cookies, true),
        'browser_cache' => [
            'configured' => !empty($browser['success']),
            'enabled' => !empty($browser['enabled']),
            'error' => substr($browser_error, 0, 500),
        ],
    ], in_array($currency_cookie, $cache_cookies, true) ? 200 : 500);
}, 999);
