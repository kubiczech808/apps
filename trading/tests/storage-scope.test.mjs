// Runs offline: no secrets, no network, no database.
//
// The one property that makes serving reads from MySQL safe: a query narrowed by a
// portfolio's own rules must return a SUPERSET of what those rules keep. Tighter by a hair
// and it hides markets the portfolio would have traded -- and that failure has no symptom.
// Nothing errors, no page is empty, the portfolio just finds fewer candidates and there is
// nothing to notice.
//
// So this does not read either side. It executes the rules (api.php), executes the column
// extraction and the bounds (storage.php), and checks the implication on real row shapes.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");
const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8");

// api.php require_once's storage.php from its own directory, so both go into the temp root
// and the pair loads exactly as it does on the host -- api.php's no-storage fallback, which
// the other suites deliberately exercise, must NOT be the path taken here.
function evalPhp(expression, args, { storage = STORAGE } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "storage-scope-"));
  try {
    const cut = API.indexOf("\ntry {");
    assert.ok(cut > 0, "api.php still ends with its request dispatch");
    writeFileSync(join(directory, "storage.php"), storage);
    writeFileSync(join(directory, "definitions.php"), API.slice(0, cut) + "\n");
    const encoded = Buffer.from(JSON.stringify(args)).toString("base64");
    const output = execFileSync("php", ["-r",
      `require '${join(directory, "definitions.php")}';`
      + ` $args = json_decode(base64_decode('${encoded}'), true);`
      + ` echo json_encode(${expression});`,
    ], { encoding: "utf8" });
    return JSON.parse(output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const HOUR = 3600 * 1000;
const iso = (offsetHours) => new Date(Date.now() + offsetHours * HOUR).toISOString();

// Row shapes drawn from what the catalogue actually carries, each one aimed at a place the
// column and the rule could read different fields for the same question.
const ROWS = {
  // Liquidity: a live market that also carries the resolved figure. The rule weighs
  // volumeUsdc; a column that preferred resolvedVolumeUsdc read 120 where the rule read
  // 84000 and every liquidity floor above 120 then hid it.
  liquidTwoFigures: {
    id: "row-liquid-two-figures",
    tokenId: "1001",
    status: "SCRAPED",
    marketProbability: 0.74,
    volumeUsdc: 84000,
    resolvedVolumeUsdc: 120,
    netYield: 0.31,
    resolutionEndDate: iso(20),
    endDate: iso(18),
    bestBid: 0.73,
    bestAsk: 0.75,
    marketType: "binary",
    polymarketTags: ["esports"],
  },
  // Liquidity recorded only as `liquidity`, which is the rule's own fallback.
  liquidityOnly: {
    id: "row-liquidity-only",
    tokenId: "1002",
    status: "SCRAPED",
    marketProbability: 0.72,
    liquidity: 41000,
    netYield: 0.28,
    resolutionEndDate: iso(30),
    endDate: iso(28),
    bestBid: 0.71,
    bestAsk: 0.73,
    marketType: "binary",
    polymarketTags: ["esports"],
  },
  // A sports fixture: endDate is the kickoff, resolutionEndDate is settlement. The two are
  // different days and the rule weighs the second.
  fixture: {
    id: "row-fixture",
    tokenId: "1003",
    status: "SCRAPED",
    marketProbability: 0.77,
    volumeUsdc: 52000,
    netYield: 0.22,
    eventStartTime: iso(3),
    endDate: iso(3),
    resolutionEndDate: iso(9),
    bestBid: 0.76,
    bestAsk: 0.78,
    marketType: "binary",
    polymarketTags: ["sports"],
  },
  // No resolution date at all, only the frozen day count -- the rule's second reading.
  // endDate sits far past the horizon, which is what a column filled from endDate would
  // have used to drop it.
  dayCountOnly: {
    id: "row-day-count-only",
    tokenId: "1004",
    status: "SCRAPED",
    marketProbability: 0.71,
    volumeUsdc: 60000,
    netYield: 0.25,
    daysToResolution: 0.5,
    endDate: iso(400),
    bestBid: 0.7,
    bestAsk: 0.72,
    marketType: "binary",
    polymarketTags: ["esports"],
  },
  // Neither reading available: the rule cannot apply a horizon, so nothing may be dropped
  // for one. endDate is again far out, and again must not decide it.
  noHorizon: {
    id: "row-no-horizon",
    tokenId: "1005",
    status: "SCRAPED",
    marketProbability: 0.79,
    volumeUsdc: 75000,
    netYield: 0.4,
    endDate: iso(900),
    bestBid: 0.78,
    bestAsk: 0.8,
    marketType: "binary",
    polymarketTags: ["esports"],
  },
};

const CONFIGS = {
  band: { minProbability: 0.7, maxProbability: 0.8, maxResolutionHours: 48 },
  floor: { minProbability: 0.63, minLiquidityUsdc: 30000, maxResolutionHours: 48 },
  strict: { minProbability: 0.7, maxProbability: 0.8, minLiquidityUsdc: 40000, maxResolutionHours: 24 },
  // A horizon that is not a bound at all: under "only" the ceiling is not a rule, so no
  // clause may be compiled from it.
  inPlay: { minProbability: 0.6, liveEventMode: "only", maxResolutionHours: 6 },
};

// Every row against every portfolio, decided by the file rather than restated here.
function scopeVerdicts() {
  const cases = [];
  for (const [rowName, row] of Object.entries(ROWS)) {
    for (const [configName, config] of Object.entries(CONFIGS)) {
      cases.push({ label: `${rowName} / ${configName}`, row, config });
    }
  }
  return evalPhp(
    `array_map(static function (array $case): array {
        $config = normalize_portfolio_config(['paper' => ['probe' => $case['config']]])['paper']['probe'];
        $criteria = execution_scope_storage_criteria($config);
        $columns = trading_storage_observation_columns($case['row']);
        return [
          'label' => $case['label'],
          'criteria' => $criteria,
          'ruleKeeps' => execution_scope_matches_observation($case['row'], $config),
          'queryReturns' => trading_storage_scope_admits($columns, $criteria),
          'endAt' => $columns['endAt'],
          'volume' => $columns['volume'],
          'probability' => $columns['probability'],
        ];
     }, $args)`,
    cases,
  );
}

test("scoped query: every market the rules keep, the query still returns", () => {
  const verdicts = scopeVerdicts();
  assert.equal(verdicts.length, Object.keys(ROWS).length * Object.keys(CONFIGS).length);

  // A run where no portfolio keeps anything would pass this vacuously, which is how a
  // superset check quietly stops testing. The fixtures exist to be kept.
  const kept = verdicts.filter((verdict) => verdict.ruleKeeps);
  assert.ok(kept.length >= 8, `fixtures must exercise the kept path, got ${kept.length}`);

  for (const verdict of kept) {
    assert.equal(verdict.queryReturns, true,
      `${verdict.label}: the rules keep this market and the scoped query drops it`
      + ` -- criteria ${JSON.stringify(verdict.criteria)},`
      + ` stored endAt ${verdict.endAt}, volume ${verdict.volume}, probability ${verdict.probability}`);
  }
});

test("scoped query: the bounds still narrow, they have not become a no-op", () => {
  // The cheapest way to satisfy a superset test is to stop filtering. Every clause must
  // still exclude a row it is supposed to exclude.
  const excluded = evalPhp(
    `array_map(static function (array $case): bool {
        return trading_storage_scope_admits($case['columns'], $case['criteria']);
     }, $args)`,
    [
      { columns: { probability: 0.5, endAt: null, volume: null }, criteria: { minProbability: 0.7 } },
      { columns: { probability: 0.95, endAt: null, volume: null }, criteria: { maxProbability: 0.8 } },
      { columns: { probability: 0.75, endAt: "2030-01-01 00:00:00", volume: null }, criteria: { endBefore: "2026-01-01 00:00:00" } },
      { columns: { probability: 0.75, endAt: null, volume: 900 }, criteria: { minLiquidityUsdc: 30000 } },
      { columns: { probability: null, endAt: null, volume: null }, criteria: { minProbability: 0.7 } },
    ],
  );
  assert.deepEqual(excluded, [false, false, false, false, false]);

  const admitted = evalPhp(
    `array_map(static function (array $case): bool {
        return trading_storage_scope_admits($case['columns'], $case['criteria']);
     }, $args)`,
    [
      { columns: { probability: 0.75, endAt: null, volume: null }, criteria: { minProbability: 0.7, maxProbability: 0.8 } },
      // Unknown is not late, and unknown is not illiquid: a row that cannot answer is left
      // for the payload rules to judge rather than dropped where nothing can see it.
      { columns: { probability: 0.75, endAt: null, volume: null }, criteria: { endBefore: "2026-01-01 00:00:00", minLiquidityUsdc: 30000 } },
      { columns: { probability: 0.75, endAt: "2025-06-01 00:00:00", volume: 80000 }, criteria: { endBefore: "2026-01-01 00:00:00", minLiquidityUsdc: 30000 } },
    ],
  );
  assert.deepEqual(admitted, [true, true, true]);
});

test("the query is built from the same bounds the check uses", () => {
  // The table exists so the WHERE and the predicate cannot drift apart. If a clause is ever
  // added straight into the SQL string, this is what notices.
  const forScope = STORAGE.slice(
    STORAGE.indexOf("function trading_storage_observations_for_scope"),
    STORAGE.indexOf("function trading_storage_observations_fetch"),
  );
  assert.ok(forScope.length > 0, "trading_storage_observations_for_scope is still there to check");
  assert.match(forScope, /foreach \(trading_storage_scope_clauses\(\) as \$name => \$clause\)/,
    "the scoped query must build its WHERE from trading_storage_scope_clauses()");

  // Two clauses are not portfolio bounds and belong in the query itself: the lifecycle, and
  // the window that decides what counts as the current catalogue. Anything else added by
  // hand is a bound that no longer has a predicate beside it.
  const handWritten = [...forScope.matchAll(/\$where\[\] = '([^']+)'/g)].map((match) => match[1]);
  const bounds = handWritten.filter((clause) =>
    !/^lifecycle = :lifecycle$/.test(clause) && !/^updated_at >= :freshSince$/.test(clause));
  assert.deepEqual(bounds, [],
    `these clauses bypass the shared bounds table: ${JSON.stringify(bounds)}`);

  const clauses = evalPhp("array_keys(trading_storage_scope_clauses())", []);
  assert.deepEqual(clauses.sort(), ["endBefore", "maxProbability", "minLiquidityUsdc", "minProbability"]);
});

test("stored columns read the same fields the rules read", () => {
  // The packed payload is binary and would take json_encode down with it, so only the
  // columns a bound can ask about come back.
  const columns = evalPhp(
    `array_map(static fn (array $row): array => array_intersect_key(
        trading_storage_observation_columns($row),
        array_flip(['endAt', 'volume', 'probability', 'lifecycle']),
     ), $args)`,
    [ROWS.liquidTwoFigures, ROWS.fixture, ROWS.dayCountOnly, ROWS.noHorizon],
  );

  // Liquidity is what the rule weighs, not the richer figure beside it.
  assert.equal(columns[0].volume, 84000);

  // A fixture settles after it kicks off, and the column records the settlement.
  const fixtureEnd = Date.parse(`${columns[1].endAt}Z`);
  assert.ok(fixtureEnd - Date.now() > 7 * HOUR,
    `fixture endAt ${columns[1].endAt} looks like the kickoff, not the settlement`);

  // A frozen day count anchored to the scan, never the far-off endDate beside it.
  const dayCountEnd = Date.parse(`${columns[2].endAt}Z`);
  assert.ok(dayCountEnd - Date.now() < 14 * HOUR,
    `daysToResolution 0.5 stored as ${columns[2].endAt}`);

  // Nothing to answer with is NULL, so no horizon clause can act on it.
  assert.equal(columns[3].endAt, null);
});

test("stored time and compared time are the same clock", () => {
  // Measured on production: 40 sampled rows, every one reporting an age of exactly 122
  // minutes. Not a distribution -- one value, which is what a clock offset looks like and
  // what a real lag never does. trading_storage_now() writes UTC through gmdate() while
  // MySQL's NOW() answered in the server's own zone, two hours ahead in summer, so a row
  // written this second read as two hours old. It was diagnosed as "the mirror has not
  // written for two hours". The mirror had been writing the whole time.
  //
  // Nothing broke then only because the catalogue window is three days wide and swallowed
  // the offset. Tighten that window and the catalogue empties with no error at all.
  const connect = STORAGE.slice(
    STORAGE.indexOf("function trading_storage_pdo"),
    STORAGE.indexOf("function trading_storage_bootstrap"),
  );
  assert.match(connect, /SET time_zone = '\+00:00'/,
    "the session must be put on the same clock the rows are written in");

  // And the comparison the whole candidate list hangs on does not depend on two clocks
  // agreeing at all: the bound is computed in PHP, in UTC, and bound as a parameter.
  const [freshSince, phpNow, freshMinutes] = evalPhp(
    "[trading_storage_catalogue_fresh_since(), gmdate('Y-m-d H:i:s'), trading_storage_catalogue_fresh_minutes()]",
    [],
  );
  const gap = (Date.parse(`${phpNow}Z`) - Date.parse(`${freshSince}Z`)) / 60000;
  assert.ok(Math.abs(gap - freshMinutes) < 2,
    `the window must open exactly ${freshMinutes} minutes back, opened ${gap}`);
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(freshSince),
    `and in the column's own format: ${freshSince}`);

  // No NOW() may decide what is current any more -- that is the clock that was wrong.
  for (const name of ["trading_storage_observations_for_scope", "trading_storage_observations_fetch"]) {
    const start = STORAGE.indexOf(`function ${name}`);
    const body = STORAGE.slice(start, STORAGE.indexOf("\n}", start));
    assert.doesNotMatch(body, /NOW\(6?\) - INTERVAL/,
      `${name} must take its freshness bound from PHP, not from the database's clock`);
    assert.match(body, /freshSince/, `${name} must bind the computed bound`);
  }
});

test("the upsert writes exactly these columns", () => {
  // The extraction is only worth testing if the write still goes through it.
  const upsert = STORAGE.slice(
    STORAGE.indexOf("function trading_storage_observations_upsert"),
    STORAGE.indexOf("function trading_storage_observation_age"),
  );
  assert.ok(upsert.length > 0, "the upsert is still there to check");
  assert.match(upsert, /\$statement->execute\(trading_storage_observation_columns\(\$item\)\)/,
    "the upsert must bind trading_storage_observation_columns()");

  const bound = evalPhp("array_keys(trading_storage_observation_columns($args))", ROWS.fixture);
  // The trades upsert has an ON DUPLICATE KEY UPDATE of its own earlier in the file, so the
  // end of this statement is searched from its start rather than from the top.
  const insertAt = STORAGE.indexOf("INSERT INTO trading_observations");
  assert.ok(insertAt > 0, "the observations INSERT is still there to check");
  const placeholders = [...STORAGE.slice(
    insertAt,
    STORAGE.indexOf("ON DUPLICATE KEY UPDATE", insertAt),
  ).matchAll(/:([a-zA-Z]+)/g)].map((match) => match[1]);
  assert.ok(placeholders.length > 0, "the INSERT still binds named placeholders");
  assert.deepEqual(placeholders.sort(), bound.sort(),
    "every placeholder in the INSERT must be bound by the column extraction, and vice versa");
});
