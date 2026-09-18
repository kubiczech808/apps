// Runs offline: the browser's real parameter builder is lifted out of app.js and EXECUTED,
// with its own real helpers rather than stubs. No network, no secrets.
//
// Asked for: "zkontroluj, ze ma prehled parametru portfolia vsechny polozky a values jsou
// maximalne strucne. napr. probability staci rozmezi %, dip entry staci rozmezi pro entry,
// certainity staci hodnota, apod."
//
// Both halves are policy, not wording, and each needs a different kind of check:
//
//   * ALL ITEMS. Several parameters used to be hidden when they were off, on the grounds
//     that a column of "Off" is noise. A parameter that disappears when unset cannot be
//     checked at all -- the reader cannot tell "not set" from "not supported" -- which is
//     how the stop-loss probability floor came to be settable in the modal and absent from
//     the card. So the label list is asserted whole, and against the CONFIG the server
//     normalises, so a new setting cannot be added on one side only.
//   * CONCISE. A value is the number. Asserting that is asserting an absence, so it is
//     done by length and by shape: no value may be a sentence.
//
// The eight tests that previously pinned these rows grepped the two builders for their
// exact source text. They are rewritten here rather than deleted -- what they defended is
// that each parameter IS shown, which is what this asserts, by running the thing.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildRows, APP, extractFunction, constant, API } from "./portfolio-parameter-card-harness.mjs";

const CONFIG = {
  minProbability: 0.7,
  maxProbability: 0.8,
  stakeUsdc: 5,
  liveEventMode: "include",
  marketType: "all",
  excludedMarketShapes: ["over-under", "draw"],
  includeOnlyMarketTags: ["esports"],
  excludedMarketTags: [],
  selectionOrder: "highest_reward_risk_first",
  minLiquidityUsdc: 1000,
  minNetYield: 0.01,
  stopLossRiskMultiplier: 1.75,
  stopLossProbabilityFloor: 0.6,
  reverseOnStopLoss: true,
  settlementCloseBid: 0.999,
  autoRotatePositions: false,
  useLimitOrders: true,
  executionTrigger: "cron",
  executionCronMinutes: 60,
  automationEnabled: true,
  excludedCandidateTokenIds: ["a", "b"],
};

const rowsFor = (overrides = {}) => buildRows({ ...CONFIG, ...overrides }, { mode: "paper-x" });
const valueOf = (rows, label) => rows.find(([name]) => name === label)?.[1];

test("every parameter has a row, whether it is set or not", () => {
  // The set, named, so adding a setting to the form and forgetting the card fails here.
  // In the order the parameter FORM asks for them: the card and the form are read one
  // after the other, and two different orders make that a search every time.
  const expected = [
    "Probability", "Stake", "Resolution", "Priority", "Volume", "Execution",
    "Rotation", "Close at certainty", "Dip entry", "Stop floor", "Stop loss",
    "Reverse after stop", "Included tags", "Excluded tags", "Excluded shapes",
    "Order mode",
  ];
  assert.deepEqual(rowsFor().map(([label]) => label), expected);

  // And with everything switched off, the SAME rows are still there. This is the half that
  // was broken: a portfolio that never touched the dip rule, the floor or the certainty
  // close simply had no row for them, so there was no way to see they exist.
  const off = rowsFor({
    excludedMarketShapes: [], includeOnlyMarketTags: [], excludedMarketTags: [],
    stopLossRiskMultiplier: 0, stopLossProbabilityFloor: null, reverseOnStopLoss: false,
    settlementCloseBid: null, minLiquidityUsdc: null,
  });
  assert.deepEqual(off.map(([label]) => label), expected);
  assert.equal(valueOf(off, "Stop floor"), "off");
  assert.equal(valueOf(off, "Close at certainty"), "off");
  assert.equal(valueOf(off, "Dip entry"), "off");
  assert.equal(valueOf(off, "Excluded shapes"), "—");
  assert.equal(valueOf(off, "Volume"), "—");
});

test("a value is the number, not a sentence about it", () => {
  const rows = rowsFor();
  assert.equal(valueOf(rows, "Probability"), "70.0%–80.0%");
  assert.equal(valueOf(rows, "Stake"), "$5");
  assert.equal(valueOf(rows, "Resolution"), "≤ 19 h + under way");
  assert.equal(valueOf(rows, "Volume"), "$1,000");
  assert.equal(valueOf(rows, "Stop loss"), "175.0%");
  assert.equal(valueOf(rows, "Stop floor"), "60.0%");
  assert.equal(valueOf(rows, "Close at certainty"), "99.9%");
  assert.equal(valueOf(rows, "Reverse after stop"), "$5");
  assert.equal(valueOf(rows, "Rotation"), "off");
  assert.equal(valueOf(rows, "Order mode"), "limit");
  assert.equal(valueOf(rows, "Priority"), "reward/risk");

  // The general rule, so a new row cannot arrive as a paragraph: no value is a sentence.
  for (const [label, value] of rows) {
    assert.ok(String(value).length <= 34, `"${label}" is too long to read at a glance: ${value}`);
    assert.doesNotMatch(String(value), /\b(without|rather|not counted|qualifying|always included)\b/i,
      `"${label}" describes the parameter instead of stating it: ${value}`);
  }
});

