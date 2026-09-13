import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

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
  // FOK first on the WHOLE position, with nothing asked of the exchange beforehand. The FAK
  // follows only once the FOK is DECIDED -- a queued FOK has not failed, and sending the FAK
  // on top of it would be a second live order for the same shares.
  assert.match(source, /if \(!exitFilled\(response\) && !exitPendingMatch\(response\) && ALLOW_PARTIAL\) \{\s*\n\s*response = await sell\(size, OrderType\.FAK\);/);
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
  // Priced at the level actually in force -- the higher of the equal-risk floor and the
  // probability floor -- not at plan.stopPrice, which may not be the one that triggered.
  assert.match(source, /submitProtectedExit\(\{ \.\.\.plan, stopPrice: activeFloor \}, \{ bestBidPrice: exitBid \}\)/);
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
  // One request for every book INCLUDING the dip-entry watch, which rides the same call for
  // the same reason: it needs the stop's reaction time, and a second fetch would put back
  // the round trip per pass that this batching removed.
  assert.match(source, /const books = await fetchBooks\(\[\.\.\.new Set\(\[\.\.\.candidates\.map\(\(plan\) => plan\.tokenId\), \.\.\.dipTokens\]\)\]\);/,
    "the books must be read in a single batched request");
  assert.match(source, /await fetch\(`\$\{CLOB_HOST\}\/books`/, "which is the CLOB's own /books endpoint");
  const check = source.slice(source.indexOf("const candidates = plans.filter("));
  const batchAt = check.indexOf("await fetchBooks([");
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

// The same trap one level up, and measured too: 482 of the 500 retained events were
// WORKER_ERROR "fetch failed", one per second through a nine-minute outage of the host the
// worker polls. Eighteen rows were left for everything else the worker had ever done, which
// is not enough to hold a settlement close, a protective sell, or the one recorded dip the
// new rule is supposed to be judged by.
test("worker errors: an outage is counted once per episode, not once per second", () => {
  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  // The episode window is taken from the module rather than restated here: a test that
  // declares its own threshold passes no matter what the worker actually uses.
  const window = Number(/WORKER_ERROR_EPISODE_MS = (\d+)/.exec(source)?.[1]);
  assert.equal(window, 600000, "ten minutes; the assertions below are written against it");
  const record = new Function(
    "recordEvent",
    "WORKER_ERROR_EPISODE_MS",
    `${functionBody(source, "recordWorkerError")}\nreturn recordWorkerError;`,
  )((state, event) => { state.history.push(event); }, window);
  const state = { history: [] };

  // One second apart, as the real loop produces them.
  record(state, new Error("fetch failed"), "2026-09-11T06:16:21.616Z");
  record(state, new Error("fetch failed"), "2026-09-11T06:16:22.594Z");
  record(state, new Error("fetch failed"), "2026-09-11T06:16:23.609Z");
  assert.equal(state.history.length, 1, "the first failure is logged at once, the repeats are counted");
  assert.equal(state.workerErrors["fetch failed"].count, 3);
  assert.equal(state.workerErrors["fetch failed"].episodes, 1);
  assert.equal(state.workerErrors["fetch failed"].firstAt, "2026-09-11T06:16:21.616Z");
  assert.equal(state.workerErrors["fetch failed"].lastAt, "2026-09-11T06:16:23.609Z");

  // Still the same episode nine minutes in, so still no second row.
  record(state, new Error("fetch failed"), "2026-09-11T06:25:00.000Z");
  assert.equal(state.history.length, 1);
  assert.equal(state.workerErrors["fetch failed"].count, 4);

  // Gone for over ten minutes and back: a new outage is new information and is logged.
  record(state, new Error("fetch failed"), "2026-09-11T07:30:00.000Z");
  assert.equal(state.history.length, 2, "a failure that had stopped and returned is logged again");
  assert.equal(state.workerErrors["fetch failed"].count, 1, "the run counter restarts with the episode");
  assert.equal(state.workerErrors["fetch failed"].episodes, 2);
  assert.equal(state.workerErrors["fetch failed"].totalCount, 5, "the lifetime total is kept across episodes");

  // A different message is its own row and is never folded into the first.
  record(state, new Error("HTTP 502"), "2026-09-11T07:30:01.000Z");
  assert.equal(state.history.length, 3);
  assert.equal(state.workerErrors["HTTP 502"].count, 1);

  // The flood must be gone at the call site too, or the collapsing helper is dead code --
  // which is exactly how the BOOK_ERROR fix could have been shipped without working.
  assert.match(source, /recordWorkerError\(context\.state, error, new Date\(\)\.toISOString\(\)\)/);
  assert.doesNotMatch(source, /type: "WORKER_ERROR", error: error\?\.message/);
});

// Asked for: a position whose outcome the market has already decided still waits hours for
// Polymarket to resolve it, with the stake locked the whole time. Selling one tick below
// certainty pays about a cent a share to get that capital back now.
test("settlement close: a decided market is sold at the bid rather than held to resolution", () => {
  const position = { tokenId: "1", shares: 6.9, totalCostUsdc: 4.92, netGainIfWinUsdc: 2.01, feeRate: 0, feesEnabled: false };

  // The position's size travels with every call, because what a close forfeits is measured
  // in USDC and a price on its own cannot say how much that is.
  const reason = (bid, plan) => worker.exitReason({ bestBidPrice: bid, shares: position.shares, ...plan });

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

  // And the settlement close fires on its own, with no stop configured at all -- but only
  // where taking the bid gives up next to nothing. 6.9 shares at 0.99 hands back 6.9 cents
  // of a match already won, which is the thing this whole rule exists to stop; at 0.999 it
  // is seven tenths of a cent, and that is a fair price for the capital back now.
  assert.equal(reason(0.999, { stopPrice: null, triggerPrice: null, settlementCloseBid: 0.99 }), "settlement");
  assert.equal(reason(0.99, { stopPrice: null, triggerPrice: null, settlementCloseBid: 0.99 }), null,
    "a hundredth of the position handed back is not a close, it is a donation");
  assert.equal(reason(0.998, { stopPrice: null, triggerPrice: null, settlementCloseBid: 0.99 }), "settlement",
    "0.2% is the line, and it is inclusive");
  assert.equal(reason(0.98, { stopPrice: null, triggerPrice: null, settlementCloseBid: 0.99 }), null);

  // A market with no bid at all is not a decided market.
  assert.equal(reason(0, { stopPrice: null, triggerPrice: null, settlementCloseBid: 0.99 }), null);
  assert.equal(reason(null, { stopPrice: null, triggerPrice: null, settlementCloseBid: 0.99 }), null);

  // And the rule does not care how big the position is, which is the point of expressing it
  // as a fraction: the same bid decides the same way at seven shares and at seventy, so a
  // stake that grows does not quietly switch the protection off.
  for (const size of [null, 0.5, 7, 70, 700]) {
    assert.equal(worker.exitReason({
      bestBidPrice: 0.999, stopPrice: null, triggerPrice: null, settlementCloseBid: 0.99, shares: size,
    }), "settlement", `0.999 is worth taking at any size, including ${size}`);
    assert.equal(worker.exitReason({
      bestBidPrice: 0.99, stopPrice: null, triggerPrice: null, settlementCloseBid: 0.99, shares: size,
    }), null, `0.99 against a certainty setting is worth taking at no size, including ${size}`);
  }

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
  assert.match(source, /let size = sellableSize\(planned\);[\s\S]{0,700}?let response = await sell\(size, OrderType\.FOK\);/,
    "the first attempt offers the whole position, on the size grid the exchange signs it on");

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
  // for another portfolio and only this one's position is being closed. Floored onto the
  // exchange's own two-decimal size grid, not to four decimals: the client signs on that
  // grid, so anything finer is a number the order never carried.
  assert.match(source, /size = sellableSize\(Math\.min\(planned, held\)\);/);
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
    const DUST_SHARES = ${JSON.stringify(worker.DUST_SHARES)};
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

  // And a third: a remainder under a hundredth of a share is dust, not a position. The
  // exchange refuses an order for it as "invalid maker amount", and the worker retried that
  // every twenty seconds -- 333 of its 500 retained events, which buried the history that
  // every other diagnosis reads.
  assert.deepEqual(positions({ positions: [{ tokenId: "1", shares: 0.0034, question: "dust" }] }), []);
  assert.deepEqual(positions({ positions: [{ tokenId: "1", shares: 0.0099, question: "dust" }] }), []);
  assert.deepEqual(positions({ positions: [{ tokenId: "1", shares: 0.01, question: "the smallest real position" }] }),
    ["the smallest real position"]);
});

// "invalid maker amount" is the exchange refusing an order for DUST. Measured on the worker,
// and it took three attempts to see: every one of them was an order for 0.0031 or 0.0034
// shares, below the minimum order size the exchange accepts. 333 of 500 retained events.
//
// The two fixes before this one were rules invented to explain that error -- a two-decimal
// floor, then a whole-cent USDC leg -- and both were wrong because the size was never
// written down anywhere. A dust order cannot be resized into validity, only stopped.
test("an order for dust is stopped, not retried into validity", async () => {
  const worker = await import("../tools/rpi-live-exit-worker.mjs");
  const sync = readFileSync(new URL("../tools/live-account-sync.mjs", import.meta.url), "utf8");

  // One threshold, two files. A remainder the account sync counts as CLOSED while the worker
  // counts it as an open position to protect is exactly what happened: the sync stopped
  // reporting these and the worker went on trying to sell them every twenty seconds.
  assert.equal(worker.DUST_SHARES, 0.01);
  assert.match(sync, /const DUST_SHARES = 0\.01;/,
    "the account sync has to agree, or a position is closed in one file and open in the other");

  // Terminal now. Retrying it forever is the actual damage -- not the failed sale, which was
  // a sale of nothing, but the 500-event history it floods, so that the record of a real
  // stop-loss decision had already scrolled out of the log kept to explain it.
  assert.equal(worker.exitFailureIsTerminal({ error: "invalid maker amount" }), true);
  const balance = { error: "not enough balance / allowance: the balance is not enough -> balance: 7221, order amount: 6840000" };
  assert.equal(worker.exitFailureIsTerminal(balance), true);
  assert.equal(worker.exitFailureIsTerminal({ error: "the account no longer holds this position" }), false,
    "that one is already marked terminal at the call site, by its own path");
  assert.equal(worker.exitFailureIsTerminal({}), false);

  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  // Dust never reaches the watch list in the first place.
  assert.match(source, /number\(position\.shares \?\? position\.size, 0\) >= DUST_SHARES/);
  // And a position that falls to dust between the plan and the order is refused here rather
  // than sent, so the exchange is never asked a question with only one answer.
  assert.match(source, /if \(planned == null \|\| planned < DUST_SHARES\) \{/);
  assert.match(source, /shares are dust,/);
  // The rules invented to explain this error are gone, with their retry.
  assert.doesNotMatch(source, /const coarse = Math\.floor\(size \* 100\) \/ 100;/);
  assert.doesNotMatch(source, /makerAmountSafeSize/);
  assert.doesNotMatch(source, /makerAmountPrecisionRefusal/);
  // The size stays on the record, which is what finally answered it.
  assert.match(source, /exitShares: response\?\.exitShares \?\? null,/);
  assert.match(source, /makerAmountUsdc: response\?\.makerAmountUsdc \?\? null,/);

  // And the two fields the error actually names, off the SIGNED order rather than off the
  // request. They are different numbers -- the client rounds a SELL size down before signing,
  // so a plan asking for 6.8472 shares is posted as 6.84 -- and reasoning about the request
  // instead of the order is what made the last two attempts guesses.
  assert.match(source, /makerAmount: order\?\.makerAmount != null \? String\(order\.makerAmount\) : null,/);
  assert.match(source, /takerAmount: order\?\.takerAmount != null \? String\(order\.takerAmount\) : null,/);
  assert.match(source, /signedAmounts: response\?\.signedAmounts \?\? null,/);
  // Captured where the order is built, so a refusal carries it too -- a field recorded only
  // on success would be absent from every row worth reading.
  const builder = source.slice(source.indexOf("const sell = async (size, orderType)"));
  assert.ok(builder.indexOf("signedAmounts = {") < builder.indexOf("client.postOrder"),
    "the amounts have to be captured before the order is posted, or a refusal loses them");
});

// The status workflow reads this state, and it reads it through `node -e '<script>'` -- one
// single-quoted shell argument. A lone apostrophe anywhere inside it, in a COMMENT included,
// closes the string and the remaining words become arguments.
//
// Not hypothetical: a possessive in one comment made node try to open a file named "own",
// and the read that was meant to explain a stop loss that did not fire failed instead. The
// diagnosis tool has to be the one thing that does not break while something is wrong.
test("the worker status script survives being one single-quoted shell argument", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/trading-rpi-live-exit-worker-status.yml", import.meta.url),
    "utf8",
  );
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line.trim() === "node -e '");
  assert.ok(start > 0, "the inline node script has to be found for this to mean anything");
  const end = lines.findIndex((line, index) => index > start && line.trim().startsWith("' \"$state\""));
  assert.ok(end > start, "and its closing quote too");
  const body = lines.slice(start + 1, end);
  const offenders = body
    .map((line, index) => [start + index + 2, line])
    .filter(([, line]) => line.includes("'"));
  assert.deepEqual(offenders, [],
    `an apostrophe inside the single-quoted node script ends it: ${JSON.stringify(offenders)}`);

  // And that it is valid JavaScript at all. The apostrophe rule was written after one
  // syntax fault broke this read, and the next one that broke it was an ordinary duplicate
  // declaration -- caught only by dispatching the workflow, which is the slowest possible
  // place to find out. Parsing it here catches every kind at once.
  assert.doesNotThrow(() => new Script(body.join("\n")),
    "the inline status script has to parse");
});

