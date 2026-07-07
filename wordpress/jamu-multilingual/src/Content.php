<?php

namespace Jamu\Multilingual;

use WP_Post;
use WP_Term;

defined('ABSPATH') || exit;

final class Content
{
    private bool $term_guard = false;

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
        add_filter('woocommerce_attribute_label', [$this, 'attribute_label'], 20, 3);
        add_filter('woocommerce_structured_data_product', [$this, 'product_schema'], 20, 2);

        add_filter('get_term', [$this, 'term'], 20, 2);
        add_filter('wp_get_attachment_image_attributes', [$this, 'image_attributes'], 20, 3);
        add_filter('wp_nav_menu_objects', [$this, 'menu_items'], 20, 2);
        add_filter('get_block_template', [$this, 'block_template'], 20, 3);
        add_filter('get_block_templates', [$this, 'block_templates'], 20, 3);
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
        return $translation && $translation->content !== '' ? $translation->content : $content;
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
        $localized->content = $translation->content;
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

    public function block_data(array $parsed_block, array $source_block, ?object $parent_block): array
    {
        if (!$this->active() || !in_array($parsed_block['blockName'] ?? '', ['core/navigation-link', 'core/navigation-submenu'], true)) {
            return $parsed_block;
        }
        $attributes = $parsed_block['attrs'] ?? [];
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
        $parsed_block['attrs'] = $attributes;
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
        return $translation && $translation->{$field} !== '' ? $translation->{$field} : $value;
    }

    private function active(): bool
    {
        return $this->languages->current() !== Languages::DEFAULT
            && (!is_admin() || wp_doing_ajax());
    }
}
