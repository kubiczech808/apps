<?php
/**
 * Ephemeral JAMU inventory bridge.
 * Inert without the one-time request header and self-removes after success.
 */

defined('ABSPATH') || exit;

$jamu_presented = (string) ($_SERVER['HTTP_X_JAMU_BRIDGE'] ?? '');
if ($jamu_presented === '' || !hash_equals('__JAMU_TOKEN_HASH__', hash('sha256', $jamu_presented))) {
    return;
}

add_action('wp_loaded', static function (): void {
    if (($_GET['jamu_bridge'] ?? '') !== 'inventory') {
        return;
    }

    if (!function_exists('get_posts') || !function_exists('get_terms')) {
        status_header(503);
        exit;
    }

    nocache_headers();
    header('Content-Type: application/json; charset=UTF-8');
    register_shutdown_function(static function (): void {
        @unlink(__FILE__);
    });

    $inventory = [
        'schema' => 1,
        'site' => home_url('/'),
        'generated_at' => gmdate('c'),
        'wordpress_version' => get_bloginfo('version'),
        'site_strings' => [
            'name' => get_bloginfo('name'),
            'description' => get_bloginfo('description'),
        ],
        'settings' => [
            'show_on_front' => get_option('show_on_front'),
            'page_on_front' => (int) get_option('page_on_front'),
            'page_for_posts' => (int) get_option('page_for_posts'),
            'woocommerce_shop_page_id' => (int) get_option('woocommerce_shop_page_id'),
            'woocommerce_cart_page_id' => (int) get_option('woocommerce_cart_page_id'),
            'woocommerce_checkout_page_id' => (int) get_option('woocommerce_checkout_page_id'),
            'woocommerce_myaccount_page_id' => (int) get_option('woocommerce_myaccount_page_id'),
        ],
        'posts' => [],
        'terms' => [],
        'attributes' => [],
        'menus' => [],
        'block_templates' => [],
        'forms' => [],
        'media' => [],
        'registered_post_types' => [],
        'active_theme' => [],
        'active_plugins' => [],
    ];

    $registered_post_types = get_post_types([], 'objects');
    foreach ($registered_post_types as $post_type => $object) {
        $counts = wp_count_posts($post_type);
        $inventory['registered_post_types'][] = [
            'name' => $post_type,
            'label' => $object->label,
            'public' => (bool) $object->public,
            'show_ui' => (bool) $object->show_ui,
            'published' => (int) ($counts->publish ?? 0),
        ];
    }

    $public_post_types = get_post_types(['public' => true], 'objects');
    foreach (['wp_navigation', 'wp_template', 'wp_template_part', 'wp_block'] as $special_type) {
        if (isset($registered_post_types[$special_type])) {
            $public_post_types[$special_type] = $registered_post_types[$special_type];
        }
    }
    unset($public_post_types['attachment']);
    foreach ($public_post_types as $post_type => $object) {
        $posts = get_posts([
            'post_type' => $post_type,
            'post_status' => 'publish',
            'posts_per_page' => -1,
            'orderby' => 'ID',
            'order' => 'ASC',
            'suppress_filters' => true,
        ]);
        foreach ($posts as $post) {
            $row = [
                'object_type' => 'post',
                'object_subtype' => $post->post_type,
                'object_id' => $post->ID,
                'parent' => (int) $post->post_parent,
                'slug' => $post->post_name,
                'url' => get_permalink($post),
                'title' => $post->post_title,
                'excerpt' => $post->post_excerpt,
                'content' => $post->post_content,
                'featured_media' => (int) get_post_thumbnail_id($post),
                'seo_title' => (string) get_post_meta($post->ID, '_yoast_wpseo_title', true),
                'meta_description' => (string) get_post_meta($post->ID, '_yoast_wpseo_metadesc', true),
            ];
            if ($post->post_type === 'product') {
                $row['gallery_media'] = array_values(array_filter(array_map(
                    'absint',
                    explode(',', (string) get_post_meta($post->ID, '_product_image_gallery', true))
                )));
            }
            $inventory['posts'][] = $row;
        }
    }

    $public_taxonomies = get_taxonomies(['public' => true], 'objects');
    foreach ($public_taxonomies as $taxonomy => $object) {
        $terms = get_terms(['taxonomy' => $taxonomy, 'hide_empty' => true]);
        if (is_wp_error($terms)) {
            continue;
        }
        foreach ($terms as $term) {
            $inventory['terms'][] = [
                'object_type' => 'term',
                'object_subtype' => $taxonomy,
                'object_id' => $term->term_id,
                'parent' => (int) $term->parent,
                'slug' => $term->slug,
                'url' => is_wp_error(get_term_link($term)) ? '' : get_term_link($term),
                'title' => $term->name,
                'content' => $term->description,
                'count' => (int) $term->count,
            ];
        }
    }

    if (function_exists('wc_get_attribute_taxonomies')) {
        foreach (wc_get_attribute_taxonomies() as $attribute) {
            $inventory['attributes'][] = [
                'object_type' => 'attribute',
                'object_subtype' => 'product_attribute',
                'object_id' => (int) $attribute->attribute_id,
                'slug' => $attribute->attribute_name,
                'title' => $attribute->attribute_label,
            ];
        }
    }

    foreach (wp_get_nav_menus() as $menu) {
        $items = [];
        foreach (wp_get_nav_menu_items($menu->term_id, ['post_status' => 'publish']) ?: [] as $item) {
            $items[] = [
                'menu_item_id' => $item->ID,
                'parent' => (int) $item->menu_item_parent,
                'title' => $item->title,
                'url' => $item->url,
                'type' => $item->type,
                'object' => $item->object,
                'object_id' => (int) $item->object_id,
            ];
        }
        $inventory['menus'][] = [
            'id' => $menu->term_id,
            'name' => $menu->name,
            'slug' => $menu->slug,
            'items' => $items,
        ];
    }

    if (function_exists('get_block_templates')) {
        foreach (['wp_template', 'wp_template_part'] as $template_type) {
            foreach (get_block_templates([], $template_type) as $template) {
                $stable_key = 'template:' . $template->id;
                $inventory['block_templates'][] = [
                    'object_type' => 'template',
                    'object_subtype' => $template_type,
                    'object_id' => (int) hexdec(substr(hash('sha256', $stable_key), 0, 15)),
                    'template_id' => $template->id,
                    'wp_id' => (int) ($template->wp_id ?? 0),
                    'slug' => $template->slug,
                    'theme' => $template->theme,
                    'source' => $template->source,
                    'title' => is_object($template->title) ? ($template->title->rendered ?? '') : (string) $template->title,
                    'description' => (string) ($template->description ?? ''),
                    'content' => (string) $template->content,
                    'area' => (string) ($template->area ?? ''),
                ];
            }
        }
    }

    $forms = get_posts([
        'post_type' => 'wpforms',
        'post_status' => 'publish',
        'posts_per_page' => -1,
        'orderby' => 'ID',
        'order' => 'ASC',
    ]);
    foreach ($forms as $form) {
        $form_data = json_decode($form->post_content, true);
        if (!is_array($form_data)) {
            continue;
        }
        $public_fields = [];
        foreach ((array) ($form_data['fields'] ?? []) as $field_id => $field) {
            $public_field = [
                'id' => (int) ($field['id'] ?? $field_id),
                'type' => (string) ($field['type'] ?? ''),
            ];
            foreach (['label', 'description', 'placeholder', 'sublabel_hide', 'size', 'format', 'code'] as $key) {
                if (array_key_exists($key, $field)) {
                    $public_field[$key] = $field[$key];
                }
            }
            if (!empty($field['choices']) && is_array($field['choices'])) {
                $public_field['choices'] = array_map(static function ($choice): array {
                    return [
                        'label' => (string) ($choice['label'] ?? ''),
                        'value' => (string) ($choice['value'] ?? ''),
                    ];
                }, $field['choices']);
            }
            $public_fields[(string) $field_id] = $public_field;
        }
        $public_settings = [];
        foreach (['form_title', 'form_desc', 'submit_text', 'submit_text_processing', 'confirmation_message'] as $key) {
            if (array_key_exists($key, $form_data['settings'] ?? [])) {
                $public_settings[$key] = $form_data['settings'][$key];
            }
        }
        $inventory['forms'][] = [
            'object_type' => 'form',
            'object_subtype' => 'wpforms',
            'object_id' => $form->ID,
            'title' => $form->post_title,
            'fields' => $public_fields,
            'settings' => $public_settings,
        ];
    }

    $attachments = get_posts([
        'post_type' => 'attachment',
        'post_status' => 'inherit',
        'post_mime_type' => 'image',
        'posts_per_page' => -1,
        'orderby' => 'ID',
        'order' => 'ASC',
    ]);
    foreach ($attachments as $attachment) {
        $inventory['media'][] = [
            'object_type' => 'attachment',
            'object_subtype' => 'image',
            'object_id' => $attachment->ID,
            'parent' => (int) $attachment->post_parent,
            'url' => wp_get_attachment_url($attachment->ID),
            'title' => $attachment->post_title,
            'caption' => $attachment->post_excerpt,
            'description' => $attachment->post_content,
            'alt' => (string) get_post_meta($attachment->ID, '_wp_attachment_image_alt', true),
        ];
    }

    $theme = wp_get_theme();
    $inventory['active_theme'] = [
        'name' => $theme->get('Name'),
        'version' => $theme->get('Version'),
        'template' => $theme->get_template(),
        'stylesheet' => $theme->get_stylesheet(),
    ];

    if (!function_exists('get_plugin_data')) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    foreach ((array) get_option('active_plugins', []) as $plugin_file) {
        $absolute = WP_PLUGIN_DIR . '/' . $plugin_file;
        $data = is_readable($absolute) ? get_plugin_data($absolute, false, false) : [];
        $inventory['active_plugins'][] = [
            'file' => $plugin_file,
            'name' => $data['Name'] ?? '',
            'version' => $data['Version'] ?? '',
        ];
    }

    echo wp_json_encode($inventory, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}, 999);
