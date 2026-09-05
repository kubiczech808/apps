import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const worker = await import("../tools/rpi-live-exit-worker.mjs");

test("equal-risk exit plan limits planned loss to the potential win", () => {
  const plan = worker.equalRiskExitPlan({
    shares: 5.4,
    totalCostUsdc: 5,
    netGainIfWinUsdc: 0.4,
    feeRate: 0.02,
    feesEnabled: true,
  });
  assert.equal(plan.protectable, true);
  const exit = worker.netExitValue({ shares: plan.shares, price: plan.stopPrice, feeRate: plan.feeRate, feesEnabled: plan.feesEnabled });
  assert.ok(Math.abs(exit - plan.minimumExitValueUsdc) < 0.00001, `${exit} should match ${plan.minimumExitValueUsdc}`);
  assert.ok(plan.costUsdc - exit <= plan.riskTargetUsdc + 0.00001);
});

test("stop trigger uses the best executable bid and does not trigger above the floor", () => {
  assert.equal(worker.bestBid({ bids: [{ price: "0.72" }, { price: "0.69" }] }), 0.72);
  assert.equal(worker.exitTrigger({ bestBidPrice: 0.72, stopPrice: 0.71 }), false);
  assert.equal(worker.exitTrigger({ bestBidPrice: 0.71, stopPrice: 0.71 }), true);
  assert.equal(worker.exitTrigger({ bestBidPrice: 0.70, stopPrice: 0.71 }), true);
  assert.equal(worker.exitTrigger({ bestBidPrice: 0.712, stopPrice: 0.71, triggerPrice: 0.712 }), true);
});

// The Pi recorded a triggered stop for a market with no bids at all, on every poll, and
// only shadow mode kept it from selling into an empty book: number() ran Number(null),
// which is 0, and 0 is at or below every floor. An absent bid is unknown, not free.
test("a market with nothing bid on it is not a triggered stop", () => {
  assert.equal(worker.bestBid({ bids: [] }), null, "an empty book has no best bid");
  assert.equal(worker.bestBid({}), null);
  assert.equal(worker.exitTrigger({
    bestBidPrice: worker.bestBid({ bids: [] }), stopPrice: 0.4225, triggerPrice: 0.4245,
  }), false, "no bid means there is nothing to sell into, not a price of zero");
  assert.equal(worker.exitTrigger({ bestBidPrice: undefined, stopPrice: 0.4225 }), false);
  assert.equal(worker.exitTrigger({ bestBidPrice: "", stopPrice: 0.4225 }), false);
  assert.equal(worker.exitTrigger({ bestBidPrice: 0, stopPrice: 0.4225 }), false,
    "a quoted zero is the same vacuum as an absent bid");
  // The real crossing still fires, so the guard did not quietly disable the stop.
  assert.equal(worker.exitTrigger({ bestBidPrice: 0.42, stopPrice: 0.4225, triggerPrice: 0.4245 }), true);
});

// Iberian Soul sat at a bid of 0.03 against a stop of 0.3675 -- the book jumped the floor
// hours before, so selling recovers a residue rather than capping a loss. It still sells,
// but the two cases must be distinguishable in the log, because arming the worker on a
// portfolio full of gapped positions is a different decision from arming it on one whose
// stops are about to fire.
test("a stop that the book jumped is recorded apart from one firing now", () => {
  const firing = worker.stopCrossing({ bestBidPrice: 0.42, stopPrice: 0.4225 });
  assert.equal(firing.gapped, false);
  assert.ok(firing.recoveredFraction > 0.99);

  const jumped = worker.stopCrossing({ bestBidPrice: 0.03, stopPrice: 0.3675 });
  assert.equal(jumped.gapped, true, "a bid at 8% of the stop is a gap, not a crossing");
  assert.ok(jumped.recoveredFraction < 0.09);

  assert.equal(worker.stopCrossing({ bestBidPrice: null, stopPrice: 0.4225 }), null,
    "with no bid there is no crossing to classify");
  assert.equal(worker.stopCrossing({ bestBidPrice: 0.42, stopPrice: null }), null);
});

test("a stop reversal resolves only the other side of a binary market", () => {
  const market = {
    outcomes: JSON.stringify(["Yes", "No"]),
    clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
  };
  assert.deepEqual(worker.oppositeBinaryToken(market, "yes-token"), {
    eligible: true,
    tokenId: "no-token",
    outcome: "No",
  });
  assert.equal(worker.oppositeBinaryToken({ outcomes: "[\"A\",\"B\",\"C\"]", clobTokenIds: "[\"a\",\"b\",\"c\"]" }, "a").eligible, false);
  assert.equal(worker.bestAsk({ asks: [{ price: "0.54" }, { price: "0.57" }] }), 0.54);
});

