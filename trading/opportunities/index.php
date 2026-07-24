<?php
declare(strict_types=1);

$index = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'index.html';
if (!is_file($index)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Trading opportunities page is not available.';
    exit;
}

header('Content-Type: text/html; charset=utf-8');
readfile($index);
