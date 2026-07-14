<?php

namespace Jamu\Multilingual;

use WP_Post;
use WP_Term;

defined('ABSPATH') || exit;

final class Router
{
    private bool $link_guard = false;

    public function __construct(
        private Repository $repository,
        private Languages $languages
    ) {
    }

    public function register(): void
    {
        add_action('init', [$this, 'add_rewrite_rules'], 8);
        add_filter('query_vars', [$this, 'query_vars']);
        add_action('parse_request', [$this, 'resolve_request'], 5);
        add_filter('post_type_link', [$this, 'filter_post_link'], 20, 2);
        add_filter('post_link', [$this, 'filter_post_link'], 20, 2);
        add_filter('page_link', [$this, 'filter_page_link'], 20, 2);
        add_filter('term_link', [$this, 'filter_term_link'], 20, 3);
    }

    public function add_rewrite_rules(): void
    {
        foreach ($this->languages->additional() as $language => $config) {
            $prefix = preg_quote($config['prefix'], '#');
            $product = preg_quote($config['product_base'], '#');
            $category = preg_quote($config['category_base'], '#');
            $tag = preg_quote($config['tag_base'], '#');

            add_rewrite_rule(
                "^{$prefix}/{$product}/([^/]+)/?$",
                "index.php?jamu_lang={$language}&jamu_route_type=product&jamu_route=\$matches[1]",
                'top'
            );
            add_rewrite_rule(
                "^{$prefix}/{$category}/(.+?)/?$",
                "index.php?jamu_lang={$language}&jamu_route_type=product_cat&jamu_route=\$matches[1]",
                'top'
            );
            add_rewrite_rule(
                "^{$prefix}/{$tag}/(.+?)/?$",
                "index.php?jamu_lang={$language}&jamu_route_type=product_tag&jamu_route=\$matches[1]",
                'top'
            );
            add_rewrite_rule(
                "^{$prefix}/(.+?)/?$",
                "index.php?jamu_lang={$language}&jamu_route_type=content&jamu_route=\$matches[1]",
                'top'
            );
            add_rewrite_rule(
                "^{$prefix}/?$",
                "index.php?jamu_lang={$language}&jamu_route_type=home",
                'top'
            );
        }

        add_rewrite_rule(
            '^jamu-localized-sitemap\.xml$',
            'index.php?jamu_sitemap=1',
            'top'
        );
    }

    public function query_vars(array $vars): array
    {
        return array_merge($vars, [
            'jamu_lang', 'jamu_route_type', 'jamu_route',
            'jamu_missing_translation', 'jamu_sitemap',
        ]);
    }

    public function resolve_request(\WP $wp): void
    {
        $language = sanitize_key((string) ($wp->query_vars['jamu_lang'] ?? ''));
        if (!$language) {
            $request = trim((string) ($wp->request ?? ''), '/');
            if ($request === '') {
                $request = trim((string) wp_parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH), '/');
            }
            foreach ($this->languages->additional() as $candidate => $config) {
                if ($request === trim((string) $config['prefix'], '/')) {
                    $language = $candidate;
                    $wp->query_vars['jamu_lang'] = $candidate;
                    $wp->query_vars['jamu_route_type'] = 'home';
                    break;
                }
            }
        }
        if (!$language || $language === Languages::DEFAULT) {
            return;
        }
        $this->languages->set_current($language);

        $type = sanitize_key((string) ($wp->query_vars['jamu_route_type'] ?? ''));
        $route = trim((string) ($wp->query_vars['jamu_route'] ?? ''), '/');

        if ($type === 'home') {
            $page_id = (int) get_option('page_on_front');
            if ($page_id) {
                $this->set_post_query($wp, $page_id, 'page');
                if (!$this->repository->get('post', $page_id, $language)) {
                    $wp->query_vars['jamu_missing_translation'] = 1;
                }
            }
            return;
        }

        if ($type === 'product') {
            $translation = $this->repository->find_route($language, 'post', 'product', $route);
            if ($translation) {
                $this->set_post_query($wp, (int) $translation->object_id, 'product');
                return;
            }
            $post = get_page_by_path($route, OBJECT, 'product');
            if ($post instanceof WP_Post) {
                $this->set_post_query($wp, $post->ID, 'product');
                $wp->query_vars['jamu_missing_translation'] = 1;
            }
            return;
        }

        if (in_array($type, ['product_cat', 'product_tag'], true)) {
            $translation = $this->repository->find_route($language, 'term', $type, $route);
            if ($translation) {
                $this->set_term_query($wp, (int) $translation->object_id, $type);
                return;
            }
            $original_slug = basename($route);
            $term = get_term_by('slug', $original_slug, $type);
            if ($term instanceof WP_Term) {
                $this->set_term_query($wp, $term->term_id, $type);
                $wp->query_vars['jamu_missing_translation'] = 1;
            }
            return;
        }