// A portfolio that is switched off does not trade, and selling one of its positions is
// trading. Omitting its tokens from `policies` does not achieve that on its own: this
// worker applies defaultPolicy to every position it does not find there, so an omitted
// token inherits the main Live portfolio's stop instead of being left alone. The server
// therefore names the exclusions, and they have to outrank PROTECT_ALL and the local
// watchlist -- both of which otherwise mean "watch everything I can see".
test("positions the server excludes are left alone", () => {
  const excluded = worker.excludedRemoteTokens({
    excluded: [
      { tokenId: "sleeping-token", portfolioId: "live-custom-live2", enabled: false, reason: "portfolio automation is switched off" },
      { tokenId: "", portfolioId: "live", reason: "no token" },
    ],
  });
  assert.equal(excluded.size, 1, "a row with no token id is not an exclusion");
  assert.equal(excluded.get("sleeping-token").portfolioId, "live-custom-live2");
  assert.match(excluded.get("sleeping-token").reason, /automation is switched off/);
  assert.equal(worker.excludedRemoteTokens({}).size, 0);
  assert.equal(worker.excludedRemoteTokens({ excluded: null }).size, 0);
});

test("worker source keeps live exits opt-in and price-protected", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  assert.match(source, /LIVE_EXIT_MODE \|\| "shadow"/);
  assert.match(source, /MODE !== "live" \|\| !CONFIRM_LIVE/);
  assert.match(source, /client\.postOrder\(signed, OrderType\.FOK, false\)/);
  assert.match(source, /String\(response\?\.status \|\| ""\)\.toLowerCase\(\) === "matched"/);
  assert.match(source, /if \(!exitFilled\(response\) && ALLOW_PARTIAL\)/);
  assert.match(source, /LIVE_EXIT_POLICY_URL/);
  assert.match(source, /remotePolicyMap\(context\.policyState\)/);
  assert.match(source, /defaultRemotePolicy\(context\.policyState\)/);
  assert.match(source, /if \(plan\.reverseOnStopLoss\)/);
  assert.match(source, /submitStopLossReversal\(plan\)/);
  assert.match(source, /STOP_LOSS_REVERSAL_STAKE_USDC = 5/);
  // The exclusion is checked before PROTECT_ALL and the local watchlist, not after, or
  // "protect everything" would override the owner's switch.
  assert.match(source, /if \(excludedTokens\.has\(tokenId\)\) return null;[\s\S]{0,400}?if \(!PROTECT_ALL/);
  assert.match(source, /context\.state\.excludedPositions =/,
    "what is deliberately unwatched has to be visible, not merely absent");
});

// Measured on the Pi: a dispatch that set live mode left the worker's own state file
// reporting mode=shadow while it cycled normally. The EnvironmentFile on disk said live;
// the process kept the environment it had started with hours earlier. `enable --now`
// starts a STOPPED unit and does nothing to a running one, so every install since the
// worker last came up published new code and new configuration that the live process never
// read -- which also hid two code fixes pushed the same evening.
test("configuring the worker actually reaches the running process", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/trading-rpi-live-exit-worker.yml", import.meta.url), "utf8");

  assert.match(workflow, /systemctl --user restart trading-live-exit-worker\.service/,
    "a running worker has to be replaced, not merely enabled");
  assert.ok(!/systemctl --user enable --now trading-live-exit-worker\.service/.test(workflow),
    "enable --now cannot come back: it is a no-op against the case that matters");

  // And the claim is verified against the worker's own report rather than assumed from the
  // restart, because assuming it is exactly what went unnoticed.
  //
  // The state file has to be one the RESTARTED worker wrote. The first version of this
  // check read whatever file was there and reported the previous mode with full confidence
  // -- the same mistake it exists to catch, one level up -- so the timestamp comparison is
  // the part worth pinning.
  assert.match(workflow, /restarted_at="\$\(date \+%s\)"/);
  assert.match(workflow, /\[ "\$\(stat -c %Y "\$state"\)" -ge "\$restarted_at" \]/,
    "a state file older than the restart is the predecessor's, and answers the wrong question");
  assert.match(workflow, /if \[ "\$running" != "\$expected" \]; then[\s\S]*?exit 1/,
    "a worker still in the previous mode has to fail the run, not pass quietly");
});

