<?php

namespace Jamu\Multilingual;

use WP_Post;
use WP_Term;

defined('ABSPATH') || exit;

final class Admin
{
    private const NONCE_ACTION = 'jamu_ml_save_translation';

    public function __construct(
        private Repository $repository,
        private Languages $languages,
        private Router $router
    ) {
    }

    public function register(): void
    {
        add_action('add_meta_boxes', [$this, 'meta_boxes']);
        add_action('save_post', [$this, 'save_post'], 20, 2);
        add_action('admin_menu', [$this, 'admin_menu']);
        add_action('admin_init', [$this, 'taxonomy_hooks'], 20);
        add_filter('attachment_fields_to_edit', [$this, 'attachment_fields'], 20, 2);
        add_filter('attachment_fields_to_save', [$this, 'save_attachment_fields'], 20, 2);
        add_action('wp_ajax_jamu_ml_export', [$this, 'ajax_export']);
        add_action('wp_ajax_jamu_ml_import', [$this, 'ajax_import']);
        add_action('admin_notices', [$this, 'notices']);
        add_action('woocommerce_after_add_attribute_fields', [$this, 'attribute_fields']);
        add_action('woocommerce_after_edit_attribute_fields', [$this, 'attribute_fields']);
        add_action('woocommerce_attribute_added', [$this, 'save_attribute']);
        add_action('woocommerce_attribute_updated', [$this, 'save_attribute']);
    }

    public function meta_boxes(): void
    {
        foreach (['product', 'page', 'post'] as $post_type) {
            if (post_type_exists($post_type)) {
                add_meta_box(
                    'jamu-ml-translations',
                    __('JAMU translations', 'jamu-multilingual'),
                    [$this, 'render_post_box'],
                    $post_type,
                    'normal',
                    'default'
                );
            }
        }
    }

    public function render_post_box(WP_Post $post): void
    {
        wp_nonce_field(self::NONCE_ACTION, 'jamu_ml_nonce');
        echo '<p>' . esc_html__('Price, stock, SKU, tax, shipping and variations always remain on the original WooCommerce product.', 'jamu-multilingual') . '</p>';
        foreach ($this->languages->additional() as $language => $config) {
            $translation = $this->repository->get('post', $post->ID, $language, false);
            $this->translation_fields($language, $config['label'], $translation, $post->post_name, true);
        }
    }

