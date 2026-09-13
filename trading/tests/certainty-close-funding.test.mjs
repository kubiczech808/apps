// Runs offline: no secrets, no network.
process.env.PAPER_PORTFOLIO_USDC = "100";

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { canFundAnotherPosition as workerCanFund, watchPlan } from "../tools/rpi-live-exit-worker.mjs";
// Imported rather than lifted out by regex. The bot guards its own entry point
// (invokedDirectly), so importing it runs nothing, and the rules below are then the file's
// actual exports instead of a copy evaluated out of context -- which is what broke when the
// forfeit rule was added beside them and the lifted copy could no longer see it.
import { certaintyCloseTriggered, certaintyCloseIsWorthTaking } from "../tools/paper-trading-bot.mjs";

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
  const triggered = certaintyCloseTriggered;

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
  assert.match(mark[0], /if \(certaintyCloseTriggered\(\{\s*\n\s*closeBid,\s*\n\s*bestBid,\s*\n\s*fundable: fundedWithoutSelling,\s*\n\s*hasTradableCandidate: funding\?\.hasTradableCandidate,\s*\n\s*\}\)\) \{/,
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

test("the paper certainty close will not hand back part of a match already won", () => {
  // Reported from the dashboard, three closed winners side by side, with what each gave
  // back against the win it had already earned:
  //
  //   LOS vs FURIA          WIN +$1.85   P/L +$1.83    0.02 back   0.29%
  //   Map Handicap 1WIN     WIN +$1.94   P/L +$1.86    0.08 back   1.16%
  //   HULIGANI vs Klim      WIN +$1.58   P/L +$1.57    0.01 back   0.15%
  //
  // "Je to skoda proste na vyhranem zapase prijit o cast vyhry." The third was worth making;
  // the first two were not.
  assert.equal(certaintyCloseIsWorthTaking({ bestBid: 0.9986, closeBid: 0.999 }), true, "0.14%, the one worth making");
  assert.equal(certaintyCloseIsWorthTaking({ bestBid: 0.997, closeBid: 0.999 }), false, "0.3%, LOS");
  assert.equal(certaintyCloseIsWorthTaking({ bestBid: 0.988, closeBid: 0.999 }), false, "1.2%, 1WIN");
  // The line itself, inclusive, and the price either side of it.
  assert.equal(certaintyCloseIsWorthTaking({ bestBid: 0.998, closeBid: 0.999 }), true);
  assert.equal(certaintyCloseIsWorthTaking({ bestBid: 0.9979, closeBid: 0.999 }), false);

  // Driven through the decision the bot actually takes, with the capital locked so the
  // funding gate is not what is being measured here.
  const fires = (bid, closeBid = 0.999) => certaintyCloseTriggered({ closeBid, bestBid: bid, fundable: false });
  assert.equal(fires(0.999), true);
  // Two gates, and they are not the same gate. The SETTING says when the owner wants out;
  // the forfeit rule says whether taking that bid is worth it. At a 0.999 setting the
  // setting binds first, so 0.998 does not close -- it never reached the level asked for.
  assert.equal(fires(0.998), false, "below its own setting, whatever the forfeit would be");

  // Where the forfeit rule earns its place is a certainty setting the market cannot quote
  // exactly: 0.99 is such a setting, and a bid AT it hands back 1% of a won match. This is
  // the shape of every sale that was reported -- a 0.999 setting clamped down to the top of
  // a cent grid and taken there.
  assert.equal(fires(0.99, 0.99), false, "reaching a 0.99 setting is not a reason to hand back 1%");
  assert.equal(fires(0.998, 0.99), true, "at 0.2% it is worth taking");

  // A fraction, not a fixed sum: the same prices decide the same way whatever the stake, so
  // a portfolio that moves from $5 to $50 keeps exactly this protection rather than losing
  // it silently.
  assert.equal(certaintyCloseIsWorthTaking({ bestBid: 0.999, closeBid: 0.999 }), true);

  // And a setting below certainty is left alone: 0.95 is a price someone named for their
  // capital, not a slice of a won match, and it is not this rule's business.
  assert.equal(certaintyCloseIsWorthTaking({ bestBid: 0.95, closeBid: 0.95 }), true);
  assert.equal(fires(0.95, 0.95), true, "a deliberate haircut still closes");
  assert.equal(fires(0.94, 0.95), false, "and below its own setting it does not");

  // A bid nobody has is not a bid at certainty, at any setting.
  assert.equal(certaintyCloseIsWorthTaking({ bestBid: null, closeBid: 0.999 }), false);
});

test("the certainty close is held when there is nothing to spend the capital on", () => {
  // Asked for: as well as "do we have the stake in cash", ask "is there a candidate to
  // trade" -- and if there is not, do not close. Selling a decided position early buys the
  // capital back; capital with nothing to buy is worth less than the position, which would
  // have settled at 1.00.
  const fires = (hasTradableCandidate) => certaintyCloseTriggered({
    closeBid: 0.999, bestBid: 0.999, fundable: false, hasTradableCandidate,
  });

  assert.equal(fires(true), true, "capital locked and something to buy: close");
  assert.equal(fires(false), false, "capital locked and nothing to buy: hold to resolution");

  // Unknown leaves it armed, exactly as the funding gate does. A close that any absent
  // field can silence is the failure this one has already shipped three times, and the
  // forfeit rule above means an unnecessary close now costs at most 0.2%.
  assert.equal(fires(undefined), true);
  assert.equal(fires(null), true);

  // It is the last gate, not the first: a bid below the setting is still not a close, and
  // a forfeit above the line is still not a close, whatever the shortlist looked like.
  assert.equal(certaintyCloseTriggered({ closeBid: 0.999, bestBid: 0.99, fundable: false, hasTradableCandidate: true }), false);
  assert.equal(certaintyCloseTriggered({ closeBid: 0.99, bestBid: 0.99, fundable: false, hasTradableCandidate: true }), false);
  // And spare capital still holds the position regardless of the shortlist.
  assert.equal(certaintyCloseTriggered({ closeBid: 0.999, bestBid: 0.999, fundable: true, hasTradableCandidate: true }), false);
});

test("execution decides the candidate question and the run log says so", () => {
  // The user asked for this to happen within execution and to be logged in the execution
  // log, so the decision is recorded where the shortlist was actually built -- not
  // reconstructed afterwards from a trade that did or did not close.
  const batch = /function buildTradeBatchLog[\s\S]*?\n\}/.exec(BOT);
  assert.ok(batch, "the execution log builder must be findable");
  assert.match(batch[0], /certaintyClose: \{/, "the execution log carries the close decision");
  assert.match(batch[0], /executableCandidates,/);
  assert.match(batch[0], /armed: executableCandidates > 0,/);
  // With a reason in words, because a bare zero in a log is a number, not an explanation.
  assert.match(batch[0], /no candidate this portfolio would buy/);

  // And the gate the pass actually reads comes from what execution recorded, rather than
  // being recomputed from different inputs a pass later.
  const gate = /function lastExecutionHadTradableCandidate[\s\S]*?\n\}/.exec(BOT);
  assert.ok(gate, "the gate must be findable");
  assert.match(gate[0], /portfolioState\?\.lastDecision\?\.eligibleCount/);
  // Null, not false, when nothing has run yet: a portfolio on its first pass must not have
  // its close silenced by the absence of a number.
  assert.match(gate[0], /if \(!Number\.isFinite\(count\)\) return null;/);

  const refresh = /async function refreshTrades[\s\S]*?hasTradableCandidate: lastExecutionHadTradableCandidate\(portfolioState\)/.exec(BOT);
  assert.ok(refresh, "refreshTrades must decide it once per pass, beside the capital answer");

  // The duplicate settlementCloseBid key that used to sit in the execution log's settings
  // block is gone: two keys of the same name in one object literal is one key and a
  // question about which line is dead.
  const settings = /settings: \{[\s\S]*?\n    \},/.exec(batch[0]);
  assert.ok(settings, "the settings block must be findable");
  assert.equal((settings[0].match(/settlementCloseBid:/g) || []).length, 1,
    "settlementCloseBid appears once");
});
