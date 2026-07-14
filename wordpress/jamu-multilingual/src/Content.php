<?php

namespace Jamu\Multilingual;

use WP_Post;
use WP_Term;

defined('ABSPATH') || exit;

final class Content
{
    private bool $term_guard = false;
    private bool $template_part_guard = false;

    public function __construct(
        private Repository $repository,
        private Languages $languages,
        private Router $router
    ) {
    }

    public function register(): void
    {
        add_filter('the_title', [$this, 'title'], 20, 2);
        add_filter('the_content', [$this, 'content'], 20);
        add_filter('get_the_excerpt', [$this, 'excerpt'], 20, 2);

        add_filter('woocommerce_product_get_name', [$this, 'product_name'], 20, 2);
        add_filter('woocommerce_product_get_description', [$this, 'product_description'], 20, 2);
        add_filter('woocommerce_product_get_short_description', [$this, 'product_short_description'], 20, 2);
        add_filter('woocommerce_product_variation_get_name', [$this, 'product_name'], 20, 2);
        add_filter('woocommerce_product_single_add_to_cart_text', [$this, 'add_to_cart_text'], 20, 2);
        add_filter('woocommerce_product_add_to_cart_text', [$this, 'add_to_cart_text'], 20, 2);
        add_filter('woocommerce_attribute_label', [$this, 'attribute_label'], 20, 3);
        add_filter('woocommerce_structured_data_product', [$this, 'product_schema'], 20, 2);

        add_filter('gettext', [$this, 'gettext'], 20, 3);
        add_filter('get_term', [$this, 'term'], 20, 2);
        add_filter('wp_get_attachment_image_attributes', [$this, 'image_attributes'], 20, 3);
        add_filter('wp_nav_menu_objects', [$this, 'menu_items'], 20, 2);
        add_filter('get_block_template', [$this, 'block_template'], 20, 3);
        add_filter('get_block_templates', [$this, 'block_templates'], 20, 3);
        add_filter('render_block', [$this, 'template_part_block'], 20, 2);
        add_filter('render_block', [$this, 'navigation_item_block'], 21, 2);
        add_filter('render_block', [$this, 'post_excerpt_block'], 22, 3);
        add_filter('render_block_data', [$this, 'block_data'], 20, 3);
        add_filter('wpforms_frontend_form_data', [$this, 'wpforms_data'], 20);
        add_filter('option_blogname', fn ($value) => $this->site_option($value, 'blogname'), 20);
        add_filter('option_blogdescription', fn ($value) => $this->site_option($value, 'blogdescription'), 20);
    }

    public function title(string $title, int $post_id = 0): string
    {
        if (!$this->active() || !$post_id) {
            return $title;
        }
        $translation = $this->repository->get('post', $post_id, $this->languages->current());
        return $translation && $translation->title !== '' ? $translation->title : $title;
    }

    public function content(string $content): string
    {
        if (!$this->active() || !in_the_loop()) {
            return $content;
        }
        $translation = $this->repository->get('post', get_the_ID(), $this->languages->current());
        return $translation && $translation->content !== '' ? $this->localized_markup($translation->content) : $content;
    }

    public function excerpt(string $excerpt, ?WP_Post $post = null): string
    {
        if (!$this->active() || !$post) {
            return $excerpt;
        }
        $translation = $this->repository->get('post', $post->ID, $this->languages->current());
        return $translation && $translation->excerpt !== '' ? $translation->excerpt : $excerpt;
    }

    public function product_name(string $name, object $product): string
    {
        if (!$this->active() || !method_exists($product, 'get_id')) {
            return $name;
        }
        $id = (int) $product->get_id();
        if (method_exists($product, 'get_parent_id') && $product->get_parent_id()) {
            $id = (int) $product->get_parent_id();
        }
        $translation = $this->repository->get('post', $id, $this->languages->current());
        return $translation && $translation->title !== '' ? $translation->title : $name;
    }

    public function product_description(string $description, object $product): string
    {
        return $this->product_field($description, $product, 'content');
    }

    public function product_short_description(string $description, object $product): string
    {
        return $this->product_field($description, $product, 'excerpt');
    }

    public function add_to_cart_text(string $text, ?object $product = null): string
    {
        if (!$this->active()) {
            return $text;
        }
        return $this->ui_string('Add to cart') ?: $text;
    }

    public function gettext(string $translation, string $text, string $domain): string
    {
        if (!$this->active()) {
            return $translation;
        }
        return $this->ui_string($text) ?: $translation;
    }