    public function save_post(int $post_id, WP_Post $post): void
    {
        if (!in_array($post->post_type, ['product', 'page', 'post'], true)
            || wp_is_post_autosave($post_id)
            || wp_is_post_revision($post_id)
            || !isset($_POST['jamu_ml_nonce'])
            || !wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['jamu_ml_nonce'])), self::NONCE_ACTION)
            || !current_user_can('edit_post', $post_id)
        ) {
            return;
        }

        $this->save_languages('post', $post->post_type, $post_id, $_POST['jamu_ml'] ?? []);
    }

    public function taxonomy_hooks(): void
    {
        $taxonomies = ['product_cat', 'product_tag', 'category', 'post_tag'];
        if (function_exists('wc_get_attribute_taxonomy_names')) {
            $taxonomies = array_merge($taxonomies, wc_get_attribute_taxonomy_names());
        }
        foreach (array_unique($taxonomies) as $taxonomy) {
            if (!taxonomy_exists($taxonomy)) {
                continue;
            }
            add_action("{$taxonomy}_add_form_fields", function () use ($taxonomy): void {
                wp_nonce_field(self::NONCE_ACTION, 'jamu_ml_nonce');
                foreach ($this->languages->additional() as $language => $config) {
                    echo '<div class="form-field">';
                    $this->translation_fields($language, $config['label'], null, '', false);
                    echo '</div>';
                }
            });
            add_action("{$taxonomy}_edit_form_fields", function (WP_Term $term) use ($taxonomy): void {
                wp_nonce_field(self::NONCE_ACTION, 'jamu_ml_nonce');
                foreach ($this->languages->additional() as $language => $config) {
                    $translation = $this->repository->get('term', $term->term_id, $language, false);
                    echo '<tr class="form-field"><th colspan="2">';
                    $this->translation_fields($language, $config['label'], $translation, $term->slug, false);
                    echo '</th></tr>';
                }
            });
            add_action("created_{$taxonomy}", [$this, 'save_term']);
            add_action("edited_{$taxonomy}", [$this, 'save_term']);
        }
    }

    public function save_term(int $term_id): void
    {
        if (!isset($_POST['jamu_ml_nonce'])
            || !wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['jamu_ml_nonce'])), self::NONCE_ACTION)
            || !current_user_can('manage_categories')
        ) {
            return;
        }
        $term = get_term($term_id);
        if (!$term instanceof WP_Term) {
            return;
        }
        $this->save_languages('term', $term->taxonomy, $term_id, $_POST['jamu_ml'] ?? []);
    }

    public function attribute_fields(): void
    {
        $attribute_id = absint($_GET['edit'] ?? 0);
        wp_nonce_field(self::NONCE_ACTION, 'jamu_ml_attribute_nonce');
        foreach ($this->languages->additional() as $language => $config) {
            $translation = $attribute_id
                ? $this->repository->get('attribute', $attribute_id, $language, false)
                : null;
            $title = esc_attr((string) ($translation->title ?? ''));
            ?>
            <div class="form-field">
                <label for="jamu-attribute-<?php echo esc_attr($language); ?>"><?php echo esc_html(sprintf(__('Attribute label (%s)', 'jamu-multilingual'), $config['label'])); ?></label>
                <input id="jamu-attribute-<?php echo esc_attr($language); ?>" name="jamu_attribute[<?php echo esc_attr($language); ?>][title]" value="<?php echo $title; ?>">
                <label><input type="checkbox" name="jamu_attribute[<?php echo esc_attr($language); ?>][status]" value="publish" <?php checked(($translation->status ?? '') === 'publish'); ?>> <?php esc_html_e('Published', 'jamu-multilingual'); ?></label>
            </div>
            <?php
        }
    }

    public function save_attribute(int $attribute_id): void
    {
        if (!isset($_POST['jamu_ml_attribute_nonce'])
            || !wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['jamu_ml_attribute_nonce'])), self::NONCE_ACTION)
            || !current_user_can('manage_woocommerce')
        ) {
            return;
        }
        $this->save_languages('attribute', 'product_attribute', $attribute_id, $_POST['jamu_attribute'] ?? []);
    }

    public function attachment_fields(array $fields, WP_Post $post): array
    {
        foreach ($this->languages->additional() as $language => $config) {
            $translation = $this->repository->get('attachment', $post->ID, $language, false);
            $fields["jamu_alt_{$language}"] = [
                'label' => sprintf(__('Alt text (%s)', 'jamu-multilingual'), $config['label']),
                'input' => 'text',
                'value' => $translation->data_decoded['alt'] ?? '',
            ];
        }
        return $fields;
    }

    public function save_attachment_fields(array $post, array $attachment): array
    {
        $post_id = absint($post['ID'] ?? 0);
        if (!$post_id || !current_user_can('edit_post', $post_id)) {
            return $post;
        }
        foreach ($this->languages->additional() as $language => $config) {
            $key = "jamu_alt_{$language}";
            if (!array_key_exists($key, $attachment)) {
                continue;
            }
            $existing = $this->repository->get('attachment', $post_id, $language, false);
            $data = $existing->data_decoded ?? [];
            $data['alt'] = sanitize_text_field($attachment[$key]);
            $this->repository->save([
                'object_type' => 'attachment', 'object_subtype' => 'image',
                'object_id' => $post_id, 'language' => $language,
                'data' => $data, 'status' => $data['alt'] !== '' ? 'publish' : 'draft',
            ]);
        }
        return $post;
    }

    public function admin_menu(): void
    {
        add_management_page(
            __('JAMU translations', 'jamu-multilingual'),
            __('JAMU translations', 'jamu-multilingual'),
            'manage_options',
            'jamu-translations',
            [$this, 'admin_page']
        );
    }

    public function admin_page(): void
    {
        $nonce = wp_create_nonce('jamu_ml_transfer');
        $rows = $this->repository->all_published();
        $counts = ['en' => 0, 'de' => 0, 'pl' => 0];
        foreach ($rows as $row) {
            if (isset($counts[$row->language])) {
                $counts[$row->language]++;
            }
        }
        ?>
        <div class="wrap">
            <h1><?php esc_html_e('JAMU translations', 'jamu-multilingual'); ?></h1>
            <p><?php echo esc_html(sprintf('EN: %d · DE: %d · PL: %d', $counts['en'], $counts['de'], $counts['pl'])); ?></p>
            <p><?php esc_html_e('Translations can be edited on posts, products, taxonomy terms and media. Import only JSON created for this plugin.', 'jamu-multilingual'); ?></p>
            <button class="button" id="jamu-export"><?php esc_html_e('Export source and translations', 'jamu-multilingual'); ?></button>
            <input type="file" id="jamu-import-file" accept="application/json">
            <button class="button button-primary" id="jamu-import"><?php esc_html_e('Import translations', 'jamu-multilingual'); ?></button>
            <pre id="jamu-transfer-status" style="max-width:900px;white-space:pre-wrap"></pre>
        </div>
        <script>
        (() => {
            const ajaxUrl = <?php echo wp_json_encode(admin_url('admin-ajax.php')); ?>;
            const nonce = <?php echo wp_json_encode($nonce); ?>;
            const status = document.getElementById('jamu-transfer-status');
            document.getElementById('jamu-export').addEventListener('click', async () => {
                status.textContent = 'Exporting…';
                const response = await fetch(`${ajaxUrl}?action=jamu_ml_export&_ajax_nonce=${encodeURIComponent(nonce)}`, {credentials: 'same-origin'});
                const blob = await response.blob();
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob); link.download = 'jamu-translations-export.json'; link.click();
                URL.revokeObjectURL(link.href); status.textContent = response.ok ? 'Export complete.' : 'Export failed.';
            });
            document.getElementById('jamu-import').addEventListener('click', async () => {
                const file = document.getElementById('jamu-import-file').files[0];
                if (!file) { status.textContent = 'Choose a JSON file first.'; return; }
                status.textContent = 'Importing…';
                const form = new FormData(); form.append('action', 'jamu_ml_import'); form.append('_ajax_nonce', nonce); form.append('payload', await file.text());
                const response = await fetch(ajaxUrl, {method: 'POST', body: form, credentials: 'same-origin'});
                status.textContent = await response.text();
            });
        })();
        </script>
        <?php
    }

    public function ajax_export(): void
    {
        check_ajax_referer('jamu_ml_transfer');
        if (!current_user_can('manage_options')) {
            wp_send_json_error(['message' => 'Forbidden'], 403);
        }
        nocache_headers();
        header('Content-Disposition: attachment; filename="jamu-translations-export.json"');
        wp_send_json([
            'schema' => 1,
            'site' => home_url('/'),
            'generated_at' => gmdate('c'),
            'source' => $this->source_inventory(),
            'translations' => $this->repository->all_published(),
        ], 200, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    public function ajax_import(): void
    {
        check_ajax_referer('jamu_ml_transfer');
        if (!current_user_can('manage_options')) {
            wp_send_json_error(['message' => 'Forbidden'], 403);
        }
        $payload = json_decode(wp_unslash($_POST['payload'] ?? ''), true);
        if (!is_array($payload) || !is_array($payload['translations'] ?? null)) {
            wp_send_json_error(['message' => 'Invalid JSON payload'], 400);
        }
        $saved = 0;
        $errors = [];
        foreach ($payload['translations'] as $row) {
            if (!is_array($row)) {
                continue;
            }
            $result = $this->repository->save($this->sanitize_translation($row));
            if (is_wp_error($result)) {
                $errors[] = $result->get_error_message();
            } elseif ($result) {
                $saved++;
            }
        }
        flush_rewrite_rules(false);
        wp_send_json_success(['saved' => $saved, 'errors' => array_values(array_unique($errors))]);
    }

    public function notices(): void
    {
        $error = get_transient('jamu_ml_admin_error_' . get_current_user_id());
        if (!$error) {
            return;
        }
        delete_transient('jamu_ml_admin_error_' . get_current_user_id());
        printf('<div class="notice notice-error"><p>%s</p></div>', esc_html($error));
    }

    private function translation_fields(string $language, string $label, ?object $translation, string $fallback_slug, bool $with_excerpt): void
    {
        $prefix = "jamu_ml[{$language}]";
        $value = static fn (string $field): string => esc_attr((string) ($translation->{$field} ?? ''));
        echo '<fieldset style="border:1px solid #ccd0d4;padding:12px;margin:12px 0">';
        echo '<legend><strong>' . esc_html($label) . '</strong></legend>';
        printf('<p><label><input type="checkbox" name="%s[status]" value="publish" %s> %s</label></p>', esc_attr($prefix), checked(($translation->status ?? '') === 'publish', true, false), esc_html__('Published', 'jamu-multilingual'));
        printf('<p><label>%s<br><input class="widefat" name="%s[title]" value="%s"></label></p>', esc_html__('Title/name', 'jamu-multilingual'), esc_attr($prefix), $value('title'));
        printf('<p><label>%s<br><input class="widefat" name="%s[route_path]" value="%s" placeholder="%s"></label></p>', esc_html__('Localized URL path', 'jamu-multilingual'), esc_attr($prefix), $value('route_path'), esc_attr($fallback_slug));
        if ($with_excerpt) {
            printf('<p><label>%s<br><textarea class="widefat" rows="4" name="%s[excerpt]">%s</textarea></label></p>', esc_html__('Short description/excerpt', 'jamu-multilingual'), esc_attr($prefix), esc_textarea((string) ($translation->excerpt ?? '')));
        }
        printf('<p><label>%s<br><textarea class="widefat" rows="8" name="%s[content]">%s</textarea></label></p>', esc_html__('Content/description', 'jamu-multilingual'), esc_attr($prefix), esc_textarea((string) ($translation->content ?? '')));
        printf('<p><label>%s<br><input class="widefat" name="%s[seo_title]" value="%s"></label></p>', esc_html__('SEO title', 'jamu-multilingual'), esc_attr($prefix), $value('seo_title'));
        printf('<p><label>%s<br><textarea class="widefat" rows="2" name="%s[meta_description]">%s</textarea></label></p>', esc_html__('Meta description', 'jamu-multilingual'), esc_attr($prefix), esc_textarea((string) ($translation->meta_description ?? '')));
        echo '</fieldset>';
    }

    private function save_languages(string $type, string $subtype, int $object_id, mixed $input): void
    {
        if (!is_array($input)) {
            return;
        }
        foreach ($this->languages->additional() as $language => $config) {
            $row = is_array($input[$language] ?? null) ? wp_unslash($input[$language]) : [];
            $row = $this->sanitize_translation(array_merge($row, [
                'object_type' => $type, 'object_subtype' => $subtype,
                'object_id' => $object_id, 'language' => $language,
            ]));
            $result = $this->repository->save($row);
            if (is_wp_error($result)) {
                set_transient('jamu_ml_admin_error_' . get_current_user_id(), $result->get_error_message(), 60);
            }
        }
    }

    private function sanitize_translation(array $row): array
    {
        return [
            'object_type' => sanitize_key($row['object_type'] ?? ''),
            'object_subtype' => sanitize_key($row['object_subtype'] ?? ''),
            'object_id' => absint($row['object_id'] ?? 0),
            'language' => sanitize_key($row['language'] ?? ''),
            'route_path' => sanitize_text_field($row['route_path'] ?? ''),
            'slug' => sanitize_title($row['slug'] ?? ''),
            'title' => sanitize_text_field($row['title'] ?? ''),
            'excerpt' => $this->sanitize_markup((string) ($row['excerpt'] ?? '')),
            'content' => $this->sanitize_markup((string) ($row['content'] ?? '')),
            'seo_title' => sanitize_text_field($row['seo_title'] ?? ''),
            'meta_description' => sanitize_textarea_field($row['meta_description'] ?? ''),
            'data' => is_array($row['data'] ?? null) ? $row['data'] : [],
            'status' => ($row['status'] ?? '') === 'publish' ? 'publish' : 'draft',
        ];
    }

    private function sanitize_markup(string $value): string
    {
        $comments = [];
        $placeholder_prefix = 'jamu_ml_block_comment_';
        $value = preg_replace_callback('/<!--\s*\/?wp:[\s\S]*?-->/', static function (array $match) use (&$comments, $placeholder_prefix): string {
            $placeholder = $placeholder_prefix . count($comments) . '_';
            $comments[$placeholder] = $match[0];
            return $placeholder;
        }, $value) ?? $value;

        $value = wp_kses_post($value);
        return strtr($value, $comments);
    }

    private function source_inventory(): array
    {
        $result = ['posts' => [], 'terms' => [], 'attributes' => [], 'media' => []];
        $posts = get_posts([
            'post_type' => ['product', 'page', 'post', 'nav_menu_item'],
            'post_status' => ['publish', 'private'], 'numberposts' => -1,
            'orderby' => 'ID', 'order' => 'ASC',
        ]);
        foreach ($posts as $post) {
            $result['posts'][] = [
                'object_type' => 'post', 'object_subtype' => $post->post_type,
                'object_id' => $post->ID, 'slug' => $post->post_name,
                'title' => $post->post_title, 'excerpt' => $post->post_excerpt,
                'content' => $post->post_content,
                'seo_title' => get_post_meta($post->ID, '_yoast_wpseo_title', true),
                'meta_description' => get_post_meta($post->ID, '_yoast_wpseo_metadesc', true),
            ];
        }
        foreach (['product_cat', 'product_tag', 'category', 'post_tag'] as $taxonomy) {
            if (!taxonomy_exists($taxonomy)) {
                continue;
            }
            $terms = get_terms(['taxonomy' => $taxonomy, 'hide_empty' => false]);
            if (is_wp_error($terms)) {
                continue;
            }
            foreach ($terms as $term) {
                $result['terms'][] = [
                    'object_type' => 'term', 'object_subtype' => $taxonomy,
                    'object_id' => $term->term_id, 'parent' => $term->parent,
                    'slug' => $term->slug, 'title' => $term->name,
                    'content' => $term->description,
                ];
            }
        }
        if (function_exists('wc_get_attribute_taxonomies')) {
            foreach (wc_get_attribute_taxonomies() as $attribute) {
                $result['attributes'][] = [
                    'object_type' => 'attribute', 'object_subtype' => 'product_attribute',
                    'object_id' => (int) $attribute->attribute_id,
                    'slug' => $attribute->attribute_name, 'title' => $attribute->attribute_label,
                ];
            }
        }
        $media = get_posts(['post_type' => 'attachment', 'post_status' => 'inherit', 'post_mime_type' => 'image', 'numberposts' => -1]);
        foreach ($media as $attachment) {
            $result['media'][] = [
                'object_type' => 'attachment', 'object_subtype' => 'image',
                'object_id' => $attachment->ID, 'title' => $attachment->post_title,
                'data' => ['alt' => get_post_meta($attachment->ID, '_wp_attachment_image_alt', true)],
            ];
        }
        return $result;
    }
}
