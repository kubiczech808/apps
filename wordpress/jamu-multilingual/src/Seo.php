<?php

namespace Jamu\Multilingual;

use WP_Post;
use WP_Term;

defined('ABSPATH') || exit;

final class Seo
{
    public function __construct(
        private Repository $repository,
        private Languages $languages,
        private Router $router
    ) {
    }

    public function register(): void
    {
        add_action('wp_head', [$this, 'head'], 2);
        add_filter('wp_robots', [$this, 'robots']);
        add_filter('pre_get_document_title', [$this, 'document_title'], 20);

        add_filter('wpseo_canonical', [$this, 'canonical']);
        add_filter('wpseo_title', [$this, 'seo_title']);
        add_filter('wpseo_metadesc', [$this, 'meta_description']);
        add_filter('wpseo_robots_array', [$this, 'yoast_robots']);
    }

    public function head(): void
    {
        if ($this->languages->current() === Languages::DEFAULT && !$this->object_context()) {
            return;
        }

        $context = $this->object_context();
        if (!$context) {
            return;
        }

        if (!defined('WPSEO_VERSION')) {
            $canonical = $this->context_url($context, $this->languages->current());
            if ($canonical) {
                printf("\n<link rel=\"canonical\" href=\"%s\" />\n", esc_url($canonical));
            }
            $description = $this->translated_field('meta_description');
            if ($description) {
                printf("<meta name=\"description\" content=\"%s\" />\n", esc_attr($description));
            }
        }

        foreach ($this->alternate_urls($context) as $language => $url) {
            printf(
                "<link rel=\"alternate\" hreflang=\"%s\" href=\"%s\" />\n",
                esc_attr($language),
                esc_url($url)
            );
        }
    }

    public function robots(array $robots): array
    {
        if ($this->is_missing_translation()) {
            $robots['noindex'] = true;
            unset($robots['index']);
        }
        return $robots;
    }

    public function yoast_robots(array $robots): array
    {
        if ($this->is_missing_translation()) {
            $robots['index'] = 'noindex';
        }
        return $robots;
    }

    public function canonical(string $canonical): string
    {
        $context = $this->object_context();
        if (!$context) {
            return $canonical;
        }
        return $this->context_url($context, $this->languages->current()) ?: $canonical;
    }

    public function document_title(string $title): string
    {
        return $this->seo_title($title);
    }

    public function seo_title(string $title): string
    {
        return $this->translated_field('seo_title') ?: $this->translated_field('title') ?: $title;
    }

    public function meta_description(string $description): string
    {
        return $this->translated_field('meta_description') ?: $description;
    }

    private function alternate_urls(array $context): array
    {
        $urls = [];
        $default = $this->context_url($context, Languages::DEFAULT);
        if ($default) {
            $urls['cs'] = $default;
        }

        foreach (array_keys($this->languages->additional()) as $language) {
            $url = $this->context_url($context, $language, true);
            if ($url) {
                $urls[$language] = $url;
            }
        }
        if ($default) {
            $urls['x-default'] = $default;
        }
        return $urls;
    }

    private function object_context(): ?array
    {
        $object = get_queried_object();
        if ($object instanceof WP_Post) {
            return ['type' => 'post', 'id' => $object->ID, 'subtype' => $object->post_type];
        }
        if ($object instanceof WP_Term && in_array($object->taxonomy, ['product_cat', 'product_tag'], true)) {
            return ['type' => 'term', 'id' => $object->term_id, 'subtype' => $object->taxonomy];
        }
        return null;
    }

    private function context_url(array $context, string $language, bool $require_translation = false): string
    {
        if ($context['type'] === 'post') {
            return $this->router->localized_post_url($context['id'], $language, $require_translation);
        }
        return $this->router->localized_term_url($context['id'], $context['subtype'], $language, $require_translation);
    }

    private function translated_field(string $field): string
    {
        $language = $this->languages->current();
        if ($language === Languages::DEFAULT) {
            return '';
        }
        $context = $this->object_context();
        if (!$context) {
            return '';
        }
        $translation = $this->repository->get($context['type'], $context['id'], $language);
        return $translation && isset($translation->{$field}) ? (string) $translation->{$field} : '';
    }

    private function is_missing_translation(): bool
    {
        if ($this->languages->current() === Languages::DEFAULT) {
            return false;
        }
        if ((int) get_query_var('jamu_missing_translation') === 1) {
            return true;
        }
        $context = $this->object_context();
        return $context
            && !$this->repository->get($context['type'], $context['id'], $this->languages->current());
    }
}