    public function term($term, string $taxonomy)
    {
        if (!$term instanceof WP_Term || $this->term_guard || !$this->active()) {
            return $term;
        }
        $this->term_guard = true;
        $translation = $this->repository->get('term', $term->term_id, $this->languages->current());
        $this->term_guard = false;
        if (!$translation) {
            return $term;
        }
        $localized = clone $term;
        if ($translation->title !== '') {
            $localized->name = $translation->title;
        }
        if ($translation->content !== '') {
            $localized->description = $translation->content;
        }
        return $localized;
    }

    public function attribute_label(string $label, string $name, $product = null): string
    {
        if (!$this->active()) {
            return $label;
        }
        $attribute_id = function_exists('wc_attribute_taxonomy_id_by_name')
            ? (int) wc_attribute_taxonomy_id_by_name($name)
            : 0;
        if (!$attribute_id) {
            return $label;
        }
        $translation = $this->repository->get('attribute', $attribute_id, $this->languages->current());
        return $translation && $translation->title !== '' ? $translation->title : $label;
    }

    public function image_attributes(array $attributes, $attachment, $size): array
    {
        if (!$this->active() || !is_object($attachment) || empty($attachment->ID)) {
            return $attributes;
        }
        $translation = $this->repository->get('attachment', (int) $attachment->ID, $this->languages->current());
        if ($translation && !empty($translation->data_decoded['alt'])) {
            $attributes['alt'] = $translation->data_decoded['alt'];
        }
        return $attributes;
    }

    public function menu_items(array $items, object $args): array
    {
        if (!$this->active()) {
            return $items;
        }
        $language = $this->languages->current();
        foreach ($items as $item) {
            $translation = $this->repository->get('post', (int) $item->ID, $language);
            if ($translation && $translation->title !== '') {
                $item->title = $translation->title;
            }
            if ($item->type === 'post_type') {
                $item->url = $this->router->localized_post_url((int) $item->object_id, $language) ?: $item->url;
            } elseif ($item->type === 'taxonomy') {
                $item->url = $this->router->localized_term_url((int) $item->object_id, $item->object, $language) ?: $item->url;
            } elseif ($translation && !empty($translation->data_decoded['url'])) {
                $item->url = esc_url_raw($translation->data_decoded['url']);
            }
        }
        return $items;
    }

    public function product_schema(array $markup, object $product): array
    {
        if (!$this->active() || !method_exists($product, 'get_id')) {
            return $markup;
        }
        $translation = $this->repository->get('post', (int) $product->get_id(), $this->languages->current());
        if ($translation) {
            $markup['name'] = $translation->title ?: ($markup['name'] ?? '');
            $markup['description'] = wp_strip_all_tags($translation->excerpt ?: $translation->content);
        }
        return $markup;
    }

    public function block_template($template, string $id, string $template_type)
    {
        if (!$template || !$this->active() || !isset($template->content)) {
            return $template;
        }
        $translation = $this->repository->get(
            'template',
            Identity::stable_id('template:' . $id),
            $this->languages->current()
        );
        if (!$translation || $translation->content === '') {
            return $template;
        }
        $localized = clone $template;
        $localized->content = $this->localized_markup($translation->content);
        if ($translation->title !== '' && isset($localized->title)) {
            $localized->title = $translation->title;
        }
        return $localized;
    }

    public function block_templates(array $templates, array $query, string $template_type): array
    {
        if (!$this->active()) {
            return $templates;
        }
        foreach ($templates as $index => $template) {
            if (is_object($template) && isset($template->id)) {
                $templates[$index] = $this->block_template($template, (string) $template->id, $template_type);
            }
        }
        return $templates;
    }

    public function template_part_block(string $block_content, array $block): string
    {
        if (
            !$this->active()
            || $this->template_part_guard
            || ($block['blockName'] ?? '') !== 'core/template-part'
        ) {
            return $block_content;
        }

        $attributes = $block['attrs'] ?? [];
        $slug = sanitize_key((string) ($attributes['slug'] ?? ''));
        if ($slug === '') {
            return $block_content;
        }

        $theme = (string) ($attributes['theme'] ?? '');
        if ($theme === '') {
            $theme = wp_get_theme()->get_stylesheet();
        }
        $template_id = $theme . '//' . $slug;
        $translation = $this->repository->get(
            'template',
            Identity::stable_id('template:' . $template_id),
            $this->languages->current()
        );
        if (!$translation || $translation->content === '') {
            return $block_content;
        }

        $this->template_part_guard = true;
        $rendered = do_blocks($this->localized_markup($translation->content));
        $this->template_part_guard = false;

        if (preg_match('/^(\s*<(header|footer|div)\b[^>]*>)(.*)(<\/\2>\s*)$/is', $block_content, $matches)) {
            return $matches[1] . $rendered . $matches[4];
        }

        return $rendered;
    }

