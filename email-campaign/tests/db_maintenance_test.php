<?php
/**
 * Uklid databaze. Databaze rostla bez omezeni, protoze crawl log ani provozni log se
 * nikdy nemazaly a dokonceny beh za sebou nechaval celou nezpracovanou frontu URL.
 *
 * Test hlida hlavne to, oc uzivateli slo: uklid nesmi pripravit o kontakty. Maze jen
 * radky "tato URL byla otevrena s timto vysledkem" a historii tiku; kontakty v
 * recipients, jejich databaze i ucty zustavaji - a to i pri uplnem vynulovani AI
 * research dat.
 */
$appFile = __DIR__ . '/../index.php';
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
foreach (['DB_SCRAPING_ITEM_RETENTION_DAYS', 'DB_IMPORT_RAW_RETENTION_DAYS', 'DB_AI_RESEARCH_LOG_KEEP_ROWS', 'DB_CLEANUP_BATCH_ROWS'] as $const) {
    preg_match('/const ' . $const . ' = (\d+);/', $src, $m);
    assert(isset($m[1]), 'konstanta chybi: ' . $const);
    eval('const ' . $const . ' = ' . $m[1] . ';');
}
const AI_RESEARCH_ALLOWED_EMAIL = 'admin@example.cz';
$SETTINGS = [];
function loadSettings(PDO $pdo): array { global $SETTINGS; return $SETTINGS; }
function setSetting(PDO $pdo, string $key, string $value): void { global $SETTINGS; $SETTINGS[$key] = $value; }
function isMysql(PDO $pdo): bool { return false; }
function tableExists(PDO $pdo, string $table): bool
{
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM sqlite_master WHERE type="table" AND name=?');
    $stmt->execute([$table]);
    return (int)$stmt->fetchColumn() > 0;
}
function recentNoEmailScrapingCacheDays(string $source): int
{
    return ['dasoertliche_de' => 30, 'dastelefonbuch_de' => 21][$source] ?? 14;
}
foreach (['protectedContactOwnerEmails', 'databaseCleanupTables', 'formatBytesHuman',
          'scrapingItemRetentionCutoff', 'scrapingItemPruneWatermark', 'scrapingItemPruneItemCondition',
          'scrapingJobsWithPrunableItems', 'countPrunableScrapingItems', 'pruneScrapingJobItems',
          'importItemRawWatermark', 'importItemRawRetentionCutoff', 'importRunsWithPrunableRaw',
          'countPrunableImportItemRaw', 'pruneImportItemRawData', 'countPrunableAiResearchLogs', 'pruneAiResearchLogs',
          'countExpiredAppSessions', 'pruneExpiredAppSessions', 'countAiResearchRunsWithCache',
          'stripAiResearchRunCaches', 'databaseCleanupEstimate', 'runDatabaseCleanupBatch',
          'quoteDatabaseIdentifier', 'resetAiResearchData', 'countRecipientsForOwnerEmail',
          'scrapingDiscoveryBuffer', 'scrapingDiscoveryBufferForJob'] as $fn) {
    eval(extractFn($src, $fn));
}

function freshDb(): PDO
{
    $db = new PDO('sqlite::memory:');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec('CREATE TABLE scraping_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT DEFAULT "finished",
        discovered_count INTEGER DEFAULT 0, list_id INTEGER DEFAULT 1, source TEXT DEFAULT "firmy_cz",
        updated_at TEXT DEFAULT "", finished_at TEXT DEFAULT "")');
    $db->exec('CREATE TABLE scraping_job_items (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER,
        url TEXT DEFAULT "", status TEXT DEFAULT "queued", email TEXT DEFAULT "",
        created_at TEXT DEFAULT "", processed_at TEXT DEFAULT "")');
    $db->exec('CREATE TABLE ai_research_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT DEFAULT "done",
        message TEXT DEFAULT "", created_at TEXT DEFAULT "")');
    $db->exec('CREATE TABLE ai_research_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT DEFAULT "done",
        plan_json TEXT DEFAULT "{}")');
    $db->exec('CREATE TABLE ai_research_contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER)');
    $db->exec('CREATE TABLE app_sessions (id TEXT PRIMARY KEY, data BLOB, updated_at INTEGER, expires_at INTEGER)');
    $db->exec('CREATE TABLE import_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, finished_at TEXT DEFAULT "")');
    $db->exec('CREATE TABLE import_run_items (id INTEGER PRIMARY KEY AUTOINCREMENT, import_run_id INTEGER,
        result TEXT DEFAULT "inserted", reason TEXT DEFAULT "", email TEXT DEFAULT "", raw_data TEXT DEFAULT "",
        row_num INTEGER DEFAULT 0)');
    $db->exec('CREATE TABLE app_users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT)');
    $db->exec('CREATE TABLE contact_databases (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER, name TEXT)');
    $db->exec('CREATE TABLE recipients (id INTEGER PRIMARY KEY AUTOINCREMENT, list_id INTEGER, email TEXT)');
    return $db;
}
function addItem(PDO $db, int $jobId, string $status, string $email, string $when): int
{
    $stmt = $db->prepare('INSERT INTO scraping_job_items (job_id, url, status, email, created_at, processed_at) VALUES (?,?,?,?,?,?)');
    $stmt->execute([$jobId, 'https://firmy.cz/detail/' . random_int(1, 1000000), $status, $email, $when, $status === 'queued' ? '' : $when]);
    return (int)$db->lastInsertId();
}
$old = date('c', time() - 90 * 86400);
$fresh = date('c', time() - 2 * 86400);

