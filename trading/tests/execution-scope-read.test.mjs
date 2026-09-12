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
  // ceiling is six pages; the stub has more rows than that, so the walk must stop.
  const rows = Array.from({ length: 20000 }, (_, index) => market(index));
  const result = runPhp(
    `(function () use ($args) {
        $kept = execution_scope_observations_from_storage(null);
        return ['kept' => count($kept), 'pages' => count($GLOBALS['scopeCalls'])];
     })()`,
    {},
    { rows },
  );
  assert.equal(result.pages, 6, "the walk stops at the ceiling rather than reading forever");
  assert.equal(result.kept, 12000);
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

test("only the execution summary asks for a scope", () => {
  // Every other view either wants the catalogue or a page of it, and neither is a scope.
  // Handing one of those a portfolio's scope would make markets disappear from it with no
  // error to notice.
  assert.match(API, /\$summary === 'execution'\n\s*\);/,
    "the state endpoint must pass the scope flag only for the execution summary");
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
