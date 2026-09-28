<?php

use Jamu\Multilingual\Languages;
use Jamu\Multilingual\Content;
use Jamu\Multilingual\Email;
use Jamu\Multilingual\Identity;
use Jamu\Multilingual\Repository;
use Jamu\Multilingual\Router;
use Jamu\Multilingual\Shipping;

if (!defined('ABSPATH')) {
    exit(1);
}

$repository = new Repository();
$languages = new Languages();
$router = new Router($repository, $languages);
$languages->set_current('en');
$content_layer = new Content($repository, $languages, $router);

$product = new WC_Product_Simple();
$product->set_name('Český testovací produkt');
$product->set_slug('cesky-testovaci-produkt');
$product->set_regular_price('199');
$product->set_sku('JAMU-CI-1');
$product->set_manage_stock(true);
$product->set_stock_quantity(7);
$product_id = $product->save();

$term_result = wp_insert_term('Česká testovací kategorie', 'product_cat', ['slug' => 'ceska-testovaci-kategorie']);
if (is_wp_error($term_result)) {
    throw new RuntimeException($term_result->get_error_message());
}
$term_id = (int) $term_result['term_id'];
wp_set_object_terms($product_id, [$term_id], 'product_cat');

$saved = $repository->save([
    'object_type' => 'post',
    'object_subtype' => 'product',
    'object_id' => $product_id,
    'language' => 'en',
    'route_path' => 'test-product',
    'slug' => 'test-product',
    'title' => 'English test product',
    'excerpt' => 'Translated short description.',
    'content' => '<p>Translated full description.</p>',
    'seo_title' => 'English test product – JAMU',
    'meta_description' => 'English test meta description.',
    'status' => 'publish',
]);

if (is_wp_error($saved) || !$saved) {
    throw new RuntimeException('Could not save translation.');
}

$saved_term = $repository->save([
    'object_type' => 'term',
    'object_subtype' => 'product_cat',
    'object_id' => $term_id,
    'language' => 'en',
    'route_path' => 'test-category',
    'slug' => 'test-category',
    'title' => 'English test category',
    'content' => 'Translated category description.',
    'seo_title' => 'English test category – JAMU',
    'meta_description' => 'English category meta description.',
    'status' => 'publish',
]);
if (is_wp_error($saved_term) || !$saved_term) {
    throw new RuntimeException('Could not save category translation.');
}

$page_id = wp_insert_post([
    'post_type' => 'page', 'post_status' => 'publish',
    'post_title' => 'Česká testovací stránka', 'post_name' => 'ceska-testovaci-stranka',
    'post_content' => '<p>Český obsah stránky.</p>',
], true);
if (is_wp_error($page_id)) {
    throw new RuntimeException($page_id->get_error_message());
}
$repository->save([
    'object_type' => 'post', 'object_subtype' => 'page', 'object_id' => $page_id,
    'language' => 'en', 'route_path' => 'test-page', 'slug' => 'test-page',
    'title' => 'English test page', 'content' => '<p>English page content.</p>',
    'status' => 'publish',
]);

$template_id = 'jadro//front-page';
$repository->save([
    'object_type' => 'template', 'object_subtype' => 'wp_template',
    'object_id' => Identity::stable_id('template:' . $template_id),
    'language' => 'en', 'title' => 'English front page template',
    'content' => '<!-- wp:paragraph --><p>English template content.</p><!-- /wp:paragraph -->',
    'status' => 'publish',
]);
$template = (object) ['id' => $template_id, 'title' => 'Source template', 'content' => '<p>Source</p>'];
$localized_template = $content_layer->block_template($template, $template_id, 'wp_template');
if (!str_contains($localized_template->content, 'English template content')) {
    throw new RuntimeException('Block template was not localized.');
}

add_shortcode('jamu_test_shortcode', static fn (): string => '<span class="jamu-test-shortcode">Shortcode rendered</span>');
$repository->save([
    'object_type' => 'template', 'object_subtype' => 'wp_template_part',
    'object_id' => Identity::stable_id('template:jadro//footer'),
    'language' => 'en', 'title' => 'English footer',
    'content' => '<!-- wp:shortcode -->[jamu_test_shortcode]<!-- /wp:shortcode -->',
    'status' => 'publish',
]);
$localized_footer = $content_layer->template_part_block(
    '<footer class="wp-block-template-part"></footer>',
    ['blockName' => 'core/template-part', 'attrs' => ['slug' => 'footer', 'theme' => 'jadro']]
);
remove_shortcode('jamu_test_shortcode');
if (!str_contains($localized_footer, 'Shortcode rendered')) {
    throw new RuntimeException('Localized template-part shortcodes were not rendered.');
}