echo "== 1. crawl log behu dokonceneho pred retencnim oknem se maze cely ==\n";
// O smazani rozhoduje, kdy skoncil beh - ne jednotlivy radek. Kdyz beh skoncil pred
// vic nez retencnim oknem, jeho crawl log uz nikdo nepotrebuje a jde pryc naraz.
$db = freshDb();
$db->prepare('INSERT INTO scraping_jobs (status, finished_at) VALUES ("finished", ?)')->execute([$old]);
addItem($db, 1, 'skipped', '', $old);
addItem($db, 1, 'skipped', '', $old);
addItem($db, 1, 'inserted', '', $old);
printf("  ke smazani: %d ze 3\n", countPrunableScrapingItems($db));
assert(countPrunableScrapingItems($db) === 3, 'cely crawl log stareho behu jde pryc');
assert(pruneScrapingJobItems($db, 100) === 3, 'a smaze se');
assert((int)$db->query('SELECT COUNT(*) FROM scraping_job_items')->fetchColumn() === 0, 'tabulka je prazdna');
// A uklid se k uz uklizenemu behu nevraci porad dokola.
assert(scrapingJobsWithPrunableItems($db, 10, 0) === [], 'uklizeny beh uz uklid nezdrzuje');

echo "\n== 1b. nedavno dokonceny beh si crawl log nechava ==\n";
$db = freshDb();
$db->prepare('INSERT INTO scraping_jobs (status, finished_at) VALUES ("finished", ?)')->execute([$fresh]);
addItem($db, 1, 'skipped', '', $fresh);
printf("  ke smazani: %d z 1\n", countPrunableScrapingItems($db));
assert(countPrunableScrapingItems($db) === 0, 'cache URL bez e-mailu musi zustat funkcni');

echo "\n== 2. retencni okno je nad cache URL bez e-mailu ==\n";
$maxCache = 0;
foreach (['firmy_cz', 'dasoertliche_de', 'dastelefonbuch_de'] as $source) {
    $maxCache = max($maxCache, recentNoEmailScrapingCacheDays($source));
}
printf("  okno %d dnu, nejdelsi cache %d dnu\n", DB_SCRAPING_ITEM_RETENTION_DAYS, $maxCache);
assert(DB_SCRAPING_ITEM_RETENTION_DAYS > $maxCache,
    'kratsi okno by nutilo scraper chodit na stejne URL znovu, tedy platit misto requesty');

echo "\n== 3. bezici beh a jeho fronta se uklidu nedotknou ==\n";
$db = freshDb();
$db->prepare('INSERT INTO scraping_jobs (status, finished_at) VALUES ("running", ?)')->execute(['']);
addItem($db, 1, 'queued', '', $old);
addItem($db, 1, 'skipped', '', $old);
printf("  ke smazani u beziciho behu: %d\n", countPrunableScrapingItems($db));
assert(countPrunableScrapingItems($db) === 0, 'aktivni prace se mazat nesmi');

