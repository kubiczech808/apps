<?php

namespace Jamu\Multilingual;

use WP_Post;
use WP_Term;

defined('ABSPATH') || exit;

final class Content
{
    private bool $term_guard = false;
    private bool $template_part_guard = false;
    private bool $language_navigation_inserted = false;

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
        add_filter('render_block', [$this, 'query_pagination_link_block'], 25, 2);
        add_filter('render_block', [$this, 'navigation_language_switcher'], 30, 2);
        add_filter('render_block_data', [$this, 'block_data'], 20, 3);
        add_filter('comment_form_defaults', [$this, 'comment_form_defaults'], 20);
        add_filter('comment_form_default_fields', [$this, 'comment_form_default_fields'], 20);
        add_filter('comment_form_field_comment', [$this, 'comment_form_field_comment'], 20);
        add_filter('wpforms_frontend_form_data', [$this, 'wpforms_data'], 20);
        add_filter('option_blogname', fn ($value) => $this->site_option($value, 'blogname'), 20);
        add_filter('option_blogdescription', fn ($value) => $this->site_option($value, 'blogdescription'), 20);
        add_action('wp_head', [$this, 'language_switcher_styles'], 30);
        add_action('wp_footer', [$this, 'language_switcher_late_styles'], 98);
        add_action('wp_footer', [$this, 'frontend_i18n_fallback'], 99);
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

        $previous_language_navigation_inserted = $this->language_navigation_inserted;
        if ($slug === 'header') {
            $this->language_navigation_inserted = false;
        }

        $this->template_part_guard = true;
        $rendered = do_blocks($this->localized_markup($translation->content));
        $this->template_part_guard = false;

        if ($slug === 'header') {
            $this->language_navigation_inserted = str_contains($rendered, 'jamu-language-menu');
        } else {
            $this->language_navigation_inserted = $previous_language_navigation_inserted;
        }

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

    public function query_pagination_link_block(string $block_content, array $block): string
    {
        if (!$this->active() || !in_array($block['blockName'] ?? '', ['core/query-pagination-next', 'core/query-pagination-previous'], true)) {
            return $block_content;
        }

        $replacements = [
            'en' => [
                'Next Page' => 'Next page',
                'Previous Page' => 'Previous page',
            ],
            'de' => [
                'Next Page' => 'Nächste Seite',
                'Previous Page' => 'Vorherige Seite',
            ],
            'pl' => [
                'Next Page' => 'Następna strona',
                'Previous Page' => 'Poprzednia strona',
            ],
        ];

        return strtr($block_content, $replacements[$this->languages->current()] ?? []);
    }

    public function navigation_language_switcher(string $block_content, array $block): string
    {
        if (
            (is_admin() && !wp_doing_ajax())
            || ($block['blockName'] ?? '') !== 'core/navigation'
            || !str_contains($block_content, 'wp-block-navigation__container')
            || str_contains($block_content, 'jamu-language-menu')
        ) {
            return $block_content;
        }

        $switcher = $this->language_navigation_markup();
        if ($switcher === '') {
            return $block_content;
        }

        $updated = preg_replace_callback(
            '/(<ul\b[^>]*class=(["\'])(?=[^"\']*wp-block-navigation__container)[^"\']*\2[^>]*>)(.*)(<\/ul>)/is',
            static fn (array $match): string => $match[1] . $match[3] . $switcher . $match[4],
            $block_content,
            1
        );

        if (!is_string($updated) || $updated === $block_content) {
            return $block_content;
        }

        return $updated;
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

    public function language_switcher_styles(): void
    {
        if (is_admin() && !wp_doing_ajax()) {
            return;
        }

        echo <<<'HTML'
<style id="jamu-ml-language-switcher-style">
.jamu-language-menu .screen-reader-text{border:0;clip:rect(1px,1px,1px,1px);clip-path:inset(50%);height:1px;margin:-1px;overflow:hidden;padding:0;position:absolute!important;width:1px;word-wrap:normal!important}
.jamu-language-menu>.wp-block-navigation-item__content .wp-block-navigation-item__label,.jamu-language-menu__item .wp-block-navigation-item__label{align-items:center;display:inline-flex;gap:0}
.jamu-language-menu__flag{align-items:center;display:inline-flex;line-height:1}
.jamu-language-menu__flag-icon{border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,.15);display:block;height:1rem;width:1.5rem}
.jamu-language-menu .wp-block-navigation__submenu-icon{margin-left:.2em}
.jamu-language-menu .wp-block-navigation__submenu-container{background:transparent!important;background-color:transparent!important;background-image:none!important;border:0!important;box-shadow:none!important;gap:.25rem;margin:0!important;min-width:0!important;padding:.2rem 0 0!important;width:auto!important}
.jamu-language-menu__item,.jamu-language-menu__item .wp-block-navigation-item__content{background:transparent!important;background-color:transparent!important}
.jamu-language-menu__item .wp-block-navigation-item__content{justify-content:center;min-width:1.75rem;padding:.1rem 0!important}
@media (min-width:782px){.jamu-language-menu{position:relative}.jamu-language-menu .wp-block-navigation__submenu-container{left:50%!important;right:auto!important;top:100%!important;transform:translateX(-50%)}}
</style>
HTML;
    }

