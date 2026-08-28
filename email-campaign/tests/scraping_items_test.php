<?php
/**
 * Detail scrapingu nesmi nacitat vsechny polozky vsech behu - u kontejneru s desetitisici
 * URL to shodilo stranku na chybu 500. Pocty se ctou z databaze, do pameti jde jen jedna
 * stranka nejnovejsich polozek.
 */
$appFile = __DIR__ . '/../index.php';
$cssFile = __DIR__ . '/../assets/app.css';
$src = file_get_contents($appFile);
function extractFn(string $src, string $name): string
{
    $pos = strpos($src, "\nfunction " . $name . "(");
    if ($pos === false) { throw new RuntimeException('nenalezeno: ' . $name); }
    $next = strpos($src, "\nfunction ", $pos + 1);
    $body = $next === false ? substr($src, $pos) : substr($src, $pos, $next - $pos);
    $end = strrpos($body, '}');
    return $end === false ? $body : substr($body, 0, $end + 1);
}
preg_match('/const SCRAPING_ITEMS_PER_PAGE = (\d+);/', $src, $m);
eval('const SCRAPING_ITEMS_PER_PAGE = ' . $m[1] . ';');
eval(extractFn($src, 'scrapingItemsByJob'));
eval(extractFn($src, 'scrapingItemCountsByJob'));
eval(extractFn($src, 'scrapingItemGroups'));
eval(extractFn($src, 'scrapingGroupCounts'));

$pdo = new PDO('sqlite::memory:');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec('CREATE TABLE scraping_job_items (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INT, url TEXT,
    status TEXT, email TEXT DEFAULT "", subject_name TEXT DEFAULT "", website TEXT DEFAULT "",
    address TEXT DEFAULT "", message TEXT DEFAULT "", created_at TEXT DEFAULT "", processed_at TEXT DEFAULT "")');
$ins = $pdo->prepare('INSERT INTO scraping_job_items (job_id, url, status, email, subject_name) VALUES (?,?,?,?,?)');
// Beh #10: velky kontejner. 4000 polozek, z toho 1200 vlozenych, 300 aktualizovanych,
// 2000 preskocenych, 300 jeste nezpracovanych.
$plan = array_merge(
    array_fill(0, 1200, 'inserted'),
    array_fill(0, 300, 'updated'),
    array_fill(0, 1500, 'skipped'),
    array_fill(0, 500, 'failed'),
    array_fill(0, 500, 'queued')
);
$pdo->beginTransaction();
foreach ($plan as $i => $status) {
    $ins->execute([10, 'https://x.cz/' . $i, $status, 'a' . $i . '@x.cz', 'Firma ' . $i]);
}
// Beh #11: maly kontejner.
for ($i = 0; $i < 7; $i++) {
    $ins->execute([11, 'https://y.cz/' . $i, 'inserted', 'b' . $i . '@y.cz', 'Mala firma ' . $i]);
}
$pdo->commit();
$total10 = (int)$pdo->query('SELECT COUNT(*) FROM scraping_job_items WHERE job_id=10')->fetchColumn();

echo "== 1. do pameti jde jen stranka, ne cely beh ==\n";
$items = scrapingItemsByJob($pdo, [10, 11]);
printf("  beh #10 ma %d polozek, nacteno %d; beh #11 ma 7, nacteno %d\n",
    $total10, count($items[10]), count($items[11]));
assert(count($items[10]) === SCRAPING_ITEMS_PER_PAGE, 'nacita se jen stranka, mam ' . count($items[10]));
assert(count($items[11]) === 7, 'maly beh se vejde cely');
assert((int)$items[10][0]['id'] > (int)$items[10][1]['id'], 'od nejnovejsi');
// Jen sloupce, ktere detail vypisuje - zadne SELECT *.
$columns = array_keys($items[10][0]);
sort($columns);
printf("  sloupce: %s\n", implode(', ', $columns));
assert(!in_array('website', $columns, true) && !in_array('created_at', $columns, true),
    'nepotrebne sloupce se netahaji');
assert(strpos(extractFn($src, 'scrapingItemsByJob'), 'SELECT *') === false, 'zadne SELECT *');

echo "\n== 2. pocty se ctou z databaze ==\n";
$counts = scrapingItemCountsByJob($pdo, [10, 11]);
printf("  #10: zpracovano %d, vlozeno %d, aktualizovano %d, preskoceno %d, polozek celkem %d\n",
    $counts[10]['processed'], $counts[10]['inserted'], $counts[10]['updated'], $counts[10]['skipped'], $counts[10]['items']);
