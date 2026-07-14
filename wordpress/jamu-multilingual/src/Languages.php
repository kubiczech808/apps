<?php

namespace Jamu\Multilingual;

defined('ABSPATH') || exit;

final class Languages
{
    public const DEFAULT = 'cs';

    private const CONFIG = [
        'cs' => [
            'label' => 'Čeština', 'locale' => 'cs_CZ', 'prefix' => '',
            'product_base' => 'produkt', 'category_base' => 'kategorie-produktu',
            'tag_base' => 'stitek-produktu',
        ],
        'en' => [
            'label' => 'English', 'locale' => 'en_GB', 'prefix' => 'en',
            'product_base' => 'product', 'category_base' => 'product-category',
            'tag_base' => 'product-tag',
        ],
        'de' => [
            'label' => 'Deutsch', 'locale' => 'de_DE', 'prefix' => 'de',
            'product_base' => 'produkt', 'category_base' => 'produkt-kategorie',
            'tag_base' => 'produkt-schlagwort',
        ],
        'pl' => [
            'label' => 'Polski', 'locale' => 'pl_PL', 'prefix' => 'pl',
            'product_base' => 'produkt', 'category_base' => 'kategoria-produktu',
            'tag_base' => 'tag-produktu',
        ],
    ];

    private ?string $current = null;

    public function register(): void
    {
        add_filter('locale', [$this, 'filter_locale'], 1);
        add_filter('determine_locale', [$this, 'filter_locale'], 1);
        add_filter('language_attributes', [$this, 'filter_language_attributes']);
        add_filter('body_class', function (array $classes): array {
            $classes[] = 'jamu-lang-' . sanitize_html_class($this->current());
            return $classes;
        });
    }

    public function all(): array
    {
        return self::CONFIG;
    }

    public function additional(): array
    {
        return array_diff_key(self::CONFIG, [self::DEFAULT => true]);
    }

    public function get(string $language): array
    {
        return self::CONFIG[$language] ?? self::CONFIG[self::DEFAULT];
    }

    public function current(): string
    {
        if ($this->current !== null) {
            return $this->current;
        }

        $requested = isset($GLOBALS['wp_query']) ? get_query_var('jamu_lang') : '';
        if (is_string($requested) && isset(self::CONFIG[$requested])) {
            return $this->current = $requested;
        }

        $language = $this->language_from_path((string) ($_SERVER['REQUEST_URI'] ?? '/'));
        if ($language !== '') {
            return $this->current = $language;
        }

        $language = $this->context_language();
        if ($language !== '') {
            return $this->current = $language;
        }

        return $this->current = self::DEFAULT;
    }

    public function set_current(string $language): void
    {
        if (isset(self::CONFIG[$language])) {
            $this->current = $language;
        }
    }

    public function filter_locale(string $locale): string
    {
        if ($this->should_localize_request()) {
            return self::CONFIG[$this->current()]['locale'];
        }
        return $locale;
    }

    public function filter_language_attributes(string $output): string
    {
        if (!$this->should_localize_request()) {
            return $output;
        }
        $lang = esc_attr($this->current());
        if (preg_match('/lang=(?:"[^"]*"|\'[^\']*\')/i', $output)) {
            return (string) preg_replace('/lang=(?:"[^"]*"|\'[^\']*\')/i', 'lang="' . $lang . '"', $output);
        }
        return 'lang="' . $lang . '" ' . $output;
    }

    public function should_localize_request(): bool
    {
        if (wp_doing_cron()) {
            return false;
        }
        if (is_admin() && !wp_doing_ajax()) {
            return false;
        }
        return true;
    }

    private function context_language(): string
    {
        $request_path = trim((string) wp_parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH), '/');
        $is_context_request = wp_doing_ajax()
            || (defined('REST_REQUEST') && REST_REQUEST)
            || str_starts_with($request_path, 'wp-json/')
            || str_contains($request_path, '/wp-json/')
            || isset($_GET['wc-ajax']);

        if (!$is_context_request) {
            return '';
        }

        $referer = (string) ($_SERVER['HTTP_REFERER'] ?? '');
        if ($referer !== '' && $this->is_same_site_url($referer)) {
            $language = $this->language_from_path($referer);
            if ($language !== '') {
                return $language;
            }
            return '';
        }

        $cookie = sanitize_key((string) ($_COOKIE['jamu_lang'] ?? ''));
        return isset(self::CONFIG[$cookie]) && $cookie !== self::DEFAULT ? $cookie : '';
    }

    private function language_from_path(string $url_or_path): string
    {
        $path = wp_parse_url($url_or_path, PHP_URL_PATH);
        if (!is_string($path)) {
            $path = $url_or_path;
        }

        $path = trim($path, '/');
        $first = strtok($path, '/') ?: '';
        return isset(self::CONFIG[$first]) && $first !== self::DEFAULT ? $first : '';
    }

    private function is_same_site_url(string $url): bool
    {
        $parts = wp_parse_url($url);
        if (!is_array($parts)) {
            return false;
        }

        $host = strtolower((string) ($parts['host'] ?? ''));
        if ($host === '') {
            return true;
        }

        $home = wp_parse_url(home_url('/'));
        $site_host = strtolower((string) ($home['host'] ?? ''));
        return $site_host !== '' && ($host === $site_host || $host === 'www.' . $site_host);
    }
}
