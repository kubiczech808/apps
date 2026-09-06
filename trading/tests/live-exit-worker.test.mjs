import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const worker = await import("../tools/rpi-live-exit-worker.mjs");

// Brace-matched, because slicing to "the next async function" silently swallowed the rest
// of the file once another function was inserted between them -- and an assertion that
// searches too much text passes or fails for the wrong reason.
function functionBody(source, name) {
  const at = source.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`function ${name} was not found`);
  // Keep a preceding `async`. Slicing from "function" alone drops it, and the body then
  // contains `await` inside something declared synchronous -- which fails as a syntax
  // error rather than as the assertion the test meant to make.
  const start = source.slice(Math.max(0, at - 6), at) === "async " ? at - 6 : at;
  let depth = 0;
  for (let index = source.indexOf("{", source.indexOf(")", start)); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} is unbalanced`);
}


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
  // FOK first on the WHOLE position, with nothing asked of the exchange beforehand.
  assert.match(source, /if \(!exitFilled\(response\) && ALLOW_PARTIAL\) response = await sell\(size, OrderType\.FAK\);/);
  // The retry after a balance refusal always part-fills: it is already a rescue of less
  // than the position, and holding out for all-or-nothing would throw the rescue away.
  assert.match(source, /Holding\s*\n\s*\/\/ out for all-or-nothing here would throw the rescue away[\s\S]{0,120}?response = await sell\(size, OrderType\.FAK\);/);
  assert.match(source, /LIVE_EXIT_POLICY_URL/);
  assert.match(source, /remotePolicyMap\(context\.policyState\)/);
  assert.match(source, /defaultRemotePolicy\(context\.policyState\)/);
  // Never after a settlement close: that position won, and buying the opposite outcome of
  // a decided market is buying the loser.
  assert.match(source, /if \(plan\.reverseOnStopLoss && reason !== "settlement"\)/);
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
  const body = functionBody(source, "submitStopLossReversal");
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
  const body = functionBody(source, "submitProtectedExit");
  assert.match(body, /protectedExitPrice\(/, "the raw six-decimal floor must not be sent as a price");
  assert.match(body, /options = \{ tickSize: String\(constraints\.tickSize\) \}/,
    "the order has to declare the grid it is priced on");
  // Same trap the executor documents: an unknown negRisk must stay unknown.
  assert.match(body, /typeof constraints\.negRisk === "boolean"/,
    "negRisk must only be sent when it is actually known");
  assert.doesNotMatch(body, /price: plan\.stopPrice/, "the unrounded floor must not reach createOrder");
  // And a bid has to reach the pricing, or the gap case cannot be seen from inside it.
  assert.match(source, /submitProtectedExit\(plan, \{ bestBidPrice: exitBid \}\)/);
  // That bid is re-read at the moment of the exit. The books are read in one batch, so by
  // the time a given position is acted on its bid can be seconds old -- long enough on a
  // resolving event to price the sell where nobody is buying any more.
  assert.match(source, /let exitBid = currentBestBid;/,
    "the trigger's own bid is the fallback when the fresh read fails");
  const act = source.slice(source.indexOf("let exitBid = currentBestBid;"));
  const upToSubmit = act.slice(0, act.indexOf("submitProtectedExit("));
  assert.match(upToSubmit, /CLOB book/, "the exit price must come from a freshly read book");
  // It re-prices; it must not re-decide. A stop that has fired sells, or a tick back above
  // the trigger cancels the exit and the position keeps falling.
  assert.doesNotMatch(upToSubmit, /exitTrigger\(/,
    "the trigger must not be re-evaluated after it has already fired");
});

// Asked: is the real problem that the breach is noticed too late? Price on a resolving
// event falls in seconds, and a stop cannot be pre-placed on Polymarket -- a resting SELL
// priced below the current bid is immediately marketable and fills at once, and the CLOB
// has no stop or trigger order type. So this loop IS the stop's reaction time, and how
// fast it goes round is the whole of the answer.
//
// It read the books strictly one after another, each awaited before the next began, and
// submitted an exit in the middle of that queue. With seventeen open positions the last
// one was looked at seventeen round trips after the first, and one exit -- an order plus a
// possible reverse -- blocked every position behind it.
test("stop latency: every watched book is read in one pass, not in a queue", () => {
  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");

  // One request for every book, not one request per book. This is what puts a floor under
  // the poll interval: N requests a pass means N per second at a one-second loop.
  assert.match(source, /const books = await fetchBooks\(candidates\.map\(\(plan\) => plan\.tokenId\)\);/,
    "the books must be read in a single batched request");
  assert.match(source, /await fetch\(`\$\{CLOB_HOST\}\/books`/, "which is the CLOB's own /books endpoint");
  const check = source.slice(source.indexOf("const candidates = plans.filter("));
  const batchAt = check.indexOf("await fetchBooks(candidates");
  const actAt = check.indexOf("for (const { plan, book, error: bookError } of observed)");
  assert.ok(batchAt >= 0 && actAt > batchAt,
    "reading has to finish before acting, or one exit delays the next position's price check");

  // The old shape must not come back: a book fetch awaited inside the loop over plans.
  assert.doesNotMatch(source, /for \(const plan of plans\) \{[\s\S]{0,400}?await fetchJson\(`\$\{CLOB_HOST\}\/book/,
    "a per-plan awaited book fetch is the queue this replaced");

  // A failed batch falls back to reading them individually rather than blinding the worker
  // to every position at once.
  assert.match(source, /observed = await mapWithConcurrency\(candidates, async \(plan\) => \{/,
    "one bad batch must not cost the pass entirely");

  // The bounded map itself, driven: order preserved, and genuinely concurrent.
  const started = [];
  let peak = 0;
  let active = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  return (async () => {
    const worker = new Function("items", "limit", `
      ${functionBody(source, "mapWithConcurrency")}
      return mapWithConcurrency;
    `)();
    const out = await worker(items, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      started.push(value);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    }, 4);
    assert.deepEqual(out, items.map((value) => value * 2), "results must stay in input order");
    assert.ok(peak > 1, "the whole point is that reads overlap");
    assert.ok(peak <= 4, `the bound must hold, saw ${peak} at once`);
    assert.deepEqual(await worker([], async () => 1, 4), [], "an empty watch list is not an error");
  })();
});

