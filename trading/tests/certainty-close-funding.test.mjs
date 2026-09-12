// Runs offline: no secrets, no network.
process.env.PAPER_PORTFOLIO_USDC = "100";

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { canFundAnotherPosition as workerCanFund, watchPlan } from "../tools/rpi-live-exit-worker.mjs";

const BOT = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");

// The bot is a single self-contained runtime with a top-level main(), so the rule is lifted
// out and driven directly rather than by importing the file. Lifted, not retyped: what runs
// below is the file's own source for the function.
function botRule() {
  const source = /export function canFundAnotherPosition[\s\S]*?\n\}/.exec(BOT);
  assert.ok(source, "the paper bot's funding rule must be findable");
  return new Function(`${source[0].replace("export ", "")}; return canFundAnotherPosition;`)();
}

test("the certainty close is only for capital that is actually locked", () => {
  for (const canFund of [botRule(), workerCanFund]) {
    // Enough free for the next stake: another position can be opened without selling, so
    // there is nothing for the close to buy back.
    assert.equal(canFund(5, 5), true, "a free balance equal to the stake funds a position");
    assert.equal(canFund(12.5, 5), true);
    // Not enough: the capital in the decided position IS the constraint, and buying it back
    // a few hours early for a tick is the whole point of the setting.
    assert.equal(canFund(4.99, 5), false);
    assert.equal(canFund(0, 5), false);

    // Unknown must never silence the close. Every one of these answers "not fundable", so
    // the close still fires -- an absent number is not evidence that capital is spare.
    assert.equal(canFund(null, 5), false);
    assert.equal(canFund(undefined, 5), false);
    assert.equal(canFund(Number.NaN, 5), false);
    assert.equal(canFund(50, null), false);
    assert.equal(canFund(50, 0), false);
    assert.equal(canFund(50, -1), false);
  }
});

test("the worker drops the settlement close when the account can fund another stake", () => {
  const position = { tokenId: "77", shares: 10, totalCostUsdc: 5, entryPrice: 0.5, size: 10 };
  const policy = {
    settlementCloseBid: 0.999,
    stopLossEnabled: false,
    stopLossRiskMultiplier: 0,
    stakeUsdc: 5,
  };

  // Cash short of the stake: the close is armed, at the bid the portfolio configured.
  const locked = watchPlan(position, { ...policy, accountCashUsdc: 1.2 });
  assert.ok(locked, "a position with a settlement close is still watched");
  assert.equal(locked.settlementCloseBid, 0.999);

  // Cash covers the stake: nothing to buy back, so the close is not armed.
  const funded = watchPlan(position, { ...policy, accountCashUsdc: 40 });
  assert.equal(funded, null,
    "with no stop and no floor, an unneeded settlement close leaves nothing to watch");

  // And another watch reason still holds the position under watch when the close steps
  // aside -- the funding rule must not take protection away with it. The probability floor
  // is used here because it is an independent trigger that needs no derived stop.
  const floored = watchPlan(position, {
    ...policy,
    accountCashUsdc: 40,
    stopLossProbabilityFloor: 0.3,
  });
  assert.ok(floored, "a probability floor keeps the position watched");
  assert.equal(floored.settlementCloseBid, null, "the close is off while capital is spare");
  assert.equal(floored.probabilityFloor, 0.3, "the floor is untouched");

  // Unknown cash keeps the close armed, which is the safe direction.
  const unknown = watchPlan(position, { ...policy, accountCashUsdc: null });
  assert.ok(unknown, "an unknown balance must not unwatch the position");
  assert.equal(unknown.settlementCloseBid, 0.999);
});

