<?php
/**
 * Vycerpana kvota nesmi vest k nekonecnemu opakovani stejneho pokusu. Free tier Google
 * vraci kratky retry hint i u DENNIHO limitu, takze "dalsi pokus za 75 s" se v logu
 * opakovalo pořád a nic neproběhlo. Po nekolika marnych pokusech se poskytovatel odstavi,
 * prepne se na zalozni klic, a kdyz zadny neni, tik dodela aspon praci bez modelu.
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
foreach (['AI_RESEARCH_QUOTA_STREAK_LIMIT', 'AI_RESEARCH_HARD_QUOTA_PAUSE_SECONDS',
          'AI_RESEARCH_MAX_BACKOFF_SECONDS', 'AI_RESEARCH_FIRST_BATCH_CONTACTS',
          'AI_RESEARCH_FINISH_ATTEMPTS_MAX'] as $c) {
    preg_match('/const ' . $c . ' = ([^;]+);/', $src, $m);
    eval('const ' . $c . ' = ' . $m[1] . ';');
}
function formatDateTime(string $iso): string { return date('d.m.Y H:i', strtotime($iso)); }
function truncatePlainText(string $t, int $l): string { return mb_substr($t, 0, $l); }
$SETTINGS = [];
function loadSettings(PDO $pdo): array { return $GLOBALS['SETTINGS']; }
function setSetting(PDO $pdo, string $key, string $value): void { $GLOBALS['SETTINGS'][$key] = $value; }
function aiResearchPrimaryKeyword(array $p): string { return (string)($p['scraping_queries'][0]['keyword'] ?? ''); }
function aiResearchPrimarySourceKey(array $p): string { return (string)($p['scraping_queries'][0]['source'] ?? ''); }
function scrapingSourceIsActive(string $s): bool { return $s === 'firmy_cz'; }
function scrapingSourceLabel(string $s): string { return $s; }
$SCRAPING = null;
function aiResearchScrapingProgress(PDO $pdo, array $plan): ?array { return $GLOBALS['SCRAPING']; }
foreach (['aiResearchRetryDelaySeconds', 'aiResearchQuotaIsMinuteWindow', 'aiResearchMinuteQuotaWaitSeconds',
          'aiResearchTemporaryBackoffUntil', 'aiResearchErrorIsMinuteQuota', 'aiResearchFailureMessage',
          'aiResearchErrorIsQuota', 'aiResearchQuotaStreak', 'aiResearchHardQuotaPauseSeconds',
          'aiResearchQuotaReportedDailyRequestLimit', 'aiResearchObservedDailyRequestLimit',
          'aiResearchQuotaExhaustedModel', 'aiResearchSwitchToNextGeminiModel',
          'aiResearchModelExhausted', 'aiResearchUsableGeminiModel', 'aiResearchMarkModelExhausted',
          'aiResearchModelStateMap', 'aiResearchCombinedDailyRequestLimit',
          'geminiModelCandidates', 'geminiRuntimeModel', 'normalizeGeminiModelName',
          'aiResearchModelName', 'aiModelName',
          'aiResearchRememberObservedDailyRequestLimit', 'aiResearchDailyGeminiRequestBudget',
          'aiResearchDailyRequestBudgetOrDefault',
          'aiResearchProviderKey', 'aiResearchProviderPreference', 'aiResearchProviderExhausted',
          'aiResearchProviderName', 'aiResearchMarkProviderExhausted', 'aiResearchHandleQuotaFailure',
          'aiResearchStepsNeedingModel', 'aiResearchRunProgressesWithoutModel',
          'aiResearchSupportedMarkets', 'aiResearchPlanTargetMarkets', 'aiResearchEstimateSourcesForPlan',
          'aiResearchWorkflowChecklist', 'aiResearchWorkflowRequiredDone', 'aiResearchWorkflowMissingSteps',
          'aiResearchRunWaitsOnlyForScraping', 'aiResearchNextWork', 'aiResearchChecklistProgress'] as $fn) {
    eval(extractFn($src, $fn));
}
class FakePdo extends PDO { public function __construct() {} }
$pdo = new FakePdo();
// Presna zprava z produkce.
$real = new RuntimeException('{"error":{"code":429,"message":"You exceeded your current quota. Please retry in 41.9s","status":"RESOURCE_EXHAUSTED"}}');

echo "== 1. presny pripad z logu: opakovane 'odlozeno' ==\n";
$GLOBALS['SETTINGS'] = [];
$onlyGemini = ['ai' => ['gemini_api_key' => 'AIza']];
aiResearchProviderExhausted('gemini', 0);
aiResearchProviderExhausted('openai', 0);
for ($attempt = 1; $attempt <= 4; $attempt++) {
    $r = aiResearchHandleQuotaFailure($pdo, $onlyGemini, $real);
    printf("  pokus %d -> zastavit tik: %-3s | model k dispozici: %-3s | %s\n",
        $attempt, $r['stop'] ? 'ano' : 'ne', $r['model_available'] ? 'ano' : 'ne', mb_substr($r['message'], 0, 70));
    if ($attempt < AI_RESEARCH_QUOTA_STREAK_LIMIT) {
        assert($r['stop'] === true, 'prvni pokusy resi kratky backoff');
    } else {
        assert($r['stop'] === false, 'po ' . AI_RESEARCH_QUOTA_STREAK_LIMIT . '. pokusu se uz neopakuje dokola');
        assert($r['model_available'] === false, 'bez zalozniho klice model neni');
        assert(mb_strpos($r['message'], 'vycerpanou kvotu') !== false, 'zprava pojmenuje pricinu');
        assert(mb_strpos($r['message'], 'nastaveni AI') !== false, 'a rekne, co s tim');
    }
}
assert(aiResearchProviderExhausted('gemini'), 'Gemini je odstaveny');
printf("  pauza: %d s\n", AI_RESEARCH_HARD_QUOTA_PAUSE_SECONDS);
assert(AI_RESEARCH_HARD_QUOTA_PAUSE_SECONDS >= 1800, 'pauza musi byt vyrazne delsi nez retry hint');

echo "\n== 2. denni limit ceka do pulnoci, ne 75 s ==\n";
$daily = 'Quota exceeded for quota metric GenerateRequestsPerDayPerProjectPerModel, retry in 34s';
$pause = aiResearchHardQuotaPauseSeconds($daily);
printf("  denni limit -> pauza %d min (do %s)\n", (int)round($pause / 60), date('d.m. H:i', time() + $pause));
assert($pause > 3600, 'denni limit se do hodiny neuvolni, mam ' . $pause);
assert(aiResearchHardQuotaPauseSeconds('retry in 41s') === AI_RESEARCH_HARD_QUOTA_PAUSE_SECONDS, 'jinak hodinova pauza');

echo "\n== 3. se druhym klicem se jen prepne a pokracuje ==\n";
$GLOBALS['SETTINGS'] = [];
aiResearchProviderExhausted('gemini', 0);
aiResearchProviderExhausted('openai', 0);
$both = ['ai' => ['gemini_api_key' => 'AIza', 'openai_api_key' => 'sk-x', 'research_provider' => 'gemini']];
for ($attempt = 1; $attempt <= AI_RESEARCH_QUOTA_STREAK_LIMIT; $attempt++) {
    $r = aiResearchHandleQuotaFailure($pdo, $both, $real);
}
printf("  po prepnuti: model k dispozici %s, poskytovatel %s\n  %s\n",
    $r['model_available'] ? 'ano' : 'ne', aiResearchProviderName($both), $r['message']);
assert($r['stop'] === false && $r['model_available'] === true, 'se zalohou se pokracuje hned');
assert(aiResearchProviderName($both) === 'openai', 'dalsi pozadavek jde na OpenAI');
assert((int)($GLOBALS['SETTINGS']['ai_research_quota_streak'] ?? -1) === 0, 'po prepnuti se serie nuluje');

echo "\n== 4. bez modelu se dodela prace, ktera ho nepotrebuje ==\n";
$base = [
    'business_understanding' => 'Firma prodava zabezpeceni.',
    'website_url_analyzed' => 'https://x.cz',
    'primary_segment' => 'Stavebni firmy',
    'scraping_queries' => [['source' => 'firmy_cz', 'keyword' => 'stavebni firma']],
    'target_markets' => ['CZ'],
    'outreach_variants' => [['subject' => 'A'], ['subject' => 'B']],
];
$run = ['id' => 1, 'status' => 'done', 'email_body_html' => '<p>x</p>', 'accepted_count' => 0];
$GLOBALS['SCRAPING'] = null;
// Chybi ucet a davka -> to model nepotrebuje.
$offline = aiResearchWorkflowChecklist($pdo, $run, $base + ['contact_estimate' => ['complete' => true, 'reachable_contacts' => 900, 'sources' => [['source' => 'firmy_cz']], 'pending_sources' => []]]);
printf("  chybi %s -> bez modelu: %s\n", implode(', ', aiResearchWorkflowMissingSteps($offline)),
    aiResearchRunProgressesWithoutModel($offline) ? 'lze' : 'nelze');
assert(aiResearchRunProgressesWithoutModel($offline), 'ucet a davka model nepotrebuji');
// Chybi vzory osloveni -> to uz model potrebuje.
$needsModel = aiResearchWorkflowChecklist($pdo, $run, array_merge($base, ['outreach_variants' => [], 'contact_estimate' => ['complete' => true, 'reachable_contacts' => 900, 'sources' => [['source' => 'firmy_cz']], 'pending_sources' => []]]));
assert(!aiResearchRunProgressesWithoutModel($needsModel), 'vzory osloveni bez modelu nevzniknou');

echo "\n== 5. fronta v rezimu bez modelu nezaklada novy seed ==\n";
$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->exec('CREATE TABLE ai_research_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, seed_business TEXT DEFAULT "",
    seed_email TEXT DEFAULT "", status TEXT DEFAULT "done", plan_json TEXT DEFAULT "{}",
    found_count INTEGER DEFAULT 0, accepted_count INTEGER DEFAULT 0, email_body_html TEXT DEFAULT "")');
$ins = $db->prepare('INSERT INTO ai_research_runs (seed_business, status, plan_json, accepted_count, email_body_html) VALUES (?,?,?,?,?)');
printf("  prazdna fronta, bez modelu -> %s\n", aiResearchNextWork($db, [], false)['kind']);
assert(aiResearchNextWork($db, [], false)['kind'] === 'none', 'bez modelu se novy seed nezaklada');
assert(aiResearchNextWork($db, [], true)['kind'] === 'new_seed', 's modelem ano');
// Beh, kteremu chybi jen ucet, se vezme i bez modelu.
$ins->execute(['Ceka na ucet', 'done', json_encode($base + ['contact_estimate' => ['complete' => true, 'reachable_contacts' => 900, 'sources' => [['source' => 'firmy_cz']], 'pending_sources' => []]]), 0, '<p>x</p>']);
printf("  beh bez uctu, bez modelu -> %s\n", aiResearchNextWork($db, [], false)['kind']);
assert(aiResearchNextWork($db, [], false)['kind'] === 'finish_incomplete', 'takovy beh se posunout da');
// Beh, kteremu chybi vzory osloveni, se bez modelu nebere.
$db->exec('DELETE FROM ai_research_runs');
$ins->execute(['Ceka na osloveni', 'deferred', json_encode(array_merge($base, ['outreach_variants' => []])), 0, '']);
printf("  beh bez osloveni, bez modelu -> %s\n", aiResearchNextWork($db, [], false)['kind']);
assert(aiResearchNextWork($db, [], false)['kind'] === 'none', 'na osloveni se bez modelu ceka');

echo "\n== 6. tik a retez to respektuji ==\n";
$tick = extractFn($src, 'runCronAiResearch');
assert(strpos($tick, 'aiResearchNextWork($pdo, $skipRunIds, $modelAvailable)') !== false, 'fronta zna rezim');
assert(strpos($tick, "if ((string)\$work['kind'] === 'none')") !== false, 'tik pozna, ze uz neni co delat');
assert(strpos($tick, 'aiResearchHandleQuotaFailure($pdo, $config, $e)') !== false, 'kvota ma jedno zpracovani');
assert(strpos($tick, 'aiResearchQuotaStreak($pdo, 0)') !== false, 'uspesny tik nuluje serii');
assert(strpos($tick, 'vsichni poskytovatele maji vycerpanou kvotu') !== false, 'tik nezacina marnym pozadavkem');
echo "  ok\n";

echo "\n== 7. vycerpany DENNI strop se pozna z cisla, ktere Google sam uvede ==\n";
// Presna zprava z produkce, 04.09.2026. Nas denni rozpocet stal na 200, protoze tolik
// mel free tier drivejsiho modelu; gemini-3-flash pripousti 20. Zbylych 119 pozadavku
// v jedne serii byly zarucene chyby - a protoze retry hint zni "retry in 33s", cetly
// se jako minutove okno a opakovaly se dokola.
$exhausted = 'You exceeded your current quota, please check your plan and billing details. '
    . 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, '
    . 'limit: 20, model: gemini-3-flash Please retry in 33.76887199s.';
printf("  ohlaseny denni strop: %d\n", aiResearchQuotaReportedDailyRequestLimit($exhausted));
assert(aiResearchQuotaReportedDailyRequestLimit($exhausted) === 20, 'strop se musi precist z chyby');
assert(aiResearchQuotaIsMinuteWindow($exhausted) === false,
    'kratky retry hint nesmi vycerpany denni strop vydavat za minutove okno');
$pause = aiResearchHardQuotaPauseSeconds($exhausted);
printf("  pauza: %d min (do %s)\n", (int)round($pause / 60), date('d.m. H:i', time() + $pause));
assert($pause > 3600, 'do konce dne se strop neuvolni, mam ' . $pause);
// Minutove okno se timhle nesmi rozbit: male cislo neni denni strop.
$minute = 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_requests_per_minute, '
    . 'limit: 5, model: gemini-3-flash Please retry in 12s.';
assert(aiResearchQuotaReportedDailyRequestLimit($minute) === 0, 'jednotky nejsou denni strop');
assert(aiResearchQuotaIsMinuteWindow($minute) === true, 'minutove okno zustava minutovym oknem');

echo "\n== 7b. strop je per model, takze rozpocet je soucet pres modely ==\n";
// Free tier Google pocita denni strop pro kazdy model zvlast. Odstavit celeho
// providera kvuli jednomu vycerpanemu modelu proto zahazovalo kvotu, kterou mame.
$GLOBALS['SETTINGS'] = [];
foreach (geminiModelCandidates() as $candidate) {
    aiResearchModelExhausted($candidate, 0);
}
geminiRuntimeModel('');
$onlyGemini = ['ai' => ['gemini_api_key' => 'AIza']];
$candidateCount = count(geminiModelCandidates());
printf("  modelu v zebriku: %d, rozpocet bez pozorovani: %d\n",
    $candidateCount, aiResearchDailyRequestBudgetOrDefault($onlyGemini, $pdo));
assert(aiResearchDailyRequestBudgetOrDefault($onlyGemini, $pdo) === 200 * $candidateCount,
    'bez pozorovani se kazdy model pocita vychozim stropem');
// Ohlaseny strop plati pro model, ktery ho ohlasil - ne pro ostatni.
// Model se urcuje tou samou cestou jako v provozu: Google echuje "gemini-3-flash",
// coz v nasem zebriku neni, takze strop patri modelu, se kterym request odesel.
$blamed = aiResearchQuotaExhaustedModel($exhausted, $onlyGemini);
printf("  strop pripsan modelu: %s\n", $blamed);
assert(in_array($blamed, geminiModelCandidates(), true),
    'strop musi patrit modelu ze zebriku, jinak ho soucet nikdy neuvidi');
assert(aiResearchRememberObservedDailyRequestLimit($pdo, $exhausted, $blamed) === 20,
    'strop se zapamatuje k modelu');
$after = aiResearchDailyRequestBudgetOrDefault($onlyGemini, $pdo);
printf("  po pozorovani gemini-3-flash=20: %d\n", $after);
assert($after === 200 * ($candidateCount - 1) + 20,
    'cislo jednoho modelu nesmi srazit rozpocet ostatnim, mam ' . $after);
// Vlastni nastaveni ma prednost - kdo ma placeny tarif, nesmi ho pozorovani srazit.
assert(aiResearchDailyRequestBudgetOrDefault(
    ['ai' => ['gemini_api_key' => 'A', 'gemini_research_daily_request_budget' => 5000]], $pdo) === 5000,
    'explicitni nastaveni pozorovani neprebiji');
// A pozorovani se zapisuje tam, kde se kvotova chyba resi.
$handle = extractFn($src, 'aiResearchHandleQuotaFailure');
assert(strpos($handle, 'aiResearchRememberObservedDailyRequestLimit($pdo, $message') !== false,
    'kvotova chyba musi ohlaseny strop zapsat');

echo "\n== 7c. vycerpany model prepne na dalsi, ne na odstaveni providera ==\n";
// Tohle je cesta, jak zvysit denni propustnost bez placeneho tarifu: nejsilnejsi
// model se pouziva, dokud ma kvotu, pak se spadne o stupen niz. Kvalita klesa
// teprve tehdy, kdyz lepsi model uz na dnes nema nic.
$GLOBALS['SETTINGS'] = [];
foreach (geminiModelCandidates() as $candidate) {
    aiResearchModelExhausted($candidate, 0);
}
geminiRuntimeModel('');
$candidates = geminiModelCandidates();
printf("  zebrik: %s\n", implode(' -> ', $candidates));
$blamed = aiResearchQuotaExhaustedModel($exhausted, $onlyGemini);
assert($blamed === $candidates[0],
    'bez shody v zebriku plati model, se kterym request odesel, mam ' . $blamed);
$next = aiResearchSwitchToNextGeminiModel($onlyGemini, $exhausted, $pdo);
printf("  po vycerpani %s -> %s\n", $blamed, $next);
assert($next === $candidates[1], 'prepne se na dalsi model ze zebriku');
assert(aiResearchModelExhausted($blamed), 'vycerpany model zustava odstaveny');
assert(aiResearchModelName($onlyGemini) === $next, 'dalsi pozadavek uz jde na novy model');
// Odstaveni prezije i to, ze kazdy tik je jiny request.
assert(isset(aiResearchModelStateMap($pdo)[$blamed]),
    'odstaveny model se musi ulozit, jinak kazdy tik zacne znovu u 429');
// Vycerpany model uz se do rozpoctu nepocita vubec.
$dropped = aiResearchDailyRequestBudgetOrDefault($onlyGemini, $pdo);
printf("  rozpocet bez vycerpaneho modelu: %d\n", $dropped);
assert($dropped === 200 * ($candidateCount - 1),
    'vycerpany model uz kvotu nepridava, mam ' . $dropped);
// Minutove okno na slabsi model neprepina - uvolni se samo.
assert(aiResearchSwitchToNextGeminiModel($onlyGemini, $minute, $pdo) === '',
    'minutove okno nesmi snizovat kvalitu prepnutim na slabsi model');
// A kdyz uz zadny model nezbyva, prepnuti nelze nabidnout.
foreach ($candidates as $candidate) {
    aiResearchMarkModelExhausted($candidate, 3600, $pdo);
}
assert(aiResearchUsableGeminiModel() === '', 'vycerpane vsechny modely = neni kam jit');
assert(aiResearchSwitchToNextGeminiModel($onlyGemini, $exhausted, $pdo) === '',
    'bez volneho modelu se teprve odstavi provider');
printf("  vsechny vycerpane -> prepnuti: %s\n", aiResearchUsableGeminiModel() === '' ? 'zadne' : 'chyba');

echo "\n== 8. kvotovy naraz nesmi spotrebovat pokus o dokonceni behu ==\n";
// Tohle je druha polovina te same skody: dokonceni behu polykalo vyjimku a vracelo ji
// jako obycejnou zpravu kroku, takze (a) tik se vykazal jako hotovy a vynuloval serii
// kvotovych neuspechu, takze eskalace na dlouhou pauzu nikdy nenastala, a (b) kazdy
// naraz spotreboval jeden ze tri pokusu. Za jednu serii se tak trvale zavrelo 30
// zdravych subjektu (uzavrenych behu 16 -> 46).
$finish = extractFn($src, 'runCronAiResearchUnfinished');
assert(strpos($finish, 'aiResearchErrorIsQuota($e->getMessage())') !== false,
    'dokonceni musi kvotovou chybu poznat');
assert(strpos($finish, 'aiResearchRefundFinishAttempt($pdo, $runId)') !== false,
    'kvotovy naraz se musi vratit zpatky');
assert(preg_match('/aiResearchRefundFinishAttempt\(\$pdo, \$runId\);\s*\n\s*throw \$e;/', $finish) === 1,
    'a vyjimka musi jit nahoru, kde se kvota resi');
assert(strpos($src, 'function reopenAiResearchRunsClosedByAttemptCap') !== false,
    'behy uzavrene stropem pokusu se musi dat znovu otevrit');
assert(strpos($src, "isset(\$_GET['reopen_quota_closed'])") !== false,
    'naprava musi byt spustitelna z cronu');
echo "  ok\n";

echo "\nVSE OK\n";
