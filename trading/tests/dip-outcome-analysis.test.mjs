// Runs offline: the analysis tool's own arithmetic, executed. No network, no credentials.
// Importing the tool must not fire its reads, which the run guard at the bottom of it
// ensures and the last test here checks.
//
// This is a REPORTING tool, so the thing that can go wrong is not a crash -- it is a table
// that looks authoritative and says something false. Three ways that happens, one test each:
//
//   * a bucket boundary that silently drops rows, so a band reads better than it is;
//   * P/L per dollar computed off the stake instead of the cost, which flatters cheap
//     entries -- a 30% entry buys three times the shares a 90% entry does;
//   * the verified/mid-game split collapsing, which is the whole reason this tool exists.
//     Every trade opened before the opening-price fix was selected on a number that may
//     have been a mid-game price, and pooling those with the real ones would turn "where
//     should I set the opening band" into a question answered from noise.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { bucketOf, volumeBucket, summarise, openingIsVerified } from "../tools/dip-outcome-analysis.mjs";

const EDGES = [0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

test("every probability lands in exactly one bucket, and none falls through the floor", () => {
  assert.equal(bucketOf(0.35, EDGES), "30-50%");
  assert.equal(bucketOf(0.5, EDGES), "50-60%", "a value ON a boundary belongs to the bucket it opens");
  assert.equal(bucketOf(0.78, EDGES), "70-80%");
  assert.equal(bucketOf(0.995, EDGES), "90-100%");
  assert.equal(bucketOf(null, EDGES), "unknown", "a missing opening price must not be counted as a low one");

  // The bait: a row below the lowest edge must be visible, not vanish. A table that
  // silently omits its worst rows reads as a better strategy than it is.
  assert.equal(bucketOf(0.1, EDGES), "below");

  // And no probability in the range may be dropped. Walked rather than spot-checked,
  // because an off-by-one in the loop shows up only at one edge.
  for (let value = 0.30; value <= 0.999; value += 0.005) {
    const label = bucketOf(Number(value.toFixed(3)), EDGES);
    assert.notEqual(label, "unknown", `${value.toFixed(3)} fell out of every bucket`);
    assert.notEqual(label, "below", `${value.toFixed(3)} was pushed below the floor`);
  }
});

test("volume buckets cover the line without a gap or an overlap", () => {
  assert.equal(volumeBucket(0), "a <1k");
  assert.equal(volumeBucket(999.99), "a <1k");
  assert.equal(volumeBucket(1000), "b 1-5k");
  assert.equal(volumeBucket(24999), "c 5-25k");
  assert.equal(volumeBucket(25000), "d 25-100k");
  assert.equal(volumeBucket(1e6), "e 100k+");
  assert.equal(volumeBucket(null), "unknown");
});

test("P/L per dollar is measured against what the trade COST, not the nominal stake", () => {
  // The distinction that makes the table comparable across entry prices. Both trades below
  // staked $5 and made $1; the first paid $5.50 with fees for it and the second $5.00, so
  // they are not the same return and must not print as one.
  const rows = [
    { realizedPnlUsdc: 1, stakeUsdc: 5, totalCostUsdc: 5.5 },
    { realizedPnlUsdc: 1, stakeUsdc: 5, totalCostUsdc: 5.0 },
  ];
  const both = summarise(rows);
  assert.equal(both.n, 2);
  assert.equal(both.wins, 2);
  assert.equal(both.winRate, 1);
  assert.equal(both.pnl, 2);
  assert.equal(both.perTrade, 1);
  // 2 / 10.5, not 2 / 10.
  assert.ok(Math.abs(both.perDollar - 2 / 10.5) < 1e-9,
    `per-dollar must divide by the real cost: ${both.perDollar}`);

  // A trade with no recorded cost falls back to its stake rather than dividing by zero.
  const fallback = summarise([{ realizedPnlUsdc: 1, stakeUsdc: 5 }]);
  assert.ok(Math.abs(fallback.perDollar - 0.2) < 1e-9);

  // A loss is a loss: zero P/L is not a win, or every unresolved row inflates the win rate.
  const mixed = summarise([
    { realizedPnlUsdc: -2, totalCostUsdc: 5 },
    { realizedPnlUsdc: 0, totalCostUsdc: 5 },
    { realizedPnlUsdc: 3, totalCostUsdc: 5 },
  ]);
  assert.equal(mixed.wins, 1, "break-even is not a win");
  assert.equal(mixed.pnl, 1);
  assert.equal(summarise([]).n, 0, "an empty bucket must not divide by zero");
  assert.equal(summarise([]).winRate, null);
});

test("the verified / mid-game split is the one thing this tool must never blur", () => {
  const hours = (n) => new Date(Date.now() + n * 3600000).toISOString();

  // First seen six hours before kickoff: a real opening price.
  assert.equal(openingIsVerified({ firstObservedAt: hours(-6), eventStartTime: hours(-1) }), true);
  // First seen half an hour AFTER kickoff: a mid-game price wearing the name of an opening
  // one. This is the reported case -- a market flat at 50/50 for a week, met by the scan at
  // 6-6 in extra innings and recorded as "opened at 75%".
  assert.equal(openingIsVerified({ firstObservedAt: hours(-0.5), eventStartTime: hours(-1) }), false);

  // Undecidable is its own answer, and must be neither. Folding it into "verified" would put
  // unknowable rows into the evidence; folding it into "mid-game" would throw away rows that
  // may be fine. The report counts all three separately.
  assert.equal(openingIsVerified({ firstObservedAt: hours(-6) }), null);
  assert.equal(openingIsVerified({ eventStartTime: hours(-1) }), null);
  assert.equal(openingIsVerified({}), null);
  assert.equal(openingIsVerified({ firstObservedAt: "not a date", eventStartTime: hours(-1) }), null);

  // And the report actually keeps them apart, rather than computing the split and pooling it
  // anyway. Checked on the source because it is the shape of the output, not a return value.
  const source = readFileSync(new URL("../tools/dip-outcome-analysis.mjs", import.meta.url), "utf8");
  assert.match(source, /openingVerified === true/);
  assert.match(source, /openingVerified === false/);
  assert.match(source, /openingVerified == null/);
  assert.match(source, /NOT evidence about the band/,
    "the mid-game table has to say what it is, or it will be read as a result");
});

test("importing the tool does not run it", () => {
  // It pages the whole observation catalogue over HTTPS. A module that did that on import
  // would fire it from every test run that touches this file.
  const source = readFileSync(new URL("../tools/dip-outcome-analysis.mjs", import.meta.url), "utf8");
  assert.match(source, /import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`/,
    "main() must be behind a run guard");
  assert.ok(!/^main\(\)/m.test(source), "and never called at the top level");
});
