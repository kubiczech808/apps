<?php
/**
 * Prehled AI research a log automatiky musi byt citelny i na telefonu. Karty pro uzke
 * displeje uz v CSS byly, ale nefungovaly ze dvou duvodu: bunky nemely data-label
 * (popisek karty byl prazdny) a desktopova sada pravidel - min-width 1608 px, pevne
 * sirky sloupcu a jednoradkove bunky - je specifictejsi, takze telefonni pravidla
 * prebila. Test hlida obe veci.
 */
$css = file_get_contents(__DIR__ . '/../assets/app.css');
$php = file_get_contents(__DIR__ . '/../index.php');

/** Vrati telo posledniho @media bloku, ktery odpovida hledanemu dotazu. */
function lastMediaBlock(string $css, string $query): string
{
    $needle = '@media ' . $query . ' {';
    $pos = strrpos($css, $needle);
    assert($pos !== false, 'chybi @media ' . $query);
    $depth = 0;
    for ($i = $pos + strlen($needle) - 1, $len = strlen($css); $i < $len; $i++) {
        if ($css[$i] === '{') { $depth++; }
        if ($css[$i] === '}') {
            $depth--;
            if ($depth === 0) {
                return substr($css, $pos, $i - $pos + 1);
            }
        }
    }
    throw new RuntimeException('neuzavreny @media blok');
}

echo "== 1. kazda bunka obou tabulek ma popisek pro kartu ==\n";
$labels = [
    // prehled AI research
    '#', 'Návrhy', 'Oslovení', 'Kdy', 'Seed byznys', 'Email', 'Databáze',
    'Klíčové slovo', 'Lokalita', 'Kontakty', 'K oslovení',
    // log automatiky
    'Stav', 'Naplánováno', 'Práce', 'Předmět', 'Model', 'Req.', 'Tokeny', 'Trvání', 'Zpráva',
];
foreach ($labels as $label) {
    assert(str_contains($php, 'data-label="' . $label . '"'), 'chybi data-label pro sloupec ' . $label);
}
printf("  popisku: %d\n", count($labels));
// Kroky workflow berou popisek ze stejneho checklistu jako hlavicka.
assert(str_contains($php, 'class="research-step-col" data-label="<?= h((string)$stepColumn[\'short\']) ?>"'),
    'kroky workflow maji popisek z checklistu');

echo "\n== 2. telefonni pravidla prebiji desktopovou sirku tabulky ==\n";
$phone = lastMediaBlock($css, '(max-width: 760px)');
assert(str_contains($phone, '.view-research .research-table,'), 'prehled je v telefonnim bloku');
assert(str_contains($phone, '.research-log-table {'), 'log je v telefonnim bloku');
assert(str_contains($phone, 'min-width: 0;'), 'sirka 1608 px se rusi');
// Desktopova pravidla musi byt v souboru DRIV, jinak by je telefonni neprebila.
$desktopWide = strpos($css, 'min-width: 1608px;');
$phoneStart = strrpos($css, '@media (max-width: 760px) {');
printf("  desktopova sirka na %d. znaku, telefonni blok od %d.\n", (int)$desktopWide, (int)$phoneStart);
assert($desktopWide !== false && $desktopWide < $phoneStart, 'telefonni pravidla musi byt az za desktopovymi');

echo "\n== 3. karta: hlavicka zmizi, bunky se skladaji pod sebe s popiskem ==\n";
foreach (['display: none;', 'content: attr(data-label);', 'white-space: normal;'] as $rule) {
    assert(str_contains($phone, $rule), 'chybi pravidlo karty: ' . $rule);
}
assert(str_contains($phone, '> tbody > tr:not(.detail-row) > td,'), 'bunky karty se stylují bez detailu radku');
assert(str_contains($phone, '.detail-row'), 'rozbaleny detail zustava mimo kartu');
echo "  ok\n";

echo "\n== 4. sedm kroku workflow je prouzek stitku, ne sedm radku ==\n";
$chipPos = strpos($phone, 'td.research-step-col {');
assert($chipPos !== false, 'kroky maji vlastni pravidlo');
$chip = substr($phone, $chipPos, 420);
assert(str_contains($chip, 'display: inline-flex;'), 'stitky sedi v jednom radku');
assert(str_contains($chip, 'width: auto !important;'), 'a nesmi je roztahnout sirka 100 % z obecneho pravidla');
echo "  ok\n";

echo "\n== 5. druhy radek a drobny text se na karte zobrazi ==\n";
// Na desktopu se skryvaji, aby radek zustal jednoradkovy; na karte je misto.
assert(str_contains($css, '> td br,'), 'desktop skryva zalomeni v radku');
assert(str_contains($phone, 'display: revert;'), 'na telefonu se zalomeni a drobny text vraci');
echo "  ok\n";

echo "\n== 6. zprava v logu dostane cely radek karty ==\n";
$msgPos = strpos($phone, '.research-log-message {');
assert($msgPos !== false, 'zprava ma vlastni pravidlo');
$msg = substr($phone, $msgPos, 200);
assert(str_contains($msg, 'grid-template-columns: minmax(0, 1fr);'), 'zprava se nezuzuje na 34 % sirky');
assert(str_contains($msg, 'min-width: 0;'), 'a rusi desktopovych 260 px');
echo "  ok\n";

echo "\nVSE OK\n";