// Asked for as a strict rule, with the trade and the market side by side: Counter-Strike
// A Great Chaos vs DNK, bought at 77.9%, exited around 50% for a 1.79 loss -- and Polymarket
// showed M1, M2 and M3 all blank on a market with 4.06K of volume. Not one map had been
// played, so nothing had happened for the price to be about.
test("a stop does not sell before the fixture has started", async () => {
  const worker = await import("../tools/rpi-live-exit-worker.mjs");

  // The kickoff is read on the corroborated rule, not off a bare gameStartTime. Gamma
  // populates that field on markets that are not fixtures at all -- a tweet-count market
  // carried the tracking window's start there with every sports field blank -- so one of
  // gameId, sportsMarketType, eventStartTime, teamAID or teamBID has to back it up.
  assert.equal(worker.preciseKickoffAt({ gameStartTime: "2026-09-07T20:00:00Z" }), null,
    "a lone gameStartTime is not proof of a fixture");
  assert.equal(
    worker.preciseKickoffAt({ gameStartTime: "2026-09-07T20:00:00Z", gameId: "abc" }),
    "2026-09-07T20:00:00.000Z",
  );
  assert.equal(worker.preciseKickoffAt({ eventStartTime: "2026-09-07T20:00:00Z" }), "2026-09-07T20:00:00.000Z");
  assert.equal(
    worker.preciseKickoffAt({ events: [{ startDateIso: "2026-09-07T20:00:00Z" }] }),
    "2026-09-07T20:00:00.000Z",
  );
  assert.equal(worker.preciseKickoffAt({}), null);
  assert.equal(worker.preciseKickoffAt({ gameStartTime: "not a date", gameId: "abc" }), null);

  const at = Date.parse("2026-09-07T19:26:00Z");
  // The reported trade: the stop fired at 19:26 on a fixture scheduled later.
  assert.equal(worker.stopIsBeforeKickoff({ kickoffAt: "2026-09-07T20:00:00Z", now: at }), true);
  // Under way, so the stop is the owner's rule again and this one stands aside.
  assert.equal(worker.stopIsBeforeKickoff({ kickoffAt: "2026-09-07T19:00:00Z", now: at }), false);
  // An unknown kickoff ABSTAINS. Refusing on a missing date would switch every stop off on
  // every market Gamma does not schedule, which is the opposite of a strict rule.
  assert.equal(worker.stopIsBeforeKickoff({ kickoffAt: null, now: at }), false);
  assert.equal(worker.stopIsBeforeKickoff({ kickoffAt: "", now: at }), false);
  assert.equal(worker.stopIsBeforeKickoff({}), false);

  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  // First of the stop's refusals. The others describe a book that moved against the
  // position; this one says nothing has happened at all, and reporting a wide spread on a
  // match that has not begun sends the reader after the book when the answer is the clock.
  const stopBranch = source.slice(source.indexOf('if (reason === "stop") {'));
  assert.ok(stopBranch.indexOf("stopIsBeforeKickoff") < stopBranch.indexOf("stopBookIsUntradable"),
    "the kickoff is checked before the book");
  assert.match(source, /declineKind: "before-kickoff",/);
  // Cached, or a triggered stop would ask Gamma for an unmoving date once every twenty
  // seconds for as long as the book stays down.
  assert.match(source, /async function kickoffForToken\(state, tokenId, at\)/);
  assert.match(source, /const KICKOFF_UNKNOWN_RECHECK_MS = 15 \* 60 \* 1000;/);
  // A failed lookup is unknown, not "before kickoff": a Gamma outage must not become a
  // reason to hold every position.
  const lookup = source.slice(source.indexOf("async function kickoffForToken"));
  assert.match(lookup.slice(0, 1200), /\} catch \{[\s\S]*?kickoff = null;/);
});

test("a stop before kickoff is refused the same way on paper", async () => {
  const bot = await import("../tools/paper-trading-bot.mjs");
  const worker = await import("../tools/rpi-live-exit-worker.mjs");

  // One rule, two models: a paper portfolio that stops when the live worker would not is
  // worse than no paper portfolio, because it is what the rule gets tried on.
  const at = Date.parse("2026-09-07T19:26:00Z");
  for (const kickoffAt of ["2026-09-07T20:00:00Z", "2026-09-07T19:00:00Z", null, "", "not a date"]) {
    assert.equal(
      bot.paperStopIsBeforeKickoff({ kickoffAt, now: at }),
      worker.stopIsBeforeKickoff({ kickoffAt, now: at }),
      `the two models disagree about a ${kickoffAt} kickoff`,
    );
  }

  // And the paper side reads the kickoff off the market with the same corroboration, via
  // the bot's own sportsScheduledEventDateDetail rather than a second copy of the rule.
  assert.equal(bot.paperPreciseKickoffAt({}), null);
  assert.equal(
    bot.paperPreciseKickoffAt({ gameStartTime: "2026-09-07T20:00:00Z", gameId: "abc", question: "Team A vs Team B winner" }),
    "2026-09-07T20:00:00.000Z",
  );

  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.match(source, /const detail = sportsScheduledEventDateDetail\(market\);/,
    "the kickoff rule is read from the bot's own function, not re-derived");
  assert.match(source, /if \(!detail\?\.precise \|\| !detail\.date\) return null;/,
    "only a precise kickoff counts; a slug date is a whole-day bucket");
  // Regardless of a crossing: a crossing before kickoff is a drift on a thin book, and
  // booking a fill at the floor for it would record a loss the live account cannot take.
  const decision = source.slice(source.indexOf("function equalRiskStopExitDecision"));
  assert.ok(decision.indexOf("paperStopIsBeforeKickoff") < decision.indexOf("paperStopGapFloorPrice(floor)"),
    "the kickoff is checked before the gap band");
  assert.match(source, /kickoffAt: paperPreciseKickoffAt\(market\),/);
});