$repository->save([
    'object_type' => 'form', 'object_subtype' => 'wpforms', 'object_id' => 55,
    'language' => 'en', 'status' => 'publish',
    'data' => [
        'fields' => ['1' => ['label' => 'First name', 'placeholder' => 'Your name']],
        'settings' => ['submit_text' => 'Send'],
    ],
]);
$localized_form = $content_layer->wpforms_data([
    'id' => 55,
    'fields' => ['1' => ['id' => 1, 'label' => 'Jméno', 'placeholder' => 'Vaše jméno']],
    'settings' => ['submit_text' => 'Odeslat'],
]);
if ($localized_form['fields']['1']['label'] !== 'First name' || $localized_form['settings']['submit_text'] !== 'Send') {
    throw new RuntimeException('WPForms data was not localized safely.');
}

update_option('woocommerce_terms_page_id', $page_id);
$languages->set_current('en');
unset($_POST['terms']);
$terms_errors = new WP_Error();
$content_layer->require_terms_acceptance([], $terms_errors);
if (!in_array('terms', $terms_errors->get_error_codes(), true)) {
    throw new RuntimeException('Terms acceptance was not enforced server-side.');
}
$_POST['terms'] = '1';
$accepted_terms_errors = new WP_Error();
$content_layer->require_terms_acceptance([], $accepted_terms_errors);
unset($_POST['terms']);
if (in_array('terms', $accepted_terms_errors->get_error_codes(), true)) {
    throw new RuntimeException('Accepted terms were incorrectly rejected.');
}

$untranslated = new WC_Product_Simple();
$untranslated->set_name('Nepřeložený produkt');
$untranslated->set_slug('neprelozeny-produkt');
$untranslated->set_regular_price('99');
$untranslated_id = $untranslated->save();

$url = $router->localized_post_url($product_id, 'en', true);
if (!str_ends_with($url, '/en/product/test-product/')) {
    throw new RuntimeException('Unexpected localized product URL: ' . $url);
}

$reloaded = wc_get_product($product_id);
if (!$reloaded || $reloaded->get_sku() !== 'JAMU-CI-1' || $reloaded->get_stock_quantity() !== 7) {
    throw new RuntimeException('Canonical WooCommerce product data changed.');
}

$email_layer = new Email($languages);
$email_layer->register();
$email_order = wc_create_order();
$email_order->update_meta_data(Email::ORDER_LANGUAGE_META, 'de');
$email_order->save();
$customer_on_hold = WC()->mailer()->get_emails()['WC_Email_Customer_On_Hold_Order'] ?? null;
if (!$customer_on_hold) {
    throw new RuntimeException('Customer on-hold email is unavailable.');
}
$recipient = apply_filters('woocommerce_email_recipient_customer_on_hold_order', 'ci@example.invalid', $email_order, $customer_on_hold);
$subject = apply_filters('woocommerce_email_subject_customer_on_hold_order', 'Objednávka z Tajemství JAMU 🌿 čeká na zaplacení', $email_order, $customer_on_hold);
if ($recipient !== 'ci@example.invalid' || !str_contains($subject, 'Ihre Bestellung')) {
    throw new RuntimeException('Customer email locale or subject was not localized.');
}
$mail_params = apply_filters('woocommerce_mail_callback_params', [
    'ci@example.invalid',
    $subject,
    'Děkuji Vám za objednávku.',
    ['Content-Type: text/html'],
    [],
]);
if (!str_contains((string) $mail_params[2], 'Vielen Dank')) {
    throw new RuntimeException('Customer email body was not localized.');
}

