<?php
/**
 * Efektivita tiku: minutovy limit se drzi napric hopy retezu (kazdy hop je novy proces),
 * jedna docasna chyba jednoho seedu nezahodi cely tik, a nedostupny provider tik odlozi.
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
foreach (['aiResearchRequestTimestamps', 'aiResearchMinuteUsageBaseline', 'aiResearchThrottleBeforeRequest',
          'aiResearchGeminiRequestsPerMinuteBudget', 'aiResearchTokensPerMinuteBudget',
          'aiResearchProviderName', 'aiResearchProviderKey', 'aiResearchProviderPreference',
          'aiResearchProviderExhausted', 'aiResearchEstimatePayloadTokens'] as $fn) {
    eval(extractFn($src, $fn));
}

$config = ['ai' => ['gemini_api_key' => 'AIza', 'gemini_research_rpm_budget' => 6]];
$budget = aiResearchGeminiRequestsPerMinuteBudget($config);

echo "== 1. minutovy limit plati i pres hopy retezu ==\n";
printf("  rozpocet: %d pozadavku/min\n", $budget);
aiResearchRequestTimestamps('reset');
aiResearchMinuteUsageBaseline(0);
$sent = 0;
while ($sent < 20 && aiResearchThrottleBeforeRequest($config, time() + 600, 100)) {
    aiResearchRequestTimestamps('add', 100);
    $sent++;
}
printf("  jeden proces poslal: %d\n", $sent);
assert($sent === $budget, 'v jednom procesu se posle presne rozpocet, mam ' . $sent);

// Novy hop = novy proces: pocitadlo v procesu je prazdne, ale historie z DB nam rekne,
// ze uz se v minutovem okne poslalo $sent pozadavku.
aiResearchRequestTimestamps('reset');
aiResearchMinuteUsageBaseline($sent);
$allowed = aiResearchThrottleBeforeRequest($config, time() + 600, 100);
printf("  dalsi hop se stejnym oknem smi poslat: %s\n", $allowed ? 'ANO' : 'ne');
assert($allowed === false, 'hop nesmi limit obejit tim, ze je to novy proces');
// Kdyz okno mezitim doslo, hop pokracuje.
aiResearchMinuteUsageBaseline(0);
assert(aiResearchThrottleBeforeRequest($config, time() + 600, 100) === true, 'po uvolneni okna se pokracuje');

echo "\n== 2. baseline se cte z ulozene historie ==\n";
eval(extractFn($src, 'aiResearchGeminiUsageTimestamps'));
eval(extractFn($src, 'aiResearchRequestsUsedLastMinute'));
$GLOBALS['SETTINGS'] = ['ai_research_gemini_request_log' => json_encode([
    time() - 5, time() - 30, time() - 59, time() - 120, time() - 3600,
])];
function loadSettings(PDO $pdo): array { return $GLOBALS['SETTINGS']; }
class FakePdo extends PDO { public function __construct() {} }
$pdo = new FakePdo();
$lastMinute = aiResearchRequestsUsedLastMinute($pdo);
printf("  v historii je 5 pozadavku, v poslednich 60 s: %d\n", $lastMinute);
assert($lastMinute === 3, 'do minutoveho okna patri jen posledni tri, mam ' . $lastMinute);
$tickFn = extractFn($src, 'runCronAiResearch');
assert(strpos($tickFn, 'aiResearchMinuteUsageBaseline(aiResearchRequestsUsedLastMinute($pdo))') !== false,
    'tik si na zacatku prevezme, kolik uz bylo poslano');

echo "\n== 3. retez se zastavi pred limitem, misto aby narazil na 429 ==\n";
$chainFn = extractFn($src, 'aiResearchChainNextTick');
assert(strpos($chainFn, 'aiResearchRequestsUsedLastMinute($pdo)') !== false, 'retez si zjisti minutove okno');
assert(strpos($chainFn, 'minutovy limit') !== false, 'a rekne to ve zprave');
assert(strpos($chainFn, 'aiResearchEstimatedGeminiRequestsPerSeed($config)') !== false,
    'pocita s tim, kolik dalsi hop spotrebuje');
echo "  ok\n";

echo "\n== 4. jedna chyba seedu nezahodi cely tik ==\n";
$loop = substr($tickFn, strpos($tickFn, 'while ($processed < AI_RESEARCH_MAX_STEPS_PER_TICK)'));
// Vyriznuty usek konci az koncem funkce, takze obsahuje i vnejsi zachyt tiku.
assert(substr_count($loop, 'catch (AiResearchTemporaryException $e)') >= 2,
    'oba druhy prace maji vlastni zachyt docasne chyby');
// Rozhodnuti o kvote ma jedno misto (aiResearchHandleQuotaFailure) a smycka podle nej
// bud tik zastavi, nebo pokracuje bez modelu.
assert(substr_count($loop, 'aiResearchHandleQuotaFailure($pdo, $config, $e)') === 2,
    'oba druhy prace posilaji kvotu do jednoho vyhodnoceni');
assert(substr_count($loop, "if (\$quota['stop']) {") === 2, 'zastaveni tiku rozhoduje vyhodnoceni kvoty');
assert(substr_count($loop, 'throw $e;') === 2, 'a jen tehdy se chyba propisuje dal');
assert(strpos($loop, 'preskocen: ') !== false, 'jinak se preskoci jen ten jeden seed');
assert(strpos($loop, '$skipRunIds[] = (int)$work[\'run_id\'];') !== false, 'a uz se v tomto tiku nezkousi');
echo "  ok\n";

echo "\n== 5. vlastni odlozeni kvuli minutovemu limitu nema delat backoff ==\n";
eval(extractFn($src, 'aiResearchRetryDelaySeconds'));
eval(extractFn($src, 'aiResearchQuotaReportedDailyRequestLimit'));
eval(extractFn($src, 'aiResearchQuotaIsMinuteWindow'));
eval(extractFn($src, 'aiResearchMinuteQuotaWaitSeconds'));
eval(extractFn($src, 'aiResearchTemporaryBackoffUntil'));
$own = new RuntimeException('AI plan_generation se odklada, aby se nesla pres minutovy limit pozadavku; beh pokracuje pri dalsim cronu.');
printf("  vlastni odlozeni -> backoff: %s\n", aiResearchTemporaryBackoffUntil($own) > 0 ? 'ANO' : 'ne');
assert(aiResearchTemporaryBackoffUntil($own) === 0, 'nase vlastni pauza nema poskytovatele penalizovat');
$real = new RuntimeException('429 You exceeded your current quota, please retry in 41s');
assert(aiResearchTemporaryBackoffUntil($real) > time(), 'skutecna kvota backoff ma');

echo "\nVSE OK\n";
