// Runs offline: no secrets, no network, no hosting access. Importing the executor
// does not start a run, so no order can be placed from a test.
import assert from "node:assert/strict";
import test from "node:test";

const executor = await import("../tools/live-order-executor.mjs");

const THRESHOLD = executor.ROTATION_PROTECT_REMAINING_GAIN_USDC;

const STAKE = 5;
const MAX_WIN = 0.5;
const SHARES = STAKE + MAX_WIN;

const HOUR_AGO = () => new Date(Date.now() - 3600000).toISOString();
const NEXT_WEEK = () => new Date(Date.now() + 7 * 86400000).toISOString();

// Builds a position whose *net exit* P/L sits `remaining` USDC short of its maximum
// win. The mark price is derived rather than asserted, because the economics are
// computed from shares * price - cost, not from a stored P/L field.
function position({ remaining, endDate = null, feeRate = 0 }) {
  const targetSellPnl = MAX_WIN - remaining;
  return {
    tokenId: "1000000000000000001",
    question: "Fixture market",
    outcome: "Yes",
    status: "OPEN",
    shares: SHARES,
    stakeUsdc: STAKE,
    totalCostUsdc: STAKE,
    maxLossUsdc: STAKE,
    netGainIfWinUsdc: MAX_WIN,
    currentPrice: (STAKE + targetSellPnl) / SHARES,
    feeRate,
    feesEnabled: feeRate > 0,
    endDate,
  };
}

const economicsFor = (options) => executor.positionRotationEconomics(position(options));
const remainingFor = (options) => economicsFor(options).remainingPotentialGainUsdc;
const lockedFor = (options) => economicsFor(options).settlementLocked;
const exhaustedFor = (options) => economicsFor(options).upsideExhausted;

test("rotation: the threshold is two cents", () => {
  assert.equal(THRESHOLD, 0.02);
});

test("rotation: the fixture drives the economics the executor actually reads", () => {
  // Guards the test itself: if the derived price stopped producing the intended
  // remaining gain, every assertion below would silently test nothing.
  assert.ok(Math.abs(remainingFor({ remaining: 0.01 }) - 0.01) < 1e-9);
  assert.ok(Math.abs(remainingFor({ remaining: 0.3 }) - 0.3) < 1e-9);
});

test("rotation: past resolution with real upside left is protected", () => {
  // The case worth waiting out: settlement is overdue and the position still has
  // meaningful money to collect, so no candidate may take its capital.
  for (const remaining of [0.021, 0.05, 0.3, 0.5]) {
    assert.equal(
      lockedFor({ remaining, endDate: HOUR_AGO() }),
      true,
      `remaining ${remaining} USDC past resolution must be held`,
    );
  }
});

test("rotation: past resolution with nothing left to collect is released", () => {
  // Waiting no longer earns anything, so the capital is freed instead of parked
  // until settlement.
  for (const remaining of [0, 0.005, 0.02]) {
    const economics = economicsFor({ remaining, endDate: HOUR_AGO() });
    assert.equal(economics.settlementLocked, false, `remaining ${remaining} USDC must not be held`);
    assert.equal(economics.upsideExhausted, true, `remaining ${remaining} USDC has nothing left to wait for`);
  }
});

test("rotation: a future resolution is never protected", () => {
  // The protection exists only for positions stuck awaiting settlement. One that has
  // not reached its end date follows the ordinary improvement rules.
  for (const remaining of [0.01, 0.3, 0.5]) {
    assert.equal(
      lockedFor({ remaining, endDate: NEXT_WEEK() }),
      false,
      `remaining ${remaining} USDC before resolution must stay rotatable`,
    );
  }
});

test("rotation: a missing end date does not count as elapsed", () => {
  // Sports rows carry unreliable dates. Treating unknown as past would strand
  // capital in a position nobody can prove is overdue.
  assert.equal(lockedFor({ remaining: 0.3, endDate: null }), false);
  assert.equal(economicsFor({ remaining: 0.3, endDate: null }).noDaysLeft, true, "still reported as no usable horizon");
});

test("rotation: the boundary is inclusive on the release side", () => {
  const past = HOUR_AGO();
  assert.equal(exhaustedFor({ remaining: THRESHOLD, endDate: past }), true);
  assert.equal(lockedFor({ remaining: THRESHOLD, endDate: past }), false);
  assert.equal(exhaustedFor({ remaining: THRESHOLD + 0.001, endDate: past }), false);
  assert.equal(lockedFor({ remaining: THRESHOLD + 0.001, endDate: past }), true);
});

test("rotation: upside exhaustion is independent of the horizon", () => {
  // Nothing left to collect means nothing to wait for, whenever it lands.
  assert.equal(exhaustedFor({ remaining: 0.01, endDate: HOUR_AGO() }), true);
  assert.equal(exhaustedFor({ remaining: 0.01, endDate: NEXT_WEEK() }), true);
  assert.equal(exhaustedFor({ remaining: 0.01, endDate: null }), true);
});

test("rotation: the exit fee counts against the remaining gain", () => {
  // A taker exit fee lowers the net sell P/L, so a position that looks two cents from
  // its win before fees can still have real upside after them. The threshold must be
  // measured after fees, like every other economic check.
  const withoutFee = remainingFor({ remaining: 0.01, endDate: HOUR_AGO() });
  const withFee = remainingFor({ remaining: 0.01, endDate: HOUR_AGO(), feeRate: 0.02 });
  assert.ok(withFee > withoutFee, `the fee must widen the gap, got ${withFee} vs ${withoutFee}`);
});

test("rotation: the veto precedes the ranking metric and exhaustion bypasses it", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // The veto is evaluated first, and an exhausted position may rotate without
  // clearing the improvement threshold, because the metric cannot judge either case.
  assert.match(source, /const rotationPreferred = !settlementLocked/);
  assert.match(source, /\(upsideExhausted\s*\n\s*\|\| \(evDelta > 0 && priorityDelta >= ROTATION_MIN_PRIORITY_IMPROVEMENT\)\)/);
  assert.equal(/const settlementLocked = resolutionPast && !upsideExhausted;/.test(source), true);

  // Both outcomes must be explained in words in the run log.
  assert.ok(source.includes("resolution is already past and this position still has $"));
  assert.ok(source.includes("short of its maximum win, within the $"));
});
