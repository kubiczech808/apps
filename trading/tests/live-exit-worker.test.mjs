import assert from "node:assert/strict";
import test from "node:test";

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
