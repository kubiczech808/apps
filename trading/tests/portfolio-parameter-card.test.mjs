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
  const expected = [
    "Probability", "Stake", "Resolution", "Market type", "Excluded shapes",
    "Included tags", "Excluded tags", "Dip entry", "Priority", "Volume",
    "Min net profit", "Stop loss", "Stop floor", "Reverse after stop",
    "Close at certainty", "Rotation", "Order mode", "Execution", "Automation",
    "Excluded markets",
  ];
  assert.deepEqual(rowsFor().map(([label]) => label), expected);

  // And with everything switched off, the SAME rows are still there. This is the half that
  // was broken: a portfolio that never touched the dip rule, the floor or the certainty
  // close simply had no row for them, so there was no way to see they exist.
  const off = rowsFor({
    excludedMarketShapes: [], includeOnlyMarketTags: [], excludedMarketTags: [],
    stopLossRiskMultiplier: 0, stopLossProbabilityFloor: null, reverseOnStopLoss: false,
    settlementCloseBid: null, minLiquidityUsdc: null, excludedCandidateTokenIds: [],
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
  assert.equal(valueOf(rows, "Min net profit"), "1.0%");
  assert.equal(valueOf(rows, "Volume"), "$1,000");
  assert.equal(valueOf(rows, "Stop loss"), "175.0%");
  assert.equal(valueOf(rows, "Stop floor"), "60.0%");
  assert.equal(valueOf(rows, "Close at certainty"), "99.9%");
  assert.equal(valueOf(rows, "Reverse after stop"), "$5");
  assert.equal(valueOf(rows, "Rotation"), "off");
  assert.equal(valueOf(rows, "Order mode"), "limit");
  assert.equal(valueOf(rows, "Priority"), "reward/risk");
  assert.equal(valueOf(rows, "Automation"), "on");
  assert.equal(valueOf(rows, "Excluded markets"), "2");

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
  // Only live: several live portfolios share one wallet, so correlated exposure is a
  // system switch, and the order price comes from the book rather than from a setting.
  assert.match(live, /\["Order price",/);
  assert.match(live, /\["Cross-live risk",/);
  assert.doesNotMatch(paper, /\["Cross-live risk",/);
});

test("the card covers what the server stores", () => {
  // The guard against the two halves drifting apart. Each of these is normalised into every
  // portfolio config by api.php, and each has to be visible somewhere on the card -- that is
  // what "vsechny polozky" means, checked against the server rather than against a list
  // maintained here.
  const settings = [
    "minProbability", "maxProbability", "stakeUsdc", "maxResolutionHours", "settlementCloseBid",
    "stopLossProbabilityFloor", "liveEventMode", "selectionOrder", "minLiquidityUsdc",
    "minNetYield", "executionTrigger", "executionCronMinutes", "automationEnabled",
    "autoRotatePositions", "useLimitOrders", "marketType", "excludedMarketShapes",
    "excludedCandidateTokenIds", "includeOnlyMarketTags", "excludedMarketTags",
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
      minNetYield: "normalizeMinimumNetYield",
      settlementCloseBid: "normalizeSettlementCloseBid",
      stopLossProbabilityFloor: "normalizeStopLossProbabilityFloor",
      minProbability: "normalizeEligibilityThreshold",
      maxProbability: "normalizeOptionalProbability",
      minLiquidityUsdc: "normalizeOptionalMoney",
      executionCronMinutes: "executionCronMinutesLabel",
      executionTrigger: "normalizeExecutionTrigger",
      includeOnlyMarketTags: "normalizeMarketTagList",
      excludedMarketTags: "excludedTags",
      marketType: "portfolioMarketTypeLabel",
      excludedCandidateTokenIds: "excludedTokens",
      useLimitOrders: "useLimitOrders",
      automationEnabled: "automationEnabled",
    }[setting] || setting;
    assert.match(builder, new RegExp(named), `${setting} has no row on the parameter card`);
  }
});