test("probability with no ceiling reads as a floor, not a fake range", () => {
  assert.equal(valueOf(rowsFor({ maxProbability: null }), "Probability"), "≥ 70.0%");
});

test("dip entry states the band it buys in", () => {
  // "dip entry staci rozmezi pro entry". Where the market OPENED is the rule's condition and
  // is the same on every dip portfolio; the band it BUYS in is the parameter being tuned.
  // The portfolio's own probability range has to sit inside the dip's buy band, or the
  // rule is refused as configured -- a dip portfolio still filtering for 70-80% would fire
  // without a collapse. The card reports that refusal rather than a band it is not applying.
  const rows = rowsFor({
    minProbability: 0.3, maxProbability: 0.56,
    dipEntryEnabled: true, dipEntryOpenMin: 0.7, dipEntryOpenMax: 1,
    dipEntryBuyMin: 0.3, dipEntryBuyMax: 0.56,
  });
  assert.equal(valueOf(rows, "Dip entry"), "30.0%–56.0%");
});

test("the resolution row changes with the mode, and states no ceiling where none applies", () => {
  // Under "only" nothing is admitted by its horizon, so printing a ceiling would describe a
  // rule the run does not apply. The parameter form hides the input for the same reason.
  assert.equal(valueOf(rowsFor({ liveEventMode: "only" }), "Resolution"), "under way only");
  assert.equal(valueOf(rowsFor({ liveEventMode: "ignore" }), "Resolution"), "≤ 19 h");
});

test("a portfolio that has excluded every shape is told so", () => {
  // Excluding all seven leaves a portfolio that can never take a candidate, and it fails
  // silently: no orders, no rejections worth reading. Listing seven labels would leave the
  // reader to notice that is all of them.
  const every = [...constant("MARKET_SHAPE_LABELS").matchAll(/^\s*"?([a-z-]+)"?:/gm)].map((match) => match[1]);
  assert.ok(every.length >= 5, `the shape labels must be readable: ${every.join(", ")}`);
  assert.equal(valueOf(rowsFor({ excludedMarketShapes: every }), "Excluded shapes"), "all — cannot trade");
});

