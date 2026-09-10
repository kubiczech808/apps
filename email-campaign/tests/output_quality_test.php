<?php
/**
 * Kvalita vystupu AI research, merena na skutecnych vystupech z produkce.
 *
 * Propustnost na free tieru se zvysuje setrenim pozadavku - zebrikem modelu a
 * davkovanim vic vystupu do jedne odpovedi. Kvalita je pritom to hlavni, takze
 * musi byt pineovana testem, ne posuzovana dojmem. Oba pripady nize jsou konkretni
 * behy, ktere prosly do produkce spatne.
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
foreach (['AI_RESEARCH_MIN_PLAN_CONFIDENCE'] as $c) {
    preg_match('/const ' . $c . ' = ([^;]+);/', $src, $m);
    eval('const ' . $c . ' = ' . $m[1] . ';');
}
function truncatePlainText(string $t, int $l): string { return mb_substr($t, 0, $l); }
foreach (['aiResearchFoldText', 'aiResearchIsGenericCatalogKeyword',
          'aiResearchNormalizeCatalogKeyword', 'aiResearchPrimaryKeyword',
          'aiResearchTextHasPlaceholder',
          'aiResearchGenericOutreachPhrases', 'aiResearchPlanConfidenceTooLow',
          'aiResearchSubjectMatchesSegment', 'aiResearchSeedOutreachIsSpecific'] as $fn) {
    eval(extractFn($src, $fn));
}

echo "== 1. model, ktery si planem neni jisty, nesmi cilit podle nazvu firmy ==\n";
// Beh #159 "Zajisteni sidla firem s.r.o." z produkce. Model do pochopeni firmy sam
// napsal, ze web prezentuje repliky hodinek a jde nejspis o napadenou prezentaci -
// a presto se naplanovalo cileni na ucetni kancelare, tedy podle NAZVU firmy, coz
// prompt vyslovne zakazuje. Jistotu si model dal 35 %, kdezto pouzitelne plany
// hlasily 85-90 %.
$hijacked = [
    'confidence' => 35,
    'confidence_notes' => 'Obsah webu nesouvisi s nazvem firmy.',
    'business_understanding' => 'Webove stranky prezentuji online nabidku svycarskych replik hodinek.',
    'primary_segment' => 'Ucetni kancelare a danovi poradci',
];
$reason = aiResearchPlanConfidenceTooLow($hijacked);
printf("  jistota 35 %% -> %s\n", $reason !== '' ? 'seed nevhodny' : 'CHYBA: plan projde');
assert($reason !== '', 'plan s jistotou 35 % se nesmi pouzit');
assert(str_contains($reason, '35'), 'duvod ma rict, jak nizka jistota byla');
assert(str_contains($reason, 'nesouvisi'), 'duvod ma prevzit poznamku modelu');
// Pouzitelne plany z te same davky projit musi, jinak by kontrola zastavila praci.
foreach ([85, 90, 70, 50] as $ok) {
    assert(aiResearchPlanConfidenceTooLow(['confidence' => $ok]) === '',
        'jistota ' . $ok . ' % je v poradku a nesmi seed zahodit');
}
printf("  hranice: pod %d %% nevhodny, od %d %% se pracuje\n",
    AI_RESEARCH_MIN_PLAN_CONFIDENCE, AI_RESEARCH_MIN_PLAN_CONFIDENCE);
// Chybejici jistota neni duvod k zahozeni - starsi behy ji nemaji vubec.
assert(aiResearchPlanConfidenceTooLow([]) === '', 'bez udane jistoty se plan nezahazuje');
assert(aiResearchPlanConfidenceTooLow(['confidence' => 0]) === '', 'nula znamena neuvedeno');
// A zahazuje se bez dalsiho pozadavku: opakovani by na tomtez webu dalo totez.
$planFn = extractFn($src, 'aiResearchPlan');
assert(strpos($planFn, "\$plan['seed_unsuitable'] = true;") !== false,
    'nizka jistota se resi oznacenim seedu, ne vyjimkou');
assert(strpos($planFn, 'aiResearchPlanConfidenceTooLow($plan)') < strpos($planFn, 'aiResearchAssertPlanQuality($plan)'),
    'jistota se testuje driv, nez se plan zamitne jako obecny');

echo "\n== 2. predmet osloveni nesmi mluvit o jinem segmentu nez plan ==\n";
// Beh #156 z produkce: plan cilil na prazske IT firmy (keyword "softwarova firma"),
// ale predmet zval k "Akvizice logistickych firem v okoli D1 pro Hotel U Ledu".
// Telo segment zminovalo, takze puvodni kontrola, ktera cetla jen telo, to propustila.
$itPlan = [
    'scraping_queries' => [['source' => 'firmy_cz', 'keyword' => 'softwarova firma']],
    'audience_label' => 'Prazske IT firmy hledajici misto pro firemni vyjezdy a teambuildingy',
    'primary_segment' => 'IT a softwarove spolecnosti (Praha)',
];
$wrong = 'Akvizice logistickych firem v okoli D1 pro Hotel U Ledu';
printf("  %s\n    -> %s\n", $wrong,
    aiResearchSubjectMatchesSegment($wrong, $itPlan) ? 'CHYBA: projde' : 'zamitnuto');
assert(!aiResearchSubjectMatchesSegment($wrong, $itPlan),
    'predmet o logistickych firmach nesmi projit u planu na softwarove firmy');
$right = 'Akvizice 6 softwarovych firem v Praze pro Hotel U Ledu';
printf("  %s\n    -> %s\n", $right,
    aiResearchSubjectMatchesSegment($right, $itPlan) ? 'ok' : 'CHYBA: zamitnuto');
assert(aiResearchSubjectMatchesSegment($right, $itPlan), 'spravny predmet projit musi');

echo "\n== 2b. cestina se sklonuje, takze se porovnavaji zaklady slov ==\n";
// Skutecne predmety z produkce, ktere jsou v poradku a projit musi. Plan rika
// "stavebni firmy", predmet "stavebnich firem" - cele slovo se nikdy nepotka.
$buildPlan = [
    'scraping_queries' => [['source' => 'firmy_cz', 'keyword' => 'stavebni firma']],
    'audience_label' => 'stavebni firmy resici smlouvy o dilo, stavebni pravo a spravu neproplacenych faktur',
    'primary_segment' => 'Stavebni firmy',
];
foreach ([
    'Navrh osloveni 6 stavebnich firem pro sluzby externiho pravniho oddeleni',
    'Akvizice 6 stavebnich firem pro Partner 4 Office',
] as $subject) {
    printf("  %-72s -> %s\n", mb_substr($subject, 0, 72),
        aiResearchSubjectMatchesSegment($subject, $buildPlan) ? 'ok' : 'CHYBA');
    assert(aiResearchSubjectMatchesSegment($subject, $buildPlan),
        'skutecny spravny predmet z produkce musi projit: ' . $subject);
}
// Obecna slova nesmi kontrolu zachranit: "firem" sedi na cokoli, prave proto
// puvodni kontrola propustila predmet o uplne jinem odvetvi.
assert(!aiResearchSubjectMatchesSegment('Akvizice 6 firem pro nasi nabidku', $buildPlan),
    '"firem" samo o sobe nesmi stacit, sedi na kazdy segment');
// Plan bez konkretniho slova nelze vyvratit - kontrola nema co porovnavat.
assert(aiResearchSubjectMatchesSegment('Cokoli', ['scraping_queries' => []]),
    'bez konkretniho slova v planu se predmet nezamita');

echo "\n== 3. kontrola je zapojena v ceste, kde osloveni vznika ==\n";
$gate = extractFn($src, 'aiResearchSeedOutreachIsSpecific');
assert(strpos($gate, 'aiResearchSubjectMatchesSegment($subject, $plan, $segment)') !== false,
    'kontrola predmetu musi byt v brane pro osloveni seedu');
// Brana vraci duvod, ktery se loguje - hromadna odpoved se pak zahodi a osloveni
// se vygeneruje samostatnym pozadavkem, takze spatny predmet neprojde do produkce.
$bundle = 'Osloveni z hromadne odpovedi zahozen';
assert(strpos($src, 'AI research seed outreach z hromadne odpovedi zahozen') !== false,
    'zahozeni hromadneho osloveni musi byt videt v logu');
echo "  ok\n";

echo "\nVSE OK\n";
