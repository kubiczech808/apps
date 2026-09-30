<?php

namespace Jamu\Multilingual;

defined('ABSPATH') || exit;

final class Email
{
    public const ORDER_LANGUAGE_META = '_jamu_ml_language';
    private const YAYMAIL_VARIANT_PREFIX = 'jamu-';
    private const YAYMAIL_VARIANT_VERSION = '2026-09-30-1';

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
        add_filter('yaymail_email_get_variant', [$this, 'yaymail_email_variant'], 20, 5);
        add_filter('woocommerce_mail_callback_params', [$this, 'restore_after_mail_params'], 999);
        add_filter('wp_mail_charset', [$this, 'mail_charset'], PHP_INT_MAX);
        add_action('phpmailer_init', [$this, 'configure_html_mailer'], PHP_INT_MAX);
        add_action('woocommerce_email_sent', [$this, 'restore_after_email_sent'], 999, 3);
        add_action('shutdown', [$this, 'restore_email_context'], 0);

        add_filter('jamu_ml_should_localize_request', [$this, 'force_email_context'], 20);
        add_filter('jamu_ml_should_translate_content', [$this, 'force_email_context'], 20);
        add_action('init', [$this, 'ensure_yaymail_language_variants'], 99);
        add_action('admin_menu', [$this, 'email_variant_menu']);
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
            add_filter("woocommerce_email_subject_{$id}", function (string $text, mixed $object = null, mixed $email = null): string {
                return $this->prepare_customer_email_property($text, $object, $email, 'subject');
            }, 1, 3);
            add_filter("woocommerce_email_heading_{$id}", function (string $text, mixed $object = null, mixed $email = null): string {
                return $this->prepare_customer_email_property($text, $object, $email, 'heading');
            }, 1, 3);
            add_filter("woocommerce_email_additional_content_{$id}", function (string $text, mixed $object = null, mixed $email = null): string {
                return $this->prepare_customer_email_property($text, $object, $email, 'additional_content');
            }, 1, 3);
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

    /**
     * Subjects, headings and additional content have their own WooCommerce
     * settings. Keep a language-specific copy on the YayMail variant so a
     * subsequent Czech edit cannot leak into an existing foreign-language
     * template.
     */
    public function prepare_customer_email_property(string $text, mixed $object, mixed $email, string $property): string
    {
        $this->begin_email_context($object, $email);
        $language = $this->languages->current();
        if ($language === Languages::DEFAULT) {
            return $text;
        }

        $email_id = is_object($email) && !empty($email->id) ? (string) $email->id : '';
        $value = $email_id !== '' ? $this->yaymail_variant_property($email_id, $language, $property) : '';
        if ($value === '') {
            return $this->translate_email_text($text);
        }

        return is_object($email) && method_exists($email, 'format_string')
            ? (string) $email->format_string($value)
            : $value;
    }

    /**
     * YayMail's documented variant hook selects an independent visual design
     * for an order. The order meta, rather than the current admin/browser
     * language, is the authority here.
     */
    public function yaymail_email_variant(string $variant, mixed $order, mixed $args = null, mixed $email = null, mixed $template_name = null): string
    {
        $order = $this->normalize_order($order);
        $language = $order ? $this->order_language($order) : '';
        $template_name = is_string($template_name) ? $template_name : '';
        if ($language === '' || $language === Languages::DEFAULT || !str_starts_with($template_name, 'customer_')) {
            return $variant;
        }

        return $this->yaymail_variant_slug($language);
    }

