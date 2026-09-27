<?php
/** Ephemeral, read-only JAMU checkout hook audit bridge. */

defined('ABSPATH') || exit;

$presented = (string) ($_SERVER['HTTP_X_JAMU_CHECKOUT_AUDIT'] ?? '');
if ($presented === '' || !hash_equals('__JAMU_TOKEN_HASH__', hash('sha256', $presented))) {
    return;
}

add_action('wp_loaded', static function (): void {
    if (($_GET['jamu_bridge'] ?? '') !== 'checkout-audit') {
        return;
    }

    nocache_headers();
    header('Content-Type: application/json; charset=UTF-8');
    register_shutdown_function(static function (): void {
        @unlink(__FILE__);
    });

    $describe = static function (mixed $callback): array {
        $name = gettype($callback);
        $file = '';
        try {
            if (is_array($callback) && isset($callback[0], $callback[1])) {
                $owner = is_object($callback[0]) ? get_class($callback[0]) : (string) $callback[0];
                $name = $owner . '::' . (string) $callback[1];
                $file = (string) (new ReflectionMethod($callback[0], (string) $callback[1]))->getFileName();
            } elseif (is_string($callback) && function_exists($callback)) {
                $name = $callback;
                $file = (string) (new ReflectionFunction($callback))->getFileName();
            } elseif ($callback instanceof Closure) {
                $name = 'Closure';
                $file = (string) (new ReflectionFunction($callback))->getFileName();
            }
        } catch (ReflectionException) {
        }
        return ['callback' => $name, 'file' => str_replace(ABSPATH, '/', $file)];
    };

    $hooks = static function (string $tag) use ($describe): array {
        global $wp_filter;
        if (empty($wp_filter[$tag]) || !isset($wp_filter[$tag]->callbacks)) {
            return [];
        }
        $rows = [];
        foreach ($wp_filter[$tag]->callbacks as $priority => $callbacks) {
            foreach ($callbacks as $row) {
                $rows[] = ['priority' => (int) $priority] + $describe($row['function'] ?? null);
            }
        }
        return $rows;
    };

    $tags = [
        'wc_ajax_update_order_review',
        'woocommerce_checkout_update_order_review',
        'woocommerce_review_order_before_shipping',
        'woocommerce_review_order_after_shipping',
        'woocommerce_cart_totals_before_shipping',
        'woocommerce_cart_totals_after_shipping',
        'woocommerce_after_shipping_rate',
    ];
    $result = ['hooks' => []];
    foreach ($tags as $tag) {
        $result['hooks'][$tag] = $hooks($tag);
    }
    echo wp_json_encode($result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
});
