<?php

use Jamu\Multilingual\Languages;
use Jamu\Multilingual\Content;
use Jamu\Multilingual\Identity;
use Jamu\Multilingual\Repository;
use Jamu\Multilingual\Router;

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

file_put_contents('/tmp/jamu-smoke-ids.json', wp_json_encode([
    'product' => $product_id,
    'category' => $term_id,
    'page' => $page_id,
    'untranslated' => $untranslated_id,
]));
echo "JAMU smoke setup complete: {$url}\n";
