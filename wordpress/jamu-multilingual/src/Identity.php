<?php

namespace Jamu\Multilingual;

defined('ABSPATH') || exit;

final class Identity
{
    public static function stable_id(string $key): int
    {
        return (int) hexdec(substr(hash('sha256', $key), 0, 15));
    }
}

