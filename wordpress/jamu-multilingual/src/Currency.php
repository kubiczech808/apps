<?php

namespace Jamu\Multilingual;

defined('ABSPATH') || exit;

final class Currency
{
    private const YAY_CURRENCY_COOKIE = 'yay_currency_widget';
    private const YAY_SWITCHER_COOKIE = 'yay_currency_do_change_switcher';

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