    /**
     * One-time bootstrap of independent YayMail designs. YayMail creates a
     * variant by copying the base design; we translate that initial snapshot
     * once and never copy the Czech design over it again.
     */
    public function ensure_yaymail_language_variants(): void
    {
        if (get_option('jamu_ml_yaymail_variant_version') === self::YAYMAIL_VARIANT_VERSION
            || !class_exists('\\YayMail\\YayMailTemplate')
            || !class_exists('\\YayMail\\Models\\TemplateModel')
        ) {
            return;
        }

        $templates = get_posts([
            'post_type' => 'yaymail_template',
            'post_status' => ['publish', 'future', 'pending'],
            'posts_per_page' => -1,
            'orderby' => 'ID',
            'order' => 'ASC',
            'suppress_filters' => true,
        ]);

        // YayMail may retain historical duplicate base records. Its own loader
        // deterministically uses the oldest record, so bootstrap each email
        // name just once as well. This must never rewrite a language variant
        // from a later duplicate source.
        $seen_templates = [];
        foreach ($templates as $template_post) {
            if ((string) get_post_meta($template_post->ID, '_yaymail_template_variant', true) !== '') {
                continue;
            }
            $template_name = (string) get_post_meta($template_post->ID, '_yaymail_template', true);
            if (!str_starts_with($template_name, 'customer_')) {
                continue;
            }
            if (isset($seen_templates[$template_name])) {
                continue;
            }
            $seen_templates[$template_name] = true;

            $source = new \YayMail\YayMailTemplate($template_name);
            if (!$source->is_exists()) {
                continue;
            }

            foreach (array_keys($this->languages->additional()) as $language) {
                $variant = new \YayMail\YayMailTemplate($template_name, '', $this->yaymail_variant_slug($language));
                if (!$variant->is_exists()) {
                    continue;
                }

                $translated = $this->translate_yaymail_data($source->get_data(), $language);
                \YayMail\Models\TemplateModel::update($variant->get_id(), $translated);
                $this->seed_yaymail_email_properties($template_name, $variant->get_id(), $language);
            }
        }

        update_option('jamu_ml_yaymail_variant_version', self::YAYMAIL_VARIANT_VERSION, false);
    }

    public function email_variant_menu(): void
    {
        add_management_page(
            __('JAMU email translations', 'jamu-multilingual'),
            __('JAMU email translations', 'jamu-multilingual'),
            'manage_woocommerce',
            'jamu-email-translations',
            [$this, 'render_email_variant_page']
        );
    }

