<?php

namespace Jamu\Multilingual;

defined('ABSPATH') || exit;

final class Shipping
{
    public function __construct(private Languages $languages)
    {
    }

    public function register(): void
    {
        add_filter('woocommerce_update_order_review_fragments', [$this, 'remove_unsafe_pickup_fragment_script'], PHP_INT_MAX);
        add_action('wp_head', [$this, 'dpd_pickup_bootstrap'], 1);
        add_action('template_redirect', [$this, 'replace_legacy_dpd_script'], 0);
        add_action('wp_footer', [$this, 'dpd_pickup_compatibility'], 1);
    }

    /**
     * A legacy Packeta shipping-rate template injects this raw script into the
     * checkout-review fragment. It writes to optional shipping fields without
     * checking that WooCommerce rendered them, which aborts the AJAX refresh
     * and leaves its loading overlay visible. The maintained widget already
     * manages the pickup selection, so this duplicate legacy synchronisation
     * is safely removed before it reaches the browser.
     *
     * @param array<string, string> $fragments
     * @return array<string, string>
     */
    public function remove_unsafe_pickup_fragment_script(array $fragments): array
    {
        foreach ($fragments as $selector => $html) {
            $fragments[$selector] = $this->remove_unsafe_pickup_script((string) $html);
        }

        return $fragments;
    }

    private function remove_unsafe_pickup_script(string $html): string
    {
        $unsafe_pickup_script = '#<script>\s*document\.getElementById\(["\']customer_details["\']\).*?document\.getElementById\(["\']shipping_city["\']\)\.value\s*=\s*["\']["\'];\s*</script>#is';

        return (string) preg_replace($unsafe_pickup_script, '', $html);
    }

    /**
     * WC Doprava prints dpd.js directly instead of registering it with
     * WordPress. Its message listeners write to removed checkout nodes and
     * can leave the checkout overlay active. Replace just that file on the
     * checkout page with a compatible, null-safe picker bridge.
     */
    public function replace_legacy_dpd_script(): void
    {
        if (is_admin() || !function_exists('is_checkout') || !is_checkout()) {
            return;
        }

        ob_start([$this, 'replace_legacy_dpd_script_html']);
    }

    public function replace_legacy_dpd_script_html(string $html): string
    {
        $html = $this->remove_unsafe_pickup_script($html);
        $pattern = '#<script\b[^>]*\bsrc=["\'][^"\']*/WC-Doprava-main/js/dpd\.js(?:\?[^"\']*)?["\'][^>]*>\s*</script>#i';
        $html = (string) preg_replace_callback($pattern, static function (): string {
            return <<<'HTML'
<script id="jamu-ml-safe-dpd-picker">
(function (window, document) {
    const Packeta = window.Packeta = window.Packeta || {};
    const Widget = Packeta.Widget = Packeta.Widget || {};
    let overlay = null;
    let messageHandler = null;

    function hide() {
        if (overlay) {
            overlay.style.visibility = 'hidden';
        }
        if (messageHandler) {
            window.removeEventListener('message', messageHandler, false);
            messageHandler = null;
        }
    }

    Widget.baseUrl = 'https://api.dpd.cz/widget/latest/index.html';
    Widget.close = hide;
    Widget.pick = function (apiKey, callback, options, container) {
        hide();
        options = options || {};
        const embedded = container != null;
        const source = apiKey === 'no'
            ? Widget.baseUrl + '?disableLockers=true'
            : Widget.baseUrl;

        overlay = embedded ? container : document.createElement('div');
        if (!embedded) {
            overlay.setAttribute('style', 'z-index:999999;position:fixed;left:0;top:0;width:100%;height:100%;background:' + (options.overlayColor || 'rgba(0,0,0,.3)') + ';');
            overlay.addEventListener('click', hide);
            document.body.appendChild(overlay);
        }

        const frame = document.createElement('iframe');
        frame.id = 'packeta-widget';
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        frame.setAttribute('allow', 'geolocation');
        frame.setAttribute('src', source);
        frame.setAttribute('style', embedded
            ? 'border:hidden;width:100%;height:100%;'
            : 'border:hidden;position:absolute;left:0;top:0;width:100%;height:100%;padding:10px 5px;box-sizing:border-box;background:#fff;');
        overlay.appendChild(frame);
        overlay.setAttribute('tabindex', '-1');
        overlay.classList.add('visible');

        messageHandler = function (event) {
            const point = event.data && event.data.dpdWidget;
            if (!point) {
                return;
            }
            if (point.message === 'widgetClose') {
                hide();
                return;
            }
            if (typeof callback === 'function') {
                callback(point);
            }
            hide();
        };
        window.addEventListener('message', messageHandler, false);
        overlay.focus();
    };
})(window, document);
</script>
HTML;
        }, $html, 1);

        // The same legacy plugin prints four inline handlers for DPD, Zásilkovna,
        // Czech Post and GLS. They all operate on the same temporary fields and
        // assume fragments never change. The maintained Packeta integration and
        // the safe DPD bridge above own the picker flow, so these duplicate state
        // handlers must not run on checkout.
        $legacy_inline = '#<script\b[^>]*>\s*var\s+packetaApiKey\s*=.*?function\s+showSelectedPickupPoint\s*\(\s*point\s*\).*?</script>#is';

        return (string) preg_replace($legacy_inline, '', $html);
    }

