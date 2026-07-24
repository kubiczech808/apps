<?php

namespace Jamu\Multilingual;

defined('ABSPATH') || exit;

final class Currency
{
    private const YAY_CURRENCY_COOKIE = 'yay_currency_widget';
    private const YAY_SWITCHER_COOKIE = 'yay_currency_do_change_switcher';
    private const BANK_TRANSFER_DISCOUNT_CZK = 10.0;

    /**
     * Approximate display/business rates used for converting the fixed CZK
     * bank-transfer discount into the currency forced by the current language.
     *
     * Base: 1 foreign currency unit in CZK.
     */
    private const CZK_RATES = [
        'EUR' => 24.25,
        'PLN' => 5.58,
    ];

    private const CHECKOUT_GATEWAY_IDS = [
        'bacs',
        'cod',
        'woocommerce_payments',
        'stripe_applepay',
        'stripe_googlepay',
        'stripe_sepa',
    ];

    private const MAP = [
        'cs' => ['code' => 'CZK', 'id' => '3347'],
        'en' => ['code' => 'EUR', 'id' => '3348'],
        'de' => ['code' => 'EUR', 'id' => '3348'],
        'pl' => ['code' => 'PLN', 'id' => '4519'],
    ];

    public function __construct(private Languages $languages)
    {
    }

    public function register(): void
    {
        $this->set_request_currency();
        add_action('init', [$this, 'set_request_currency'], 0);
        add_filter('wc_get_price_decimals', [$this, 'price_decimals'], 20);
        add_action('woocommerce_cart_calculate_fees', [$this, 'normalize_bank_transfer_discount_fee'], PHP_INT_MAX);
        add_filter('woocommerce_available_payment_gateways', [$this, 'available_payment_gateways'], PHP_INT_MAX);
        add_action('wp_footer', [$this, 'payment_gateway_frontend_guard'], 5);
        add_action('wp_footer', [$this, 'frontend_fallback'], 90);
    }

    public function set_request_currency(): void
    {
        if (!$this->should_apply()) {
            return;
        }

        $target = $this->target();
        if (!$target) {
            return;
        }

        $_COOKIE[self::YAY_CURRENCY_COOKIE] = $target['id'];
        $_COOKIE[self::YAY_SWITCHER_COOKIE] = '1';

        if (headers_sent()) {
            return;
        }

        $this->set_cookie(self::YAY_CURRENCY_COOKIE, $target['id']);
        $this->set_cookie(self::YAY_SWITCHER_COOKIE, '1');
    }

