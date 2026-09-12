// Runs offline: no secrets, no network, no database.
//
// The read the whole migration turns on. Serving the execution shortlist from SQL means
// asking for one portfolio's markets instead of the catalogue -- the first cutover decoded
// all eight thousand payloads on every request, answered in 58 seconds and reset
// connections, and was rolled back inside five minutes.
//
// The query is stubbed here, so what is under test is the WALK: that it reaches the end of
// the scope, that it keeps only what the portfolio's rules admit, and that paging neither
// repeats nor skips a row. Those are the ways this fails silently -- a portfolio simply
// stops seeing candidates, with no error anywhere.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");
const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8");

// api.php require_once's storage.php from its own directory, so a stub placed there is what
// it loads. Only the one function the walk calls is defined; nothing else on this path
// touches the database.
const STUB_STORAGE = `<?php
$GLOBALS['scopeCalls'] = [];
function trading_storage_observations_for_scope(array $criteria, int $limit = 400, bool $freshOnly = true, int $offset = 0): array
{
    $GLOBALS['scopeCalls'][] = ['limit' => $limit, 'offset' => $offset, 'criteria' => $criteria];
    $rows = $GLOBALS['scopeRows'] ?? [];
    return array_slice($rows, $offset, $limit);
}
`;

function runPhp(expression, args, { rows = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "execution-scope-"));
  try {
    const cut = API.indexOf("\ntry {");
    assert.ok(cut > 0, "api.php still ends with its request dispatch");
    writeFileSync(join(directory, "storage.php"), STUB_STORAGE);
    writeFileSync(join(directory, "definitions.php"), API.slice(0, cut) + "\n");
    // Thousands of rows go through a file, not the command line: a fixture wide enough to
    // need a second page is also wide enough for execve to refuse the argument list.
    const rowsFile = join(directory, "rows.json");
    writeFileSync(rowsFile, JSON.stringify(rows));
    const encodedArgs = Buffer.from(JSON.stringify(args)).toString("base64");
    return JSON.parse(execFileSync("php", ["-r",
      `require '${join(directory, "definitions.php")}';`
      + ` $GLOBALS['scopeRows'] = json_decode(file_get_contents('${rowsFile}'), true);`
      + ` $args = json_decode(base64_decode('${encodedArgs}'), true);`
      + ` echo json_encode(${expression});`,
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const HOUR = 3600 * 1000;
const iso = (hours) => new Date(Date.now() + hours * HOUR).toISOString();

// A row the rules keep, unless an override pushes it out of the portfolio's band.
const market = (index, extra = {}) => ({
  id: `m${index}`,
  tokenId: String(index),
  status: "SCRAPED",
  marketProbability: 0.75,
  volumeUsdc: 90000,
  netYield: 0.3,
  resolutionEndDate: iso(10),
  endDate: iso(8),
  bestBid: 0.74,
  bestAsk: 0.76,
  marketType: "binary",
  polymarketTags: ["esports"],
  ...extra,
});

const CONFIG = { minProbability: 0.7, maxProbability: 0.8, minLiquidityUsdc: 30000, maxResolutionHours: 48 };

test("the scoped read walks to the end of the scope and keeps only what the rules admit", () => {
  // 2500 rows is more than one page, so the walk has to continue past the first. Every
  // tenth row sits outside the portfolio's band and must not survive.
  const rows = Array.from({ length: 2500 }, (_, index) =>
    market(index, index % 10 === 0 ? { marketProbability: 0.35 } : {}));

  const result = runPhp(
    `(function () use ($args) {
        $config = normalize_portfolio_config(['paper' => ['probe' => $args]])['paper']['probe'];
        $kept = execution_scope_observations_from_storage($config);
        return [
          'kept' => count($kept),
          'ids' => array_slice(array_map(static fn (array $row): string => (string) $row['id'], $kept), 0, 3),
          'unique' => count(array_unique(array_map(static fn (array $row): string => (string) $row['id'], $kept))),
          'calls' => $GLOBALS['scopeCalls'],
        ];
     })()`,
    CONFIG,
    { rows },
  );

  assert.equal(result.kept, 2250, "every row inside the band, and none outside it");
  assert.equal(result.unique, result.kept, "paging must not hand the same row back twice");
  assert.deepEqual(result.ids, ["m1", "m2", "m3"], "the walk starts at the top of the ranking");

  // Two full pages and a short one: the short page is what ends the walk.
  assert.equal(result.calls.length, 2, `pages walked: ${JSON.stringify(result.calls)}`);
  assert.deepEqual(result.calls.map((call) => call.offset), [0, 2000]);
  assert.equal(result.calls[0].limit, 2000);

  // And the portfolio's own rules reached the database as bounds, rather than every row
  // being fetched and filtered afterwards.
  assert.equal(result.calls[0].criteria.minProbability, 0.7);
  assert.equal(result.calls[0].criteria.maxProbability, 0.8);
  assert.equal(result.calls[0].criteria.minLiquidityUsdc, 30000);
});

test("a scope that never ends is still bounded", () => {
  // A portfolio that bounds nothing must not turn one request into an unbounded read. The
  // ceiling has to sit ABOVE the fresh catalogue: the database holds 25906 markets inside
  // the window, three times what the JSON file carried, and a ceiling below that would cut
  // a reward/risk portfolio's scope off by the wrong key.
  const rows = Array.from({ length: 50000 }, (_, index) => market(index));
  const result = runPhp(
    `(function () use ($args) {
        $kept = execution_scope_observations_from_storage(null);
        return ['kept' => count($kept), 'pages' => count($GLOBALS['scopeCalls'])];
     })()`,
    {},
    { rows },
  );
  assert.equal(result.pages, 20, "the walk stops at the ceiling rather than reading forever");
  assert.equal(result.kept, 40000, "and the ceiling clears the fresh catalogue with room over it");
});

test("a scope that fits in one page makes one round trip", () => {
  const rows = Array.from({ length: 40 }, (_, index) => market(index));
  const result = runPhp(
    `(function () use ($args) {
        $config = normalize_portfolio_config(['paper' => ['probe' => $args]])['paper']['probe'];
        return ['kept' => count(execution_scope_observations_from_storage($config)), 'pages' => count($GLOBALS['scopeCalls'])];
     })()`,
    CONFIG,
    { rows },
  );
  assert.equal(result.pages, 1, "a short first page is the end of the scope");
  assert.equal(result.kept, 40);
});

test("the walk stops once it holds the page asked for, and only when the ranking agrees", () => {
  // Measured on production: a portfolio bounded only by a probability floor walked six
  // pages in 2.05 seconds, to produce nineteen candidates for a page 1200 wide. Everything
  // past a full page was work that could not change the answer -- the database orders by
  // the same key the executor ranks by, so nothing further down can displace what is held.
  const rows = Array.from({ length: 12000 }, (_, index) => market(index));

  const early = runPhp(
    `(function () use ($args) {
        $kept = execution_scope_observations_from_storage(null, 1200);
        return ['kept' => count($kept), 'pages' => count($GLOBALS['scopeCalls'])];
     })()`,
    {},
    { rows },
  );
  assert.equal(early.pages, 1, "one page already holds more than the caller asked for");
  assert.equal(early.kept, 2000);

  // A caller reading the SECOND page needs the first page's rows still in front of it, so
  // the walk counts to the end of the requested page rather than to its width.
  const deep = runPhp(
    `(function () use ($args) {
        $kept = execution_scope_observations_from_storage(null, 1200 + 3000);
        return ['kept' => count($kept), 'pages' => count($GLOBALS['scopeCalls'])];
     })()`,
    {},
    { rows },
  );
  assert.equal(deep.pages, 3, `a deeper page needs a longer walk: ${JSON.stringify(deep)}`);
  assert.ok(deep.kept >= 4200, "and enough rows to reach the end of that page");

  // A portfolio ranked by reward/risk is ranked by something the query cannot order by, so
  // for that one the walk has to see the whole scope before it can rank it. Stopping early
  // there would hand the executor a page cut by the wrong key.
  const rewardRisk = runPhp(
    `(function () use ($args) {
        $config = normalize_portfolio_config(['paper' => ['probe' => $args]])['paper']['probe'];
        $kept = execution_scope_observations_from_storage($config, 1200);
        return ['pages' => count($GLOBALS['scopeCalls']), 'kept' => count($kept), 'order' => $config['selectionOrder'] ?? null];
     })()`,
    { ...CONFIG, selectionOrder: "highest_reward_risk_first" },
    { rows },
  );
  assert.equal(rewardRisk.order, "highest_reward_risk_first", "the fixture must actually set that order");
  // The whole scope, not a page of it: six full pages of 2000, then one more that comes
  // back empty and ends the walk. A full page never proves the scope ended.
  assert.equal(rewardRisk.pages, 7,
    "a ranking the query cannot express must be walked to the end of the scope");
  assert.equal(rewardRisk.kept, 12000, "and every row of that scope reaches the ranking");
});

test("only the execution summary asks for a scope", () => {
  // Every other view either wants the catalogue or a page of it, and neither is a scope.
  // Handing one of those a portfolio's scope would make markets disappear from it with no
  // error to notice.
  assert.match(API, /\$summary === 'execution',\n/,
    "the state endpoint must pass the scope flag only for the execution summary");
  // And how far the walk may read: the end of the page about to be cut, offset included.
  // Counting only one page's worth would serve a caller's second page out of nothing.
  assert.match(API, /\$summary === 'execution' \? max\(0, \$executionOffset\) \+ EXECUTION_SCOPE_PAGE_LIMIT : 0/,
    "the walk must be told the end of the requested page, not just its width");
  const payloadAt = API.indexOf("function state_payload(");
  assert.ok(payloadAt > 0, "state_payload must be findable");
  const payload = API.slice(payloadAt, API.indexOf("\nfunction ", payloadAt + 1));
  assert.ok(payload.length > 0, "state_payload must have a body to check");
  assert.match(payload, /if \(\$observationsScopedToStrategy\) \{\s*\n(?:.*\n)*?\s*\$document\['marketObservations'\] = execution_scope_observations_from_storage\(/,
    "the scoped branch must be the one that reads a scope");
  assert.match(payload, /trading_storage_observations_fetch\('SCRAPED', 0, 0, \$freshObservationsOnly\)/,
    "and the unscoped readers must keep the read they had");
});

test("the paged query orders totally, or a walk repeats and misses rows", () => {
  const scope = STORAGE.slice(
    STORAGE.indexOf("function trading_storage_observations_for_scope"),
    STORAGE.indexOf("function trading_storage_observations_fetch"),
  );
  assert.ok(scope.length > 0, "the scoped query must be findable");
  // annualized_return alone has thousands of ties -- every market with no return recorded
  // shares NULL -- and tied rows may come back in a different order on each page.
  assert.match(scope, /ORDER BY annualized_return DESC, end_at ASC, observation_key ASC/);
  // OFFSET is only legal after LIMIT; an offset alone would serve the scope again from row
  // zero, and the walk would never advance.
  assert.match(scope, /' LIMIT ' \. max\(1, min\(5000, \$limit\)\)[\s\S]*?\$offset > 0 \? ' OFFSET '/);
});