    /**
     * Create the fields used by WC Doprava before WooCommerce's initial
     * checkout refresh. The third-party scripts assume that every field is
     * present and write to it without null checks.
     */
    public function dpd_pickup_bootstrap(): void
    {
        if (!function_exists('is_checkout') || !is_checkout()) {
            return;
        }
        ?>
<script id="jamu-ml-dpd-pickup-bootstrap">
(function () {
    if (window.location.search.indexOf('jamu_checkout_trace=1') !== -1) {
        window.addEventListener('error', function (event) {
            const details = event.error && event.error.stack ? event.error.stack : '';
            window.console.log('JAMU checkout trace:', event.message, event.filename + ':' + event.lineno + ':' + event.colno, details);
        }, true);
    }

    const fields = {
        'packeta-point-id': 'hidden',
        'ship-to-different-address-checkbox': 'checkbox',
        'shipping_first_name': 'hidden',
        'shipping_last_name': 'hidden',
        'shipping_company': 'hidden',
        'shipping_postcode': 'hidden',
        'shipping_address_1': 'hidden',
        'shipping_address_2': 'hidden',
        'shipping_city': 'hidden',
        'billing_first_name': 'hidden',
        'billing_last_name': 'hidden'
    };

    function checkoutForm() {
        return document.querySelector('form.checkout, form.woocommerce-checkout, form[name="checkout"]');
    }

    function ensureFields() {
        const form = checkoutForm();
        if (!form) {
            return;
        }

        Object.keys(fields).forEach(function (id) {
            if (document.getElementById(id)) {
                return;
            }
            const field = document.createElement('input');
            field.id = id;
            field.name = id === 'ship-to-different-address-checkbox' ? 'ship_to_different_address' : id;
            field.type = fields[id];
            field.hidden = true;
            field.autocomplete = 'off';
            form.appendChild(field);
        });

        if (!document.getElementById('packeta-point-info')) {
            const info = document.createElement('span');
            info.id = 'packeta-point-info';
            info.hidden = true;
            info.appendChild(document.createTextNode(''));
            form.appendChild(info);
        }
    }

    document.addEventListener('DOMContentLoaded', ensureFields, { once: true });
    if (document.readyState !== 'loading') {
        ensureFields();
    }
})();
</script>
        <?php
    }