// Reported: a live position kept falling with its stop configured, watched and firing.
// The worker's own state showed the mechanism working -- stop reached, price on the tick
// grid, gap-sell at the bid -- and every order refused:
//
//   400 "the order signer address has to be the address of the API KEY"
//
// 106 rejections across 6 tokens, each left terminal:false and retried forever. Measured
// on the Pi: POLYMARKET_FUNDER_ADDRESS was 0x3252...2293, the hard-coded fallback the
// workflow writes when the secret is unset, while the account actually being traded is
// 0xe219...39e2. Under signature type 3 the funder address is what the order presents as
// its signer, and the API key belongs to the wallet -- so every exit was signed as a
// different address than the one authorised to place it.
//
// Buys were unaffected because the executor does not trust its environment here: it reads
// the account configuration published in the live state. Two paths signing for one wallet,
// only one of which knew which wallet it was.
test("signing: the worker signs as the account the live state publishes, not as its environment", () => {
  const state = { history: [] };
  const adopted = worker.adoptAccountTradingConfig({
    account: { trading: { funderAddress: "0xE219de3B5081b45Dc5fD1d2225c19b1476f139e2", signatureType: 3 } },
  }, state);
  assert.equal(adopted.funderAddress, "0xE219de3B5081b45Dc5fD1d2225c19b1476f139e2");
  assert.equal(adopted.signatureType, 3);
  assert.equal(adopted.source, "live-state");
  assert.equal(worker.signingAccount().funderAddress, "0xE219de3B5081b45Dc5fD1d2225c19b1476f139e2",
    "the adopted account is what the next order is signed with");
  // Recorded when it moves. Twelve hours of identical rejections said nothing about which
  // address was being used, which is why the fault was invisible.
  assert.equal(state.history.filter((event) => event.type === "SIGNING_ACCOUNT_ADOPTED").length, 1);
  assert.equal(state.signingAccount.funderAddress, "0xE219de3B5081b45Dc5fD1d2225c19b1476f139e2");

  // The discovery block is the executor's own second source, so it is read here too.
  const discovered = worker.adoptAccountTradingConfig({
    accountDiscovery: { selectedFunderAddress: "0xabc", selectedSignatureType: 1 },
  });
  assert.equal(discovered.funderAddress, "0xabc");
  assert.equal(discovered.signatureType, 1);

  // A live state that names no account must not blank the address the worker is using.
  const kept = worker.adoptAccountTradingConfig({});
  assert.equal(kept.funderAddress, "0xabc", "an empty state leaves the adopted account alone");

  // Adopting the same account again is not a change and must not re-log.
  const quiet = { history: [] };
  worker.adoptAccountTradingConfig({ account: { trading: { funderAddress: "0xabc", signatureType: 1 } } }, quiet);
  assert.equal(quiet.history.length, 0);
});

