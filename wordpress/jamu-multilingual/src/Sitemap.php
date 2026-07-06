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
        if (!(int) get_query_var('jamu_sitemap')) {
            return;
        }

        status_header(200);
        nocache_headers();
        header('Content-Type: application/xml; charset=UTF-8');
        echo '<?xml version="1.0" encoding="UTF-8"?>' . "\n";
        echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">' . "\n";

        foreach ($this->group_rows($this->repository->all_published()) as $group) {
            foreach ($group['translations'] as $translation) {
                $url = $this->translation_url($translation);
                if (!$url) {
                    continue;
                }
                echo "  <url>\n";
                echo '    <loc>' . esc_url($url) . "</loc>\n";
                echo '    <lastmod>' . esc_html(mysql2date('c', $translation->updated_at, false)) . "</lastmod>\n";
                foreach ($group['translations'] as $alternate) {
                    $alternate_url = $this->translation_url($alternate);
                    if ($alternate_url) {
                        printf(
                            "    <xhtml:link rel=\"alternate\" hreflang=\"%s\" href=\"%s\" />\n",
                            esc_attr($alternate->language),
                            esc_url($alternate_url)
                        );
                    }
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

    private function group_rows(array $rows): array
    {
        $groups = [];
        foreach ($rows as $row) {
            if (!in_array($row->object_type, ['post', 'term'], true)) {
                continue;
            }
            $key = $row->object_type . ':' . $row->object_id;
            $groups[$key] ??= ['translations' => []];
            $groups[$key]['translations'][] = $row;
        }
        return $groups;
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