    public function render_email_variant_page(): void
    {
        if (!current_user_can('manage_woocommerce')) {
            return;
        }
        $this->ensure_yaymail_language_variants();

        if (isset($_POST['jamu_ml_email_variant_nonce'])
            && wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['jamu_ml_email_variant_nonce'])), 'jamu_ml_save_email_variants')
        ) {
            $this->save_email_variant_properties($_POST['jamu_ml_email'] ?? []);
            echo '<div class="notice notice-success"><p>' . esc_html__('Email language settings saved.', 'jamu-multilingual') . '</p></div>';
        }

        $templates = $this->customer_yaymail_templates();
        ?>
        <div class="wrap">
            <h1><?php esc_html_e('JAMU email translations', 'jamu-multilingual'); ?></h1>
            <p><?php esc_html_e('Each language is an independent YayMail design. Editing the Czech design never overwrites English, German or Polish. Use the visual editor link for body/layout and the fields below for subject, heading and additional content.', 'jamu-multilingual'); ?></p>
            <form method="post">
                <?php wp_nonce_field('jamu_ml_save_email_variants', 'jamu_ml_email_variant_nonce'); ?>
                <?php foreach ($templates as $template_name => $template_id) : ?>
                    <h2><?php echo esc_html($template_name); ?></h2>
                    <table class="widefat striped" style="max-width:1100px"><thead><tr><th><?php esc_html_e('Language', 'jamu-multilingual'); ?></th><th><?php esc_html_e('Visual template', 'jamu-multilingual'); ?></th><th><?php esc_html_e('Subject', 'jamu-multilingual'); ?></th><th><?php esc_html_e('Heading', 'jamu-multilingual'); ?></th><th><?php esc_html_e('Additional content', 'jamu-multilingual'); ?></th></tr></thead><tbody>
                    <?php foreach ($this->languages->additional() as $language => $config) :
                        $variant_id = $this->yaymail_variant_id($template_name, $language);
                        ?>
                        <tr><th scope="row"><?php echo esc_html($config['label']); ?></th><td><?php if ($variant_id) : ?><a class="button" target="_blank" href="<?php echo esc_url(admin_url('admin.php?page=yaymail-settings#/customizer/?template=' . $variant_id)); ?>"><?php esc_html_e('Open visual editor', 'jamu-multilingual'); ?></a><?php endif; ?></td>
                        <?php foreach (['subject', 'heading', 'additional_content'] as $property) : ?>
                            <td><textarea class="large-text" rows="3" name="jamu_ml_email[<?php echo esc_attr($template_name); ?>][<?php echo esc_attr($language); ?>][<?php echo esc_attr($property); ?>]"><?php echo esc_textarea($variant_id ? get_post_meta($variant_id, '_jamu_ml_' . $property, true) : ''); ?></textarea></td>
                        <?php endforeach; ?></tr>
                    <?php endforeach; ?>
                    </tbody></table>
                <?php endforeach; ?>
                <p><button class="button button-primary" type="submit"><?php esc_html_e('Save email translations', 'jamu-multilingual'); ?></button></p>
            </form>
        </div>
        <?php
    }

    public function restore_after_mail_params(array $params): array
    {
        if ($this->context_depth > 0) {
            foreach ([1, 2] as $index) {
                if (isset($params[$index]) && is_string($params[$index]) && $params[$index] !== '') {
                    $params[$index] = $this->translate_email_text(
                        $index === 2 ? $this->decode_quoted_printable_html($params[$index]) : $params[$index]
                    );
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

    /**
     * YayMail's test-email action supplies an HTML Content-Type header without
     * a charset. Explicit UTF-8 is essential for Czech, Polish and German
     * characters and prevents clients from guessing an incorrect encoding.
     */
    public function mail_charset(string $charset): string
    {
        return 'UTF-8';
    }

    /**
     * Some mail relays used by shared hosting leak quoted-printable escapes
     * (for example =0A and =C3=A1) into YayMail test and WooCommerce emails.
     * Encode HTML mail as Base64 after WooCommerce/YayMail configure PHPMailer;
     * mail clients then decode the message unambiguously.
     */
    public function configure_html_mailer(object $mailer): void
    {
        $content_type = strtolower((string) ($mailer->ContentType ?? ''));
        $body = (string) ($mailer->Body ?? '');
        $body = $this->decode_quoted_printable_html($body);
        if (!str_contains($content_type, 'html') && stripos($body, '<html') === false && stripos($body, '<body') === false) {
            return;
        }

        $mailer->Body = $body;
        $mailer->CharSet = 'UTF-8';
        $mailer->Encoding = 'base64';
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
        return $this->translate_email_text_for_language($text, $this->languages->current());
    }

    /**
     * YayMail can return a complete HTML document that has already been
     * quoted-printable encoded. Passing that literal text to PHPMailer makes
     * clients show quoted-printable escape sequences instead of the email.
     * Decode only unmistakably encoded HTML; ordinary URLs and attributes
     * stay untouched.
     */
    private function decode_quoted_printable_html(string $body): string
    {
        if (!preg_match('/(?:=(?:0D)?0A|=3D|=C[0-9A-F]|=D[0-9A-F]|=\r?\n)/i', $body)) {
            return $body;
        }

        $decoded = quoted_printable_decode($body);
        if ($decoded === $body || !preg_match('/<(?:html|body|table|div|p)\b/i', $decoded)) {
            return $body;
        }

        return $decoded;
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
                'Zvolili jste platbu bankovním převodem. Prosím o její provedení do 7 kalendářních dnů podle platebních údajů níže. Jako variabilní symbol použijte číslo objednávky.' => 'You chose payment by bank transfer. Please make the payment within 7 calendar days using the payment details below. Use your order number as the payment reference.',
                'Zaplatit můžete také pomocí QR kódu. Před potvrzením platby prosím doplňte částku a variabilní symbol podle údajů v tomto e-mailu.' => 'You can also pay by QR code. Before confirming the payment, please enter the amount and payment reference shown in this email.',
                'Zboží skladem obvykle odešlu do 3 pracovních dnů od přijetí platby, nejpozději do 7 pracovních dnů. O odeslání Vás budu informovat.' => 'In-stock goods are normally dispatched within 3 working days after payment is received, and no later than within 7 working days. I will let you know when your order is dispatched.',
                'V příloze najdete platební údaje, shrnutí objednávky, obchodní podmínky a formulář pro případné odstoupení od smlouvy.' => 'Attached you will find the payment details, order summary, terms and conditions, and the withdrawal form.',
                'Pokud budete mít jakýkoliv dotaz, stačí odpovědět na tento e-mail.' => 'If you have any questions, simply reply to this email.',
                'Děkuji za důvěru a přeji krásný den.' => 'Thank you for your trust. Have a lovely day.',
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
                'Bankovním převodem' => 'By bank transfer',
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
                'Zvolili jste platbu bankovním převodem. Prosím o její provedení do 7 kalendářních dnů podle platebních údajů níže. Jako variabilní symbol použijte číslo objednávky.' => 'Sie haben Banküberweisung gewählt. Bitte überweisen Sie den Betrag innerhalb von 7 Kalendertagen anhand der untenstehenden Zahlungsdaten. Geben Sie Ihre Bestellnummer als Verwendungszweck an.',
                'Zaplatit můžete také pomocí QR kódu. Před potvrzením platby prosím doplňte částku a variabilní symbol podle údajů v tomto e-mailu.' => 'Sie können auch per QR-Code zahlen. Geben Sie vor der Zahlungsbestätigung Betrag und Verwendungszweck gemäß dieser E-Mail ein.',
                'Zboží skladem obvykle odešlu do 3 pracovních dnů od přijetí platby, nejpozději do 7 pracovních dnů. O odeslání Vás budu informovat.' => 'Lagerware versende ich in der Regel innerhalb von 3 Werktagen nach Zahlungseingang, spätestens innerhalb von 7 Werktagen. Über den Versand informiere ich Sie.',
                'V příloze najdete platební údaje, shrnutí objednávky, obchodní podmínky a formulář pro případné odstoupení od smlouvy.' => 'Im Anhang finden Sie die Zahlungsdaten, Bestellübersicht, Allgemeinen Geschäftsbedingungen und das Widerrufsformular.',
                'Pokud budete mít jakýkoliv dotaz, stačí odpovědět na tento e-mail.' => 'Wenn Sie Fragen haben, antworten Sie einfach auf diese E-Mail.',
                'Děkuji za důvěru a přeji krásný den.' => 'Vielen Dank für Ihr Vertrauen. Ich wünsche Ihnen einen schönen Tag.',
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
                'Bankovním převodem' => 'Per Banküberweisung',
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
                'Zvolili jste platbu bankovním převodem. Prosím o její provedení do 7 kalendářních dnů podle platebních údajů níže. Jako variabilní symbol použijte číslo objednávky.' => 'Wybrano płatność przelewem bankowym. Proszę dokonać płatności w ciągu 7 dni kalendarzowych zgodnie z poniższymi danymi. Jako tytuł przelewu proszę podać numer zamówienia.',
                'Zaplatit můžete také pomocí QR kódu. Před potvrzením platby prosím doplňte částku a variabilní symbol podle údajů v tomto e-mailu.' => 'Możesz również zapłacić kodem QR. Przed potwierdzeniem płatności wpisz kwotę i tytuł przelewu zgodnie z informacjami w tym e-mailu.',
                'Zboží skladem obvykle odešlu do 3 pracovních dnů od přijetí platby, nejpozději do 7 pracovních dnů. O odeslání Vás budu informovat.' => 'Produkty dostępne w magazynie wysyłam zwykle w ciągu 3 dni roboczych od otrzymania płatności, najpóźniej w ciągu 7 dni roboczych. Poinformuję Cię o wysyłce.',
                'V příloze najdete platební údaje, shrnutí objednávky, obchodní podmínky a formulář pro případné odstoupení od smlouvy.' => 'W załączniku znajdziesz dane do płatności, podsumowanie zamówienia, regulamin oraz formularz odstąpienia od umowy.',
                'Pokud budete mít jakýkoliv dotaz, stačí odpovědět na tento e-mail.' => 'Jeśli masz pytania, po prostu odpowiedz na tę wiadomość e-mail.',
                'Děkuji za důvěru a přeji krásný den.' => 'Dziękuję za zaufanie i życzę pięknego dnia.',
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
                'Bankovním převodem' => 'Przelewem bankowym',
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
                'Przelew / kod QR (-10 Kč)' => 'Przelew / kod QR (-1,77 zł)',
                'Převodem / QR kódem (-10 Kč)' => 'Przelew / kod QR (-1,77 zł)',
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
                '/děkuji(?:\s|<[^>]+>)+Vám(?:\s|<[^>]+>)+za(?:\s|<[^>]+>)+objednávku(?:\s|<[^>]+>)+č\.(?:\s|<[^>]+>)*([0-9]+)(?:\s|<[^>]+>)*,(?:\s|<[^>]+>)*kterou(?:\s|<[^>]+>)+tímto(?:\s|<[^>]+>)+přijímám(?:\s|<[^>]+>)+a(?:\s|<[^>]+>)+potvrzuji(?:\s|<[^>]+>)+uzavření(?:\s|<[^>]+>)+kupní(?:\s|<[^>]+>)+smlouvy\./iu' => 'Thank you for your order no. $1. I hereby accept it and confirm the conclusion of the purchase contract.',
                '/Jen pro informaci\s*[–-]\s*Vaše objednávka č\. ([0-9]+) byla přijata a je nyní zpracovávána:/u' => 'Just to let you know — your order no. $1 has been received and is now being processed:',
                '/děkuji za vaši objednávku č\. ([^.<]+)\. Nyní čekám na potvrzení, že platba v pořádku dorazila\./u' => 'thank you for your order no. $1. I am now waiting for confirmation that the payment has arrived successfully.',
                '/Platbu můžete provést podle níže uvedených platebních údajů nebo pomocí QR kódu \(u něj je potřeba zadat částku a variabilní symbol\)\./u' => 'You can make the payment using the bank details below or by QR code. For QR payment, please enter the amount and variable symbol.',
                '/\[Objednávka č\. ([0-9]+)\]/u' => '[Order #$1]',
                '/\[Order #([0-9]+)\]/u' => '[Order #$1]',
                '/\(includes ([^)]+) VAT\)/u' => '(includes $1 VAT)',
                '/\s*[—-]\s*Built with\s*(?:<a\b[^>]*>)?WooCommerce(?:<\/a>)?/iu' => '',
            ],
            'de' => [
                '/děkuji(?:\s|<[^>]+>)+Vám(?:\s|<[^>]+>)+za(?:\s|<[^>]+>)+objednávku(?:\s|<[^>]+>)+č\.(?:\s|<[^>]+>)*([0-9]+)(?:\s|<[^>]+>)*,(?:\s|<[^>]+>)*kterou(?:\s|<[^>]+>)+tímto(?:\s|<[^>]+>)+přijímám(?:\s|<[^>]+>)+a(?:\s|<[^>]+>)+potvrzuji(?:\s|<[^>]+>)+uzavření(?:\s|<[^>]+>)+kupní(?:\s|<[^>]+>)+smlouvy\./iu' => 'Vielen Dank für Ihre Bestellung Nr. $1. Hiermit nehme ich sie an und bestätige den Abschluss des Kaufvertrags.',
                '/Jen pro informaci\s*[–-]\s*Vaše objednávka č\. ([0-9]+) byla přijata a je nyní zpracovávána:/u' => 'Zur Information — Ihre Bestellung Nr. $1 ist eingegangen und wird nun bearbeitet:',
                '/děkuji za vaši objednávku č\. ([^.<]+)\. Nyní čekám na potvrzení, že platba v pořádku dorazila\./u' => 'vielen Dank für Ihre Bestellung Nr. $1. Ich warte nun auf die Bestätigung, dass die Zahlung erfolgreich eingegangen ist.',
                '/Platbu můžete provést podle níže uvedených platebních údajů nebo pomocí QR kódu \(u něj je potřeba zadat částku a variabilní symbol\)\./u' => 'Sie können die Zahlung über die unten angegebenen Bankdaten oder per QR-Code durchführen. Beim QR-Code geben Sie bitte den Betrag und den Verwendungszweck ein.',
                '/\[Objednávka č\. ([0-9]+)\]/u' => '[Bestellung Nr. $1]',
                '/\[Order #([0-9]+)\]/u' => '[Bestellung #$1]',
                '/\(includes ([^)]+) VAT\)/u' => '(inkl. $1 MwSt.)',
                '/\s*[—-]\s*Built with\s*(?:<a\b[^>]*>)?WooCommerce(?:<\/a>)?/iu' => '',
            ],
            'pl' => [
                '/děkuji(?:\s|<[^>]+>)+Vám(?:\s|<[^>]+>)+za(?:\s|<[^>]+>)+objednávku(?:\s|<[^>]+>)+č\.(?:\s|<[^>]+>)*([0-9]+)(?:\s|<[^>]+>)*,(?:\s|<[^>]+>)*kterou(?:\s|<[^>]+>)+tímto(?:\s|<[^>]+>)+přijímám(?:\s|<[^>]+>)+a(?:\s|<[^>]+>)+potvrzuji(?:\s|<[^>]+>)+uzavření(?:\s|<[^>]+>)+kupní(?:\s|<[^>]+>)+smlouvy\./iu' => 'Dziękuję za zamówienie nr $1, które niniejszym przyjmuję i potwierdzam zawarcie umowy kupna-sprzedaży.',
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

    private function yaymail_variant_slug(string $language): string
    {
        return self::YAYMAIL_VARIANT_PREFIX . $language;
    }

    private function yaymail_variant_id(string $template_name, string $language): int
    {
        if (!class_exists('\\YayMail\\YayMailTemplate')) {
            return 0;
        }
        $template = new \YayMail\YayMailTemplate($template_name, '', $this->yaymail_variant_slug($language));
        return $template->is_exists() ? (int) $template->get_id() : 0;
    }

    private function yaymail_variant_property(string $email_id, string $language, string $property): string
    {
        if (!in_array($property, ['subject', 'heading', 'additional_content'], true)) {
            return '';
        }
        $variant_id = $this->yaymail_variant_id($email_id, $language);
        return $variant_id ? (string) get_post_meta($variant_id, '_jamu_ml_' . $property, true) : '';
    }

    private function translate_yaymail_data(mixed $value, string $language): mixed
    {
        if (is_string($value)) {
            return $this->translate_email_text_for_language($value, $language);
        }
        if (!is_array($value)) {
            return $value;
        }
        foreach ($value as $key => $item) {
            $value[$key] = $this->translate_yaymail_data($item, $language);
        }
        return $value;
    }

    private function translate_email_text_for_language(string $text, string $language): string
    {
        if ($language === Languages::DEFAULT) {
            return $text;
        }
        $text = strtr($text, $this->email_exact_replacements($language));
        foreach ($this->email_regex_replacements($language) as $pattern => $replacement) {
            $text = (string) preg_replace($pattern, $replacement, $text);
        }
        return $text;
    }

    /** @return array<string, int> */
    private function customer_yaymail_templates(): array
    {
        $result = [];
        foreach (get_posts([
            'post_type' => 'yaymail_template',
            'post_status' => ['publish', 'future', 'pending'],
            'posts_per_page' => -1,
            'orderby' => 'ID',
            'order' => 'ASC',
            'suppress_filters' => true,
        ]) as $template) {
            if ((string) get_post_meta($template->ID, '_yaymail_template_variant', true) !== '') {
                continue;
            }
            $name = (string) get_post_meta($template->ID, '_yaymail_template', true);
            if (str_starts_with($name, 'customer_') && !isset($result[$name])) {
                $result[$name] = (int) $template->ID;
            }
        }
        return $result;
    }

    private function seed_yaymail_email_properties(string $template_name, int $variant_id, string $language): void
    {
        $settings = get_option('woocommerce_' . $template_name . '_settings', []);
        $settings = is_array($settings) ? $settings : [];
        $email = $this->customer_email_by_id($template_name);
        $defaults = [
            'subject' => $email && method_exists($email, 'get_default_subject') ? (string) $email->get_default_subject() : '',
            'heading' => $email && method_exists($email, 'get_default_heading') ? (string) $email->get_default_heading() : '',
            'additional_content' => '',
        ];
        foreach ($defaults as $property => $default) {
            $key = '_jamu_ml_' . $property;
            if (metadata_exists('post', $variant_id, $key)) {
                continue;
            }
            $source = isset($settings[$property]) ? (string) $settings[$property] : $default;
            update_post_meta($variant_id, $key, $this->translate_email_text_for_language($source, $language));
        }
    }

    private function save_email_variant_properties(mixed $input): void
    {
        if (!is_array($input)) {
            return;
        }
        foreach ($input as $template_name => $languages) {
            $template_name = sanitize_key((string) $template_name);
            if (!str_starts_with($template_name, 'customer_') || !is_array($languages)) {
                continue;
            }
            foreach ($this->languages->additional() as $language => $config) {
                $values = is_array($languages[$language] ?? null) ? wp_unslash($languages[$language]) : [];
                $variant_id = $this->yaymail_variant_id($template_name, $language);
                if (!$variant_id) {
                    continue;
                }
                foreach (['subject', 'heading', 'additional_content'] as $property) {
                    if (array_key_exists($property, $values)) {
                        update_post_meta($variant_id, '_jamu_ml_' . $property, sanitize_textarea_field((string) $values[$property]));
                    }
                }
            }
        }
    }

    private function customer_email_by_id(string $email_id): ?object
    {
        if (!function_exists('WC') || !WC() || !method_exists(WC(), 'mailer')) {
            return null;
        }
        foreach ((array) WC()->mailer()->get_emails() as $email) {
            if (is_object($email) && isset($email->id) && (string) $email->id === $email_id) {
                return $email;
            }
        }
        return null;
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