// Reported with the book in evidence: Games Total O/U 2.5 on a match that had not started,
// $291 of volume in the whole market, an order book showing asks at 97-99c and "No bids" on
// the other side. A position bought at 75% was left at about 25% for a 3.33 loss. Nothing had
// happened to the fixture -- there was no counterparty, and the price that fired the stop was
// the absence of one.
test("a stop does not sell into a book that has no counterparty", async () => {
  const worker = await import("../tools/rpi-live-exit-worker.mjs");
  const book = (bids, asks) => ({
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
  });

  // Depth is summed over every level at or above the price, not read off the top: a 5-share
  // top bid does not sell a 6.6-share position however good its price is.
  const deep = book([[0.74, 5], [0.73, 40], [0.6, 100]], [[0.76, 50]]);
  assert.equal(worker.bidDepthShares(deep, 0.74), 5);
  assert.equal(worker.bidDepthShares(deep, 0.73), 45);
  assert.equal(worker.bidDepthShares(deep, 0.5), 145);
  assert.equal(worker.bidDepthShares({}, 0.5), 0);

  const untradable = (options) => worker.stopBookIsUntradable(options);

  // A healthy book sells. The rule must not become a reason never to stop.
  assert.equal(untradable({
    book: deep, bestBidPrice: 0.74, bestAskPrice: 0.76, exitPrice: 0.73, shares: 6.6,
  }), null);

  // The reported case: a lone bid with nothing offered against it. exitTrigger deliberately
  // let this through -- "the bid stands alone there" -- and that is the hole.
  const oneSided = untradable({
    book: book([[0.25, 40]], []), bestBidPrice: 0.25, bestAskPrice: null, exitPrice: 0.25, shares: 6.6,
  });
  assert.equal(oneSided.kind, "one-sided");
  assert.match(oneSided.reason, /no ask at all/);

  // Three cents, as asked. A 0.10 bid against a 0.90 ask is not a price either.
  const wide = untradable({
    book: book([[0.1, 500]], [[0.9, 500]]), bestBidPrice: 0.1, bestAskPrice: 0.9, exitPrice: 0.1, shares: 6.6,
  });
  assert.equal(wide.kind, "wide-spread");
  assert.equal(wide.spread, 0.8);
  // And the boundary is inclusive: exactly three cents still sells.
  assert.equal(untradable({
    book: book([[0.71, 50]], [[0.74, 50]]), bestBidPrice: 0.71, bestAskPrice: 0.74, exitPrice: 0.71, shares: 6.6,
  }), null);
  assert.equal(untradable({
    book: book([[0.71, 50]], [[0.75, 50]]), bestBidPrice: 0.71, bestAskPrice: 0.75, exitPrice: 0.71, shares: 6.6,
  })?.kind, "wide-spread");

  // Enough capital behind the bid to take the position, measured at or above the price the
  // sell is priced at -- which is what a fill-and-kill order can actually match against.
  const thin = untradable({
    book: book([[0.74, 2]], [[0.75, 50]]), bestBidPrice: 0.74, bestAskPrice: 0.75, exitPrice: 0.74, shares: 6.6,
  });
  assert.equal(thin.kind, "thin-depth");
  assert.equal(thin.depthShares, 2);
  assert.equal(thin.neededShares, 6.6);

  // A bidless book is exitTrigger's business, not this rule's: answering it here too would
  // have two rules disagreeing about one book, which this file has been fixed for before.
  assert.equal(untradable({
    book: book([], [[0.75, 50]]), bestBidPrice: null, bestAskPrice: 0.75, shares: 6.6,
  }), null);

  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  // Decided on the SAME read as the price and the depth, or the three describe different
  // moments -- the trap the gap band was already fixed for once.
  assert.match(source, /exitAsk = bestAsk\(fresh\);/);
  assert.match(source, /exitBook = fresh;/);
  // Only for a stop. A settlement close takes the bid on purpose on a book quoting near
  // certainty, where one-sided is the normal shape and refusing it would strand the capital
  // that rule exists to free.
  assert.match(source, /if \(reason === "stop"\) \{\s*\n\s*const untradable = stopBookIsUntradable\(\{/);
  // Recorded under its own event name: collapsing it into STOP_DECLINED_GAPPED would make the
  // tally say "the book gapped" about a market where nothing had happened at all.
  assert.match(source, /type: declineKind === "gapped" \? "STOP_DECLINED_GAPPED" : "STOP_DECLINED_UNTRADABLE",/);
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
  assert.equal(worker.stopGapFloorPrice(null, 0.1), null);
  assert.equal(worker.stopGapFloorPrice(0, 0.1), null);

  // And snapped DOWN to the price grid a bid can actually sit on. 10% under the 0.49
  // probability floor is 0.441, and on a one-cent tick the best price at or below that line
  // is 0.44 -- so an un-snapped line refuses the only price inside its own band. Measured:
  // four live positions declined at bid 0.44 against a 0.441 floor, missing by a tenth of a
  // cent, from a rule that exists to prevent twenty-point liquidations.
  assert.equal(worker.stopGapFloorPrice(0.49, 0.1), 0.44);
  assert.equal(worker.stopGapFloorPrice(0.2575, 0.1), 0.23);

  // The band in force is 50%, widened from 10% on the owner's instruction after a stop
  // declined at 14% under and the position then lost its whole stake. One global value, so
  // the default IS the setting and it is asserted rather than left implied.
  assert.equal(worker.stopGapFloorPrice(0.524963), 0.26, "half of the stop, snapped down");
  assert.equal(worker.stopGapFloorPrice(0.30), 0.15);

  // The trade that prompted it now sells. That is the whole point of the change.
  assert.equal(worker.stopGapIsTooWide({ bestBidPrice: 0.45, stopPrice: 0.524963 }), false,
    "0.45 against a 0.525 stop is a real price on a book that moved, and it sells");

  // And every case the band was BUILT for is still refused, which is the test that matters.
  // These are the measured liquidations: bought near 76-80c, floors around 25-37c, sold at
  // 1.5c and 5.7c -- bids at roughly a tenth of the stop.
  for (const [stop, bid] of [[0.2575, 0.015], [0.37, 0.057], [0.25, 0.02], [0.30, 0.03]]) {
    assert.equal(worker.stopGapIsTooWide({ bestBidPrice: bid, stopPrice: stop }), true,
      `a ${bid} bid against a ${stop} stop is a liquidation, not a price`);
  }
  // Never up: snapping toward the stop would tighten the band the owner asked to widen.
  for (const stop of [0.13, 0.2575, 0.33, 0.49, 0.876]) {
    const limit = worker.stopGapFloorPrice(stop, 0.1);
    assert.ok(limit <= stop * 0.9 + 1e-9, `${stop} snapped up to ${limit}`);
    assert.ok(limit > stop * 0.9 - 0.01, `${stop} gave away more than a cent: ${limit}`);
  }

  // The reported case: a 0.2575 stop against a 1.5c book.
  assert.equal(worker.stopGapIsTooWide({ bestBidPrice: 0.015, stopPrice: 0.2575, tolerance: 0.1 }), true);
  // Just inside the tolerance still sells -- the point is to cap the loss near the level,
  // not to refuse every stop that slips a little.
  assert.equal(worker.stopGapIsTooWide({ bestBidPrice: 0.24, stopPrice: 0.2575, tolerance: 0.1 }), false);
  assert.equal(worker.stopGapIsTooWide({ bestBidPrice: 0.2575, stopPrice: 0.2575, tolerance: 0.1 }), false);
  // The four positions that were sitting un-sold: bid at the tick immediately under the raw
  // 10% line now sells, and a bid a further tick down still declines.
  assert.equal(worker.stopGapIsTooWide({ bestBidPrice: 0.44, stopPrice: 0.49, tolerance: 0.1 }), false);
  assert.equal(worker.stopGapIsTooWide({ bestBidPrice: 0.43, stopPrice: 0.49, tolerance: 0.1 }), true);

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
  assert.match(source, /if \(reason === "stop" && stopGapIsTooWide\(\{ bestBidPrice: exitBid, stopPrice: activeFloor \}\)\)/,
    "and the tolerance is measured against the level that fired, not against the other one");
  // Nothing is sent and nothing is recorded as an attempt, so the next pass asks again: a
  // book that gapped on one tick often comes back, and a terminal mark would abandon it.
  assert.match(source, /const due = recordDeclinedStop\(context\.state, plan, \{/);
  assert.doesNotMatch(source, /terminal: true[\s\S]{0,200}STOP_DECLINED_GAPPED/);
  // Collapsed to a standing row. At one pass a second an event each would bury the whole
  // history in minutes, which is the trap the book errors already fell into once.
  assert.match(source, /if \(previous\) return due;\s*\n\s*recordEvent\(state, \{/);
  assert.match(source, /type: declineKind === "gapped" \? "STOP_DECLINED_GAPPED" :/);
  // And cleared once it does sell, or the row would outlive what it describes.
  assert.match(source, /clearDeclinedStop\(context\.state, plan\.tokenId\);/);

  // The same collapsing on the way OUT to the dashboard. The row is what an open position
  // reads to explain why its stop fired and did not sell, so it has to be published -- but
  // one HTTP request per pass is 1599 of them for a single position, which is the sample
  // this rule was measured on.
  assert.match(source, /const DECLINED_STOP_PUBLISH_MS = 15 \* 60 \* 1000;/);
  assert.match(source, /if \(due\) await recordDeclinedStopOnDashboard\(context\.state, plan, exitBid\);/);
  assert.match(source, /reason: "stop-declined",/);
  // Best effort, exactly as a completed exit is: the stop's decision stands whether or not
  // the annotation is delivered, and a failed post must not become a crashed pass.
  const publisher = source.slice(source.indexOf("async function recordDeclinedStopOnDashboard"));
  assert.match(publisher.slice(0, 2400), /\} catch \{/);
});

// Asked for: sell when the probability falls to a set level OR when the loss reaches its
// cap, whichever comes first -- on every portfolio, configurable per portfolio.
//
// The reason it was asked for: two stops on one portfolio fired one too early and one too
// late from the same setting, with nothing misconfigured. The equal-risk floor moves with
// the entry, so a 95c entry gets 8.7 points of room and a 72c entry 46.3.
test("two stop floors, and the price meets the higher one first", async () => {
  const worker = await import("../tools/rpi-live-exit-worker.mjs");

  // Both are floors and the price arrives from above, so "whichever comes first" is max.
  assert.equal(worker.effectiveStopFloor({ stopPrice: 0.8625, probabilityFloor: 0.49 }), 0.8625,
    "a high entry's equal-risk floor is already above the probability floor");
  assert.equal(worker.effectiveStopFloor({ stopPrice: 0.2575, probabilityFloor: 0.49 }), 0.49,
    "a cheap entry stops at the probability floor instead of riding almost to zero");

  // Either may be absent, and the answer is then the other.
  assert.equal(worker.effectiveStopFloor({ stopPrice: 0.30, probabilityFloor: null }), 0.30);
  assert.equal(worker.effectiveStopFloor({ stopPrice: null, probabilityFloor: 0.49 }), 0.49);
  assert.equal(worker.effectiveStopFloor({ stopPrice: 0, probabilityFloor: 0 }), null);
  assert.equal(worker.effectiveStopFloor({}), null);

  // Driven end to end: the same position, with and without the floor.
  const book = { bestBidPrice: 0.45, bestAskPrice: 0.47, stopPrice: 0.2575, triggerPrice: 0.2595 };
  assert.equal(worker.exitReason(book), null,
    "on the equal-risk floor alone a 45c bid is nowhere near selling");
  assert.equal(worker.exitReason({ ...book, probabilityFloor: 0.49 }), "stop",
    "with the floor it sells, which is the whole point");

  // The settlement close still outranks nothing and is unaffected -- given a size, which it
  // needs now that what a close forfeits is measured in USDC rather than in ticks.
  assert.equal(worker.exitReason({ bestBidPrice: 0.999, stopPrice: null, probabilityFloor: 0.49, settlementCloseBid: 0.99, shares: 7 }),
    "settlement");

  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  // A portfolio may set only this floor, and that is still a stop: requiring one of the
  // other two to watch it would leave it unwatched, which is the fault the settlement close
  // had before it joined that line.
  assert.match(source, /if \(stopPrice == null && closeBid == null && flatFloor == null\) return null;/);
  // The pre-trigger buffer belongs to the level in force. Carrying the stored trigger over
  // would test the equal-risk floor's buffer against the probability floor.
  assert.match(source, /const trigger = floor === number\(stopPrice\) && triggerPrice != null/);
});

// Reported by the state file, not by anyone: an order the exchange had QUEUED was written
// down as EXIT_REJECTED. Measured on the account -- three orders for the same position at
// 04:59:26, 05:00:12 and 05:00:53, then "the account no longer holds this position" at
// 05:01:13. The first had filled all along.
//
// Two faults from one missing name. The retry timer started on an order that was still
// alive, and when a queued order later filled, nothing annotated the closed trade, because
// only the `matched` branch does that.
test("an order the exchange queued is submitted, not rejected", async () => {
  const worker = await import("../tools/rpi-live-exit-worker.mjs");

  // The response that started this. `delayed` with an order id: taken, undecided.
  const delayed = { success: true, status: "delayed", error: null, orderID: "0x906e" };
  assert.equal(worker.exitPendingMatch(delayed), true);
  assert.equal(worker.exitPendingMatch({ success: true, status: "live", orderID: "0x1" }), true);

  // Decided, in either direction, is not pending.
  assert.equal(worker.exitPendingMatch({ success: true, status: "matched", orderID: "0x1" }), false,
    "a fill is a fill, and exitFilled owns it");
  assert.equal(worker.exitPendingMatch({ success: true, status: "unmatched", orderID: "0x1" }), false,
    "a kill order that executed nothing has nothing left to wait for");

  // A refusal carries an error and no order id, so there is nothing to wait for.
  assert.equal(worker.exitPendingMatch({ success: false, error: "invalid maker amount" }), false);
  assert.equal(worker.exitPendingMatch({ status: "delayed" }), false,
    "without an order id there is no order on the exchange to wait for");
  assert.equal(worker.exitPendingMatch(null), false);

  // The window. Open while the order may still match, closed once it has run out -- and
  // absent entirely on a record that never queued anything.
  const at = Date.parse("2026-09-07T05:00:00.000Z");
  const record = { pending: { since: "2026-09-07T05:00:00.000Z" } };
  assert.equal(worker.pendingExitIsOpen(record, at + 30000, 60000), true);
  assert.equal(worker.pendingExitIsOpen(record, at + 60001, 60000), false);
  assert.equal(worker.pendingExitIsOpen({ pending: null }, at), false);
  assert.equal(worker.pendingExitIsOpen({}, at), false);
  assert.equal(worker.pendingExitIsOpen({ pending: { since: "not a date" } }, at), false);
});

// What the exchange says became of it. `size_matched` decides, because a status string
// alone cannot tell "still queued" from "matched and no longer open".
test("a queued order is resolved against the exchange, not guessed", async () => {
  const worker = await import("../tools/rpi-live-exit-worker.mjs");

  assert.equal(worker.pendingOrderOutcome({ status: "matched" }).kind, "filled");
  assert.equal(worker.pendingOrderOutcome({ status: "delayed", original_size: "6.84", size_matched: "6.84" }).kind,
    "filled", "the whole size matched, whatever the status still says");
  assert.equal(worker.pendingOrderOutcome({ status: "delayed", original_size: "6.84", size_matched: "2.00" }).kind,
    "open", "a part-matched order is still running");
  assert.equal(worker.pendingOrderOutcome({ status: "cancelled" }).kind, "cancelled");
  assert.equal(worker.pendingOrderOutcome({ status: "unmatched" }).kind, "cancelled");
  assert.equal(worker.pendingOrderOutcome({ status: "delayed" }).kind, "open");
  assert.equal(worker.pendingOrderOutcome({ status: "live" }).kind, "open");
  // Not knowing is its own answer, and must never be read as either of the other two: a
  // filled order is not an OPEN order, so a 404 covers a fill and a cancel alike.
  assert.equal(worker.pendingOrderOutcome(null).kind, "unknown");
  assert.equal(worker.pendingOrderOutcome({ status: "something new" }).kind, "unknown");
  assert.equal(worker.pendingOrderOutcome(null).filled, false);

  // The requested size stands in when the exchange does not echo the original.
  assert.equal(worker.pendingOrderOutcome({ status: "delayed", size_matched: "6.84" }, { requestedShares: 6.84 }).kind,
    "filled");

  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  // The retry gate consults the queue BEFORE the retry interval, or the interval fires
  // another order for a position that already has one on the exchange.
  const gate = source.slice(source.indexOf("const candidates = plans.filter"));
  const queueAt = gate.indexOf("pendingExitIsOpen(pending");
  const intervalAt = gate.indexOf("RETRY_INTERVAL_MS) return false");
  assert.ok(queueAt > 0 && intervalAt > queueAt,
    "the queued-order check has to come before the retry interval");

  // A queued FOK must not have a FAK sent on top of it: that is a second live order for the
  // same shares, which is the duplicate being fixed.
  assert.match(source, /if \(!exitFilled\(response\) && !exitPendingMatch\(response\) && ALLOW_PARTIAL\)/);

  // A queued order that fills runs the SAME post-fill work as one that came back matched --
  // the dashboard annotation and the owed reverse. Both call sites, one function.
  assert.equal(source.split("await afterExitFilled(").length - 1, 2,
    "the fill path is shared by the matched response and the resolved queue");
  const resolver = functionBody(source, "resolvePendingExits");
  assert.match(resolver, /await afterExitFilled\(/,
    "a queue that filled has to go through the shared post-fill path");
  assert.match(functionBody(source, "afterExitFilled"), /await recordLiveExit\(/,
    "and that path is what annotates the closed trade with the stop that sold it");
  // Released when the window runs out rather than held forever: an order nobody can account
  // for must not become a stop that never tries again.
  assert.match(resolver, /EXIT_QUEUE_TIMED_OUT/);
  // And re-armed at once when the exchange says it ended without matching, because the
  // position is still exposed and the retry timer would be the wrong wait.
  assert.match(resolver, /record\.lastAttemptAt = null;/);
});

// Found while reading the retry gate: exit records are keyed by token, are terminal by
// design, and nothing ever removed them. "The account no longer holds this position" is a
// correct terminal answer for as long as the position exists, and permanently wrong once it
// does not -- a market re-entered later inherits the row from its previous life and is
// filtered out of every pass, so its stop is never tried at all.
test("an exit record ends when the position it describes does", async () => {
  const worker = await import("../tools/rpi-live-exit-worker.mjs");

  const state = {
    exits: {
      held: { terminal: true, error: "invalid maker amount" },
      sold: { terminal: true, error: "the account no longer holds this position" },
      queued: { terminal: false, pending: { orderId: "0x906e", since: "2026-09-07T05:00:00.000Z" } },
      alsoHeld: { terminal: false, lastAttemptAt: "2026-09-07T05:00:00.000Z" },
    },
  };
  const dropped = worker.pruneSettledExits(state, new Set(["held", "alsoHeld"]));

  assert.deepEqual(dropped, ["sold"]);
  assert.deepEqual(Object.keys(state.exits).sort(), ["alsoHeld", "held", "queued"]);
  assert.equal(state.exits.queued.pending.orderId, "0x906e",
    "a queued order outlives its position on purpose -- that is how a filled queue is found");

  // Strings and numbers key the same row: the plan list carries String(tokenId).
  const numeric = { exits: { 123: { terminal: true } } };
  assert.deepEqual(worker.pruneSettledExits(numeric, ["123"]), []);
  assert.deepEqual(worker.pruneSettledExits({ exits: {} }, []), []);
  assert.deepEqual(worker.pruneSettledExits({}, []), []);

  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  // Pruned from the positions actually held, and only after the queued orders have been
  // resolved -- the fill is the moment the position disappears.
  const pass = functionBody(source, "checkOnce");
  const resolveAt = pass.indexOf("resolvePendingExits(context, heldTokens)");
  const pruneAt = pass.indexOf("pruneSettledExits(context.state, heldTokens)");
  assert.ok(resolveAt > 0 && pruneAt > resolveAt,
    "queued orders are resolved before their records could be pruned");
  // Both ask what the ACCOUNT holds, not what is watched: a position may be held and
  // deliberately excluded from the watch list, and dropping its record would be wrong.
  assert.match(pass, /const heldTokens = new Set\(livePositions\(context\.liveState\)/);
});

// The measurement that reframed "invalid maker amount". It was called dust and made
// terminal, which was right about what it IS and wrong about where it comes from.
//
// Read off the retained history, eight pairs, no exception: a `delayed` order for 6.5733
// shares is signed as 6.57, and about twenty seconds later -- the retry interval -- this
// worker sent an order for exactly 0.0033 and was told "invalid maker amount". The residue
// is asked minus floor(asked, 2) every single time, which means the queued order FILLED and
// the retry was sizing itself against the remainder the exchange left behind.
//
// So the dust refusals were not an independent fault. They were the visible end of
// recording a queued order as a rejection: 453 of the 500 retained events, and every one of
// those exits sold without ever being recorded as sold.
test("the dust an exit leaves behind is the exchange's two-decimal size grid", async () => {
  const worker = await import("../tools/rpi-live-exit-worker.mjs");

  // asked -> the dust the next attempt was refused for, straight off the production read.
  const measured = [
    [6.5733, 0.0033], [6.1111, 0.0011], [6.6621, 0.0021], [6.2531, 0.0031], [6.1875, 0.0075],
  ];
  for (const [asked, dust] of measured) {
    const signed = worker.sellableSize(asked);
    assert.ok(Math.abs((asked - signed) - dust) < 1e-9,
      `${asked} shares sign as ${signed}, leaving ${asked - signed}, and ${dust} was refused`);
  }

  assert.equal(worker.sellableSize(6.5733), 6.57);
  assert.equal(worker.sellableSize(6.5), 6.5, "an exact size is left alone");
  assert.equal(worker.sellableSize(0.0033), 0, "dust floors to nothing, which is what it is");
  // Never rounded up: asking for a hair more than the position is a balance refusal.
  assert.equal(worker.sellableSize(6.999), 6.99);
  assert.equal(worker.sellableSize(0), 0);
  assert.equal(worker.sellableSize(null), 0);
  assert.equal(worker.sellableSize(-1), 0);

  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  const submit = functionBody(source, "submitProtectedExit");
  // Both sizings go through the grid: the first offer and the retry after a balance refusal.
  // The retry used to floor to four decimals, which is finer than the exchange signs.
  assert.equal(submit.split("sellableSize(").length - 1, 2);
  assert.doesNotMatch(submit, /Math\.floor\(Math\.min\(planned, held\) \* 10000\)/);
  // A size that floors below the minimum is terminal rather than sent and refused.
  assert.match(submit, /which is below the \$\{DUST_SHARES\} it will accept an order for/);
});

// A redeploy must not disarm the live stop loss.
//
// It did. Dispatching the configure workflow to ship a code fix, with no inputs, wrote
// LIVE_EXIT_MODE=shadow -- and the next status read showed 147 SHADOW_STOP_TRIGGERED:
// stops reached, nothing sold, on a live account. The push path had preserved the armed
// mode all along and its comment says exactly why; the dispatch path, which is the one a
// person actually uses, defaulted over it.
test("a redeploy preserves the armed mode instead of defaulting over it", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/trading-rpi-live-exit-worker.yml", import.meta.url),
    "utf8",
  );

  // Arming and disarming have to be asked for by name, so every switch defaults to `keep`.
  for (const input of ["live_exit_mode", "protect_all", "confirm_live"]) {
    const block = workflow.slice(workflow.indexOf(`      ${input}:`));
    assert.match(block.slice(0, 400), /required: false/, `${input} must not be required`);
    assert.match(block.slice(0, 400), /default: keep/, `${input} must default to keep`);
    assert.match(block.slice(0, 400), /options: \[keep,/, `${input} must offer keep`);
  }

  // And `keep` reads the EnvironmentFile rather than a literal.
  assert.match(workflow, /keep\|""\) read_existing "\$1" ;;/);
  for (const key of ["LIVE_EXIT_MODE", "LIVE_EXIT_PROTECT_ALL", "LIVE_EXIT_CONFIRM_LIVE"]) {
    assert.match(workflow, new RegExp(`keep_or_existing ${key} "\\$\\{${key}:-\\}"`),
      `${key} has to fall back to what is already armed`);
  }
  // The old defaults are what caused it, so they must not come back.
  assert.doesNotMatch(workflow, /exit_mode="\$\{LIVE_EXIT_MODE:-shadow\}"/);
  assert.doesNotMatch(workflow, /confirm_live="\$\{LIVE_EXIT_CONFIRM_LIVE:-false\}"/);

  // The deploy says which of the two it left the worker in, so a redeploy that disarms is
  // visible in its own log rather than three steps later in another workflow.
  assert.match(workflow, /-> ARMED: a reached stop may be submitted as a protective SELL\./);
  assert.match(workflow, /-> SHADOW: a reached stop is logged and NOTHING is sold\./);

  // And the status read repeats the verdict at the END, because a long log is read from
  // the end: the tally said 147 SHADOW_STOP_TRIGGERED and the line saying why was 400
  // lines above it.
  const status = readFileSync(
    new URL("../../.github/workflows/trading-rpi-live-exit-worker-status.yml", import.meta.url),
    "utf8",
  );
  const verdictAt = status.indexOf("the running worker reports mode=");
  const tallyAt = status.indexOf("exit attempts recorded:");
  assert.ok(verdictAt > tallyAt && tallyAt > 0, "the armed verdict has to be the last thing printed");
});

// Found while retuning "55+ underway": a closed trade read entry 0.4500, floor 0.4900 --
// the probability floor sat ABOVE the entry. That is not a stop, it is a liquidation the
// instant the stop arms, because the position starts out already past the level that is
// supposed to trigger a sale. The equal-risk floor can never do this -- equalRiskExitPlan's
// own binary search is bounded by the entry and refuses to return one at or above it -- but
// the probability floor is a flat number with no such bound, on "Will CA Nacional Potosi
// win?", outcome No, bought at 45c against a 49% floor set for the portfolio generally.
test("a probability floor at or above the entry does not become the active stop", async () => {
  const worker = await import("../tools/rpi-live-exit-worker.mjs");

  // The measured case: entry 0.45, floor 0.49. The floor must be refused, and the equal-risk
  // level (here null, since none was configured) is all that is left.
  assert.equal(worker.effectiveStopFloor({ stopPrice: null, probabilityFloor: 0.49, entryPrice: 0.45 }), null,
    "a floor above the entry is not a stop, and there is no equal-risk floor to fall back to");
  assert.equal(worker.effectiveStopFloor({ stopPrice: 0.30, probabilityFloor: 0.49, entryPrice: 0.45 }), 0.30,
    "with an equal-risk floor present, the position keeps that protection instead of none");

  // Equal to the entry is refused too -- armed exactly at the entry still liquidates rather
  // than capping a loss.
  assert.equal(worker.effectiveStopFloor({ stopPrice: null, probabilityFloor: 0.45, entryPrice: 0.45 }), null);

  // Below the entry, the floor applies exactly as before -- this is not a new restriction on
  // the ordinary case, only on the inverted one.
  assert.equal(worker.effectiveStopFloor({ stopPrice: null, probabilityFloor: 0.35, entryPrice: 0.45 }), 0.35);
  assert.equal(worker.effectiveStopFloor({ stopPrice: 0.30, probabilityFloor: 0.35, entryPrice: 0.45 }), 0.35,
    "below the entry, the higher of the two floors still wins as before");

  // entryPrice unknown must not newly withhold protection: every existing call this worker
  // makes before a plan is fully resolved has to keep behaving as it did.
  assert.equal(worker.effectiveStopFloor({ stopPrice: null, probabilityFloor: 0.49 }), 0.49,
    "without an entry to compare against, the floor is trusted as before");
  assert.equal(worker.effectiveStopFloor({ stopPrice: null, probabilityFloor: 0.49, entryPrice: null }), 0.49);

  // Driven through exitReason: a floor above the entry must not fire a stop off a bid that
  // is actually above where the position was bought -- that would be selling a position
  // that has not lost anything at all.
  assert.equal(
    worker.exitReason({ bestBidPrice: 0.47, bestAskPrice: 0.49, stopPrice: null, probabilityFloor: 0.49, entryPrice: 0.45 }),
    null,
    "0.47 is above the 0.45 entry -- there is no loss here for a stop to be capping",
  );

  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  assert.match(source, /const flat = flatRaw != null && entry != null && flatRaw >= entry \? null : flatRaw;/);
  // Both call sites in the pass loop have to forward the entry, or the fix never reaches
  // a live decision.
  const pass = functionBody(source, "checkOnce");
  assert.match(pass, /exitReason\(\{[\s\S]{0,220}?entryPrice: plan\.entryPrice,/);
  assert.match(pass, /effectiveStopFloor\(\{ stopPrice: plan\.stopPrice, probabilityFloor: plan\.probabilityFloor, entryPrice: plan\.entryPrice \}\);/);
});

// Asked for: buy a favourite that has collapsed inside a fixture already under way, and do
// it WITHOUT waiting one to two minutes for a runner -- "just try to insert the position,
// with every other parameter already prepared, diversification settled, and only when
// capital is available".
//
// That is why this lives in the loop that is already round every second with the signing
// key rather than in the hourly executor. Everything slow is decided by api.php's
// dip-entry-watch; the fast path answers only the two questions that cannot be answered
// early, and then places the order.
test("dip entry: the fast path decides only what cannot be prepared in advance", () => {
  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");

  // Armed deliberately or not at all. A deployed file must not start buying.
  assert.match(source, /const DIP_ENTRY_MODE = String\(process\.env\.LIVE_DIP_ENTRY_MODE \|\| "off"\)/);
  assert.match(source, /if \(DIP_ENTRY_MODE !== "live" \|\| MODE !== "live" \|\| !CONFIRM_LIVE\) \{/,
    "live buying needs the worker's own live mode and its confirmation as well as this one");
  // Shadow records the whole decision instead, which is how the rule gets measured first.
  assert.match(source, /type: "DIP_ENTRY_SHADOW"/);

  // Exits come first in a pass: an exit protects capital already committed, an entry
  // commits more of it.
  const exitAt = source.indexOf("for (const { plan, book, error: bookError } of observed)");
  const dipAt = source.indexOf("await fireDipEntries(context, dipBooks, now)");
  assert.ok(exitAt > 0 && dipAt > exitAt, "the dip entry must not be able to delay a stop loss");
  // And it cannot break the loop that protects real positions.
  assert.match(source, /type: "DIP_ENTRY_ERROR"/);

  // The trigger reads the ASK, because that is what an entry pays. The bid would report a
  // collapse the buyer cannot be filled at.
  const trigger = new Function("bestAsk", `
    ${functionBody(source, "dipEntryTrigger")}
    return dipEntryTrigger;
  `)((book) => book.ask ?? null);
  const plan = { buyMin: 0.3, buyMax: 0.4 };
  assert.equal(trigger(plan, { ask: 0.35 }).fire, true);
  assert.equal(trigger(plan, { ask: 0.45 }).fire, false, "above the band is not a collapse yet");
  assert.equal(trigger(plan, { ask: 0.22 }).fire, false, "below the band is a different bet");
  assert.equal(trigger(plan, { ask: null }).fire, false, "an empty book is not an opportunity");

  // The watch set is held by the worker, not served fresh each pass, because a dipped
  // favourite LEAVES the catalogue: at 70-80% it is a row, at 35% it is not.
  const merge = new Function("DIP_ENTRY_TTL_MS", "dipEntryPlanKey", `
    ${functionBody(source, "mergeDipEntryWatch")}
    return mergeDipEntryWatch;
  `)(3600000, (row) => `${row.portfolioId}:${row.tokenId}`);
  const first = merge(null, { plans: [{ portfolioId: "live", tokenId: "aaa", buyMax: 0.4 }] }, 1000);
  assert.equal(first.size, 1);
  // The market has dipped out of the catalogue, so the endpoint no longer lists it. The
  // entry has to survive exactly that, or it disappears at the moment it is needed.
  const kept = merge(first, { plans: [] }, 2000);
  assert.equal(kept.size, 1, "an entry that left the catalogue must not be dropped");
  assert.equal(merge(kept, { plans: [] }, 1000 + 3600001).size, 0, "but it does expire");
});

test("dip entry: it fires once, needs cash, and honours what was prepared", async () => {
  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  const submitted = [];
  const build = (overrides = {}) => new Function(
    "bestAsk", "exitFilled", "recordEvent", "submitDipEntry", "dipEntryTrigger", "dipEntryPlanKey",
    "DIP_ENTRY_MODE", "MODE", "CONFIRM_LIVE",
    `${functionBody(source, "fireDipEntries")}\nreturn fireDipEntries;`,
  )(
    (book) => book.ask ?? null,
    (response) => response?.success === true,
    (state, event) => { state.history = [event, ...(state.history || [])]; },
    async (plan, book, cash) => {
      submitted.push({ tokenId: plan.tokenId, cash });
      return { success: overrides.accept !== false, price: 0.35, shares: 14 };
    },
    (plan, book) => {
      const ask = book.ask ?? null;
      return ask != null && ask <= plan.buyMax && ask >= plan.buyMin ? { fire: true, ask } : { fire: false };
    },
    (row) => `${row.portfolioId}:${row.tokenId}`,
    overrides.dipMode || "live",
    overrides.mode || "live",
    overrides.confirm !== false,
  );

  const plan = {
    portfolioId: "live-custom-dip", tokenId: "aaa", question: "INOX vs Black Phoenix",
    openProbability: 0.78, buyMin: 0.3, buyMax: 0.4, stakeUsdc: 5, blockedReason: "",
  };
  const books = new Map([["aaa", { ask: 0.35 }]]);
  const context = () => ({
    state: { dipEntries: {} },
    dipWatch: new Map([["live-custom-dip:aaa", plan]]),
    dipWatchPayload: { cashUsdc: 40 },
  });

  // The reported case: it opened at 78%, it is asked at 35%, so it is bought.
  const live = context();
  await build()(live, books, "2026-09-10T20:27:00Z");
  assert.deepEqual(submitted.map((row) => row.tokenId), ["aaa"]);
  assert.equal(submitted[0].cash, 40, "the cash the plan was prepared with reaches the order");
  assert.equal(live.state.history[0].type, "DIP_ENTRY_SUBMITTED");

  // Once, ever. A price wobbling across the band's edge must not buy repeatedly, and the
  // claim alone stops that only until the first order settles.
  submitted.length = 0;
  await build()(live, books, "2026-09-10T20:28:00Z");
  assert.deepEqual(submitted, [], "a settled token is never bought again");

  // A rejection is terminal too: retrying into a book that already refused the size is how
  // one decision became three orders.
  submitted.length = 0;
  const rejected = context();
  await build({ accept: false })(rejected, books, "2026-09-10T20:27:00Z");
  assert.equal(rejected.state.history[0].type, "DIP_ENTRY_REJECTED");
  await build({ accept: false })(rejected, books, "2026-09-10T20:28:00Z");
  assert.equal(submitted.length, 1, "a rejected entry is not retried on the next pass");

  // Diversification was settled when the plan was prepared, and a blocked plan is recorded
  // rather than silently skipped -- otherwise a watched market that reached the band and
  // was not bought looks like a worker that missed it.
  submitted.length = 0;
  const blocked = context();
  blocked.dipWatch = new Map([["live-custom-dip:aaa", { ...plan, blockedReason: "the wallet already has a position in this market" }]]);
  await build()(blocked, books, "2026-09-10T20:27:00Z");
  assert.deepEqual(submitted, []);
  assert.equal(blocked.state.history[0].type, "DIP_ENTRY_BLOCKED");
  assert.match(blocked.state.history[0].error, /already has a position/);

  // Shadow: the whole decision at the price it would have paid, and nothing sent.
  submitted.length = 0;
  const shadow = context();
  await build({ dipMode: "shadow" })(shadow, books, "2026-09-10T20:27:00Z");
  assert.deepEqual(submitted, []);
  assert.equal(shadow.state.history[0].type, "DIP_ENTRY_SHADOW");
  assert.equal(shadow.state.history[0].ask, 0.35, "and it records the price it would have paid");
});

test("dip entry: the order never pays above the band, and never without cash", () => {
  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");

  // "Only when capital is available", checked against the stake this plan was prepared
  // with rather than against a hopeful balance.
  assert.match(source, /if \(!\(Number\(cashUsdc\) >= stake\)\) \{/);
  // The band's ceiling is also the price ceiling. A worker that was a second late must not
  // buy the recovery it was too slow to catch.
  assert.match(source, /const price = Math\.min\(marketable, Number\(plan\.buyMax\)\);/,
    "the buy band's top is the highest price the order may pay");
  // Marketable through the levels the size consumes, not top-of-book: the same reasoning as
  // the stop-loss reversal, which is specified as a market order too.
  assert.match(source, /marketableBuyPrice\(\{ book, notionalUsdc: stake, maxSlippage: DIP_ENTRY_MAX_SLIPPAGE \}\)/);
  // The claim is what stops this and the hourly executor from both entering the same
  // market, and a failed order releases it rather than leaving it held.
  assert.match(source, /const claim = await claimLiveEntry\(plan\.tokenId, claimId\);/);
  assert.match(source, /await settleLiveEntryClaim\("release", plan\.tokenId, claimId\);\n    return \{ success: false, error: error\?\.message/,
    "a thrown order must release its claim, or the market can never be entered again");
  // FAK then FOK, for the reason the reversal already documents: a smaller position is
  // still the position the rule asked for.
  assert.match(source, /postOrder\(signed, OrderType\.FAK, false\)[\s\S]{0,200}?postOrder\(signed, OrderType\.FOK, false\)/);
});

// The same trap the three exit switches were fixed for: dispatching this workflow to ship a
// code change must not arm or disarm anything as a side effect. A redeploy with no inputs
// once turned an armed stop loss into 147 shadow events.
test("dip entry: arming it is deliberate, and a redeploy never changes it", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/trading-rpi-live-exit-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /dip_entry_mode:[\s\S]*?default: keep/,
    "keep must be the default, or shipping a fix rearms the rule");
  assert.match(workflow, /options: \[keep, "off", shadow, live\]/);
  assert.match(workflow, /dip_entry_mode="\$\(keep_or_existing LIVE_DIP_ENTRY_MODE "\$\{LIVE_DIP_ENTRY_MODE:-\}"\)"/,
    "an absent input has to fall back to what the EnvironmentFile already says");
  assert.match(workflow, /dip_entry_mode="\$\{dip_entry_mode:-off\}"/, "and a first install is off");
  assert.match(workflow, /case "\$dip_entry_mode" in off\|shadow\|live\) ;; \*\) dip_entry_mode=off ;; esac/,
    "an unrecognised value must fall back to off, never to live");
  // The install says out loud what it just armed, because that is how the disarmed stop
  // loss went unnoticed for 147 events.
  assert.match(workflow, /DIP ENTRY ARMED: a collapsed favourite in the buy band may be BOUGHT/);
  assert.match(workflow, /LIVE_DIP_ENTRY_MODE=\$\{dip_entry_mode\}/);
  assert.match(workflow, /LIVE_DIP_ENTRY_WATCH_URL=https:\/\/osobnizkusenosti\.cz\/trading\/api\.php\?action=dip-entry-watch/);
});

// Reported: positions the market prices as decided are not sold automatically and have to be
// closed by hand. Measured on the account before changing anything: the setting IS stored
// (0.999 on every live portfolio), the positions ARE in the policy the worker watches, and
// six of ten open positions trade on a 0.01 tick grid -- where the highest bid that can
// exist is 0.99. The rule was right, the wiring was right, and `bid >= 0.999` was
// unsatisfiable by construction.
test("certainty close: the level in force is the level configured, on every grid", () => {
  // The clamp this test used to describe is gone, and with it every early sale in the log.
  // It lowered the configured level to "the top of whatever grid this market quotes on",
  // which on a cent market is 0.99 -- and 0.99 is not 0.999. A level is a number someone
  // chose, not a suggestion to be rounded toward whatever the book happens to offer.
  //
  // The level now comes back exactly as configured, and a market that cannot quote it does
  // not close at all: the position redeems at 1.00, which is above anything the clamp could
  // ever have taken.
  assert.equal(worker.settlementCloseLevel(0.999), 0.999);
  assert.equal(worker.settlementCloseLevel(0.995), 0.995);
  assert.equal(worker.settlementCloseLevel(0.95), 0.95);
  assert.equal(worker.settlementCloseLevel(0.5), 0.5);
  // Off stays off.
  assert.equal(worker.settlementCloseLevel(0), null);
  assert.equal(worker.settlementCloseLevel(null), null);
  // Handing it a grid anyway must change nothing.
  //
  // This replaces an arity check, which did not work: `function f(a, tick = null)` has a
  // length of 1, because a parameter with a default is not counted -- and that is exactly
  // the shape the clamp had. Restoring the clamp passed the arity check and failed no test
  // in the suite. A signature is not behaviour; only the behaviour catches it.
  for (const tick of [0.01, 0.001, 0.0001, 0, null, "nonsense"]) {
    assert.equal(worker.settlementCloseLevel(0.999, tick), 0.999,
      `a tick of ${tick} must not lower a configured 0.999`);
    assert.equal(worker.settlementCloseLevel(0.95, tick), 0.95);
  }
  assert.equal(worker.reachableSettlementCloseBid, undefined,
    "the clamp must be gone rather than merely unused -- a caller could find it again");

  // The third argument below is a tick, passed on purpose. The decision has to come out the
  // same with it and without it: exitReason no longer accepts one, so a caller that tries
  // to hand the grid over changes nothing.
  const fires = (bid, closeBid, tickSize = undefined, shares = 7) => worker.exitReason({
    bestBidPrice: bid, bestAskPrice: null, stopPrice: null, triggerPrice: null, settlementCloseBid: closeBid,
    tickSize, shares,
  });
  // A 0.01-grid market at the top of its book, with the setting at 0.999 and the tick
  // MEASURED rather than assumed. 0.99 is the best that market will ever show, and it is
  // still not the level: it does not fire, and the position redeems at 1.00 instead.
  // Asked for with three such sales on the table: +$1.85 won and +$1.83 realised, +$1.94
  // and +$1.86, +$1.58 and +$1.57.
  assert.equal(fires(0.99, 0.999, 0.01), null,
    "the top of a cent grid is not the level, and a measured tick does not make it one");
  // One tick below the top is further from certainty still.
  assert.equal(fires(0.98, 0.999, 0.01), null);
  // The reported sale, four times over: with no tick measured, 0.99 must NOT sell against a
  // 0.999 setting. "Games Total: O/U 3.5" went at 99 cents on exactly this.
  assert.equal(fires(0.99, 0.999), null, "an unmeasured tick must never sell a cent early");
  assert.equal(fires(0.999, 0.999), "settlement", "and the configured level still fires");
  // A position still a long way out is untouched -- the account had these at 0.69 to 0.90,
  // and selling one of those as though it were decided would be far worse than not selling.
  assert.equal(fires(0.9, 0.999), null, "90% is not certainty and must never read as it");
  assert.equal(fires(0.71, 0.999), null);
  // A lower setting keeps meaning exactly what it says, and the forfeit rule does not touch
  // it. A portfolio asking to be let out at 0.95 is not handing back part of a won match;
  // it is buying its capital back at a price it named. That decision belongs to whoever
  // configured the portfolio.
  assert.equal(fires(0.95, 0.95), "settlement", "a deliberate haircut is still honoured");
  assert.equal(fires(0.94, 0.95), null, "and below the setting it is not reached at all");
  // Off sells nothing, however high the bid goes.
  assert.equal(fires(0.99, 0), null);

  // The reported loss, as its own case. A 0.001-grid market bid at 0.991 with the setting at
  // 0.999 must NOT sell: 0.991 is not certainty on a book that can quote 0.999.
  assert.equal(fires(0.991, 0.999, 0.001), null,
    "a bid below the setting on a grid that can reach the setting is not certainty");
  assert.equal(fires(0.999, 0.999, 0.001), "settlement", "and at the setting it does sell");
  // The same bid and setting with each of the three grids the exchange quotes, so the point
  // is a measurement rather than a claim: the tick changes nothing. 0.99 against a 0.999
  // setting is refused on a cent grid, on a tenth-of-a-cent grid, and with no grid at all.
  for (const tick of [0.01, 0.001, 0.0001, null, undefined]) {
    assert.equal(fires(0.99, 0.999, tick), null,
      `0.99 is not 0.999, and a tick of ${tick} cannot make it one`);
  }

  // The grid is read from the book, and a price no cent grid could quote proves a finer one.
  const book = (prices) => ({ bids: prices.map((price) => ({ price: String(price), size: "100" })), asks: [] });
  assert.equal(worker.observedBookTick(book([0.99, 0.98, 0.97])), 0.01);
  // 0.29 and 0.57 are cent prices whose division by 0.01 is NOT exact in floating point
  // (28.999999999999996, 56.99999999999999). An exact multiple test reads them as a finer
  // grid than the market has, which would leave a 0.999 setting unreachable again -- the
  // original fault. These are here because the first version of this test used only values
  // that happened to divide cleanly, and passed with the tolerance removed.
  assert.equal(worker.observedBookTick(book([0.57, 0.29, 0.07])), 0.01);
  assert.equal(worker.observedBookTick(book([0.991, 0.99, 0.985])), 0.001);
  assert.equal(worker.observedBookTick(book([0.9991, 0.99])), 0.0001);
  // Never finer than the book has shown, and an unreadable book falls back to the coarsest
  // grid -- the safe direction, where the close still fires.
  assert.equal(worker.observedBookTick({}), 0.01);
  assert.equal(worker.observedBookTick({ bids: [] }), 0.01);

  // The stop still outranks it: both can be true only in a market that moved from a loss
  // back to certainty, and the stop is checked first.
  assert.equal(worker.exitReason({
    bestBidPrice: 0.99, stopPrice: 0.995, triggerPrice: 0.996, settlementCloseBid: 0.999,
  }), "stop");

  // The trigger must not be handed the grid at all. Asserted on the source because the
  // argument would be silently ignored if it were passed -- the call would keep working and
  // the test above would keep passing, while the line said the opposite of the rule.
  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /tickSize: marketTick,/,
    "the exit decision must not be given the market's grid");
  // The level recorded on the event is the configured one, because there is no longer a
  // second, lowered one for it to differ from.
  assert.match(source, /event\.settlementCloseBidInForce = plan\.settlementCloseBid;/);
  // The grid is still measured and still logged -- it prices the order and it explains a
  // fill -- it just no longer decides the sale.
  assert.match(source, /const marketTick = await effectiveMarketTick\(plan\.tokenId, book\);/);
  assert.match(source, /event\.marketTick = marketTick;/);
});

// Reported: a market reached 100%, sat at a 0.999 bid for over five minutes with the
// certainty close set to 99.9, and was never sold.
//
// Measured on the live account before anything was changed: the bid WAS at the setting and
// the tick was 0.001, so the trigger was satisfied -- "WOULD FIRE". What refused it was the
// exit itself, with "the remaining UNKNOWN shares are dust". Unknown, not small: the
// position holds 6.93 shares.
//
// The path is exact. That portfolio runs with the stop loss OFF, so equalRiskExitPlan
// returns { protectable: false, reason: "position stop-loss multiplier is disabled" } and
// NOTHING else -- no share count. watchPlan still watches the position, correctly, because
// the settlement close is its own independent reason; but it spread that refusal into the
// plan, so the close could never size an order. A portfolio with the stop loss off and the
// certainty close on could therefore never close at certainty.
test("settlement close: a position with no stop still carries its share count", () => {
  // Stop loss off, certainty close on: the exact pair of settings on the live portfolio.
  const position = {
    tokenId: "1",
    shares: 6.9295,
    totalCostUsdc: 4.92,
    netGainIfWinUsdc: 2.01,
    stopLossRiskMultiplier: 0,
    feeRate: 0,
    feesEnabled: false,
  };
  const plan = worker.watchPlan(position, {
    portfolioId: "live-custom-underway",
    settlementCloseBid: 0.999,
    stopLossEnabled: false,
    stopLossRiskMultiplier: 0,
    enabled: true,
  });

  assert.ok(plan, "the settlement close is its own reason to watch, with or without a stop");
  assert.equal(plan.protectable, false, "there is no stop here, and the plan should still say so");
  assert.equal(plan.stopPrice, null);
  // The fix: the share count is a fact about the position, not about the stop.
  assert.equal(plan.shares, 6.9295,
    "without this the exit cannot size an order and refuses the position as unknown shares");
  assert.equal(plan.totalCostUsdc, 4.92);
  assert.equal(plan.settlementCloseBid, 0.999);

  // And a position that IS protectable keeps the derived numbers rather than being
  // overwritten by the raw ones.
  const protectedPlan = worker.watchPlan(
    { ...position, stopLossRiskMultiplier: 1 },
    { portfolioId: "live", settlementCloseBid: 0.999, stopLossEnabled: true, enabled: true },
  );
  assert.equal(protectedPlan.shares, 6.9295);
  assert.ok(protectedPlan.stopPrice > 0 && protectedPlan.stopPrice < 1);
});

// The other half: nine positions were already marked terminal by that refusal, and a
// terminal exit record is filtered out of every later pass. Fixing the plan alone would have
// reached none of them.
test("settlement close: terminality earned by the defect is released, the exchange's is not", () => {
  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  const submit = functionBody(source, "submitProtectedExit");

  // An unknown size is no longer terminal at all: it is a plan that failed to carry its
  // size, not a fact about the position.
  assert.match(submit, /terminal: planned != null,/);
  assert.match(submit, /the position's share count was missing from the exit plan/);
  // A genuinely tiny holding stays terminal -- retrying it forever is the fault that rule
  // was written for.
  assert.match(submit, /shares are dust,/);

  // And the records already stored are released, matched on their recorded reason so a
  // refusal that came from the exchange keeps meaning what it said.
  assert.match(source, /EXIT_TERMINAL_CLEARED/);
  assert.match(source, /share count was missing\|shares are dust/);
  assert.match(source, /&& number\(plan\.shares\) != null && number\(plan\.shares\) >= DUST_SHARES/,
    "release it only once the plan can actually size an order, or it retries into the same refusal");
});

test("certainty close: the grid is the finer of what the exchange declares and what the book shows", async () => {
  // Reported, and recorded in the worker's own event history:
  //
  //   "Coritiba FBC vs. CA Paranaense: O/U 1.5"  bestBid 0.99  ask null
  //   settlementCloseBid 0.999  settlementCloseBidInForce 0.99  marketTick 0.01
  //   ...and the order it then placed went out with tickSize 0.001
  //
  // Reading the book alone was not enough. Every visible price was a round cent, so the
  // book read as a 0.01 grid and the setting was clamped to 0.99 -- while the exchange's
  // own declared tick, sitting on the other side of the same event, said 0.001. The
  // position was sold below a certainty it could have reached.
  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");

  const centBook = { bids: [{ price: "0.99", size: "100" }], asks: [] };
  const fineBook = { bids: [{ price: "0.999", size: "100" }], asks: [] };
  assert.equal(worker.observedBookTick(centBook), 0.01,
    "a book quoting only round cents cannot prove a finer grid on its own");

  // Which is exactly why the declared tick has to be consulted too.
  const fires = (bid, tickSize) => worker.exitReason({
    bestBidPrice: bid, stopPrice: null, triggerPrice: null, settlementCloseBid: 0.999, tickSize,
    // Seven shares: at 0.999 that forfeits 0.007 USDC, inside the cent this close may give
    // up. The rule is in USDC now, so a price on its own no longer decides anything.
    shares: 7,
  });
  assert.equal(fires(0.99, 0.001), null, "0.99 is not certainty on a market that can quote 0.999");
  // A market that cannot quote 0.999 reaches its own top at 0.99 -- and seven shares there
  // hand back seven cents of a won match, so the close holds instead. Small enough and it
  // is worth taking again.
  assert.equal(fires(0.99, 0.01), null,
    "a market that cannot quote 0.999 simply does not get closed at certainty any more");
  assert.equal(fires(0.999, 0.001), "settlement");

  // The finer of the two, in BOTH directions, driven for real. Each source has been seen
  // too coarse on its own and each failure loses money the same way: the book missed a fine
  // grid on Coritiba, and the worker's log also holds an exit priced "tick 0.01" against a
  // book quoting 0.999.
  const original = globalThis.fetch;
  try {
    globalThis.fetch = exchangeStub({ tick: { minimum_tick_size: 0.001 } }).fetchStub;
    assert.equal(await worker.effectiveMarketTick("grid-declared-finer", centBook), 0.001,
      "a declared 0.001 must win over a book that happens to be quoting round cents");

    globalThis.fetch = exchangeStub({ tick: { minimum_tick_size: 0.01 } }).fetchStub;
    assert.equal(await worker.effectiveMarketTick("grid-book-finer", fineBook), 0.001,
      "and a book quoting 0.999 must win over a declared cent grid");

    // Unknown stays UNKNOWN. This is the third sale's path: the declared lookup missed, the
    // book was quoting round cents precisely BECAUSE the market was already at certainty,
    // and 0.999 was lowered to 0.99 on that guess. The book alone can never lower it again.
    globalThis.fetch = exchangeStub({ tick: { status: 404 } }).fetchStub;
    assert.equal(await worker.effectiveMarketTick("grid-unknown", centBook), null,
      "a declared tick that could not be read must not be answered with the book's");
  } finally {
    globalThis.fetch = original;
  }

  // A failed lookup must not be remembered as a coarse tick: that is this bug, cached, and
  // it would keep selling early for as long as the worker stayed up.
  const lookup = /async function declaredMarketTick[\s\S]*?\n\}/.exec(source)[0];
  assert.match(lookup, /tick = null;/);
  assert.ok(!/tick = COARSEST_MARKET_TICK/.test(lookup) && !/tick = 0\.01/.test(lookup),
    "a lookup that failed must answer unknown, not a coarse tick");
  // The caching, the backoff and the fallbacks are all driven for real against a stubbed
  // exchange further down this file -- see "a failed lookup is retried, not remembered" and
  // the tests beside it. Matching the source for them here is what gave three separate
  // versions of this a clean run while they sold positions early, so the duplication is
  // deliberately not repeated.
  //
  // The source IS read for one thing: which endpoint is asked. Gamma answered 0.01 about
  // the market that sold at 0.99 and answers 0.001 about the same market now, so a quiet
  // return to it would restore the fault while every stub in this file kept passing.
  assert.match(lookup, /clobMinimumTickSize\(key\)/);
  assert.ok(!/orderPriceMinTickSize/.test(lookup),
    "the grid must not come from Gamma: it was measured wrong in the direction that sells early");
  assert.match(source, /\$\{CLOB_HOST\}\/tick-size\?token_id=/, "and it must be the exchange's own endpoint");

  // And the trigger must use it rather than the book alone.
  assert.match(source, /const marketTick = await effectiveMarketTick\(plan\.tokenId, book\);/);
  // Every level the worker quotes -- the one it sells at and the one it writes into the
  // log -- is the same level. A reachableSettlementCloseBid() called without the grid
  // reports the stored setting, so the shadow log claimed a close at 0.999 while the live
  // path sold at 0.99, and the two disagreed in the record for three of these sales.
  assert.ok(!/reachableSettlementCloseBid\(plan\.settlementCloseBid\)/.test(source),
    "the level must never be computed without the market's grid");
  assert.ok(!/const marketTick = observedBookTick\(book\);/.test(source),
    "the trigger must not go back to reading only the book");
});

// ---------------------------------------------------------------------------
// The certainty close, exercised rather than described.
//
// This bug shipped four times. Each fix was pinned by assertions that read the SOURCE and
// confirmed it looked right -- and it did look right. What none of them exercised was the
// code actually running: a tick lookup that fails, a cache that remembers the failure, a
// book quoting round numbers, and a tick source that answers 0.01 about a market quoting
// 0.999. Those are where every one of the four faults lived.
//
// So these drive the real functions with a stubbed fetch and assert on what they decide.
// ---------------------------------------------------------------------------

// The exchange, stubbed in its two halves.
//
// `tick` answers CLOB /tick-size -- the grid the exchange enforces and the only one that
// decides anything here. `gamma` answers the Gamma market list, which is asked about neg
// risk and nothing else any more. They are separate on purpose: a measured disagreement
// between them is what sold "Games Total: O/U 3.5" at 0.99, and a stub that cannot express
// the disagreement cannot test the fix.
function exchangeStub({ tick, gamma = [] } = {}) {
  const calls = [];
  const reply = (source, href) => (typeof source === "function" ? source(href, calls.length) : source);
  const fetchStub = async (url) => {
    const href = String(url);
    calls.push(href);
    const answer = href.includes("/tick-size") ? reply(tick, href) : reply(gamma, href);
    if (answer instanceof Error) throw answer;
    if (answer?.status && answer.status >= 400) {
      return { ok: false, status: answer.status, json: async () => ({}) };
    }
    // `in` rather than `??`, so a stub can answer with a null or empty body on purpose.
    const payload = answer && typeof answer === "object" && "body" in answer ? answer.body : answer;
    return { ok: true, status: 200, json: async () => payload };
  };
  return { fetchStub, calls };
}

const roundCentBook = { bids: [{ price: "0.99", size: "100" }], asks: [] };
let tokenSeed = 0;
const freshToken = () => `test-token-${(tokenSeed += 1)}`;

test("certainty close: a market quoting round cents is NOT sold at 0.99 when its tick is finer", async () => {
  // The reported sale, replayed against what each source actually said that morning.
  //
  // The book showed only 0.99, so the book alone concludes a cent grid. Gamma answered
  // 0.01 -- measured, from the worker's own event: declaredTick 0.01. And the CLOB answers
  // minimum_tick_size 0.001, which is the number the exchange judges orders by and which
  // the same market's book is quoting 0.999 against.
  //
  // So this is the whole fault in one stub: every source that used to be consulted said
  // 0.01, and the position must still be held for 0.999.
  const original = globalThis.fetch;
  const { fetchStub, calls } = exchangeStub({
    tick: { minimum_tick_size: 0.001 },
    gamma: [{ orderPriceMinTickSize: 0.01 }],
  });
  globalThis.fetch = fetchStub;
  try {
    const token = freshToken();
    const tick = await worker.effectiveMarketTick(token, roundCentBook);
    assert.equal(tick, 0.001, "the exchange's own grid must win over Gamma and over a round-cent book");
    assert.equal(worker.exitReason({
      bestBidPrice: 0.99, stopPrice: null, triggerPrice: null, settlementCloseBid: 0.999, tickSize: tick, shares: 7,
    }), null, "0.99 is not certainty on a market that can quote 0.999");
    // And it does sell once the bid actually reaches the setting.
    assert.equal(worker.exitReason({
      bestBidPrice: 0.999, stopPrice: null, triggerPrice: null, settlementCloseBid: 0.999, tickSize: tick, shares: 7,
    }), "settlement");
    assert.ok(calls.length >= 1 && calls[0].includes("tick-size") && calls[0].includes(token),
      `the grid is asked of the exchange, by token: ${JSON.stringify(calls)}`);

    // And the ORDER is priced on that same grid. These were two separate lookups, and the
    // log holds the position that paid for it: ShindeN vs Fluxo W7M triggered at tick
    // 0.001 and its sell went out at tick 0.01, priced 0.99. Waiting for 0.999 buys
    // nothing if the order rounds back down on the way out.
    const constraints = await worker.exchangeConstraintsForToken(token);
    assert.equal(constraints.tickSize, tick, "the order must be priced on the grid the trigger decided on");
    assert.equal(worker.protectedExitPrice({ stopPrice: null, bestBidPrice: 0.999, tickSize: constraints.tickSize }), 0.999,
      "and the sell must actually go out at 0.999, not be rounded down to 0.99");
  } finally {
    globalThis.fetch = original;
  }
});

test("certainty close: a genuine cent market still sells at 0.99 rather than never selling", async () => {
  // The fault the clamp was introduced for, which must not come back while fixing the other.
  const original = globalThis.fetch;
  const { fetchStub } = exchangeStub({ tick: { minimum_tick_size: 0.01 } });
  globalThis.fetch = fetchStub;
  try {
    const tick = await worker.effectiveMarketTick(freshToken(), roundCentBook);
    assert.equal(tick, 0.01);
    assert.equal(worker.exitReason({
      bestBidPrice: 0.99, stopPrice: null, triggerPrice: null, settlementCloseBid: 0.999, tickSize: tick, shares: 7,
    }), null, "a cent market simply holds to redemption now: 0.99 hands back 1% of a won match");
  } finally {
    globalThis.fetch = original;
  }
});

test("certainty close: a failed lookup is retried, not remembered", async () => {
  // Every watched token is looked up in the same pass at startup, so one burst the exchange
  // refuses fails all of them -- and remembering that pinned the whole account to book-only
  // inference until restart.
  const original = globalThis.fetch;
  let failing = true;
  const { fetchStub, calls } = exchangeStub({
    tick: () => (failing ? new Error("CLOB tick size for token: HTTP 429") : { minimum_tick_size: 0.001 }),
  });
  globalThis.fetch = fetchStub;
  try {
    const token = freshToken();
    // While the lookup refuses, the grid is unknown -- and unknown is NOT the book's cents. The
    // book reads 0.01 here only because the market is already at certainty, so falling back
    // to it lowered 0.999 to 0.99 at exactly the moment that costs a cent a share.
    assert.equal(await worker.effectiveMarketTick(token, roundCentBook), null);
    const afterFirst = calls.length;

    // Inside the backoff it must not ask again: this runs every second, per position.
    assert.equal(await worker.effectiveMarketTick(token, roundCentBook), null);
    assert.equal(calls.length, afterFirst, "a failed lookup must not be re-asked every pass");

    // And with the grid unknown the close does not fire at 0.99 at all: the position rides
    // to settlement at 1.00, which is worth more than the sale this used to make. Waiting
    // is slower; selling early is gone for good.
    assert.equal(worker.exitReason({
      bestBidPrice: 0.99, stopPrice: null, triggerPrice: null, settlementCloseBid: 0.999, tickSize: null,
    }), null, "an unknown grid must never lower the certainty level");

    // Once the backoff is over and the exchange answers, the real tick takes over -- WITHOUT
    // a restart, which is the whole point.
    failing = false;
    worker.__resetMarketTickBackoffForTests(token);
    assert.equal(await worker.effectiveMarketTick(token, roundCentBook), 0.001,
      "the level must recover on its own once the exchange answers");
    assert.ok(calls.length > afterFirst, "and it must actually ask again");

    // A real answer is then kept, so the loop stops asking.
    const afterSuccess = calls.length;
    assert.equal(await worker.effectiveMarketTick(token, roundCentBook), 0.001);
    assert.equal(calls.length, afterSuccess, "a known tick is not re-asked");
  } finally {
    globalThis.fetch = original;
  }
});

test("certainty close: a market Gamma has dropped still has its grid", async () => {
  // This used to be "a market missing from the open half is still found", and it asked the
  // Gamma list twice -- closed=false, then closed=true -- so a market that resolved between
  // passes would not lose its tick. The probe measured what actually happens to a resolved
  // market: Gamma returns NOTHING for it, in either half, while CLOB /tick-size still
  // answers 0.001. So the same intent is kept and the second Gamma request is not.
  //
  // It matters here more than anywhere: a certainty close fires on a market the book has
  // already decided, which is precisely when Gamma is about to drop it.
  const original = globalThis.fetch;
  const { fetchStub, calls } = exchangeStub({ tick: { minimum_tick_size: 0.001 }, gamma: [] });
  globalThis.fetch = fetchStub;
  try {
    assert.equal(await worker.effectiveMarketTick(freshToken(), roundCentBook), 0.001,
      "a market that has resolved between passes must not lose its tick");
    assert.ok(!calls.some((href) => href.includes("closed=true")),
      "and it must not be hunted for in a Gamma half that no longer holds it");
  } finally {
    globalThis.fetch = original;
  }
});

test("certainty close: a tick the exchange does not declare is UNKNOWN, not a cent", async () => {
  // This test used to assert the opposite, and the opposite is the bug. With no declared
  // tick it fell back to the book -- and the book, on a market approaching certainty, is
  // quoting round cents, so the fallback reported 0.01 at exactly the moment the position
  // was about to be sold. A 0.999 setting was lowered to 0.99 and the position went a cent
  // early: Coritiba, Fortaleza, and "Games Total: O/U 3.5" at 99 cents.
  //
  // Unknown is now unknown. Nothing is lowered, the close does not fire, and the position
  // settles at 1.00 -- which is more than the 0.99 the fallback was taking.
  const original = globalThis.fetch;
  const { fetchStub } = exchangeStub({ tick: { minimum_tick_size: null } });
  globalThis.fetch = fetchStub;
  try {
    const fineBook = { bids: [{ price: "0.991", size: "10" }], asks: [] };
    assert.equal(await worker.effectiveMarketTick(freshToken(), fineBook), null,
      "a book cannot stand in for a tick the exchange did not declare");
    assert.equal(await worker.effectiveMarketTick(freshToken(), roundCentBook), null,
      "and a round-cent book least of all -- that is the shape every early sale had");

    // What that means where it matters: the level is not reduced, so 0.99 does not sell.
    // It cannot be reduced by anything now -- the grid does not reach this decision -- but
    // the case is kept, because an unknown tick is still what the log will show on the next
    // one of these and this is where someone will come looking.
    assert.equal(worker.settlementCloseLevel(0.999), 0.999);
    assert.equal(worker.exitReason({
      bestBidPrice: 0.99, stopPrice: null, triggerPrice: null, settlementCloseBid: 0.999, tickSize: null,
    }), null, "the reported sale must not happen");
  } finally {
    globalThis.fetch = original;
  }
});

test("certainty close: the stop still outranks it, and a low setting is not certainty", async () => {
  // Both can be true only in a market that fell and recovered; the stop is checked first.
  assert.equal(worker.exitReason({
    bestBidPrice: 0.99, stopPrice: 0.995, triggerPrice: 0.996, settlementCloseBid: 0.999, tickSize: 0.001, shares: 7,
  }), "stop");
  // Off sells nothing, however high the bid.
  assert.equal(worker.exitReason({
    bestBidPrice: 0.999, stopPrice: null, triggerPrice: null, settlementCloseBid: 0, tickSize: 0.001,
  }), null);
  // And a position a long way from decided is never read as certainty.
  for (const bid of [0.5, 0.71, 0.9, 0.95]) {
    assert.equal(worker.exitReason({
      bestBidPrice: bid, stopPrice: null, triggerPrice: null, settlementCloseBid: 0.999, tickSize: 0.001, shares: 7,
    }), null, `${bid} must not read as certainty`);
  }
});

test("certainty close: the grid is re-asked as the price moves, because it MOVES with the price", async () => {
  // The fifth early sale, and the one that happened after the source had already been fixed.
  //
  // Measured on 2026-09-12: the close sold at 0.99 again at 10:05 and at 12:35, on markets
  // whose CLOB minimum_tick_size is 0.001, with the order going out tickSize 0.01. The
  // source was right by then. The CACHE was stale.
  //
  // Polymarket's tick is a property of the PRICE, not of the market: 0.01 through the middle
  // of the range, 0.001 near the ends. A position first looked up at 0.60 is looked up on the
  // coarse grid, and remembering that for the life of the process means the close reads 0.01
  // at exactly the moment the market has moved to 0.001. A number that was true when it was
  // fetched and false when it was used.
  const original = globalThis.fetch;
  let declared = 0.01;            // what the exchange says while the market is mid-range
  const { fetchStub, calls } = exchangeStub({ tick: () => ({ minimum_tick_size: declared }) });
  globalThis.fetch = fetchStub;
  try {
    const token = freshToken();
    const midRangeBook = { bids: [{ price: "0.62", size: "100" }], asks: [{ price: "0.64", size: "100" }] };
    assert.equal(await worker.effectiveMarketTick(token, midRangeBook), 0.01,
      "mid-range the exchange really does quote in cents");

    // The market runs to certainty and the exchange moves it onto the fine grid.
    declared = 0.001;
    // Aged past the TTL, not force-expired: force-expiring proves the re-ask works and
    // proves nothing about the TTL being short enough to matter. Measured -- with an
    // outright expiry here, setting the TTL to a full day broke no test at all, and a
    // tick that is a day stale is exactly this bug.
    worker.__ageMarketTickCacheForTests(token, 90000);
    const asked = calls.length;
    const tick = await worker.effectiveMarketTick(token, roundCentBook);
    assert.ok(calls.length > asked, "the grid has to be asked about again, not remembered");
    assert.equal(tick, 0.001, "and the new answer is the one that counts");

    // Which is the whole point: 0.99 is no longer certainty on this market.
    assert.equal(worker.exitReason({
      bestBidPrice: 0.99, stopPrice: null, triggerPrice: null, settlementCloseBid: 0.999, tickSize: tick,
    }), null, "the position must be held for 0.999");
    assert.equal(worker.exitReason({
      bestBidPrice: 0.999, stopPrice: null, triggerPrice: null, settlementCloseBid: 0.999, tickSize: tick, shares: 7,
    }), "settlement");

    // And the order is priced on the same fresh grid, not on the remembered one.
    const constraints = await worker.exchangeConstraintsForToken(token);
    assert.equal(constraints.tickSize, 0.001,
      "an order priced on the stale grid rounds 0.999 back down to 0.99 on the way out");
  } finally {
    globalThis.fetch = original;
  }
});

test("certainty close: a fresh answer is not re-asked on every pass of a one-second loop", async () => {
  // The other half of the same decision. Re-asking is what makes the tick correct; re-asking
  // every pass would be one request per position per second against a shared exchange.
  const original = globalThis.fetch;
  const { fetchStub, calls } = exchangeStub({ tick: { minimum_tick_size: 0.001 } });
  globalThis.fetch = fetchStub;
  try {
    const token = freshToken();
    assert.equal(await worker.effectiveMarketTick(token, roundCentBook), 0.001);
    const afterFirst = calls.length;
    for (let pass = 0; pass < 5; pass += 1) {
      assert.equal(await worker.effectiveMarketTick(token, roundCentBook), 0.001);
    }
    assert.equal(calls.length, afterFirst, "a fresh tick is answered from memory");

    // Ten seconds old is still fresh. Together with the ninety-second case above this pins
    // the TTL from both sides: long enough not to hammer a one-second loop, short enough
    // that a market crossing onto the fine grid is re-read before a close can fire.
    worker.__ageMarketTickCacheForTests(token, 10000);
    assert.equal(await worker.effectiveMarketTick(token, roundCentBook), 0.001);
    assert.equal(calls.length, afterFirst, "a ten-second-old answer must not be re-asked");
  } finally {
    globalThis.fetch = original;
  }
});

test("certainty close: the forfeit is a fraction of the position, so the stake may grow", () => {
  // Reported with three closed winners on the dashboard, and the rule is read straight off
  // them -- what each handed back against the win it had already earned:
  //
  //   LOS vs FURIA          WIN +$1.85   P/L +$1.83    0.02 given back   0.29%
  //   Map Handicap 1WIN     WIN +$1.94   P/L +$1.86    0.08 given back   1.16%
  //   HULIGANI vs Klim      WIN +$1.58   P/L +$1.57    0.01 given back   0.15%
  //
  // The third was worth taking and the first two were not. 0.2% is the line between them,
  // and it is a line that means the same thing at a $5 stake and a $50 one -- which is the
  // whole reason it is a fraction and not a cent.
  const worth = (bid, level = 0.999) =>
    worker.certaintyCloseIsWorthTaking({ bestBidPrice: bid, settlementCloseBid: level });

  assert.equal(worth(0.9986), true, "0.14% -- the sale that was worth making");
  assert.equal(worth(0.997), false, "0.3% -- LOS, two cents of a won match");
  assert.equal(worth(0.988), false, "1.2% -- 1WIN, eight cents");
  // The boundary itself, inclusive, and the two prices either side of it.
  assert.equal(worth(0.998), true);
  assert.equal(worth(0.9979), false);
  assert.equal(worth(0.999), true);

  // A fraction, so the same prices decide the same way however large the position is. An
  // absolute cent would have quietly switched this protection off as the stake grew.
  for (const shares of [1, 7, 70, 700]) {
    assert.equal(worker.exitReason({
      bestBidPrice: 0.999, stopPrice: null, triggerPrice: null, settlementCloseBid: 0.999, tickSize: 0.001, shares,
    }), "settlement", `0.999 stays worth taking at ${shares} shares`);
    assert.equal(worker.exitReason({
      bestBidPrice: 0.99, stopPrice: null, triggerPrice: null, settlementCloseBid: 0.999, tickSize: 0.01, shares,
    }), null, `0.99 stays not worth taking at ${shares} shares`);
  }

  // The USDC figure is still reported, because that is what a person reads off a trade --
  // it just is not what the decision turns on.
  assert.equal(worker.certaintyCloseSacrificeUsdc({ bestBidPrice: 0.99, shares: 6.9 }), 0.069);
  assert.equal(worker.certaintyCloseSacrificeUsdc({ bestBidPrice: 0.999, shares: 6.9 }), 0.0069);
  assert.equal(worker.certaintyCloseSacrificeUsdc({ bestBidPrice: 0.999, shares: null }), null);

  // And a setting below certainty is left alone entirely: that is a stated price for the
  // capital, not a slice of a match already won.
  assert.equal(worth(0.95, 0.95), true);
  assert.equal(worth(0.9, 0.9), true);
  assert.equal(worth(0.99, 0.99), false, "0.99 is a certainty setting, and 1% is too much to hand back");
});

// Asked for after the rule above still let a sale go at 0.99 against a 0.999 setting:
// "a pri teto hodnote proste neni to stejne hodnota 99. a to striktne osetri!"
//
// The trigger was only half of it. The ORDER is priced separately, from a different source:
// the trigger reads the grid off the book in front of it, the order reads whatever the
// exchange declares for the token, and when those two disagree the order is the one that
// moves money. A 0.999 bid priced on a declared 0.01 grid rounds DOWN to 0.99, and a SELL
// at 0.99 authorises a sale at 0.99. That is in this log already: trigger tick 0.001, order
// out at tickSize 0.01, price 0.99.
test("certainty close: no order may be priced below the level the portfolio set", () => {
  const price = (bid, tick, minPrice) => worker.protectedExitPrice({
    stopPrice: null, bestBidPrice: bid, tickSize: tick, minPrice,
  });

  // The exact recorded case. The book is quoting 0.999, the exchange is declaring cents, and
  // the order that would go out carries 0.99. Refused: no price at all is better than a
  // price under the level, because the position redeems at 1.00 on its own.
  assert.equal(price(0.999, 0.01, 0.999), null,
    "a 0.999 bid priced on a declared cent grid must not go out at 0.99");
  // Same bid, honest grid: the order carries the level and the sale happens.
  assert.equal(price(0.999, 0.001, 0.999), 0.999);
  assert.equal(price(1, 0.001, 0.999), 1, "and a bid above the level prices above it");
  // A lower setting is met by a cent grid without any of this.
  assert.equal(price(0.95, 0.01, 0.95), 0.95);
  // The floor is the LEVEL, not the bid: a bid that drifted below the level between the
  // trigger and the order is refused rather than sold into.
  assert.equal(price(0.99, 0.001, 0.999), null);

  // A stop has no such floor, and must not acquire one. It is already selling into a fall;
  // refusing to price it would turn "the loss is capped here" into "the position is never
  // sold", which is the opposite of what a stop is for.
  assert.equal(worker.protectedExitPrice({ stopPrice: 0.5, bestBidPrice: 0.42, tickSize: 0.01 }), 0.42,
    "a gapped stop still sells where the buyers are");

  // Wired, not merely available. The level reaches the order only if submitProtectedExit
  // passes it, and only for a close: a stop arrives here with its floor in stopPrice.
  const source = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  assert.match(source, /const closeLevel = plan\.stopPrice == null \? settlementCloseLevel\(plan\.settlementCloseBid\) : null;/);
  assert.match(source, /minPrice: closeLevel,/);
});

// Found while enforcing the above, and the same defect wearing different clothes: a price
// exactly on the grid was being floored to the tick BELOW it.
//
//   0.29 * 100 = 28.999999999999996   ->   Math.floor -> 28   ->   0.28
//
// Every exit price goes through this. A stop set at 0.29 posted a SELL at 0.28 -- a cent
// under the level that was configured -- and nothing in the log would ever have said why,
// because both numbers look right on their own.
test("exit prices: a price already on the grid is never floored to the tick below it", () => {
  // The two that fail without a tolerance. They are not special: they are simply cent
  // prices whose product with 100 lands just under an integer in binary floating point.
  assert.equal(worker.roundToTick(0.29, 0.01, "down"), 0.29);
  assert.equal(worker.roundToTick(0.57, 0.01, "down"), 0.57);

  // Swept rather than sampled, because picking examples is how this survived: every cent
  // from 0.01 to 1.00 must floor to itself on a cent grid.
  for (let cents = 1; cents <= 100; cents += 1) {
    const price = Number((cents / 100).toFixed(2));
    assert.equal(worker.roundToTick(price, 0.01, "down"), price,
      `${price} is already on the cent grid and must not be lowered`);
  }
  // And on the fine grid the close actually uses.
  for (const price of [0.999, 0.998, 0.995, 0.991, 0.909, 0.101]) {
    assert.equal(worker.roundToTick(price, 0.001, "down"), price);
  }

  // A price genuinely between two ticks still rounds the way it is asked to. The tolerance
  // is a millionth of a tick; it must not swallow a real fraction of one.
  assert.equal(worker.roundToTick(0.2949, 0.01, "down"), 0.29);
  assert.equal(worker.roundToTick(0.2951, 0.01, "down"), 0.29);
  assert.equal(worker.roundToTick(0.2949, 0.01, "up"), 0.3);
  assert.equal(worker.roundToTick(0.9991, 0.001, "down"), 0.999);

  // Which is what it means downstream: a stop configured at 0.29 posts at 0.29.
  assert.equal(worker.protectedExitPrice({ stopPrice: 0.29, bestBidPrice: 0.3, tickSize: 0.01 }), 0.29);
});

// Stated as a requirement, in these words: "v pasmu 0,99-0,998 se pri parametru close at
// certainity = 99.9 nesmi nic stat."
//
// It is the answer to the one question left open by the forfeit rule -- whether a bid
// between 0.99 and 0.998 may ever be taken against a 0.999 setting -- and the answer is no,
// at every price in that band, by both of the two independent gates. Swept rather than
// sampled, because every early sale in this log was one specific price inside it.
test("certainty close: at a 0.999 setting nothing happens between 0.99 and 0.998", () => {
  for (let tenths = 990; tenths <= 998; tenths += 1) {
    const bid = Number((tenths / 1000).toFixed(3));
    // The trigger: the level is the configured one, so a bid below it is not certainty.
    assert.equal(
      worker.exitReason({
        bestBidPrice: bid, bestAskPrice: null, stopPrice: null, triggerPrice: null,
        settlementCloseBid: 0.999, shares: 7,
      }),
      null,
      `${bid} is below the 0.999 that was configured and must not sell`,
    );
    // And the order, independently: even if something upstream decided to sell, the price
    // may not be under the level. Two gates, because one of them has failed before.
    assert.equal(
      worker.protectedExitPrice({ stopPrice: null, bestBidPrice: bid, tickSize: 0.001, minPrice: 0.999 }),
      null,
      `an order at ${bid} against a 0.999 close must not be priced at all`,
    );
  }
  // The top of the band is where it starts working, and that boundary is the whole point.
  assert.equal(worker.exitReason({
    bestBidPrice: 0.999, bestAskPrice: null, stopPrice: null, triggerPrice: null,
    settlementCloseBid: 0.999, shares: 7,
  }), "settlement");
  assert.equal(worker.protectedExitPrice({ stopPrice: null, bestBidPrice: 0.999, tickSize: 0.001, minPrice: 0.999 }), 0.999);
});
