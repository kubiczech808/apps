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
        add_filter('the_content', [$this, 'content'], 7);
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
        add_filter('render_block', [$this, 'post_terms_block'], 23, 2);
        add_filter('render_block', [$this, 'post_navigation_link_block'], 24, 2);
        add_filter('render_block_data', [$this, 'block_data'], 20, 3);
        add_filter('comment_form_defaults', [$this, 'comment_form_defaults'], 20);
        add_filter('comment_form_default_fields', [$this, 'comment_form_default_fields'], 20);
        add_filter('comment_form_field_comment', [$this, 'comment_form_field_comment'], 20);
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

    public function post_terms_block(string $block_content, array $block): string
    {
        if (!$this->active() || ($block['blockName'] ?? '') !== 'core/post-terms') {
            return $block_content;
        }

        $language = $this->languages->current();
        $replacements = [
            'en' => [
                'Z kategorie ,,' => 'From category “',
                'Další články na téma:' => 'More articles about:',
            ],
            'de' => [
                'Z kategorie ,,' => 'Aus der Kategorie „',
                'Další články na téma:' => 'Weitere Artikel zum Thema:',
            ],
            'pl' => [
                'Z kategorie ,,' => 'Z kategorii „',
                'Další články na téma:' => 'Więcej artykułów na temat:',
            ],
        ];

        return strtr($block_content, $replacements[$language] ?? []);
    }

    public function post_navigation_link_block(string $block_content, array $block): string
    {
        if (!$this->active() || ($block['blockName'] ?? '') !== 'core/post-navigation-link') {
            return $block_content;
        }

        return strtr($block_content, [
            'Previous:' => $this->ui_string('Previous:') ?: 'Previous:',
            'Next:' => $this->ui_string('Next:') ?: 'Next:',
        ]);
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

    public function comment_form_defaults(array $defaults): array
    {
        if (!$this->active()) {
            return $defaults;
        }

        $defaults['title_reply'] = $this->ui_string('Leave a Reply') ?: ($defaults['title_reply'] ?? '');
        $defaults['cancel_reply_link'] = $this->ui_string('Cancel reply') ?: ($defaults['cancel_reply_link'] ?? '');
        $defaults['label_submit'] = $this->ui_string('Post Comment') ?: ($defaults['label_submit'] ?? '');
        $defaults['comment_notes_before'] = sprintf(
            '<p class="comment-notes">%s <span class="required-field-message">%s</span></p>',
            esc_html($this->ui_string('Your email address will not be published.')),
            esc_html($this->ui_string('Required fields are marked *'))
        );

        return $defaults;
    }

    public function comment_form_default_fields(array $fields): array
    {
        if (!$this->active()) {
            return $fields;
        }

        $commenter = wp_get_current_commenter();
        $required = (bool) get_option('require_name_email');
        $required_mark = $required ? ' <span class="required">*</span>' : '';
        $required_attrs = $required ? ' required aria-required="true"' : '';

        $fields['author'] = sprintf(
            '<p class="comment-form-author"><label for="author">%s%s</label><input id="author" name="author" type="text" value="%s" size="30" maxlength="245" autocomplete="name"%s /></p>',
            esc_html($this->ui_string('Name')),
            $required_mark,
            esc_attr($commenter['comment_author'] ?? ''),
            $required_attrs
        );
        $fields['email'] = sprintf(
            '<p class="comment-form-email"><label for="email">%s%s</label><input id="email" name="email" type="email" value="%s" size="30" maxlength="100" aria-describedby="email-notes" autocomplete="email"%s /></p>',
            esc_html($this->ui_string('Email')),
            $required_mark,
            esc_attr($commenter['comment_author_email'] ?? ''),
            $required_attrs
        );
        $fields['url'] = sprintf(
            '<p class="comment-form-url"><label for="url">%s</label><input id="url" name="url" type="url" value="%s" size="30" maxlength="200" autocomplete="url" /></p>',
            esc_html($this->ui_string('Website')),
            esc_attr($commenter['comment_author_url'] ?? '')
        );

        if (isset($fields['cookies'])) {
            $fields['cookies'] = preg_replace(
                '#(<label\b[^>]*for=["\']wp-comment-cookies-consent["\'][^>]*>)(.*?)(</label>)#is',
                '$1' . esc_html($this->ui_string('Save my name, email, and website in this browser for the next time I comment.')) . '$3',
                $fields['cookies']
            ) ?? $fields['cookies'];
        }

        return $fields;
    }

    public function comment_form_field_comment(string $field): string
    {
        if (!$this->active()) {
            return $field;
        }

        return sprintf(
            '<p class="comment-form-comment"><label for="comment">%s <span class="required">*</span></label><textarea id="comment" name="comment" cols="45" rows="8" maxlength="65525" required aria-required="true"></textarea></p>',
            esc_html($this->ui_string('Comment'))
        );
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
        $value = preg_replace(
            '#(' . $site . ')(?:en|de|pl)/(?:[^"\']+/)*wp-content/uploads/#i',
            '$1wp-content/uploads/',
            $value
        ) ?? $value;

        if (!$this->active()) {
            return $value;
        }

        $value = preg_replace_callback(
            '/\b(href|action)=(["\'])(.*?)\2/i',
            function (array $match): string {
                $localized = $this->localized_url_attribute(html_entity_decode($match[3], ENT_QUOTES));
                if ($localized === '') {
                    return $match[0];
                }
                return $match[1] . '=' . $match[2] . esc_url($localized) . $match[2];
            },
            $value
        ) ?? $value;

        $value = $this->localized_text_cleanup($value);

        return preg_replace(
            '#(' . $site . ')(?:en|de|pl)/(?:[^"\']+/)*wp-content/uploads/#i',
            '$1wp-content/uploads/',
            $value
        ) ?? $value;
    }

    private function localized_text_cleanup(string $value): string
    {
        $replacements = [
            'en' => [
                'Products Products' => 'View products',
            ],
            'de' => [
                'Produkte Produkte' => 'Produkte ansehen',
            ],
            'pl' => [
                'Produkty Produktów' => 'Zobacz produkty',
                '<p># S</p>' => '<p></p>',
            ],
        ];

        return strtr($value, $replacements[$this->languages->current()] ?? []);
    }

    private function localized_url_attribute(string $url): string
    {
        $url = trim($url);
        if ($url === '' || str_starts_with($url, '#') || preg_match('#^(?:mailto|tel|sms|javascript):#i', $url)) {
            return '';
        }

        $parts = wp_parse_url($url);
        if (!is_array($parts)) {
            return '';
        }

        $home_parts = wp_parse_url(home_url('/'));
        $site_host = strtolower((string) ($home_parts['host'] ?? ''));
        $host = strtolower((string) ($parts['host'] ?? ''));
        if ($host !== '' && $host !== $site_host && $host !== 'www.' . $site_host) {
            return '';
        }

        $language = $this->languages->current();
        $prefix = (string) $this->languages->get($language)['prefix'];
        $path = trim((string) ($parts['path'] ?? ''), '/');
        if ($path === '') {
            return $this->with_url_suffix(home_url(user_trailingslashit($prefix)), $parts);
        }

        if (preg_match('#^(?:wp-content|wp-includes|wp-admin)/#i', $path)) {
            return '';
        }

        $segments = array_values(array_filter(explode('/', $path), static fn (string $segment): bool => $segment !== ''));
        $removed_localized_prefix = false;
        while ($segments && in_array(strtolower($segments[0]), ['en', 'de', 'pl', 'tajemstvi-jamu'], true)) {
            array_shift($segments);
            $removed_localized_prefix = true;
        }

        if ($removed_localized_prefix) {
            $normalized_path = implode('/', $segments);
            $localized = $normalized_path === ''
                ? home_url(user_trailingslashit($prefix))
                : home_url(user_trailingslashit($prefix . '/' . $normalized_path));
            return $this->with_url_suffix($localized, $parts);
        }

        $first = strtolower($segments[0] ?? '');
        $last = sanitize_title((string) end($segments));
        $post = null;

        if ($first === 'produkt' && $last !== '') {
            $post = get_page_by_path($last, OBJECT, 'product');
        } elseif ($first === 'kategorie-produktu' && $last !== '') {
            $term = get_term_by('slug', $last, 'product_cat');
            if ($term instanceof WP_Term) {
                $localized = $this->router->localized_term_url($term, 'product_cat', $language);
                return $localized ? $this->with_url_suffix($localized, $parts) : '';
            }
        } elseif ($first === 'stitek-produktu' && $last !== '') {
            $term = get_term_by('slug', $last, 'product_tag');
            if ($term instanceof WP_Term) {
                $localized = $this->router->localized_term_url($term, 'product_tag', $language);
                return $localized ? $this->with_url_suffix($localized, $parts) : '';
            }
        } else {
            $post = get_page_by_path($path, OBJECT, ['page', 'post']);
        }

        if ($post instanceof WP_Post) {
            $localized = $this->router->localized_post_url($post, $language);
            return $localized ? $this->with_url_suffix($localized, $parts) : '';
        }

        return '';
    }

    private function with_url_suffix(string $url, array $parts): string
    {
        if (!empty($parts['query'])) {
            $url .= (str_contains($url, '?') ? '&' : '?') . $parts['query'];
        }
        if (!empty($parts['fragment'])) {
            $url .= '#' . $parts['fragment'];
        }
        return $url;
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
                'Leave a Reply' => 'Leave a Reply',
                'Cancel reply' => 'Cancel reply',
                'Your email address will not be published.' => 'Your email address will not be published.',
                'Required fields are marked *' => 'Required fields are marked *',
                'Your email address will not be published. Required fields are marked *' => 'Your email address will not be published. Required fields are marked *',
                'Your email address will not be published. Required fields are marked %s' => 'Your email address will not be published. Required fields are marked %s',
                'Comment' => 'Comment',
                'Name' => 'Name',
                'Email' => 'Email',
                'Website' => 'Website',
                'Save my name, email, and website in this browser for the next time I comment.' => 'Save my name, email, and website in this browser for the next time I comment.',
                'Post Comment' => 'Post Comment',
                'Reply' => 'Reply',
                'Previous:' => 'Previous:',
                'Next:' => 'Next:',
                'Open menu' => 'Open menu',
                'Close menu' => 'Close menu',
                'View my cart' => 'View my cart',
                'Go to checkout' => 'Go to checkout',
                'Start shopping' => 'Start shopping',
                'Number of items in the cart: %d' => 'Number of items in the cart: %d',
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
                'Leave a Reply' => 'Kommentar hinterlassen',
                'Cancel reply' => 'Antwort abbrechen',
                'Your email address will not be published.' => 'Ihre E-Mail-Adresse wird nicht veröffentlicht.',
                'Required fields are marked *' => 'Pflichtfelder sind mit * markiert',
                'Your email address will not be published. Required fields are marked *' => 'Ihre E-Mail-Adresse wird nicht veröffentlicht. Pflichtfelder sind mit * markiert',
                'Your email address will not be published. Required fields are marked %s' => 'Ihre E-Mail-Adresse wird nicht veröffentlicht. Pflichtfelder sind mit %s markiert',
                'Comment' => 'Kommentar',
                'Name' => 'Name',
                'Email' => 'E-Mail',
                'Website' => 'Website',
                'Save my name, email, and website in this browser for the next time I comment.' => 'Meinen Namen, meine E-Mail-Adresse und Website in diesem Browser speichern, bis ich wieder kommentiere.',
                'Post Comment' => 'Kommentar veröffentlichen',
                'Reply' => 'Antworten',
                'Previous:' => 'Vorheriger:',
                'Next:' => 'Nächster:',
                'Open menu' => 'Menü öffnen',
                'Close menu' => 'Menü schließen',
                'View my cart' => 'Warenkorb ansehen',
                'Go to checkout' => 'Zur Kasse',
                'Start shopping' => 'Einkauf starten',
                'Number of items in the cart: %d' => 'Anzahl der Artikel im Warenkorb: %d',
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
                'Leave a Reply' => 'Dodaj komentarz',
                'Cancel reply' => 'Anuluj odpowiedź',
                'Your email address will not be published.' => 'Twój adres e-mail nie zostanie opublikowany.',
                'Required fields are marked *' => 'Wymagane pola są oznaczone *',
                'Your email address will not be published. Required fields are marked *' => 'Twój adres e-mail nie zostanie opublikowany. Wymagane pola są oznaczone *',
                'Your email address will not be published. Required fields are marked %s' => 'Twój adres e-mail nie zostanie opublikowany. Wymagane pola są oznaczone %s',
                'Comment' => 'Komentarz',
                'Name' => 'Imię',
                'Email' => 'E-mail',
                'Website' => 'Strona internetowa',
                'Save my name, email, and website in this browser for the next time I comment.' => 'Zapisz moje imię, e-mail i stronę w tej przeglądarce, aby użyć ich przy następnym komentarzu.',
                'Post Comment' => 'Opublikuj komentarz',
                'Reply' => 'Odpowiedz',
                'Previous:' => 'Poprzedni:',
                'Next:' => 'Następny:',
                'Open menu' => 'Otwórz menu',
                'Close menu' => 'Zamknij menu',
                'View my cart' => 'Zobacz koszyk',
                'Go to checkout' => 'Przejdź do kasy',
                'Start shopping' => 'Rozpocznij zakupy',
                'Number of items in the cart: %d' => 'Liczba produktów w koszyku: %d',
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
