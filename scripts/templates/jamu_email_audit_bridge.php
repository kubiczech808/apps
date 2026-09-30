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
    header('X-JAMU-Email-Audit: active');
    ob_start();
    $runtime_warnings = [];
    set_error_handler(static function (int $severity, string $message, string $file, int $line) use (&$runtime_warnings): bool {
        $runtime_warnings[] = [
            'severity' => $severity,
            'file' => basename($file),
            'line' => $line,
        ];
        return true;
    });
    $completed = false;
    register_shutdown_function(static function () use (&$completed): void {
        if (!$completed && !headers_sent()) {
            while (ob_get_level() > 0) {
                ob_end_clean();
            }
            $error = error_get_last();
            http_response_code(500);
            header('Content-Type: application/json; charset=UTF-8');
            echo wp_json_encode([
                'audit_error' => [
                    'type' => is_array($error) ? (int) ($error['type'] ?? 0) : 0,
                    'file' => is_array($error) ? basename((string) ($error['file'] ?? '')) : '',
                    'line' => is_array($error) ? (int) ($error['line'] ?? 0) : 0,
                ],
            ]);
        }
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
    $template_encoding_summary = [];
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
            $storage = (string) $template->post_content . (string) wp_json_encode($meta);
            $qp_newline_count = preg_match_all('/=(?:0D)?0A/i', $storage);
            $qp_utf8_count = preg_match_all('/=(?:C[0-9A-F]|D[0-9A-F])[0-9A-F]/i', $storage);
            $decoded_storage = ($qp_newline_count || $qp_utf8_count) ? quoted_printable_decode($storage) : '';
            $decodes_to_html = $decoded_storage !== ''
                && preg_match('/<(?:html|body|table|div|p)\b/i', $decoded_storage) === 1;
            if ($qp_newline_count || $qp_utf8_count) {
                $template_encoding_summary[] = [
                    'id' => (int) $template->ID,
                    'template_name' => (string) get_post_meta($template->ID, '_yaymail_template', true),
                    'variant' => (string) get_post_meta($template->ID, '_yaymail_template_variant', true),
                    'qp_newline_count' => (int) $qp_newline_count,
                    'qp_utf8_count' => (int) $qp_utf8_count,
                    'decodes_to_html' => $decodes_to_html,
                ];
            }
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
                'meta' => $meta_summary,
            ];
        }
    }

    // Exercise the actual PHPMailer hook chain without calling send() or
    // exposing a message body. This catches a broken content-transfer
    // encoding before a customer can receive it.
    if (!class_exists('\PHPMailer\PHPMailer\PHPMailer') && is_readable(ABSPATH . WPINC . '/PHPMailer/PHPMailer.php')) {
        require_once ABSPATH . WPINC . '/PHPMailer/Exception.php';
        require_once ABSPATH . WPINC . '/PHPMailer/PHPMailer.php';
    }
    $mailer_class = class_exists('\PHPMailer\PHPMailer\PHPMailer')
        ? '\PHPMailer\PHPMailer\PHPMailer'
        : (class_exists('PHPMailer') ? 'PHPMailer' : '');
    $mail_encoding_probe = ['available' => false];
    if ($mailer_class !== '') {
        try {
            $probe_html = '<html><body><p>JAMU encoding probe: Příliš žluťoučký kůň.</p></body></html>';
            $mailer = new $mailer_class(true);
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
            $encoding = strtolower((string) ($mailer->Encoding ?? ''));
            $decoded_body = match ($encoding) {
                'base64' => base64_decode(preg_replace('/\\s+/', '', $encoded_body), true),
                'quoted-printable' => quoted_printable_decode($encoded_body),
                default => $encoded_body,
            };
            $mail_encoding_probe = [
                'available' => true,
                'mailer_class' => $mailer_class,
                'encoding' => $encoding,
                'charset' => (string) ($mailer->CharSet ?? ''),
                'mime_has_base64_header' => stripos($mime, 'Content-Transfer-Encoding: base64') !== false,
                'decoded_body_contains_marker' => is_string($decoded_body) && str_contains($decoded_body, 'JAMU encoding probe'),
                'encoded_body_has_raw_qp_artifacts' => (bool) preg_match('/=(?:0D|0A|[A-F0-9]{2})/i', $encoded_body),
            ];
        } catch (Throwable $exception) {
            $mail_encoding_probe = ['available' => true, 'error' => get_class($exception)];
        }
    }

    // Render every enabled customer email in every supported checkout language
    // using an unsaved order object. Nothing is written and send() is never
    // called. The result tests both YayMail's selected visual variant and the
    // final PHPMailer content-transfer encoding.
    $render_probes = [];
    if ($mailer_class !== '' && class_exists('WC_Order')) {
        foreach ((array) WC()->mailer()->get_emails() as $email) {
            $email_id = is_object($email) && isset($email->id) ? (string) $email->id : '';
            if ($email_id === '' || !str_starts_with($email_id, 'customer_') || (string) ($email->enabled ?? '') !== 'yes') {
                continue;
            }
            foreach (['cs', 'en', 'de', 'pl'] as $language) {
                try {
                    // A real order object is needed only for rendering the
                    // WooCommerce/YayMail layout. The known test order is
                    // reloaded per language and never saved, so no customer
                    // data or order state leaves WordPress.
                    $order = function_exists('wc_get_order') ? wc_get_order(4552) : null;
                    if (!$order) {
                        $order = new WC_Order();
                    }
                    $order->set_billing_first_name('JAMU');
                    $order->set_billing_last_name('Probe');
                    $order->set_billing_email('probe@example.invalid');
                    $order->update_meta_data('_jamu_ml_language', $language);
                    $email->object = $order;
                    $recipient = apply_filters(
                        'woocommerce_email_recipient_' . $email_id,
                        'audit@tajemstvijamu.cz',
                        $order,
                        $email
                    );
                    $subject = (string) $email->get_subject();
                    $html = (string) $email->get_content_html();
                    $params = apply_filters('woocommerce_mail_callback_params', [
                        $recipient,
                        $subject,
                        $html,
                        ['Content-Type: text/html; charset=UTF-8'],
                        [],
                    ]);
                    $final_html = (string) ($params[2] ?? '');
                    $probe = [
                        'email_id' => $email_id,
                        'language' => $language,
                        'html_bytes' => strlen($final_html),
                        'has_html' => preg_match('/<(?:html|body|table|div|p)\b/i', $final_html) === 1,
                        'html_has_raw_qp_artifacts' => preg_match('/=(?:0D|0A|[A-F0-9]{2})/i', $final_html) === 1,
                        'selected_variant' => apply_filters('yaymail_email_get_variant', '', $order, [], $email, $email_id),
                    ];
                    $mailer = new $mailer_class(false);
                    $mailer->isMail();
                    $mailer->setFrom('audit@tajemstvijamu.cz', 'JAMU test');
                    $mailer->addAddress('audit@tajemstvijamu.cz');
                    $mailer->Subject = (string) ($params[1] ?? '');
                    $mailer->isHTML(true);
                    $mailer->CharSet = 'UTF-8';
                    $mailer->Body = $final_html;
                    do_action('phpmailer_init', $mailer);
                    $prepared = $mailer->preSend();
                    $mime = $prepared ? (string) $mailer->getSentMIMEMessage() : '';
                    $sections = preg_split("/\\r?\\n\\r?\\n/", $mime, 2);
                    $encoded_body = $sections[1] ?? '';
                    $render_probes[] = $probe + [
                        'mime_prepared' => (bool) $prepared,
                        'mime_encoding' => strtolower((string) ($mailer->Encoding ?? '')),
                        'mime_has_base64_header' => stripos($mime, 'Content-Transfer-Encoding: base64') !== false,
                        'mime_body_has_raw_qp_artifacts' => preg_match('/=(?:0D|0A|[A-F0-9]{2})/i', $encoded_body) === 1,
                    ];
                } catch (Throwable $exception) {
                    $render_probes[] = [
                        'email_id' => $email_id,
                        'language' => $language,
                        'error' => get_class($exception),
                        'error_file' => basename($exception->getFile()),
                        'error_line' => $exception->getLine(),
                    ];
                }
            }
        }
    }

    restore_error_handler();
    $warning_summary = array_values(array_unique(array_map(
        static fn (array $warning): string => implode(':', $warning),
        $runtime_warnings
    )));
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    $completed = true;
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
        'template_encoding_summary' => $template_encoding_summary,
        'render_probes' => $render_probes,
        'runtime_warning_summary' => $warning_summary,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}, 999);
