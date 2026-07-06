<?php

use Jamu\Multilingual\Languages;
use Jamu\Multilingual\Repository;
use Jamu\Multilingual\Router;

if (!defined('ABSPATH')) {
    exit(1);
}

$repository = new Repository();
$languages = new Languages();
$router = new Router($repository, $languages);

$product = new WC_Product_Simple();
$product->set_name('Český testovací produkt');
$product->set_slug('cesky-testovaci-produkt');
$product->set_regular_price('199');
$product->set_sku('JAMU-CI-1');
$product->set_manage_stock(true);
$product->set_stock_quantity(7);
$product_id = $product->save();

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

$url = $router->localized_post_url($product_id, 'en', true);
if (!str_ends_with($url, '/en/product/test-product/')) {
    throw new RuntimeException('Unexpected localized product URL: ' . $url);
}

$reloaded = wc_get_product($product_id);
if (!$reloaded || $reloaded->get_sku() !== 'JAMU-CI-1' || $reloaded->get_stock_quantity() !== 7) {
    throw new RuntimeException('Canonical WooCommerce product data changed.');
}

file_put_contents('/tmp/jamu-product-id', (string) $product_id);
echo "JAMU smoke setup complete: {$url}\n";