    public function frontend_fallback(): void
    {
        if (!$this->should_apply()) {
            return;
        }

        $target = $this->target();
        if (!$target) {
            return;
        }

        $data = [
            'language' => $this->languages->current(),
            'code' => $target['code'],
            'id' => $target['id'],
            'cookieName' => self::YAY_CURRENCY_COOKIE,
            'switcherCookieName' => self::YAY_SWITCHER_COOKIE,
        ];

        printf(
            "<script id=\"jamu-ml-currency\">\n%s\n</script>\n",
            'window.jamuMlCurrency=' . wp_json_encode($data, JSON_UNESCAPED_SLASHES) . ';' . <<<'JS'
(function () {
    const data = window.jamuMlCurrency || {};
    const targetCode = String(data.code || '').toUpperCase();
    let targetId = String(data.id || '');
    if (!targetCode || !targetId) {
        return;
    }

    const yay = window.yay_callback_data || {};
    const cookieName = yay.cookie_name || data.cookieName || 'yay_currency_widget';
    const switcherCookieName = yay.cookie_switcher_name || data.switcherCookieName || 'yay_currency_do_change_switcher';

    function setCookie(name, value) {
        const secure = window.location.protocol === 'https:' ? '; Secure' : '';
        document.cookie = encodeURIComponent(name) + '=' + encodeURIComponent(value) + '; path=/; max-age=2592000; SameSite=Lax' + secure;
    }

    function currentCurrencyIdFromYayData() {
        const currencies = Array.isArray(yay.converted_currency) ? yay.converted_currency : [];
        for (const currency of currencies) {
            if (String(currency.currency || '').toUpperCase() === targetCode && currency.ID) {
                return String(currency.ID);
            }
        }
        return '';
    }

    targetId = currentCurrencyIdFromYayData() || targetId;
    setCookie(cookieName, targetId);
    setCookie(switcherCookieName, '1');

    function selectedSwitcher(select) {
        return select && String(select.value || '') === targetId;
    }

    function setSelect(select) {
        if (!select || selectedSwitcher(select)) {
            return false;
        }
        const option = Array.from(select.options || []).find((item) => String(item.value || '') === targetId);
        if (!option) {
            return false;
        }
        select.value = targetId;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    function apply() {
        const switchers = Array.from(document.querySelectorAll('select.yay-currency-switcher, select[name="currency"]'));
        if (!switchers.length) {
            return;
        }

        const alreadySelected = switchers.some(selectedSwitcher);
        if (alreadySelected) {
            return;
        }

        const key = 'jamuMlCurrencyApplied:' + targetCode + ':' + window.location.pathname;
        if (window.sessionStorage && window.sessionStorage.getItem(key) === '1') {
            return;
        }
        if (window.sessionStorage) {
            window.sessionStorage.setItem(key, '1');
        }

        for (const select of switchers) {
            if (setSelect(select)) {
                if (select.form && typeof select.form.submit === 'function') {
                    select.form.submit();
                }
                return;
            }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', apply);
    } else {
        apply();
    }
})();
JS
        );
    }

    public function available_payment_gateways(array $gateways): array
    {
        if (!$this->should_apply() || !$this->uses_pln_currency()) {
            return $gateways;
        }

        if (!function_exists('WC') || !WC() || !WC()->payment_gateways()) {
            return $gateways;
        }

        $all_gateways = WC()->payment_gateways()->payment_gateways();
        if (!is_array($all_gateways)) {
            return $gateways;
        }

        foreach (self::CHECKOUT_GATEWAY_IDS as $gateway_id) {
            if (isset($gateways[$gateway_id]) || empty($all_gateways[$gateway_id])) {
                continue;
            }

            $gateway = $all_gateways[$gateway_id];
            if (!$this->gateway_can_be_restored($gateway)) {
                continue;
            }

            $gateways[$gateway_id] = $gateway;
        }

        return $this->sort_gateways($gateways);
    }

    public function price_decimals(int $decimals): int
    {
        $target = $this->target();
        $currency = is_array($target) ? (string) ($target['code'] ?? '') : '';

        if (in_array($currency, ['EUR', 'PLN'], true)) {
            return max(2, $decimals);
        }

        return $decimals;
    }

    public function normalize_bank_transfer_discount_fee($cart): void
    {
        if (!$this->should_apply() || !is_object($cart)) {
            return;
        }

        $target = $this->target();
        $currency = is_array($target) ? (string) ($target['code'] ?? '') : '';
        if (!in_array($currency, ['EUR', 'PLN'], true)) {
            return;
        }

        $discount = $this->converted_bank_transfer_discount($currency);
        if ($discount <= 0) {
            return;
        }

        $amount = -1 * $discount;
        $found = false;

        if (method_exists($cart, 'fees_api') && $cart->fees_api()) {
            foreach ($cart->fees_api()->get_fees() as $fee) {
                if (!$this->is_bank_transfer_discount_fee($fee)) {
                    continue;
                }

                $fee->amount = $amount;
                $fee->total = $amount;
                $fee->tax = 0.0;
                $fee->tax_data = [];
                $found = true;
            }
        }

        if (!$found && $this->selected_payment_method() === 'bacs' && method_exists($cart, 'add_fee')) {
            $cart->add_fee($this->bank_transfer_discount_label($currency), $amount, false);
        }
    }

    public function payment_gateway_frontend_guard(): void
    {
        if (!$this->should_apply() || !$this->uses_pln_currency()) {
            return;
        }

        $gateway_ids = array_values(self::CHECKOUT_GATEWAY_IDS);

        printf(
            "<script id=\"jamu-ml-payment-gateway-guard\">\n%s\n</script>\n",
            'window.jamuMlPaymentGateways=' . wp_json_encode(['ids' => $gateway_ids], JSON_UNESCAPED_SLASHES) . ';' . <<<'JS'
(function () {
    const allowedIds = (window.jamuMlPaymentGateways && window.jamuMlPaymentGateways.ids) || [];
    if (!allowedIds.length) {
        return;
    }

    function patchYayCurrencyData(data) {
        if (!data || !Array.isArray(data.converted_currency)) {
            return data;
        }

        for (const currency of data.converted_currency) {
            if (String(currency.currency || '').toUpperCase() === 'PLN') {
                currency.paymentMethods = ['all'];
            }
        }
        return data;
    }

    function restoreHiddenPaymentMethods(root) {
        const scope = root && root.nodeType === 1 ? root : document.body;
        if (!scope) {
            return;
        }

        for (const id of allowedIds) {
            const selectors = [
                '[value="' + id + '"]',
                '[data-gateway_id="' + id + '"]',
                '[data-payment-method="' + id + '"]',
                '[id*="' + id + '"]',
                '[class*="' + id + '"]'
            ];
            for (const element of scope.querySelectorAll(selectors.join(','))) {
                const wrapper = element.closest('li,fieldset,.wc-block-components-radio-control__option,.wc-block-components-payment-methods__payment-method,.payment_method_' + id) || element;
                wrapper.hidden = false;
                wrapper.removeAttribute('hidden');
                wrapper.style.removeProperty('display');
                wrapper.style.removeProperty('visibility');
            }
        }
    }

    if (Object.prototype.hasOwnProperty.call(window, 'yay_callback_data')) {
        window.yay_callback_data = patchYayCurrencyData(window.yay_callback_data);
    } else {
        try {
            Object.defineProperty(window, 'yay_callback_data', {
                configurable: true,
                get() {
                    return undefined;
                },
                set(value) {
                    const patched = patchYayCurrencyData(value);
                    Object.defineProperty(window, 'yay_callback_data', {
                        configurable: true,
                        writable: true,
                        value: patched
                    });
                }
            });
        } catch (error) {
            // If another script already locked the property, the server-side gateway filter still applies.
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            restoreHiddenPaymentMethods(document.body);
        });
    } else {
        restoreHiddenPaymentMethods(document.body);
    }

    new MutationObserver(function (mutations) {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1) {
                    restoreHiddenPaymentMethods(node);
                }
            }
        }
    }).observe(document.documentElement, { childList: true, subtree: true });
})();
JS
        );
    }

    private function should_apply(): bool
    {
        if (wp_doing_cron()) {
            return false;
        }
        if (is_admin() && !wp_doing_ajax()) {
            return false;
        }
        if (strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')) === 'POST' && isset($_POST['currency'])) {
            return false;
        }
        return true;
    }

    private function target(): ?array
    {
        $language = $this->languages->current();
        return self::MAP[$language] ?? null;
    }

    private function uses_pln_currency(): bool
    {
        $cookie = sanitize_text_field(wp_unslash((string) ($_COOKIE[self::YAY_CURRENCY_COOKIE] ?? '')));
        if ($cookie === self::MAP['pl']['id']) {
            return true;
        }

        $target = $this->target();
        return is_array($target) && ($target['code'] ?? '') === 'PLN';
    }

    private function gateway_can_be_restored(object $gateway): bool
    {
        if (isset($gateway->enabled) && $gateway->enabled !== 'yes') {
            return false;
        }

        if (method_exists($gateway, 'is_available')) {
            return (bool) $gateway->is_available();
        }

        return true;
    }

    private function selected_payment_method(): string
    {
        if (isset($_POST['payment_method'])) {
            return sanitize_key(wp_unslash((string) $_POST['payment_method']));
        }

        if (isset($_POST['post_data'])) {
            $post_data = [];
            parse_str(wp_unslash((string) $_POST['post_data']), $post_data);
            if (isset($post_data['payment_method'])) {
                return sanitize_key((string) $post_data['payment_method']);
            }
        }

        if (function_exists('WC') && WC() && WC()->session) {
            return sanitize_key((string) WC()->session->get('chosen_payment_method'));
        }

        return '';
    }

    private function converted_bank_transfer_discount(string $currency): float
    {
        $rate = self::CZK_RATES[$currency] ?? 0.0;
        if ($rate <= 0) {
            return 0.0;
        }

        return round(self::BANK_TRANSFER_DISCOUNT_CZK / $rate, 2);
    }

    private function is_bank_transfer_discount_fee(object $fee): bool
    {
        $amount = isset($fee->amount) ? (float) $fee->amount : 0.0;
        if ($amount > 0) {
            return false;
        }

        $name = strtolower(remove_accents(wp_strip_all_tags((string) ($fee->name ?? ''))));
        if ($name === '') {
            return false;
        }

        foreach (['bank', 'prevod', 'preved', 'przelew', 'uberweisung', 'qr'] as $needle) {
            if (str_contains($name, $needle)) {
                return true;
            }
        }

        return false;
    }

    private function bank_transfer_discount_label(string $currency): string
    {
        return match ($this->languages->current()) {
            'de' => 'Per Banküberweisung',
            'pl' => 'Przelewem bankowym',
            'en' => 'By bank transfer',
            default => $currency === 'PLN' ? 'Przelewem bankowym' : 'By bank transfer',
        };
    }

    private function sort_gateways(array $gateways): array
    {
        $ordered = [];
        foreach (self::CHECKOUT_GATEWAY_IDS as $gateway_id) {
            if (isset($gateways[$gateway_id])) {
                $ordered[$gateway_id] = $gateways[$gateway_id];
                unset($gateways[$gateway_id]);
            }
        }

        return $ordered + $gateways;
    }

    private function set_cookie(string $name, string $value): void
    {
        $options = [
            'expires' => time() + MONTH_IN_SECONDS,
            'path' => '/',
            'secure' => is_ssl(),
            'httponly' => false,
            'samesite' => 'Lax',
        ];

        $domain = defined('COOKIE_DOMAIN') ? (string) COOKIE_DOMAIN : '';
        if ($domain !== '') {
            $options['domain'] = $domain;
        }

        setcookie($name, $value, $options);
    }
}
