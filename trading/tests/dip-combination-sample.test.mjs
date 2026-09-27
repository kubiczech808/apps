// Runs offline. sampleCell() is EXECUTED against cache rows shaped exactly as
// backtestDipMarket writes them.
//
// Built because a swept cell reported win% 90-98 against a price% of ~49-50 -- an edge of 40+
// points, sustained over hundreds of trades, at 80%+ opening floors. That is either a real,
// extreme inefficiency or a population of stale, depth-less prints, and the aggregate alone
// cannot tell those apart. Only the raw rows can, so this is what prints them.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { sampleCell } from "../tools/dip-combination-sweep.mjs";

function market({ token, opening, resolvedAt = "2026-09-01T00:00:00.000Z", price, win = true, openingAt = "2026-08-31T18:00:00.000Z", lowestAt = "2026-08-31T20:00:00.000Z" }) {
  return {
    tokenId: token,
    question: `Will ${token} win?`,
    slug: `slug-${token}`,
    status: "complete",
    usableOpening: true,
    openingAt,
    openingPrice: opening,
    lowestInPlayAt: lowestAt,
    lowestInPlayPrice: price,
    resolvedAt,
    finalOutcomePrice: win ? 1 : 0,
    // Mirrors real cache semantics: a level only carries an entry when the price actually
    // touched at or below it. A row that never fell that far has null there, exactly like
    // backtestDipMarket's own entries[level] = openingInBand ? inPlay.find(...) : null.
    entries: { [String(0.5)]: price != null && price <= 0.5 ? {
      enteredAt: lowestAt, entryPrice: price, feeUsdc: 0,
      pnlUsdc: win ? (5 / price) - 5 : -5, outcome: win ? "WIN" : "LOSS",
    } : null },
  };
}

test("a sample carries the actual rows behind a cell, not another aggregate", () => {
  const rows = [
    market({ token: "a", opening: 0.9, price: 0.48 }),
    market({ token: "b", opening: 0.9, price: 0.49, win: false }),
    market({ token: "c", opening: 0.6, price: 0.48 }), // outside the 80+ open floor
    market({ token: "d", opening: 0.9, price: 0.6 }), // never touched the 45-50 band
  ];
  const sample = sampleCell(rows, [0.8, 0.99], [0.45, 0.5], 10);
  assert.equal(sample.length, 2, "only rows inside both the open floor and the buy band");
  assert.deepEqual(sample.map((row) => row.slug), ["slug-a", "slug-b"]);
  // Enough to actually check a suspicious row by eye: when it opened, where the entry
  // actually touched, and what it resolved to -- not merely that it counted.
  assert.equal(sample[0].openingPrice, 0.9);
  assert.equal(sample[0].entryPrice, 0.48);
  assert.equal(sample[0].outcome, "WIN");
  assert.equal(sample[0].finalOutcomePrice, 1);
});

test("the limit caps the sample without touching which rows qualify", () => {
  const rows = Array.from({ length: 5 }, (_, index) => market({ token: `m${index}`, opening: 0.9, price: 0.48 }));
  assert.equal(sampleCell(rows, [0.8, 0.99], [0.45, 0.5], 2).length, 2);
  assert.equal(sampleCell(rows, [0.8, 0.99], [0.45, 0.5], 100).length, 5);
});

test("it is read-only and gated behind explicit env, not printed by default", () => {
  const tool = readFileSync(new URL("../tools/dip-combination-sweep.mjs", import.meta.url), "utf8");
  assert.match(tool, /DIP_SWEEP_SAMPLE_TAG/, "the sample must be opt-in, not part of the default run");
  assert.ok(!/writeFile|action=state|storage-admin/.test(tool), "still read-only");
});
