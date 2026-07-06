<?php

namespace Jamu\Multilingual;

defined('ABSPATH') || exit;

final class Installer
{
    public static function activate(): void
    {
        global $wpdb;

        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        $table = $wpdb->prefix . 'jamu_translations';
        $charset = $wpdb->get_charset_collate();

        $sql = "CREATE TABLE {$table} (
            id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
            object_type varchar(32) NOT NULL,
            object_subtype varchar(64) NOT NULL DEFAULT '',
            object_id bigint(20) unsigned NOT NULL,
            language varchar(5) NOT NULL,
            route_path varchar(255) NOT NULL DEFAULT '',
            slug varchar(200) NOT NULL DEFAULT '',
            title longtext NULL,
            excerpt longtext NULL,
            content longtext NULL,
            seo_title text NULL,
            meta_description text NULL,
            data longtext NULL,
            status varchar(20) NOT NULL DEFAULT 'draft',
            updated_at datetime NOT NULL,
            PRIMARY KEY  (id),
            UNIQUE KEY object_language (object_type,object_id,language),
            KEY route_lookup (language,object_type,object_subtype,route_path(160)),
            KEY status_language (status,language)
        ) {$charset};";

        dbDelta($sql);
        update_option('jamu_ml_db_version', JAMU_ML_VERSION, false);

        if (get_option('jamu_ml_settings', null) === null) {
            add_option('jamu_ml_settings', [
                'fallback' => 'source',
                'hide_untranslated_archives' => '0',
            ], '', false);
        }

        (new Router(new Repository(), new Languages()))->add_rewrite_rules();
        flush_rewrite_rules(false);
    }

    public static function deactivate(): void
    {
        flush_rewrite_rules(false);
    }
}

