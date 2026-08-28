<?php
/**
 * Poskytovatel AI se da prepnout z aplikace a pri vycerpane kvote se beh prepne na
 * zalozni klic uvnitr tehoz pozadavku. Retez tiku zajistuje propustnost: jeden cron
 * navaze dalsi tik, dokud je prace a rozpocty to dovoli.
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
preg_match('/const AI_RESEARCH_MAX_CHAIN_HOPS = (\d+);/', $src, $m);
eval('const AI_RESEARCH_MAX_CHAIN_HOPS = ' . $m[1] . ';');
foreach (['aiResearchProviderKey', 'aiResearchProviderPreference', 'aiResearchProviderName',
          'aiResearchProviderExhausted', 'aiResearchMarkProviderExhausted', 'aiResearchErrorIsQuota',
          'aiResearchModelText'] as $fn) {
    eval(extractFn($src, $fn));
}

function conf(array $ai): array { return ['ai' => $ai]; }
$both = ['openai_api_key' => 'sk-x', 'gemini_api_key' => 'AIza-y'];

echo "== 1. rucni volba poskytovatele ==\n";
$cases = [
    ['auto', $both, 'openai', ['openai', 'gemini']],
    ['openai', $both, 'openai', ['openai', 'gemini']],
    ['gemini', $both, 'gemini', ['gemini', 'openai']],
    ['openai', ['gemini_api_key' => 'AIza-y'], 'gemini', ['gemini']],
    ['gemini', ['openai_api_key' => 'sk-x'], 'openai', ['openai']],
];
foreach ($cases as [$choice, $keys, $expected, $order]) {
    $config = conf($keys + ['research_provider' => $choice]);
    $got = aiResearchProviderName($config);
    printf("  volba %-7s klice %-16s -> %-7s (poradi %s)\n", $choice,
        implode('+', array_keys($keys)), $got, implode(',', aiResearchProviderPreference($config)));
    assert($got === $expected, $choice . ': ocekavam ' . $expected . ', mam ' . $got);
    assert(aiResearchProviderPreference($config) === $order, 'poradi u volby ' . $choice);
}

echo "\n== 2. vycerpana kvota prepne na zalohu ==\n";
$config = conf($both + ['research_provider' => 'openai']);
assert(aiResearchProviderName($config) === 'openai', 'zacina se u OpenAI');
$fallback = aiResearchMarkProviderExhausted($config, 'openai', 600);
printf("  OpenAI hlasi kvotu -> zaloha: %s, dalsi pozadavek jde na: %s\n", $fallback, aiResearchProviderName($config));
assert($fallback === 'gemini', 'zaloha je Gemini');
assert(aiResearchProviderName($config) === 'gemini', 'dalsi pozadavek uz jde na Gemini');
assert(aiResearchProviderExhausted('openai'), 'OpenAI je oznaceny jako vycerpany');
// Bez zalozniho klice neni kam prepnout.
$onlyOpenAi = conf(['openai_api_key' => 'sk-x']);
assert(aiResearchMarkProviderExhausted($onlyOpenAi, 'openai', 600) === '', 'bez druheho klice zadna zaloha');
// Kdyz je vycerpane vsechno, vrati se preferovany, aby chyba vznikla tam.
$fallback2 = aiResearchMarkProviderExhausted($config, 'gemini', 600);
printf("  i Gemini hlasi kvotu -> zaloha: '%s', poskytovatel: %s\n", $fallback2, aiResearchProviderName($config));
assert($fallback2 === '', 'uz neni kam prepnout');
assert(aiResearchProviderName($config) === 'openai', 'vraci se preferovany');
aiResearchProviderExhausted('openai', 0);
aiResearchProviderExhausted('gemini', 0);

echo "\n== 3. rozpoznani kvotove chyby ==\n";
$quota = [
    'You exceeded your current quota, please check your plan and billing details',
    'Rate limit reached for gpt-4.1 in organization org-x on requests per min (RPM): Limit 500',
    'HTTP 429 Too Many Requests',
    'insufficient_quota',
    'Resource has been exhausted (e.g. check quota)',
];
foreach ($quota as $message) {
    printf("  %-58s -> kvota\n", substr($message, 0, 58));
    assert(aiResearchErrorIsQuota($message), 'ma se poznat jako kvota: ' . $message);
}
foreach (['Model gpt-9 not found', 'Could not connect to api.openai.com', 'invalid_api_key'] as $message) {
    printf("  %-58s -> jina chyba\n", substr($message, 0, 58));
    assert(!aiResearchErrorIsQuota($message), 'nesmi se povazovat za kvotu: ' . $message);
}

echo "\n== 4. fallback je v ceste volani, ne az v dalsim cronu ==\n";
$callFn = extractFn($src, 'aiResearchModelCall');
assert(strpos($callFn, 'aiResearchErrorIsQuota') !== false, 'kvotova chyba se rozpozna');
assert(strpos($callFn, 'aiResearchMarkProviderExhausted') !== false, 'vycerpani se poznamena');
assert(substr_count($callFn, 'aiResearchCallProvider(') === 2, 'pozadavek se zkusi znovu na zaloze');
$providerCall = extractFn($src, 'aiResearchCallProvider');
assert(strpos($providerCall, "aiModelName(\$config, \$provider)") !== false, 'model odpovida providerovi po prepnuti');
echo "  ok\n";

echo "\n== 5. text odpovedi se cte podle formatu, ne podle nastaveni ==\n";
$gemini = ['steps' => [['content' => [['text' => '{"ok":1}']]]]];
$openai = ['output' => [['content' => [['text' => '{"ok":2}']]]]];
function geminiInteractionText(array $r): string { return 'gemini'; }
function openAiResponseText(array $r): string { return 'openai'; }
$asGemini = conf($both + ['research_provider' => 'gemini']);
printf("  odpoved Gemini pri nastaveni openai: %s\n", aiResearchModelText(conf($both + ['research_provider' => 'openai']), $gemini));
assert(aiResearchModelText(conf($both + ['research_provider' => 'openai']), $gemini) === 'gemini',
    'po fallbacku odpovida Gemini, i kdyz nastaveni rika openai');
assert(aiResearchModelText($asGemini, $openai) === 'openai', 'a naopak');

echo "\n== 6. nastaveni z aplikace prebiji deployment config ==\n";
$applyFn = extractFn($src, 'applySettingsToConfig');
foreach (['ai_research_provider', 'ai_openai_api_key', 'ai_gemini_api_key'] as $key) {
    assert(strpos($applyFn, "'" . $key . "'") !== false, 'nastaveni ma mapovat ' . $key);
}
assert(strpos($applyFn, "trim((string)(\$settings[\$settingKey] ?? '')) !== ''") !== false,
    'prazdna hodnota nesmi prepsat klic z deploymentu');
$saveFn = extractFn($src, 'saveAiResearchSettings');
assert(strpos($saveFn, "clear_' . \$name . '_key") !== false, 'klic jde smazat vlastni volbou');
assert(strpos($saveFn, "_exhausted_until', ''") !== false, 'ulozeni zapomene poznamku o vycerpani');
echo "  ok\n";

echo "\n== 7. retez tiku ==\n";
printf("  strop hopu: %d\n", AI_RESEARCH_MAX_CHAIN_HOPS);
assert(AI_RESEARCH_MAX_CHAIN_HOPS >= 4, 'retez ma dat vic prace nez jeden tik');
$chainFn = extractFn($src, 'aiResearchChainNextTick');
foreach ([
    'ai_research_next_allowed_at' => 'backoff zastavi retez',
    'denni rozpocet' => 'denni rozpocet zastavi retez',
    'nebylo co zpracovat' => 'prazdna fronta zastavi retez',
    'ai_research=1&hop=' => 'dalsi hop se opravdu posila',
] as $needle => $why) {
    assert(strpos($chainFn, $needle) !== false, $why);
}
$endpoint = substr($src, strpos($src, "if (isset(\$_GET['ai_research'])) {"), 900);
assert(strpos($endpoint, 'runCronAiResearch($pdo, $config, $hop > 1)') !== false,
    'navazany hop nesmi cekat na interval, jinak retez nic neudela');
assert(strpos($endpoint, 'aiResearchChainNextTick(') !== false, 'endpoint navazuje dalsi tik');
echo "  ok\n";

echo "\nVSE OK\n";
