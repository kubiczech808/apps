<?php

namespace Jamu\Multilingual;

defined('ABSPATH') || exit;

final class Email
{
    public const ORDER_LANGUAGE_META = '_jamu_ml_language';

    /** @var array<string, bool> */
    private array $registered_email_ids = [];

    private int $context_depth = 0;
    private ?string $previous_language = null;
    private ?int $active_order_id = null;
    private ?string $active_email_id = null;
    private bool $locale_switched = false;

    public function __construct(private Languages $languages)
    {
    }

    public function register(): void
    {
        add_action('woocommerce_checkout_create_order', [$this, 'store_checkout_language'], 20, 2);
        add_action('woocommerce_checkout_order_created', [$this, 'store_checkout_language_if_missing'], 20);
        add_action('woocommerce_store_api_checkout_update_order_from_request', [$this, 'store_checkout_language'], 20, 2);
        add_action('woocommerce_store_api_checkout_order_processed', [$this, 'store_checkout_language_if_missing'], 20);

        add_filter('woocommerce_email_classes', [$this, 'register_customer_email_hooks'], 20);
        add_filter('woocommerce_mail_callback_params', [$this, 'restore_after_mail_params'], 999);
        add_action('woocommerce_email_sent', [$this, 'restore_after_email_sent'], 999, 3);
        add_action('shutdown', [$this, 'restore_email_context'], 0);

        add_filter('jamu_ml_should_localize_request', [$this, 'force_email_context'], 20);
        add_filter('jamu_ml_should_translate_content', [$this, 'force_email_context'], 20);
    }

    public function store_checkout_language($order, mixed $data = null): void
    {
        $order = $this->normalize_order($order);
        if (!$order) {
            return;
        }

        $this->set_order_language($order, $this->languages->current());
    }

    public function store_checkout_language_if_missing($order): void
    {
        $order = $this->normalize_order($order);
        if (!$order || $this->order_language($order) !== '') {
            return;
        }

        $this->set_order_language($order, $this->languages->current());
        $this->save_order($order);
    }

    public function register_customer_email_hooks(array $emails): array
    {
        foreach ($emails as $email) {
            if (!is_object($email) || empty($email->id) || !$this->is_customer_email_id((string) $email->id)) {
                continue;
            }

            $id = (string) $email->id;
            if (isset($this->registered_email_ids[$id])) {
                continue;
            }

            $this->registered_email_ids[$id] = true;
            add_filter("woocommerce_email_recipient_{$id}", [$this, 'prepare_customer_email'], 1, 3);
            add_filter("woocommerce_email_subject_{$id}", [$this, 'prepare_customer_email_text'], 1, 3);
            add_filter("woocommerce_email_heading_{$id}", [$this, 'prepare_customer_email_text'], 1, 3);
            add_filter("woocommerce_email_additional_content_{$id}", [$this, 'prepare_customer_email_text'], 1, 3);
        }

        return $emails;
    }

    public function prepare_customer_email(string $recipient, mixed $object = null, mixed $email = null): string
    {
        if (trim($recipient) !== '') {
            $this->begin_email_context($object, $email);
        }

        return $recipient;
    }

    public function prepare_customer_email_text(string $text, mixed $object = null, mixed $email = null): string
    {
        $this->begin_email_context($object, $email);

        return $text;
    }

    public function restore_after_mail_params(array $params): array
    {
        $this->restore_email_context();
        return $params;
    }

    public function restore_after_email_sent(mixed $return = null, mixed $id = null, mixed $email = null): void
    {
        $this->restore_email_context();
    }

    public function force_email_context(bool $active): bool
    {
        return $this->context_depth > 0 ? true : $active;
    }

    private function begin_email_context(mixed $object, mixed $email = null): void
    {
        $order = $this->normalize_order($object);
        if (!$order && is_object($email) && isset($email->object)) {
            $order = $this->normalize_order($email->object);
        }
        if (!$order) {
            return;
        }

        $email_id = is_object($email) && !empty($email->id) ? (string) $email->id : '';
        if ($email_id !== '' && !$this->is_customer_email_id($email_id)) {
            return;
        }

        $language = $this->order_language($order);
        if ($language === '') {
            return;
        }

        $order_id = $this->order_id($order);
        if ($this->context_depth > 0 && $this->active_order_id === $order_id && $this->active_email_id === $email_id) {
            return;
        }

        if ($this->context_depth > 0) {
            $this->restore_email_context();
        }

        $this->previous_language = $this->languages->current();
        $this->active_order_id = $order_id;
        $this->active_email_id = $email_id;
        $this->context_depth = 1;
        $this->languages->set_current($language);

        if (function_exists('switch_to_locale')) {
            $locale = (string) ($this->languages->get($language)['locale'] ?? '');
            if ($locale !== '') {
                $this->locale_switched = (bool) switch_to_locale($locale);
            }
        }
    }

    public function restore_email_context(): void
    {
        if ($this->context_depth <= 0) {
            return;
        }

        if ($this->locale_switched && function_exists('restore_previous_locale')) {
            restore_previous_locale();
        }

        if ($this->previous_language !== null) {
            $this->languages->set_current($this->previous_language);
        }

        $this->context_depth = 0;
        $this->previous_language = null;
        $this->active_order_id = null;
        $this->active_email_id = null;
        $this->locale_switched = false;
    }

    private function set_order_language(object $order, string $language): void
    {
        $language = $this->valid_language($language) ?: Languages::DEFAULT;
        if (method_exists($order, 'update_meta_data')) {
            $order->update_meta_data(self::ORDER_LANGUAGE_META, $language);
        }
    }

    private function order_language(object $order): string
    {
        if (!method_exists($order, 'get_meta')) {
            return '';
        }

        return $this->valid_language((string) $order->get_meta(self::ORDER_LANGUAGE_META, true)) ?: '';
    }

    private function valid_language(string $language): string
    {
        $language = sanitize_key($language);
        return isset($this->languages->all()[$language]) ? $language : '';
    }

    private function normalize_order(mixed $order): ?object
    {
        if (is_numeric($order) && function_exists('wc_get_order')) {
            $order = wc_get_order((int) $order);
        }

        return is_object($order) && method_exists($order, 'get_meta') ? $order : null;
    }

    private function order_id(object $order): int
    {
        return method_exists($order, 'get_id') ? (int) $order->get_id() : 0;
    }

    private function save_order(object $order): void
    {
        if (method_exists($order, 'save')) {
            $order->save();
        }
    }

    private function is_customer_email_id(string $id): bool
    {
        return str_starts_with($id, 'customer_');
    }
}
