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
        add_action('woocommerce_checkout_before_customer_details', [$this, 'render_checkout_language_field'], 1);
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

    public function render_checkout_language_field(): void
    {
        printf(
            '<input type="hidden" name="jamu_ml_language" value="%s">',
            esc_attr($this->languages->current())
        );
    }

    public function store_checkout_language($order, mixed $data = null): void
    {
        $order = $this->normalize_order($order);
        if (!$order) {
            return;
        }

        $this->set_order_language($order, $this->checkout_language($data) ?: $this->languages->current());
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

        return $this->translate_email_text($text);
    }

    public function restore_after_mail_params(array $params): array
    {
        if ($this->context_depth > 0) {
            foreach ([1, 2] as $index) {
                if (isset($params[$index]) && is_string($params[$index]) && $params[$index] !== '') {
                    $params[$index] = $this->translate_email_text($params[$index]);
                }
            }
        }

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

    private function checkout_language(mixed $data = null): string
    {
        $language = $this->language_from_payload($data);
        if ($language !== '') {
            return $language;
        }

        $language = $this->language_from_payload($_POST);
        if ($language !== '') {
            return $language;
        }

        $language = $this->language_from_payload($_REQUEST);
        if ($language !== '') {
            return $language;
        }

        $referer = (string) ($_SERVER['HTTP_REFERER'] ?? '');
        if ($referer !== '') {
            $language = $this->language_from_url($referer);
            if ($language !== '') {
                return $language;
            }
        }

        $cookie = $this->valid_language((string) ($_COOKIE['jamu_lang'] ?? ''));
        return $cookie !== '' ? $cookie : '';
    }

    private function language_from_payload(mixed $payload): string
    {
        if (is_object($payload) && method_exists($payload, 'get_param')) {
            $language = $this->valid_language((string) $payload->get_param('jamu_ml_language'));
            if ($language !== '') {
                return $language;
            }

            $language = $this->valid_language((string) $payload->get_param('jamu_lang'));
            if ($language !== '') {
                return $language;
            }

            $extensions = $payload->get_param('extensions');
            if (is_array($extensions)) {
                return $this->language_from_payload($extensions);
            }
        }

        if (!is_array($payload)) {
            return '';
        }

        foreach (['jamu_ml_language', 'jamu_lang', 'language', 'lang'] as $key) {
            if (isset($payload[$key]) && is_scalar($payload[$key])) {
                $language = $this->valid_language((string) wp_unslash($payload[$key]));
                if ($language !== '') {
                    return $language;
                }
            }
        }

        foreach (['jamu-multilingual', 'jamu_ml', 'extensions'] as $key) {
            if (isset($payload[$key]) && is_array($payload[$key])) {
                $language = $this->language_from_payload($payload[$key]);
                if ($language !== '') {
                    return $language;
                }
            }
        }

        return '';
    }

    private function language_from_url(string $url): string
    {
        $path = wp_parse_url($url, PHP_URL_PATH);
        if (!is_string($path)) {
            $path = $url;
        }

        $first = strtok(trim($path, '/'), '/') ?: '';
        return $this->valid_language($first);
    }

    private function translate_email_text(string $text): string
    {
        $language = $this->languages->current();
        if ($language === Languages::DEFAULT) {
            return $text;
        }

        $text = strtr($text, $this->email_exact_replacements($language));

        foreach ($this->email_regex_replacements($language) as $pattern => $replacement) {
            $text = (string) preg_replace($pattern, $replacement, $text);
        }

        return $text;
    }

    /**
     * @return array<string, string>
     */
    private function email_exact_replacements(string $language): array
    {
        $common = [
            'Tajemství JAMU - Built with WooCommerce' => 'Tajemství JAMU',
            'Tajemství JAMU — Built with WooCommerce' => 'Tajemství JAMU',
        ];

        $map = [
            'en' => [
                'Objednávka z Tajemství JAMU 🌿 čeká na zaplacení' => 'Your order from Tajemství JAMU 🌿 is awaiting payment',
                'Objednávku z Tajemství JAMU 🌿 jsem přijala ✅' => 'We have received your order from Tajemství JAMU 🌿 ✅',
                'Děkuji Vám za objednávku.' => 'Thank you for your order.',
                'Děkujeme Vám za objednávku' => 'Thank you for your order',
                'Dobrý den,' => 'Hello,',
                'Pro platbu CZK' => 'For CZK payment',
                'Pro platbu EUR' => 'For EUR payment',
                'Číslo účtu:' => 'Account number:',
                'Částka:' => 'Amount:',
                'Variabilní symbol:' => 'Variable symbol:',
                'Produkty' => 'Products',
                'Počet:' => 'Quantity:',
                'Cena:' => 'Price:',
                'Mezisoučet:' => 'Subtotal:',
                'Bankovním převodem:' => 'By bank transfer:',
                'Platební metoda:' => 'Payment method:',
                'Způsob platby:' => 'Payment method:',
                'Doprava:' => 'Shipping:',
                'Celkem:' => 'Total:',
                'Total:' => 'Total:',
                'Fakturační adresa' => 'Billing address',
                'Doručovací adresa' => 'Shipping address',
                'Pokud byste měli jakékoli otázky nebo potřebovali další informace, neváhejte mě kontaktovat. Jsem tady pro vás a ráda pomůžu.' => 'If you have any questions or need more information, please feel free to contact me. I am here for you and happy to help.',
                'S přáním krásného dne a zdraví,' => 'Wishing you a beautiful day and good health,',
                'Sledujte moji cestu za zdravím skrz poznávání tradičního léčitelství.' => 'Follow my journey towards health through the exploration of traditional healing.',
                'Děkujeme, že používáte tajemstvijamu.cz!' => 'Thank you for using tajemstvijamu.cz!',
                'prostřednictvím' => 'via',
                'Bank transfer / QR code (-10 Kč)' => 'Bank transfer / QR code (-0.41 €)',
                'Převodem / QR kódem (-10 Kč)' => 'Bank transfer / QR code (-0.41 €)',
                'Německo' => 'Germany',
                'Germany' => 'Germany',
            ],
            'de' => [
                'Objednávka z Tajemství JAMU 🌿 čeká na zaplacení' => 'Ihre Bestellung bei Tajemství JAMU 🌿 wartet auf Zahlung',
                'Objednávku z Tajemství JAMU 🌿 jsem přijala ✅' => 'Wir haben Ihre Bestellung bei Tajemství JAMU 🌿 erhalten ✅',
                'Děkuji Vám za objednávku.' => 'Vielen Dank für Ihre Bestellung.',
                'Děkujeme Vám za objednávku' => 'Vielen Dank für Ihre Bestellung',
                'Dobrý den,' => 'Guten Tag,',
                'Pro platbu CZK' => 'Für Zahlung in CZK',
                'Pro platbu EUR' => 'Für Zahlung in EUR',
                'Číslo účtu:' => 'Kontonummer:',
                'Částka:' => 'Betrag:',
                'Variabilní symbol:' => 'Verwendungszweck:',
                'Produkty' => 'Produkte',
                'Počet:' => 'Anzahl:',
                'Cena:' => 'Preis:',
                'Mezisoučet:' => 'Zwischensumme:',
                'Bankovním převodem:' => 'Per Banküberweisung:',
                'Platební metoda:' => 'Zahlungsart:',
                'Způsob platby:' => 'Zahlungsart:',
                'Doprava:' => 'Versand:',
                'Celkem:' => 'Gesamtsumme:',
                'Total:' => 'Gesamtsumme:',
                'Fakturační adresa' => 'Rechnungsadresse',
                'Doručovací adresa' => 'Lieferadresse',
                'Pokud byste měli jakékoli otázky nebo potřebovali další informace, neváhejte mě kontaktovat. Jsem tady pro vás a ráda pomůžu.' => 'Wenn Sie Fragen haben oder weitere Informationen benötigen, kontaktieren Sie mich bitte jederzeit. Ich bin gerne für Sie da und helfe weiter.',
                'S přáním krásného dne a zdraví,' => 'Mit den besten Wünschen für einen schönen Tag und Gesundheit,',
                'Sledujte moji cestu za zdravím skrz poznávání tradičního léčitelství.' => 'Folgen Sie meiner Reise zu mehr Gesundheit durch das Kennenlernen traditioneller Heilkunst.',
                'Děkujeme, že používáte tajemstvijamu.cz!' => 'Danke, dass Sie tajemstvijamu.cz nutzen!',
                'prostřednictvím' => 'über',
                'Banküberweisung / QR-Code (-10 Kč)' => 'Banküberweisung / QR-Code (-0,41 €)',
                'Převodem / QR kódem (-10 Kč)' => 'Banküberweisung / QR-Code (-0,41 €)',
                'Německo' => 'Deutschland',
                'Germany' => 'Deutschland',
            ],
            'pl' => [
                'Objednávka z Tajemství JAMU 🌿 čeká na zaplacení' => 'Twoje zamówienie z Tajemství JAMU 🌿 oczekuje na płatność',
                'Objednávku z Tajemství JAMU 🌿 jsem přijala ✅' => 'Otrzymaliśmy Twoje zamówienie z Tajemství JAMU 🌿 ✅',
                'Děkuji Vám za objednávku.' => 'Dziękuję za zamówienie.',
                'Děkujeme Vám za objednávku' => 'Dziękujemy za zamówienie',
                'Dobrý den,' => 'Dzień dobry,',
                'Pro platbu CZK' => 'Dla płatności w CZK',
                'Pro platbu EUR' => 'Dla płatności w EUR',
                'Číslo účtu:' => 'Numer konta:',
                'Částka:' => 'Kwota:',
                'Variabilní symbol:' => 'Symbol płatności:',
                'Produkty' => 'Produkty',
                'Počet:' => 'Ilość:',
                'Cena:' => 'Cena:',
                'Mezisoučet:' => 'Suma częściowa:',
                'Bankovním převodem:' => 'Przelewem bankowym:',
                'Platební metoda:' => 'Metoda płatności:',
                'Způsob platby:' => 'Metoda płatności:',
                'Doprava:' => 'Dostawa:',
                'Celkem:' => 'Razem:',
                'Total:' => 'Razem:',
                'Fakturační adresa' => 'Adres rozliczeniowy',
                'Doručovací adresa' => 'Adres dostawy',
                'Pokud byste měli jakékoli otázky nebo potřebovali další informace, neváhejte mě kontaktovat. Jsem tady pro vás a ráda pomůžu.' => 'Jeśli masz jakiekolwiek pytania lub potrzebujesz dodatkowych informacji, skontaktuj się ze mną. Jestem do dyspozycji i chętnie pomogę.',
                'S přáním krásného dne a zdraví,' => 'Życzę pięknego dnia i dużo zdrowia,',
                'Sledujte moji cestu za zdravím skrz poznávání tradičního léčitelství.' => 'Śledź moją drogę do zdrowia poprzez poznawanie tradycyjnego lecznictwa.',
                'Děkujeme, že používáte tajemstvijamu.cz!' => 'Dziękujemy za korzystanie z tajemstvijamu.cz!',
                'prostřednictvím' => 'za pośrednictwem',
                'Przelew / kod QR (-10 Kč)' => 'Przelew / kod QR (-1,79 zł)',
                'Převodem / QR kódem (-10 Kč)' => 'Przelew / kod QR (-1,79 zł)',
                'Německo' => 'Niemcy',
                'Germany' => 'Niemcy',
            ],
        ];

        return array_replace($common, $map[$language] ?? []);
    }

    /**
     * @return array<string, string>
     */
    private function email_regex_replacements(string $language): array
    {
        return match ($language) {
            'en' => [
                '/Jen pro informaci\s*[–-]\s*Vaše objednávka č\. ([0-9]+) byla přijata a je nyní zpracovávána:/u' => 'Just to let you know — your order no. $1 has been received and is now being processed:',
                '/děkuji za vaši objednávku č\. ([^.<]+)\. Nyní čekám na potvrzení, že platba v pořádku dorazila\./u' => 'thank you for your order no. $1. I am now waiting for confirmation that the payment has arrived successfully.',
                '/Platbu můžete provést podle níže uvedených platebních údajů nebo pomocí QR kódu \(u něj je potřeba zadat částku a variabilní symbol\)\./u' => 'You can make the payment using the bank details below or by QR code. For QR payment, please enter the amount and variable symbol.',
                '/\[Objednávka č\. ([0-9]+)\]/u' => '[Order #$1]',
                '/\[Order #([0-9]+)\]/u' => '[Order #$1]',
                '/\(includes ([^)]+) VAT\)/u' => '(includes $1 VAT)',
                '/\s*[—-]\s*Built with\s*(?:<a\b[^>]*>)?WooCommerce(?:<\/a>)?/iu' => '',
            ],
            'de' => [
                '/Jen pro informaci\s*[–-]\s*Vaše objednávka č\. ([0-9]+) byla přijata a je nyní zpracovávána:/u' => 'Zur Information — Ihre Bestellung Nr. $1 ist eingegangen und wird nun bearbeitet:',
                '/děkuji za vaši objednávku č\. ([^.<]+)\. Nyní čekám na potvrzení, že platba v pořádku dorazila\./u' => 'vielen Dank für Ihre Bestellung Nr. $1. Ich warte nun auf die Bestätigung, dass die Zahlung erfolgreich eingegangen ist.',
                '/Platbu můžete provést podle níže uvedených platebních údajů nebo pomocí QR kódu \(u něj je potřeba zadat částku a variabilní symbol\)\./u' => 'Sie können die Zahlung über die unten angegebenen Bankdaten oder per QR-Code durchführen. Beim QR-Code geben Sie bitte den Betrag und den Verwendungszweck ein.',
                '/\[Objednávka č\. ([0-9]+)\]/u' => '[Bestellung Nr. $1]',
                '/\[Order #([0-9]+)\]/u' => '[Bestellung #$1]',
                '/\(includes ([^)]+) VAT\)/u' => '(inkl. $1 MwSt.)',
                '/\s*[—-]\s*Built with\s*(?:<a\b[^>]*>)?WooCommerce(?:<\/a>)?/iu' => '',
            ],
            'pl' => [
                '/Jen pro informaci\s*[–-]\s*Vaše objednávka č\. ([0-9]+) byla přijata a je nyní zpracovávána:/u' => 'Informacyjnie — Twoje zamówienie nr $1 zostało przyjęte i jest teraz przetwarzane:',
                '/děkuji za vaši objednávku č\. ([^.<]+)\. Nyní čekám na potvrzení, že platba v pořádku dorazila\./u' => 'dziękuję za zamówienie nr $1. Czekam teraz na potwierdzenie, że płatność dotarła prawidłowo.',
                '/Platbu můžete provést podle níže uvedených platebních údajů nebo pomocí QR kódu \(u něj je potřeba zadat částku a variabilní symbol\)\./u' => 'Płatność możesz wykonać na podstawie poniższych danych bankowych lub za pomocą kodu QR. Przy płatności QR wpisz kwotę i symbol płatności.',
                '/\[Objednávka č\. ([0-9]+)\]/u' => '[Zamówienie nr $1]',
                '/\[Order #([0-9]+)\]/u' => '[Zamówienie #$1]',
                '/\(includes ([^)]+) VAT\)/u' => '(w tym $1 VAT)',
                '/\s*[—-]\s*Built with\s*(?:<a\b[^>]*>)?WooCommerce(?:<\/a>)?/iu' => '',
            ],
            default => [],
        };
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
