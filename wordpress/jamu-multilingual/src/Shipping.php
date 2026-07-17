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
        add_action('wp_footer', [$this, 'dpd_pickup_compatibility'], 1);
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

    function setField(selector, value) {
        const element = document.querySelector(selector);
        if (!element || typeof value === 'undefined' || value === null) {
            return;
        }
        element.value = value;
        dispatchInput(element);
    }

    function mirrorDpdSelection(message) {
        if (!message || !message.dpdWidget || message.dpdWidget.message === 'widgetClose') {
            return;
        }

        ensureDpdElements();

        const point = message.dpdWidget;
        const name = point.contactInfo && point.contactInfo.name ? point.contactInfo.name : '';
        const address = point.location && point.location.address ? point.location.address : {};
        const id = point.id || point.pickupPointResult || name;

        setField('#packeta-point-id', point.pickupPointResult || id || name);
        const info = document.getElementById('packeta-point-info');
        if (info) {
            info.hidden = false;
            info.textContent = name ? (texts.selectedPrefix + ' ' + name) : texts.notSelected || '';
            placeDpdInfo(info);
        }

        setField('[name="shipping_first_name"], #shipping-first_name, #shipping_first_name', (document.querySelector('[name="billing_first_name"], #billing-first_name, #billing_first_name') || {}).value || '');
        setField('[name="shipping_last_name"], #shipping-last_name, #shipping_last_name', (document.querySelector('[name="billing_last_name"], #billing-last_name, #billing_last_name') || {}).value || '');
        setField('[name="shipping_company"], #shipping-company, #shipping_company', id || '');
        setField('[name="shipping_postcode"], #shipping-postcode, #shipping_postcode', address.zip || '');
        setField('[name="shipping_address_1"], #shipping-address_1, #shipping_address_1', name || '');
        setField('[name="shipping_address_2"], #shipping-address_2, #shipping_address_2', address.street || '');
        setField('[name="shipping_city"], #shipping-city, #shipping_city', address.city || '');
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
            return originalPick.call(this, apiKey, callback, normalizePacketaWidgetOptions(options));
        };
        widget.pick.jamuMlPatched = true;
        return true;
    }

    function patchPacketaObject(packeta) {
        if (!packeta || typeof packeta !== 'object') {
            return false;
        }
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
    translateDpdUi(document.body);

    window.addEventListener('message', function (event) {
        mirrorDpdSelection(event.data);
    }, true);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            ensureDpdElements();
            translateDpdUi(document.body);
        });
    }

    new MutationObserver(function (mutations) {
        ensureDpdElements();
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
