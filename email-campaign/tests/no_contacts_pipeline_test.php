<?php
/**
 * Seed, u ktereho prvnich par detailu z katalogu nemelo e-mail, musi projit celym
 * workflow: vzor osloveni, ucet a databaze i prvni davka. Drive se takovy beh zastavil
 * na tretim kroku ze sedmi a fronta si ho uz nikdy nevzala, protoze rozhodovala podle
 * poctu ulozenych vzorku kontaktu.
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
foreach (['AI_RESEARCH_FIRST_BATCH_CONTACTS'] as $const) {
    preg_match('/const ' . $const . ' = (\d+);/', $src, $m);
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
          'aiResearchRunWaitsOnlyForScraping', 'aiResearchNextWork', 'aiResearchWorkIsFinishing'] as $fn) {
    eval(extractFn($src, $fn));
}

$plan = [
    'business_understanding' => 'Firma prodava zabezpeceni budov.',
    'website_url_analyzed' => 'https://cbis.cz',
    'primary_segment' => 'Stavebni firmy',
    'scraping_queries' => [['source' => 'firmy_cz', 'keyword' => 'stavebni firma']],
    'target_markets' => ['CZ'],
];

echo "== 1. beh bez vzorku kontaktu se dostane do fronty ==\n";
$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->exec('CREATE TABLE ai_research_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, seed_business TEXT DEFAULT "",
    seed_email TEXT DEFAULT "", status TEXT DEFAULT "done", plan_json TEXT DEFAULT "{}",
    found_count INTEGER DEFAULT 0, accepted_count INTEGER DEFAULT 0, email_body_html TEXT DEFAULT "")');
$ins = $db->prepare('INSERT INTO ai_research_runs (seed_business, status, plan_json, found_count, accepted_count, email_body_html) VALUES (?,?,?,?,?,?)');
$ins->execute(['C.B.I.S Security', 'done', json_encode($plan), 0, 0, '']);
$work = aiResearchNextWork($db);
printf("  dalsi prace: %s (#%d)\n", $work['kind'], (int)$work['run_id']);
assert($work['kind'] === 'finish_incomplete', 'beh bez kontaktu musi jit dotahnout, mam ' . $work['kind']);
assert((int)$work['run_id'] === 1, 'a ma to byt prave on');

echo "\n== 2. seed bez pouzitelneho planu frontu neblokuje ==\n";
$db->exec('DELETE FROM ai_research_runs');
$ins->execute(['Bez planu', 'done', json_encode(['business_understanding' => '', 'scraping_queries' => []]), 0, 0, '']);
$work = aiResearchNextWork($db);
printf("  dalsi prace: %s\n", $work['kind']);
assert($work['kind'] === 'new_seed', 'beh bez planu se dotahovat nema, mam ' . $work['kind']);

echo "\n== 3. vzor osloveni se generuje z planu, i kdyz nejsou kontakty ==\n";
$draftFn = extractFn($src, 'aiResearchRunDraft');
assert(strpos($draftFn, 'skipped_no_accepted_contacts') === false, 'stare zastaveni bez kontaktu je pryc');
assert(strpos($draftFn, "!\$acceptedContacts && aiResearchPrimaryKeyword(\$plan) === ''") !== false,
    'negeneruje se jen tehdy, kdyz chybi i plan');
$auditFn = extractFn($src, 'auditAiResearchRunNow');
assert(substr_count($auditFn, '$planUsableForDrafts') >= 3, 'kontrola behu pouziva plan misto poctu kontaktu');
assert(strpos($auditFn, 'if (($contacts || $planUsableForDrafts) && ($draftUnusable') !== false, 'vzory osloveni');
assert(strpos($auditFn, "if ((\$contacts || \$planUsableForDrafts) && in_array((string)\$run['status']") !== false, 'ucet a workspace');
echo "  ok\n";

echo "\n== 4. dokonceni behu zaklada workspace i bez vzorku ==\n";
$finalizeFn = extractFn($src, 'finalizeAiResearchRun');
assert(strpos($finalizeFn, '$planUsable = aiResearchPrimaryKeyword($plan)') !== false, 'rozhoduje pouzitelny plan');
assert(strpos($finalizeFn, 'if ($accepted || $planUsable) {') !== false, 'workspace se zaklada i bez vzorku');
assert(strpos($finalizeFn, "(\$accepted || \$planUsable) ? 'preparing' : 'not_ready'") !== false, 'stav osloveni');
assert(strpos($finalizeFn, "\$status = (\$accepted || \$planUsable) ? 'done'") !== false, 'beh je hotovy');
echo "  ok\n";

echo "\n== 5. po zalozeni workspace uz chybi jen davka a ta se doplni workerem ==\n";
$full = $plan + [
    'contact_estimate' => ['complete' => true, 'reachable_contacts' => 4200, 'sources' => [['source' => 'firmy_cz']], 'pending_sources' => []],
    'outreach_variants' => [['subject' => 'A'], ['subject' => 'B']],
    'provisioned_container_id' => 4,
    'provisioned_list_id' => 8,
];
$run = ['id' => 1, 'status' => 'done', 'email_body_html' => '<p>x</p>', 'accepted_count' => 0];
$SCRAPING = ['container_id' => 4, 'list_id' => 8, 'job' => ['status' => 'running'], 'contacts_total' => 12];
$checklist = aiResearchWorkflowChecklist($db, $run, $full);
$missing = aiResearchWorkflowMissingSteps($checklist);
printf("  chybi: %s\n", implode('; ', $missing) ?: '(nic)');
assert($missing === ['Nascrapovaná první dávka kontaktů'], 'ma chybet jen davka, chybi: ' . implode('; ', $missing));
assert(aiResearchRunWaitsOnlyForScraping($db, $full, $checklist), 'na davku se jen ceka, cron ji netahá');
// A po dobehnuti davky je zaznam hotovy.
$SCRAPING = ['container_id' => 4, 'list_id' => 8, 'job' => ['status' => 'finished'], 'contacts_total' => AI_RESEARCH_FIRST_BATCH_CONTACTS];
$checklist = aiResearchWorkflowChecklist($db, $run, $full);
printf("  po davce hotovo: %s\n", aiResearchWorkflowRequiredDone($checklist) ? 'ano' : 'NE');
assert(aiResearchWorkflowRequiredDone($checklist), 'se dokoncenou davkou musi byt beh ready');

echo "\nVSE OK\n";
