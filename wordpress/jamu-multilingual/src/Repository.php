<?php

namespace Jamu\Multilingual;

use WP_Error;

defined('ABSPATH') || exit;

final class Repository
{
    private array $cache = [];

    public function table(): string
    {
        global $wpdb;
        return $wpdb->prefix . 'jamu_translations';
    }

    public function get(string $object_type, int $object_id, string $language, bool $published_only = true): ?object
    {
        global $wpdb;
        $key = implode(':', [$object_type, $object_id, $language, (int) $published_only]);
        if (array_key_exists($key, $this->cache)) {
            return $this->cache[$key];
        }

        $status = $published_only ? " AND status = 'publish'" : '';
        $sql = $wpdb->prepare(
            "SELECT * FROM {$this->table()} WHERE object_type = %s AND object_id = %d AND language = %s{$status} LIMIT 1",
            $object_type,
            $object_id,
            $language
        );
        $row = $wpdb->get_row($sql);
        if ($row && is_string($row->data)) {
            $row->data_decoded = json_decode($row->data, true) ?: [];
        }
        return $this->cache[$key] = $row ?: null;
    }

    public function translations(string $object_type, int $object_id, bool $published_only = true): array
    {
        global $wpdb;
        $status = $published_only ? " AND status = 'publish'" : '';
        $rows = $wpdb->get_results($wpdb->prepare(
            "SELECT * FROM {$this->table()} WHERE object_type = %s AND object_id = %d{$status}",
            $object_type,
            $object_id
        ));
        $result = [];
        foreach ($rows as $row) {
            $row->data_decoded = json_decode((string) $row->data, true) ?: [];
            $result[$row->language] = $row;
        }
        return $result;
    }

    public function find_route(string $language, string $object_type, string $subtype, string $route_path): ?object
    {
        global $wpdb;
        $route_path = trim(rawurldecode($route_path), '/');
        $sql = $wpdb->prepare(
            "SELECT * FROM {$this->table()} WHERE language = %s AND object_type = %s AND object_subtype = %s AND route_path = %s AND status = 'publish' LIMIT 1",
            $language,
            $object_type,
            $subtype,
            $route_path
        );
        return $wpdb->get_row($sql) ?: null;
    }

    public function find_content_route(string $language, string $route_path): ?object
    {
        global $wpdb;
        $sql = $wpdb->prepare(
            "SELECT * FROM {$this->table()} WHERE language = %s AND object_type = 'post' AND route_path = %s AND status = 'publish' LIMIT 1",
            $language,
            trim(rawurldecode($route_path), '/')
        );
        return $wpdb->get_row($sql) ?: null;
    }

    public function save(array $input): bool|WP_Error
    {
        global $wpdb;

        $defaults = [
            'object_type' => 'post', 'object_subtype' => '', 'object_id' => 0,
            'language' => '', 'route_path' => '', 'slug' => '', 'title' => '',
            'excerpt' => '', 'content' => '', 'seo_title' => '',
            'meta_description' => '', 'data' => [], 'status' => 'draft',
        ];
        $data = wp_parse_args($input, $defaults);
        $data['object_type'] = sanitize_key($data['object_type']);
        $data['object_subtype'] = sanitize_key($data['object_subtype']);
        $data['object_id'] = absint($data['object_id']);
        $data['language'] = sanitize_key($data['language']);
        $data['route_path'] = $this->sanitize_route((string) $data['route_path']);
        $data['slug'] = sanitize_title((string) ($data['slug'] ?: basename($data['route_path'])));
        $data['status'] = $data['status'] === 'publish' ? 'publish' : 'draft';
        $data['data'] = wp_json_encode(is_array($data['data']) ? $data['data'] : []);
        $data['updated_at'] = current_time('mysql', true);

        if (!$data['object_id'] || !in_array($data['language'], ['en', 'de', 'pl'], true)) {
            return new WP_Error('jamu_invalid_translation', __('Invalid translation object or language.', 'jamu-multilingual'));
        }

        if ($data['status'] === 'publish' && $data['route_path'] !== '') {
            $conflict = $wpdb->get_var($wpdb->prepare(
                "SELECT object_id FROM {$this->table()} WHERE language = %s AND object_type = %s AND object_subtype = %s AND route_path = %s AND object_id != %d AND status = 'publish' LIMIT 1",
                $data['language'],
                $data['object_type'],
                $data['object_subtype'],
                $data['route_path'],
                $data['object_id']
            ));
            if ($conflict) {
                return new WP_Error('jamu_duplicate_route', __('This localized URL is already used.', 'jamu-multilingual'));
            }
        }

        $existing = $this->get($data['object_type'], $data['object_id'], $data['language'], false);
        $formats = ['%s', '%s', '%d', '%s', '%s', '%s', '%s', '%s', '%s', '%s', '%s', '%s', '%s', '%s'];
        if ($existing) {
            $ok = $wpdb->update($this->table(), $data, ['id' => (int) $existing->id], $formats, ['%d']);
        } else {
            $ok = $wpdb->insert($this->table(), $data, $formats);
        }
        $this->cache = [];
        return $ok !== false;
    }

    public function all_published(): array
    {
        global $wpdb;
        return $wpdb->get_results("SELECT * FROM {$this->table()} WHERE status = 'publish' ORDER BY object_type, object_id, language") ?: [];
    }

    private function sanitize_route(string $route): string
    {
        $parts = array_filter(explode('/', trim($route, '/')), 'strlen');
        return implode('/', array_map('sanitize_title', $parts));
    }
}
