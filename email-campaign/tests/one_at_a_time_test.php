<?php
/**
 * Jeden subjekt se dotahne do konce a teprve pak se bere dalsi. V prehledu se drive
 * hromadily z casti zpracovane zaznamy: beh, ktery cekal na scraping nebo ktery se
 * zastavil uz na planu, fronta preskocila a cas dostal novy seed. Test hlida, ze novy
 * seed vznikne teprve tehdy, kdyz zadny rozdelany beh nezbyva - a ze zadny beh nemuze
 * frontu drzet navzdy.
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
foreach (['AI_RESEARCH_FIRST_BATCH_CONTACTS', 'AI_RESEARCH_FINISH_ATTEMPTS_MAX', 'AI_RESEARCH_BATCH_STEPS_PER_TICK'] as $const) {
    preg_match('/const ' . $const . ' = (\d+);/', $src, $m);
    assert(isset($m[1]), 'konstanta chybi: ' . $const);
    eval('const ' . $const . ' = ' . $m[1] . ';');
}
function aiResearchPrimaryKeyword(array $p): string { return (string)($p['scraping_queries'][0]['keyword'] ?? ''); }
function aiResearchPrimarySourceKey(array $p): string { return (string)($p['scraping_queries'][0]['source'] ?? ''); }
function scrapingSourceIsActive(string $s): bool { return $s === 'firmy_cz'; }
function scrapingSourceLabel(string $s): string { return $s; }
$SCRAPING = null;
function aiResearchScrapingProgress(PDO $pdo, array $plan): ?array { global $SCRAPING; return $SCRAPING; }
function loadSettings(PDO $pdo): array { return []; }
foreach (['aiResearchSupportedMarkets', 'aiResearchPlanTargetMarkets', 'aiResearchEstimateSourcesForPlan',
          'aiResearchWorkflowChecklist', 'aiResearchWorkflowRequiredDone', 'aiResearchWorkflowMissingSteps',
          'aiResearchRunWaitsOnlyForScraping', 'aiResearchNextWork', 'aiResearchWorkIsFinishing',
          'aiResearchCloseExhaustedRuns', 'aiResearchStepsNeedingModel', 'aiResearchRunProgressesWithoutModel'] as $fn) {
    eval(extractFn($src, $fn));
}

$plan = [
    'business_understanding' => 'Firma prodava zabezpeceni budov.',
    'website_url_analyzed' => 'https://cbis.cz',
    'primary_segment' => 'Stavebni firmy',
    'scraping_queries' => [['source' => 'firmy_cz', 'keyword' => 'stavebni firma']],
    'target_markets' => ['CZ'],
];
$readyPlan = $plan + [
    'contact_estimate' => ['complete' => true, 'reachable_contacts' => 4200, 'sources' => [['source' => 'firmy_cz']], 'pending_sources' => []],
    'outreach_variants' => [['subject' => 'A'], ['subject' => 'B']],
    'provisioned_container_id' => 4,
    'provisioned_list_id' => 8,
];

function freshDb(): PDO
{
    $db = new PDO('sqlite::memory:');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec('CREATE TABLE ai_research_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, seed_business TEXT DEFAULT "",
        seed_email TEXT DEFAULT "", status TEXT DEFAULT "done", plan_json TEXT DEFAULT "{}",
        found_count INTEGER DEFAULT 0, accepted_count INTEGER DEFAULT 0, email_body_html TEXT DEFAULT "",
        message TEXT DEFAULT "", updated_at TEXT DEFAULT "")');
    return $db;
}
function addRun(PDO $db, string $name, string $status, array $plan, int $accepted = 0, string $html = ''): int
{
    $ins = $db->prepare('INSERT INTO ai_research_runs (seed_business, status, plan_json, found_count, accepted_count, email_body_html) VALUES (?,?,?,?,?,?)');
    $ins->execute([$name, $status, json_encode($plan), $accepted, $accepted, $html]);
    return (int)$db->lastInsertId();
}

echo "== 1. beh, ktery se zastavil uz na planu, se dotahuje (nezahazuje se) ==\n";
$db = freshDb();
addRun($db, 'Bez planu', 'done', ['business_understanding' => '', 'scraping_queries' => []]);
$work = aiResearchNextWork($db);
printf("  dalsi prace: %s (#%d)\n", $work['kind'], (int)$work['run_id']);
assert($work['kind'] === 'finish_incomplete', 'prazdny zaznam se ma dotahnout, mam ' . $work['kind']);

echo "\n== 2. behu chybi jen davka - tik ji posune sam, misto aby vzal novy seed ==\n";
$db = freshDb();
addRun($db, 'C.B.I.S Security', 'done', $readyPlan, 0, '<p>x</p>');
$SCRAPING = ['container_id' => 4, 'list_id' => 8, 'job' => ['id' => 77, 'status' => 'running'], 'contacts_total' => 12];
$work = aiResearchNextWork($db);
printf("  dalsi prace: %s (#%d)\n", $work['kind'], (int)$work['run_id']);
assert($work['kind'] === 'scrape_batch', 'davka se ma posunout v tiku, mam ' . $work['kind']);
assert(aiResearchWorkIsFinishing($work), 'davka je prace na rozdelanem behu, ne novy seed');

echo "\n== 3. rozdelany beh, se kterym se teted hybat neda, presto blokuje novy seed ==\n";
$db = freshDb();
$runId = addRun($db, 'C.B.I.S Security', 'done', $plan);
// Stejny beh uz v tomto tiku prisel na radu a neposunul se.
$work = aiResearchNextWork($db, [$runId]);
printf("  dalsi prace: %s (%s)\n", $work['kind'], (string)($work['blocked_by'] ?? ''));
assert($work['kind'] === 'none', 'novy seed se zakladat nesmi, mam ' . $work['kind']);
assert(str_contains((string)$work['blocked_by'], '#' . $runId), 'v duvodu ma byt, ktery beh se dotahuje');

echo "\n== 4. bez modelu to plati stejne ==\n";
$work = aiResearchNextWork($db, [], false);
printf("  dalsi prace: %s (%s)\n", $work['kind'], (string)($work['blocked_by'] ?? ''));
assert($work['kind'] === 'none', 'bez modelu se novy seed nezaklada');
assert(str_contains((string)$work['blocked_by'], 'AI model'), 'duvod ma rict, ze kroky potrebuji model');

echo "\n== 5. nedotazitelny beh se trvale uzavre, aby frontu nedrzel navzdy ==\n";
$db = freshDb();
$stuck = $plan;
$stuck['finish_attempts'] = AI_RESEARCH_FINISH_ATTEMPTS_MAX;
$stuckId = addRun($db, 'Nedotazitelny', 'done', $stuck);
$work = aiResearchNextWork($db);
printf("  pred uzavrenim: %s (%s)\n", $work['kind'], (string)($work['blocked_by'] ?? ''));
assert($work['kind'] === 'none', 'dokud je otevreny, novy seed nevznika');
$closed = aiResearchCloseExhaustedRuns($db);
printf("  uzavreno behu: %d\n", $closed);
assert($closed === 1, 'beh po vycerpanych pokusech se ma uzavrit');
$stored = json_decode((string)$db->query('SELECT plan_json FROM ai_research_runs WHERE id=' . $stuckId)->fetchColumn(), true);
printf("  duvod: %s\n", (string)$stored['permanently_closed_reason']);
assert(!empty($stored['permanently_closed']), 'ma byt trvale uzavreny');
assert(str_contains((string)$stored['permanently_closed_reason'], 'Nascrapovaná první dávka kontaktů'),
    'duvod ma jmenovat chybejici kroky');
$work = aiResearchNextWork($db);
printf("  po uzavreni: %s\n", $work['kind']);
assert($work['kind'] === 'new_seed', 'uzavreny beh uz frontu nedrzi, mam ' . $work['kind']);

echo "\n== 6. hotovy beh i nevhodny seed pusti dalsi subjekt ==\n";
$db = freshDb();
$SCRAPING = ['container_id' => 4, 'list_id' => 8, 'job' => ['id' => 77, 'status' => 'finished'], 'contacts_total' => AI_RESEARCH_FIRST_BATCH_CONTACTS];
addRun($db, 'Hotovy', 'done', $readyPlan, 30, '<p>x</p>');
addRun($db, 'Nevhodny', 'done', ['seed_unsuitable' => true] + $plan);
addRun($db, 'Uzavreny', 'done', ['permanently_closed' => true] + $plan);
$work = aiResearchNextWork($db);
printf("  dalsi prace: %s\n", $work['kind']);
assert($work['kind'] === 'new_seed', 'nic nezbyva, ma se vzit novy seed, mam ' . $work['kind']);
assert(aiResearchCloseExhaustedRuns($db) === 0, 'hotove a uzavrene behy se znovu neuzaviraji');

echo "\n== 7. jen jeden rozdelany beh naraz: druhy ceka ==\n";
$db = freshDb();
$SCRAPING = null;
$first = addRun($db, 'Prvni', 'done', $plan);
$second = addRun($db, 'Druhy', 'done', $plan);
$work = aiResearchNextWork($db);
printf("  bere se: #%d (%s)\n", (int)$work['run_id'], $work['kind']);
assert((int)$work['run_id'] === $first, 'od nejstarsiho, mam #' . (int)$work['run_id']);
$work = aiResearchNextWork($db, [$first]);
printf("  po preskoceni prvniho: #%d (%s)\n", (int)$work['run_id'], $work['kind']);
assert((int)$work['run_id'] === $second, 'dalsi rozdelany, ne novy seed');

echo "\n== 8. retez a planovac to popisuji stejne ==\n";
$chainFn = extractFn($src, 'aiResearchChainNextTick');
assert(str_contains($chainFn, 'novy seed se nezaklada, dokud neni hotovy'), 'retez se zastavi na blokovanem behu');
$plannedFn = extractFn($src, 'aiResearchPlannedLogMessage');
assert(str_contains($plannedFn, "\$work['blocked_by']"), 'planovac ukaze, na co se ceka');
$tickFn = extractFn($src, 'runCronAiResearch');
assert(str_contains($tickFn, 'aiResearchCloseExhaustedRuns($pdo)'), 'tik uzavira nedotazitelne behy');
assert(str_contains($tickFn, 'novy seed se nezaklada, dokud neni hotovy'), 'a do logu to napise');
$unfinishedFn = extractFn($src, 'runCronAiResearchUnfinished');
assert(str_contains($unfinishedFn, "=== 'scrape_batch'"), 'davku posouva dokonceni behu');
assert(strpos($unfinishedFn, "'scrape_batch'") < strpos($unfinishedFn, "\$plan['finish_attempts'] = "),
    'krok davky nesmi cerpat pokusy o dokonceni');
echo "  ok\n";

echo "\nVSE OK\n";
