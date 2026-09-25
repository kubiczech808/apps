<?php

$src = file_get_contents(__DIR__ . '/../index.php');
$start = strpos($src, "\nfunction appBaseUrl(");
if ($start === false) {
    throw new RuntimeException('Nenalezena funkce appBaseUrl.');
}
$end = strpos($src, "\nfunction ", $start + 1);
eval($end === false ? substr($src, $start) : substr($src, $start, $end - $start));

$originalServer = $_SERVER;
$_SERVER = [
    'HTTP_HOST' => 'www.osobnizkusenosti.cz',
    'REQUEST_URI' => '/email-campaign/?worker=scraping',
];
assert(appBaseUrl() === 'https://www.osobnizkusenosti.cz/email-campaign/');

$_SERVER = [
    'HTTP_HOST' => 'localhost:8080',
    'REQUEST_URI' => '/email-campaign/',
];
assert(appBaseUrl() === 'http://localhost:8080/email-campaign/');

$_SERVER = $originalServer;
echo "VSE OK\n";
