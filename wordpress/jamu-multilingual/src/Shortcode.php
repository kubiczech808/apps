<?php

namespace Jamu\Multilingual;

use WP_Post;
use WP_Term;

defined('ABSPATH') || exit;

final class Shortcode
{
    public function __construct(
        private Repository $repository,
        private Languages $languages,
        private Router $router
    ) {
    }

    public function register(): void
    {
        add_shortcode('jamu_language_switcher', [$this, 'render']);
    }

    public function render(array|string $attributes = []): string
    {
        $attributes = shortcode_atts(['show_names' => '1'], (array) $attributes, 'jamu_language_switcher');
        $object = get_queried_object();
        $items = [];

        foreach ($this->languages->all() as $language => $config) {
            $url = '';
            if ($object instanceof WP_Post) {
                $url = $this->router->localized_post_url($object, $language, $language !== Languages::DEFAULT);
            } elseif ($object instanceof WP_Term && in_array($object->taxonomy, ['product_cat', 'product_tag'], true)) {
                $url = $this->router->localized_term_url($object, $object->taxonomy, $language, $language !== Languages::DEFAULT);
            } elseif ($language === Languages::DEFAULT) {
                $url = home_url('/');
            } else {
                $front_id = (int) get_option('page_on_front');
                $url = $front_id ? $this->router->localized_post_url($front_id, $language, true) : '';
            }
            if (!$url) {
                continue;
            }

            $label = $attributes['show_names'] === '1' ? $config['label'] : strtoupper($language);
            $current = $language === $this->languages->current();
            $items[] = sprintf(
                '<li class="jamu-language-switcher__item%s"><a href="%s" hreflang="%s" lang="%s"%s>%s</a></li>',
                $current ? ' is-current' : '',
                esc_url($url),
                esc_attr($language),
                esc_attr($language),
                $current ? ' aria-current="page"' : '',
                esc_html($label)
            );
        }

        return '<nav class="jamu-language-switcher" aria-label="' . esc_attr__('Language', 'jamu-multilingual') . '"><ul>'
            . implode('', $items)
            . '</ul></nav>';
    }
}
