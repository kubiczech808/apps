<?php

namespace Jamu\Multilingual;

defined('ABSPATH') || exit;

final class Plugin
{
    private static ?self $instance = null;
    private bool $booted = false;

    public static function instance(): self
    {
        return self::$instance ??= new self();
    }

    public function boot(): void
    {
        if ($this->booted) {
            return;
        }
        $this->booted = true;

        $repository = new Repository();
        $languages = new Languages();
        $router = new Router($repository, $languages);

        $languages->register();
        $router->register();
        (new Content($repository, $languages, $router))->register();
        (new Seo($repository, $languages, $router))->register();
        (new Sitemap($repository, $languages, $router))->register();
        (new Shortcode($repository, $languages, $router))->register();
        (new Currency($languages))->register();
        (new Shipping($languages))->register();
        (new Email($languages))->register();

        if (is_admin()) {
            (new Admin($repository, $languages, $router))->register();
        }

        add_action('init', static function (): void {
            load_plugin_textdomain('jamu-multilingual', false, dirname(plugin_basename(JAMU_ML_FILE)) . '/languages');
        });
    }
}