test("the paper bot asks the question once per pass, not once per position", () => {
  // Two positions at certainty in the same fan-out must read the same answer. Asking inside
  // mapWithConcurrency would let them disagree, and the second would act on capital the
  // first had already freed.
  const refresh = /async function refreshTrades[\s\S]*?\n\}/.exec(BOT);
  assert.ok(refresh, "refreshTrades must be findable");
  assert.match(refresh[0], /const capitalState = \{\s*\n\s*canFundAnotherPosition: canFundAnotherPosition\(/,
    "refreshTrades must decide the funding question once, before the fan-out");
  assert.match(refresh[0], /markOpenTrade\(trade, strategy, capitalState\)/,
    "the pass's answer must be handed to every position");

  // The same pair the pass-forward rule reads, so "free" and "stake" mean one thing.
  assert.match(refresh[0], /portfolioState\?\.portfolio\?\.freeCapitalUsdc/);
  assert.match(refresh[0], /portfolioState\?\.portfolio\?\.maxStakeUsdc/);
});

test("the paper bot's certainty close fires on locked capital and holds on spare capital", () => {
  const source = /export function certaintyCloseTriggered[\s\S]*?\n\}/.exec(BOT);
  assert.ok(source, "the certainty close decision must be findable");
  const triggered = new Function(`${source[0].replace("export ", "")}; return certaintyCloseTriggered;`)();

  // At the configured bid with the capital locked: sell, which is the behaviour that was
  // wrong three times and must not regress while a funding gate is added above it.
  assert.equal(triggered({ closeBid: 0.999, bestBid: 0.999, fundable: false }), true);
  assert.equal(triggered({ closeBid: 0.999, bestBid: 0.9995, fundable: false }), true);
  // Below the configured bid: still never an early sale.
  assert.equal(triggered({ closeBid: 0.999, bestBid: 0.99, fundable: false }), false,
    "0.99 is not 0.999 -- this is the sale the owner reported three times");
  assert.equal(triggered({ closeBid: 0.999, bestBid: 0.991, fundable: false }), false);

  // The new condition: spare capital means nothing to buy back, so hold to resolution.
  assert.equal(triggered({ closeBid: 0.999, bestBid: 0.999, fundable: true }), false);

  // Off, and unknown. A missing answer must leave the close armed, not silence it.
  assert.equal(triggered({ closeBid: null, bestBid: 0.999, fundable: false }), false);
  assert.equal(triggered({ closeBid: 0.999, bestBid: 0.999 }), true);
  assert.equal(triggered({ closeBid: 0.999, bestBid: 0.999, fundable: undefined }), true);
  assert.equal(triggered({ closeBid: 0.999, bestBid: 0.999, fundable: "yes" }), true,
    "only a real true may hold the position; anything else is not an answer");
  assert.equal(triggered({ closeBid: 0.999, bestBid: null, fundable: false }), false,
    "no bid is not a bid at certainty");

  // And the decision is actually the one markOpenTrade takes.
  const mark = /async function markOpenTrade[\s\S]*?\n\}\n\nfunction/.exec(BOT);
  assert.ok(mark, "markOpenTrade must be findable");
  assert.match(mark[0], /const fundedWithoutSelling = funding\?\.canFundAnotherPosition === true;/,
    "the pass's answer must be read, and read strictly");
  assert.match(mark[0], /if \(certaintyCloseTriggered\(\{ closeBid, bestBid, fundable: fundedWithoutSelling \}\)\) \{/,
    "markOpenTrade must close through the rule the test above drives");
});

test("the API sends the worker both figures the rule needs", () => {
  const policy = /function live_stop_loss_policy_config[\s\S]*?\n\}/.exec(API);
  assert.ok(policy, "the live policy builder must be findable");
  assert.match(policy[0], /'accountCashUsdc' => \$accountCashUsdc,/,
    "the worker cannot answer the question without the account's cash");
  assert.match(policy[0], /'stakeUsdc' => is_numeric\(\$row\['stakeUsdc'\] \?\? null\)/,
    "nor without the portfolio's stake");

  const payload = /function live_stop_loss_policy_payload[\s\S]*?\n\}/.exec(API);
  assert.ok(payload, "the policy payload must be findable");
  assert.match(payload[0], /\$accountCashUsdc = is_numeric\(\$accountState\['portfolio'\]\['cashUsdc'\] \?\? null\)/,
    "the cash figure must come from the live account state");
  // Both call sites, or a portfolio's positions would be judged without it.
  assert.equal(
    (payload[0].match(/live_stop_loss_policy_config\(\$config, [^)]*\$accountCashUsdc\)/g) || []).length,
    2,
    "every policy lookup must carry the cash figure, the fallback included");
});