echo "\n== 4. uspesny radek se nemaze, dokud z nej backfill nedopsal zdroj ==\n";
$db = freshDb();
$db->prepare('INSERT INTO scraping_jobs (status, finished_at) VALUES ("finished", ?)')->execute([$old]);
$done = addItem($db, 1, 'inserted', 'kontakt@firma.cz', $old);
$later = addItem($db, 1, 'inserted', 'druhy@firma.cz', $old);
$SETTINGS = ['recipient_source_backfill_scraping_item_id' => (string)$done];
printf("  vodoznak backfillu #%d -> ke smazani %d z 2\n", $done, countPrunableScrapingItems($db));
assert(countPrunableScrapingItems($db) === 1, 'jen radek, ktery backfill uz zpracoval');
assert(pruneScrapingJobItems($db, 100) === 1, 'a smaze se prave on');
$SETTINGS = [];

echo "\n== 4b. surova kopie radku u starych importu se vyprazdni, vysledek zustava ==\n";
// import_run_items je druha nejvetsi tabulka: kazdy nascrapovany kontakt se loguje i
// jako radek importu s celou surovou radkou. Ta kopie uz nic nerozhoduje.
$db = freshDb();
$db->prepare('INSERT INTO import_runs (finished_at) VALUES (?)')->execute([$old]);
$db->prepare('INSERT INTO import_runs (finished_at) VALUES (?)')->execute([$fresh]);
$itemIns = $db->prepare('INSERT INTO import_run_items (import_run_id, result, reason, email, raw_data) VALUES (?,?,?,?,?)');
$itemIns->execute([1, 'skipped', 'bez e-mailu', '', '["Firma s.r.o.","https://firma.cz"]']);
$itemIns->execute([1, 'inserted', '', 'kontakt@firma.cz', '["Firma s.r.o.","kontakt@firma.cz"]']);
$itemIns->execute([2, 'skipped', 'bez e-mailu', '', '["Nova firma"]']);
// Vodoznak backfillu jeste nedosel k uspesnemu radku, takze ten musi zustat cely.
$SETTINGS = ['recipient_source_backfill_import_item_id' => '0'];
printf("  k vyprazdneni: %d ze 3\n", countPrunableImportItemRaw($db));
assert(countPrunableImportItemRaw($db) === 1, 'jen radek stareho importu, ktery backfill nepotrebuje');
assert(pruneImportItemRawData($db, 100) === 1, 'a vyprazdni se');
$rows = $db->query('SELECT id, result, reason, raw_data FROM import_run_items ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
assert($rows[0]['raw_data'] === '' && $rows[0]['result'] === 'skipped' && $rows[0]['reason'] === 'bez e-mailu',
    'vysledek a duvod radku zustavaji, mizi jen surova kopie');
assert($rows[1]['raw_data'] !== '', 'uspesny radek pred vodoznakem se nedotkne');
assert($rows[2]['raw_data'] !== '', 'nedavny import se nedotkne');
// Po posunu vodoznaku uz smi jit i uspesny radek.
$SETTINGS = ['recipient_source_backfill_import_item_id' => '2'];
assert(countPrunableImportItemRaw($db) === 1, 'za vodoznakem uz smi i uspesny radek');
$SETTINGS = [];

echo "\n== 5. provozni log se drzi na poslednich " . DB_AI_RESEARCH_LOG_KEEP_ROWS . " radcich ==\n";
$db = freshDb();
$ins = $db->prepare('INSERT INTO ai_research_logs (status, message, created_at) VALUES (?,?,?)');
for ($i = 0; $i < DB_AI_RESEARCH_LOG_KEEP_ROWS + 25; $i++) {
    $ins->execute(['done', 'tik ' . $i, $old]);
}
$ins->execute(['planned', 'naplanovany beh', $fresh]);
printf("  ke smazani: %d\n", countPrunableAiResearchLogs($db));
assert(countPrunableAiResearchLogs($db) === 25, 'nad strop jde 25 radku');
assert(pruneAiResearchLogs($db, 1000) === 25, 'a smazi se');
assert((int)$db->query('SELECT COUNT(*) FROM ai_research_logs WHERE status="planned"')->fetchColumn() === 1,
    'naplanovany radek zustava vzdy - je to jediny zaznam o tom, co se bude delat');

echo "\n== 6. z planu dokonceneho behu se zahodi text z webu, rozhodnuti zustavaji ==\n";
$db = freshDb();
$plan = ['website_context_cache' => str_repeat('text z webu ', 500), 'scraping_queries' => [['keyword' => 'stavebni firma']], 'business_understanding' => 'Zabezpeceni budov.'];
$db->prepare('INSERT INTO ai_research_runs (status, plan_json) VALUES ("done", ?)')->execute([json_encode($plan)]);
assert(countAiResearchRunsWithCache($db) === 1, 'beh s cache je videt');
assert(stripAiResearchRunCaches($db, 10) === 1, 'cache se zahodi');
$stored = json_decode((string)$db->query('SELECT plan_json FROM ai_research_runs WHERE id=1')->fetchColumn(), true);
printf("  po uklidu drzi plan: %s\n", implode(', ', array_keys($stored)));
assert(!isset($stored['website_context_cache']), 'text z webu je pryc');
assert(isset($stored['scraping_queries'], $stored['business_understanding']), 'rozhodovaci pole zustavaji');

echo "\n== 7. uklid se nikdy nedotkne kontaktu ani uctu ==\n";
$db = freshDb();
$db->exec('INSERT INTO app_users (id, email) VALUES (1, "lenka@tajemstvijamu.cz")');
$db->exec('INSERT INTO contact_databases (id, owner_user_id, name) VALUES (7, 1, "Nascrapovane kontakty")');
$recipientInsert = $db->prepare('INSERT INTO recipients (list_id, email) VALUES (7, ?)');
for ($i = 0; $i < 120; $i++) {
    $recipientInsert->execute(['kontakt' . $i . '@firma.cz']);
}
$db->prepare('INSERT INTO scraping_jobs (status, finished_at) VALUES ("finished", ?)')->execute([$old]);
addItem($db, 1, 'inserted', 'kontakt0@firma.cz', $old);
$db->prepare('INSERT INTO ai_research_logs (status, message, created_at) VALUES ("done", "tik", ?)')->execute([$old]);
$db->prepare('INSERT INTO app_sessions (id, data, updated_at, expires_at) VALUES ("stara", "", ?, ?)')
   ->execute([time() - 7200, time() - 3600]);
$before = (int)$db->query('SELECT COUNT(*) FROM recipients')->fetchColumn();
$message = runDatabaseCleanupBatch($db, 10);
$after = (int)$db->query('SELECT COUNT(*) FROM recipients')->fetchColumn();
printf("  %s\n  kontaktu pred/po: %d/%d\n", $message, $before, $after);
assert($after === $before && $after === 120, 'uklid nesmi ubrat ani jeden kontakt');
assert(countExpiredAppSessions($db) === 0, 'propadle sessiony jsou pryc');
// A uklid smi mazat jen z vyjmenovanych tabulek.
foreach (['recipients', 'contact_databases', 'app_users', 'campaigns', 'send_logs', 'scraping_jobs'] as $protectedTable) {
    assert(!in_array($protectedTable, databaseCleanupTables(), true), $protectedTable . ' nesmi byt v seznamu uklidu');
}

echo "\n== 8. vynulovani AI research kontakty a ucty zachova ==\n";
$db->exec('INSERT INTO ai_research_runs (status, plan_json) VALUES ("done", "{}")');
$db->exec('INSERT INTO ai_research_contacts (run_id) VALUES (1)');
$SETTINGS = ['ai_research_last_run_at' => '123'];
$reset = resetAiResearchData($db);
printf("  %s\n", $reset);
assert((int)$db->query('SELECT COUNT(*) FROM ai_research_runs')->fetchColumn() === 0, 'behy jsou pryc');
assert((int)$db->query('SELECT COUNT(*) FROM ai_research_contacts')->fetchColumn() === 0, 'vzorky kontaktu jsou pryc');
assert((int)$db->query('SELECT COUNT(*) FROM recipients')->fetchColumn() === 120, 'kontakty uctu zustavaji');
assert((int)$db->query('SELECT COUNT(*) FROM contact_databases')->fetchColumn() === 1, 'databaze kontaktu zustava');
assert((int)$db->query('SELECT COUNT(*) FROM app_users')->fetchColumn() === 1, 'ucet zustava');
assert(str_contains($reset, 'lenka@tajemstvijamu.cz: 120 kontaktu'), 'vypise doklad o zachovanych kontaktech');
assert((string)($SETTINGS['ai_research_last_run_at'] ?? 'x') === '', 'stav planovace se vynuluje');
// Zdroj funkce nesmi vubec sahat na tabulky s daty.
$resetSrc = extractFn($src, 'resetAiResearchData');
foreach (['recipients', 'contact_databases', 'app_users', 'campaigns', 'scraping_job'] as $protectedTable) {
    assert(!str_contains(str_replace('countRecipientsForOwnerEmail', '', $resetSrc), 'DELETE FROM ' . $protectedTable),
        'vynulovani nesmi mazat ' . $protectedTable);
}

echo "\n== 9. dokonceny beh uz nedrzi mrtvou frontu URL ==\n";
$finishSrc = extractFn($src, 'finishScrapingJob');
assert(str_contains($finishSrc, 'discardQueuedScrapingItems($pdo, $jobId)'), 'po dokonceni se fronta zahodi');
$discardSrc = extractFn($src, 'discardQueuedScrapingItems');
assert(str_contains($discardSrc, 'status="queued"'), 'maze se jen nezpracovana fronta, ne vysledky');
// Runway discovery se odviji od cile behu, jinak beh s cilem 100 kontaktu zaradil
// az 10 000 URL a po dosazeni cile je vsechny nechal lezet.
printf("  bez cile: %d, cil 100 kontaktu: %d, cil 5: %d\n",
    scrapingDiscoveryBufferForJob(['source' => 'firmy_cz', 'max_sites' => 0]),
    scrapingDiscoveryBufferForJob(['source' => 'firmy_cz', 'max_sites' => 100]),
    scrapingDiscoveryBufferForJob(['source' => 'firmy_cz', 'max_sites' => 5]));
assert(scrapingDiscoveryBufferForJob(['source' => 'firmy_cz', 'max_sites' => 0]) === 10000, 'beh bez cile bere zdroj cely');
assert(scrapingDiscoveryBufferForJob(['source' => 'firmy_cz', 'max_sites' => 100]) === 600, 'na 100 kontaktu staci stovky URL');
assert(scrapingDiscoveryBufferForJob(['source' => 'firmy_cz', 'max_sites' => 5]) === 200, 'pod podlahou se runway nezuzuje');
assert(scrapingDiscoveryBufferForJob(['source' => 'gelbeseiten_de', 'max_sites' => 1000]) === 300, 'strop zdroje plati dal');

echo "\n== 10. pocet nalezenych URL po uklidu neklesne ==\n";
$counterSrc = extractFn($src, 'refreshScrapingJobCounters');
assert(str_contains($counterSrc, 'AND discovered_count<?'), 'prepocet smi cislo jen zvysit');

echo "\n== 11. uklid je omezeny davkou a bezi z cronu ==\n";
assert(str_contains($src, 'runDatabaseCleanupBatch($pdo, 15)'), 'mala davka pri kazdem cronu');
$batchSrc = extractFn($src, 'runDatabaseCleanupBatch');
assert(str_contains($batchSrc, 'DB_CLEANUP_BATCH_ROWS'), 'mazani ma strop na davku');
assert(str_contains($batchSrc, '$deadline'), 'a casovy strop, aby request nespadl na hostingu');
assert(str_contains($batchSrc, 'OPTIMIZE'), 'zprava rika, ze misto vrati az uvolneni');
// Destruktivni akce jen pro spravce.
foreach (['run_database_cleanup', 'optimize_database_tables', 'reset_ai_research_data'] as $action) {
    $pos = strpos($src, "\$action === '" . $action . "'");
    assert($pos !== false, 'akce chybi: ' . $action);
    assert(str_contains(substr($src, $pos, 400), 'requireDatabaseMaintenanceAccess()'), $action . ' musi byt jen pro spravce');
}
assert(str_contains($src, "!== 'VYNULOVAT'"), 'vynulovani se potvrzuje slovem');
echo "  ok\n";

echo "\n== 12. velikosti se ctou z information_schema vcetne volneho mista ==\n";
$sizeSrc = extractFn($src, 'databaseTableSizes');
foreach (['DATA_LENGTH', 'INDEX_LENGTH', 'DATA_FREE', 'INFORMATION_SCHEMA.TABLES'] as $needle) {
    assert(str_contains($sizeSrc, $needle), 'chybi ' . $needle);
}
printf("  format: %s, %s, %s\n", formatBytesHuman(838 * 1024 * 1024), formatBytesHuman(1536), formatBytesHuman(0));
assert(formatBytesHuman(0) === '0 B', 'nula se vypise cistě');
assert(str_contains(formatBytesHuman(838 * 1024 * 1024), 'MB'), '838 MB se vypise v MB');

echo "\nVSE OK\n";
