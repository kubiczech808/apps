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

        $path = trim((string) wp_parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH), '/');
        $first = strtok($path, '/') ?: '';
        return $this->current = isset(self::CONFIG[$first]) && $first !== self::DEFAULT
            ? $first
            : self::DEFAULT;
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
}