    public function navigation_item_block(string $block_content, array $block): string
    {
        if (!$this->active() || !in_array($block['blockName'] ?? '', ['core/navigation-link', 'core/navigation-submenu'], true)) {
            return $block_content;
        }

        $attributes = $this->localized_navigation_attributes($block['attrs'] ?? []);
        $label = (string) ($attributes['label'] ?? '');
        $url = (string) ($attributes['url'] ?? '');

        if ($url !== '') {
            $block_content = preg_replace_callback(
                '/\bhref=(["\'])(.*?)\1/i',
                static fn (array $match): string => 'href=' . $match[1] . esc_url($url) . $match[1],
                $block_content,
                1
            ) ?? $block_content;
        }

        if ($label !== '') {
            $block_content = preg_replace_callback(
                '/(<span\b[^>]*class=(["\'])(?=[^"\']*wp-block-navigation-item__label)[^"\']*\2[^>]*>)(.*?)(<\/span>)/is',
                static fn (array $match): string => $match[1] . esc_html($label) . $match[4],
                $block_content,
                1
            ) ?? $block_content;

            $block_content = preg_replace_callback(
                '/\baria-label=(["\'])(.*?)\1/i',
                static fn (array $match): string => 'aria-label=' . $match[1] . esc_attr($label . ' submenu') . $match[1],
                $block_content,
                1
            ) ?? $block_content;
        }

        return $block_content;
    }

    public function post_excerpt_block(string $block_content, array $block, ?object $instance = null): string
    {
        if (!$this->active() || ($block['blockName'] ?? '') !== 'core/post-excerpt') {
            return $block_content;
        }

        $post_id = 0;
        if ($instance && isset($instance->context['postId'])) {
            $post_id = absint($instance->context['postId']);
        }
        if (!$post_id) {
            $post_id = absint(get_the_ID());
        }
        if (!$post_id) {
            return $block_content;
        }

        $translation = $this->repository->get('post', $post_id, $this->languages->current());
        if (!$translation || $translation->excerpt === '') {
            return $block_content;
        }

        $excerpt = $this->excerpt_fragment($this->localized_markup((string) $translation->excerpt));
        if ($excerpt === '') {
            return $block_content;
        }

        $updated = preg_replace_callback(
            '/(<p\b[^>]*class=(["\'])(?=[^"\']*wp-block-post-excerpt__excerpt)[^"\']*\2[^>]*>)(.*?)(<\/p>)/is',
            static fn (array $match): string => $match[1] . $excerpt . $match[4],
            $block_content,
            1
        );

        return $updated ?? $block_content;
    }

    public function block_data(array $parsed_block, array $source_block, ?object $parent_block): array
    {
        if (!$this->active() || !in_array($parsed_block['blockName'] ?? '', ['core/navigation-link', 'core/navigation-submenu'], true)) {
            return $parsed_block;
        }
        $parsed_block['attrs'] = $this->localized_navigation_attributes($parsed_block['attrs'] ?? []);
        return $parsed_block;
    }

    public function wpforms_data(array $form_data): array
    {
        if (!$this->active() || empty($form_data['id'])) {
            return $form_data;
        }
        $translation = $this->repository->get('form', (int) $form_data['id'], $this->languages->current());
        if (!$translation || empty($translation->data_decoded)) {
            return $form_data;
        }
        $translated = $translation->data_decoded;
        if (!empty($translated['fields']) && is_array($translated['fields'])) {
            $form_data['fields'] = array_replace_recursive($form_data['fields'] ?? [], $translated['fields']);
        }
        if (!empty($translated['settings']) && is_array($translated['settings'])) {
            $form_data['settings'] = array_replace_recursive($form_data['settings'] ?? [], $translated['settings']);
        }
        return $form_data;
    }

    public function site_option(mixed $value, string $option): mixed
    {
        if (!$this->active()) {
            return $value;
        }
        $translation = $this->repository->get(
            'option',
            Identity::stable_id('option:' . $option),
            $this->languages->current()
        );
        return $translation && $translation->title !== '' ? $translation->title : $value;
    }

    private function product_field(string $value, object $product, string $field): string
    {
        if (!$this->active() || !method_exists($product, 'get_id')) {
            return $value;
        }
        $id = method_exists($product, 'get_parent_id') && $product->get_parent_id()
            ? (int) $product->get_parent_id()
            : (int) $product->get_id();
        $translation = $this->repository->get('post', $id, $this->languages->current());
        return $translation && $translation->{$field} !== '' ? $this->localized_markup((string) $translation->{$field}) : $value;
    }

