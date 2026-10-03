<?php

namespace Jamu\Multilingual;

defined('ABSPATH') || exit;

/**
 * Small integration points for the host's existing WP-Optimize cache.
 *
 * WP-Optimize reads cache cookie names from its persisted configuration before
 * normal plugins are loaded. Registering this filter means the currency cookie
 * is stored in that configuration when caching is enabled, so a cached PLN
 * page can never be served to a visitor who selected EUR (or vice versa).
 */
final class Performance
{
    public const CURRENCY_COOKIE = 'yay_currency_widget';

    public function register(): void
    {
        add_filter('wpo_cache_cookies', [$this, 'cache_cookies'], 20, 2);
    }

    /**
     * @param array<int, mixed> $cookies
     * @param array<string, mixed> $config
     * @return array<int, string>
     */
    public function cache_cookies(array $cookies, array $config = []): array
    {
        $cookies[] = self::CURRENCY_COOKIE;

        $cookies = array_filter($cookies, static fn (mixed $cookie): bool => is_string($cookie) && $cookie !== '');
        return array_values(array_unique($cookies));
    }
}
