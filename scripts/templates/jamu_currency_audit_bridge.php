<?php
/**
 * Ephemeral, read-only audit for product currency metadata.
 */

defined('ABSPATH') || exit;

$jamu_presented = (string) ($_SERVER['HTTP_X_JAMU_BRIDGE'] ?? '');
if ($jamu_presented === '' || !hash_equals('__JAMU_TOKEN_HASH__', hash('sha256', $jamu_presented))) {
    return;
}

add_action('wp_loaded', static function (): void {
    if (($_GET['jamu_bridge'] ?? '') !== 'currency_audit') {
        return;
    }

    nocache_headers();
    header('Content-Type: application/json; charset=UTF-8');

    register_shutdown_function(static function (): void {
        @unlink(__FILE__);
    });

    global $wpdb;
    $posts = $wpdb->posts;
    $postmeta = $wpdb->postmeta;
    $patterns = ['%yay%', '%currency%', '%fixed%price%', '%price%fixed%'];
    $where = implode(' OR ', array_fill(0, count($patterns), 'pm.meta_key LIKE %s'));
    $sql = "SELECT pm.meta_key, COUNT(*) AS entries, COUNT(DISTINCT pm.post_id) AS products
        FROM {$postmeta} pm
        INNER JOIN {$posts} p ON p.ID = pm.post_id
        WHERE p.post_type = 'product' AND p.post_status NOT IN ('trash', 'auto-draft')
          AND ({$where})
        GROUP BY pm.meta_key
        ORDER BY products DESC, pm.meta_key ASC";
    $keys = $wpdb->get_results($wpdb->prepare($sql, ...$patterns), ARRAY_A);

    $examples = [];
    foreach ($keys as $row) {
        $key = (string) $row['meta_key'];
        $sample = $wpdb->get_results(
            $wpdb->prepare(
                "SELECT pm.post_id, pm.meta_value FROM {$postmeta} pm
                 INNER JOIN {$posts} p ON p.ID = pm.post_id
                 WHERE p.post_type = 'product' AND pm.meta_key = %s
                 ORDER BY pm.post_id ASC LIMIT 5",
                $key
            ),
            ARRAY_A
        );
        $examples[$key] = array_map(static function (array $item): array {
            return [
                'product_id' => (int) $item['post_id'],
                'value' => mb_substr(wp_strip_all_tags((string) $item['meta_value']), 0, 250),
            ];
        }, $sample);
    }

    $product_id = 4528;
    $product_meta = $wpdb->get_results(
        $wpdb->prepare(
            "SELECT meta_key, meta_value FROM {$postmeta}
             WHERE post_id = %d
             ORDER BY meta_key ASC",
            $product_id
        ),
        ARRAY_A
    );
    foreach ($product_meta as &$item) {
        $item['meta_value'] = mb_substr(wp_strip_all_tags((string) $item['meta_value']), 0, 250);
    }
    unset($item);

    $hook_callbacks = static function (string $hook): array {
        global $wp_filter;
        if (empty($wp_filter[$hook]) || !isset($wp_filter[$hook]->callbacks)) {
            return [];
        }
        $result = [];
        foreach ($wp_filter[$hook]->callbacks as $priority => $callbacks) {
            foreach ($callbacks as $callback) {
                $function = $callback['function'] ?? null;
                if (is_array($function)) {
                    $name = (is_object($function[0]) ? get_class($function[0]) : (string) $function[0]) . '::' . (string) $function[1];
                } elseif (is_string($function)) {
                    $name = $function;
                } else {
                    $name = 'closure';
                }
                $result[] = ['priority' => (int) $priority, 'callback' => $name];
            }
        }
        return $result;
    };

    echo wp_json_encode([
        'ok' => true,
        'woocommerce_currency' => get_option('woocommerce_currency'),
        'product_meta_keys' => $keys,
        'examples' => $examples,
        'sample_product_id' => $product_id,
        'sample_product_meta' => $product_meta,
        'active_plugins' => array_values((array) get_option('active_plugins', [])),
        'price_filters' => [
            'woocommerce_product_get_price' => $hook_callbacks('woocommerce_product_get_price'),
            'woocommerce_product_get_regular_price' => $hook_callbacks('woocommerce_product_get_regular_price'),
            'woocommerce_product_get_sale_price' => $hook_callbacks('woocommerce_product_get_sale_price'),
        ],
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}, 999);