    private function localized_navigation_attributes(array $attributes): array
    {
        $object_id = absint($attributes['id'] ?? 0);
        $kind = (string) ($attributes['kind'] ?? '');
        $type = (string) ($attributes['type'] ?? '');
        $language = $this->languages->current();

        if ($object_id && $kind === 'post-type') {
            $translation = $this->repository->get('post', $object_id, $language);
            if ($translation) {
                $attributes['label'] = $translation->title ?: ($attributes['label'] ?? '');
                $attributes['url'] = $this->router->localized_post_url($object_id, $language) ?: ($attributes['url'] ?? '');
            }
        } elseif ($object_id && $kind === 'taxonomy') {
            $translation = $this->repository->get('term', $object_id, $language);
            if ($translation) {
                $attributes['label'] = $translation->title ?: ($attributes['label'] ?? '');
                if (in_array($type, ['product_cat', 'product_tag'], true)) {
                    $attributes['url'] = $this->router->localized_term_url($object_id, $type, $language) ?: ($attributes['url'] ?? '');
                }
            }
        } else {
            $key = 'navigation:' . ($attributes['label'] ?? '') . '|' . ($attributes['url'] ?? '');
            $translation = $this->repository->get('string', Identity::stable_id($key), $language);
            if ($translation) {
                $attributes['label'] = $translation->title ?: ($attributes['label'] ?? '');
                if (!empty($translation->data_decoded['url'])) {
                    $attributes['url'] = $translation->data_decoded['url'];
                }
            }
        }

        return $attributes;
    }

    private function excerpt_fragment(string $value): string
    {
        $value = trim($value);
        $value = preg_replace('#</p>\s*<p\b[^>]*>#i', '<br><br>', $value) ?? $value;
        $value = preg_replace('#^\s*<p\b[^>]*>#i', '', $value) ?? $value;
        $value = preg_replace('#</p>\s*$#i', '', $value) ?? $value;
        return trim($value);
    }

    private function localized_markup(string $value): string
    {
        $site = preg_quote(home_url('/'), '#');
        return preg_replace(
            '#(' . $site . ')(?:en|de|pl)/(?:[^"\']+/)*wp-content/uploads/#i',
            '$1wp-content/uploads/',
            $value
        ) ?? $value;
    }

    private function ui_string(string $text): string
    {
        $strings = [
            'en' => [
                'Add to cart' => 'Add to cart',
                'Product quantity' => 'Product quantity',
                'Quantity' => 'Quantity',
                'View cart' => 'View cart',
                'Select options' => 'Select options',
                'Read more' => 'Read more',
                'Description' => 'Description',
                'Additional information' => 'Additional information',
                'Reviews' => 'Reviews',
                'Related products' => 'Related products',
                'Sale!' => 'Sale!',
                'Checkout' => 'Checkout',
                'Cart' => 'Cart',
            ],
            'de' => [
                'Add to cart' => 'In den Warenkorb',
                'Product quantity' => 'Produktmenge',
                'Quantity' => 'Menge',
                'View cart' => 'Warenkorb ansehen',
                'Select options' => 'Optionen wählen',
                'Read more' => 'Weiterlesen',
                'Description' => 'Beschreibung',
                'Additional information' => 'Zusätzliche Informationen',
                'Reviews' => 'Bewertungen',
                'Related products' => 'Ähnliche Produkte',
                'Sale!' => 'Angebot!',
                'Checkout' => 'Kasse',
                'Cart' => 'Warenkorb',
            ],
            'pl' => [
                'Add to cart' => 'Dodaj do koszyka',
                'Product quantity' => 'Ilość produktu',
                'Quantity' => 'Ilość',
                'View cart' => 'Zobacz koszyk',
                'Select options' => 'Wybierz opcje',
                'Read more' => 'Czytaj więcej',
                'Description' => 'Opis',
                'Additional information' => 'Dodatkowe informacje',
                'Reviews' => 'Opinie',
                'Related products' => 'Podobne produkty',
                'Sale!' => 'Promocja!',
                'Checkout' => 'Zamówienie',
                'Cart' => 'Koszyk',
            ],
        ];

        $language = $this->languages->current();
        return $strings[$language][$text] ?? '';
    }

    private function active(): bool
    {
        return $this->languages->current() !== Languages::DEFAULT
            && (!is_admin() || wp_doing_ajax());
    }
}
