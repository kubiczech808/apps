<?php
/**
 * Provoz na Gemini free tieru: jeden seed smi stat jen dva pozadavky na model, vychozi
 * denni strop musi byt pod skutecnym limitem poskytovatele (jinak si ho vycerpame a
 * hodiny se opakuje marny pokus) a vycerpany rozpocet nesmi zastavit praci, ktera model
 * nepotrebuje.
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
foreach (['aiResearchProviderKey', 'aiResearchProviderPreference', 'aiResearchProviderExhausted',
          'aiResearchProviderName', 'aiResearchEstimatedGeminiRequestsPerSeed',
          'aiResearchDailyGeminiRequestBudget', 'aiResearchDailyRequestBudgetOrDefault',
          'aiResearchGeminiRequestsPerMinuteBudget'] as $fn) {
    eval(extractFn($src, $fn));
}
$gemini = ['ai' => ['gemini_api_key' => 'AIza']];
$openai = ['ai' => ['openai_api_key' => 'sk-x']];

echo "== 1. jeden seed = dva pozadavky na model ==\n";
printf("  Gemini: %d, OpenAI: %d\n",
    aiResearchEstimatedGeminiRequestsPerSeed($gemini), aiResearchEstimatedGeminiRequestsPerSeed($openai));
assert(aiResearchEstimatedGeminiRequestsPerSeed($gemini) === 2, 'plan + jedna odpoved s oba texty');
assert(aiResearchEstimatedGeminiRequestsPerSeed($openai) === 2, 'stejne u OpenAI');
// Konfigurace ma prednost.
assert(aiResearchEstimatedGeminiRequestsPerSeed(['ai' => ['gemini_api_key' => 'A', 'gemini_research_requests_per_seed' => 5]]) === 5,
    'nastaveni prebiji vychozi hodnotu');

echo "\n== 2. dva texty z jedne odpovedi ==\n";
$draftFn = extractFn($src, 'aiResearchRunDraft');
assert(strpos($draftFn, 'seed_outreach') !== false, 'prompt si rekne i o text pro seed');
assert(strpos($draftFn, "\$result['seed_outreach'] = [") !== false, 'a vraci ho volajicimu');
$finalizeFn = extractFn($src, 'finalizeAiResearchRun');
assert(strpos($finalizeFn, '$bundledSeedDraft') !== false, 'dokonceni pouzije text z hromadne odpovedi');
assert(strpos($finalizeFn, 'aiResearchSeedOutreachIsSpecific(') !== false, 'a zkontroluje jeho konkretnost');
$bundledPos = strpos($finalizeFn, '$bundledSeedDraft');
$fallbackPos = strpos($finalizeFn, 'aiResearchGenerateSeedOutreach(');
assert($bundledPos < $fallbackPos, 'samostatny pozadavek je az zaloha');
assert(strpos($finalizeFn, "if (!is_array(\$plan['seed_outreach_draft'] ?? null) && (\$accepted") !== false,
    'zaloha se vola jen kdyz text z hromadne odpovedi chybi');
echo "  ok\n";

echo "\n== 3. alternativni keywordy uz nestoji dalsi pozadavek ==\n";
assert(strpos($src, 'aiResearchAlternativePlans') === false, 'volani i funkce jsou pryc');
$runOnce = extractFn($src, 'runAiResearchOnce');
assert(strpos($runOnce, 'alternativni keyword') === false, 've smycce uz nezustala vetev na alternativy');
echo "  ok\n";

echo "\n== 4. vychozi denni strop je pod limitem poskytovatele ==\n";
$geminiCap = aiResearchDailyRequestBudgetOrDefault($gemini);
$openAiCap = aiResearchDailyRequestBudgetOrDefault($openai);
printf("  Gemini: %d pozadavku/den -> cca %d seedu, OpenAI: %d -> cca %d seedu\n",
    $geminiCap, intdiv($geminiCap, 2), $openAiCap, intdiv($openAiCap, 2));
assert($geminiCap > 0 && $geminiCap <= 250, 'strop musi byt pod free tierem, mam ' . $geminiCap);
assert(intdiv($geminiCap, aiResearchEstimatedGeminiRequestsPerSeed($gemini)) >= 50,
    'i tak ma vyjit aspon padesat seedu denne');
// Nastaveni z aplikace prebiji.
assert(aiResearchDailyRequestBudgetOrDefault(['ai' => ['gemini_api_key' => 'A', 'gemini_research_daily_request_budget' => 900]]) === 900,
    'kdo ma placeny tarif, zvedne strop v nastaveni');

echo "\n== 5. minutovy strop drzi pod free tierem ==\n";
$rpm = aiResearchGeminiRequestsPerMinuteBudget($gemini);
printf("  Gemini: %d pozadavku/min\n", $rpm);
assert($rpm <= 9, 'free tier Gemini ma 10 RPM, drzime se pod tim');

echo "\n== 6. vycerpany denni rozpocet neznamena zadna prace ==\n";
$tick = extractFn($src, 'runCronAiResearch');
assert(strpos($tick, '$dailyBudgetSpent = $usedToday + $neededPerSeed > $dailyBudget;') !== false,
    'vycerpani se jen poznamena');
assert(strpos($tick, '$modelAvailable = !$dailyBudgetSpent;') !== false,
    'a prepne rezim, misto aby tik skoncil');
assert(strpos($tick, "updateAiResearchLog(\$pdo, \$planned, ['status' => 'skipped', 'message' => \$message") === false,
    'stary early return uz tam neni');
assert(strpos($tick, 'bezi jen prace bez modelu') !== false, 'a rekne to ve zprave');
echo "  ok\n";

echo "\n== 7. kolik seedu denne to dava ==\n";
$perSeed = aiResearchEstimatedGeminiRequestsPerSeed($gemini);
printf("  Gemini free tier: %d/%d = %d seedu denne (drive %d)\n",
    $geminiCap, $perSeed, intdiv($geminiCap, $perSeed), intdiv($geminiCap, 3));
assert(intdiv($geminiCap, $perSeed) > intdiv($geminiCap, 3), 'dva pozadavky na seed musi dat vic nez tri');

echo "\n== 8. deploy config nesmi prebijet pocet pozadavku na seed nahoru ==\n";
// Produkce hlasila 3 pozadavky na seed proti dvema v kodu, protoze deploy workflow
// dosazoval vlastni vychozi "3". Stalo to tretinu propustnosti a z velikosti ani
// z logu to nebylo videt.
$deploy = file_get_contents(__DIR__ . '/../../.github/workflows/email-campaign-deploy.yml');
assert($deploy !== false, 'deploy workflow se musi precist');
preg_match_all('/RESEARCH_REQUESTS_PER_SEED"\) or "(\d+)"/', $deploy, $matches);
printf("  deploy dosazuje: %s, kod ma vychozi %d\n", implode(', ', $matches[1]), $perSeed);
assert($matches[1] !== [], 'deploy musi pocet pozadavku na seed nastavovat');
foreach ($matches[1] as $deployed) {
    assert((int)$deployed <= $perSeed,
        'deploy nesmi nastavit vic pozadavku na seed (' . $deployed . ') nez kolik kod potrebuje (' . $perSeed . ')');
}

echo "\n== 9. automatika ma zapnuty cron, jinak nezpracuje nic ==\n";
// Kategorie se nedojede, kdyz tik nic nespusti. Sest dni se nedelo nic presne proto,
// ze tenhle trigger chybel.
$research = file_get_contents(__DIR__ . '/../../.github/workflows/email-campaign-ai-research.yml');
assert($research !== false, 'workflow AI research se musi precist');
assert(preg_match('/schedule:\s*\n\s*- cron:/', $research) === 1, 'AI research musi mit scheduled trigger');
printf("  trigger: %s\n", trim(preg_replace('/\s+/', ' ', (string)(preg_match("/- cron: '([^']+)'/", $research, $c) ? $c[1] : '?'))));

echo "\n== 9b. jedno spusteni musi odjet serii tiku, ne jediny ==\n";
// GitHub planovane behy na tomto repu zahazuje (mezery v hodinach misto peti minut),
// takze propustnost nesmi stat na kadenci rozvrhu. Jedno spusteni proto tiky opakuje.
assert(strpos($research, 'for call in $(seq 1 "$calls")') !== false,
    'workflow musi tiky opakovat ve smycce');
assert(strpos($research, 'ai_research=1&hop=2') !== false,
    'navazujici tik musi jit s hop=2, jinak ho zastavi interval guard');
assert(preg_match('/timeout-minutes:\s*(\d+)/', $research, $t) === 1 && (int)$t[1] >= 60,
    'serie tiku potrebuje dlouhy timeout jobu');
assert(preg_match('/cancel-in-progress:\s*false/', $research) === 1,
    'bezici serie tiku se nesmi zrusit prichodem dalsiho rozvrhu');
assert(strpos($research, 'AI research odlozen') !== false,
    'smycka musi skoncit, kdyz provider drzi limit');
assert(preg_match('/nebylo co zpracovat\|bez modelu uz neni co delat/', $research) === 1,
    'smycka musi skoncit i na prazdne fronte');
printf("  smycka: %s tiku na spusteni, timeout %s min\n",
    preg_match("/default: '(\d+)'/", $research, $d) ? $d[1] : '?', $t[1]);

echo "\nVSE OK\n";
