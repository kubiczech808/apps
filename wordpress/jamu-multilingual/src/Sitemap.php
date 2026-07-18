<?php

namespace Jamu\Multilingual;

defined('ABSPATH') || exit;

final class Sitemap
{
    public function __construct(
        private Repository $repository,
        private Languages $languages,
        private Router $router
    ) {
    }

    public function register(): void
    {
        add_action('template_redirect', [$this, 'maybe_render'], 0);
        add_filter('wpseo_sitemap_index', [$this, 'yoast_index']);
        add_filter('robots_txt', [$this, 'robots_txt'], 20, 2);
    }

    public function maybe_render(): void
    {
        if (!(int) get_query_var('jamu_sitemap') && !$this->is_direct_sitemap_request()) {
            return;
        }

        status_header(200);
        nocache_headers();
        header('Content-Type: application/xml; charset=UTF-8');
        echo '<?xml version="1.0" encoding="UTF-8"?>' . "\n";
        echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">' . "\n";

        $seen_urls = [];
        foreach ($this->group_rows($this->repository->all_published()) as $group) {
            if (!$this->is_indexable_group($group)) {
                continue;
            }

            $alternates = $this->alternate_urls($group);
            if (!$alternates) {
                continue;
            }

            foreach ($group['translations'] as $translation) {
                $url = $this->translation_url($translation);
                if (!$url) {
                    continue;
                }
                if (isset($seen_urls[$url])) {
                    continue;
                }
                $seen_urls[$url] = true;

                echo "  <url>\n";
                echo '    <loc>' . esc_url($url) . "</loc>\n";
                echo '    <lastmod>' . esc_html(mysql2date('c', $translation->updated_at, false)) . "</lastmod>\n";
                foreach ($alternates as $language => $alternate_url) {
                    printf(
                        "    <xhtml:link rel=\"alternate\" hreflang=\"%s\" href=\"%s\" />\n",
                        esc_attr($language),
                        esc_url($alternate_url)
                    );
                }
                echo "  </url>\n";
            }
        }
        echo "</urlset>\n";
        exit;
    }

    public function yoast_index(string $xml): string
    {
        $url = home_url('/jamu-localized-sitemap.xml');
        return $xml . '<sitemap><loc>' . esc_url($url) . '</loc><lastmod>' . esc_html(gmdate('c')) . '</lastmod></sitemap>';
    }

    public function robots_txt(string $output, bool $public): string
    {
        if ($public && !str_contains($output, 'jamu-localized-sitemap.xml')) {
            $output .= "\nSitemap: " . home_url('/jamu-localized-sitemap.xml') . "\n";
        }
        return $output;
    }

    private function is_direct_sitemap_request(): bool
    {
        $path = trim((string) wp_parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH), '/');
        return $path === 'jamu-localized-sitemap.xml';
    }

    private function group_rows(array $rows): array
    {
        $groups = [];
        foreach ($rows as $row) {
            if (!in_array($row->object_type, ['post', 'term'], true)) {
                continue;
            }
            $key = $row->object_type . ':' . $row->object_id;
            $groups[$key] ??= [
                'object_type' => $row->object_type,
                'object_subtype' => $row->object_subtype,
                'object_id' => (int) $row->object_id,
                'translations' => [],
            ];
            $groups[$key]['translations'][] = $row;
        }
        return $groups;
    }

    private function is_indexable_group(array $group): bool
    {
        if (($group['object_type'] ?? '') !== 'post') {
            return true;
        }

        $id = (int) ($group['object_id'] ?? 0);
        if (!$id) {
            return false;
        }

        $post = get_post($id);
        if (!$post || $post->post_status !== 'publish') {
            return false;
        }

        $excluded_page_ids = array_filter(array_map('absint', [
            get_option('woocommerce_cart_page_id'),
            get_option('woocommerce_checkout_page_id'),
            get_option('woocommerce_myaccount_page_id'),
        ]));

        return !in_array($id, $excluded_page_ids, true);
    }

    private function alternate_urls(array $group): array
    {
        $urls = [];
        $type = (string) ($group['object_type'] ?? '');
        $subtype = (string) ($group['object_subtype'] ?? '');
        $id = (int) ($group['object_id'] ?? 0);
        if (!$id) {
            return [];
        }

        if ($type === 'post') {
            $default = $this->router->localized_post_url($id, Languages::DEFAULT);
        } elseif ($type === 'term') {
            $default = $this->router->localized_term_url($id, $subtype, Languages::DEFAULT);
        } else {
            $default = '';
        }

        if ($default) {
            $urls['cs'] = $default;
        }

        foreach (array_keys($this->languages->additional()) as $language) {
            if ($type === 'post') {
                $url = $this->router->localized_post_url($id, $language, true);
            } else {
                $url = $this->router->localized_term_url($id, $subtype, $language, true);
            }
            if ($url) {
                $urls[$language] = $url;
            }
        }

        if ($default) {
            $urls['x-default'] = $default;
        }

        return $urls;
    }

    private function translation_url(object $translation): string
    {
        if ($translation->object_type === 'post') {
            return $this->router->localized_post_url((int) $translation->object_id, $translation->language, true);
        }
        return $this->router->localized_term_url(
            (int) $translation->object_id,
            $translation->object_subtype,
            $translation->language,
            true
        );
    }
}
