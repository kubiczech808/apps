<?php

$source = file_get_contents(__DIR__ . '/../index.php');
if ($source === false) {
    throw new RuntimeException('Nelze nacist index.php.');
}

function expectAllbizRetirement(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

expectAllbizRetirement(!str_contains($source, "'allbiz_us' => 'AllBiz.com (USA)'"), 'AllBiz nesmi byt v aktivnich zdrojich.');
expectAllbizRetirement(!str_contains($source, 'function discoverAllbizScrapingState'), 'AllBiz worker nesmi zustat v aplikaci.');
expectAllbizRetirement(!str_contains($source, 'function extractAllbizCandidateUrls'), 'AllBiz parser nesmi zustat v aplikaci.');
expectAllbizRetirement(!str_contains($source, 'function allbizUsStates'), 'AllBiz volba statu nesmi zustat v aplikaci.');
expectAllbizRetirement(str_contains($source, 'function retireAllbizScraping'), 'Chybi bezpecne ukonceni starych AllBiz behu.');
expectAllbizRetirement(str_contains($source, 'AND j.source<>"allbiz_us"'), 'Stary AllBiz job nesmi projit worker frontou.');
expectAllbizRetirement(str_contains($source, 'function cleanupRetiredAllbizStorage'), 'Chybi cileny uklid AllBiz technickych dat.');
expectAllbizRetirement(str_contains($source, 'DELETE FROM scraping_job_items WHERE id IN'), 'AllBiz crawl log se musi mazat po davkach.');
expectAllbizRetirement(str_contains($source, 'OPTIMIZE TABLE '), 'Po smazani AllBiz logu musi probehnout fyzicke uvolneni mista.');
expectAllbizRetirement(str_contains($source, 'recipients_preserved'), 'Uklid musi explicitne zachovat kontakty.');

echo "AllBiz retirement checks: OK\n";