test("both cards are built by the one list", () => {
  // They were two near-identical builders and had already drifted: the paper card showed
  // the order mode and the live card showed cross-live risk, and neither showed the
  // probability floor. The live card adds its own rows on the end and adds no others.
  const paper = extractFunction(APP, "portfolioRuleRows");
  const live = extractFunction(APP, "livePortfolioRuleRows");
  for (const [name, body] of [["paper", paper], ["live", live]]) {
    assert.match(body, /portfolioParameterRows\(config, \{/, `the ${name} card must use the shared list`);
  }
  // The one row still only on the live card: 5050's tag filter, which is the only thing
  // there that says which markets that portfolio will look at at all. The order price and
  // cross-live risk were taken off by request and are checked in "the settings taken off
  // the card still work".
  assert.match(live, /\["Tag filter",/);
  assert.doesNotMatch(paper, /\["Tag filter",/);
});

test("the card covers what the server stores", () => {
  // The guard against the two halves drifting apart. Each of these is normalised into every
  // portfolio config by api.php, and each has to be visible somewhere on the card -- that is
  // what "vsechny polozky" means, checked against the server rather than against a list
  // maintained here.
  // Two groups are deliberately absent from this list, for two different reasons.
  //
  // marketType and minNetYield no longer JUDGE anything: "odeber z logiky i z UI posouzeni
  // parametru Market type - napriklad All markets, Min net profit". Both are still
  // normalised into the stored config so an archived portfolio reads back the rules it was
  // traded under, but neither filters and neither has a row.
  //
  // automationEnabled and excludedCandidateTokenIds still work exactly as before and are
  // simply not shown: "odeber pouze z UI ale nech funkcni - automation, Cross-live risk,
  // Order price, Excluded markets". The test below asserts they are still APPLIED, which is
  // what "nech funkcni" means and what a bare removal from this list would stop checking.
  const settings = [
    "minProbability", "maxProbability", "stakeUsdc", "maxResolutionHours", "settlementCloseBid",
    "stopLossProbabilityFloor", "liveEventMode", "selectionOrder", "minLiquidityUsdc",
    "executionTrigger", "executionCronMinutes",
    "autoRotatePositions", "useLimitOrders", "excludedMarketShapes",
    "includeOnlyMarketTags", "excludedMarketTags",
  ];
  for (const setting of settings) {
    assert.match(API, new RegExp(`'${setting}' =>`), `${setting} must be a stored setting`);
  }
  const builder = extractFunction(APP, "portfolioParameterRows");
  for (const setting of settings) {
    // maxResolutionHours reaches the card through resolutionHoursForMode, and the stop-loss
    // multiplier through stopLossRiskMultiplier; both are named in the builder's body.
    // Two reach the card through a helper rather than by name: the horizon through
    // resolutionHoursForMode, and the live-event mode through configLiveEventMode.
    const named = {
      maxResolutionHours: "resolutionHoursForMode",
      liveEventMode: "configLiveEventMode",
      autoRotatePositions: "automaticRotationIsEnabled",
      excludedMarketShapes: "configExcludedMarketShapes",
      stakeUsdc: "normalizeRiskAllocation",
      settlementCloseBid: "normalizeSettlementCloseBid",
      stopLossProbabilityFloor: "normalizeStopLossProbabilityFloor",
      minProbability: "normalizeEligibilityThreshold",
      maxProbability: "normalizeOptionalProbability",
      minLiquidityUsdc: "normalizeOptionalMoney",
      executionCronMinutes: "executionCronMinutesLabel",
      executionTrigger: "normalizeExecutionTrigger",
      includeOnlyMarketTags: "normalizeMarketTagList",
      excludedMarketTags: "excludedTags",
      useLimitOrders: "useLimitOrders",
    }[setting] || setting;
    assert.match(builder, new RegExp(named), `${setting} has no row on the parameter card`);
  }
});

test("the settings taken off the card still work", () => {
  // "odeber pouze z UI ale nech funkcni". A setting that stops being shown and quietly
  // stops being applied is the same bug as one that is shown and ignored, so each of the
  // four is checked where it is enforced rather than where it used to be displayed.
  const bot = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  const executor = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // Automation: an automatic run still does nothing while the switch is off.
  assert.match(API, /'automationEnabled' => \(bool\)/);
  assert.match(executor, /AUTOMATION_DISABLED/);

  // The per-market exclusion list still drops a token from the shortlist.
  assert.match(executor, /EXCLUDED_CANDIDATE_TOKEN_IDS\.has\(tokenId\)/);
  assert.match(API, /'excludedCandidateTokenIds' =>/);

  // 5050 still bids at its configured price, and the live portfolio still takes the book.
  assert.match(executor, /FIXED_ENTRY_PRICE/);

  // And correlated exposure across the live portfolios is still blocked.
  assert.match(executor, /CROSS_PORTFOLIO_RISK_DIVERSIFICATION/);

  // None of the four is on the card.
  const labels = buildRows(CONFIG, { mode: "paper-x" }).map(([label]) => label);
  for (const gone of ["Automation", "Excluded markets", "Order price", "Cross-live risk"]) {
    assert.ok(!labels.includes(gone), `${gone} must not be on the card`);
  }
  const live = extractFunction(APP, "livePortfolioRuleRows");
  assert.ok(!live.includes('["Order price"'), "nor on the live card");
  assert.ok(!live.includes('["Cross-live risk"'));
});

test("the card is ordered the way the form is", () => {
  // Checked against the form itself rather than against a list kept here, so moving a
  // field in index.html and not moving the row fails.
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  // Which form control each card row corresponds to. A row with no control is one the
  // form cannot change, and there are none of those left on the card.
  const controlFor = {
    Probability: "data-eligibility-threshold",
    Stake: "data-risk-allocation",
    Resolution: "data-live-event-mode",
    Priority: "data-selection-order",
    Volume: "data-min-liquidity",
    Execution: "data-execution-trigger",
    Rotation: "data-auto-rotate-positions",
    "Close at certainty": "data-settlement-close-bid",
    "Dip entry": "data-dip-entry-group",
    "Stop floor": "data-stop-loss-probability-floor",
    "Stop loss": "data-stop-loss-risk-multiplier",
    "Reverse after stop": "data-stop-loss-reverse-on-trigger",
    "Included tags": "data-include-only-tags",
    "Excluded tags": "data-excluded-tags",
    "Excluded shapes": "data-exclude-market-shape",
    "Order mode": "data-limit-orders",
  };
  const labels = buildRows(CONFIG, { mode: "paper-x" }).map(([label]) => label);
  const positions = labels.map((label) => {
    const control = controlFor[label];
    assert.ok(control, `${label} has no form control named for it`);
    const at = html.indexOf(control);
    assert.ok(at > 0, `${control} must exist in the parameter form`);
    return { label, at };
  });
  const sorted = [...positions].sort((left, right) => left.at - right.at).map((row) => row.label);
  assert.deepEqual(labels, sorted,
    `the card's order must match the form's, which reads: ${sorted.join(", ")}`);
});
