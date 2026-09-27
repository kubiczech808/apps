<?php
/**
 * Ephemeral JAMU email delivery audit bridge.
 * It reports hook topology and safe configuration metadata only.
 */

defined('ABSPATH') || exit;

$presented = (string) ($_SERVER['HTTP_X_JAMU_EMAIL_AUDIT'] ?? '');
if ($presented === '' || !hash_equals('__JAMU_TOKEN_HASH__', hash('sha256', $presented))) {
    return;
}

add_action('wp_loaded', static function (): void {
    if (($_GET['jamu_bridge'] ?? '') !== 'email-audit') {
        return;
    }

    nocache_headers();
    header('Content-Type: application/json; charset=UTF-8');
    register_shutdown_function(static function (): void {
        @unlink(__FILE__);
    });

    $callback_name = static function (mixed $callback): string {
        if (is_string($callback)) {
            return $callback;
        }
        if (is_array($callback) && isset($callback[0], $callback[1])) {
            $owner = is_object($callback[0]) ? get_class($callback[0]) : (string) $callback[0];
            return $owner . '::' . (string) $callback[1];
        }
        if ($callback instanceof Closure) {
            return 'Closure';
        }
        if (is_object($callback) && method_exists($callback, '__invoke')) {
            return get_class($callback) . '::__invoke';
        }
        return gettype($callback);
    };

    $hooks = static function (string $tag) use ($callback_name): array {
        global $wp_filter;
        if (empty($wp_filter[$tag]) || !isset($wp_filter[$tag]->callbacks)) {
            return [];
        }
        $rows = [];
        foreach ($wp_filter[$tag]->callbacks as $priority => $callbacks) {
            foreach ($callbacks as $row) {
                $rows[] = [
                    'priority' => (int) $priority,
                    'callback' => $callback_name($row['function'] ?? null),
                    'accepted_args' => (int) ($row['accepted_args'] ?? 0),
                ];
            }
        }
        return $rows;
    };

    $plugin_data = [];
    if (!function_exists('get_plugin_data')) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    foreach ((array) get_option('active_plugins', []) as $plugin_file) {
        if (!preg_match('/(?:mail|smtp|woo|wpcode|header)/i', (string) $plugin_file)) {
            continue;
        }
        $file = WP_PLUGIN_DIR . '/' . $plugin_file;
        $data = is_readable($file) ? get_plugin_data($file, false, false) : [];
        $plugin_data[] = [
            'file' => (string) $plugin_file,
            'name' => (string) ($data['Name'] ?? ''),
            'version' => (string) ($data['Version'] ?? ''),
        ];
    }

    $option_keys = [];
    foreach (wp_load_alloptions() as $key => $value) {
        if (!preg_match('/(?:mail|smtp|yaymail|wpcode|phpmailer)/i', (string) $key)) {
            continue;
        }
        $option_keys[] = [
            'key' => (string) $key,
            'type' => gettype($value),
            'array_keys' => is_array($value) ? array_slice(array_map('strval', array_keys($value)), 0, 40) : [],
        ];
    }

    $snippet_signals = [];
    foreach (get_post_types([], 'names') as $post_type) {
        if (!preg_match('/(?:code|snippet)/i', (string) $post_type)) {
            continue;
        }
        $posts = get_posts([
            'post_type' => $post_type,
            'post_status' => 'any',
            'posts_per_page' => -1,
            'suppress_filters' => true,
        ]);
        foreach ($posts as $post) {
            $content = (string) $post->post_content;
            $signals = [];
            foreach (['quoted_printable', 'wp_mail', 'phpmailer', 'Content-Transfer-Encoding', 'woocommerce_mail'] as $needle) {
                if (stripos($content, $needle) !== false) {
                    $signals[] = $needle;
                }
            }
            if ($signals) {
                $snippet_signals[] = [
                    'id' => (int) $post->ID,
                    'post_type' => (string) $post_type,
                    'status' => (string) $post->post_status,
                    'title' => (string) $post->post_title,
                    'signals' => $signals,
                ];
            }
        }
    }

    $email_settings = [];
    foreach ((array) WC()->mailer()->get_emails() as $id => $email) {
        if (!is_object($email)) {
            continue;
        }
        $email_settings[] = [
            'id' => (string) $id,
            'enabled' => (string) ($email->enabled ?? ''),
            'email_type' => (string) ($email->email_type ?? ''),
            'template_html' => (string) ($email->template_html ?? ''),
            'template_plain' => (string) ($email->template_plain ?? ''),
        ];
    }

    echo wp_json_encode([
        'schema' => 1,
        'generated_at' => gmdate('c'),
        'plugins' => $plugin_data,
        'options' => $option_keys,
        'email_settings' => $email_settings,
        'hooks' => array_map($hooks, [
            'woocommerce_mail_callback',
            'woocommerce_mail_callback_params',
            'wp_mail',
            'wp_mail_content_type',
            'phpmailer_init',
            'wp_mail_from',
            'wp_mail_from_name',
        ]),
        'snippet_signals' => $snippet_signals,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}, 999);