assert($counts[10]['inserted'] === 1200, 'vlozene');
assert($counts[10]['updated'] === 300, 'aktualizovane');
assert($counts[10]['skipped'] === 2000, 'preskocene vcetne failed, mam ' . $counts[10]['skipped']);
assert($counts[10]['processed'] === 3500, 'nezpracovane queued se nepocitaji, mam ' . $counts[10]['processed']);
assert($counts[10]['items'] === $total10, 'celkovy pocet polozek');
assert($counts[11]['inserted'] === 7);
// Stejna pravidla jako pri seskupeni vzorku.
$sampleGroups = scrapingGroupCounts(scrapingItemGroups($items[11]));
assert($sampleGroups['inserted'] === $counts[11]['inserted'], 'u maleho behu musi cisla souhlasit');

echo "\n== 3. strankovani jednoho behu ==\n";
$page2 = scrapingItemsByJob($pdo, [10, 11], SCRAPING_ITEMS_PER_PAGE, 10, 2);
printf("  #10 stranka 2: %d polozek, prvni id %d (stranka 1 mela prvni id %d)\n",
    count($page2[10]), (int)$page2[10][0]['id'], (int)$items[10][0]['id']);
assert(count($page2[10]) === SCRAPING_ITEMS_PER_PAGE, 'druha stranka je plna');
assert((int)$page2[10][0]['id'] < (int)$items[10][0]['id'], 'druha stranka je starsi');
$ids1 = array_column($items[10], 'id');
$ids2 = array_column($page2[10], 'id');
assert(array_intersect($ids1, $ids2) === [], 'stranky se neprekryvaji');
// Ostatni behy zustavaji na prvni strance.
assert(count($page2[11]) === 7, 'strankovani se tyka jen vybraneho behu');
$last = (int)ceil($total10 / SCRAPING_ITEMS_PER_PAGE);
$beyond = scrapingItemsByJob($pdo, [10], SCRAPING_ITEMS_PER_PAGE, 10, $last + 5);
printf("  za poslednim strankou (%d): %d polozek\n", $last, count($beyond[10] ?? []));
assert(($beyond[10] ?? []) === [], 'za koncem uz nic neni a nic nespadne');

echo "\n== 4. UI vypisuje cisla z databaze, ne z vzorku ==\n";
$route = substr($src, strpos($src, "\$scrapingItemsByJob = scrapingItemsByJob("), 600);
assert(strpos($route, 'SCRAPING_ITEMS_PER_PAGE') !== false, 'route pouziva stranku');
assert(strpos($src, "\$jobDisplayCounts = \$scrapingItemCounts[(int)\$job['id']]") !== false,
    'radek behu bere cisla z DB');
assert(strpos($src, 'Zobrazeno <?= h((string)count($jobItems)) ?> z') !== false, 'UI rekne, kolik z kolika vidime');
assert(strpos($src, 'scraping-items-pager') !== false, 'strankovani je v UI');
echo "  ok\n";

echo "\n== 5. cislovani zaznamu v AI research ==\n";
assert(strpos($src, '$researchRowNumber++') !== false, 'poradove cislo se pocita');
assert(strpos($src, 'class="research-number-col"') !== false, 'cislo ma vlastni sloupec');
assert(strpos($src, '$researchColumnCount = 11 + count($researchStepColumns);') !== false,
    'colspan detailu pocita i se sloupcem cisla');
$css = file_get_contents($cssFile);
assert(strpos($css, '.research-table > thead > tr > th:nth-child(1) { width: 44px; }') !== false, 'sloupec cisla ma sirku');
preg_match_all('/\.view-research \.research-table > thead > tr > th:nth-child\((\d+)\) \{ width: (\d+)px; \}/', $css, $w, PREG_SET_ORDER);
$sum = 0;
foreach ($w as $row) { $sum += (int)$row[2]; }
preg_match('/\.research-step-col \{ width: (\d+)px/', $css, $sm);
$sum += 7 * (int)$sm[1];
preg_match('/\.view-research \.research-table \{[^}]*min-width: (\d+)px/s', $css, $mw);
printf("  soucet sirek %d px, min-width %d px\n", $sum, (int)$mw[1]);
assert($sum === (int)$mw[1], 'min-width musi odpovidat souctu sirek');

echo "\nVSE OK\n";
