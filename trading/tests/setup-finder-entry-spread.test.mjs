// Runs offline: api.php's real spread functions are EXECUTED against rows shaped like the
// resolved archive. No network, no database, no credentials.
//
// Reported, with a screenshot: the Setup finder showed valorant at 100.0% accuracy over 36
// trades. "neverim jim. ja sam jsem mel otevrene pozice v valorant a kazda vyherni nebyla."
//
// Measured against the resolved archive on 18.9.: valorant holds 98 rows, 86 of which settle
// cleanly -- 65 wins and 21 losses, 75.6%. Every entry quote came from firstMarketProbability
// and nothing was skipped for a missing price, so the three obvious explanations were all
// wrong. The finder saw 36 of those 86 and every one was a win.
//
// The filter that removed the other 50 was the spread test, and it was reading the LAST
// recorded book. On a resolved market that is the book after the result was effectively
// known: a market heading to zero has a collapsing, wide book, one heading to one stays
// tight. So the simulation asked "would this have been tradable?" and answered with evidence
// from after the outcome -- keeping winners and dropping losers.
//
// This is a look-ahead bias, so the test is written as one: the same market, twice, differing
// only in what happened to its book AFTER entry.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");

function extractPhpFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > 0, `${signature} must exist in api.php`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, "the function must be complete");
  return source.slice(start, end + 2);
}

const FUNCTIONS = [
  extractPhpFunction(API, "function observation_spread(array $item): ?float"),
  extractPhpFunction(API, "function observation_spread_is_tradable(array $item, bool $unknownIsTradable = false): bool"),
  extractPhpFunction(API, "function observation_entry_spread(array $item): ?float"),
  extractPhpFunction(API, "function observation_entry_spread_is_tradable(array $item): bool"),
].join("\n");

function judge(rows) {
  const dir = mkdtempSync(join(tmpdir(), "entry-spread-"));
  const script = join(dir, "run.php");
  writeFileSync(script, `<?php
const MAX_TRADABLE_SPREAD = 0.05;
${FUNCTIONS}
$rows = json_decode(${JSON.stringify(JSON.stringify(rows))}, true);
$out = [];
foreach ($rows as $row) {
    $out[] = [
        'entrySpread' => observation_entry_spread($row),
        'entryTradable' => observation_entry_spread_is_tradable($row),
        'liveSpread' => observation_spread($row),
        'liveTradable' => observation_spread_is_tradable($row),
    ];
}
echo json_encode($out);
`);
  return JSON.parse(execFileSync("php", [script], { encoding: "utf8" }));
}

// One market, entered on a tight book at 74%. The only difference is what its book did
// afterwards -- which is precisely what a decision made at entry cannot know.
const winner = {
  firstMarketProbability: 0.74, firstSpread: 0.01,
  marketProbability: 0.99, spread: 0.01, finalOutcomePrice: 1,
};
const loser = {
  firstMarketProbability: 0.74, firstSpread: 0.01,
  // The book fell apart on the way to zero, which is what a losing market's book does.
  marketProbability: 0.01, spread: 0.40, finalOutcomePrice: 0,
};

test("the same entry is judged the same way whatever happened next", () => {
  const [w, l] = judge([winner, loser]);
  assert.equal(w.entryTradable, true, "tight book at entry, and it won");
  assert.equal(l.entryTradable, true, "the SAME tight book at entry, and it lost");
  assert.equal(w.entrySpread, l.entrySpread, "the entry books are identical by construction");
});

test("the old rule kept the winner and dropped the loser -- the bias, demonstrated", () => {
  // Not an assertion about deleted code: observation_spread_is_tradable is still the live
  // shortlist's rule and is still exported here, so this RUNS it on the same two rows.
  const [w, l] = judge([winner, loser]);
  assert.equal(w.liveTradable, true);
  assert.equal(l.liveTradable, false,
    "judged on the book after the result, the loser is excluded and the accuracy climbs");
  // Which is the whole mechanism: identical decisions, opposite verdicts, decided by the
  // outcome.
  assert.notEqual(w.liveTradable, l.liveTradable);
  assert.equal(w.entryTradable, l.entryTradable);
});

test("a market with a genuinely wide book AT ENTRY is still excluded", () => {
  // The filter must keep working. Removing the bias is not the same as removing the rule:
  // a market nobody could have traded into should not count as a trade we would have made.
  const [row] = judge([{ firstMarketProbability: 0.74, firstSpread: 0.30, spread: 0.01 }]);
  assert.equal(row.entryTradable, false, "wide at entry means no fill, whatever it did later");
});

test("a row that never recorded an entry book is admitted, not dropped", () => {
  // Most of the archive predates spread collection. Dropping those rows applies a rule they
  // never had a chance to meet and silently shrinks the population -- which is the same
  // failure in a different direction.
  const [noBook] = judge([{ firstMarketProbability: 0.74, finalOutcomePrice: 0 }]);
  assert.equal(noBook.entrySpread, null);
  assert.equal(noBook.entryTradable, true);
});

test("the entry rule never falls back to the current book", () => {
  // The fallback is what would quietly reintroduce the bias: a resolved row almost always
  // carries a current spread, so a chain that tried firstSpread and then spread would use
  // the post-outcome book for exactly the rows that lack an entry one.
  const [row] = judge([{ firstMarketProbability: 0.5, spread: 0.40, bestAsk: 0.9, bestBid: 0.5 }]);
  assert.equal(row.entrySpread, null, "no entry book means unknown, not the live one");
  assert.equal(row.entryTradable, true);
  assert.equal(row.liveSpread, 0.4, "while the live rule does see it, which is correct there");

  const source = extractPhpFunction(API, "function observation_entry_spread(array $item): ?float");
  assert.doesNotMatch(source, /'spread'/, "only the first-observation fields may be read");
  assert.doesNotMatch(source, /'bestAsk'/);
  assert.doesNotMatch(source, /'bestBid'/);
  assert.match(source, /firstSpread/);
  assert.match(source, /firstBestAsk/);
});

test("the Setup finder uses the entry rule, and the live shortlist still uses the other", () => {
  const finder = API.slice(API.indexOf("if ($action === 'resolved-combinations') {"));
  const body = finder.slice(0, finder.indexOf("\n    if ($action ==="));
  assert.match(body, /observation_entry_spread_is_tradable\(\$item\)/,
    "the historical simulation judges on the entry book");
  assert.doesNotMatch(body, /observation_spread_is_tradable\(/,
    "and never on the current one");

  // The live rule is untouched: it is right where it is used, and changing it would have
  // loosened the shortlist that places real orders.
  assert.ok(API.includes("function observation_spread_is_tradable(array $item, bool $unknownIsTradable = false): bool"),
    "the live tradability rule must still exist");
});
