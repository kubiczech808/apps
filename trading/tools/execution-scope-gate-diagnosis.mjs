// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Measured: the live portfolio "Live 72-82" is served a scoped execution catalogue of
// ELEVEN rows out of 1200 active scraped markets, and named markets that appear to meet
// every stored parameter -- "2nd Half Spread: VfB Stuttgart (-1.5)" at 78.0% with
// $22,347.98 volume and 2.2 days to resolution -- are not among them. The executor
// therefore never sees them: the cut happens server-side in
// execution_scope_matches_observation() before any JS filter runs.
//
// That function applies nine gates in sequence and returns false at the first one. A count
// of survivors says nothing about which. So this runs the REAL PHP function -- api.php is
// sliced above its request dispatch and included, exactly as the test suite does it -- once
// per row, and again gate by gate, so every rejection is attributed to a named gate with a
// count, and the markets asked about are reported with the value each gate compared.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const STRATEGY_ID = process.env.SCOPE_STRATEGY_ID || "live";
const FOCUS = (process.env.FOCUS_MARKETS || "koln;stuttgart;bayern;ipswich;liverpool;barcelona")
  .split(";").map((text) => text.trim().toLowerCase()).filter(Boolean);

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function main() {
  console.log(`Execution scope gate diagnosis at ${new Date().toISOString()}`);
  console.log(`Read-only: nothing is written, no credentials are used.`);
  console.log(`scope: ${STRATEGY_ID}   focus: ${FOCUS.join(", ")}\n`);

  // The unscoped scraped view is the population the scope filters. Taking it from
  // summary=scraped rather than summary=execution is the point: this asks what the scope
  // removed, so it must start from what the scope had to choose from.
  const scraped = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=scraped&t=${Date.now()}`)
    .then((payload) => payload?.state || payload || {});
  const rows = (Array.isArray(scraped.marketObservations) ? scraped.marketObservations : []);
  console.log(`active scraped rows available to the scope: ${rows.length}`);

  const configPayload = await fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`);
  const config = configPayload?.config || configPayload || {};

  // api.php, cut above the line where it starts answering a request. Including the whole
  // file would execute the dispatcher.
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");
  const cut = api.indexOf("\ntry {");
  if (cut < 0) throw new Error("could not find api.php's request dispatch to cut above");
  const library = api.slice(0, cut);

  const work = join(tmpdir(), `scope-gate-${process.pid}`);
  await mkdir(work, { recursive: true });
  const libraryPath = join(work, "api-library.php");
  await writeFile(libraryPath, library);
  await writeFile(join(work, "rows.json"), JSON.stringify(rows));
  await writeFile(join(work, "config.json"), JSON.stringify(config));

  // Each gate reproduced in the same order and with the same comparisons as
  // execution_scope_matches_observation, so the attribution is the real sequence -- and the
  // real function is called too, as a cross-check that this decomposition agrees with it.
  const script = `<?php
require ${JSON.stringify(libraryPath)};
$rows = json_decode(file_get_contents(${JSON.stringify(join(work, "rows.json"))}), true);
$configAll = json_decode(file_get_contents(${JSON.stringify(join(work, "config.json"))}), true);
$strategyId = ${JSON.stringify(STRATEGY_ID)};
$focus = ${JSON.stringify(FOCUS)};

if ($strategyId === 'live' || $strategyId === 'live5050') {
    $config = is_array($configAll[$strategyId] ?? null) ? $configAll[$strategyId] : [];
} elseif (preg_match('/^live-custom-([a-z][a-zA-Z0-9]{1,30})$/', $strategyId, $m) === 1) {
    $config = is_array($configAll['livePortfolios'][$m[1]] ?? null) ? $configAll['livePortfolios'][$m[1]] : [];
} else {
    $config = is_array($configAll['paper'][$strategyId] ?? null) ? $configAll['paper'][$strategyId] : [];
}
if ($config === []) { fwrite(STDERR, "no config for {$strategyId}\\n"); exit(1); }

function gate_failures(array $item, array $config): array
{
    $failed = [];
    if (!is_active_scraped_market_observation($item)) { $failed[] = 'not an active scraped observation'; }
    $probability = is_numeric($item['marketProbability'] ?? null) ? (float) $item['marketProbability'] : null;
    $minimum = normalize_probability_value($config['minProbability'] ?? null, 0.01);
    $maximum = normalize_optional_probability_value($config['maxProbability'] ?? null);
    if ($probability === null) { $failed[] = 'no market probability recorded'; }
    elseif ($probability < $minimum) { $failed[] = 'probability below minProbability'; }
    elseif ($maximum !== null && $probability > $maximum) { $failed[] = 'probability above maxProbability'; }
    $days = is_numeric($item['daysToResolution'] ?? null) ? (float) $item['daysToResolution'] : null;
    $maxDays = normalize_optional_days_value($config['maxResolutionDays'] ?? null);
    if ($days !== null && $maxDays !== null && $days > $maxDays) { $failed[] = 'resolution beyond maxResolutionDays'; }
    $minimumLiquidity = normalize_optional_money_value($config['minLiquidityUsdc'] ?? null);
    $liquidity = is_numeric($item['volumeUsdc'] ?? null) ? (float) $item['volumeUsdc'] : (float) ($item['liquidity'] ?? 0);
    if ($minimumLiquidity !== null && $liquidity < $minimumLiquidity) { $failed[] = 'volume below minLiquidityUsdc'; }
    if (!observation_spread_is_tradable($item, true)) { $failed[] = 'bid/ask spread not tradable'; }
    $minimumYield = normalize_net_yield_value($config['minNetYield'] ?? null, 0.0);
    if (is_numeric($item['netYield'] ?? null) && (float) $item['netYield'] < $minimumYield) { $failed[] = 'netYield below minNetYield'; }
    $marketType = normalize_portfolio_market_type_value($config['marketType'] ?? null, false);
    if ($marketType !== 'all' && observation_market_type($item) !== $marketType) { $failed[] = 'market type does not match'; }
    if (($config['excludeOverUnderMarkets'] ?? false) === true && observation_is_over_under_market($item)) { $failed[] = 'Over/Under excluded'; }
    $tags = execution_scope_observation_tags($item);
    $include = normalize_market_tag_list($config['includeOnlyMarketTags'] ?? []);
    if ($include !== [] && array_intersect($include, $tags) === []) { $failed[] = 'outside includeOnlyMarketTags'; }
    if ($include === []) {
        $exclude = normalize_market_tag_list($config['excludedMarketTags'] ?? []);
        $hit = array_intersect($exclude, $tags);
        if ($exclude !== [] && $hit !== []) { $failed[] = 'excluded tag: ' . implode('+', $hit); }
    }
    return $failed;
}

$counts = [];
$firstCounts = [];
$passed = 0;
$disagree = 0;
foreach ($rows as $item) {
    if (!is_array($item)) { continue; }
    $failed = gate_failures($item, $config);
    $real = execution_scope_matches_observation($item, $config);
    if (($failed === []) !== $real) { $disagree++; }
    if ($failed === []) { $passed++; continue; }
    foreach ($failed as $reason) { $counts[$reason] = ($counts[$reason] ?? 0) + 1; }
    $firstCounts[$failed[0]] = ($firstCounts[$failed[0]] ?? 0) + 1;
}

echo "\\n== the server's own gates over every active scraped row\\n";
echo "   rows examined                " . count($rows) . "\\n";
echo "   passed every gate            {$passed}\\n";
echo "   decomposition disagreements  {$disagree}   (must be 0, or this breakdown is not the real function)\\n";

echo "\\n   -- first gate that rejected each row (each row counted once) --\\n";
arsort($firstCounts);
foreach ($firstCounts as $reason => $count) { printf("   %6d  %s\\n", $count, $reason); }

echo "\\n   -- every gate a row failed (a row can fail several) --\\n";
arsort($counts);
foreach ($counts as $reason => $count) { printf("   %6d  %s\\n", $count, $reason); }

echo "\\n== the markets asked about\\n";
$found = 0;
foreach ($rows as $item) {
    if (!is_array($item)) { continue; }
    $haystack = strtolower(($item['question'] ?? '') . ' ' . ($item['outcome'] ?? '') . ' ' . ($item['slug'] ?? '') . ' ' . ($item['eventSlug'] ?? ''));
    $match = false;
    foreach ($focus as $needle) { if (strpos($haystack, $needle) !== false) { $match = true; break; } }
    if (!$match) { continue; }
    $found++;
    $failed = gate_failures($item, $config);
    echo "\\n-- \\"" . substr((string) ($item['question'] ?? ''), 0, 74) . "\\"\\n";
    echo "   outcome " . ($item['outcome'] ?? '-') . "   eventSlug " . ($item['eventSlug'] ?? '-') . "\\n";
    printf("   marketProbability %s   volumeUsdc %s   liquidity %s   daysToResolution %s\\n",
        var_export($item['marketProbability'] ?? null, true),
        var_export($item['volumeUsdc'] ?? null, true),
        var_export($item['liquidity'] ?? null, true),
        var_export($item['daysToResolution'] ?? null, true));
    printf("   bestBid %s   bestAsk %s   spread %s   maxTradable %s\\n",
        var_export($item['bestBid'] ?? null, true),
        var_export($item['bestAsk'] ?? null, true),
        var_export(observation_spread($item), true),
        var_export(MAX_TRADABLE_SPREAD, true));
    printf("   netYield %s   marketType %s   overUnder %s\\n",
        var_export($item['netYield'] ?? null, true),
        observation_market_type($item),
        var_export(observation_is_over_under_market($item), true));
    echo "   tags " . implode(', ', execution_scope_observation_tags($item)) . "\\n";
    if ($failed === []) { echo "   VERDICT: in scope\\n"; }
    else { echo "   VERDICT: rejected by " . count($failed) . " gate(s):\\n"; foreach ($failed as $reason) { echo "     - {$reason}\\n"; } }
}
if ($found === 0) { echo "   !! none of these markets is in the active scraped catalogue at all\\n"; }
`;

  const scriptPath = join(work, "gates.php");
  await writeFile(scriptPath, script);
  const output = execFileSync("php", [scriptPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  console.log(output);
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  if (error?.stderr) console.log(String(error.stderr).slice(0, 3000));
  process.exitCode = 1;
});