        if ($type === 'content') {
            $translation = $this->repository->find_content_route($language, $route);
            if ($translation) {
                $this->set_post_query($wp, (int) $translation->object_id, $translation->object_subtype);
                return;
            }
            $post = get_page_by_path($route, OBJECT, ['page', 'post']);
            if ($post instanceof WP_Post) {
                $this->set_post_query($wp, $post->ID, $post->post_type);
                $wp->query_vars['jamu_missing_translation'] = 1;
            }
        }
    }

    public function localized_post_url(int|WP_Post $post, string $language, bool $require_translation = false): string
    {
        $post = get_post($post);
        if (!$post instanceof WP_Post) {
            return '';
        }
        if ($language === Languages::DEFAULT) {
            return $this->original_post_url($post);
        }

        $translation = $this->repository->get('post', $post->ID, $language);
        if (!$translation && $require_translation) {
            return '';
        }
        $config = $this->languages->get($language);
        if ($post->post_type === 'page' && (int) get_option('page_on_front') === (int) $post->ID) {
            return home_url(user_trailingslashit($config['prefix']));
        }

        $route = $translation && $translation->route_path
            ? trim($translation->route_path, '/')
            : $this->original_content_path($post);

        if ($post->post_type === 'product') {
            $route = $config['product_base'] . '/' . basename($route);
        }
        return home_url(user_trailingslashit($config['prefix'] . '/' . $route));
    }

    public function localized_term_url(int|WP_Term $term, string $taxonomy, string $language, bool $require_translation = false): string
    {
        $term = get_term($term, $taxonomy);
        if (!$term instanceof WP_Term) {
            return '';
        }
        if ($language === Languages::DEFAULT) {
            $url = get_term_link($term);
            return is_wp_error($url) ? '' : $url;
        }
        $translation = $this->repository->get('term', $term->term_id, $language);
        if (!$translation && $require_translation) {
            return '';
        }
        $config = $this->languages->get($language);
        $base = $taxonomy === 'product_cat' ? $config['category_base'] : $config['tag_base'];
        $route = $translation && $translation->route_path ? $translation->route_path : $term->slug;
        return home_url(user_trailingslashit($config['prefix'] . '/' . $base . '/' . trim($route, '/')));
    }

    public function filter_post_link(string $url, WP_Post $post): string
    {
        if ($this->link_guard || !$this->is_localized_frontend()) {
            return $url;
        }
        $localized = $this->localized_post_url($post, $this->languages->current());
        return $localized ?: $url;
    }

    public function filter_page_link(string $url, int $post_id): string
    {
        if ($this->link_guard || !$this->is_localized_frontend()) {
            return $url;
        }
        $localized = $this->localized_post_url($post_id, $this->languages->current());
        return $localized ?: $url;
    }

    public function filter_term_link(string $url, WP_Term $term, string $taxonomy): string
    {
        if ($this->link_guard || !$this->is_localized_frontend() || !in_array($taxonomy, ['product_cat', 'product_tag'], true)) {
            return $url;
        }
        $localized = $this->localized_term_url($term, $taxonomy, $this->languages->current());
        return $localized ?: $url;
    }

    private function original_post_url(WP_Post $post): string
    {
        $this->link_guard = true;
        $url = get_permalink($post);
        $this->link_guard = false;
        return is_string($url) ? $url : '';
    }

    private function original_content_path(WP_Post $post): string
    {
        $url = $this->original_post_url($post);
        $path = trim((string) wp_parse_url($url, PHP_URL_PATH), '/');
        if ($post->post_type === 'product') {
            return $post->post_name;
        }
        return $path ?: $post->post_name;
    }

    private function set_post_query(\WP $wp, int $post_id, string $post_type): void
    {
        unset($wp->query_vars['name'], $wp->query_vars['pagename'], $wp->query_vars['page_id'], $wp->query_vars['p']);
        if ($post_type === 'page') {
            $wp->query_vars['page_id'] = $post_id;
            $wp->query_vars['post_type'] = 'page';
            return;
        }

        $wp->query_vars['post_type'] = $post_type;
        $wp->query_vars['p'] = $post_id;
    }

    private function set_term_query(\WP $wp, int $term_id, string $taxonomy): void
    {
        $term = get_term($term_id, $taxonomy);
        if (!$term instanceof WP_Term) {
            return;
        }
        $wp->query_vars[$taxonomy] = $term->slug;
        $wp->query_vars['taxonomy'] = $taxonomy;
        $wp->query_vars['term'] = $term->slug;
    }

    private function is_localized_frontend(): bool
    {
        return $this->languages->current() !== Languages::DEFAULT
            && (!is_admin() || wp_doing_ajax());
    }
}
