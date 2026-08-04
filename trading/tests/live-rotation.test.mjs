// Runs offline: no secrets, no network, no hosting access. Importing the executor
// does not start a run, so no order can be placed from a test.
import assert from "node:assert/strict";
import test from "node:test";

const executor = await import("../tools/live-order-executor.mjs");

const THRESHOLD = executor.ROTATION_PROTECT_REMAINING_GAIN_USDC;

const STAKE = 5;
const MAX_WIN = 0.5;
const SHARES = STAKE + MAX_WIN;

// Builds a position whose *net exit* P/L sits `remaining` USDC short of its maximum
// win. The mark price is derived rather than asserted, because the economics are
// computed from shares * price - cost, not from a stored P/L field.
function position({ remaining, endDate = null, feeRate = 0 }) {
  const targetSellPnl = MAX_WIN - remaining;
  const price = (STAKE + targetSellPnl) / SHARES;
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
    currentPrice: price,
    feeRate,
    feesEnabled: feeRate > 0,
    endDate,
    daysToResolution: endDate == null ? null : 0.3,
  };
}

const remainingFor = (options) => executor.positionRotationEconomics(position(options)).remainingPotentialGainUsdc;
const lockedFor = (options) => executor.positionRotationEconomics(position(options)).settlementLocked;

test("rotation: the protection threshold is two cents", () => {
  assert.equal(THRESHOLD, 0.02);
});

test("rotation: the fixture drives the economics the executor actually reads", () => {
  // Guards the test itself: if the derived price stopped producing the intended
  // remaining gain, every assertion below would silently test nothing.
  assert.ok(Math.abs(remainingFor({ remaining: 0.01 }) - 0.01) < 1e-9);
  assert.ok(Math.abs(remainingFor({ remaining: 0.3 }) - 0.3) < 1e-9);
});

test("rotation: a position waiting on two cents or less is locked", () => {
  for (const remaining of [0, 0.005, 0.01, 0.019, 0.02]) {
    assert.equal(lockedFor({ remaining }), true, `remaining ${remaining} USDC must be protected`);
  }
});

test("rotation: a position with real upside left stays rotatable", () => {
  for (const remaining of [0.021, 0.05, 0.2, 0.5]) {
    assert.equal(lockedFor({ remaining }), false, `remaining ${remaining} USDC must stay rotatable`);
  }
});

test("rotation: the boundary is inclusive and does not drift", () => {
  assert.equal(lockedFor({ remaining: THRESHOLD }), true);
  assert.equal(lockedFor({ remaining: THRESHOLD + 0.001 }), false);
});

test("rotation: the protection ignores the remaining horizon", () => {
  // The rule is about how little is left to collect, not about when it settles, so
  // it holds whether or not Polymarket supplied a usable resolution date.
  const past = new Date(Date.now() - 3600000).toISOString();
  const future = new Date(Date.now() + 7 * 86400000).toISOString();

  assert.equal(lockedFor({ remaining: 0.01, endDate: past }), true);
  assert.equal(lockedFor({ remaining: 0.01, endDate: future }), true);
  assert.equal(lockedFor({ remaining: 0.01, endDate: null }), true);
  assert.equal(lockedFor({ remaining: 0.3, endDate: past }), false);
});

test("rotation: the exit fee counts against the remaining gain", () => {
  // A taker exit fee lowers the net sell P/L, so a position that looks two cents
  // from its win before fees can still have real upside left after them. The
  // protection must be measured after fees, like every other economic check.
  const withoutFee = remainingFor({ remaining: 0.01, feeRate: 0 });
  const withFee = remainingFor({ remaining: 0.01, feeRate: 0.02 });
  assert.ok(withFee > withoutFee, `the fee must widen the gap, got ${withFee} vs ${withoutFee}`);
});

test("rotation: a position already at its maximum win is locked", () => {
  assert.equal(lockedFor({ remaining: 0 }), true, "nothing left to collect means nothing to gain by rotating");
});

test("rotation: the veto is applied before the ranking metric", async () => {
  // The veto has to come ahead of the metric, because an almost-settled position is
  // exactly the one whose remaining annualized return looks worst.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  assert.match(source, /const rotationPreferred = !settlementLocked/);
  // The previous behaviour did the opposite: it force-closed near-win positions and
  // bypassed the improvement test entirely.
  assert.doesNotMatch(source, /immediateCloseAllowed/);
  // A held position must be explained in words, not left as a bare flag.
  assert.ok(source.includes("only waiting on $"), "the run log must state why the position was kept");
});
