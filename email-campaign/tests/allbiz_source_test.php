<?php

$src = file_get_contents(__DIR__ . '/../index.php');

function extractAllbizFn(string $src, string $name): string
{
    $start = strpos($src, "\nfunction " . $name . "(");
    if ($start === false) {
        throw new RuntimeException('Nenalezena funkce: ' . $name);
    }
    $end = strpos($src, "\nfunction ", $start + 1);
    return $end === false ? substr($src, $start) : substr($src, $start, $end - $start);
}

eval(extractAllbizFn($src, 'aiResearchFoldText'));
eval(extractAllbizFn($src, 'normalizeScrapingKeyword'));
eval(extractAllbizFn($src, 'allbizUsStates'));
eval(extractAllbizFn($src, 'allbizNormalizeState'));
eval(extractAllbizFn($src, 'allbizSearchUrl'));
eval(extractAllbizFn($src, 'normalizeAllbizDetailUrl'));

echo "== AllBiz USA zdroj ==\n";
$states = allbizUsStates();
assert(count($states) === 51, 'musi obsahovat 50 statu a Washington, D.C.');
assert(allbizNormalizeState('Alabama') === 'AL');
assert(allbizNormalizeState('US_AL') === 'AL');
assert(allbizNormalizeState('dc') === 'DC');
assert(allbizNormalizeState('neexistujici') === '');

$url = allbizSearchUrl('massage', 'AL');
assert($url === 'https://www.allbiz.com/search?ss=massage&ia=US_AL');
assert(normalizeAllbizDetailUrl('https://www.allbiz.com/business/massage_962J-251-990-4770?ref=test') === 'https://www.allbiz.com/business/massage_962J-251-990-4770');
assert(normalizeAllbizDetailUrl('https://www.bizarchive.com/business/foot-massage_92R-205-978-0008') === 'https://www.bizarchive.com/business/foot-massage_92R-205-978-0008');
assert(normalizeAllbizDetailUrl('https://www.allbiz.com/search?ss=massage&ia=US_AL') === '');
assert(str_contains($src, "'allbiz_us' => 'AllBiz.com (USA)'") && str_contains($src, 'discoverAllbizScrapingState'), 'zdroj je aktivni a ma vlastni kurzor');

$database = file_get_contents(__DIR__ . '/../src/Database.php');
assert(str_contains($database, "'scraping_jobs', 'source_cursor'"), 'migrace musi ulozit kurzor behu');
echo "VSE OK\n";