$customer_email_cases = [
    'en' => [
        'subject' => 'Your order from',
        'body' => 'Thank you for your order no. 123.',
        'payment' => 'You chose payment by bank transfer.',
    ],
    'de' => [
        'subject' => 'Ihre Bestellung',
        'body' => 'Vielen Dank für Ihre Bestellung Nr. 123.',
        'payment' => 'Sie haben Banküberweisung gewählt.',
    ],
    'pl' => [
        'subject' => 'Twoje zamówienie',
        'body' => 'Dziękuję za zamówienie nr 123,',
        'payment' => 'Wybrano płatność przelewem bankowym.',
    ],
];
$customer_email_body = <<<'HTML'
<p>děkuji Vám za objednávku č. <span>123</span><span>, kterou tímto přijímám a potvrzuji uzavření kupní smlouvy.</span></p>
<p>Zvolili jste platbu bankovním převodem. Prosím o její provedení do 7 kalendářních dnů podle platebních údajů níže. Jako variabilní symbol použijte číslo objednávky.</p>
<p>Zaplatit můžete také pomocí QR kódu. Před potvrzením platby prosím doplňte částku a variabilní symbol podle údajů v tomto e-mailu.</p>
<p>Zboží skladem obvykle odešlu do 3 pracovních dnů od přijetí platby, nejpozději do 7 pracovních dnů. O odeslání Vás budu informovat.</p>
<p>V příloze najdete platební údaje, shrnutí objednávky, obchodní podmínky a formulář pro případné odstoupení od smlouvy.</p>
<p>Pokud budete mít jakýkoliv dotaz, stačí odpovědět na tento e-mail.</p><p>Děkuji za důvěru a přeji krásný den.</p>
<p>Bankovním převodem</p>
HTML;
foreach ($customer_email_cases as $language => $expected) {
    $localized_order = wc_create_order();
    $localized_order->update_meta_data(Email::ORDER_LANGUAGE_META, $language);
    $localized_order->save();
    $localized_subject = apply_filters(
        'woocommerce_email_subject_customer_on_hold_order',
        'Objednávka z Tajemství JAMU 🌿 čeká na zaplacení',
        $localized_order,
        $customer_on_hold
    );
    $localized_params = apply_filters('woocommerce_mail_callback_params', [
        'ci@example.invalid', $localized_subject, $customer_email_body, ['Content-Type: text/html'], [],
    ]);
    $localized_body = (string) $localized_params[2];
    if (!str_contains($localized_subject, $expected['subject'])
        || !str_contains($localized_body, $expected['body'])
        || !str_contains($localized_body, $expected['payment'])
        || str_contains($localized_body, 'Zvolili jste platbu')
        || str_contains($localized_body, 'Děkuji za důvěru')) {
        throw new RuntimeException('Complete customer email was not localized for ' . $language . '.');
    }
}
if (apply_filters('wp_mail_charset', 'ISO-8859-1') !== 'UTF-8') {
    throw new RuntimeException('Outgoing email charset was not forced to UTF-8.');
}
$html_mailer = (object) ['ContentType' => 'text/html', 'Body' => '<html><body>Příliš žluťoučký kůň</body></html>', 'CharSet' => '', 'Encoding' => ''];
$email_layer->configure_html_mailer($html_mailer);
if ($html_mailer->CharSet !== 'UTF-8' || $html_mailer->Encoding !== 'base64') {
    throw new RuntimeException('HTML email encoding was not configured safely.');
}

$shipping_layer = new Shipping($languages);
$unsafe_checkout_fragment = <<<'HTML'
<table><tfoot><script>
document.getElementById("customer_details").getElementsByClassName("woocommerce-shipping-fields")[0].removeAttribute("style", "display:none;");
document.getElementById("ship-to-different-address-checkbox").checked = false;
document.getElementById("shipping_first_name").value = "";
document.getElementById("shipping_last_name").value = "";
document.getElementById("shipping_company").value = "";
document.getElementById("shipping_postcode").value = "";
document.getElementById("shipping_address_1").value = "";
document.getElementById("shipping_address_2").value = "";
document.getElementById("shipping_city").value = "";
</script><tr><td>Shipping remains visible</td></tr></tfoot></table>
HTML;
$safe_checkout_fragments = $shipping_layer->remove_unsafe_pickup_fragment_script([
    '.woocommerce-checkout-review-order-table' => $unsafe_checkout_fragment,
]);
$safe_checkout_fragment = $safe_checkout_fragments['.woocommerce-checkout-review-order-table'] ?? '';
if (str_contains($safe_checkout_fragment, 'shipping_first_name') || !str_contains($safe_checkout_fragment, 'Shipping remains visible')) {
    throw new RuntimeException('Unsafe checkout pickup script was not removed safely.');
}

file_put_contents('/tmp/jamu-smoke-ids.json', wp_json_encode([
    'product' => $product_id,
    'category' => $term_id,
    'page' => $page_id,
    'untranslated' => $untranslated_id,
]));
echo "JAMU smoke setup complete: {$url}\n";