// Reported: the position that is supposed to open on the opposite outcome after a stop did
// not open, and the rule is specified as a market order -- so barring a market that cannot
// be bought at all, a position should always result.
//
// It was priced at exactly bestAsk and posted FOK. That is a limit order at the top of the
// book, all-or-nothing: it fills only if the entire size sits at that single price level at
// the instant it lands. A 5 USDC order at 0.20 needs 25 shares; a top level holding 4 of
// them kills the whole order and nothing opens.
test("stop reversal: the entry is priced to actually take the size it needs", () => {
  // A book whose top level is far too thin for the order, which is the ordinary case.
  const thinTop = {
    asks: [
      { price: 0.20, size: 4 },
      { price: 0.21, size: 10 },
      { price: 0.22, size: 200 },
    ],
  };
  assert.equal(worker.bestAsk(thinTop), 0.20, "the top of book is still 0.20");
  const price = worker.marketableBuyPrice({ book: thinTop, notionalUsdc: 5 });
  assert.equal(price, 0.22,
    "5 USDC is only covered once the 0.22 level is reached, so that is what it must pay");

  // Enough depth at the top: it must not pay away the spread for nothing.
  const deepTop = { asks: [{ price: 0.20, size: 500 }, { price: 0.30, size: 500 }] };
  assert.equal(worker.marketableBuyPrice({ book: deepTop, notionalUsdc: 5 }), 0.20,
    "a top level that already covers the order is the price");

  // "Market order" is not "any price". Beyond the slippage cap the order is fitted to the
  // deepest price inside it rather than chasing the book.
  const gapped = { asks: [{ price: 0.20, size: 1 }, { price: 0.90, size: 900 }] };
  const capped = worker.marketableBuyPrice({ book: gapped, notionalUsdc: 5, maxSlippage: 0.05 });
  assert.ok(capped <= 0.25, `a 0.05 cap must not reach 0.90, got ${capped}`);
  assert.ok(capped >= 0.20);

  // Never at or above 1: at 1.00 the outcome cannot profit at all.
  const nearOne = { asks: [{ price: 0.985, size: 1 }, { price: 1, size: 1000 }] };
  const near = worker.marketableBuyPrice({ book: nearOne, notionalUsdc: 5, maxSlippage: 0.5 });
  assert.ok(near == null || near < 1, `must stay below 1, got ${near}`);

  // Nothing to buy is still nothing to buy.
  assert.equal(worker.marketableBuyPrice({ book: { asks: [] }, notionalUsdc: 5 }), null);
  assert.equal(worker.marketableBuyPrice({ book: { asks: [{ price: 0.2, size: 10 }] } }), null,
    "no notional means no answer, rather than a price for an unknown size");

  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  // The reverse must be marketable AND partial-friendly. The protective SELL keeps FOK on
  // purpose -- a partial exit leaves a stop plan that no longer matches the position -- but
  // for an entry a smaller position is still the position the rule asks for.
  const reversal = source.slice(source.indexOf("async function submitStopLossReversal("));
  const body = reversal.slice(0, reversal.indexOf("\nasync function "));
  assert.match(body, /marketableBuyPrice\(/, "the reverse must not price at bare bestAsk");
  assert.match(body, /OrderType\.FAK/, "and must not be all-or-nothing");
  assert.ok(body.indexOf("OrderType.FAK") < body.indexOf("OrderType.FOK"),
    "FAK is the first attempt; FOK is only the fallback for a venue that refuses it");
  // The protective SELL is untouched by all this.
  const exit = source.slice(source.indexOf("async function submitProtectedExit("));
  assert.match(exit.slice(0, exit.indexOf("\nasync function ")), /OrderType\.FOK/,
    "the protective sell keeps its strict price floor");
});

// The other half: a reverse that failed was never tried again. Once the protective SELL
// matches, the position is gone, so that plan is absent from every later pass -- there was
// no list of owed reversals at all, and a momentary rejection meant no opposite position
// ever opened.
test("stop reversal: an owed position survives the pass that failed to open it", () => {
  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");

  assert.match(source, /context\.state\.pendingReversals\[plan\.tokenId\] = \{/,
    "an owed reverse has to be recorded before it is attempted, not after it succeeds");
  const check = source.slice(source.indexOf("async function checkOnce("));
  const plansAt = check.indexOf("context.liveState");
  const retryAt = check.indexOf("await retryPendingReversals(context);");
  assert.ok(retryAt >= 0 && retryAt < plansAt,
    "owed reverses must be retried before the plan list, which no longer contains them");

  // Terminal versus momentary. Only a market that cannot be bought at all is final.
  assert.equal(worker.reversalFailureIsTerminal("opposite market is no longer accepting orders"), true);
  assert.equal(worker.reversalFailureIsTerminal("position is not in a two-outcome market"), true);
  assert.equal(worker.reversalFailureIsTerminal("CLOB book read failed: socket hang up"), false,
    "a failed read is a moment, not an answer");
  assert.equal(worker.reversalFailureIsTerminal("opposite outcome has no executable ask"), false,
    "an empty book now says nothing about the book in a minute");
  assert.equal(worker.reversalFailureIsTerminal(null), false);
});

// Reported: on the live portfolio "70+ 3d incl. O/U" (live-custom-ewportfolio) the stop
// loss does not work at all.
//
// Measured on the worker's own state, and it was not a coverage problem -- that portfolio's
// multiplier is 2, its stopLossEnabled is true, and all nine of its open positions are in
// the policy payload. The worker was firing and being refused:
//
//   stopPrice 0.129981  triggerPrice 0.131981  bestBid 0.09
//   type EXIT_REJECTED  response { success:false, status:400 }
//
// eleven times in eleven minutes on one position, and all six tokens it had ever tried to
// exit sat at status 400 with no order id. Two causes, both visible in that one line.
test("protected exit: the sell is priced on the tick grid and where it can fill", () => {
  // 0.129981 is not a price the CLOB accepts. Rounding is DOWN for a sell: it is the
  // marketable direction, and one tick of extra loss is nothing beside not exiting at all.
  assert.equal(worker.roundToTick(0.129981, 0.01, "down"), 0.12);
  assert.equal(worker.roundToTick(0.129981, 0.001, "down"), 0.129);
  assert.equal(worker.roundToTick(0.13, 0.01, "down"), 0.13, "a price already on the grid is unchanged");
  assert.equal(worker.roundToTick(0.5, 0, "down"), 0.5, "an unusable tick must not produce NaN");

  // The reported position exactly: floor 0.129981, book gapped down to 0.09. Insisting on
  // the floor there cannot match at any price, which is why it never sold.
  const gapped = worker.protectedExitPrice({ stopPrice: 0.129981, bestBidPrice: 0.09, tickSize: 0.01 });
  assert.equal(gapped, 0.09, "once the book is through the floor, sell where the buyers are");

  // Not gapped: the floor is the price, on the grid.
  const atFloor = worker.protectedExitPrice({ stopPrice: 0.129981, bestBidPrice: 0.20, tickSize: 0.01 });
  assert.equal(atFloor, 0.12, "with bids above the floor the sell rests at the floor, tick-aligned");

  // A bid exactly at the floor is not a gap.
  assert.equal(worker.protectedExitPrice({ stopPrice: 0.12, bestBidPrice: 0.12, tickSize: 0.01 }), 0.12);

  // Nothing sellable stays nothing sellable rather than becoming a zero-price order.
  assert.equal(worker.protectedExitPrice({ stopPrice: 0.129981, bestBidPrice: 0, tickSize: 0.01 }), 0.12);
  assert.equal(worker.protectedExitPrice({ stopPrice: 0.004, bestBidPrice: 0.003, tickSize: 0.01 }), null,
    "a floor that rounds to zero on this grid is not an order");

  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  const submit = source.slice(source.indexOf("async function submitProtectedExit("));
  const body = submit.slice(0, submit.indexOf("\nasync function "));
  assert.match(body, /protectedExitPrice\(/, "the raw six-decimal floor must not be sent as a price");
  assert.match(body, /options = \{ tickSize: String\(constraints\.tickSize\) \}/,
    "the order has to declare the grid it is priced on");
  // Same trap the executor documents: an unknown negRisk must stay unknown.
  assert.match(body, /typeof constraints\.negRisk === "boolean"/,
    "negRisk must only be sent when it is actually known");
  assert.doesNotMatch(body, /price: plan\.stopPrice/, "the unrounded floor must not reach createOrder");
  // And the bid that decided the trigger has to reach the pricing, or the gap case cannot
  // be seen from inside it.
  assert.match(source, /submitProtectedExit\(plan, \{ bestBidPrice: currentBestBid \}\)/);
});