test("signing: a signer mismatch is named as a configuration fault, not one more rejection", () => {
  assert.equal(
    worker.rejectionIsSignerMismatch({ error: "the order signer address has to be the address of the API KEY" }),
    true,
  );
  assert.equal(
    worker.rejectionIsSignerMismatch({ errorMsg: "The order signer address has to be the address of the API key" }),
    true,
    "the CLOB's casing is not part of the contract",
  );
  // Ordinary refusals must not be dressed up as a broken configuration.
  assert.equal(worker.rejectionIsSignerMismatch({ error: "not enough balance / allowance" }), false);
  assert.equal(worker.rejectionIsSignerMismatch({ error: "invalid price" }), false);
  assert.equal(worker.rejectionIsSignerMismatch({}), false);

  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  // Surfaced on the state, so a worker that cannot place any order at all says so instead
  // of being inferred from hundreds of identical events.
  assert.match(source, /context\.state\.signingError = \{/);
  // And deliberately NOT terminal: the next live state can correct the address, and a stop
  // that has given up is worse than one that keeps trying.
  assert.match(source, /It stays non-terminal on purpose/);

  // The client must be built from the adopted account, never from the module's env
  // constants -- reading those again is the whole defect.
  const client = functionBody(source, "authenticatedClient");
  assert.match(client, /const funderAddress = accountTrading\.funderAddress;/);
  assert.match(client, /const signatureType = accountTrading\.signatureType;/);
  assert.doesNotMatch(client, /funderAddress: FUNDER_ADDRESS/);
  assert.doesNotMatch(client, /signatureTypes\[SIGNATURE_TYPE\]/);
});

// Measured on the Pi: 389 of the 500 retained events were BOOK_ERROR, nearly all of them
// one closed market repeating "HTTP 404" every five seconds. They had pushed the exit
// rejections and the worker's own startup out of the window, so the history could only
// show the last forty minutes of one broken market -- while the question being asked of it
// was what the stop loss had done all night.
test("book errors: a market repeating the same failure is counted, not re-logged every pass", () => {
  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  const record = new Function("recordEvent", `${functionBody(source, "recordBookError")}\nreturn recordBookError;`)(
    (state, event) => { state.history.push(event); },
  );
  const state = { history: [] };
  const plan = { tokenId: "1", question: "FC Juárez vs. CF Pachuca: FC Juárez O/U 0.5" };

  record(state, plan, new Error("HTTP 404"), "2026-09-05T07:14:45.598Z");
  record(state, plan, new Error("HTTP 404"), "2026-09-05T07:14:50.752Z");
  record(state, plan, new Error("HTTP 404"), "2026-09-05T07:15:01.098Z");
  assert.equal(state.history.length, 1, "the first occurrence is recorded immediately, the repeats are not");
  assert.equal(state.bookErrors["1"].count, 3);
  assert.equal(state.bookErrors["1"].firstAt, "2026-09-05T07:14:45.598Z");
  assert.equal(state.bookErrors["1"].lastAt, "2026-09-05T07:15:01.098Z");

  // A DIFFERENT failure on the same market is new information and is recorded.
  record(state, plan, new Error("fetch failed"), "2026-09-05T08:03:34.323Z");
  assert.equal(state.history.length, 2);
  assert.equal(state.bookErrors["1"].count, 1, "the counter restarts with the new condition");
  assert.equal(state.bookErrors["1"].error, "fetch failed");

  // And another market is its own row, never folded into the first.
  record(state, { tokenId: "2", question: "Games Total: O/U 4.5" }, new Error("fetch failed"), "2026-09-05T08:03:34.323Z");
  assert.equal(state.history.length, 3);
  assert.equal(state.bookErrors["2"].count, 1);
});

// Asked for: a position whose outcome the market has already decided still waits hours for
// Polymarket to resolve it, with the stake locked the whole time. Selling one tick below
// certainty pays about a cent a share to get that capital back now.
test("settlement close: a decided market is sold at the bid rather than held to resolution", () => {
  const position = { tokenId: "1", shares: 6.9, totalCostUsdc: 4.92, netGainIfWinUsdc: 2.01, feeRate: 0, feesEnabled: false };

  const reason = (bid, plan) => worker.exitReason({ bestBidPrice: bid, ...plan });

  // A portfolio that only wants this must still be WATCHED. Requiring a stop in watchPlan
  // is what would have left it out of the watch list entirely -- the books below are read
  // for exactly what that returns, so an unwatched position is never looked at again.
  const settlementOnly = worker.watchPlan(position, {
    enabled: true,
    stopLossEnabled: false,
    stopLossRiskMultiplier: 0,
    settlementCloseBid: 0.99,
  });
  assert.ok(settlementOnly, "a settlement-close-only portfolio's position is watched");
  assert.equal(settlementOnly.stopPrice, null, "with no stop invented from a 0 multiplier");
  assert.equal(settlementOnly.triggerPrice, null);
  assert.equal(settlementOnly.settlementCloseBid, 0.99);

  // Neither reason configured is still not watched: nothing would ever act on it.
  assert.equal(worker.watchPlan(position, { enabled: true, stopLossEnabled: false, stopLossRiskMultiplier: 0 }), null);

  // And a portfolio with both keeps its stop as well.
  const both = worker.watchPlan(position, { enabled: true, stopLossRiskMultiplier: 2, settlementCloseBid: 0.99 });
  assert.ok(both.stopPrice > 0 && both.stopPrice < 1);
  assert.equal(both.settlementCloseBid, 0.99);

  // The stop is unaffected by the new rule.
  assert.equal(reason(0.12, { stopPrice: 0.13, triggerPrice: 0.132, settlementCloseBid: null }), "stop");
  assert.equal(reason(0.5, { stopPrice: 0.13, triggerPrice: 0.132, settlementCloseBid: null }), null);

  // And the settlement close fires on its own, with no stop configured at all.
  assert.equal(reason(0.99, { stopPrice: null, triggerPrice: null, settlementCloseBid: 0.99 }), "settlement");
  assert.equal(reason(0.995, { stopPrice: null, triggerPrice: null, settlementCloseBid: 0.99 }), "settlement");
  assert.equal(reason(0.98, { stopPrice: null, triggerPrice: null, settlementCloseBid: 0.99 }), null);

  // A market with no bid at all is not a decided market.
  assert.equal(reason(0, { stopPrice: null, triggerPrice: null, settlementCloseBid: 0.99 }), null);
  assert.equal(reason(null, { stopPrice: null, triggerPrice: null, settlementCloseBid: 0.99 }), null);

  // Both can be true only in a market that went from a loss to certainty within one pass.
  // The stop is the more urgent of the two, so it wins.
  assert.equal(reason(0.99, { stopPrice: 0.995, triggerPrice: 0.997, settlementCloseBid: 0.99 }), "stop");

});

test("settlement close: the sell is priced at the bid, because there is no floor to protect", () => {
  // A stop keeps its floor: the whole point of one is not to sell below it while the book
  // is still there.
  assert.equal(worker.protectedExitPrice({ stopPrice: 0.13, bestBidPrice: 0.5, tickSize: 0.01 }), 0.13);
  // A settlement close has no floor. Passing the stop price here would price the sell under
  // a book that is quoting near certainty -- 0.13 into a 0.99 bid.
  assert.equal(worker.protectedExitPrice({ stopPrice: null, bestBidPrice: 0.99, tickSize: 0.01 }), 0.99);
  assert.equal(worker.protectedExitPrice({ stopPrice: null, bestBidPrice: 0.9994, tickSize: 0.001 }), 0.999);
  // And with no bid there is nothing to sell into, floor or not.
  assert.equal(worker.protectedExitPrice({ stopPrice: null, bestBidPrice: 0, tickSize: 0.01 }), null);
  assert.equal(worker.protectedExitPrice({ stopPrice: null, bestBidPrice: null, tickSize: 0.01 }), null);

  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  // The submission has to drop the floor, or the price above is never the one sent.
  assert.match(source, /await submitProtectedExit\(\{ \.\.\.plan, stopPrice: null \}, \{ bestBidPrice: exitBid \}\)/);
  // A settlement-only position used to be held back to a slower cadence of its own, because
  // reading its book cost a request of its own. Batching removed that cost, so the reason
  // is gone -- and holding a position back from the pass that would have sold it is the
  // delay this loop exists to avoid. Every plan is now read every pass.
  assert.doesNotMatch(source, /SETTLEMENT_SCAN_INTERVAL_MS/,
    "no position waits for a cadence of its own any more");
  assert.doesNotMatch(source, /settlementScannedAt/);
});

// Reported: the stop sold a WINNING position. Measured on "Avispa Fukuoka vs. FC Mito Holly
// Hock: 1st Half O/U 1.5", four minutes after a 12:00 kickoff, holding Under 1.5 bought at
// 0.70 with the floor at 0.129981:
//
//   bestBid 0.10  exitPrice 0.10  -> sold 7 Under at 9.6c
//
// The first half finished 0-0 and Under resolved at 1.00. Under was never near 0.10; the
// market simply had no bid side at kickoff, and the stop read the one lowball order resting
// there as the price. A neighbouring market's bid bounced 0.13, 0.07, 0.06, 0.12, 0.06,
// 0.01 inside four minutes over the same window -- not a price series, an empty book.
test("stop trigger: a lowball bid the rest of the book contradicts is not a price", () => {
  const floor = { stopPrice: 0.129981, triggerPrice: 0.131981 };

  // The reported case: bid through the floor, ask still up where the market really is.
  assert.equal(worker.exitTrigger({ ...floor, bestBidPrice: 0.10, bestAskPrice: 0.90 }), false,
    "a 0.10 bid against a 0.90 ask is a 0.50 mid: the market has not moved against us");
  assert.equal(worker.exitTrigger({ ...floor, bestBidPrice: 0.10, bestAskPrice: 0.75 }), false);

  // A genuinely collapsing outcome must still fire: its ask collapses with it.
  assert.equal(worker.exitTrigger({ ...floor, bestBidPrice: 0.01, bestAskPrice: 0.05 }), true,
    "bid 0.01 against ask 0.05 is a 0.03 mid, still through the floor");
  assert.equal(worker.exitTrigger({ ...floor, bestBidPrice: 0.09, bestAskPrice: 0.11 }), true,
    "a healthy tight book is unaffected -- bid, ask and mid agree");

  // Nobody offering at all is a state the midpoint cannot describe, so the bid stands alone
  // there, exactly as it always has.
  assert.equal(worker.exitTrigger({ ...floor, bestBidPrice: 0.10, bestAskPrice: null }), true);
  assert.equal(worker.exitTrigger({ ...floor, bestBidPrice: 0.10 }), true);

  // The guards that were already there are untouched: no bid is not a low bid.
  assert.equal(worker.exitTrigger({ ...floor, bestBidPrice: null, bestAskPrice: 0.9 }), false);
  assert.equal(worker.exitTrigger({ ...floor, bestBidPrice: 0, bestAskPrice: 0.9 }), false);
  // And a bid above the trigger is not a stop whatever the ask says.
  assert.equal(worker.exitTrigger({ ...floor, bestBidPrice: 0.70, bestAskPrice: 0.72 }), false);

  // exitReason has to pass the ask through, or the rule above never reaches the decision.
  assert.equal(
    worker.exitReason({ bestBidPrice: 0.10, bestAskPrice: 0.90, ...floor, settlementCloseBid: null }),
    null,
  );
  assert.equal(
    worker.exitReason({ bestBidPrice: 0.01, bestAskPrice: 0.05, ...floor, settlementCloseBid: null }),
    "stop",
  );

  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  assert.match(source, /const currentBestAsk = bestAsk\(book\);/);
  assert.match(source, /bestAskPrice: currentBestAsk,/);
  // Recorded on the event, because the bid alone could not tell a collapsing market from an
  // empty book and there was no way to tell afterwards which one had sold.
  assert.match(source, /bestAsk: currentBestAsk,/);
  assert.match(source, /midPrice: currentBestBid != null && currentBestAsk != null/);
});

// Measured live in the same window: four positions in four unrelated markets sold within
// the same second, each at 0.67-0.70 against an entry of 0.7028, each carrying
// stopPrice 0.704193 and riskTargetUsdc 0.040192. A four-cent risk target on a 4.92 stake
// puts the floor ABOVE the entry, so the first book read liquidated all of them.
test("stop plan: a floor at or above the entry price is refused, not armed", () => {
  // 7 shares for 4.9199 is an entry of 0.702843 -- the production position, fees on, which
  // is what pushes the floor of a tiny risk target above the entry in the first place.
  const position = { shares: 7, totalCostUsdc: 4.9199, netGainIfWinUsdc: 2.0096, feeRate: 0.02, feesEnabled: true };

  const collapsed = worker.equalRiskExitPlan({ ...position, riskTargetUsdc: 0.02 });
  assert.equal(collapsed.protectable, false);
  assert.match(collapsed.reason, /is not below the .* entry price/);
  assert.match(collapsed.reason, /risk target 0\.0200 USDC on a 4\.92 USDC position/,
    "the refusal names the numbers it was refused for, or the next report says nothing again");
  assert.ok(collapsed.stopPrice >= collapsed.entryPrice);

  // The portfolio's real setting is unaffected: a 2x multiplier puts the floor far below.
  const armed = worker.equalRiskExitPlan({ ...position, stopLossRiskMultiplier: 2 });
  assert.equal(armed.protectable, true);
  assert.ok(armed.stopPrice < armed.entryPrice);
  assert.ok(Math.abs(armed.riskTargetUsdc - 4.0192) < 0.0001);

  // The smaller the target, the further ABOVE entry the floor sits -- every one of them a
  // liquidation at entry rather than a loss cap.
  for (const riskTargetUsdc of [0.02, 0.01, 0.001]) {
    assert.equal(worker.equalRiskExitPlan({ ...position, riskTargetUsdc }).protectable, false, `risk target ${riskTargetUsdc}`);
  }

  // A refused plan must not be watched, or the worker would act on it anyway. This is the
  // real path: the policy payload's multiplier is copied onto the position before the plan
  // is derived, so a collapsed multiplier arrives exactly here.
  assert.equal(
    worker.watchPlan({ ...position, tokenId: "1", riskTargetUsdc: 0.02 }, { enabled: true }),
    null,
    "nothing to watch: no stop can be armed and no settlement close is configured",
  );
  // But the settlement close is a separate reason to watch, and an unarmed stop must not
  // take it down with it.
  const stillWatched = worker.watchPlan(
    { ...position, tokenId: "1", riskTargetUsdc: 0.02 },
    { enabled: true, settlementCloseBid: 0.99 },
  );
  assert.ok(stillWatched);
  assert.equal(stillWatched.stopPrice, null);
  assert.equal(stillWatched.settlementCloseBid, 0.99);
});

// Asked for, in these words: if we react late and can save less of the position than
// intended, save what can be saved and just sell. And if the account does not hold the
// position, there is no point trying at all.
//
// Measured on the Pi before this: 84 EXIT_REJECTED against 5 EXIT_SUBMITTED, every refusal
//
//   "not enough balance / allowance: the balance is not enough
//    -> balance: 7221, order amount: 6840000"
//
// 0.007221 shares held against the 6.84 the plan asked to sell. The exchange refuses the
// whole order, so being late rescued nothing at all rather than rescuing less -- and the
// attempt was not terminal, so it repeated every twenty seconds for days.
test("exit refusals: the account's own answer ends the attempt, everything else retries", async () => {
  const worker = await import("../tools/rpi-live-exit-worker.mjs");

  // The exchange's own view of the account. No retry can talk it out of this.
  assert.equal(worker.exitFailureIsTerminal({
    error: "not enough balance / allowance: the balance is not enough -> balance: 7221, order amount: 6840000",
  }), true);
  assert.equal(worker.exitFailureIsTerminal({ errorMsg: "the balance is not enough" }), true);

  // Everything else is a condition of the moment and is worth another pass. A stop that
  // has given up on a position it could still sell is the worse failure of the two.
  assert.equal(worker.exitFailureIsTerminal({ error: "no valid exit price on this market's tick grid" }), false);
  assert.equal(worker.exitFailureIsTerminal({ error: "fetch failed" }), false);
  assert.equal(worker.exitFailureIsTerminal({ error: "invalid POLY_1271 signature" }), false,
    "a signing fault is a configuration problem the next live state can correct");
  assert.equal(worker.exitFailureIsTerminal({}), false);
  assert.equal(worker.exitFailureIsTerminal(null), false);

  // Nothing is asked of the exchange before selling. A balance query is a race with
  // itself -- the answer is stale by the time the order lands, and on a resolving market it
  // can be stale inside the five seconds between passes -- so the whole position is offered
  // and the refusal supplies the number for the one retry that follows.
  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /getBalanceAllowance/,
    "the balance is never queried ahead of the sell");
  assert.match(source, /let size = planned;\s*\n\s*let response = await sell\(size, OrderType\.FOK\);/,
    "the first attempt offers the whole position");

  // The refusal carries the balance at the instant it rejected the order, which is as fresh
  // as this can be. 0.007221 shares against the 6.84 the plan asked for.
  assert.equal(worker.balanceFromRejection({
    error: "not enough balance / allowance: the balance is not enough -> balance: 7221, order amount: 6840000",
  }), 0.007221);
  // A refusal about something else is not a size question and must not resize anything.
  assert.equal(worker.balanceFromRejection({ error: "invalid POLY_1271 signature" }), null);
  assert.equal(worker.balanceFromRejection({ error: "not enough balance" }), null,
    "a size refusal that quotes no number leaves the size alone rather than guessing zero");
  assert.equal(worker.balanceFromRejection({}), null);
  assert.equal(worker.balanceFromRejection(null), null);
  // Nothing held at all: the retry is skipped and the attempt ends.
  assert.equal(worker.balanceFromRejection({
    error: "the balance is not enough -> balance: 0, order amount: 6840000",
  }), 0);

  // Floored, never rounded up -- asking for a hair more than the balance is the refusal
  // being answered -- and capped at the plan, because the account may hold the same token
  // for another portfolio and only this one's position is being closed.
  assert.match(source, /size = Math\.floor\(Math\.min\(planned, held\) \* 10000\) \/ 10000;/);
  assert.match(source, /if \(!\(held > 0\)\) \{[\s\S]{0,240}terminal: true/,
    "a position the account does not hold ends the attempt instead of repeating it");
});

// Reported: certainty selling works, but one position of the same portfolio sold at 99.9
// and "Set 2 Winner: Zverev vs Tabilo" never did. Measured beforehand, it was in the policy
// payload -- "covered ... stake 4.9299" -- and absent from the worker's seven watched
// positions, so nothing was reading its book.
//
// The difference between the two positions was their status. PENDING_RESOLUTION means the
// market has stopped trading and its settlement price is not published yet: the shares are
// still held, and it is the exact state the certainty close exists for. Excluding it meant
// that the moment a position became the kind this rule acts on, it stopped being watched.
test("a position awaiting resolution is still watched, because that is when it sells", () => {
  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  const positions = new Function("state", `
    ${functionBody(source, "number")}
    const FINISHED_POSITION_STATUSES = ${JSON.stringify(worker.FINISHED_POSITION_STATUSES)};
    ${functionBody(source, "livePositions")}
    return livePositions(state).map((position) => position.question);
  `);

  const held = { tokenId: "1", shares: 4.93 };
  const watched = positions({
    positions: [
      { ...held, question: "Set 2 Winner: Zverev vs Tabilo", status: "PENDING_RESOLUTION" },
      { ...held, question: "still trading", status: "OPEN" },
      { ...held, question: "no status at all" },
      // Genuinely finished: the shares are gone or the settlement is already published, so
      // there is nothing left for a stop or a close to do.
      { ...held, question: "sold", status: "SOLD" },
      { ...held, question: "won", status: "WON" },
      { ...held, question: "lost", status: "LOST" },
      { ...held, question: "closed", status: "CLOSED" },
      { ...held, question: "redeem", status: "REDEEM_REQUIRED" },
    ],
  });

  assert.deepEqual(watched, ["Set 2 Winner: Zverev vs Tabilo", "still trading", "no status at all"]);
  assert.ok(!worker.FINISHED_POSITION_STATUSES.includes("PENDING_RESOLUTION"),
    "awaiting a settlement price is not the same as being settled");

  // The other two reasons to skip a position are untouched: without a token there is
  // nothing to place an order against, and without shares there is nothing to sell.
  assert.deepEqual(positions({ positions: [{ shares: 4.93, question: "no token" }] }), []);
  assert.deepEqual(positions({ positions: [{ tokenId: "1", shares: 0, question: "no shares" }] }), []);
});

// Measured as the current blocker on the certainty close: twelve refusals, the most recent
// failures on the account, all at px 0.999 on a 0.001 tick with sizes carrying four
// decimals. "invalid maker amount" is the exchange refusing the SIZE's precision -- a
// different question from the balance, and it wants a different answer.
test("a size the exchange will not accept is retried coarser, not smaller", async () => {
  const worker = await import("../tools/rpi-live-exit-worker.mjs");

  assert.equal(worker.makerAmountPrecisionRefusal({ error: "invalid maker amount" }), true);
  assert.equal(worker.makerAmountPrecisionRefusal({ errorMsg: "invalid amounts: maker amount precision" }), true);

  // Each refusal has its own answer, and confusing them is how a retry loop forms: a
  // balance refusal is retried SMALLER, a precision refusal COARSER, and a signer fault is
  // not a size question at all.
  const balance = { error: "not enough balance / allowance: the balance is not enough -> balance: 7221, order amount: 6840000" };
  assert.equal(worker.makerAmountPrecisionRefusal(balance), false);
  assert.equal(worker.exitFailureIsTerminal(balance), true);
  assert.equal(worker.makerAmountPrecisionRefusal({ error: "the order signer address has to be the address of the API KEY" }), false);
  assert.equal(worker.makerAmountPrecisionRefusal({}), false);
  assert.equal(worker.makerAmountPrecisionRefusal(null), false);

  // A precision refusal is NOT terminal: it is answerable, and giving up on it would
  // abandon a position the account still holds.
  assert.equal(worker.exitFailureIsTerminal({ error: "invalid maker amount" }), false);

  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  assert.match(source, /const coarse = Math\.floor\(size \* 100\) \/ 100;/,
    "two decimals, floored -- never up, which would ask for shares that are not held");
  // Once. A retry that is refused the same way again is not tried a third time, or the
  // loop this whole file has been fixed for twice comes back.
  assert.match(source, /if \(exitFilled\(retried\) \|\| !makerAmountPrecisionRefusal\(retried\)\)/);
});

// Asked for, retracting an earlier instruction: the stop should NOT sell at any cost. If it
// cannot be caught within about 10% of the level that was set, leave the position and see
// what happens.
//
// Measured on the account, which is what prompted it: positions bought near 76-80c sold at
// 1.5c and 5.7c against floors around 25-37c. Twenty points and more below the configured
// level is not a capped loss, it is a liquidation at whatever happened to be resting.
test("a stop declines to sell into a gap far below its own floor", async () => {
  const worker = await import("../tools/rpi-live-exit-worker.mjs");

  // Read as a fraction OF THE STOP, not as percentage points: 10% under a 0.30 floor is
  // 0.27, not 0.20. That is what "10% under what I have set" means when the stop is a price.
  assert.equal(worker.stopGapFloorPrice(0.30, 0.1), 0.27);
  assert.equal(worker.stopGapFloorPrice(0.2575, 0.1), 0.23175);
  assert.equal(worker.stopGapFloorPrice(null, 0.1), null);
  assert.equal(worker.stopGapFloorPrice(0, 0.1), null);

  // The reported case: a 0.2575 stop against a 1.5c book.
  assert.equal(worker.stopGapIsTooWide({ bestBidPrice: 0.015, stopPrice: 0.2575, tolerance: 0.1 }), true);
  // Just inside the tolerance still sells -- the point is to cap the loss near the level,
  // not to refuse every stop that slips a little.
  assert.equal(worker.stopGapIsTooWide({ bestBidPrice: 0.24, stopPrice: 0.2575, tolerance: 0.1 }), false);
  assert.equal(worker.stopGapIsTooWide({ bestBidPrice: 0.2575, stopPrice: 0.2575, tolerance: 0.1 }), false);

  // A settlement close has no floor and is not capping a loss: it takes the bid on purpose,
  // so this must never refuse it.
  assert.equal(worker.stopGapIsTooWide({ bestBidPrice: 0.999, stopPrice: null, tolerance: 0.1 }), false);

  // No bid at all is no market rather than a wide gap. exitTrigger already refuses that,
  // and answering it here too would make two rules disagree about one book.
  assert.equal(worker.stopGapIsTooWide({ bestBidPrice: null, stopPrice: 0.30, tolerance: 0.1 }), false);
  assert.equal(worker.stopGapIsTooWide({ bestBidPrice: 0, stopPrice: 0.30, tolerance: 0.1 }), false);

  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  // Decided on the FRESH bid -- the one the sell would actually meet -- not the batched read
  // the trigger was decided on.
  assert.match(source, /if \(reason === "stop" && stopGapIsTooWide\(\{ bestBidPrice: exitBid, stopPrice: plan\.stopPrice \}\)\)/);
  // Nothing is sent and nothing is recorded as an attempt, so the next pass asks again: a
  // book that gapped on one tick often comes back, and a terminal mark would abandon it.
  assert.match(source, /recordDeclinedStop\(context\.state, plan, \{/);
  assert.doesNotMatch(source, /terminal: true[\s\S]{0,200}STOP_DECLINED_GAPPED/);
  // Collapsed to a standing row. At one pass a second an event each would bury the whole
  // history in minutes, which is the trap the book errors already fell into once.
  assert.match(source, /if \(previous\) return;\s*\n\s*recordEvent\(state, \{\s*\n\s*at, type: "STOP_DECLINED_GAPPED"/);
  // And cleared once it does sell, or the row would outlive what it describes.
  assert.match(source, /clearDeclinedStop\(context\.state, plan\.tokenId\);/);
});
