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

    // WPCode stores most snippets in an option rather than posts. Inspect only
    // for mail-encoding keywords; never return a snippet body.
    $wpcode_signals = [];
    $wpcode_snippets = get_option('wpcode_snippets', []);
    foreach (is_array($wpcode_snippets) ? $wpcode_snippets : [] as $key => $snippet) {
        $serialized = is_scalar($snippet) ? (string) $snippet : wp_json_encode($snippet);
        if (!is_string($serialized)) {
            continue;
        }
        $signals = [];
        foreach (['quoted_printable', 'base64_encode', 'Content-Transfer-Encoding', 'wp_mail', 'phpmailer'] as $needle) {
            if (stripos($serialized, $needle) !== false) {
                $signals[] = $needle;
            }
        }
        if ($signals) {
            $wpcode_signals[] = [
                'key' => is_scalar($key) ? (string) $key : '',
                'signals' => $signals,
            ];
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

    // YayMail keeps its visual designs in a private custom post type.  Report
    // only safe structural metadata here (never the email bodies or customer
    // data) so the multilingual layer can select stable per-language designs.
    $yaymail_templates = [];
    if (post_type_exists('yaymail_template')) {
        $templates = get_posts([
            'post_type' => 'yaymail_template',
            'post_status' => 'any',
            'posts_per_page' => -1,
            'orderby' => 'ID',
            'order' => 'ASC',
            'suppress_filters' => true,
        ]);
        foreach ($templates as $template) {
            $meta = get_post_meta($template->ID);
            $meta_summary = [];
            foreach ($meta as $key => $values) {
                $value = $values[0] ?? '';
                $meta_summary[] = [
                    'key' => (string) $key,
                    'type' => gettype($value),
                    'bytes' => is_string($value) ? strlen($value) : 0,
                ];
            }
            $yaymail_templates[] = [
                'id' => (int) $template->ID,
                'title' => (string) $template->post_title,
                'status' => (string) $template->post_status,
                'template_name' => (string) get_post_meta($template->ID, '_yaymail_template', true),
                'variant' => (string) get_post_meta($template->ID, '_yaymail_template_variant', true),
                'jamu_language_fields' => array_values(array_filter(['subject', 'heading', 'additional_content'], static fn (string $field): bool => metadata_exists('post', $template->ID, '_jamu_ml_' . $field))),
                'content_bytes' => strlen((string) $template->post_content),
                // A visual template must contain literal HTML, never a
                // pre-encoded quoted-printable message body.
                'has_quoted_printable_artifacts' => (bool) preg_match(
                    '/=(?:0D|0A|[A-F0-9]{2})/i',
                    (string) $template->post_content . wp_json_encode($meta)
                ),
                'meta' => $meta_summary,
            ];
        }
    }

    // Exercise the actual PHPMailer hook chain without calling send() or
    // exposing a message body. This catches a broken content-transfer
    // encoding before a customer can receive it.
    $mail_encoding_probe = ['available' => false];
    if (class_exists('\PHPMailer\PHPMailer\PHPMailer')) {
        try {
            $probe_html = '<html><body><p>JAMU encoding probe: Příliš žluťoučký kůň.</p></body></html>';
            $mailer = new \PHPMailer\PHPMailer\PHPMailer(true);
            $mailer->isMail();
            $mailer->setFrom('noreply@example.invalid', 'JAMU test');
            $mailer->addAddress('recipient@example.invalid');
            $mailer->Subject = 'JAMU encoding probe';
            $mailer->isHTML(true);
            $mailer->CharSet = 'UTF-8';
            $mailer->Body = $probe_html;
            do_action('phpmailer_init', $mailer);
            $mailer->preSend();
            $mime = (string) $mailer->getSentMIMEMessage();
            $sections = preg_split("/\\r?\\n\\r?\\n/", $mime, 2);
            $encoded_body = $sections[1] ?? '';
            $decoded_body = strtolower((string) ($mailer->Encoding ?? '')) === 'base64'
                ? base64_decode(preg_replace('/\\s+/', '', $encoded_body), true)
                : $encoded_body;
            $mail_encoding_probe = [
                'available' => true,
                'encoding' => (string) ($mailer->Encoding ?? ''),
                'charset' => (string) ($mailer->CharSet ?? ''),
                'mime_has_base64_header' => stripos($mime, 'Content-Transfer-Encoding: base64') !== false,
                'decoded_body_contains_marker' => is_string($decoded_body) && str_contains($decoded_body, 'JAMU encoding probe'),
                'encoded_body_has_raw_qp_artifacts' => (bool) preg_match('/=(?:0D|0A|[A-F0-9]{2})/i', $encoded_body),
            ];
        } catch (Throwable $exception) {
            $mail_encoding_probe = ['available' => true, 'error' => get_class($exception)];
        }
    }

    echo wp_json_encode([
        'schema' => 1,
        'generated_at' => gmdate('c'),
        'plugins' => $plugin_data,
        'options' => $option_keys,
        'email_settings' => $email_settings,
        'yaymail_templates' => $yaymail_templates,
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
        'wpcode_signals' => $wpcode_signals,
        'mail_encoding_probe' => $mail_encoding_probe,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}, 999);