    public function dpd_pickup_compatibility(): void
    {
        if (is_admin() && !wp_doing_ajax()) {
            return;
        }

        $language = $this->languages->current();
        $texts = [
            'cs' => [
                'notSelected' => 'Zatím nevybráno',
                'selectedPrefix' => 'Vybrané výdejní místo:',
                'choosePickupPoint' => 'Vybrat výdejní místo',
                'pickupPoint' => 'Výdejní místo',
                'pickupAndDropoff' => 'Výdejní i podací místo',
                'labelFree' => 'Podání bez štítku (pouze QR kód nebo PIN)',
                'openingHours' => 'Otevírací doba:',
                'navigate' => 'Navigovat',
                'closed' => 'Zavřeno',
            ],
            'en' => [
                'notSelected' => 'No pickup point selected yet',
                'selectedPrefix' => 'Selected pickup point:',
                'choosePickupPoint' => 'Choose pickup point',
                'pickupPoint' => 'Pickup point',
                'pickupAndDropoff' => 'Pickup and drop-off point',
                'labelFree' => 'Label-free drop-off (QR code or PIN only)',
                'openingHours' => 'Opening hours:',
                'navigate' => 'Navigate',
                'closed' => 'Closed',
            ],
            'de' => [
                'notSelected' => 'Noch keine Abholstelle ausgewählt',
                'selectedPrefix' => 'Ausgewählte Abholstelle:',
                'choosePickupPoint' => 'Abholstelle auswählen',
                'pickupPoint' => 'Abholstelle',
                'pickupAndDropoff' => 'Abhol- und Abgabestelle',
                'labelFree' => 'Paketabgabe ohne Etikett (nur QR-Code oder PIN)',
                'openingHours' => 'Öffnungszeiten:',
                'navigate' => 'Navigieren',
                'closed' => 'Geschlossen',
            ],
            'pl' => [
                'notSelected' => 'Nie wybrano jeszcze punktu odbioru',
                'selectedPrefix' => 'Wybrany punkt odbioru:',
                'choosePickupPoint' => 'Wybierz punkt odbioru',
                'pickupPoint' => 'Punkt odbioru',
                'pickupAndDropoff' => 'Punkt odbioru i nadania',
                'labelFree' => 'Nadanie bez etykiety (tylko kod QR lub PIN)',
                'openingHours' => 'Godziny otwarcia:',
                'navigate' => 'Nawiguj',
                'closed' => 'Zamknięte',
            ],
        ];

        $data = [
            'language' => $language,
            'texts' => $texts[$language] ?? $texts[Languages::DEFAULT],
        ];

        printf(
            "<script id=\"jamu-ml-dpd-pickup-compatibility\">\n%s\n</script>\n",
            'window.jamuMlDpdPickup=' . wp_json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ';' . <<<'JS'
(function () {
    const data = window.jamuMlDpdPickup || {};
    const texts = data.texts || {};
    const hiddenIds = [
        'packeta-point-id',
        'shipping_company',
        'shipping_postcode',
        'shipping_address_1',
        'shipping_address_2',
        'shipping_city'
    ];
    const textIds = ['packeta-point-info'];
    const checkboxIds = ['ship-to-different-address-checkbox'];
    const copiedIds = ['shipping_first_name', 'shipping_last_name'];
    const sourceIds = ['billing_first_name', 'billing_last_name'];
    let lastSelection = '';
    let updateTimer = 0;
    const names = {
        'packeta-point-id': 'packeta-point-id',
        'ship-to-different-address-checkbox': 'ship_to_different_address'
    };

    function checkoutForm() {
        return document.querySelector('form.checkout, form.woocommerce-checkout, form[name="checkout"]') || document.body;
    }

    function hideTechnicalCheckbox(element) {
        element.hidden = true;
        element.tabIndex = -1;
        element.setAttribute('aria-hidden', 'true');
        element.style.setProperty('display', 'none', 'important');
        element.style.setProperty('visibility', 'hidden', 'important');
        element.style.position = 'absolute';
        element.style.left = '-9999px';
        element.style.width = '1px';
        element.style.height = '1px';
        element.style.overflow = 'hidden';
    }

    function dpdShippingAnchor() {
        const input = document.querySelector('input.shipping_method[value^="doprava_zasilkovna"], input[name^="shipping_method"][value^="doprava_zasilkovna"]');
        if (!input) {
            return null;
        }
        return document.querySelector('label[for="' + input.id + '"]') || input.closest('li') || input;
    }

    function placeDpdInfo(element) {
        const anchor = dpdShippingAnchor();
        if (anchor && anchor.parentNode && element.parentNode !== anchor.parentNode) {
            anchor.parentNode.insertBefore(element, anchor.nextSibling);
        } else if (!element.parentNode) {
            checkoutForm().appendChild(element);
        }
    }

    function ensureInput(id, type) {
        let element = document.getElementById(id);
        if (element) {
            if (type === 'checkbox') {
                hideTechnicalCheckbox(element);
            }
            return element;
        }
        element = document.createElement('input');
        element.type = type || 'hidden';
        element.id = id;
        element.name = names[id] || id;
        element.autocomplete = 'off';
        if (type === 'checkbox') {
            hideTechnicalCheckbox(element);
        } else {
            element.hidden = true;
        }
        checkoutForm().appendChild(element);
        return element;
    }

    function ensureText(id) {
        let element = document.getElementById(id);
        if (element) {
            if (!element.firstChild) {
                element.appendChild(document.createTextNode(texts.notSelected || ''));
            }
            return element;
        }
        element = document.createElement('span');
        element.id = id;
        element.className = 'jamu-dpd-pickup-info';
        element.style.display = 'block';
        element.style.marginTop = '.4rem';
        element.style.fontSize = '.95em';
        element.appendChild(document.createTextNode(texts.notSelected || ''));
        placeDpdInfo(element);
        return element;
    }

    function ensureDpdElements() {
        hiddenIds.forEach(function (id) {
            ensureInput(id, 'hidden');
        });
        copiedIds.forEach(function (id) {
            ensureInput(id, 'hidden');
        });
        sourceIds.forEach(function (id) {
            ensureInput(id, 'hidden');
        });
        checkboxIds.forEach(function (id) {
            ensureInput(id, 'checkbox');
        });
        textIds.forEach(ensureText);
    }

    function dispatchInput(element) {
        if (!element) {
            return;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setField(selector, value, notify) {
        const element = document.querySelector(selector);
        if (!element || typeof value === 'undefined' || value === null) {
            return;
        }
        const nextValue = String(value);
        if (String(element.value || '') === nextValue) {
            return;
        }
        element.value = nextValue;
        if (notify) {
            dispatchInput(element);
        }
    }

    function updateCheckoutOnce() {
        window.clearTimeout(updateTimer);
        updateTimer = window.setTimeout(function () {
            if (window.jQuery) {
                window.jQuery(document.body).trigger('update_checkout');
            }
        }, 100);
    }

    function restoreDpdFieldsAfterCheckoutRefresh() {
        // WC Doprava has several inline `updated_checkout` handlers that
        // assume these fields survive WooCommerce's fragment replacement.
        // Bind before those handlers (this script is printed first) and
        // recreate only the technical fields they read or write.
        ensureDpdElements();
    }

    function mirrorDpdSelection(message) {
        if (!message || !message.dpdWidget) {
            return;
        }

        // WC Doprava's dpd.js writes directly to these IDs on every widget
        // message (including `widgetClose`). Checkout fragments can remove the
        // hidden fields in between messages, so recreate them in the capture
        // phase before dpd.js receives the same event.
        ensureDpdElements();

        if (message.dpdWidget.message === 'widgetClose') {
            return;
        }

        const point = message.dpdWidget;
        const name = point.contactInfo && point.contactInfo.name ? point.contactInfo.name : '';
        const address = point.location && point.location.address ? point.location.address : {};
        const id = point.id || point.pickupPointResult || name;
        const selection = String(point.pickupPointResult || id || name || '');
        if (!selection || selection === lastSelection) {
            return;
        }
        lastSelection = selection;

        setField('#packeta-point-id', selection, false);
        const info = document.getElementById('packeta-point-info');
        if (info) {
            info.hidden = false;
            info.textContent = name ? (texts.selectedPrefix + ' ' + name) : texts.notSelected || '';
            placeDpdInfo(info);
        }

        setField('[name="shipping_first_name"], #shipping-first_name, #shipping_first_name', (document.querySelector('[name="billing_first_name"], #billing-first_name, #billing_first_name') || {}).value || '', false);
        setField('[name="shipping_last_name"], #shipping-last_name, #shipping_last_name', (document.querySelector('[name="billing_last_name"], #billing-last_name, #billing_last_name') || {}).value || '', false);
        setField('[name="shipping_company"], #shipping-company, #shipping_company', id || '', false);
        setField('[name="shipping_postcode"], #shipping-postcode, #shipping_postcode', address.zip || '', false);
        setField('[name="shipping_address_1"], #shipping-address_1, #shipping_address_1', name || '', false);
        setField('[name="shipping_address_2"], #shipping-address_2, #shipping_address_2', address.street || '', false);
        setField('[name="shipping_city"], #shipping-city, #shipping_city', address.city || '', false);
        updateCheckoutOnce();
    }

    function translateTextNode(node) {
        const replacements = {
            'Zatím nevybráno': texts.notSelected,
            'ZatÃ­m nevybrÃ¡no': texts.notSelected,
            'Vybrat výdejní místo': texts.choosePickupPoint,
            'Vybrat vÃ½dejnÃ­ mÃ­sto': texts.choosePickupPoint,
            'Výdejní i podací místo': texts.pickupAndDropoff,
            'VÃ½dejnÃ­ i podacÃ­ mÃ­sto': texts.pickupAndDropoff,
            'Výdejní místo': texts.pickupPoint,
            'VÃ½dejnÃ­ mÃ­sto': texts.pickupPoint,
            'Podání bez štítku (pouze QR kód nebo PIN)': texts.labelFree,
            'PodÃ¡nÃ­ bez Å¡tÃ­tku (pouze QR kÃ³d nebo PIN)': texts.labelFree,
            'Otevírací doba:': texts.openingHours,
            'OtevÃ­racÃ­ doba:': texts.openingHours,
            'Navigovat': texts.navigate,
            'Zavřeno': texts.closed,
            'ZavÅ™eno': texts.closed,
            'Shipment': data.language === 'de' ? 'Versand' : data.language === 'pl' ? 'Dostawa' : data.language === 'en' ? 'Shipping' : 'Doprava',
            'DPD doručení domů': data.language === 'de' ? 'DPD Lieferung nach Hause' : data.language === 'pl' ? 'DPD dostawa do domu' : data.language === 'en' ? 'DPD home delivery' : 'DPD doručení domů',
            'DPD doruÄŤenĂ­ domĹŻ': data.language === 'de' ? 'DPD Lieferung nach Hause' : data.language === 'pl' ? 'DPD dostawa do domu' : data.language === 'en' ? 'DPD home delivery' : 'DPD doručení domů'
        };
        const original = node.nodeValue || '';
        let updated = original;
        for (const source in replacements) {
            const target = replacements[source];
            if (target) {
                updated = updated.split(source).join(target);
            }
        }
        if (updated !== original) {
            node.nodeValue = updated;
        }
    }

    function translateDpdUi(root) {
        const scope = root && root.nodeType === 1 ? root : document.body;
        if (!scope) {
            return;
        }
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const value = node.nodeValue || '';
                return /Zat|Vybrat|Výdej|VÃ½dejn|Podání|PodÃ¡n|Otevír|OtevÃ|Navigovat|Zavřeno|ZavÅ|Shipment|DPD doru/.test(value)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_SKIP;
            }
        });
        const nodes = [];
        while (walker.nextNode()) {
            nodes.push(walker.currentNode);
        }
        nodes.forEach(translateTextNode);
    }

    function clonePlain(value) {
        if (!value || typeof value !== 'object') {
            return value;
        }
        if (Array.isArray(value)) {
            return value.map(clonePlain);
        }
        const output = {};
        Object.keys(value).forEach(function (key) {
            output[key] = clonePlain(value[key]);
        });
        return output;
    }

    function normalizePacketaWidgetOptions(options) {
        if (!options || typeof options !== 'object') {
            return options;
        }

        const country = String(options.country || '').toLowerCase();
        const vendors = Array.isArray(options.vendors) ? options.vendors : [];
        const hasGermanHermesOnly = country === 'de'
            && vendors.length > 0
            && vendors.every(function (vendor) {
                return vendor && String(vendor.carrierId || '') === '6828';
            });

        if (!hasGermanHermesOnly) {
            return options;
        }

        const next = clonePlain(options);
        if (!Number(next.weight)) {
            delete next.weight;
        }
        next.country = 'de';
        next.language = next.language || data.language || 'de';
        next.vendors = [
            { country: 'de', group: '', selected: true },
            { country: 'de', group: 'zbox' },
            { carrierId: '6828' }
        ];
        next.jamuMlPatched = true;

        if (window.console && typeof window.console.info === 'function') {
            window.console.info('JAMU multilingual: expanded Packeta German pickup vendors', next);
        }

        return next;
    }

    function patchPacketaWidget(widget) {
        if (!widget || typeof widget.pick !== 'function' || widget.pick.jamuMlPatched) {
            return false;
        }

        const originalPick = widget.pick;
        widget.pick = function (apiKey, callback, options) {
            // WC Doprava registers unsafe `dpdWidget` message handlers inside
            // pick(). Guard those handlers at registration time: a checkout
            // fragment can disappear while the external picker is open.
            const nativeAddEventListener = window.addEventListener;
            let didWrap = false;

            try {
                window.addEventListener = function (type, listener, listenerOptions) {
                    if (type === 'message' && typeof listener === 'function' && String(listener).indexOf('dpdWidget') !== -1) {
                        const guardedListener = function (event) {
                            ensureDpdElements();
                            try {
                                return listener.call(this, event);
                            } catch (error) {
                                // Selection and closing are handled by the safe
                                // multilingual listener above. Do not let the
                                // legacy listener leave WooCommerce blocked.
                                if (window.console && typeof window.console.warn === 'function') {
                                    window.console.warn('JAMU multilingual: prevented a legacy DPD picker error.');
                                }
                            }
                        };
                        return nativeAddEventListener.call(this, type, guardedListener, listenerOptions);
                    }
                    return nativeAddEventListener.call(this, type, listener, listenerOptions);
                };
                didWrap = window.addEventListener !== nativeAddEventListener;

                return originalPick.call(this, apiKey, callback, normalizePacketaWidgetOptions(options));
            } finally {
                if (didWrap) {
                    window.addEventListener = nativeAddEventListener;
                }
            }
        };
        widget.pick.jamuMlPatched = true;
        return true;
    }

    function observePacketaWidget(packeta) {
        if (!packeta || typeof packeta !== 'object') {
            return;
        }

        const descriptor = Object.getOwnPropertyDescriptor(packeta, 'Widget');
        if (descriptor && descriptor.configurable === false) {
            patchPacketaWidget(packeta.Widget);
            return;
        }
        if (descriptor && descriptor.get && descriptor.get.jamuMlWidgetObserver) {
            patchPacketaWidget(packeta.Widget);
            return;
        }

        let storedWidget = packeta.Widget;
        const getWidget = function () {
            return storedWidget;
        };
        getWidget.jamuMlWidgetObserver = true;

        try {
            Object.defineProperty(packeta, 'Widget', {
                configurable: true,
                enumerable: true,
                get: getWidget,
                set(value) {
                    storedWidget = value;
                    patchPacketaWidget(storedWidget);
                }
            });
        } catch (error) {
            // The interval fallback below will patch a non-configurable object.
        }

        patchPacketaWidget(storedWidget);
    }

    function patchPacketaObject(packeta) {
        if (!packeta || typeof packeta !== 'object') {
            return false;
        }
        observePacketaWidget(packeta);
        return patchPacketaWidget(packeta.Widget);
    }

    function installPacketaPatch() {
        let stored = window.Packeta;
        patchPacketaObject(stored);

        try {
            const descriptor = Object.getOwnPropertyDescriptor(window, 'Packeta');
            if (!descriptor || descriptor.configurable !== false) {
                Object.defineProperty(window, 'Packeta', {
                    configurable: true,
                    enumerable: true,
                    get() {
                        return stored;
                    },
                    set(value) {
                        stored = value;
                        patchPacketaObject(stored);
                    }
                });
            }
        } catch (error) {
            window.setInterval(function () {
                patchPacketaObject(window.Packeta);
            }, 250);
        }

        let attempts = 0;
        const timer = window.setInterval(function () {
            attempts += 1;
            if (patchPacketaObject(window.Packeta) || attempts >= 80) {
                window.clearInterval(timer);
            }
        }, 250);
    }

    installPacketaPatch();
    ensureDpdElements();
    if (window.jQuery) {
        window.jQuery(document.body).on('updated_checkout.jamuMlDpd updated_wc_div.jamuMlDpd', restoreDpdFieldsAfterCheckoutRefresh);
    }
    translateDpdUi(document.body);

    window.addEventListener('message', function (event) {
        if (!event.data || !event.data.dpdWidget) {
            return;
        }

        // WC Doprava's legacy dpd.js subsequently handles the same message
        // and writes to checkout fields without null checks. WooCommerce may
        // have replaced those fields while the picker was open. We own the
        // compatible, guarded update above, so do not let that listener run.
        mirrorDpdSelection(event.data);
        if (event.data.dpdWidget.message === 'widgetClose') {
            const frame = document.getElementById('packeta-widget');
            if (frame && frame.parentElement) {
                frame.parentElement.style.visibility = 'hidden';
            }
        }
    }, true);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            ensureDpdElements();
            translateDpdUi(document.body);
        });
    }

    new MutationObserver(function (mutations) {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1) {
                    translateDpdUi(node);
                }
            }
        }
    }).observe(document.documentElement, { childList: true, subtree: true });
})();
JS
        );
    }
}
