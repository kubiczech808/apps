<?php
/**
 * Plugin Name: JAMU Multilingual SEO
 * Description: Lightweight multilingual content and SEO layer for WordPress and WooCommerce.
 * Version: 0.1.0
 * Author: Tajemství JAMU
 * Requires at least: 6.5
 * Requires PHP: 8.1
 * Text Domain: jamu-multilingual
 */

defined('ABSPATH') || exit;

define('JAMU_ML_VERSION', '0.1.0');
define('JAMU_ML_FILE', __FILE__);
define('JAMU_ML_DIR', plugin_dir_path(__FILE__));

spl_autoload_register(static function (string $class): void {
    $prefix = 'Jamu\\Multilingual\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }

    $relative = substr($class, strlen($prefix));
    $file = JAMU_ML_DIR . 'src/' . str_replace('\\', '/', $relative) . '.php';
    if (is_readable($file)) {
        require_once $file;
    }
});

register_activation_hook(__FILE__, ['Jamu\\Multilingual\\Installer', 'activate']);
register_deactivation_hook(__FILE__, ['Jamu\\Multilingual\\Installer', 'deactivate']);

add_action('plugins_loaded', static function (): void {
    Jamu\Multilingual\Plugin::instance()->boot();
}, 1);

