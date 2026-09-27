// Runs offline. The sample tool's gates, which have to match the ones the statistics apply --
// a row this calls "counted" and the fold skips would send the reader looking in the wrong
// place, which is the whole failure mode this tool exists to avoid.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { gateRow, counted, summarise, shapeOf, byShape } from "../tools/resolved-row-sample.mjs";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");

const row = (overrides = {}) => ({
  firstMarketProbability: 0.7,
  finalOutcomePrice: 1,
  firstSpread: 0.02,
  firstObservedAt: "2026-09-10T00:00:00.000Z",
  endDate: "2026-09-10T12:00:00.000Z",
  ...overrides,
});

test("the gates are the four the statistics actually apply", () => {
  // Entry must be a live quote strictly between 0 and 1.
  assert.match(API, /if \(\$numeric > 0 && \$numeric < 1\) \{/);
  assert.equal(gateRow(row({ firstMarketProbability: 1 })).hasEntry, false);
  assert.equal(gateRow(row({ firstMarketProbability: 0.7 })).hasEntry, true);

  // Settlement must be a clean 0 or 1; a void pays 0.50 and is neither.
  assert.equal(gateRow(row({ finalOutcomePrice: 0.5 })).hasOutcome, false);
  assert.equal(gateRow(row({ finalOutcomePrice: 0 })).outcome, 0);

  // Spread at entry, against the same ceiling api.php uses.
  assert.match(API, /const MAX_TRADABLE_SPREAD = 0\.05;/);
  assert.equal(gateRow(row({ firstSpread: 0.9 })).spreadOk, false);
  assert.equal(gateRow(row({ firstSpread: null, firstBestAsk: null, firstBestBid: null })).spreadOk, true,
    "a row that recorded no spread is admitted, as it is in api.php");

  // And a row first seen after it was due is hindsight, not a setup.
  assert.equal(gateRow(row({ firstObservedAt: "2026-09-10T13:00:00.000Z" })).notAfterDue, false);
});

test("the summary separates why rows were dropped, and states the price alongside the win rate", () => {
  const rows = [
    row(), row(), row({ finalOutcomePrice: 0 }),
    row({ firstMarketProbability: null, lastLiveMarketProbability: null, marketProbability: null, marketPrice: null }),
    row({ finalOutcomePrice: 0.5 }),
    row({ firstSpread: 0.9 }),
    row({ firstObservedAt: "2026-09-10T13:00:00.000Z" }),
  ];
  const stats = summarise(rows);
  assert.equal(stats.total, 7);
  assert.equal(stats.counted, 3, "three rows clear every gate");
  assert.equal(stats.wins, 2);
  assert.ok(Math.abs(stats.winRate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(stats.meanEntry - 0.7) < 1e-9, "the price is reported next to the win rate");
  // Each rejection attributed to one gate, so the counts add up to the total rather than
  // overlapping -- otherwise "why were rows dropped" has no answer.
  assert.equal(stats.noEntry, 1);
  assert.equal(stats.noOutcome, 1);
  assert.equal(stats.wideSpread, 1);
  assert.equal(stats.afterDue, 1);
  assert.equal(stats.counted + stats.noEntry + stats.noOutcome + stats.wideSpread + stats.afterDue, stats.total);
});

test("a flipped row is graded on the side that was priced, exactly as the statistics do", () => {
  // Rewritten rather than dropped. It used to assert that a flip is reported and never acts
  // as a gate, which was true while this tool read finalOutcomePrice raw -- and that made it
  // print the OPPOSITE result to the one the statistics counted for the same row. A sampler
  // that disagrees with the table it is explaining is worse than no sampler.
  const flippedBinary = row({ firstTokenId: "a", tokenId: "b", outcomeCount: 2, finalOutcomePrice: 1 });
  assert.equal(gateRow(flippedBinary).flipped, true, "the flip is still reported");
  assert.equal(counted(gateRow(flippedBinary)), true, "and the row is still counted");
  assert.equal(gateRow(flippedBinary).outcome, 0,
    "but the side that was bought lost, whatever the side that led at the close did");
  assert.equal(summarise([flippedBinary, row()]).flipped, 1);

  // Nothing says this one has two outcomes, so inverting would be a guess -- api.php
  // excludes it and so does this.
  assert.equal(counted(gateRow(row({ firstTokenId: "a", tokenId: "b" }))), false);

  // And a settlement recorded against the priced side beats every inference.
  assert.equal(gateRow(row({ firstTokenId: "a", tokenId: "b", outcomeCount: 2, finalOutcomePrice: 1, firstSideFinalOutcomePrice: 1 })).outcome, 1);

  // settledTokenId decides when present: the graded side IS the priced side here.
  assert.equal(gateRow(row({ firstTokenId: "a", tokenId: "b", settledTokenId: "a", outcomeCount: 2, finalOutcomePrice: 1 })).outcome, 1);
});

test("it bounds what it asks for", () => {
  // The endpoint reads the settled archive, and an unbounded read of it exhausted the host.
  const tool = readFileSync(new URL("../tools/resolved-row-sample.mjs", import.meta.url), "utf8");
  assert.match(tool, /Math\.min\(800, Number\(process\.env\.ROW_LIMIT \|\| 300\)\)/);
  assert.match(tool, /&limit=\$\{LIMIT\}/);
});

test("the shape split is the same rule api.php classifies by", () => {
  // Three ports of one rule now: the bot, api.php and this. Two chances to drift, so the
  // patterns are checked against api.php's own rather than trusted.
  assert.match(API, /'\/\^spread:\|\\bspread\\b\|\\\(\[-\+\]\\d\/i' => 'spread'/);
  assert.match(API, /'\/exact score\/i' => 'exact-score'/);
  assert.match(API, /'\/both teams to\/i' => 'both-teams'/);
  assert.match(API, /\\bvs\\\.\?\\b\|\\bv\\\.\\b\|\\s@\\s\|\\b\(\?:win\|wins\|winner\)\\b/);

  assert.equal(shapeOf({ question: "Will Cordoba CF win on 2026-09-27?" }), "outright");
  assert.equal(shapeOf({ question: "LoL: A vs B - Game 3 Winner" }), "in-event-leg");
  assert.equal(shapeOf({ question: "Total Kills Over/Under 21.5 in Game 3?" }), "over-under");
  assert.equal(shapeOf({ question: "Total goals 2.5 - A vs B" }), "over-under");
  assert.equal(shapeOf({ question: "Spread: Team A (-1.5)" }), "spread");
  assert.equal(shapeOf({ question: "Will it rain tomorrow?" }), "other");
  // Over-under is decided before outright, exactly as the classifier orders them: a totals
  // market whose question also says "vs" is a totals market.
  assert.equal(shapeOf({ question: "Games Total: O/U 3.5 - A vs B" }), "over-under");
});

test("shapes are summarised separately, so one uncapturable half cannot condemn the other", () => {
  const rows = [
    // Outright, seen well before its end date: capturable.
    row({ question: "Will Denmark win on 2026-09-27?" }),
    row({ question: "Will Germany win on 2026-09-27?", finalOutcomePrice: 0 }),
    // An in-event leg that did not exist until the match was under way.
    row({ question: "LoL: A vs B - Game 3 Winner", firstObservedAt: "2026-09-10T13:00:00.000Z" }),
    row({ question: "LoL: C vs D - Game 2 Winner", firstObservedAt: "2026-09-10T13:00:00.000Z" }),
  ];
  const groups = byShape(rows);
  const outright = groups.find((group) => group.shape === "outright");
  const inEvent = groups.find((group) => group.shape === "in-event-leg");
  assert.equal(outright.counted, 2, "both outrights were seen in time");
  assert.equal(outright.winRate, 0.5);
  assert.equal(inEvent.counted, 0);
  assert.equal(inEvent.afterDue, 2, "and the legs are all hindsight, which is the distinction");
});