    public function language_switcher_late_styles(): void
    {
        if (is_admin() && !wp_doing_ajax()) {
            return;
        }

        echo <<<'HTML'
<style id="jamu-ml-language-switcher-late-style">
@media (min-width:782px){
.jamu-language-menu,.jamu-language-menu.has-child,.jamu-language-menu.open-on-hover-click,.jamu-language-menu.wp-block-navigation-submenu{background:transparent!important;background-color:transparent!important;background-image:none!important}
.jamu-language-menu>.wp-block-navigation__submenu-container,.jamu-language-menu.has-child:not(.open-on-click):hover>.wp-block-navigation__submenu-container,.jamu-language-menu.has-child:not(.open-on-click):focus-within>.wp-block-navigation__submenu-container,.jamu-language-menu .wp-block-navigation__submenu-container.wp-block-navigation-submenu{background:transparent!important;background-color:transparent!important;background-image:none!important;backdrop-filter:none!important;border:0!important;box-shadow:none!important;left:50%!important;margin:0!important;max-width:max-content!important;min-width:0!important;opacity:1!important;outline:0!important;padding:.15rem 0 0!important;right:auto!important;top:100%!important;transform:translateX(-50%)!important;width:max-content!important}
.jamu-language-menu>.wp-block-navigation__submenu-container:before,.jamu-language-menu>.wp-block-navigation__submenu-container:after{background:transparent!important;content:none!important;display:none!important}
.jamu-language-menu__item,.jamu-language-menu__item:hover,.jamu-language-menu__item:focus-within,.jamu-language-menu__item>.wp-block-navigation-item__content,.jamu-language-menu__item>.wp-block-navigation-item__content:hover,.jamu-language-menu__item>.wp-block-navigation-item__content:focus{background:transparent!important;background-color:transparent!important;background-image:none!important;box-shadow:none!important}
}
</style>
HTML;
    }

