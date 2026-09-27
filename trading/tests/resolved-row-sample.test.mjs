// Runs offline. The sample tool's gates, which have to match the ones the statistics apply --
// a row this calls "counted" and the fold skips would send the reader looking in the wrong
// place, which is the whole failure mode this tool exists to avoid.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { gateRow, counted, summarise } from "../tools/resolved-row-sample.mjs";

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

test("a flipped row is identified but not excluded, because it is only 2% of them", () => {
  const flipped = row({ firstTokenId: "a", tokenId: "b" });
  assert.equal(gateRow(flipped).flipped, true);
  assert.equal(counted(gateRow(flipped)), true, "the flip is reported, not used as a gate");
  assert.equal(summarise([flipped, row()]).flipped, 1);
});

test("it bounds what it asks for", () => {
  // The endpoint reads the settled archive, and an unbounded read of it exhausted the host.
  const tool = readFileSync(new URL("../tools/resolved-row-sample.mjs", import.meta.url), "utf8");
  assert.match(tool, /Math\.min\(800, Number\(process\.env\.ROW_LIMIT \|\| 300\)\)/);
  assert.match(tool, /&limit=\$\{LIMIT\}/);
});