    public function frontend_i18n_fallback(): void
    {
        if (!$this->active()) {
            return;
        }

        $data = $this->frontend_i18n_data();
        if (empty($data['exact']) && empty($data['patterns'])) {
            return;
        }

        printf(
            "<script id=\"jamu-ml-frontend-i18n\">\n%s\n</script>\n",
            'window.jamuMlI18n=' . wp_json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ';' . <<<'JS'
(function () {
    const data = window.jamuMlI18n || {};
    const exact = data.exact || {};
    const patterns = data.patterns || [];
    const attrs = ['aria-label', 'title', 'placeholder', 'value'];
    let scheduled = false;

    if (data.language) {
        document.cookie = 'jamu_lang=' + encodeURIComponent(data.language) + '; path=/; max-age=2592000; SameSite=Lax';
    }

    function withWhitespace(original, translated) {
        const leading = original.match(/^\s*/)[0] || '';
        const trailing = original.match(/\s*$/)[0] || '';
        return leading + translated + trailing;
    }

    function translate(value) {
        if (typeof value !== 'string') {
            return '';
        }
        const normalized = value.replace(/\s+/g, ' ').trim();
        if (!normalized) {
            return '';
        }
        if (Object.prototype.hasOwnProperty.call(exact, normalized)) {
            return exact[normalized];
        }
        for (const item of patterns) {
            const match = normalized.match(new RegExp(item.match));
            if (!match) {
                continue;
            }
            if (item.one && match[1] === '1') {
                return item.one.replace('$1', match[1]);
            }
            if (item.other) {
                return item.other.replace('$1', match[1] || '');
            }
        }
        return '';
    }

    function translateTextNode(node) {
        const translated = translate(node.nodeValue || '');
        if (translated) {
            node.nodeValue = withWhitespace(node.nodeValue || '', translated);
        }
    }

    function translateElementAttributes(element) {
        if (!element || element.nodeType !== 1) {
            return;
        }
        for (const attr of attrs) {
            if (!element.hasAttribute(attr)) {
                continue;
            }
            if (attr === 'value' && element.tagName !== 'BUTTON') {
                const type = (element.getAttribute('type') || '').toLowerCase();
                if (!['button', 'submit', 'reset'].includes(type)) {
                    continue;
                }
            }
            const value = element.getAttribute(attr) || '';
            const translated = translate(value);
            if (translated && translated !== value) {
                element.setAttribute(attr, translated);
            }
        }
    }

    function apply(root) {
        const scope = root && root.nodeType === 1 ? root : document.body;
        if (!scope) {
            return;
        }

        if (scope.nodeType === 1) {
            translateElementAttributes(scope);
            scope.querySelectorAll('[aria-label],[title],[placeholder],input[value],button[value]').forEach(translateElementAttributes);
        }

        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA'].includes(parent.tagName)) {
                    return NodeFilter.FILTER_REJECT;
                }
                return translate(node.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            }
        });
        const nodes = [];
        while (walker.nextNode()) {
            nodes.push(walker.currentNode);
        }
        nodes.forEach(translateTextNode);
    }

    function schedule(root) {
        if (scheduled) {
            return;
        }
        scheduled = true;
        window.requestAnimationFrame(function () {
            scheduled = false;
            apply(document.body);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { apply(document.body); });
    } else {
        apply(document.body);
    }

    new MutationObserver(function (mutations) {
        for (const mutation of mutations) {
            if (mutation.type === 'characterData') {
                schedule(mutation.target.parentElement || document.body);
                return;
            }
            if (mutation.type === 'attributes') {
                schedule(mutation.target || document.body);
                return;
            }
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1 || node.nodeType === 3) {
                    schedule(node.nodeType === 1 ? node : node.parentElement);
                    return;
                }
            }
        }
    }).observe(document.documentElement, {
        attributeFilter: attrs,
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true
    });
})();
JS
        );
    }

    private function frontend_i18n_data(): array
    {
        $exact = [
            'en' => [
                'Previous Page' => 'Previous page',
                'Next Page' => 'Next page',
            ],
            'de' => [
                'Your cart' => 'Ihr Warenkorb',
                'View cart' => 'Warenkorb ansehen',
                'Proceed to checkout' => 'Zur Kasse',
                'Proceed to Checkout' => 'Zur Kasse',
                'Checkout' => 'Kasse',
                'Cart' => 'Warenkorb',
                'Basket' => 'Warenkorb',
                'Cart totals' => 'Warenkorbsumme',
                'Subtotal' => 'Zwischensumme',
                'Total' => 'Gesamtsumme',
                'Shipping' => 'Versand',
                'Taxes' => 'Steuern',
                'Tax' => 'Steuer',
                'Discount' => 'Rabatt',
                'Discounts' => 'Rabatte',
                'Coupon' => 'Gutschein',
                'Coupon code' => 'Gutscheincode',
                'Apply coupon' => 'Gutschein anwenden',
                'Apply' => 'Anwenden',
                'Update cart' => 'Warenkorb aktualisieren',
                'Remove item' => 'Artikel entfernen',
                'Remove' => 'Entfernen',
                'Add a coupon' => 'Gutschein hinzufügen',
                'Enter code' => 'Code eingeben',
                'Remove coupon' => 'Gutschein entfernen',
                'Continue Shopping' => 'Weiter einkaufen',
                'Continue shopping' => 'Weiter einkaufen',
                'Start shopping' => 'Einkauf starten',
                'Your cart is currently empty!' => 'Ihr Warenkorb ist derzeit leer!',
                'No products in the cart.' => 'Keine Produkte im Warenkorb.',
                'Return to shop' => 'Zurück zum Shop',
                'Order summary' => 'Bestellübersicht',
                'Your order' => 'Ihre Bestellung',
                'Order details' => 'Bestelldetails',
                'Billing details' => 'Rechnungsdetails',
                'Shipping address' => 'Lieferadresse',
                'Billing address' => 'Rechnungsadresse',
                'Contact information' => 'Kontaktinformationen',
                'Payment options' => 'Zahlungsarten',
                'Payment method' => 'Zahlungsart',
                'Place order' => 'Bestellung aufgeben',
                'Place Order' => 'Bestellung aufgeben',
                'Pay for order' => 'Bestellung bezahlen',
                'Product' => 'Produkt',
                'Products' => 'Produkte',
                'Quantity' => 'Menge',
                'Price' => 'Preis',
                'First name' => 'Vorname',
                'Last name' => 'Nachname',
                'Company name' => 'Firmenname',
                'Country / Region' => 'Land / Region',
                'Street address' => 'Straße und Hausnummer',
                'Town / City' => 'Ort / Stadt',
                'Postcode / ZIP' => 'Postleitzahl',
                'Postal code' => 'Postleitzahl',
                'ZIP Code' => 'Postleitzahl',
                'Apartment, suite, unit, etc.' => 'Wohnung, Suite, Einheit usw.',
                'Apartment, suite, unit, etc. (optional)' => 'Wohnung, Suite, Einheit usw. (optional)',
                'State / County' => 'Bundesland / Landkreis',
                'State/County' => 'Bundesland / Landkreis',
                'Phone' => 'Telefon',
                'Email address' => 'E-Mail-Adresse',
                'Order notes' => 'Bestellhinweise',
                'Add a note to your order' => 'Eine Notiz zur Bestellung hinzufügen',
                'Shipping options' => 'Versandoptionen',
                'Free shipping' => 'Kostenloser Versand',
                'Local pickup' => 'Abholung vor Ort',
                'Calculate shipping' => 'Versand berechnen',
                'Shipping to' => 'Versand nach',
                'Change address' => 'Adresse ändern',
                'Returning customer?' => 'Schon Kunde?',
                'Click here to login' => 'Hier klicken, um sich anzumelden',
                'Have a coupon?' => 'Haben Sie einen Gutschein?',
                'Click here to enter your code' => 'Hier klicken, um den Code einzugeben',
                'Create an account?' => 'Konto erstellen?',
                'Use same address for billing' => 'Dieselbe Adresse für die Rechnung verwenden',
                'Enter the address where you want your order delivered.' => 'Geben Sie die Adresse ein, an die Ihre Bestellung geliefert werden soll.',
                'Enter the billing address that matches your payment method.' => 'Geben Sie die Rechnungsadresse ein, die zu Ihrer Zahlungsmethode passt.',
                'This field is required' => 'Dieses Feld ist erforderlich',
                'There are no payment methods available.' => 'Es sind keine Zahlungsarten verfügbar.',
                'I have read and agree to the website terms and conditions' => 'Ich habe die Allgemeinen Geschäftsbedingungen der Website gelesen und akzeptiere sie',
                'Privacy policy' => 'Datenschutzerklärung',
                'Terms and conditions' => 'Allgemeine Geschäftsbedingungen',
                'Thank you. Your order has been received.' => 'Vielen Dank. Ihre Bestellung ist eingegangen.',
                'Open cart' => 'Warenkorb öffnen',
                'Close cart' => 'Warenkorb schließen',
                'Items in cart' => 'Artikel im Warenkorb',
                'Shipping, taxes, and discounts calculated at checkout.' => 'Versand, Steuern und Rabatte werden an der Kasse berechnet.',
                'Previous Page' => 'Vorherige Seite',
                'Next Page' => 'Nächste Seite',
                'Add a review' => 'Bewertung hinzufügen',
                'Reviews' => 'Bewertungen',
                'Mezisoučet' => 'Zwischensumme',
                'Doprava' => 'Versand',
                'Celkem' => 'Gesamtsumme',
                'Celkem k platbě' => 'Gesamtsumme',
                'Přejít k pokladně' => 'Zur Kasse',
                'Pokladna' => 'Kasse',
                'Košík' => 'Warenkorb',
                'Zobrazit košík' => 'Warenkorb ansehen',
                'Objednávka' => 'Bestellung',
                'Fakturační údaje' => 'Rechnungsdetails',
                'Dodací adresa' => 'Lieferadresse',
                'Platební metoda' => 'Zahlungsart',
                'Odeslat objednávku' => 'Bestellung aufgeben',
            ],
            'pl' => [
                'Your cart' => 'Twój koszyk',
                'View cart' => 'Zobacz koszyk',
                'Proceed to checkout' => 'Przejdź do kasy',
                'Proceed to Checkout' => 'Przejdź do kasy',
                'Checkout' => 'Kasa',
                'Cart' => 'Koszyk',
                'Basket' => 'Koszyk',
                'Cart totals' => 'Podsumowanie koszyka',
                'Subtotal' => 'Suma częściowa',
                'Total' => 'Razem',
                'Shipping' => 'Dostawa',
                'Taxes' => 'Podatki',
                'Tax' => 'Podatek',
                'Discount' => 'Rabat',
                'Discounts' => 'Rabaty',
                'Coupon' => 'Kupon',
                'Coupon code' => 'Kod kuponu',
                'Apply coupon' => 'Zastosuj kupon',
                'Apply' => 'Zastosuj',
                'Update cart' => 'Aktualizuj koszyk',
                'Remove item' => 'Usuń produkt',
                'Remove' => 'Usuń',
                'Add a coupon' => 'Dodaj kupon',
                'Enter code' => 'Wpisz kod',
                'Remove coupon' => 'Usuń kupon',
                'Continue Shopping' => 'Kontynuuj zakupy',
                'Continue shopping' => 'Kontynuuj zakupy',
                'Start shopping' => 'Rozpocznij zakupy',
                'Your cart is currently empty!' => 'Twój koszyk jest pusty!',
                'No products in the cart.' => 'Brak produktów w koszyku.',
                'Return to shop' => 'Wróć do sklepu',
                'Order summary' => 'Podsumowanie zamówienia',
                'Your order' => 'Twoje zamówienie',
                'Order details' => 'Szczegóły zamówienia',
                'Billing details' => 'Dane rozliczeniowe',
                'Shipping address' => 'Adres dostawy',
                'Billing address' => 'Adres rozliczeniowy',
                'Contact information' => 'Dane kontaktowe',
                'Payment options' => 'Metody płatności',
                'Payment method' => 'Metoda płatności',
                'Place order' => 'Złóż zamówienie',
                'Place Order' => 'Złóż zamówienie',
                'Pay for order' => 'Zapłać za zamówienie',
                'Product' => 'Produkt',
                'Products' => 'Produkty',
                'Quantity' => 'Ilość',
                'Price' => 'Cena',
                'First name' => 'Imię',
                'Last name' => 'Nazwisko',
                'Company name' => 'Nazwa firmy',
                'Country / Region' => 'Kraj / region',
                'Street address' => 'Ulica i numer',
                'Town / City' => 'Miasto',
                'Postcode / ZIP' => 'Kod pocztowy',
                'Postal code' => 'Kod pocztowy',
                'ZIP Code' => 'Kod pocztowy',
                'Apartment, suite, unit, etc.' => 'Mieszkanie, lokal itp.',
                'Apartment, suite, unit, etc. (optional)' => 'Mieszkanie, lokal itp. (opcjonalnie)',
                'State / County' => 'Województwo / powiat',
                'State/County' => 'Województwo / powiat',
                'Phone' => 'Telefon',
                'Email address' => 'Adres e-mail',
                'Order notes' => 'Uwagi do zamówienia',
                'Add a note to your order' => 'Dodaj notatkę do zamówienia',
                'Shipping options' => 'Opcje dostawy',
                'Free shipping' => 'Darmowa dostawa',
                'Local pickup' => 'Odbiór osobisty',
                'Calculate shipping' => 'Oblicz dostawę',
                'Shipping to' => 'Dostawa do',
                'Change address' => 'Zmień adres',
                'Returning customer?' => 'Masz już konto?',
                'Click here to login' => 'Kliknij tutaj, aby się zalogować',
                'Have a coupon?' => 'Masz kupon?',
                'Click here to enter your code' => 'Kliknij tutaj, aby wpisać kod',
                'Create an account?' => 'Utworzyć konto?',
                'Use same address for billing' => 'Użyj tego samego adresu do rozliczenia',
                'Enter the address where you want your order delivered.' => 'Wpisz adres, na który chcesz otrzymać zamówienie.',
                'Enter the billing address that matches your payment method.' => 'Wpisz adres rozliczeniowy zgodny z metodą płatności.',
                'This field is required' => 'To pole jest wymagane',
                'There are no payment methods available.' => 'Brak dostępnych metod płatności.',
                'I have read and agree to the website terms and conditions' => 'Przeczytałem/am i akceptuję regulamin strony',
                'Privacy policy' => 'Polityka prywatności',
                'Terms and conditions' => 'Regulamin',
                'Thank you. Your order has been received.' => 'Dziękujemy. Twoje zamówienie zostało przyjęte.',
                'Open cart' => 'Otwórz koszyk',
                'Close cart' => 'Zamknij koszyk',
                'Items in cart' => 'Produkty w koszyku',
                'Shipping, taxes, and discounts calculated at checkout.' => 'Koszt dostawy, podatki i rabaty zostaną obliczone przy kasie.',
                'Previous Page' => 'Poprzednia strona',
                'Next Page' => 'Następna strona',
                'Add a review' => 'Dodaj opinię',
                'Reviews' => 'Opinie',
                'Reviews (1)' => 'Opinie (1)',
                '(1 customer review)' => '(1 opinia klienta)',
                'New' => 'Nowość',
                'Mezisoučet' => 'Suma częściowa',
                'Doprava' => 'Dostawa',
                'Celkem' => 'Razem',
                'Celkem k platbě' => 'Razem do zapłaty',
                'Přejít k pokladně' => 'Przejdź do kasy',
                'Pokladna' => 'Kasa',
                'Košík' => 'Koszyk',
                'Zobrazit košík' => 'Zobacz koszyk',
                'Objednávka' => 'Zamówienie',
                'Fakturační údaje' => 'Dane rozliczeniowe',
                'Dodací adresa' => 'Adres dostawy',
                'Platební metoda' => 'Metoda płatności',
                'Odeslat objednávku' => 'Złóż zamówienie',
            ],
        ];

        $patterns = [
            'de' => [
                ['match' => '^Your cart \\(items: (\\d+)\\)$', 'one' => 'Ihr Warenkorb (1 Artikel)', 'other' => 'Ihr Warenkorb ($1 Artikel)'],
                ['match' => '^Your cart \\((\\d+) item\\)$', 'one' => 'Ihr Warenkorb (1 Artikel)', 'other' => 'Ihr Warenkorb ($1 Artikel)'],
                ['match' => '^Your cart \\((\\d+) items\\)$', 'one' => 'Ihr Warenkorb (1 Artikel)', 'other' => 'Ihr Warenkorb ($1 Artikel)'],
                ['match' => '^Number of items in the cart: (\\d+)$', 'one' => 'Anzahl der Artikel im Warenkorb: 1', 'other' => 'Anzahl der Artikel im Warenkorb: $1'],
                ['match' => '^Remove (.+) from cart$', 'other' => '$1 aus dem Warenkorb entfernen'],
                ['match' => '^Quantity of (.+) in your cart\\.?$', 'other' => 'Menge von $1 in Ihrem Warenkorb'],
                ['match' => '^\\((\\d+) customer review\\)$', 'one' => '(1 Kundenbewertung)', 'other' => '($1 Kundenbewertungen)'],
                ['match' => '^\\((\\d+) customer reviews\\)$', 'one' => '(1 Kundenbewertung)', 'other' => '($1 Kundenbewertungen)'],
                ['match' => '^Reviews \\((\\d+)\\)$', 'one' => 'Bewertungen (1)', 'other' => 'Bewertungen ($1)'],
                ['match' => '^Rated ([0-9,.]+) out of 5$', 'other' => 'Bewertet mit $1 von 5'],
            ],
            'pl' => [
                ['match' => '^Your cart \\(items: (\\d+)\\)$', 'one' => 'Twój koszyk (1 produkt)', 'other' => 'Twój koszyk ($1 produktów)'],
                ['match' => '^Your cart \\((\\d+) item\\)$', 'one' => 'Twój koszyk (1 produkt)', 'other' => 'Twój koszyk ($1 produktów)'],
                ['match' => '^Your cart \\((\\d+) items\\)$', 'one' => 'Twój koszyk (1 produkt)', 'other' => 'Twój koszyk ($1 produktów)'],
                ['match' => '^Number of items in the cart: (\\d+)$', 'one' => 'Liczba produktów w koszyku: 1', 'other' => 'Liczba produktów w koszyku: $1'],
                ['match' => '^Remove (.+) from cart$', 'other' => 'Usuń z koszyka: $1'],
                ['match' => '^Quantity of (.+) in your cart\\.?$', 'other' => 'Ilość produktu $1 w koszyku'],
                ['match' => '^\\((\\d+) customer review\\)$', 'one' => '(1 opinia klienta)', 'other' => '($1 opinii klientów)'],
                ['match' => '^\\((\\d+) customer reviews\\)$', 'one' => '(1 opinia klienta)', 'other' => '($1 opinii klientów)'],
                ['match' => '^Reviews \\((\\d+)\\)$', 'one' => 'Opinie (1)', 'other' => 'Opinie ($1)'],
                ['match' => '^Rated ([0-9,.]+) out of 5$', 'other' => 'Oceniono na $1 z 5'],
            ],
        ];

        $language = $this->languages->current();
        return [
            'language' => $language,
            'exact' => $exact[$language] ?? [],
            'patterns' => $patterns[$language] ?? [],
        ];
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

    private function language_navigation_markup(): string
    {
        $meta = [
            'cs' => ['code' => 'CZ', 'name' => 'Čeština'],
            'en' => ['code' => 'EN', 'name' => 'English'],
            'de' => ['code' => 'DE', 'name' => 'Deutsch'],
            'pl' => ['code' => 'PL', 'name' => 'Polski'],
        ];
        $current = $this->languages->current();
        $current_meta = $meta[$current] ?? $meta[Languages::DEFAULT];
        $items = [];

        foreach ($this->languages->all() as $language => $config) {
            if ($language === $current) {
                continue;
            }

            $url = $this->language_url($language);
            if ($url === '') {
                $url = $this->language_home_url($language);
            }
            if ($url === '') {
                continue;
            }

            $language_meta = $meta[$language] ?? [
                'code' => strtoupper($language),
                'name' => (string) ($config['label'] ?? strtoupper($language)),
            ];
            $items[] = sprintf(
                '<li class="wp-block-navigation-item wp-block-navigation-link jamu-language-menu__item"><a class="wp-block-navigation-item__content" href="%s" hreflang="%s" lang="%s" aria-label="%s" title="%s"><span class="wp-block-navigation-item__label"><span class="jamu-language-menu__flag" aria-hidden="true">%s</span><span class="jamu-language-menu__name screen-reader-text">%s</span></span></a></li>',
                esc_url($url),
                esc_attr($language),
                esc_attr($language),
                esc_attr($language_meta['name']),
                esc_attr($language_meta['name']),
                $this->language_flag_svg($language),
                esc_html($language_meta['name'])
            );
        }

        if (count($items) < 1) {
            return '';
        }

        $context = [
            'submenuOpenedBy' => ['click' => false, 'hover' => false, 'focus' => false],
            'type' => 'submenu',
            'modal' => null,
            'previousFocus' => null,
        ];
        $aria_label = sprintf(
            /* translators: %s: current language name */
            __('Language, current: %s', 'jamu-multilingual'),
            $current_meta['name']
        );

        return sprintf(
            '<li data-wp-context="%s" data-wp-interactive="core/navigation" data-wp-on--focusout="actions.handleMenuFocusout" data-wp-on--keydown="actions.handleMenuKeydown" data-wp-on--pointerenter="actions.openMenuOnHover" data-wp-on--pointerleave="actions.closeMenuOnHover" data-wp-watch="callbacks.initMenu" tabindex="-1" class="wp-block-navigation-item has-child open-on-hover-click wp-block-navigation-submenu jamu-language-menu"><a class="wp-block-navigation-item__content" href="%s" aria-label="%s" title="%s"><span class="wp-block-navigation-item__label"><span class="jamu-language-menu__flag" aria-hidden="true">%s</span><span class="jamu-language-menu__name screen-reader-text">%s</span></span></a><button data-wp-bind--aria-expanded="state.isMenuOpen" data-wp-on--click="actions.toggleMenuOnClick" aria-label="%s" class="wp-block-navigation__submenu-icon wp-block-navigation-submenu__toggle"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false"><path d="M1.50002 4L6.00002 8L10.5 4" stroke-width="1.5"></path></svg></button><ul data-wp-on--focus="actions.openMenuOnFocus" class="wp-block-navigation__submenu-container wp-block-navigation-submenu">%s</ul></li>',
            esc_attr((string) wp_json_encode($context)),
            esc_url($this->language_url($current) ?: $this->language_home_url($current)),
            esc_attr($aria_label),
            esc_attr($current_meta['name']),
            $this->language_flag_svg($current),
            esc_html($current_meta['name']),
            esc_attr__('Language submenu', 'jamu-multilingual'),
            implode('', $items)
        );
    }

    private function language_flag_svg(string $language): string
    {
        return match ($language) {
            'cs' => '<svg class="jamu-language-menu__flag-icon" viewBox="0 0 36 24" width="24" height="16" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><rect width="36" height="12" fill="#fff"/><rect y="12" width="36" height="12" fill="#d7141a"/><path d="M0 0 18 12 0 24Z" fill="#11457e"/></svg>',
            'en' => '<svg class="jamu-language-menu__flag-icon" viewBox="0 0 36 24" width="24" height="16" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><rect width="36" height="24" fill="#012169"/><path d="M0 0 36 24M36 0 0 24" stroke="#fff" stroke-width="6"/><path d="M0 0 36 24M36 0 0 24" stroke="#c8102e" stroke-width="3"/><path d="M18 0v24M0 12h36" stroke="#fff" stroke-width="8"/><path d="M18 0v24M0 12h36" stroke="#c8102e" stroke-width="4"/></svg>',
            'de' => '<svg class="jamu-language-menu__flag-icon" viewBox="0 0 36 24" width="24" height="16" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><rect width="36" height="8" fill="#000"/><rect y="8" width="36" height="8" fill="#dd0000"/><rect y="16" width="36" height="8" fill="#ffce00"/></svg>',
            'pl' => '<svg class="jamu-language-menu__flag-icon" viewBox="0 0 36 24" width="24" height="16" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><rect width="36" height="12" fill="#fff"/><rect y="12" width="36" height="12" fill="#dc143c"/></svg>',
            default => '<span class="jamu-language-menu__fallback" aria-hidden="true">' . esc_html(strtoupper($language)) . '</span>',
        };
    }

    private function language_url(string $language): string
    {
        $object = get_queried_object();
        $current = $this->languages->current();
        $require_translation = $language !== Languages::DEFAULT && $language !== $current;

        if ($object instanceof WP_Post) {
            return $this->router->localized_post_url($object, $language, $require_translation);
        }

        if ($object instanceof WP_Term && in_array($object->taxonomy, ['product_cat', 'product_tag'], true)) {
            return $this->router->localized_term_url($object, $object->taxonomy, $language, $require_translation);
        }

        if ($language === Languages::DEFAULT) {
            return home_url('/');
        }

        $front_id = (int) get_option('page_on_front');
        return $front_id ? $this->router->localized_post_url($front_id, $language, true) : '';
    }

    private function language_home_url(string $language): string
    {
        if ($language === Languages::DEFAULT) {
            return home_url('/');
        }

        $config = $this->languages->get($language);
        $prefix = trim((string) ($config['prefix'] ?? ''), '/');
        return $prefix !== '' ? home_url(user_trailingslashit($prefix)) : home_url('/');
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
                'Checkout' => 'Kasa',
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
        if (isset($strings[$language][$text])) {
            return $strings[$language][$text];
        }

        $frontend = $this->frontend_i18n_data();
        return $frontend['exact'][$text] ?? '';
    }

    private function active(): bool
    {
        return $this->languages->current() !== Languages::DEFAULT
            && (!is_admin() || wp_doing_ajax());
    }
}
