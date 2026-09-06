// Runs offline: no secrets, no network, no hosting access.
process.env.PAPER_PORTFOLIO_USDC = "100";
process.env.PAPER_MAX_FRACTION = "0.05";
process.env.PAPER_MIN_ANNUALIZATION_DAYS = String(1 / 24);

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");
const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8");
const APP = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../assets/app.css", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const BOT = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
const EXECUTOR = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
const WORKFLOW = readFileSync(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8");

// Drives api.php's own normalizer. The file is loaded up to its request dispatch, so
// the definitions run and nothing else does -- what is asserted below is the file's
// behaviour rather than a restatement of it.
function normalizeConfig(input) {
  const directory = mkdtempSync(join(tmpdir(), "portfolio-config-"));
  try {
    const cut = API.indexOf("\ntry {");
    assert.ok(cut > 0, "api.php still ends with its request dispatch");
    const definitions = join(directory, "definitions.php");
    mkdirSync(join(directory, "data"), { recursive: true });
    writeFileSync(definitions, API.slice(0, cut) + "\n");
    const encoded = Buffer.from(JSON.stringify(input)).toString("base64");
    const output = execFileSync("php", ["-r",
      `require '${definitions}'; echo json_encode(normalize_portfolio_config(json_decode(base64_decode('${encoded}'), true)));`,
    ], { encoding: "utf8" });
    return JSON.parse(output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Runs the real request dispatch (unlike normalizeConfig above, which cuts it away), the
// same way taxonomy-drilldown.test.mjs drives api.php: a temp directory standing in for
// the hosting docroot, $_GET set from the query, and the file required whole so its own
// action routing runs rather than a restatement of it.
function callPortfolioRunLogApi(directory, query) {
  const encoded = Buffer.from(JSON.stringify(query)).toString("base64");
  const output = execFileSync("php", ["-r",
    `$_GET = json_decode(base64_decode('${encoded}'), true); require '${join(directory, "api.php")}';`,
  ], { encoding: "utf8" });
  return JSON.parse(output);
}

function withPortfolioRunLogApi(paperState, archives, run) {
  const directory = mkdtempSync(join(tmpdir(), "portfolio-run-log-"));
  try {
    writeFileSync(join(directory, "api.php"), API);
    mkdirSync(join(directory, "data"), { recursive: true });
    writeFileSync(join(directory, "data/paper-state.json"), JSON.stringify(paperState));
    for (const [relativePath, lines] of Object.entries(archives)) {
      const file = join(directory, "data", relativePath);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    }
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} was not found`);
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

test("portfolio trade analysis: grades the selection at settlement, excludes unfilled bids, and applies the live baseline", () => {
  const analysis = new Function("state", `
    const LIVE_PORTFOLIO_ANALYSIS_START_AT = Date.parse("2026-08-28T00:00:00+02:00");
    ${extractFunction(APP, "isClosedTrade")}
    ${extractFunction(APP, "isUnfilledLimitOrder")}
    ${extractFunction(APP, "tradeClosedAt")}
    ${extractFunction(APP, "numericOrNull")}
    ${extractFunction(APP, "tradePotentialGain")}
    ${extractFunction(APP, "tradeCostBasis")}
    ${extractFunction(APP, "portfolioAnalysisTokenId")}
    ${extractFunction(APP, "portfolioAnalysisOutcomeFromPrice")}
    ${extractFunction(APP, "portfolioAnalysisGainIfWon")}
    ${extractFunction(APP, "portfolioAnalysisPnl")}
    ${extractFunction(APP, "portfolioAnalysisOutcome")}
    ${extractFunction(APP, "portfolioAnalysisClosedTrades")}
    ${extractFunction(APP, "portfolioAnalysisProbability")}
    ${extractFunction(APP, "safeEntryProbability")}
    ${extractFunction(APP, "portfolioAnalysisRows")}
    ${extractFunction(APP, "portfolioAnalysisSummary")}
    ${extractFunction(APP, "portfolioAnalysisTag")}
    ${extractFunction(APP, "portfolioAnalysisTags")}
    return { portfolioAnalysisClosedTrades, portfolioAnalysisPnl, portfolioAnalysisRows, portfolioAnalysisSummary, portfolioAnalysisTags, safeEntryProbability };
  `)({ portfolioAnalysisOutcomeMap: { soldWin: 1, stoppedWin: 1, stoppedLoss: 0 } });
  const ledger = [
    { id: "before", status: "WON", closedAt: "2026-08-27T23:00:00+02:00", totalCostUsdc: 5, netGainIfWinUsdc: 1, marketType: "binary" },
    { id: "win", status: "WON", closedAt: "2026-08-28T10:00:00+02:00", totalCostUsdc: 5, netGainIfWinUsdc: 1, marketType: "binary", polymarketTags: ["sports", { slug: "soccer" }] },
    { id: "loss", status: "LOST", closedAt: "2026-08-29T10:00:00+02:00", totalCostUsdc: 5, netGainIfWinUsdc: 2, marketType: "multi", tags: ["esports"] },
    // Their realised P/L must not affect this report. The archive grades the original
    // selected outcome as a full win or loss after the sale/stop took place.
    { id: "sold-win", tokenId: "soldWin", status: "SOLD", closedAt: "2026-08-29T11:00:00+02:00", totalCostUsdc: 5, netGainIfWinUsdc: 0.5, realizedPnlUsdc: -0.2, marketType: "binary" },
    { id: "stopped-win", tokenId: "stoppedWin", status: "STOP_LOSS", closedAt: "2026-08-29T12:00:00+02:00", totalCostUsdc: 5, netGainIfWinUsdc: 0.4, realizedPnlUsdc: -5, marketType: "binary" },
    { id: "stopped-loss", tokenId: "stoppedLoss", status: "STOP_LOSS", closedAt: "2026-08-29T13:00:00+02:00", totalCostUsdc: 5, netGainIfWinUsdc: 0.7, realizedPnlUsdc: -1, marketType: "multi" },
    { id: "unfilled", status: "LIMIT_ORDER_EXPIRED", realizedPnlUsdc: 4, filledSize: 0 },
  ];
  const live = analysis.portfolioAnalysisClosedTrades(ledger, { live: true });
  assert.deepEqual(live.map((trade) => trade.id), ["win", "loss", "sold-win", "stopped-win", "stopped-loss"]);
  assert.deepEqual(analysis.portfolioAnalysisSummary(live), { trades: 5, wins: 3, losses: 2, pnlUsdc: -8.1 });
  const types = analysis.portfolioAnalysisRows(live, (trade) => trade.marketType);
  assert.deepEqual(types.map(({ winProbabilities, lossProbabilities, safeEntryProbability, ...row }) => row), [
    { value: "binary", trades: 3, wins: 3, losses: 0, winPnlUsdc: 1.9, lossPnlUsdc: 0, pnlUsdc: 1.9 },
    { value: "multi", trades: 2, wins: 0, losses: 2, winPnlUsdc: 0, lossPnlUsdc: -10, pnlUsdc: -10 },
  ]);
  assert.deepEqual(analysis.portfolioAnalysisTags(live[0]), ["sports", "soccer"]);
  // Legacy winners can lack netGainIfWinUsdc. An absent value must be derived from
  // shares minus the whole recorded entry cost, not coerced by Number(null) to zero.
  assert.equal(analysis.portfolioAnalysisPnl({ status: "WON", totalCostUsdc: 5, netGainIfWinUsdc: null, shares: 6 }), 1);
  assert.match(APP, /candidateIsOverUnderMarket\(trade\)/, "the report must include the requested O\/U split");
  assert.doesNotMatch(APP.slice(APP.indexOf("function portfolioAnalysisRows"), APP.indexOf("function renderPortfolioOptimizationReport")), /earlyExits/,
    "selection analysis must not present a sale as a third outcome");

  // The requested tag column: the lowest winning entry that cleared every losing one.
  const banded = analysis.portfolioAnalysisRows([
    { status: "WON", marketProbability: 0.7, totalCostUsdc: 5, netGainIfWinUsdc: 1, tags: ["tennis"] },
    { status: "WON", marketProbability: 0.75, totalCostUsdc: 5, netGainIfWinUsdc: 1, tags: ["tennis"] },
    { status: "WON", marketProbability: 0.8, totalCostUsdc: 5, netGainIfWinUsdc: 1, tags: ["tennis"] },
    { status: "LOST", marketProbability: 0.75, totalCostUsdc: 5, netGainIfWinUsdc: 1, tags: ["tennis"] },
  ], (trade) => analysis.portfolioAnalysisTags(trade));
  assert.equal(banded[0].safeEntryProbability, 0.8,
    "wins at 70/75/80 against a loss at 75 leave 80 as the lowest entry that beat every loss");
});

test("trade analysis: entry probability is broken down by whole percentage point", () => {
  const band = new Function(`${extractFunction(APP, "portfolioAnalysisProbability")}
    ${extractFunction(APP, "portfolioAnalysisProbabilityBand")}
    return portfolioAnalysisProbabilityBand;`)();

  // One row per point, so 91% and 99% stop sharing a row.
  assert.equal(band({ marketProbability: 0.91 }), "91%");
  assert.equal(band({ marketProbability: 0.99 }), "99%");
  assert.equal(band({ marketProbability: 0.51 }), "51%");
  assert.equal(band({ marketProbability: 0.755 }), "76%", "rounded to the nearest point, not floored to a band");
  assert.equal(band({ marketProbability: 0.7549 }), "75%");
  // The ends are collected: a row per point below an even chance would be a hundred rows
  // describing bets this system does not place.
  assert.equal(band({ marketProbability: 0.5 }), "<= 50%");
  assert.equal(band({ marketProbability: 0.2 }), "<= 50%");
  assert.equal(band({ marketProbability: 1 }), ">= 100%");
  assert.equal(band({}), "Not recorded");

  const order = new Function(`${extractFunction(APP, "portfolioAnalysisValueOrder")}
    return portfolioAnalysisValueOrder;`)();
  assert.equal(order("<= 50%"), -Infinity);
  assert.equal(order(">= 100%"), Infinity);
  assert.equal(order("76%"), 76);
  assert.ok(Number.isNaN(order("Not recorded")), "a row with no number has no place on the scale");
});

test("trade analysis: a per-point table reads by the scale, with unscaled rows last", () => {
  const analysis = new Function("state", `
    ${extractFunction(APP, "isClosedTrade")}
    ${extractFunction(APP, "isUnfilledLimitOrder")}
    ${extractFunction(APP, "tradeClosedAt")}
    ${extractFunction(APP, "numericOrNull")}
    ${extractFunction(APP, "tradePotentialGain")}
    ${extractFunction(APP, "tradeCostBasis")}
    ${extractFunction(APP, "portfolioAnalysisTokenId")}
    ${extractFunction(APP, "portfolioAnalysisOutcomeFromPrice")}
    ${extractFunction(APP, "portfolioAnalysisGainIfWon")}
    ${extractFunction(APP, "portfolioAnalysisPnl")}
    ${extractFunction(APP, "portfolioAnalysisOutcome")}
    ${extractFunction(APP, "portfolioAnalysisProbability")}
    ${extractFunction(APP, "portfolioAnalysisProbabilityBand")}
    ${extractFunction(APP, "safeEntryProbability")}
    ${extractFunction(APP, "portfolioAnalysisValueOrder")}
    ${extractFunction(APP, "portfolioAnalysisRows")}
    return { portfolioAnalysisRows, portfolioAnalysisProbabilityBand };
  `)({ portfolioAnalysisOutcomeMap: {} });

  const trade = (probability, status) => ({
    status,
    marketProbability: probability,
    totalCostUsdc: 5,
    netGainIfWinUsdc: 1,
  });
  // Deliberately out of order, and with the busiest point in the middle, so a count sort
  // and a scale sort cannot agree by accident.
  const rows = analysis.portfolioAnalysisRows([
    trade(0.9, "WON"),
    trade(0.75, "WON"),
    trade(0.75, "LOST"),
    trade(0.75, "WON"),
    trade(0.6, "WON"),
    { status: "WON", totalCostUsdc: 5, netGainIfWinUsdc: 1 },
    trade(0.4, "LOST"),
  ], analysis.portfolioAnalysisProbabilityBand, { order: "value" });
  assert.deepEqual(rows.map((row) => row.value), ["<= 50%", "60%", "75%", "90%", "Not recorded"]);

  // The default is unchanged, so every other table keeps ordering by weight.
  const byCount = analysis.portfolioAnalysisRows([
    trade(0.9, "WON"),
    trade(0.75, "WON"),
    trade(0.75, "LOST"),
  ], analysis.portfolioAnalysisProbabilityBand);
  assert.deepEqual(byCount.map((row) => row.value), ["75%", "90%"]);
});

test("trade analysis: each portfolio is loaded on demand, because the payload carries only the selected one", () => {
  const api = readFileSync(new URL("../api.php", import.meta.url), "utf8");
  // The measured cause, pinned so a change to it cannot silently un-fix this: the served
  // paper state includes trades for the selected portfolio only.
  assert.match(api, /\$includeTrades = !\$overviewOnly && \$selectedStrategyId !== null && \(string\) \$id === \$selectedStrategyId;/,
    "if this stops being true, the per-portfolio load button is no longer necessary");

  assert.match(APP, /async function refreshTradeAnalysisPortfolio\(portfolioId\)/);
  assert.match(APP, /data-trade-analysis-refresh="\$\{escapeHtml\(portfolio\.id\)\}"/);
  assert.match(APP, /\[data-trade-analysis-refresh\]/, "the click handler must be delegated onto the rebuilt report");
  // Both halves are re-read: a fresh ledger graded against a stale outcome map would
  // still miss the newest resolutions.
  const refresh = APP.slice(APP.indexOf("async function refreshTradeAnalysisPortfolio"), APP.indexOf("function renderPortfolioTradeAnalysisTable"));
  assert.match(refresh, /portfolio-analysis-outcomes/);
  assert.match(refresh, /summary: "dashboard", strategyId/);
  assert.match(refresh, /Array\.isArray\(rows\) \? rows : \[\]/,
    "an empty ledger is a real answer and must be cached as one, or the card offers to load it forever");
  // Nothing fans out over every portfolio on open.
  // The leading newline matters: `els.tabButtons.forEach` also appears indented inside
  // two earlier functions, and matching one of those inverts the slice into nothing.
  const report = APP.slice(APP.indexOf("function renderPortfolioOptimizationReport"), APP.indexOf("\nels.tabButtons.forEach"));
  assert.ok(report.length > 500, "the slice must actually contain the report renderer");
  assert.doesNotMatch(report, /portfolios\.(forEach|map)\([^)]*=>\s*refreshTradeAnalysisPortfolio/,
    "the report must not refresh every portfolio when it renders");
  assert.match(report, /Not loaded yet/, "an unloaded portfolio must not read as one with no settled selections");
});

test("opportunities: an info button reveals the market's tags next to the row's own label", () => {
  const css = readFileSync(new URL("../assets/app.css", import.meta.url), "utf8");

  assert.match(APP, /function marketTagsInfo\(row = \{\}\)/);
  assert.match(APP, /portfolioAnalysisTags\(row\)/, "the tags come from the same reader the analysis uses");
  // All four lists the tags were asked for: opened and closed positions share one table.
  assert.match(APP, /\$\{tradeTypeBadge\(trade\)\}\$\{marketTagsInfo\(trade\)\}/,
    "opened and closed positions");
  assert.match(APP, /Unfilled limit order<\/span>\$\{marketTagsInfo\(order\)\}/,
    "unfilled limit orders");
  assert.match(APP, /<strong>\$\{precheck\}<\/strong>\$\{marketTagsInfo\(item\)\}/,
    "execution candidates");

  assert.match(APP, /\[data-market-tags\]/, "the toggle is delegated onto the document");
  assert.match(APP, /aria-expanded/, "the button states whether it is open");

  // The tags open in one shared panel fixed to the viewport, not as a list inside the
  // row. Two reasons, and both are load-bearing: `.ledger td span` makes any span in a
  // table cell a block with a top margin, so a per-row list cost every row a second
  // line; and each of these tables scrolls sideways in its own container, which clips an
  // absolutely positioned child.
  assert.match(APP, /function openMarketTagsPanel\(button\)/);
  assert.match(APP, /className = "market-tags-panel"/);
  assert.match(css, /\.market-tags-panel \{[^}]*position:\s*fixed/);
  assert.doesNotMatch(css, /\.market-tags-panel \{[^}]*position:\s*absolute/);
  const buttonCss = css.slice(css.indexOf(".market-tags-button {"), css.indexOf(".market-tags-button:hover"));
  assert.match(buttonCss, /display:\s*inline-flex\s*!important/,
    "the icon must stay on the label's line rather than becoming a second row");
  assert.match(buttonCss, /margin:\s*0 0 0 [\d.]+px\s*!important/,
    "and must not inherit the block margin that pushed it onto its own line");
  // A panel fixed to the viewport drifts away from its row unless it is dismissed.
  assert.match(APP, /window\.addEventListener\("scroll", closeMarketTagsPanel, true\)/);
});

// Asked for: say "tags" rather than an italic "i", and on a phone put the control up in the
// top-right corner beside the state chip, well clear of it.
test("market tags: the control says what it opens and sits beside the chip on a phone", () => {
  const css = readFileSync(new URL("../assets/app.css", import.meta.url), "utf8");

  assert.match(APP, /aria-label="\$\{escapeHtml\(label\)\}">tags<\/button>/,
    'the button reads "tags" -- an italic "i" is the convention for "more information", '
    + "which says nothing about what is behind it");

  const buttonCss = css.slice(css.indexOf(".market-tags-button {"), css.indexOf(".market-tags-button:hover"));
  // A four-letter word does not fit a 16px square, so the button is sized by its text.
  assert.match(buttonCss, /width:\s*auto/);
  assert.doesNotMatch(buttonCss, /width:\s*16px/);
  assert.doesNotMatch(buttonCss, /font-style:\s*italic/, "the italic was there to make an i look like a glyph");

  // On a narrow card the market cell is a block and the state chip is floated right. The
  // tags control floats too, and being after the chip in the DOM it lands to the chip's
  // left -- the top-right corner, on the chip's own line rather than at the start of the
  // market name.
  const narrow = css.slice(css.indexOf("@media (max-width: 680px)"));
  const mobileRule = narrow.slice(
    narrow.indexOf(".trade-ledger-scroll .trade-market-cell > .market-tags-button"),
  ).slice(0, 260);
  assert.ok(mobileRule.startsWith(".trade-ledger-scroll .trade-market-cell > .market-tags-button"),
    "the phone placement rule has to live inside the narrow-screen media query");
  assert.match(mobileRule, /float:\s*right/);
  // The gap is the point of the request: two pills touching read as one control.
  const gap = /margin:\s*0 (\d+)px 4px 10px\s*!important/.exec(mobileRule);
  assert.ok(gap, "the gap to the chip has to be !important -- the base rule sets margin that way");
  assert.ok(Number(gap[1]) >= 16, `the gap to the state chip is ${gap[1]}px, which is not a wide one`);

  // The chip stays floated right, or there is nothing for the button to sit beside.
  assert.match(narrow, /\.trade-ledger-scroll \.trade-market-cell > \.order-chip \{[^}]*float:\s*right/);
});

test("opportunities: an unsettled market keeps its own label instead of a red pending chip", () => {
  // Requested: no "Pending resolution" label -- leave "Open position", or the resting
  // order's own label. The market has stopped trading but its settlement price is not
  // published, which changes nothing about what the row is.
  assert.doesNotMatch(APP, /order-chip[^"]*">Pending resolution/,
    "PENDING_RESOLUTION must fall through to the position or order label");
  // It must not have become a closed row either, or it would pick up a result chip.
  const closed = APP.slice(APP.indexOf("function isClosedTrade"), APP.indexOf("function isClosedTrade") + 600);
  assert.doesNotMatch(closed, /PENDING_RESOLUTION/,
    "an unsettled position is not a closed trade");
  assert.match(APP, /if \(trade\.mode === "LIVE"\) return '<span class="order-chip filled">Open position<\/span>'/);
});

test("trade analysis: the clean-entry threshold describes the history rather than guessing at it", () => {
  const safeEntry = new Function(`${extractFunction(APP, "safeEntryProbability")}\nreturn safeEntryProbability;`)();

  // The example as given: wins 70, 75, 80 and a loss at 75 -> 80.
  assert.equal(safeEntry([0.7, 0.75, 0.8], [0.75]), 0.8);
  // It clears every loss, not just the nearest one.
  assert.equal(safeEntry([0.7, 0.8, 0.9], [0.6, 0.85]), 0.9);
  // Ties do not clear: an entry equal to a losing one did lose at that probability.
  assert.equal(safeEntry([0.75], [0.75]), null);
  // No winner above the worst loss means no such floor exists, so nothing is invented.
  assert.equal(safeEntry([0.6, 0.7], [0.9]), null);
  assert.equal(safeEntry([], [0.5]), null);
  // A group that never lost: every entry already beat every loss, so the answer is its
  // lowest winner rather than an absence.
  assert.equal(safeEntry([0.82, 0.6, 0.91], []), 0.6);
  // Unrecorded probabilities are skipped, never read as zero -- a zero would look like
  // the safest possible entry and pull the whole column down.
  assert.equal(safeEntry([null, 0.8, undefined, NaN], [0.75]), 0.8);
  assert.equal(safeEntry([0.8], [null, 0.95]), null);
});

test("created portfolios: a config carrying one is stored beside the shipped four", () => {
  const config = normalizeConfig({
    paper: {
      esports: { displayName: "Esports 60", minProbability: 0.6, includeOnlyMarketTags: ["league-of-legends"] },
    },
  });
  for (const shipped of ["conservative", "highReward", "moreProbable", "equal"]) {
    assert.ok(config.paper[shipped], `${shipped} must survive`);
    assert.notEqual(config.paper[shipped].custom, true, `${shipped} is not a created portfolio`);
  }
  const created = config.paper.esports;
  assert.ok(created, "the created portfolio is stored");
  assert.equal(created.custom, true);
  assert.equal(created.displayName, "Esports 60");
  assert.equal(created.minProbability, 0.6);
  assert.deepEqual(created.includeOnlyMarketTags, ["league-of-legends"]);
  // A created paper portfolio participates in the same paper execution pipeline as
  // shipped portfolios unless its own switch is deliberately turned off.
  assert.equal(created.automationEnabled, true);
  assert.equal(created.archived, false);
});

// The horizon is saved in HOURS. Whole days could not express 12, 6 or 1 at all -- the
// normaliser rounded to an integer day with a minimum of 1, so everything under a day
// silently became 24 hours.
test("resolution horizon: api.php stores hours, and a portfolio saved in days keeps its ceiling", () => {
  const saved = normalizeConfig({
    paper: {
      inPlay: { displayName: "In-play", maxResolutionHours: 6 },
      halfDay: { displayName: "Half day", maxResolutionHours: 12 },
      oneHour: { displayName: "One hour", maxResolutionHours: 1 },
      // What a client that has not migrated still posts.
      legacy: { displayName: "Legacy", maxResolutionDays: 3 },
      // Both, hours authoritative: this is the shape the dashboard sends and the shape
      // the file itself writes, so the two must not fight.
      both: { displayName: "Both", maxResolutionHours: 6, maxResolutionDays: 1 },
    },
  });
  assert.equal(saved.paper.inPlay.maxResolutionHours, 6);
  assert.equal(saved.paper.halfDay.maxResolutionHours, 12);
  assert.equal(saved.paper.oneHour.maxResolutionHours, 1);
  assert.equal(saved.paper.legacy.maxResolutionHours, 72, "3 days is 72 hours, unchanged in meaning");
  assert.equal(saved.paper.both.maxResolutionHours, 6, "hours is the stored unit and wins");

  // Days is written alongside, derived, so a reader that has not migrated sees a sane
  // number rather than nothing. It is a floor of one day: sub-day precision is exactly
  // what days cannot carry, which is why hours is what the runtimes read first.
  assert.equal(saved.paper.inPlay.maxResolutionDays, 1);
  assert.equal(saved.paper.legacy.maxResolutionDays, 3);

  // Zero is not a horizon and must not fall through to the default. A portfolio set to 0
  // used to trade the 7-day fallback -- the opposite of what typing 0 intends -- and a
  // horizon of zero hours would mean an already-resolved market anyway. Wanting only
  // running fixtures is a separate switch, asserted below.
  const zeroed = normalizeConfig({ paper: { zero: { displayName: "Zero", maxResolutionHours: 0 } } });
  assert.equal(zeroed.paper.zero.maxResolutionHours, 168, "0 means unset, so the saved default stands");

  // Re-saving must not drift: a stored 6 has to survive a round trip unchanged, or every
  // save of an unrelated field would coarsen the horizon a step at a time.
  const round = normalizeConfig({ paper: { inPlay: saved.paper.inPlay } });
  assert.equal(round.paper.inPlay.maxResolutionHours, 6);

  // And the in-play setting is stored as one of three states, defaulting to "ignore" so no
  // existing portfolio starts behaving differently.
  const inPlay = normalizeConfig({
    paper: {
      running: { displayName: "Running", liveEventMode: "only" },
      wider: { displayName: "Wider", liveEventMode: "include" },
      any: { displayName: "Any", maxResolutionHours: 6 },
      // A client that has not migrated past the single checkbox.
      legacyOn: { displayName: "Legacy on", requireEventStarted: true },
      legacyOff: { displayName: "Legacy off", requireEventStarted: false },
      nonsense: { displayName: "Nonsense", liveEventMode: "sideways" },
    },
  });
  assert.equal(inPlay.paper.running.liveEventMode, "only");
  assert.equal(inPlay.paper.wider.liveEventMode, "include");
  assert.equal(inPlay.paper.any.liveEventMode, "ignore");
  assert.equal(inPlay.paper.legacyOn.liveEventMode, "only", "the old checkbox meant exactly this state");
  assert.equal(inPlay.paper.legacyOff.liveEventMode, "ignore");
  assert.equal(inPlay.paper.nonsense.liveEventMode, "ignore", "an unknown mode is not a mode");

  // The boolean is still written, derived, for a reader that has not migrated -- and it
  // must agree with the mode rather than drift from it.
  assert.equal(inPlay.paper.running.requireEventStarted, true);
  assert.equal(inPlay.paper.wider.requireEventStarted, false,
    "include is not the same as only, and the compatibility boolean cannot express it");
  assert.equal(inPlay.paper.any.requireEventStarted, false);

  // Re-saving must not drift: "include" has to survive a round trip, including the one
  // where the derived boolean says false.
  const modeRoundTrip = normalizeConfig({ paper: { wider: inPlay.paper.wider } });
  assert.equal(modeRoundTrip.paper.wider.liveEventMode, "include");
});

test("created portfolios: an id that could not be a state key or mode is refused", () => {
  const config = normalizeConfig({
    paper: {
      "../secrets": { displayName: "escape" },
      "9lives": { displayName: "leading digit" },
      "with space": { displayName: "space" },
      "a": { displayName: "too short" },
      "waytoolongidentifierthatgoespastthirtyonecharacters": { displayName: "too long" },
      "goodOne": { displayName: "accepted" },
    },
  });
  for (const refused of ["../secrets", "9lives", "with space", "a", "waytoolongidentifierthatgoespastthirtyonecharacters"]) {
    assert.equal(config.paper[refused], undefined, `${refused} must not be stored`);
  }
  assert.equal(config.paper.goodOne?.displayName, "accepted");
});

test("created portfolios: the stored count is bounded", () => {
  const paper = {};
  for (let index = 0; index < 40; index += 1) paper[`made${index}`] = { displayName: `Made ${index}` };
  const config = normalizeConfig({ paper });
  const created = Object.values(config.paper).filter((row) => row.custom === true);
  assert.equal(created.length, 24, "every created portfolio becomes a strategy the bot runs each pass");
  // And the shipped ones are never displaced by the cap.
  assert.equal(Object.keys(config.paper).length, 28);
});

// Asked for explicitly: archiving hides a portfolio and deactivates it, without losing
// anything, and restoring is only clearing the flag.
test("archiving: the flag round-trips on paper and 5050, and is refused on plain live", () => {
  const config = normalizeConfig({
    paper: { equal: { archived: true }, conservative: { archived: false } },
    live: { archived: true },
    live5050: { archived: true },
  });
  assert.equal(config.paper.equal.archived, true);
  assert.equal(config.paper.conservative.archived, false);
  // The plain live portfolio holds real positions and open orders with no automatic
  // way to stop opening more; hiding it from the dashboard would hide real exposure.
  assert.equal(config.live.archived, false);
  // 5050 is the one live portfolio archiving was asked for. Withdrawing an expired
  // resting order and refreshing the account snapshot are unconditional in the
  // executor, so archiving it only stops new bids -- nothing already held goes dark.
  assert.equal(config.live5050.archived, true);
});

test("archiving: nothing a portfolio was traded under is dropped by archiving it", () => {
  const before = normalizeConfig({
    paper: {
      equal: {
        displayName: "Stop loss",
        minProbability: 0.75,
        maxResolutionDays: 5,
        includeOnlyMarketTags: ["esports"],
        excludedCandidateTokenIds: ["123456"],
      },
    },
  });
  const after = normalizeConfig({ paper: { equal: { ...before.paper.equal, archived: true } } });
  assert.deepEqual({ ...after.paper.equal, archived: false }, { ...before.paper.equal, archived: false },
    "archiving changes one flag and nothing else");
});

test("created portfolios: the bot builds strategies from the config the workflow passes", async () => {
  const bot = await import("../tools/paper-trading-bot.mjs");
  // PORTFOLIO_USDC and STAKE_USDC arrived with fixed-USDC stake sizing: a created
  // portfolio saved before that field existed still derives its stake from the
  // fraction, so both have to be in scope here or the extraction throws.
  const build = new Function("process", "MAX_FRACTION", "DEFAULT_MAX_RESOLUTION_DAYS",
    "DEFAULT_MAX_RESOLUTION_HOURS", "MAX_RESOLUTION_HOURS_CEILING", "HOURS_PER_DAY", "PAPER_STRATEGIES",
    "normalizeExecutionTrigger", "PORTFOLIO_USDC", "STAKE_USDC", "console", `
    ${extractFunction(BOT, "normalizeStopLossRiskMultiplier")}
    ${extractFunction(BOT, "rowStopLossRiskMultiplier")}
    // A created portfolio can carry an upper probability bound as well as a floor, so the
    // helper that reads it has to be in scope here too.
    ${extractFunction(BOT, "normalizeOptionalProbability")}
    // The horizon is stored in hours; the pair that reads it, in whichever unit the row
    // was saved with, has to come along or the strategy has no ceiling at all.
    ${extractFunction(BOT, "normalizeMaxResolutionHours")}
    ${extractFunction(BOT, "configMaxResolutionHours")}
    // And the three-state setting for fixtures already under way, which a created
    // portfolio carries like any other rule.
    ${/const LIVE_EVENT_MODES = new Set\(\[[^\]]*\]\);/.exec(BOT)[0]}
    ${extractFunction(BOT, "normalizeLiveEventMode")}
    ${extractFunction(BOT, "configLiveEventMode")}
    ${extractFunction(BOT, "normalizeSettlementCloseBid")}
    ${extractFunction(BOT, "customPaperStrategies")}
    return customPaperStrategies;
  `)(
    { env: {} },
    0.05,
    7,
    7 * 24,
    365 * 24,
    24,
    { conservative: { id: "conservative" } },
    (value) => (value === "after_scrape" ? "after_scrape" : "cron"),
    100,
    5,
    console,
  );

  const strategies = build(JSON.stringify({
    esports: {
      displayName: "Esports 60",
      minProbability: 0.6,
      maxResolutionDays: 3,
      marketType: "binary",
      automationEnabled: true,
      autoRotatePositions: true,
      includeOnlyMarketTags: ["league-of-legends"],
    },
    // Refused for the same reasons the API refuses them.
    "9bad": { displayName: "leading digit" },
    conservative: { displayName: "must not shadow a shipped portfolio" },
  }));

  assert.deepEqual(Object.keys(strategies), ["esports"]);
  assert.equal(strategies.esports.label, "Esports 60");
  assert.equal(strategies.esports.minProbability, 0.6);
  assert.equal(strategies.esports.maxResolutionDays, 3);
  assert.equal(strategies.esports.maxResolutionHours, 72,
    "a portfolio saved in days keeps exactly the horizon it had, read as hours");
  assert.equal(strategies.esports.marketType, "binary");
  assert.equal(strategies.esports.automationEnabled, true);
  assert.equal(strategies.esports.allowRotation, true);
  assert.deepEqual([...strategies.esports.includeOnlyMarketTags], ["league-of-legends"]);
  const legacyStrategies = build(JSON.stringify({
    oldConfig: { displayName: "Saved before automation switch" },
  }));
  assert.equal(legacyStrategies.oldConfig.automationEnabled, true,
    "a created portfolio without the field must keep trading automatically");

  // The whole point of the unit: a sub-day horizon has to survive the trip. Reading days
  // first would round 6 up to a whole day and quietly trade a 24-hour window.
  const shortHorizon = build(JSON.stringify({
    inPlay: {
      displayName: "In-play only",
      maxResolutionHours: 6,
      // What the API writes alongside hours for readers that have not migrated. It must
      // lose to the hours value, not overrule it.
      maxResolutionDays: 1,
      requireEventStarted: true,
    },
  }));
  assert.equal(shortHorizon.inPlay.maxResolutionHours, 6);
  assert.equal(shortHorizon.inPlay.maxResolutionDays, 0.25);
  assert.equal(shortHorizon.inPlay.liveEventMode, "only",
    "a portfolio saved while this was a checkbox meant exactly the \"only\" state");
  assert.equal(legacyStrategies.oldConfig.liveEventMode, "ignore",
    "a portfolio that never set it must not start refusing markets");
  // Malformed input must not take the shipped portfolios down with it.
  assert.deepEqual(build("{not json"), {});
  assert.deepEqual(build(""), {});
  assert.ok(typeof bot.buildCalculationReport === "function", "the module still imports");
});

test("archiving: an archived portfolio is not executed and its capital is not a trigger", () => {
  // Both rules read the same predicate, so both are asserted at their call sites.
  assert.match(BOT, /return Object\.values\(PAPER_STRATEGIES\)\.filter\(\(strategy\) => !paperStrategyIsArchived\(strategy\)\);/,
    "an archived portfolio must not be executed");
  assert.match(BOT, /if \(paperStrategyIsArchived\(strategy\)\) continue;/,
    "nor may its free capital bring a pass forward");
  // A manual run reaches an automation-off portfolio, but not an archived one.
  assert.match(BOT, /paperStrategyIsArchived\(PAPER_STRATEGIES\[PAPER_STRATEGY_ID\]\) \? \[\] : \[PAPER_STRATEGIES\[PAPER_STRATEGY_ID\]\]/);
  // Everything the portfolio holds is still maintained: neither the state merge nor the
  // portfolio refresh may skip archived rows, or archiving would quietly lose data.
  const merge = extractFunction(BOT, "mergeStates");
  const update = extractFunction(BOT, "updatePortfolio");
  for (const [name, source] of [["mergeStates", merge], ["updatePortfolio", update]]) {
    assert.ok(!/paperStrategyIsArchived/.test(source),
      `${name} must keep archived portfolios, or their stored rows are lost`);
  }
});

test("created portfolios: the workflow passes them and the archive flag to the bot", () => {
  // Their ids are not known when the workflow is written, so they travel as one JSON
  // variable. Always written, or deleting the last one would not remove it.
  assert.match(WORKFLOW, /emit\("PAPER_CUSTOM_PORTFOLIOS", json\.dumps\(custom, separators=\(",", ":"\)\)\)/);
  assert.match(WORKFLOW, /re\.fullmatch\(r"\[a-z\]\[a-zA-Z0-9\]\{1,30\}", str\(key\)\)/,
    "the workflow filters ids by the same shape the API and the bot enforce");
  assert.match(WORKFLOW, /emit\(f"\{prefix\}_ARCHIVED", str\(bool\(row\.get\("archived"\)\)\)\.lower\(\)\)/);
  assert.match(BOT, /archived: envBool\("PAPER_EQUAL_ARCHIVED", false\)/);
  for (const prefix of ["PAPER_CONSERVATIVE", "PAPER_HIGH_REWARD", "PAPER_MORE_PROBABLE", "PAPER_EQUAL"]) {
    assert.match(BOT, new RegExp(`archived: envBool\\("${prefix}_ARCHIVED", false\\)`));
  }
  assert.match(API, /return in_array\(\$text, \['conservative', 'highReward', 'moreProbable', 'equal'\], true\)[\s\S]*?: normalize_custom_paper_portfolio_id\(\$text\);/,
    "api.php must accept created portfolio ids in paper_strategy_id");
  assert.match(API, /str_starts_with\(\$target, 'paper-'\)[\s\S]*?normalize_custom_paper_portfolio_id\(substr\(\$target, 6\)\)/,
    "api.php must map paper-<created-id> targets onto the shared paper workflow");
  assert.match(API, /paper_strategy_is_known\(\$paperStrategyId\)/,
    "dispatch still verifies the created portfolio exists and is not archived before running it");
  // The reset path accepts a created portfolio's id too, or a created portfolio could
  // never be reset from the dashboard.
  assert.match(BOT, /const PAPER_STRATEGY_ID = \/\^\[a-z\]\[a-zA-Z0-9\]\{1,30\}\$\/\.test/);
});

test("dashboard: the tab row is built from the saved portfolios, archived ones left out", () => {
  const run = new Function("state", `
    ${/const BUILT_IN_PAPER_STRATEGY_IDS = \[[^\]]*\];/.exec(APP)[0]}
    ${/const CUSTOM_PAPER_STRATEGY_ID = [^\n]+/.exec(APP)[0]}
    ${/const LIVE_MODES = new Set\(\[[^\]]*\]\);/.exec(APP)[0]}
    ${extractFunction(APP, "normalizeMode")}
    ${extractFunction(APP, "paperStrategyIdFromMode")}
    ${extractFunction(APP, "defaultPortfolioConfig")}
    ${extractFunction(APP, "paperStrategyIds")}
    ${extractFunction(APP, "overviewPortfolioNumbers")}
    ${extractFunction(APP, "portfolioEquityUsdc")}
    ${extractFunction(APP, "byEquityDescending")}
    // The live group is ordered by whether a portfolio is switched on, then by ROI, so the
    // tab order needs both. Real, not stubbed: the ordering is what these tests measure.
    ${extractFunction(APP, "automationIsEnabled")}
    ${extractFunction(APP, "firstOpenedAtFromTrades")}
    ${extractFunction(APP, "liveInitialCapitalForMode")}
    ${extractFunction(APP, "portfolioRealizedRoiForMode")}
    // Ordering asks each portfolio whether its automation is on, which means the real
    // config merge -- the shipped defaults matter here, since 5050 is the one portfolio
    // that ships switched off.
    ${extractFunction(APP, "customLivePortfolioDefaults")}
    ${extractFunction(APP, "customPaperPortfolioDefaults")}
    ${extractFunction(APP, "normalizePortfolioMarketType")}
    ${extractFunction(APP, "liveConfigKeyForMode")}
    ${extractFunction(APP, "portfolioConfigForMode")}
    ${extractFunction(APP, "byActiveThenRoiDescending")}
    ${extractFunction(APP, "dashboardModes")}
    // A live portfolio can be created now, so "is this mode live" and "is it archived" both
    // have to ask whether a mode names one. The cluster comes across as the real thing --
    // they are pure over state, and stubbing them would only prove the harness agrees with
    // itself about the very classification under test.
    ${extractFunction(APP, "customLivePortfolioIdFromMode")}
    ${extractFunction(APP, "isLivePortfolioMode")}
    ${extractFunction(APP, "isFixedEntryMode")}
    ${extractFunction(APP, "portfolioIsArchived")}
    const DEFAULT_MAX_RESOLUTION_DAYS = 7;
    return { dashboardModes, paperStrategyIds, normalizeMode, portfolioIsArchived };
  `);

  const config = {
    paper: {
      conservative: {}, highReward: {}, moreProbable: {}, equal: { archived: true }, esports: {},
    },
  };
  const api = run({ mode: "paper-conservative", portfolioConfig: config });
  assert.deepEqual(api.dashboardModes(),
    ["live", "live-5050", "paper-conservative", "paper-highReward", "paper-moreProbable", "paper-esports"],
    "live portfolios lead the dashboard, archived portfolios leave it and created ones join it");
  assert.deepEqual(api.paperStrategyIds({ includeArchived: true }),
    ["conservative", "highReward", "moreProbable", "equal", "esports"]);
  assert.equal(api.portfolioIsArchived("paper-equal"), true);
  assert.equal(api.portfolioIsArchived("paper-esports"), false);
  // A created portfolio's mode is real; a stale bookmark to a deleted one is not.
  assert.equal(api.normalizeMode("paper-esports"), "paper-esports");
  assert.equal(api.normalizeMode("paper-deleted"), "paper-conservative");
  assert.equal(api.normalizeMode("live-5050"), "live-5050");
});

test("dashboard: an archived 5050 leaves the tab row too, the plain live portfolio never does", () => {
  const run = new Function("state", `
    ${/const BUILT_IN_PAPER_STRATEGY_IDS = \[[^\]]*\];/.exec(APP)[0]}
    ${/const CUSTOM_PAPER_STRATEGY_ID = [^\n]+/.exec(APP)[0]}
    ${/const LIVE_MODES = new Set\(\[[^\]]*\]\);/.exec(APP)[0]}
    ${extractFunction(APP, "normalizeMode")}
    ${extractFunction(APP, "paperStrategyIdFromMode")}
    ${extractFunction(APP, "defaultPortfolioConfig")}
    ${extractFunction(APP, "paperStrategyIds")}
    ${extractFunction(APP, "overviewPortfolioNumbers")}
    ${extractFunction(APP, "portfolioEquityUsdc")}
    ${extractFunction(APP, "byEquityDescending")}
    // The live group is ordered by whether a portfolio is switched on, then by ROI, so the
    // tab order needs both. Real, not stubbed: the ordering is what these tests measure.
    ${extractFunction(APP, "automationIsEnabled")}
    ${extractFunction(APP, "firstOpenedAtFromTrades")}
    ${extractFunction(APP, "liveInitialCapitalForMode")}
    ${extractFunction(APP, "portfolioRealizedRoiForMode")}
    // Ordering asks each portfolio whether its automation is on, which means the real
    // config merge -- the shipped defaults matter here, since 5050 is the one portfolio
    // that ships switched off.
    ${extractFunction(APP, "customLivePortfolioDefaults")}
    ${extractFunction(APP, "customPaperPortfolioDefaults")}
    ${extractFunction(APP, "normalizePortfolioMarketType")}
    ${extractFunction(APP, "liveConfigKeyForMode")}
    ${extractFunction(APP, "portfolioConfigForMode")}
    ${extractFunction(APP, "byActiveThenRoiDescending")}
    ${extractFunction(APP, "dashboardModes")}
    // A live portfolio can be created now, so "is this mode live" and "is it archived" both
    // have to ask whether a mode names one. The cluster comes across as the real thing --
    // they are pure over state, and stubbing them would only prove the harness agrees with
    // itself about the very classification under test.
    ${extractFunction(APP, "customLivePortfolioIdFromMode")}
    ${extractFunction(APP, "isLivePortfolioMode")}
    ${extractFunction(APP, "isFixedEntryMode")}
    ${extractFunction(APP, "portfolioIsArchived")}
    const DEFAULT_MAX_RESOLUTION_DAYS = 7;
    return { dashboardModes, portfolioIsArchived };
  `);

  const archived5050 = run({ mode: "live", portfolioConfig: { live5050: { archived: true } } });
  assert.equal(archived5050.portfolioIsArchived("live-5050"), true);
  assert.equal(archived5050.portfolioIsArchived("live"), false,
    "archiving 5050 must not also archive the plain live portfolio -- they are different config keys");
  assert.deepEqual(archived5050.dashboardModes(),
    ["live", "paper-conservative", "paper-highReward", "paper-moreProbable", "paper-equal"],
    "an archived 5050 leaves the tab row, the same as an archived paper portfolio would");

  const neither = run({ mode: "live", portfolioConfig: {} });
  assert.equal(neither.portfolioIsArchived("live-5050"), false);
  assert.deepEqual(neither.dashboardModes(),
    ["live", "live-5050", "paper-conservative", "paper-highReward", "paper-moreProbable", "paper-equal"],
    "unarchived, both live tabs still show exactly as before this feature existed");
});

test("dashboard: a created portfolio is not mistaken for the conservative one", () => {
  const run = new Function(`
    ${/const BUILT_IN_PAPER_STRATEGY_IDS = \[[^\]]*\];/.exec(APP)[0]}
    ${/const CUSTOM_PAPER_STRATEGY_ID = [^\n]+/.exec(APP)[0]}
    ${extractFunction(APP, "paperModeFromStrategyId")}
    return paperModeFromStrategyId;
  `)();
  // A portfolio's own id decides which rules panel, run-log title and execution result
  // it gets. A fixed list here answered "conservative" for every created portfolio, so
  // all three described a different portfolio's settings.
  assert.equal(run("esports"), "paper-esports");
  assert.equal(run("equal"), "paper-equal");
  assert.equal(run("highReward"), "paper-highReward");
  assert.equal(run(""), "paper-conservative");
  assert.equal(run("../escape"), "paper-conservative");
});

test("portfolio creation: a live draft is live before it has been saved", () => {
  const run = new Function("state", `
    ${/const BUILT_IN_PAPER_STRATEGY_IDS = \[[^\]]*\];/.exec(APP)[0]}
    ${/const CUSTOM_PAPER_STRATEGY_ID = [^\n]+/.exec(APP)[0]}
    ${/const LIVE_MODES = new Set\(\[[^\]]*\]\);/.exec(APP)[0]}
    ${extractFunction(APP, "normalizePortfolioAccountType")}
    ${extractFunction(APP, "draftedCustomLivePortfolioId")}
    ${extractFunction(APP, "normalizeMode")}
    ${extractFunction(APP, "customLivePortfolioIdFromMode")}
    ${extractFunction(APP, "isLivePortfolioMode")}
    return { normalizeMode, customLivePortfolioIdFromMode, isLivePortfolioMode };
  `);
  const api = run({
    mode: "paper-conservative",
    portfolioConfig: { livePortfolios: {} },
    parameterDraftCreate: "newlive",
    parameterDraftCreateType: "live",
    parameterDraftMode: "live-custom-newlive",
  });
  assert.equal(api.normalizeMode("live-custom-newlive"), "live-custom-newlive");
  assert.equal(api.customLivePortfolioIdFromMode("live-custom-newlive"), "newlive");
  assert.equal(api.isLivePortfolioMode("live-custom-newlive"), true,
    "the create form must reveal live-only controls before the config is saved");
});

test("portfolio creation: the live form keeps validation errors inside the modal", () => {
  assert.match(HTML, /data-parameter-modal-status/,
    "the parameter modal has a visible place for create/save validation feedback");
  assert.match(APP, /function setParameterModalStatus\(text = "", tone = ""\)/,
    "modal feedback is updated independently from the obscured dashboard status");
  const switcher = extractFunction(APP, "switchCreatePortfolioType");
  assert.match(switcher, /els\.portfolioAccountType\.value = normalizePortfolioAccountType\(state\.parameterDraftCreateType\)/,
    "a rejected type change restores the selector instead of leaving it out of sync with the draft");
  const confirm = extractFunction(APP, "confirmParameterModal");
  assert.match(confirm, /requestedCreateType !== normalizePortfolioAccountType\(state\.parameterDraftCreateType\)/,
    "confirmation repairs a stale type selection before collecting form values");
  assert.match(confirm, /setParameterModalStatus\(message, "error"\)/,
    "save errors remain visible in the modal");
  assert.match(confirm, /els\.liveInitialCapital\?\.focus\(\)/,
    "missing live capital focuses the required field");
});

test("storage migration: database diagnostics stay private and require the trigger key", () => {
  assert.match(API, /function trading_storage_diagnostics\(\): array/);
  assert.match(API, /extension_loaded\('pdo_mysql'\)/,
    "the host must explicitly report whether MySQL PDO support exists");
  assert.match(API, /function require_trading_trigger_key\(\): void/,
    "database administration cannot be called from the public UI");
  assert.match(API, /if \(\$action === 'storage-diagnostics'\)[\s\S]*?require_trading_trigger_key\(\)/,
    "the diagnostics endpoint is trigger-key protected");
  const deploy = readFileSync(new URL("../../.github/workflows/trading-deploy.yml", import.meta.url), "utf8");
  for (const secret of ["POLYTRADING_DB_NAME", "POLYTRADING_DB_USER", "POLYTRADING_DB_PASSWORD"]) {
    assert.match(deploy, new RegExp(`secrets\\.${secret}`), `${secret} reaches only the generated server config`);
  }
  assert.match(deploy, /TRADING_DB_HOST: localhost/,
    "the application and MariaDB share the hosting, so the host is not a secret");
  assert.match(STORAGE, /VALUES \(:key, :type, :payload, :checksum, 1, :createdAt, :updatedAt\)/,
    "native MySQL PDO statements must bind distinct timestamps for document inserts");
  assert.match(STORAGE, /:tags, :payload, :checksum, :createdAt, :updatedAt/,
    "native MySQL PDO statements must bind distinct timestamps for observation inserts");
});

test("storage migration: compact schema does not auto-import historical data", () => {
  assert.match(STORAGE, /payload MEDIUMBLOB NOT NULL/,
    "large retained JSON must be compressed before it reaches MySQL");
  assert.match(STORAGE, /function trading_storage_event_compact_payload\(array \$payload\): array/,
    "run-log payloads must be bounded independently from market data");
  assert.match(STORAGE, /function trading_storage_compact_empty_tables\(PDO \$pdo\): array/,
    "oversized empty InnoDB tables must be rebuilt before the first retained import");
  assert.match(STORAGE, /function trading_storage_compression_preview\(PDO \$pdo, int \$sampleLimit = 160\): array/,
    "existing rows need a read-only compression estimate before any rewrite runs");
  assert.match(STORAGE, /trading_storage_pack_encoded\(\$payload\)/,
    "observations must use the compressed payload path");
  const deploy = readFileSync(new URL("../../.github/workflows/trading-deploy.yml", import.meta.url), "utf8");
  const compactStep = /- name: Bootstrap compact Trading MySQL storage[\s\S]*?(?=\n      - name:|$)/.exec(deploy);
  assert.ok(compactStep, "deployment must contain the schema-only storage step");
  assert.doesNotMatch(compactStep[0], /migrate-json/,
    "deploying a compact schema must never import the full JSON history");
  assert.match(compactStep[0], /compact-empty/,
    "the deploy must reclaim empty table allocations before the footprint is checked");
  assert.match(compactStep[0], /compact-preview/,
    "a non-empty database must be measured rather than altered during schema deployment");
  const ingester = readFileSync(new URL("../tools/ingest-trading-state.py", import.meta.url), "utf8");
  assert.match(ingester, /if not env_bool\("TRADING_STORAGE_MIRROR_ENABLED"\)/,
    "workers require an explicit mirror opt-in while capacity is being verified");
  assert.match(API, /\$storageRequest = request_payload\(\);/,
    "each protected storage request must parse its input once before a batch uses its cursor");
  assert.match(API, /trading_storage_compact_payload_batch\(/,
    "existing rows must be compacted in bounded resumable batches rather than reimported");
  assert.match(API, /function trading_storage_import_observation_source_batch\(/,
    "historical observations must be imported in bounded source-file batches");
  assert.match(API, /if \(\$operation === 'migrate-json-batch'\)/,
    "the protected API must expose a resumable backfill operation");
  const maintenance = readFileSync(new URL("../../.github/workflows/trading-storage-compact.yml", import.meta.url), "utf8");
  assert.match(maintenance, /workflow_dispatch:/,
    "existing storage maintenance must require an explicit manual dispatch");
  assert.match(maintenance, /confirm_compaction/,
    "the maintenance workflow must require a confirmation before it writes payloads");
  const backfill = readFileSync(new URL("../../.github/workflows/trading-storage-backfill.yml", import.meta.url), "utf8");
  assert.match(backfill, /confirm_backfill/,
    "historical import must remain an explicit manual action after storage verification");
  assert.match(backfill, /Database reads remain inactive/,
    "a successful import must not silently switch application reads to MySQL");
});

test("dashboard: a created portfolio's settings are its own", () => {
  const run = new Function("state", `
    ${/const BUILT_IN_PAPER_STRATEGY_IDS = \[[^\]]*\];/.exec(APP)[0]}
    ${/const CUSTOM_PAPER_STRATEGY_ID = [^\n]+/.exec(APP)[0]}
    ${/const LIVE_MODES = new Set\(\[[^\]]*\]\);/.exec(APP)[0]}
    ${extractFunction(APP, "normalizeMode")}
    ${extractFunction(APP, "isFixedEntryMode")}
    // A live portfolio can be created now, so reading a mode's config first asks whether
    // the mode names one.
    ${extractFunction(APP, "customLivePortfolioIdFromMode")}
    ${extractFunction(APP, "isLivePortfolioMode")}
    ${extractFunction(APP, "liveConfigKeyForMode")}
    ${extractFunction(APP, "paperStrategyIdFromMode")}
    ${extractFunction(APP, "normalizePortfolioMarketType")}
    ${extractFunction(APP, "defaultPortfolioConfig")}
    ${extractFunction(APP, "customPaperPortfolioDefaults")}
    ${extractFunction(APP, "portfolioConfigForMode")}
    ${extractFunction(APP, "updatePortfolioConfigForMode")}
    const DEFAULT_MAX_RESOLUTION_DAYS = 7;
    return { portfolioConfigForMode, updatePortfolioConfigForMode };
  `);
  const state = { mode: "paper-esports", portfolioConfig: { paper: { esports: { displayName: "Esports 60" } } } };
  const api = run(state);
  // Reading one must not throw for want of shipped defaults, and must not answer with
  // the conservative portfolio's settings -- which is what an unrecognised mode used to
  // fall through to, writing one portfolio's changes into another's.
  assert.equal(api.portfolioConfigForMode("paper-esports").displayName, "Esports 60");
  // The fields it did not set come from the created-portfolio base, not from whichever
  // shipped portfolio happens to be first: Conservative would require 95% probability
  // and its other settings would leak into a custom portfolio.
  assert.equal(api.portfolioConfigForMode("paper-esports").minProbability, 0.5);
  assert.equal(api.portfolioConfigForMode("paper-esports").automationEnabled, true);
  assert.equal(api.portfolioConfigForMode("paper-esports").archived, false);
  api.updatePortfolioConfigForMode("paper-esports", { minProbability: 0.62 });
  assert.equal(api.portfolioConfigForMode("paper-esports").minProbability, 0.62);
  assert.equal(api.portfolioConfigForMode("paper-conservative").minProbability, 0.95,
    "a created portfolio's change must not reach a shipped one");
});

// Reported live: a portfolio created from a statistics row ("55% Multi-outcome 1d") had
// correct settings in the form, but showed Conservative's equity, trades and run log --
// the same family of bug the two tests above already fixed for routing and settings, in
// a third place they did not cover. A portfolio has no entry in the bot's own state until
// it runs once; selectedPaperPortfolio() fell through to portfolios[0], which is whichever
// shipped portfolio happens to be first in the object, not an empty shape of its own.
test("dashboard: a portfolio not yet run does not show another portfolio's trades or equity", () => {
  const run = new Function("paperStrategyIdFromMode", "portfolioConfigForMode", `
    ${extractFunction(APP, "paperPortfolioList")}
    ${extractFunction(APP, "normalizePortfolioName")}
    ${extractFunction(APP, "selectedPaperPortfolio")}
    return selectedPaperPortfolio;
  `);

  const botState = {
    paperPortfolios: {
      conservative: {
        id: "conservative", label: "Conservative",
        portfolio: { equityUsdc: 137.42, initialUsdc: 100 },
        trades: [{ id: "t1" }], runLog: [{ id: "r1" }],
      },
    },
  };
  const configFor = (mode) => (mode === "paper-esports" ? { displayName: "55% Multi-outcome 1d" } : {});

  const fresh = run(() => "esports", configFor)(botState);
  assert.equal(fresh.id, "esports");
  assert.equal(fresh.label, "55% Multi-outcome 1d", "must show its own name, not borrow another portfolio's");
  assert.deepEqual(fresh.portfolio, {}, "must not carry Conservative's equity");
  assert.deepEqual(fresh.trades, [], "no trades until it actually runs");
  assert.deepEqual(fresh.runLog, [], "no run log until it actually runs");

  // An existing portfolio is unaffected and still returns its own real data.
  const existing = run(() => "conservative", configFor)(botState);
  assert.equal(existing.portfolio.equityUsdc, 137.42);
});

test("dashboard: a statistics row prefills the portfolio it would create", () => {
  const run = new Function("HOURS_PER_DAY", "MAX_RESOLUTION_HOURS_CEILING", `
    ${extractFunction(APP, "normalizePortfolioName")}
    // The grid measures in whole days; the portfolio it seeds stores hours, so the
    // converter has to be in scope or the prefill throws on every statistics row.
    ${extractFunction(APP, "normalizeOptionalHours")}
    ${extractFunction(APP, "portfolioPrefillFromDataset")}
    return portfolioPrefillFromDataset;
  `)(24, 365 * 24);

  // A tag row measured one tag at one probability, so the created portfolio trades that.
  assert.deepEqual(run({ prefillName: "league-of-legends", prefillProbability: "0.7", prefillTag: "league-of-legends" }), {
    displayName: "league-of-legends",
    minProbability: 0.7,
    includeOnlyMarketTags: ["league-of-legends"],
  });
  // A parameter row measured a probability, a market type and a resolution ceiling.
  assert.deepEqual(run({ prefillName: "75% Yes/No 3d", prefillProbability: "0.75", prefillDays: "3", prefillMarketType: "binary" }), {
    displayName: "75% Yes/No 3d",
    maxResolutionDays: 3,
    maxResolutionHours: 72,
    minProbability: 0.75,
    marketType: "binary",
    requireMostProbableOutcome: false,
  });
  assert.equal(run({ prefillMarketType: "multi" }).requireMostProbableOutcome, true);
  // Values that cannot be a rule are dropped rather than stored as NaN.
  assert.deepEqual(run({ prefillProbability: "0", prefillDays: "-2", prefillMarketType: "sideways" }), {});
});

test("dashboard: both statistics tables offer to create the portfolio behind a row", () => {
  assert.equal((APP.match(/data-create-portfolio \$\{portfolioPrefillAttributes\(/g) || []).length, 2,
    "tag performance and best combinations each offer it");
  const attributes = new Function(`
    ${extractFunction(APP, "escapeHtml")}
    ${extractFunction(APP, "portfolioPrefillAttributes")}
    return portfolioPrefillAttributes;
  `)();
  // camelCase keys become hyphenated data attributes, or the dataset reader finds
  // nothing and every created portfolio silently starts from a blank form.
  assert.equal(
    attributes({ name: "75% Yes/No", marketType: "binary", probability: 0.75, days: "" }),
    'data-prefill-name="75% Yes/No" data-prefill-market-type="binary" data-prefill-probability="0.75"',
  );
  // The extra column must be counted in both empty-row colspans, or the layout breaks.
  assert.match(APP, /colspan="\$\{hasProbabilityBreakdown \? 12 : 11\}"/);
  assert.match(APP, /colspan="12">No resolved scraped opportunity simulation/);
});

test("portfolio creation: user chooses paper or the connected live account", () => {
  assert.match(HTML, /data-portfolio-account-type/);
  assert.match(HTML, /<option value="paper">Paper<\/option>/);
  assert.match(HTML, /<option value="live">Live<\/option>/);
  assert.match(APP, /function switchCreatePortfolioType\(type\)/,
    "the create dialog can rebuild its draft when the account type changes");
  assert.match(APP, /els\.portfolioAccountType\?\.addEventListener\("change", \(\) => \{\s+switchCreatePortfolioType\(els\.portfolioAccountType\.value\);/,
    "the selector is wired");
  // A live creation used to reconfigure the one connected live portfolio, because there was
  // only ever one. Live portfolios are independent now, so it creates its own entry instead
  // -- and it must land under its own id rather than overwriting a sibling.
  assert.match(APP, /creatingType === "live"[\s\S]*?livePortfolios: \{\s*\n\s*\.\.\.\(base\.livePortfolios \|\| \{\}\),\s*\n\s*\[creating\]: \{[^}]*archived: false, custom: true \},/,
    "saving a live creation must add its own portfolio, not overwrite the shared account");
  // And it must be confirmed by the server before the dashboard claims it exists.
  assert.match(APP, /if \(creating && creatingType === "live" && !state\.portfolioConfig\?\.livePortfolios\?\.\[creating\]\) \{\n\s+throw new Error/,
    "a live creation the server did not persist must not read as created");
  assert.match(APP, /creatingType === "live" \? `live-custom-\$\{creating\}` : `paper-\$\{creating\}`/,
    "after saving, the dashboard opens the portfolio type the user selected");
});

test("archiving: it is confirmed before it happens and restorable afterwards", () => {
  const handler = /const archiveButton = event\.target\.closest\("\[data-parameter-modal-archive\]"\);[\s\S]*?\n  \}/.exec(APP);
  assert.ok(handler, "the archive control is wired");
  // The confirmation must gate the archive, not merely appear near it.
  assert.match(handler[0], /\n    if \(!window\.confirm\([\s\S]*?\)\) \{\n      return;\n    \}/,
    "asked for explicitly: archiving is confirmed first, and declining stops it");
  assert.match(handler[0], /setPortfolioArchived\(strategyId, true\)/);
  assert.match(APP, /data-restore-portfolio/, "and restoring is offered in settings");
  assert.match(APP, /setPortfolioArchived\(restoreButton\.dataset\.restorePortfolio \|\| "", false\)/);
  assert.match(HTML, /data-archived-portfolios/);
  // Archiving the tab you are standing on must move the dashboard somewhere real.
  const setter = extractFunction(APP, "setPortfolioArchived");
  assert.match(setter, /const next = paperStrategyIds\(\)\[0\];/);
});

// Reported live: archiving existed only inside the parameter-edit modal, so it read as
// not existing at all -- the user expected it next to the edit icon and found nothing
// there. A second, direct control now sits beside the pencil icon on the rules card.
test("archiving: a direct control sits next to the edit icon, for paper and 5050", () => {
  const card = extractFunction(APP, "renderPortfolioRulesCard");
  assert.match(card, /archiveStrategyId \? `[\s\S]*?data-portfolio-archive-direct="\$\{escapeHtml\(archiveStrategyId\)\}"[\s\S]*?` : ""/,
    "the button only renders when a strategy id is actually passed in");

  assert.match(APP, /renderPortfolioRulesCard\(portfolioState\.label \|\| "Paper portfolio", portfolioRuleRows\(\{ \.\.\.portfolioState, \.\.\.portfolio \}\), portfolioState\.id\)/,
    "the paper card passes its own strategy id");
  // A created live portfolio can be archived like 5050 can. The one that still cannot is
  // the plain connected live account: archiving it would leave the wallet with no portfolio
  // watching it at all, so it passes null and gets no control.
  assert.match(APP, /renderPortfolioRulesCard\(`\$\{portfolioNameForMode\(\)\} portfolio`, livePortfolioRuleRows\(\), \(isFixedEntryMode\(\) \|\| customLivePortfolioIdFromMode\(\)\) \? state\.mode : null\)/,
    "the live card offers archiving for 5050 and created live portfolios, never for the plain live account");

  const handler = /const directArchiveButton = event\.target\.closest\("\[data-portfolio-archive-direct\]"\);[\s\S]*?\n  \}/.exec(APP);
  assert.ok(handler, "the direct archive control is wired");
  assert.match(handler[0], /if \(!window\.confirm\(confirmMessage\)\) \{\n      return;\n    \}/,
    "the same confirmation gates it as the modal's own archive button");
  assert.match(handler[0], /setPortfolioArchived\(strategyId, true\)/);
  // The live5050 branch must resolve its own saved config, not a paper portfolio's --
  // the two are keyed differently, and this exact mismatch was live in one draft of
  // this fix (portfolioConfigForMode(`paper-${strategyId}`) for a strategyId that was
  // never a paper id at all).
  // Generalised from 5050 to any live portfolio when live portfolios became independent.
  // The mismatch this guards against is unchanged: a live id must resolve its own saved
  // config, never be prefixed into a paper one that does not exist.
  assert.match(handler[0], /portfolioConfigForMode\(isLiveStrategy \? strategyId : `paper-\$\{strategyId\}`\)/);
});

test("dashboard: the tab row survives being rebuilt", () => {
  // Portfolios are created, renamed, archived and restored, so handlers bound to the
  // buttons themselves would stop working after the first of those.
  assert.match(APP, /const button = event\.target\.closest\("\[data-mode-toggle\]"\);/,
    "mode switching must be delegated");
  assert.ok(!/els\.modeButtons\.forEach\(\(button\) => \{\s*\n\s*button\.addEventListener/.test(APP),
    "no handler may be bound to a button that gets replaced");
  assert.match(APP, /els\.modeButtons = els\.modeSwitch\.querySelectorAll\("\[data-mode-toggle\]"\);/);
});

// Reported live: after renaming Equal to Stop loss, the tab and the page title both
// correctly read "Stop loss" (they already went through portfolioNameForMode), but the
// run-once button's busy label, the execution-progress modal, and the corner
// workflow-status toast still said "Equal" or the raw "paper-equal" target -- they read
// paperModeLabel/the target string directly, which only ever knows the shipped name.
test("portfolio rename propagates to execution status text, not only the tab and title", () => {
  assert.match(APP,
    /if \(isPaperExecutionTarget\(target\)\) return portfolioNameForMode\(target === "paper" \? state\.mode : target\);/,
    "executionTargetLabel must read the current configured name");
  assert.ok(!/paperModeLabel\(target === "paper" \? state\.mode : target\)/.test(APP),
    "it must not fall back to the shipped-only name");
  assert.match(APP, /setExecutionStatus\(`\$\{executionTargetLabel\(target\)\} workflow started`\);/);
  assert.match(APP, /setExecutionStatus\(`\$\{executionTargetLabel\(target\)\} workflow \$\{workflow\.run\.conclusion\}`, "error"\);/);
  assert.match(APP, /setExecutionStatus\(`\$\{executionTargetLabel\(target\)\} workflow completed`\);/);
  // Which branch of the ternary it sits in is an implementation detail; what matters is
  // that the detail line resolves the name through the configured portfolio.
  assert.match(APP, /`Paper \$\{portfolioNameForMode\(paperModeFromStrategyId\(options\.paperStrategyId\)\)\} action:/,
    "the execution-result step must also name the current portfolio, not its shipped label");
});

test("portfolio overview: the Risk / reward tile is gone from the tile row and the code", () => {
  assert.ok(!/Risk \/ reward/.test(HTML), "the tile's label must be gone from the markup");
  assert.ok(!/data-portfolio-rr/.test(HTML), "and its two data attributes with it");
  assert.ok(!/portfolioRr\b|portfolioRrNote\b|averageRiskReward\(/.test(APP),
    "no dead lookup, renderer, or now-unused helper may be left behind");
});

// Asked for: the control panel tile held nothing but the one manual-run button, so it was
// removed and that button (with the status text next to it) moved into the run log's own
// header, which already had a header-actions row for exactly this kind of control.
test("run log: the manual-run button lives in its header, not a separate control panel", () => {
  assert.ok(!/class="control-panel"/.test(HTML), "the tile is gone");
  assert.ok(!/Control panel|Execution controls/.test(HTML), "and its chrome with it");
  const runLogPanel = /<section class="tab-panel" data-tab-panel="run-log"[\s\S]*?<\/section>/.exec(HTML);
  assert.ok(runLogPanel, "the run log panel exists");
  assert.match(runLogPanel[0], /<div class="run-log-head-actions">\s*<button class="execution-button" type="button" data-one-time-execution="current">Run once<\/button>\s*<span class="pill muted" data-execution-status>ready<\/span>/,
    "the button and its status pill must be the header-actions row's first two children");
});

// Reported at least three times: the run log only ever shows a portfolio's newest ~24
// runs (PORTFOLIO_RUN_LOG_LIMIT) and there was no way to see anything older. The live
// state cannot hold the whole history, so the bot now appends every run to a per-portfolio,
// per-month ndjson archive on the hosting, and the dashboard pages back through it.
test("run log history: one portfolio's page never returns another's rows, oldest last", () => {
  const paperState = {
    generatedAt: "2026-08-18T00:00:00Z",
    paperPortfolios: {
      moreProbable: {
        id: "moreProbable",
        // The live cap still carries this run -- it is also the newest archived one,
        // so the merge by runAt must not show it twice.
        runLog: [{ runAt: "2026-08-10T00:00:00Z", strategyId: "moreProbable", action: "OPEN" }],
      },
      conservative: { id: "conservative", runLog: [] },
    },
  };
  const archives = {
    "portfolio-run-log/moreProbable/2026-08.ndjson": [
      { runAt: "2026-08-10T00:00:00Z", strategyId: "moreProbable", action: "OPEN" },
      { runAt: "2026-08-05T00:00:00Z", strategyId: "moreProbable", action: "SKIP" },
    ],
    "portfolio-run-log/moreProbable/2026-07.ndjson": [
      { runAt: "2026-07-20T00:00:00Z", strategyId: "moreProbable", action: "SKIP" },
    ],
    // A different portfolio's own archive, present at the same time -- must never leak
    // into moreProbable's page even though both live under portfolio-run-log/.
    "portfolio-run-log/conservative/2026-08.ndjson": [
      { runAt: "2026-08-09T00:00:00Z", strategyId: "conservative", action: "OPEN" },
    ],
  };

  withPortfolioRunLogApi(paperState, archives, (directory) => {
    const first = callPortfolioRunLogApi(directory, { action: "portfolio-run-log", strategy_id: "moreProbable", page: 0, page_size: 2 });
    assert.equal(first.ok, true);
    assert.equal(first.total, 3, "the overlapping runAt is de-duplicated, not double-counted");
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.records.map((r) => r.runAt),
      ["2026-08-10T00:00:00Z", "2026-08-05T00:00:00Z"], "newest first");

    const second = callPortfolioRunLogApi(directory, { action: "portfolio-run-log", strategy_id: "moreProbable", page: 1, page_size: 2 });
    assert.equal(second.hasMore, false);
    assert.deepEqual(second.records.map((r) => r.runAt), ["2026-07-20T00:00:00Z"]);
    assert.ok(second.records.every((r) => r.strategyId === "moreProbable"),
      "conservative's archived row must never appear on moreProbable's page");

    const empty = callPortfolioRunLogApi(directory, { action: "portfolio-run-log", strategy_id: "equal", page: 0 });
    assert.equal(empty.total, 0, "a portfolio with no archive at all just has an empty history, not an error");
  });
});

test("run log history: a missing or malformed strategy_id is rejected, not silently defaulted", () => {
  const paperState = { generatedAt: "2026-08-18T00:00:00Z", paperPortfolios: {} };
  withPortfolioRunLogApi(paperState, {}, (directory) => {
    for (const strategyId of [undefined, "", "../escape", "has spaces"]) {
      const query = { action: "portfolio-run-log", page: 0 };
      if (strategyId !== undefined) query.strategy_id = strategyId;
      const response = callPortfolioRunLogApi(directory, query);
      assert.equal(response.ok, false, `strategy_id ${JSON.stringify(strategyId)} must be refused`);
    }
  });
});

// The client-side half: once "load more" has paged in older history, a run that finishes
// afterwards must still appear without another click, and the same run must never be
// counted twice just because it exists in both the live cap and the loaded archive page.
test("run log history: the dashboard merges loaded history with the live cap, never duplicating", () => {
  const run = new Function("state", `
    ${/const BUILT_IN_PAPER_STRATEGY_IDS = \[[^\]]*\];/.exec(APP)[0]}
    ${/const CUSTOM_PAPER_STRATEGY_ID = [^\n]+/.exec(APP)[0]}
    ${/const LIVE_MODES = new Set\(\[[^\]]*\]\);/.exec(APP)[0]}
    // isLiveMode delegates to the classification now that a live portfolio can be created,
    // so its helpers come across with it.
    ${extractFunction(APP, "normalizeMode")}
    ${extractFunction(APP, "customLivePortfolioIdFromMode")}
    ${extractFunction(APP, "isLivePortfolioMode")}
    ${extractFunction(APP, "isLiveMode")}
    ${extractFunction(APP, "paperStrategyIdFromMode")}
    ${extractFunction(APP, "selectedPaperPortfolio")}
    ${extractFunction(APP, "paperPortfolioList")}
    ${extractFunction(APP, "normalizePortfolioName")}
    ${extractFunction(APP, "portfolioRunLogHistoryState")}
    ${extractFunction(APP, "isCadenceWaitRun")}
    ${extractFunction(APP, "runLogTimestamp")}
    ${extractFunction(APP, "sortRunLogRows")}
    function withRunningExecutionRow(rows) { return rows; }
    ${extractFunction(APP, "currentPortfolioRunLog")}
    return currentPortfolioRunLog;
  `);

  const state = {
    mode: "paper-moreProbable",
    portfolioRunLogHistory: {
      moreProbable: {
        records: [
          { runAt: "2026-08-10T00:00:00Z", action: "OPEN" },
          { runAt: "2026-08-05T00:00:00Z", action: "SKIP" },
        ],
        page: 0, total: 2, hasMore: false, busy: false, error: "",
      },
    },
    botState: {
      paperPortfolios: {
        moreProbable: {
          id: "moreProbable",
          // A newer run landed after the history page loaded.
          runLog: [
            { runAt: "2026-08-12T00:00:00Z", action: "OPEN" },
            { runAt: "2026-08-10T00:00:00Z", action: "OPEN" },
          ],
        },
      },
    },
  };

  const rows = run(state)();
  assert.deepEqual(rows.map((r) => r.runAt), [
    "2026-08-12T00:00:00Z", "2026-08-10T00:00:00Z", "2026-08-05T00:00:00Z",
  ], "the fresh run leads, the overlap appears once, older history still follows");
});

test("capital rebase: the accuracy note names pre-reset trades separately from early exits", () => {
  const els = { portfolioAccuracy: { textContent: "", className: "" }, portfolioAccuracyNote: { textContent: "" } };
  const run = new Function("els", "probability", "pnlClass", `
    ${extractFunction(APP, "isClosedTrade")}
    ${extractFunction(APP, "closedTradePredictionResult")}
    ${extractFunction(APP, "closedAccuracyStats")}
    ${extractFunction(APP, "renderClosedAccuracy")}
    return renderClosedAccuracy;
  `)(els, (value) => String(value), () => "");

  // One resolved trade behind the (fake) cutoff, one early exit (no final price yet).
  run([
    { status: "WON" },
    { status: "SOLD", finalOutcomePrice: null },
  ], 3);
  assert.equal(els.portfolioAccuracyNote.textContent, "1 / 1 resolved · 1 early exits excluded · 3 pre-reset trades excluded",
    "both exclusion reasons must be named, and neither hides the other");

  run([{ status: "WON" }], 0);
  assert.equal(els.portfolioAccuracyNote.textContent, "1 / 1 resolved",
    "an unrebased portfolio's note must read exactly as it did before this feature existed");
});

test("limit orders: an unfilled expiry is excluded from accuracy, a still-waiting order is not counted at all", () => {
  const els = { portfolioAccuracy: { textContent: "", className: "" }, portfolioAccuracyNote: { textContent: "" } };
  const run = new Function("els", "probability", "pnlClass", `
    ${extractFunction(APP, "isClosedTrade")}
    ${extractFunction(APP, "closedTradePredictionResult")}
    ${extractFunction(APP, "closedAccuracyStats")}
    ${extractFunction(APP, "renderClosedAccuracy")}
    return renderClosedAccuracy;
  `)(els, (value) => String(value), () => "");

  // Nothing was ever bought on the expired one, so it is neither a win nor a loss --
  // excluded, the same bucket a same-day sale with no settlement price yet lands in.
  // The still-resting one belongs on the open-positions table, not this closed count.
  run([
    { status: "WON" },
    { status: "LIMIT_ORDER_EXPIRED" },
    { status: "LIMIT_ORDER_WAITING" },
  ], 0);
  assert.equal(els.portfolioAccuracyNote.textContent, "1 / 1 resolved · 1 early exits excluded",
    "the expired order is excluded, and the still-waiting one is not in this count at all");
});

test("opened trades: positions are the default, with resting orders opt-in", () => {
  const rowsForDisplay = new Function("state", `
    ${extractFunction(APP, "isOpenOrderTrade")}
    ${extractFunction(APP, "openedTradesForDisplay")}
    return openedTradesForDisplay;
  `)({ showOpenOrders: false });
  const withOpenOrders = new Function("state", `
    ${extractFunction(APP, "isOpenOrderTrade")}
    ${extractFunction(APP, "openedTradesForDisplay")}
    return openedTradesForDisplay;
  `)({ showOpenOrders: true });
  const rows = [
    { id: "position", status: "OPEN" },
    { id: "paper-order", status: "LIMIT_ORDER_WAITING" },
    { id: "live-order", mode: "LIVE_ORDER", status: "LIMIT ORDER" },
  ];
  assert.deepEqual(rowsForDisplay(rows).map((row) => row.id), ["position"]);
  assert.deepEqual(withOpenOrders(rows).map((row) => row.id), ["position", "paper-order", "live-order"]);
  assert.match(HTML, /data-show-open-orders/, "the opened-trades header needs the opt-in checkbox");
  assert.match(APP, /openedTradesForDisplay\(openTrades\)/, "paper opened rows must use the filter");
  assert.match(APP, /openedTradesForDisplay\(openedRows\)/, "live opened rows must use the filter");
});

// Reported: a "queued"/"running" (manual) row appeared in 90->50%'s run log for a run the
// user never started, then vanished on its own once it finished. dispatch-after-scan.mjs
// chains a run onto a finished scrape as a real workflow_dispatch event -- indistinguishable
// from a person's own click by event type alone -- but always as github-actions[bot].
// Reported both ways round: a run the user had just started showed AUTO, and a run they
// had not started showed MANUAL. The row inferred "manual" from the GitHub event plus the
// triggering account, and those cannot separate a dashboard click from any other API
// dispatch -- every run on this repository is triggered by the owner's own account,
// scheduled ones included. So the label now comes from what this browser recorded when it
// dispatched, and where that says nothing, neither does the row.
test("live run in progress: the source is what this browser started, never a guess", () => {
  const build = (dispatchedHere) => new Function("state", "executionRunWasDispatchedHere", `
    ${/const BUILT_IN_PAPER_STRATEGY_IDS = \[[^\]]*\];/.exec(APP)[0]}
    ${/const CUSTOM_PAPER_STRATEGY_ID = [^\n]+/.exec(APP)[0]}
    ${/const LIVE_MODES = new Set\(\[[^\]]*\]\);/.exec(APP)[0]}
    ${extractFunction(APP, "normalizeMode")}
    // The classification cluster: a live portfolio can be created, so "which target is this
    // mode" and "is that a paper target" are no longer answerable from two fixed ids.
    ${extractFunction(APP, "customLivePortfolioIdFromMode")}
    ${extractFunction(APP, "isLivePortfolioMode")}
    ${extractFunction(APP, "isPaperExecutionTarget")}
    ${extractFunction(APP, "isLiveMode")}
    ${extractFunction(APP, "isFixedEntryMode")}
    ${extractFunction(APP, "currentExecutionTarget")}
    ${extractFunction(APP, "runningExecutionRun")}
    function formatDuration() { return ""; }
    ${extractFunction(APP, "runningExecutionRow")}
    return runningExecutionRow;
  `)({
    mode: "live-5050",
    runningExecutions: {
      "live-5050": {
        id: 1,
        status: "in_progress",
        createdAt: new Date().toISOString(),
        event: "workflow_dispatch",
        triggeringActor: "kubiczech808",
      },
    },
  }, () => dispatchedHere);

  assert.equal(build(true)().runSource, "MANUAL", "a run this dashboard started reads as manual");
  // A dispatch from somewhere else used to be shown as a row with source UNKNOWN. It is now
  // not shown at all, which is the stronger form of the same rule: the synthetic row exists
  // only to cover the gap before this browser's own run publishes its record, and a run
  // this browser did not start will publish its own with its real source. Guessing at a
  // row for it could only ever mislabel it.
  assert.equal(build(false)(), null,
    "a dispatch from somewhere else gets no invented row, not one labelled unknown");

  // A scheduled run gets no synthetic row either, and that is the same rule rather than an
  // exception to it. This row exists only to cover the gap before a run this browser
  // started publishes its own record; a scheduled run is written into the log by the worker
  // with its real portfolio and its real source, and inferring one from a shared GitHub
  // workflow status could only attach it to the wrong portfolio.
  const scheduled = new Function("state", "executionRunWasDispatchedHere", `
    ${/const BUILT_IN_PAPER_STRATEGY_IDS = \[[^\]]*\];/.exec(APP)[0]}
    ${/const CUSTOM_PAPER_STRATEGY_ID = [^\n]+/.exec(APP)[0]}
    ${/const LIVE_MODES = new Set\(\[[^\]]*\]\);/.exec(APP)[0]}
    ${extractFunction(APP, "normalizeMode")}
    ${extractFunction(APP, "customLivePortfolioIdFromMode")}
    ${extractFunction(APP, "isLivePortfolioMode")}
    ${extractFunction(APP, "isPaperExecutionTarget")}
    ${extractFunction(APP, "isLiveMode")}
    ${extractFunction(APP, "isFixedEntryMode")}
    ${extractFunction(APP, "currentExecutionTarget")}
    ${extractFunction(APP, "runningExecutionRun")}
    function formatDuration() { return ""; }
    ${extractFunction(APP, "runningExecutionRow")}
    return runningExecutionRow;
  `)({
    mode: "live-5050",
    runningExecutions: {
      "live-5050": { id: 2, status: "in_progress", createdAt: new Date().toISOString(), event: "schedule", triggeringActor: "kubiczech808" },
    },
  }, () => false);
  assert.equal(scheduled(), null, "a scheduled run is logged by its worker, never guessed at here");

  // The one synthetic row there is says MANUAL, because that is the only thing it is for.
  assert.match(extractFunction(APP, "runningExecutionRow"), /runSource: "MANUAL",/);

  // And an unknown source renders as a dash, not as AUTO -- that is the whole point.
  const label = new Function(`${extractFunction(APP, "portfolioRunSource")}\nreturn portfolioRunSource;`)();
  assert.equal(label({ runSource: "UNKNOWN" }), "\u2013");
  assert.equal(label({ runSource: "MANUAL" }), "MANUAL");
  assert.equal(label({ runSource: "AUTO" }), "AUTO");
  assert.equal(label({}), "AUTO", "a stored row with no source stays automatic");
});

// Reported: paper portfolios' parameter overview never showed "use limit orders" at all,
// reading as if the setting only existed for live. The checkbox already saves it for paper
// (no data-model gap -- see the live mirror at index.html:429-432, unconditional), only
// this card's row was missing.
test("paper portfolio rules: 'Order mode' is shown, mirroring the live card", () => {
  const paper = extractFunction(APP, "portfolioRuleRows");
  assert.match(paper, /rows\.push\(\["Order mode", config\.useLimitOrders \? "Limit orders" : "Market orders"\]\);/);
  // The live card's own row must still exist, and it now reads the same saved setting the
  // paper card does rather than the checkbox's current position.
  const live = extractFunction(APP, "livePortfolioRuleRows");
  assert.match(live, /const useLimitOrders = config\.useLimitOrders === true;/);
  assert.match(live, /\["Order mode", useLimitOrders \? "Limit orders" : "Market orders"\],/);
});

// Reported missing later, alongside the day-cap logic it describes
// (strategyEligibleCandidates/portfolioFilterResult/prefilterLiveCandidate): both cards
// dropped their "Resolution filter" row when resolution dates stopped deciding whether a
// market had ended. The two questions are independent -- this row states a portfolio's
// configured ceiling, not the market's live status -- so the row belongs on both cards
// regardless of that change.
test("portfolio rules: the resolution ceiling is shown on both the paper and live cards", () => {
  const paper = extractFunction(APP, "portfolioRuleRows");
  assert.match(paper, /const maxResolutionHours = resolutionHoursForMode\(mode\);/);
  assert.match(paper, /\["Resolution filter", resolution\],/);
  assert.match(paper, /const resolution = resolutionRuleValue\(maxResolutionHours, config\);/);
  // The ceiling is stored in hours, so a 6-hour one has to reach the card as six hours.
  // Rendering it back through whole days would round it to "1 d" -- the exact loss of
  // precision the unit switch was made to end. And the card has to say what the portfolio
  // does about fixtures already under way, since that changes what the ceiling means.
  const rule = new Function("formatHorizonHours", "configLiveEventMode", `
    ${extractFunction(APP, "resolutionRuleValue")}
    return resolutionRuleValue;
  `)((hours) => `${hours} h`, (config) => config?.liveEventMode || "ignore");
  assert.equal(rule(6, {}), "Max 6 h");
  assert.equal(rule(6, { liveEventMode: "include" }), "Max 6 h, events under way always included");
  // No ceiling is stated under "only", because none is applied: that mode admits nothing
  // by its horizon, and the parameter form hides the input for the same reason.
  assert.equal(rule(6, { liveEventMode: "only" }), "Only events under way");

  const live = extractFunction(APP, "livePortfolioRuleRows");
  assert.match(live, /const maxResolutionHours = resolutionHoursForMode\(mode\);/);
  assert.match(live, /\["Resolution filter", resolutionRuleValue\(maxResolutionHours, config\)\]/);
});

// The read-only summary row above states the current value; this is the form that
// actually changes it. Reported still missing after the row came back: the same commit
// deleted the <input> from index.html itself, so app.js kept querying
// [data-max-resolution-days] and silently found nothing -- neither an error nor a
// visible gap, just a setting nobody could edit any more.
test("portfolio parameters form: the resolution ceiling has an editable input, not just a summary row", () => {
  assert.match(HTML, /<span>Max resolution hours<\/span>\s*\n\s*<input type="number" min="1" max="8760" step="1" placeholder="auto" data-max-resolution-hours>\s*\n\s*<strong data-max-resolution-hours-label>auto<\/strong>/,
    "the parameter form must have an input for this setting, not only the summary card's display");
  assert.match(APP, /maxResolutionHours: document\.querySelector\("\[data-max-resolution-hours\]"\)/);
  assert.match(APP, /maxResolutionHoursLabel: document\.querySelector\("\[data-max-resolution-hours-label\]"\)/);
  assert.match(APP, /els\.maxResolutionHours\?\.addEventListener\("input", \(\) => \{/,
    "changing the input has to save it, the same as every other parameter control");
  assert.match(APP, /updatePortfolioConfigForMode\(state\.mode, \{ maxResolutionHours: value, maxResolutionDays: days \}\);/);
});

// Hours and days are not one question asked in two units: a horizon of zero hours is a
// market that has ALREADY resolved, not one that is under way. Wanting only running
// fixtures is a different question, so it gets its own switch rather than overloading
// zero -- and that switch has to be a control the user can actually reach.
test("portfolio parameters form: events under way are their own setting, not a horizon of zero", () => {
  // Three states, not a checkbox: judging a running fixture by the ceiling, admitting it
  // regardless, and taking nothing else are three different rules.
  // The type of filter is chosen first, then the number it needs -- and under "only" the
  // number needs nothing, so the input below it is hidden.
  assert.match(HTML, /<span>Resolution filter<\/span>\s*\n\s*<select data-live-event-mode>/,
    "the parameter form must carry the in-play setting as its own control");
  assert.ok(HTML.indexOf("data-live-event-mode") < HTML.indexOf("data-max-resolution-hours"),
    "the choice comes before the hours it governs");
  for (const mode of ["ignore", "include", "only"]) {
    assert.match(HTML, new RegExp(`<option value="${mode}">`), `${mode} must be selectable`);
  }
  assert.match(APP, /liveEventMode: document\.querySelector\("\[data-live-event-mode\]"\)/);
  assert.match(APP, /els\.liveEventMode\?\.addEventListener\("change", \(\) => \{/);
  assert.match(APP, /const updates = \{ liveEventMode: value, requireEventStarted: value === "only" \};/,
    "the older boolean travels alongside for a reader that has not migrated");

  // Zero must not be a back door into the same behavior: it means "not set" everywhere.
  const normalize = extractFunction(APP, "normalizeOptionalHours");
  assert.match(normalize, /numeric <= 0\) return null;/);

  // Every runtime has to refuse an un-started row separately from an over-horizon one, or
  // the setting is a label with nothing behind it -- and "include" has to let a running
  // fixture past the ceiling, which is the state this was reopened for.
  assert.match(BOT, /liveEventMode === "only" && !eventIsRunning/);
  assert.match(BOT, /horizonApplies\(liveEventMode, eventIsRunning\) && hours > maxResolutionHours/);
  assert.match(API, /\$liveEventMode === 'only' && !\$running/);
  assert.match(API, /\$horizonApplies = \$liveEventMode !== 'only' && !\(\$liveEventMode === 'include' && \$running\)/);

  // Hiding the input is only honest if the ceiling really stops applying. A hidden number
  // that still filters is worse than a visible one, so every runtime states the same rule.
  assert.match(HTML, /data-max-resolution-hours-row/);
  assert.match(APP, /els\.maxResolutionHoursRow\.hidden = liveEventMode === "only"/);
  const applies = new Function(`${extractFunction(APP, "horizonApplies")}\nreturn horizonApplies;`)();
  assert.equal(applies("ignore", false), true);
  assert.equal(applies("ignore", true), true, "ignore caps a running fixture like anything else");
  assert.equal(applies("include", true), false, "include exempts the running fixture");
  assert.equal(applies("include", false), true, "and caps everything that has not started");
  assert.equal(applies("only", true), false);
  assert.equal(applies("only", false), false, "under only there is no ceiling at all");

  // A portfolio saved while this was a checkbox meant exactly the "only" state, in every
  // runtime that has to read it back.
  assert.match(APP, /return config\?\.requireEventStarted === true \? "only" : "ignore";/);
  assert.match(BOT, /return row\?\.requireEventStarted === true \? "only" : "ignore";/);
  assert.match(API, /return \(\$row\['requireEventStarted'\] \?\? false\) === true \? 'only' : 'ignore';/);
});

test("run log history: the workflow archives every portfolio's new runs, and the bot writes them", () => {
  assert.match(BOT, /const PORTFOLIO_RUN_LOG_ENTRY_PATH = process\.env\.PAPER_PORTFOLIO_RUN_LOG_ENTRY_PATH/);
  assert.match(BOT, /async function writePortfolioRunLogEntries\(entries\)/);
  assert.match(BOT, /const newRunLogEntries = recordRun\(state, \{ evaluations, eligible, decisions \}\);/);
  // recordRun must hand back what it just wrote to each portfolio's own runLog, or the
  // workflow step has nothing to archive.
  assert.match(BOT, /newRunLogEntries\.push\(recordPortfolioRun\(state, portfolioState, \{ evaluations, eligible, decision \}\)\);/);
  assert.match(BOT, /return newRunLogEntries;/);

  assert.match(WORKFLOW, /Append portfolio run-log history entries/);
  assert.match(WORKFLOW, /PAPER_PORTFOLIO_RUN_LOG_ENTRY_PATH: trading\/data\/portfolio-run-log-entry\.ndjson/);
  // Routed per portfolio, per month -- not one shared file every portfolio would collide in.
  assert.match(WORKFLOW, /"portfolio-run-log"\]/);
  assert.match(WORKFLOW, /enter_dir\(ftp, base \+ \[strategy_id\]\)/);

  assert.match(API, /function portfolio_run_log_records\(string \$strategyId, array \$fallback = \[\]\): array/);
  assert.match(API, /if \(\$action === 'portfolio-run-log'\)/);

  assert.match(APP, /data-run-log-load-more/);
  assert.match(APP, /loadPortfolioRunLogHistory\(strategyId\);/);
});

test("run log history: a Unicode line-boundary character inside a record does not corrupt the archive", () => {
  // Reported live: the workflow's "Append portfolio run-log history entries" step crashed
  // with json.decoder.JSONDecodeError: Unterminated string. splitlines() treats far more
  // than "\n" as a line break -- U+2028/U+2029 among them -- and JSON.stringify (the bot's
  // own writer) does not escape those, so a single valid JSON line containing one in a
  // question or an AI-generated rejection reason was silently cut in half before
  // json.loads ever saw either fragment. Only "\n" is a real line boundary here; it is the
  // exact byte the writer joins entries with.
  const source = /entry = Path\(os\.environ\["PAPER_PORTFOLIO_RUN_LOG_ENTRY_PATH"\]\)[\s\S]*?groups\[\(strategy_id, month\)\]\.append\(line\)/
    .exec(WORKFLOW);
  assert.ok(source, "the parsing block must be findable in the workflow");
  assert.ok(!/\.splitlines\(\)/.test(source[0]),
    "splitlines() must not return here -- U+2028/U+2029 inside a record silently truncate it");
  // The match starts mid-line (right at "entry"), so its own first line carries no
  // leading whitespace to measure -- the next line, a complete one, is what the whole
  // block's base indentation has to be read from.
  const scriptLines = source[0].split("\n");
  const indent = scriptLines[1].match(/^ +/)?.[0] || "";
  const script = scriptLines.map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line)).join("\n");

  const directory = mkdtempSync(join(tmpdir(), "portfolio-run-log-entry-"));
  try {
    const entryPath = join(directory, "portfolio-run-log-entry.ndjson");
    // A real shape: one clean record, one whose note carries an embedded U+2028 the way a
    // scraped question or an AI-generated reason could.
    const lines = [
      { strategyId: "moreProbable", runAt: "2026-08-18T09:00:00Z", note: "clean" },
      { strategyId: "equal", runAt: "2026-08-18T09:05:00Z", note: "line one line two" },
    ].map((entry) => JSON.stringify(entry));
    writeFileSync(entryPath, `${lines.join("\n")}\n`, "utf8");

    const output = execFileSync("python3", ["-c", `
import json, os, re
from collections import defaultdict
from pathlib import Path
os.environ["PAPER_PORTFOLIO_RUN_LOG_ENTRY_PATH"] = ${JSON.stringify(entryPath)}
${script}
print(json.dumps({f"{k[0]}|{k[1]}": v for k, v in groups.items()}))
`], { encoding: "utf8" });

    const groups = JSON.parse(output);
    assert.deepEqual(Object.keys(groups).sort(), ["equal|2026-08", "moreProbable|2026-08"],
      "both records must survive as their own group, the embedded separator included");
    const recovered = JSON.parse(groups["equal|2026-08"][0]);
    assert.equal(recovered.note, "line one line two",
      "the embedded U+2028 must round-trip intact, not truncate the record");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Reported live: between the mobile breakpoint and a full-width desktop, the tab row had
// nowhere to shrink to, so the whole page overflowed sideways and the overflow was clipped
// by body's overflow-x: hidden -- Stop loss, Live and 90 -> 50% did not wrap to a second
// row, they simply vanished, unreachable by any scroll. The row must scroll sideways on
// every width, not only below 680px, so these rules live outside any media query.
test("dashboard: the portfolio tabs stay on one row and scroll sideways on every screen width", () => {
  // Matched against the whole file rather than a slice before it: an unrelated @media
  // (min-width: 1181px) block sits even earlier in the file, so cutting the file at the
  // first @media would drop these rules entirely. exec() without the g flag returns the
  // first match in document order, and the unconditional rule is the first of each
  // selector in the file -- the mobile-scoped, indented copy comes later.
  const modeSwitch = /\.mode-switch \{[^}]*\}/.exec(CSS);
  assert.ok(modeSwitch, "the tab row is styled unconditionally, not only inside a media query");
  assert.match(modeSwitch[0], /flex-wrap: nowrap;/);
  assert.match(modeSwitch[0], /overflow-x: auto;/);
  assert.ok(!/grid-template-columns/.test(modeSwitch[0]), "it must not wrap into rows again");
  // A flex item's default min-width is auto (never shrink below content), so without this
  // on both the row and its parent, .mode-switch is held to its full content width and the
  // page overflows instead of the row scrolling internally.
  assert.match(modeSwitch[0], /min-width: 0;/);
  assert.match(modeSwitch[0], /flex: 1 1 0%;/, "sized from available space, not from its own content, or it cannot shrink smaller than its tabs");
  const portfolioActions = /\.portfolio-actions \{[^}]*\}/.exec(CSS);
  assert.ok(portfolioActions, "the row's parent exists");
  assert.match(portfolioActions[0], /min-width: 0;/,
    "the parent must also be allowed to shrink, or it holds the row to its content width regardless");
  const modeButton = /\.mode-button \{[^}]*\}/.exec(CSS);
  assert.ok(modeButton, "the tab button is styled unconditionally");
  assert.match(modeButton[0], /flex: 0 0 auto;/, "tabs keep their size rather than being squeezed");
  assert.match(modeButton[0], /white-space: nowrap;/);
  // A more specific selector further down the file silently overrode exactly these two
  // properties for every button actually inside the row (flex: 1 1 auto + white-space:
  // normal), which is how tab text ended up wrapping inside the tabs themselves even
  // though the plain .mode-button rule already said the opposite.
  assert.ok(!/\.mode-switch \.mode-button \{/.test(CSS),
    "no later, more specific rule may re-enable squeezing or text wrap for the row's own buttons");
});

test("dashboard: the overview above the selector states equity and risk against free", () => {
  assert.match(HTML, /data-portfolio-overview/);
  const overview = extractFunction(APP, "renderPortfolioOverview");
  // Requested: show separately how much is in orders and how much in open positions. One
  // "risk" figure could not say whether a portfolio was invested or only queueing, so the
  // total is split into the two commitments it was hiding.
  // The split is what this pins; the ROI p.a. column that later joined the row between
  // Equity and the two commitments is free to sit there.
  assert.match(overview, /<th>Portfolio<\/th><th>Equity<\/th>(?:<th[^>]*>[^<]*<\/th>)*?<th[^>]*>In positions<\/th><th[^>]*>In orders<\/th><th>Free<\/th>/);
  assert.match(overview, /equity: portfolio \? Number\(portfolio\.equityUsdc\) : null/);
  assert.match(overview, /portfolio\.positionRiskUsdc/);
  assert.match(overview, /orders: portfolio \? Number\(portfolio\.restingLimitOrderUsdc \|\| 0\) : null/);
  assert.match(overview, /free: portfolio \? Number\(portfolio\.freeCapitalUsdc\) : null/);
  // Reported: the table merged several portfolios into one row. They are separate
  // portfolios with separate rules and separate decisions, and the merged row was not a
  // portfolio at all -- it could not be opened as one. What the live portfolios really
  // share is the account capital, so each keeps its own row under its own name and the
  // sharing is stated on the row rather than hidden by collapsing them.
  assert.ok(!/Live account \(Live \+ 5050\)/.test(overview),
    "no row may stand for more than one portfolio");
  assert.match(overview, /name: portfolioNameForMode\(mode\)/,
    "every row is named after the portfolio it opens");
  assert.match(overview, /sharedWallet \? ' <span class="portfolio-summary-note"/,
    "the shared live account is stated on the row instead of merging the rows");
  // It must show every listed portfolio, so it is built from the same list as the tabs.
  assert.match(overview, /dashboardModes\(\)\.map/);
  // And a number that is not loaded reads as absent rather than as zero.
  assert.match(overview, /Number\.isFinite\(value\) \? money\(value\) : "-"/);
});

test("dashboard metrics: cards stay grouped by account value, P/L, then capital allocation", () => {
  const labels = ["Equity", "Resolved accuracy", "Total P/L", "Realized P/L", "Open P/L", "In positions", "Free", "In orders"];
  let previous = -1;
  for (const label of labels) {
    const index = HTML.indexOf(`<span class="label">${label}</span>`);
    assert.ok(index > previous, `${label} follows the requested dashboard order`);
    previous = index;
  }
  assert.match(HTML, /portfolio-card-row portfolio-card-row-primary[\s\S]*?Equity[\s\S]*?Resolved accuracy/);
  assert.match(HTML, /portfolio-card-row portfolio-card-row-profit[\s\S]*?Total P\/L[\s\S]*?Realized P\/L[\s\S]*?Open P\/L/);
  assert.match(HTML, /portfolio-card-row portfolio-card-row-capital[\s\S]*?In positions[\s\S]*?Free[\s\S]*?In orders/);
  assert.match(CSS, /\.portfolio-card-row-primary\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(CSS, /\.portfolio-card-row-profit,[\s\S]*?\.portfolio-card-row-capital\s*\{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
});

test("closed accuracy: a redeemed position counts even when its original cost is unavailable", () => {
  const stats = new Function(`
    ${extractFunction(APP, "isClosedTrade")}
    ${extractFunction(APP, "closedTradePredictionResult")}
    ${extractFunction(APP, "closedAccuracyStats")}
    return closedAccuracyStats;
  `)()([{ status: "REDEEMED", stakeUsdc: null, realizedPnlUsdc: null }]);
  assert.deepEqual(stats, { correct: 1, total: 1, excluded: 0, rate: 1 });
});

test("portfolio metrics: orders, positions and free cash are separate tiles", () => {
  // Relabelled ("Orders"/"Positions" -> "In orders"/"In positions") when the tiles were
  // reordered; the three separate tiles this test actually cares about are unchanged.
  for (const expected of ["In orders", "In positions", "Free"]) {
    assert.match(HTML, new RegExp(`<span class="label">${expected}<\\/span>`));
  }
  assert.match(HTML, /data-portfolio-orders/);
  assert.match(HTML, /data-portfolio-positions/);
  assert.match(HTML, /data-portfolio-free/);
  assert.doesNotMatch(HTML, /Risk \/ free/);
  assert.match(APP, /els\.portfolioFree\.textContent = money\(Math\.max\(0, freeCapital \+ restingRisk\)\);/,
    "paper free cash excludes resting orders");
  assert.match(APP, /els\.portfolioFree\.textContent = freeCash == null \? "-" : money\(freeCash\);/,
    "live free cash is the available collateral, with orders kept separate");
});

test("dashboard: the overview and the archived list render on the first load", () => {
  // Both the paper and the live render paths call syncModeUi, including on the first
  // load. Hanging these off the dashboard rerender instead left both panels empty until
  // something else on the page changed.
  const sync = extractFunction(APP, "syncModeUi");
  assert.match(sync, /renderPortfolioOverview\(\);/);
  assert.match(sync, /renderArchivedPortfolios\(\);/);
  // Fetched when the open tab does not already carry every portfolio's numbers. That is
  // always so on a live tab, and it is also so on a paper tab whose payload came up short
  // of a portfolio -- which used to leave that row reading "-" with nothing able to fill it
  // in, because the summary was fetched on live tabs only.
  assert.match(sync, /if \(live \|\| !overviewCoversEveryPortfolio\(\)\) loadPortfolioOverview\(\);/,
    "the summary must also be fetched when a paper payload is short of a portfolio");
  for (const path of ["renderBotState", "renderLiveState"]) {
    assert.match(extractFunction(APP, path), /syncModeUi\(\);/, `${path} must reach it`);
  }
});

test("settings: archived portfolios retain their complete saved trading rules", () => {
  const archivedRules = extractFunction(APP, "archivedPortfolioRuleRows");
  for (const expected of [
    "Resolved trades",
    "Min probability",
    "Max probability",
    "Included tags",
    "Excluded tags",
    "Minimum volume",
    "Rotation",
    "Stop loss",
  ]) {
    assert.match(archivedRules, new RegExp(`\\[\\"${expected}\\"`));
  }
  const archivedRender = extractFunction(APP, "renderArchivedPortfolios");
  assert.match(archivedRender, /archivedPortfolioRuleRows\(row, archivedSummary\)/);
  assert.match(archivedRender, /class="portfolio-summary-table archived-portfolio-rules"/);
});

test("dashboard: a live portfolio's tab is marked, not merely named", () => {
  // A created live portfolio is a live portfolio: the marker follows the classification,
  // not the two shipped ids, or every portfolio created since reads as paper.
  assert.match(APP, /button\.classList\.toggle\("mode-button-live", isLivePortfolioMode\(buttonMode\)\);/);
  const rule = /\.mode-button\.mode-button-live \{[^}]*\}/.exec(CSS);
  assert.ok(rule, "the marked tab has a style");
  assert.match(rule[0], /border: 2px solid var\(--danger\);/);
  // Portfolios are renameable, so the name cannot be what tells live from paper.
  assert.match(CSS, /\.mode-button\.mode-button-live\.active \{/,
    "the mark stays on the tab you are standing on");
});

// Reported: the "stop loss" (Equal) portfolio's Rotation row still showed an old value.
// Measured against history: a prior commit replaced a hardcoded
// ["Rotation", "Disabled for this proof of concept"] row with the real On/Off one
// driven by autoRotatePositions, in the same change that added the checkbox -- but
// never bumped assets/app.js's cache-busting query string. Every deploy from that day
// until this session's kept re-serving the old URL, so a browser that had it cached
// went on running the pre-fix script and showing the stale text indefinitely. The
// source has been correct since; this guards the regression class, not the display.
test("rotation: the retired hardcoded label for Equal cannot come back", () => {
  assert.ok(!/Disabled for this proof of concept/.test(APP),
    "Equal's Rotation row must stay driven by autoRotatePositions, not a fixed string");
  const rows = extractFunction(APP, "portfolioRuleRows");
  // Exactly one Rotation row: a stale hardcoded one alongside the real one is the
  // exact shape of the regression, whether or not the stale copy also renders "old
  // value" text.
  assert.equal((rows.match(/rows\.push\(\["Rotation",/g) || []).length, 1);
});

// Asked for explicitly: the Equal portfolio's synthetic stop "now works great" and
// should become an On/Off parameter every paper portfolio can turn on, applying the
// same mechanism when enabled.
test("stop loss: it is a config parameter on every paper portfolio, defaulting to Equal's established behavior", () => {
  const config = normalizeConfig({
    paper: {
      conservative: { stopLossRiskMultiplier: 1.7 },
      highReward: {},
      equal: { stopLossRiskMultiplier: 0 },
    },
  });
  assert.equal(config.paper.conservative.stopLossEnabled, true, "any portfolio can turn it on");
  assert.equal(config.paper.conservative.stopLossRiskMultiplier, 1.7, "it stores the configured risk multiple");
  assert.equal(config.paper.highReward.stopLossEnabled, false, "off unless explicitly enabled");
  assert.equal(config.paper.highReward.stopLossRiskMultiplier, 0);
  assert.equal(config.paper.moreProbable.stopLossEnabled, false);
  assert.equal(config.paper.moreProbable.stopLossRiskMultiplier, 0);
  assert.equal(config.paper.equal.stopLossEnabled, false, "and Equal can turn it off too");
  assert.equal(config.paper.equal.stopLossRiskMultiplier, 0);
});

test("stop loss: an untouched config keeps every portfolio's established behavior", () => {
  const config = normalizeConfig({});
  for (const id of ["conservative", "highReward", "moreProbable"]) {
    assert.equal(config.paper[id].stopLossEnabled, false, `${id} never had this on`);
    assert.equal(config.paper[id].stopLossRiskMultiplier, 0);
  }
  assert.equal(config.paper.equal.stopLossEnabled, true, "Equal shipped with it on");
  assert.equal(config.paper.equal.stopLossRiskMultiplier, 1.5, "Equal now defaults to a wider 150% protective band");
});

test("stop loss: a created portfolio starts with it off, like every other new switch", () => {
  const config = normalizeConfig({ paper: { esports: { displayName: "Esports 60" } } });
  assert.equal(config.paper.esports.stopLossEnabled, false);
  assert.equal(config.paper.esports.stopLossRiskMultiplier, 0);
});

test("stop loss: the bot reads a per-portfolio switch, not a constant on Equal alone", () => {
  // The four shipped strategies each read their own env var, mirroring exactly how
  // rotation is already wired -- and there is no longer a bare `equalRiskProtection:
  // true` sitting outside that pattern for Equal specifically.
  for (const [prefix, fallback] of [
    ["PAPER_CONSERVATIVE", "0"],
    ["PAPER_HIGH_REWARD", "0"],
    ["PAPER_MORE_PROBABLE", "0"],
    ["PAPER_EQUAL", "1\\.5"],
  ]) {
    assert.match(BOT, new RegExp(`equalRiskMultiplier: envStopLossRiskMultiplier\\("${prefix}", ${fallback}\\)`));
  }
  assert.equal((BOT.match(/equalRiskProtection: true,/g) || []).length, 0,
    "no strategy may hardcode this outside the per-portfolio switch");

  assert.match(BOT, /equalRiskMultiplier: rowStopLossRiskMultiplier\(row, 0\)/);
  assert.match(BOT, /equalRiskProtection: rowStopLossRiskMultiplier\(row, 0\) > 0/);
});

test("stop loss: the workflow passes it through with Equal's established default", () => {
  assert.match(WORKFLOW, /def stop_loss_multiplier\(row, strategy\):/);
  assert.match(WORKFLOW, /emit\(f"\{prefix\}_STOP_LOSS_RISK_MULTIPLIER", multiplier\)/);
  assert.match(WORKFLOW, /emit\(f"\{prefix\}_STOP_LOSS_ENABLED", str\(multiplier > 0\)\.lower\(\)\)/);
});

test("stop loss: the parameter modal offers it for paper and live portfolios", () => {
  assert.match(HTML, /data-stop-loss-risk-multiplier/);
  assert.doesNotMatch(HTML, /data-paper-only-row/);
  const sync = extractFunction(APP, "syncPortfolioParameterControls");
  assert.match(sync, /const stopLossMultiplier = stopLossRiskMultiplier\(config\);/);
  assert.match(sync, /els\.stopLossRiskMultiplier\.value = String\(Math\.round\(stopLossMultiplier \* 100\)\);/);
  assert.doesNotMatch(sync, /paperOnlyRows/,
    "the live setting must remain visible instead of being hidden by its mode");
  assert.match(APP, /els\.stopLossRiskMultiplier\?\.addEventListener\("input"/);
  // Off by default: unlike rotation (on unless explicitly false), most portfolios have
  // never had this behavior, so an absent value must not read as enabled.
  assert.match(APP, /function stopLossIsEnabled\(config = \{\}\) \{\r?\n  return stopLossRiskMultiplier\(config\) > 0;\r?\n\}/);
});

test("stop loss: the rules card shows it for every paper portfolio, not only Equal", () => {
  const rows = extractFunction(APP, "portfolioRuleRows");
  assert.ok(!/if \(portfolio\.id === "equal"\)/.test(rows),
    "the row must not be conditional on which portfolio this is");
  assert.match(rows, /rows\.push\(\["Stop loss", stopLossRiskLabel\(config\)\]\);/);
});

test("stop loss: the live rules card shows the configured stop loss risk", () => {
  const rows = extractFunction(APP, "livePortfolioRuleRows");
  assert.match(rows, /\["Stop loss", stopLossRiskLabel\(config\)\]/);
});

// Asked for: live portfolios lead the dashboard, with the same equity ordering inside
// the live and paper groups.
test("dashboard: live tabs lead, then each portfolio group is ordered by equity", () => {
  const run = new Function("state", `
    ${/const BUILT_IN_PAPER_STRATEGY_IDS = \[[^\]]*\];/.exec(APP)[0]}
    ${/const CUSTOM_PAPER_STRATEGY_ID = [^\n]+/.exec(APP)[0]}
    ${/const LIVE_MODES = new Set\(\[[^\]]*\]\);/.exec(APP)[0]}
    ${extractFunction(APP, "normalizeMode")}
    ${extractFunction(APP, "paperStrategyIdFromMode")}
    ${extractFunction(APP, "defaultPortfolioConfig")}
    ${extractFunction(APP, "paperStrategyIds")}
    ${extractFunction(APP, "overviewPortfolioNumbers")}
    ${extractFunction(APP, "portfolioEquityUsdc")}
    ${extractFunction(APP, "byEquityDescending")}
    // The live group is ordered by whether a portfolio is switched on, then by ROI, so the
    // tab order needs both. Real, not stubbed: the ordering is what these tests measure.
    ${extractFunction(APP, "automationIsEnabled")}
    ${extractFunction(APP, "firstOpenedAtFromTrades")}
    ${extractFunction(APP, "liveInitialCapitalForMode")}
    ${extractFunction(APP, "portfolioRealizedRoiForMode")}
    // Ordering asks each portfolio whether its automation is on, which means the real
    // config merge -- the shipped defaults matter here, since 5050 is the one portfolio
    // that ships switched off.
    ${extractFunction(APP, "customLivePortfolioDefaults")}
    ${extractFunction(APP, "customPaperPortfolioDefaults")}
    ${extractFunction(APP, "normalizePortfolioMarketType")}
    ${extractFunction(APP, "liveConfigKeyForMode")}
    ${extractFunction(APP, "portfolioConfigForMode")}
    ${extractFunction(APP, "byActiveThenRoiDescending")}
    ${extractFunction(APP, "dashboardModes")}
    // A live portfolio can be created now, so "is this mode live" and "is it archived" both
    // have to ask whether a mode names one. The cluster comes across as the real thing --
    // they are pure over state, and stubbing them would only prove the harness agrees with
    // itself about the very classification under test.
    ${extractFunction(APP, "customLivePortfolioIdFromMode")}
    ${extractFunction(APP, "isLivePortfolioMode")}
    ${extractFunction(APP, "isFixedEntryMode")}
    ${extractFunction(APP, "portfolioIsArchived")}
    const DEFAULT_MAX_RESOLUTION_DAYS = 7;
    return { dashboardModes, portfolioEquityUsdc };
  `);

  const paperPortfolios = {
    conservative: { portfolio: { equityUsdc: 84 } },
    highReward: { portfolio: { equityUsdc: 68 } },
    moreProbable: { portfolio: { equityUsdc: 141 } },
    equal: { portfolio: { equityUsdc: 55 } },
  };
  const app = run({
    mode: "paper-conservative",
    portfolioConfig: { live5050: { archived: true } },
    botState: { paperPortfolios },
    liveState: { portfolio: { equityUsdc: 120 } },
  });
  assert.deepEqual(app.dashboardModes(), [
    "live", // 120
    "paper-moreProbable", // 141
    "paper-conservative", // 84
    "paper-highReward", // 68
    "paper-equal", // 55
  ]);

  // A portfolio whose equity has not loaded yet is ordered last rather than treated as
  // zero, and the incoming order breaks the tie so the row does not shuffle per render.
  const partial = run({
    mode: "paper-conservative",
    portfolioConfig: { live5050: { archived: true } },
    botState: { paperPortfolios: { moreProbable: { portfolio: { equityUsdc: 141 } } } },
    liveState: null,
  });
  assert.deepEqual(partial.dashboardModes(), [
    "live",
    "paper-moreProbable",
    "paper-conservative",
    "paper-highReward",
    "paper-equal",
  ]);
});

// Asked for: the portfolio that opens by default is the one at the top of the overview.
// Both read dashboardModes(), so the rule needs no separate ordering -- what it needs is to
// wait. The live group is ordered by the automation switch and then by ROI, and an empty
// payload knows neither: every ROI is null, the group ties, and the order falls back to the
// declaration order. This used to commit at that moment on purpose, so a live dashboard
// would not sit on a paper tab while the wallet loaded, and the portfolio it picked stopped
// being the top row a second later -- with the flag already set, it never looked again.
test("dashboard: the top portfolio of the overview opens on load, but never over a click", () => {
  const preselect = extractFunction(APP, "preselectTopPortfolio");
  assert.match(preselect, /if \(state\.portfolioPreselectDone\) return;/);
  assert.match(preselect, /const \[preferred\] = dashboardModes\(\);/,
    "the default and the overview must read the same order, or they can disagree");

  // The inputs the ordering reads, so the choice is made against the order the reader will
  // actually see.
  assert.match(preselect, /Boolean\(state\.portfolioConfig\)/,
    "the automation switch comes from the config");
  assert.match(preselect, /\? Boolean\(state\.liveState\)/,
    "and a live portfolio's ROI needs the account snapshot");
  assert.match(preselect, /portfolioEquityUsdc\(preferred\) != null/,
    "a paper top row still waits for a real equity value");
  assert.ok(preselect.indexOf("portfolioPreselectDone = true") > preselect.indexOf("if (!orderingReady) return;"),
    "the flag must not be set before the data that decides the order has arrived");

  // Values, not inputs, would hold it open forever: a portfolio that has closed nothing has
  // no ROI, and there is no later payload that gives it one.
  assert.ok(!/roi == null/.test(preselect) && !/annualized == null/.test(preselect),
    "waiting on an ROI value would never resolve for a portfolio with no closed trades");

  // Switching portfolios has to refetch: the dashboard payload carries the trades of the
  // selected portfolio alone.
  assert.match(preselect, /loadDashboardState\(\);/);

  // It runs from the one place both the paper and the live render paths reach.
  assert.match(extractFunction(APP, "syncModeUi"), /preselectTopPortfolio\(\);/);
  // And it gets a turn once the config exists, not only before. The syncModeUi call at the
  // top of loadDashboardState runs while portfolioConfig is still null, so that pass can
  // never decide anything; without a second turn after the await, a page whose stored mode
  // is a paper tab commits to it. The dispatch must also read the mode AFTER that turn.
  const load = extractFunction(APP, "loadDashboardState");
  assert.ok(load.indexOf("preselectTopPortfolio();") > load.indexOf("await loadPortfolioConfig();"),
    "the preselection must get a turn once the config it needs has arrived");
  assert.ok(load.indexOf("const requestedMode = normalizeMode(state.mode);") > load.indexOf("preselectTopPortfolio();"),
    "the branch must be chosen from the mode the preselection left behind, not the one before it");
  // And a deliberate click settles it for the rest of the page load, including a click
  // on the tab that is already open.
  const handler = APP.slice(APP.indexOf('const button = event.target.closest("[data-mode-toggle]");'));
  const body = handler.slice(0, handler.indexOf("\n});"));
  assert.ok(body.indexOf("state.portfolioPreselectDone = true;") < body.indexOf("if (state.mode === mode) return;"),
    "the flag must be set before the early return, or clicking the open tab would not settle it");
});

test("run log history: the deploy keeps the archive and the endpoint reads the portfolio's segment", async () => {
  const { readFile } = await import("node:fs/promises");
  const deploy = await readFile(new URL("../../.github/workflows/trading-deploy.yml", import.meta.url), "utf8");
  // The deploy wipes data/ of anything it does not recognise. portfolio-run-log was
  // missing from the keep-set, so every deploy of the site deleted every portfolio's
  // archived run history at once -- the same omission that previously cost the state
  // segments and 5050's execution state. Only the newest runs live in the state file, so
  // what a deploy destroyed was everything older than that cap.
  assert.match(deploy, /"portfolio-run-log",/,
    "the deploy must keep the archived run-log tree");

  // And the endpoint has to name the portfolio it wants: a run log lives in that
  // portfolio's own state segment now, and the core file carries an empty one. Reading
  // the core alone left no fallback, so a portfolio whose archive was gone reported no
  // runs at all even while the state held two dozen.
  assert.match(API, /\$state = state_payload\('paper', \[\], \$strategyId\);/,
    "the run-log endpoint must load the selected portfolio's segment");
});

test("dashboard: a row takes its numbers from whichever payload has them", () => {
  // Reported from a loading screenshot: the shipped portfolios showed equity while the
  // created ones showed "-", and some never filled in. The server payload was complete --
  // all seven portfolios carried portfolio.equityUsdc -- so the table was what came up
  // short. It picked one source for the whole table (state.botState if present, otherwise
  // state.portfolioOverview), so a dashboard payload missing a portfolio blanked that row
  // even with a complete summary sitting unused beside it. Both payloads describe the same
  // portfolios, so the choice belongs per row.
  const run = new Function("state", `
    ${extractFunction(APP, "overviewPortfolioNumbers")}
    return overviewPortfolioNumbers;
  `);

  // The dashboard payload knows two portfolios, the summary knows the third.
  const lookup = run({
    botState: {
      paperPortfolios: {
        conservative: { portfolio: { equityUsdc: 84.22 } },
        highReward: { portfolio: { equityUsdc: 110.05 } },
      },
    },
    portfolioOverview: {
      conservative: { portfolio: { equityUsdc: 1 } },
      ewportfolio: { portfolio: { equityUsdc: 100 } },
    },
  });
  assert.equal(lookup("conservative").equityUsdc, 84.22, "the open tab's own payload wins where it has the portfolio");
  assert.equal(lookup("highReward").equityUsdc, 110.05);
  assert.equal(lookup("ewportfolio").equityUsdc, 100, "a portfolio the dashboard payload lacks still resolves");
  assert.equal(lookup("nothingKnowsThis"), null, "and an unknown portfolio is absent, not zero");

  // Neither source loaded yet reads as absent rather than as zero, so the tab order puts
  // it last instead of sorting it below a real loss.
  assert.equal(run({}) ("conservative"), null);
  assert.equal(run({ botState: null, portfolioOverview: null })("conservative"), null);
});

test("dashboard: archived portfolios are never listed, and never fetched for the overview", () => {
  // Reported: archived portfolios flashed into the overview while it loaded. Two halves.
  //
  // The client guessed. paperStrategyIds fell back to defaultPortfolioConfig() when the
  // saved config had not arrived, and that answers with the four shipped portfolios and
  // nothing archived -- so for one frame an archived portfolio was listed and a created one
  // was not. Nothing is listed until the real config is known, from its cache on any repeat
  // visit, so the gap is a moment of no rows rather than a moment of wrong ones.
  const ids = extractFunction(APP, "paperStrategyIds");
  assert.match(ids, /const config = state\.portfolioConfig \|\| readCachedPortfolioConfig\(\);/,
    "the cached config stands in before the fetch returns");
  assert.match(ids, /if \(!config\) return \[\];/,
    "an unknown config must list nothing rather than guess the shipped four");
  assert.ok(!/defaultPortfolioConfig\(\)/.test(ids),
    "the default config is a guess about which portfolios exist, so it may not be used here");
  // The cache has to be written, or it can never stand in.
  assert.match(extractFunction(APP, "loadPortfolioConfig"), /writeCachedPortfolioConfig\(state\.portfolioConfig\);/);

  // And the server stops sending them: this summary exists only to fill the overview
  // table, which never lists an archived portfolio, so it was payload fetched and dropped.
  const overview = API.slice(API.indexOf("if ($summary === 'portfolio-overview') {"));
  const branch = overview.slice(0, overview.indexOf("return $compact;"));
  assert.match(branch, /\$row\['archived'\] \?\? false\) !== true/,
    "the portfolio-overview summary must filter archived portfolios out");
});

// -- A workflow GitHub will not parse ----------------------------------------------------
//
// Reported: manual execution of the "live 70" portfolio failed with
//   GitHub HTTP 422: Invalid Argument - failed to parse workflow:
//   (Line: 318, Col: 13): Unexpected value '', (Line: 349, Col: 13): Unexpected value ''
// and it kept failing on every retry. Both lines were an `env:` key with nothing under it,
// left behind when the value it held moved onto the `run:` line. That is valid YAML -- the
// key simply parses as null -- so nothing local caught it, and GitHub rejects the file
// wholesale: every dispatch 422s and the schedule stops firing too.
//
// This is the second time a workflow has been shipped that GitHub refuses to parse (the
// first was the 25-input ceiling), and both times the symptom was every run silently
// failing to start. So it is checked here rather than discovered in production.
test("workflows: no mapping key is left with nothing under it", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const directory = new URL("../../.github/workflows/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  assert.ok(files.length > 5, `expected the workflow directory, found ${files.length} files`);

  const offenders = [];
  for (const name of files) {
    const lines = (await readFile(new URL(name, directory), "utf8")).split("\n");
    lines.forEach((line, index) => {
      const key = line.trim();
      // The block-valued keys GitHub rejects when empty. `run:` and `if:` take scalars and
      // are caught by YAML itself, so they are not the risk here.
      if (!["env:", "with:", "inputs:", "outputs:", "secrets:", "jobs:", "steps:"].includes(key)) return;
      const indent = line.length - line.trimStart().length;
      // The first line after it that is neither blank nor a comment decides: if it is not
      // indented deeper, the key has no entries.
      const next = lines.slice(index + 1).find((candidate) => candidate.trim() && !candidate.trim().startsWith("#"));
      if (next === undefined) return;
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= indent) offenders.push(`${name}:${index + 1} "${key}" is empty`);
    });
  }
  assert.deepEqual(offenders, [], `GitHub answers 422 for these and refuses the whole file:\n${offenders.join("\n")}`);
});

// -- A run that never started still happened ---------------------------------------------
//
// The same report, second half: the failed attempt was nowhere in the run log. Every entry
// a portfolio has is written by its runner at the end of a run, so a dispatch GitHub refuses
// produces no entry at all -- the popup shows an error, the log shows the previous run, and
// closing the popup loses the only trace.
test("run log: a refused dispatch is recorded where the portfolio's runs are read", async () => {
  const { readFile } = await import("node:fs/promises");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");

  // Recorded at the one point that knows about it, and the error still reaches the browser.
  const dispatch = /\$result = dispatch_workflow\([\s\S]*?catch \(Throwable[\s\S]*?\n        \}/.exec(api);
  assert.ok(dispatch, "the dispatch must be able to fail without losing the attempt");
  assert.match(dispatch[0], /record_execution_dispatch_failure\(/);
  assert.match(dispatch[0], /'error' => \$error->getMessage\(\)/,
    "the failure is recorded as well as reported, never instead of");

  // Merged back in on both read paths. A paper portfolio's log is assembled by PHP; a live
  // portfolio reads a static file its runner owns, so its browser fetches them separately.
  assert.match(api, /foreach \(execution_dispatch_failure_records\('paper-' \. \$strategyId\) as \$item\)/);
  assert.match(api, /if \(\$action === 'dispatch-failures'\)/);

  // Both sides must file under the same name, or a failure is written where nothing reads.
  const phpKey = /function execution_dispatch_failure_key\([\s\S]*?\n\}/.exec(api);
  assert.ok(phpKey);
  assert.match(phpKey[0], /return 'paper-' \. \$paperStrategyId;/);
  assert.match(phpKey[0], /return \$target;/);

  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const jsKey = new Function(
    "LIVE_MODES", "normalizeMode", "customLivePortfolioIdFromMode", "paperStrategyIdFromMode",
    `${extractFunction(app, "dispatchFailureKey")}\nreturn dispatchFailureKey;`,
  )(
    new Set(["live", "live-5050"]),
    (value) => String(value || ""),
    (mode) => (/^live-custom-(.+)$/.exec(String(mode || ""))?.[1] || null),
    (mode) => (/^paper-(.+)$/.exec(String(mode || ""))?.[1] || "conservative"),
  );
  // The live target IS the mode, so its key is the string PHP receives verbatim.
  assert.equal(jsKey("live"), "live");
  assert.equal(jsKey("live-5050"), "live-5050");
  assert.equal(jsKey("live-custom-live70"), "live-custom-live70");
  // Paper dispatches send target "paper" with the portfolio alongside, so they key on it.
  assert.equal(jsKey("paper-moreProbable"), "paper-moreProbable");

  // And the row reaches the rendered log rather than being fetched and dropped.
  assert.match(app, /const dispatchFailures = state\.dispatchFailuresByMode\?\.\[normalizeMode\(state\.mode\)\];/);
  assert.match(app, /if \(Array\.isArray\(dispatchFailures\)\) rows\.push\(\.\.\.dispatchFailures\);/);
  assert.match(app, /action === "DISPATCH_FAILED"/, "and it reads as a run that never started");
});

// The optimisation report is built in two places and must stay one analysis.
//
// The paper half comes from the bot, which holds the paper state. The live half cannot:
// live closed trades are rebuilt from the wallet's on-chain history and carry no portfolio
// id, because the live portfolios share one wallet -- which portfolio placed a trade is
// inferred from the price it was bought at, and that inference only exists in the browser.
// So the analysis is implemented twice, and this pins the two to identical output on
// identical trades. Without it the two halves of one report could drift apart silently.
test("portfolio optimisation: the browser and the bot run the same analysis", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  function extract(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `function ${name} was not found in app.js`);
    let depth = 0;
    for (let index = source.indexOf("{", source.indexOf(")", start)); index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
      }
    }
    throw new Error(`function ${name} is unbalanced in app.js`);
  }
  const constant = (name) => {
    const match = new RegExp(`const ${name} = ([^;]+);`).exec(app);
    assert.ok(match, `${name} was not found in app.js`);
    return `const ${name} = ${match[1]};`;
  };

  const browser = new Function(`
    ${constant("OPTIMISATION_PROBABILITY_LADDER")}
    ${constant("OPTIMISATION_MAX_DAYS_LADDER")}
    ${constant("OPTIMISATION_MIN_VOLUME_LADDER")}
    ${constant("OPTIMISATION_MIN_TRADES")}
    ${constant("OPTIMISATION_MIN_IMPROVEMENT_USDC")}
    ${extract(app, "optimisationTradeEntryProbability")}
    ${extract(app, "optimisationTradeEntryVolume")}
    ${extract(app, "optimisationTradeMarketType")}
    ${extract(app, "optimisationCandidate")}
    ${extract(app, "optimisationPortfolioRow")}
    return optimisationPortfolioRow;
  `)();

  // Enough resolved trades to clear the 12-trade floor on several cuts at once, with a
  // deliberate edge: the high-probability, short-dated, high-volume binaries are the
  // profitable ones, so the ladders actually produce recommendations to compare.
  const trades = [];
  for (let index = 0; index < 40; index += 1) {
    const strong = index % 2 === 0;
    trades.push({
      id: `trade-${index}`,
      status: "RESOLVED",
      realizedPnlUsdc: strong ? 0.9 : -0.7,
      marketProbability: strong ? 0.96 : 0.62,
      daysToResolution: strong ? 2 : 21,
      firstVolumeUsdc: strong ? 60000 : 400,
      outcome: strong ? "Yes" : "Team A",
    });
  }
  // A row with nothing recorded must be handled identically by both, not skipped by one.
  trades.push({ id: "sparse", status: "RESOLVED", realizedPnlUsdc: 0.1 });

  const bot = await import("../tools/paper-trading-bot.mjs");
  const fromBrowser = browser("equal", "Equal", trades);
  const report = bot.buildPortfolioOptimisationReport({
    paperPortfolios: { equal: { id: "equal", label: "Equal", trades } },
  });
  const fromBot = report.portfolios.find((row) => row.strategyId === "equal");
  assert.ok(fromBot, "the bot must analyse the portfolio it was given");

  assert.deepEqual(fromBrowser.baseline, fromBot.baseline,
    "the two implementations disagree about the baseline");
  assert.deepEqual(fromBrowser.recommendations, fromBot.recommendations,
    "the two implementations disagree about the recommendations");
  assert.equal(fromBrowser.note, fromBot.note);
  // The fixture is meant to produce something to compare; an empty match would pass
  // vacuously and hide a divergence.
  assert.ok(fromBrowser.recommendations.length > 0, "the fixture must produce recommendations");

  // Too little history is the common case for a young live portfolio, and both must say so
  // rather than recommending from four trades.
  const thin = trades.slice(0, 4);
  const thinBrowser = browser("equal", "Equal", thin);
  const thinBot = bot.buildPortfolioOptimisationReport({
    paperPortfolios: { equal: { id: "equal", label: "Equal", trades: thin } },
  }).portfolios.find((row) => row.strategyId === "equal");
  assert.deepEqual(thinBrowser.recommendations, []);
  assert.equal(thinBrowser.note, thinBot.note);
});

// The detailed live audit is intentionally different from the automatic suggestions:
// it starts from each *actual* loss and shows the full historical P/L if that entry
// value had been forbidden. In particular it must subtract excluded wins too -- merely
// summing avoided losses would make every stricter rule look deceptively profitable.
test("live counterfactual audit: a losing probability value recalculates the whole realised ledger", () => {
  const auditBuilder = new Function(`
    ${extractFunction(APP, "optimisationTradeEntryProbability")}
    ${extractFunction(APP, "optimisationTradeEntryVolume")}
    ${extractFunction(APP, "optimisationTradeMarketType")}
    ${extractFunction(APP, "counterfactualPnlSummary")}
    ${extractFunction(APP, "counterfactualTradeLabel")}
    ${extractFunction(APP, "counterfactualParameterDefinition")}
    ${extractFunction(APP, "counterfactualValueKey")}
    ${extractFunction(APP, "counterfactualScenariosForParameter")}
    ${extractFunction(APP, "buildLiveCounterfactualAuditReport")}
    return buildLiveCounterfactualAuditReport;
  `)();

  const audit = auditBuilder("live", "Live", [
    { id: "win-high", status: "WON", realizedPnlUsdc: 2, marketProbability: 0.9, daysToResolution: 1, firstVolumeUsdc: 50000, outcome: "Yes", question: "High win" },
    { id: "loss-71", status: "LOST", realizedPnlUsdc: -5, marketProbability: 0.71, daysToResolution: 4, firstVolumeUsdc: 9000, outcome: "No", question: "71 loss" },
    { id: "win-low", status: "WON", realizedPnlUsdc: 1, marketProbability: 0.6, daysToResolution: 3, firstVolumeUsdc: 3000, outcome: "No", question: "Low win" },
    { id: "loss-90", status: "LOST", realizedPnlUsdc: -1, marketProbability: 0.9, daysToResolution: 1, firstVolumeUsdc: 50000, outcome: "Yes", question: "90 loss" },
    { id: "unclassified", status: "LOST", realizedPnlUsdc: -2, outcome: "Team", question: "Missing entry data" },
  ]);

  assert.deepEqual(audit.baseline, { trades: 5, wins: 2, losses: 3, pnlUsdc: -5 });
  const probability = audit.parameters.find((entry) => entry.parameter === "probability");
  assert.ok(probability, "probability scenarios must be present");
  assert.equal(probability.unknownTrades, 1, "missing entry values stay in every scenario");
  const threshold71 = probability.scenarios.find((row) => Math.abs(Number(row.threshold) - 0.71) < 0.000001);
  assert.ok(threshold71, "the actual 71% loss must become a scenario");
  assert.deepEqual(threshold71.excluded, { trades: 2, wins: 1, losses: 1, pnlUsdc: -4 },
    "the scenario excludes the 71% loss and the lower-probability win");
  assert.deepEqual(threshold71.kept, { trades: 3, wins: 1, losses: 2, pnlUsdc: -1 },
    "the reported total is the P/L of all trades left after the filter, including sparse history");
  assert.equal(threshold71.pnlDeltaUsdc, 4, "change is measured against the full -5 USDC baseline");

  // The report itself still fetches a current ledger rather than relying on the dashboard
  // cache when asked to run.
  assert.match(APP, /state\.liveState = await fetchFreshState\("live"\)/,
    "the manual audit fetches a current live ledger rather than relying on dashboard cache");
  // Not currently pinned: whether anything in the page still calls runLiveCounterfactualAudit
  // to ask for that run. "Replace portfolio optimization with trade analysis" left the
  // builder, the render function and this fetch in place but removed every call site that
  // reached them (grep finds each of runLiveCounterfactualAudit(, renderLiveCounterfactualAudit(
  // only at its own definition) -- worth a look, since that could be a deliberate pause on the
  // feature or a page a refactor dropped by accident.
});

// A live account has one wallet, while custom live portfolios have their own closed
// ledger and configured original value. The chart must never reverse-engineer a custom
// portfolio's starting capital from wallet-wide equity, or another portfolio's P/L turns
// into fictional starting money.
test("live equity history: configured original value anchors the realised chart", () => {
  const historyBuilder = new Function(`
    ${extractFunction(APP, "isClosedTrade")}
    ${extractFunction(APP, "tradeClosedAt")}
    ${extractFunction(APP, "chartTimestamp")}
    ${extractFunction(APP, "equityChartBucket")}
    ${extractFunction(APP, "equityChartScale")}
    ${extractFunction(APP, "numericOrNull")}
    ${extractFunction(APP, "equityHistoryFromDailySamples")}
    ${extractFunction(APP, "portfolioEquityHistory")}
    return portfolioEquityHistory;
  `)();

  const history = historyBuilder([
    { status: "WON", openedAt: "2026-08-11T08:00:00Z", resolvedAt: "2026-08-12T08:00:00Z", realizedPnlUsdc: 3 },
    { status: "LOST", openedAt: "2026-08-12T09:00:00Z", resolvedAt: "2026-08-14T08:00:00Z", realizedPnlUsdc: -11 },
  ], 98.5, -3, "2026-08-16T10:00:00Z", 148, -8);

  assert.ok(history, "a history longer than three days must render");
  assert.equal(history.openingEquity, 148);
  assert.equal(history.originalValue, 148);
  assert.equal(history.points[0].value, 148,
    "the first plot point is the configured original value, not wallet equity minus another portfolio's losses");
  assert.equal(history.points[history.points.length - 1].value, 140,
    "the final realized value is original value plus this portfolio's settled P/L only");
  assert.ok(!history.points.some((point) => Math.abs(point.value - 190) < 0.0001),
    "the old back-calculated wallet-wide starting point must not leak into the series");

  const staleLedger = historyBuilder([
    { status: "LOST", openedAt: "2026-08-11T08:00:00Z", resolvedAt: "2026-08-12T08:00:00Z", realizedPnlUsdc: -45 },
    { status: "REDEEMED", openedAt: "2026-08-12T09:00:00Z", resolvedAt: "2026-08-14T08:00:00Z", realizedPnlUsdc: 3 },
  ], 98.25249, -4.1618, "2026-08-30T10:00:00Z", 101.3, 1.11429);
  assert.equal(staleLedger.points[0].value, 101.3);
  assert.ok(Math.abs(staleLedger.points.at(-1).value - 102.41429) < 0.0001,
    "the final live point uses authoritative realised equity, not stale retained rows");
  assert.equal(staleLedger.points.length, 2,
    "unreconciled historical rows are not rendered as fictitious equity movements");

  assert.match(APP, /const configuredLiveInitial = liveInitialCapitalForMode\(state\.mode\);/,
    "custom live portfolios use their own configured original value too");
  assert.match(APP, /originalValue: deposited,/, "the live chart receives that value explicitly");
  assert.match(APP, /realizedPnl,/, "the live chart receives the authoritative realised P\/L from its account snapshot");
  assert.match(APP, /equity-history-original-value/, "the renderer includes the visible reference line");
});

test("portfolio optimisation: live portfolios are analysed per portfolio, not per account", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // The live half is only worth anything if each live portfolio gets its own trades. The
  // wallet is shared, so the split is by mode, and liveClosedTrades must take one.
  assert.match(app, /function liveClosedTrades\(liveState, mode = state\.mode\)/,
    "liveClosedTrades must be able to answer for a portfolio other than the selected one");
  assert.match(app, /function belongsToLivePortfolio\(row, mode = state\.mode\)/,
    "attribution must be askable per portfolio");
  assert.match(app, /liveClosedTrades\(state\.liveState, mode\)/,
    "the report must pass the mode through rather than reusing the active portfolio");
  // The old state.mode-bound wrapper has to stay, since the rest of the live UI uses it.
  assert.match(app, /function belongsToActiveLivePortfolio\(row\) \{\n\s+return belongsToLivePortfolio\(row, state\.mode\);/);

  // Live rows are appended to the paper (and archived-paper) rows in one combined list, so
  // a missing bot report cannot hide them the way a separate report/live split used to.
  assert.match(app, /function portfolioTradeAnalysisPortfolios\(\) \{/);
  const combiner = extractFunction(app, "portfolioTradeAnalysisPortfolios");
  assert.match(combiner, /dashboardModes\(\)\s*\n\s*\.filter\(\(mode\) => isLivePortfolioMode\(mode\)\)/,
    "the live half is built per portfolio mode, not per account");
  assert.match(combiner, /liveClosedTrades\(\s*\n?\s*state\.liveState, mode\)/);
  assert.match(combiner, /return \[\.\.\.live, \.\.\.paper, \.\.\.archives\];/);
  assert.match(app, /const portfolios = portfolioTradeAnalysisPortfolios\(\);/);
  assert.match(app, /if \(!portfolios\.length\) \{/,
    "the empty state now considers the live half for free, since it is already merged in");
});

// Requested: drop R/R from the opened positions list and put Volume there instead, with a
// value that updates when the list is refreshed.
//
// The second half is the part that can silently not work. A trade's stored volume was
// written once at entry and never touched again, so a column reading it would have looked
// correct and shown a number frozen on the day the position was opened -- for a market
// that has since dried up, the opposite of the truth.
test("opened positions: Volume replaces R/R and is re-read on every mark", async () => {
  const app = APP;
  const bot = BOT;

  // The two tables share one renderer, so the column stays gated: Volume is the opened
  // list's, and the closed list has no column in that slot at all. R/R was dropped from
  // the opened list when Volume took its place and from the closed list on request, so
  // it must not survive in either -- header or body.
  assert.match(app, /\$\{showStatus \? "" : tradeHeader\(tableKey, "volume", "Volume"\)\}/,
    "Volume belongs to the opened list only");
  assert.match(app, /\$\{showStatus \? "" : `<td data-label="Volume">\$\{tradeVolumeCell\(trade\)\}<\/td>`\}/,
    "the body cell must follow the header, or the two tables disagree on column count");
  // Scoped to the trade renderer: a separate R/R column on the scraped-opportunities table
  // is a different list and was not part of this request.
  const renderer = app.slice(app.indexOf("function renderTradeRows"), app.indexOf("function closedTradesForCurrentPortfolio"));
  assert.ok(renderer.length > 500, "the slice must actually cover renderTradeRows");
  assert.doesNotMatch(renderer, /data-label="R\/R"/, "no R/R cell may remain in either trade table");
  assert.doesNotMatch(renderer, /riskReward/, "and no R/R header either");
  // The number itself is still computed: the CSV export carries risk_reward, and dropping a
  // column from an export is a different decision from dropping it from a screen.
  assert.match(app, /risk_reward: csvNumber\(tradeRiskReward\(trade\)/,
    "the export keeps the figure even though no table shows it");
  // The column is sortable like every other one, or it is the only dead header in the table.
  assert.match(app, /if \(key === "volume"\) return tradeVolumeUsdc\(trade\) \?\? -1;/);

  // What makes it refresh: the bot re-reads volume when it re-prices an open position, so
  // the dashboard summary the Refresh values button re-fetches already carries a current
  // figure. Without this the column would be permanently stuck at the entry value.
  const markStart = bot.indexOf("async function markOpenTrade(");
  assert.ok(markStart >= 0, "markOpenTrade must exist");
  const mark = bot.slice(markStart, bot.indexOf("const stopPlanForTrade", markStart));
  assert.ok(mark.length > 200, "the slice must actually cover markOpenTrade");
  assert.match(mark, /volumeUsdc: marketVolumeSnapshotUsdc\(market\) \?\? trade\.volumeUsdc \?\? null,/,
    "an open position's volume must be re-read from the market on every mark");
  assert.match(mark, /volume24hr: Number\.isFinite\(Number\(market\.volume24hr\)\)/);
  // marketVolumeSnapshotUsdc is the reader that excludes liquidity on purpose, which is why
  // it is the one used here.
  assert.match(bot, /function marketVolumeSnapshotUsdc\(market = \{\}\) \{\n\s+for \(const candidate of \[market\.volumeNum, market\.volume, market\.volume24hr\]\)/,
    "the mark must use traded volume, never order-book depth");

  // And the field has to survive transport, or the refresh fetches a summary that drops
  // it and the column freezes without anything looking broken. The selected portfolio's
  // trades are served whole rather than field-filtered, which is what carries the newly
  // marked volume through; the other portfolios are trimmed to balances on purpose.
  const compact = API.slice(API.indexOf("function compact_dashboard_paper_portfolio("));
  assert.match(compact.slice(0, compact.indexOf("$compact = [];")), /if \(\$includeTrades\) \{[\s\S]*?return \$portfolio;/,
    "the open portfolio's trades must reach the browser unfiltered");
  // If that ever becomes a whitelist, these two fields have to be on it.
  const fieldList = /\$fields = \[([\s\S]*?)\];/.exec(compact);
  assert.ok(fieldList, "the trimmed shape must still be a named list");
  assert.ok(!fieldList[1].includes("'trades'"),
    "trades are not part of the trimmed shape, so no field list governs them");

  // The reader itself, exercised rather than pattern-matched.
  const read = new Function(`
    ${(/function tradeVolumeUsdc\([\s\S]*?\n\}/.exec(app) || [])[0]}
    return tradeVolumeUsdc;
  `)();
  // A freshly marked position: the current figure wins over the entry one.
  assert.equal(read({ volumeUsdc: 51000, firstVolumeUsdc: 900 }), 51000);
  assert.equal(read({ volume24hr: 4200 }), 4200);
  // A live row carries no volume of its own -- the wallet history records what was bought,
  // not what the market traded -- so it reads the observation it was decorated from.
  assert.equal(read({ sourceEvaluation: { volumeUsdc: 7300 } }), 7300);
  // Order-book depth is never volume, however deep it is. This is the same mistake the
  // scraped list had, and it must not come back through this column.
  assert.equal(read({ liquidity: 99999 }), null);
  assert.equal(read({ volumeUsdc: 0, volume24hr: 0, liquidity: 15866 }), 0,
    "a market that has never traded reads zero, not its book depth");
  // Nothing recorded is unknown, and the cell says so rather than printing $0.
  assert.equal(read({}), null);
  const cell = new Function(`
    ${(/function tradeVolumeUsdc\([\s\S]*?\n\}/.exec(app) || [])[0]}
    ${(/function tradeVolumeCell\([\s\S]*?\n\}/.exec(app) || [])[0]}
    function money(value) { return "$" + Math.round(Number(value)); }
    return tradeVolumeCell;
  `)();
  assert.match(cell({}), /-<\/span>/);
  assert.equal(cell({ volumeUsdc: 1234 }), "$1234");
});

test("trade ledgers: opened and closed trades become mobile cards without horizontal scrolling", () => {
  assert.match(APP, /class="ledger-scroll trade-ledger-scroll"/,
    "trade tables need their own wrapper so other wide ledgers can keep horizontal scrolling");
  assert.match(CSS, /\.trade-ledger-scroll\s*\{\s*overflow-x: visible;/,
    "the mobile trade wrapper must not horizontally scroll");
  assert.match(CSS, /\.trade-ledger-scroll \.opened-trades-table tr,[\s\S]*?\.trade-ledger-scroll \.closed-trades-table tr \{[\s\S]*?display: grid;/,
    "each trade row should render as a boxed card on phones");
  assert.match(CSS, /\.trade-ledger-scroll \.opened-trades-table td::before,[\s\S]*?content: attr\(data-label\);/,
    "every cell keeps its column label inside the card");
  assert.match(CSS, /\.trade-ledger-scroll \.opened-trades-table \.trade-market-cell,[\s\S]*?grid-column: 1 \/ -1;/,
    "the market cell gets the full card width so long event names wrap cleanly");
});

// Requested: the candidates list must keep considering a market whose resolution datetime
// has passed, until an update confirms the event is really resolved. Gamma's end dates and
// scheduled starts are frequently wrong -- a fixture is rescheduled, a market carries a
// placeholder date, an event runs long -- and Polymarket goes on accepting orders
// throughout. Dropping those rows meant a still-tradable opportunity never reached the
// execution shortlist, refused on the strength of a date rather than on anything the
// exchange had said.
test("candidates: a passed date is not a resolution, but exchange state is", () => {
  const directory = mkdtempSync(join(tmpdir(), "active-observation-"));
  try {
    const cut = API.indexOf("\ntry {");
    const definitions = join(directory, "definitions.php");
    mkdirSync(join(directory, "data"), { recursive: true });
    writeFileSync(definitions, API.slice(0, cut) + "\n");
    const ask = (rows) => {
      const encoded = Buffer.from(JSON.stringify(rows)).toString("base64");
      return JSON.parse(execFileSync("php", ["-r",
        `require '${definitions}';`
        + ` $rows = json_decode(base64_decode('${encoded}'), true);`
        + ` echo json_encode(array_map(fn($r) => [`
        + `   is_active_scraped_market_observation($r),`
        + `   is_resolved_scraped_market_observation($r),`
        + ` ], $rows));`,
      ], { encoding: "utf8" }));
    };

    const past = "2020-01-01T00:00:00Z";
    const future = "2099-01-01T00:00:00Z";
    const [
      endedButTrading, startedButTrading, bothPast, stillAhead,
      closedStatus, settling, tooCheap, certain,
    ] = ask([
      // The reported case: the end date has passed and the market is still quoting.
      { marketProbability: 0.75, endDate: past },
      // A fixture whose scheduled start has passed but which is still accepting orders.
      { marketProbability: 0.75, scheduledEventDate: past, endDate: future },
      { marketProbability: 0.75, scheduledEventDate: past, endDate: past },
      { marketProbability: 0.75, endDate: future },
      // Evidence from the exchange, which is what actually decides it.
      { marketProbability: 0.75, endDate: future, status: "RESOLVED" },
      { marketProbability: 0.75, endDate: future, resolutionStatus: "NOT_ACCEPTING_ORDERS" },
      // The probability band is untouched by any of this.
      { marketProbability: 0.42, endDate: future },
      { marketProbability: 1, endDate: future },
    ]);

    assert.deepEqual(endedButTrading, [true, false],
      "a market past its end date is still a candidate until something says it resolved");
    assert.deepEqual(startedButTrading, [true, false],
      "so is one whose scheduled start has passed");
    assert.deepEqual(bothPast, [true, false]);
    assert.deepEqual(stillAhead, [true, false]);

    // Only the exchange's own word removes it, and then it belongs to the resolved list.
    assert.deepEqual(closedStatus, [false, true], "a resolved status is what ends candidacy");
    assert.deepEqual(settling, [false, true], "as is a market that stopped accepting orders");

    // Unchanged rules, so widening the date test cannot have quietly widened these.
    assert.deepEqual(tooCheap, [false, false], "below the band is neither active nor resolved");
    assert.deepEqual(certain, [false, false]);

    // The two lists must stay disjoint, or a row would be counted twice in the tab totals.
    for (const [active, resolved] of [endedButTrading, closedStatus, settling, stillAhead]) {
      assert.ok(!(active && resolved), "a row cannot be both an active candidate and resolved");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Reported: on the Settings history tab on a phone, nothing scrolled sideways -- not the
// table, and not the tab row above it. One cause explains both. The history table was the
// only one in the app wrapped in `class="table-scroll"`, a class no stylesheet defines, so
// it had no overflow container at all. Under `.ledger table { min-width: 1280px }` it then
// stretched every ancestor past the viewport, and `.workspace { overflow-x: hidden }`
// clipped the result -- which is why the tab row could not be swiped either: it was being
// widened along with the page instead of scrolling inside itself.
test("mobile: every table rendered into the ledger sits in a scroll container the CSS defines", () => {
  // The scroll containers this stylesheet actually implements. A wrapper not in this set
  // is a class name with nothing behind it, which is the bug being pinned.
  const scrollWrappers = ["ledger-scroll", "analysis-candidate-table-wrap", "calculation-table-wrap",
    "portfolio-summary-table"];
  for (const wrapper of scrollWrappers) {
    const rule = new RegExp(`\\.${wrapper}\\s*\\{[^}]*overflow-x:\\s*(auto|scroll)`, "s");
    assert.match(CSS, rule, `.${wrapper} must actually scroll horizontally`);
  }

  // Wherever the dashboard writes its own wrapper div around a table, that wrapper has to
  // be a class the stylesheet actually implements. This is the defect exactly: `table-scroll`
  // read like a scroll container and did nothing, because no rule ever matched it. A table
  // rendered into a container declared in index.html instead (the portfolio overview writes
  // into `<div class="portfolio-summary-table">`) has no wrapper here and is not the subject.
  const wrapped = [...APP.matchAll(/<div class="([^"]*)">\s*<table[^>]*class="([^"]*)"/g)];
  assert.ok(wrapped.length >= 5, "the wrapper audit must actually find the dashboard's wrapped tables");
  for (const match of wrapped) {
    const classes = match[1].split(/\s+/).filter(Boolean);
    const scrolls = classes.some((name) => new RegExp(`\\.${name}\\s*\\{[^}]*overflow-x:\\s*(auto|scroll)`, "s").test(CSS));
    assert.ok(scrolls,
      `table "${match[2]}" is wrapped in "${match[1]}", which no stylesheet rule gives an `
      + "overflow-x to; on a phone it stretches the page instead of scrolling inside it");
  }

  // And the specific table that was broken, by name, with a width that suits four short
  // columns rather than the 1280px the wide trade tables need.
  assert.match(APP, /<div class="ledger-scroll">\s*<table class="trade-table portfolio-config-history-table">/,
    "the settings history table must use the scroll container the rest of the app uses");
  assert.doesNotMatch(APP, /class="table-scroll"/,
    "table-scroll is defined nowhere in the stylesheet; it must not come back");
  const historyWidth = /\.ledger \.portfolio-config-history-table\s*\{[^}]*min-width:\s*(\d+)px/s.exec(CSS);
  assert.ok(historyWidth, "the settings history table needs its own min-width");
  assert.ok(Number(historyWidth[1]) < 1280,
    "four short columns must not demand the wide trade tables' 1280px of sideways scrolling");
});

// Asked for on the opened-trades cards: the state chip on the outcome's line at its right
// end, each label on its own line UNDER the value rather than beside it, and Win and
// Entry / mark showing the amount and the percentage together with the percentage in
// brackets. Verified in Chromium at 390px before these were written -- the chip and the
// outcome share a top of 19px with the chip flush to the card's right edge, and both
// halves of the Win pair share a top of 93px.
test("opened trades card: value above its label, state chip on the outcome's line", () => {
  // Win now reads as one figure. The percentage is bracketed and inside the same wrapper
  // as the amount, not a second line under it.
  const winCell = APP.slice(APP.indexOf("function tradeWinCell"), APP.indexOf("function tradeVolumeUsdc"));
  assert.match(winCell, /<span class="trade-value-pair">/, "Win must wrap both halves in the shared pair");
  assert.match(winCell, /\(\$\{percentText\}\)/, "the percentage must be bracketed");
  assert.match(winCell, /percentText === "-" \? "" :/,
    "an unavailable percentage must be omitted rather than printed as '(-)'");
  // Entry / mark already had this shape; it must use the same wrapper so both behave alike.
  const priceCell = APP.slice(APP.indexOf("function tradePriceCell"), APP.indexOf("function tradeWinCell"));
  assert.match(priceCell, /class="trade-price-summary trade-value-pair"/);
  assert.match(priceCell, /\(\$\{signedPercent\(change\)\}\)/);

  // `.ledger td span` makes any span in a cell a muted block -- that rule is why the two
  // halves stacked. The pair has to outrank it by specificity, or the fix depends on file
  // order and the next edit silently undoes it.
  assert.match(CSS, /\.ledger td \.trade-value-pair\s*\{[^}]*display:\s*inline-flex/s,
    "the pair must beat `.ledger td span { display: block }` on specificity");
  assert.match(CSS, /\.ledger td \.trade-value-pair > span\s*\{[^}]*display:\s*inline/s,
    "and so must its halves");
  assert.match(CSS, /\.ledger td span\s*\{\s*display:\s*block/s,
    "the rule being overridden must still exist -- if it goes, revisit the override");

  // The card layout, inside the phone breakpoint.
  const mobile = CSS.slice(CSS.indexOf("@media (max-width: 680px)"));
  const cell = /\.trade-ledger-scroll \.opened-trades-table td,\s*\.trade-ledger-scroll \.closed-trades-table td\s*\{([^}]*)\}/s.exec(mobile);
  assert.ok(cell, "the card's cell rule must be findable");
  assert.match(cell[1], /grid-template-columns:\s*minmax\(0, 1fr\)/,
    "one column, so the value gets the card's full width instead of sharing it with the label");
  const labelRule = /\.trade-ledger-scroll \.opened-trades-table td::before,\s*\.trade-ledger-scroll \.closed-trades-table td::before\s*\{([^}]*)\}/s.exec(mobile);
  assert.ok(labelRule, "the card's label rule must be findable");
  assert.match(labelRule[1], /order:\s*2/,
    "the label must come after the value; order:2 does it whatever the cell's content is");

  // The state chip sits at the right-hand end of the outcome's line, and the market name
  // runs the full width of the card underneath it.
  //
  // A float, not a grid column. This started as two columns, and a second column reserves
  // its width for the WHOLE cell -- so every line of a long question stopped short of the
  // chip and left a ragged empty strip down the right of the card. A float shortens only
  // the line the chip actually sits on.
  const marketCell = /\.trade-ledger-scroll \.opened-trades-table \.trade-market-cell,\s*\.trade-ledger-scroll \.closed-trades-table \.trade-market-cell\s*\{([^}]*)\}/s.exec(mobile);
  assert.ok(marketCell, "the market cell rule must be findable");
  assert.match(marketCell[1], /display:\s*block/,
    "the cell must not be a grid, or a column reserves width the question cannot use");
  assert.doesNotMatch(marketCell[1], /grid-template-columns/,
    "a second column is what kept the name out of the right-hand strip");
  const chipRule = /\.trade-ledger-scroll \.trade-market-cell > \.order-chip\s*\{([^}]*)\}/s.exec(mobile);
  assert.ok(chipRule, "the chip placement rule must be findable");
  assert.match(chipRule[1], /float:\s*right/, "right-aligned, with the text flowing under it");
  // The base `.order-chip` rule sets `margin: ... !important`, so the gap to the text it is
  // floated against has to be !important too or it is silently dropped.
  assert.match(chipRule[1], /margin:[^;]*!important/,
    "the float's margin must outrank the base rule's !important margin");
});

// Agreed after the card rework: a closed row showed a generic "Settled position" chip AND
// a separate Result column saying WON -- the same fact twice, and the chip's half of it
// told you only what the closed list already says about every row in it. The chip now
// carries the result and the column is gone.
test("closed positions: the chip carries the result, and nothing repeats it", () => {
  const badge = APP.slice(APP.indexOf("function tradeTypeBadge"), APP.indexOf("function tradePriceCell"));
  assert.doesNotMatch(badge, /order-chip filled">Settled position/,
    "the chip that said nothing must be gone");
  assert.match(badge, /if \(isClosedTrade\(trade\)\) \{[\s\S]*?tradeResultTone\(trade\)[\s\S]*?tradeResultLabel\(trade\)/,
    "a settled row's chip must be its result");

  // Order matters: the specific statuses describe something a bare result does not, so
  // they must be answered before the generic result branch swallows them.
  for (const specific of ["Redeem needed", "Protective exit", "Limit order waiting"]) {
    assert.ok(badge.indexOf(specific) < badge.indexOf("if (isClosedTrade(trade)) {"),
      `"${specific}" must be decided before the generic result chip`);
  }

  // Only a verdict gets a colour. Redeemed or sold is neither good nor bad news, and
  // colouring it would claim something the status does not say.
  const tone = APP.slice(APP.indexOf("function tradeResultTone"), APP.indexOf("function tradeTypeBadge"));
  assert.match(tone, /=== "WON"\) return "won"/);
  assert.match(tone, /=== "LOST"\) return "lost"/);
  assert.match(tone, /return "filled"/);
  assert.match(CSS, /\.order-chip\.won\s*\{[^}]*color:\s*var\(--good\)/s);
  assert.match(CSS, /\.order-chip\.lost\s*\{[^}]*color:\s*var\(--danger\)/s);

  // An unknown status still says something true rather than being dropped.
  const label = APP.slice(APP.indexOf("function tradeResultLabel"), APP.indexOf("function tradeResultTone"));
  assert.match(label, /replace\(\/_\/g, " "\)/, "underscores must not reach the chip");
  assert.match(label, /: "settled"/, "a missing status still needs a word");
});

// Found while adding those chip colours: five rules referenced `--bad` and nothing defined
// it. An undefined custom property makes the declaration invalid at computed-value time,
// so all five were dead -- measured in Chromium, the "Redeem needed" chip that is meant to
// be red computed to rgb(17, 24, 39), near-black on pink.
test("palette: every custom property a rule uses is actually defined", () => {
  const defined = new Set([...CSS.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
  const used = new Set([...CSS.matchAll(/var\((--[a-z0-9-]+)(?:\s*,[^)]*)?\)/g)].map((m) => m[1]));
  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `these custom properties are used but never defined: ${missing.join(", ")}`);
  // The one this test was written for, by name, so a rename cannot quietly reintroduce it.
  assert.ok(defined.has("--bad"), "--bad must stay defined; five error-state rules depend on it");
});

// Asked for: drop the note above the Resolution label on closed rows. It read "Polymarket
// resolution", which restates the column it sits under and nothing else -- on a card,
// under a heading that already says RESOLUTION, a whole line spent saying it twice.
test("closed positions: the resolution note only survives where it explains something", () => {
  const cell = APP.slice(APP.indexOf("function resolutionCell"), APP.indexOf("function holdingCell"));
  // Matched as the ternary it was, not as the bare phrase: the phrase also appears in the
  // comment recording why it went, and an assertion its own explanation can satisfy proves
  // nothing.
  assert.doesNotMatch(cell, /\? "Polymarket resolution"/,
    "the note that restated its own heading is gone");
  // A missing date still needs saying: the value is a bare dash, and without the note
  // there is nothing to tell a missing date from a market that resolves today.
  assert.match(cell, /resolutionDate \? "" : "no Polymarket date"/,
    "a dash still has to be explained");
  // An open row keeps its countdown -- that is the note actually worth reading.
  assert.match(cell, /\$\{compactDays\(days\)\} left/);
  assert.match(cell, /awaiting settlement, \$\{compactDays\(days\)\}/);
  // And an empty note must render nothing at all rather than an empty span, which would
  // still take a line in the card's grid.
  assert.match(cell, /\$\{note \? `<span>\$\{escapeHtml\(note\)\}<\/span>` : ""\}/,
    "an empty note must not leave an empty element behind");
});

// Measured on 2026-08-30: the dashboard showed equity $98.87 while Polymarket showed
// $103.68 on the same wallet. Neither staleness (7.9 min, $0.23) nor valuation (identical
// on every shared position) explained it. The snapshot held 15 of Polymarket's 43
// positions, and one of the 28 it dropped was unresolved, actively priced -- 6.0057 shares
// at 0.8050, $4.83 -- excluded because a REDEEMED history row shared one of its keys.
// $4.83 is the whole gap, and it was counted nowhere: not in equity, not in the positions
// table, not in the executor's risk checks.
test("live sync: the closed-trade history cannot delete a position the exchange still holds", async () => {
  const { readFile } = await import("node:fs/promises");
  const sync = await readFile(new URL("../tools/live-account-sync.mjs", import.meta.url), "utf8");

  // /positions is the record of what is held now; the history records what ended. The
  // filter must therefore turn only on whether the position is resolved.
  assert.match(sync, /const openApiPositions = positions\.filter\(\(position\) => !positionLooksResolved\(position\)\);/,
    "an unresolved position the exchange reports must survive whatever the history says");
  assert.doesNotMatch(sync, /!positionLooksResolved\(position\) && !anySharedKey\(position, knownClosedKeys\)/,
    "the key match must not be able to drop a held position again");

  // The suppression it used to apply silently becomes a warning, so a genuinely stale row
  // is something to look at rather than capital quietly going missing.
  assert.match(sync, /position-history-overlap-/,
    "an overlap must still be reported, just not acted on");
  assert.match(sync, /kept an unresolved position of \$\{shares\.toFixed\(4\)\} shares/);

  // Resolved positions still leave the open list -- that half was correct and is what makes
  // the 29 worthless settled rows in the same measurement correctly excluded.
  assert.match(sync, /function positionLooksResolved\(position\) \{\s*return positionOfficiallyResolved\(position\);/);
  assert.match(sync, /return Boolean\(position\.redeemable \|\| position\.claimable \|\| position\.resolved\);/);
});

// Reported: the dashboard listed candidates as READY -- 78.0% and 81.5%, $303k and $275k of
// volume, resolving the next day -- while every run logged "No order placed: none of the
// candidates passed the fresh Polymarket verification". They never reached verification.
// The measured run revalidated exactly 1 of 1200 rows and dropped 213 for "market type
// multi does not match live portfolio market type binary".
//
// Three implementations classify a market and they must agree, because one decides what the
// screen lists (api.php), one decides what the browser shows (app.js) and one decides what
// the executor will trade (live-order-executor.mjs). Two agreed; the executor's was an
// earlier, cruder rule with no "vs" test at all, so every two-sided fixture on the board was
// visible on screen and invisible to the run.
//
// A table of shapes, checked against all three at once. This is the only thing that keeps
// them together: they are three languages' worth of the same rule and nothing else links
// them.
test("market type: api.php, the browser and the executor classify identically", async () => {
  const executor = await import("../tools/live-order-executor.mjs");

  const cases = [
    // The reported shape. Two named sides -- "vs" settles it before any question-word guess.
    [{ question: "US Open ATP: Yibing Wu vs Adam Walton", outcome: "Yibing Wu" }, "binary"],
    [{ question: "US Open WTA: Renata Zarazua vs Polina Iatcenko", outcome: "Renata Zarazua" }, "binary"],
    [{ question: "LoL: Gen.G vs KT Rolster (BO5) - LCK Playoffs", outcome: "Gen.G" }, "binary"],
    [{ question: "Team Spirit vs Team Liquid - Game 2 Winner", outcome: "Team Spirit" }, "binary"],
    // Two-sided vocabulary without "vs".
    [{ question: "Spread: Arsenal FC (-2.5)", outcome: "Aston Villa FC" }, "binary"],
    [{ question: "Alex Michelsen vs. Federico Cina: Total Sets O/U 4.5", outcome: "Under 4.5" }, "binary"],
    // A field of alternatives, whatever one member's book looks like.
    [{ question: "Exact Score: Any Other Score?", outcome: "No" }, "multi"],
    [{ question: "Who will win the 2028 Democratic nomination?", outcome: "Gavin Newsom" }, "multi"],
    [{ question: "Will Georgia Tree win the 2026 Secret Harbour state by-election?", outcome: "Yes" }, "multi"],
    // A bracket is one band of a range carved into several, even though it opens with "Will".
    [{ question: "Will \"Grand Theft Auto VI Extended Look\" get 10-15 million views?", outcome: "Yes" }, "multi"],
    [{ question: "Will the highest temperature in London be 20-24°C on August 29?", outcome: "Yes" }, "multi"],
    // A range spelled out in words is NOT caught -- the rule looks for a hyphenated bracket,
    // so this reads as a plain Yes/No proposition. Pinned as it is rather than as it might
    // ideally be: all three agree, which is what this test is for, and a change here has to
    // be made in three places at once.
    [{ question: "Will \"Grand Theft Auto VI Extended Look\" get between 10 and 15 million views?", outcome: "Yes" }, "binary"],
    // A plain proposition about one thing happening or not.
    [{ question: "Will 1. FC Köln win on 2026-08-30?", outcome: "No" }, "binary"],
    [{ question: "Will WTI Crude Oil (WTI) hit (LOW) $80 in August?", outcome: "No" }, "binary"],
    // One entity named against a competition rather than an opponent.
    [{ question: "Real Madrid wins the Champions League", outcome: "Real Madrid" }, "multi"],
    // More than two outcomes is a field -- but only after the two-sided tests, because a
    // home/draw/away result carries three and is still one fixture.
    [{ question: "Serie A: Napoli vs Cagliari", outcome: "Draw", outcomeCount: 3 }, "binary"],
    [{ question: "Season standing", outcome: "Third", outcomeCount: 6 }, "multi"],
  ];

  // The executor, which is the implementation that was wrong.
  for (const [item, expected] of cases) {
    assert.equal(executor.candidateMarketType(item), expected,
      `executor: ${JSON.stringify(item.question)} [${item.outcome}]`);
  }

  // The browser's copy, extracted and run.
  const browser = new Function(
    `${extractFunction(APP, "candidateMarketType")}
     ${/const MULTI_OUTCOME_FIELD = new RegExp\(\[[\s\S]*?\]\.join\("\|"\), "i"\);/.exec(APP)[0]}
     ${/const BRACKET_RANGE_QUESTION = [^\n]+/.exec(APP)[0]}
     ${/const TWO_SIDED_EVENT = new RegExp\(\[[\s\S]*?\]\.join\("\|"\), "i"\);/.exec(APP)[0]}
     ${/const TWO_SIDED_OUTCOMES = new Set\(\[[\s\S]*?\]\);/.exec(APP)[0]}
     return candidateMarketType;`)();
  for (const [item, expected] of cases) {
    assert.equal(browser(item), expected, `browser: ${JSON.stringify(item.question)} [${item.outcome}]`);
  }

  // And api.php, driven for real rather than restated.
  const directory = mkdtempSync(join(tmpdir(), "market-type-"));
  try {
    const cut = API.indexOf("\ntry {");
    assert.ok(cut > 0, "api.php still ends with its request dispatch");
    const definitions = join(directory, "definitions.php");
    mkdirSync(join(directory, "data"), { recursive: true });
    writeFileSync(definitions, API.slice(0, cut) + "\n");
    const encoded = Buffer.from(JSON.stringify(cases.map(([item]) => item))).toString("base64");
    const output = execFileSync("php", ["-r",
      `require '${definitions}';`
      + ` $rows = json_decode(base64_decode('${encoded}'), true);`
      + ` echo json_encode(array_map(fn($r) => observation_market_type($r), $rows));`,
    ], { encoding: "utf8" });
    const php = JSON.parse(output);
    cases.forEach(([item, expected], index) => {
      assert.equal(php[index], expected, `api.php: ${JSON.stringify(item.question)} [${item.outcome}]`);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  // The executor must not short-circuit on a stored marketType either: neither of the other
  // two reads one, so a row carrying a value from the old rule would keep its wrong answer
  // for as long as it was retained.
  assert.equal(executor.candidateMarketType({
    question: "US Open ATP: Yibing Wu vs Adam Walton", outcome: "Yibing Wu", marketType: "multi",
  }), "binary", "a stored classification must not override the shared rule");
});

// The reported worry: the catalogue reports 5000 scraped markets and the executor might be
// sidelining opportunities. Measured, the retention cap was not the ceiling -- the serving
// cut was. scoped_execution_observations() ranked its rows only when a strategy id was
// supplied, and the live executor supplies none, so it received the first 1200 rows of the
// stored catalogue in storage order. Storage order is "most recently updated first", which
// is unrelated to whether a market is worth an order: on production 4998 rows were in
// scope, 1200 were served, and 3579 markets inside the portfolio's own two-day horizon
// never reached the run at all.
test("execution scope: rows are ranked before the page is cut, with or without a strategy", () => {
  const directory = mkdtempSync(join(tmpdir(), "execution-scope-"));
  try {
    const cut = API.indexOf("\ntry {");
    assert.ok(cut > 0, "api.php still ends with its request dispatch");
    const definitions = join(directory, "definitions.php");
    mkdirSync(join(directory, "data"), { recursive: true });
    writeFileSync(definitions, API.slice(0, cut) + "\n");
    const scope = (rows, offset = 0) => {
      const encoded = Buffer.from(JSON.stringify(rows)).toString("base64");
      const [served, total, truncated, servedOffset] = JSON.parse(execFileSync("php", ["-r",
        `require '${definitions}';`
        + ` $rows = json_decode(base64_decode('${encoded}'), true);`
        + ` [$a, $t, $x, $o] = scoped_execution_observations($rows, null, ${offset});`
        + ` echo json_encode([array_column($a, 'id'), $t, $x, $o]);`,
      ], { encoding: "utf8" }));
      return { served, total, truncated, offset: servedOffset };
    };

    const future = "2099-01-01T00:00:00Z";
    // Deliberately listed worst-first, so storage order and ranked order disagree.
    const rows = [
      { id: "weak", marketProbability: 0.9, endDate: future, marketAnnualizedReturn: 0.05, daysToResolution: 1 },
      { id: "strong", marketProbability: 0.9, endDate: future, marketAnnualizedReturn: 4.2, daysToResolution: 3 },
      { id: "middling", marketProbability: 0.9, endDate: future, marketAnnualizedReturn: 1.1, daysToResolution: 2 },
    ];
    const ranked = scope(rows);
    assert.deepEqual(ranked.served, ["strong", "middling", "weak"],
      "an unscoped execution request must still rank by annualized return, not by storage order");
    assert.equal(ranked.total, 3);
    assert.equal(ranked.truncated, false, "a scope that fits in one page is not truncated");
    assert.equal(ranked.offset, 0);

    // And the rest of the scope has to be reachable rather than merely absent: an offset
    // is what turns "capped transport" into "paged transport".
    const page = scope(rows, 2);
    assert.deepEqual(page.served, ["weak"], "an offset serves the next slice of the same ranking");
    assert.equal(page.total, 3, "the total reports the whole scope, not the page");
    assert.equal(page.offset, 2);

    // The page width is published so a caller can compute the next offset instead of
    // guessing it, and so a caller talking to an endpoint that predates paging can tell.
    const branch = API.slice(API.indexOf("if ($summary === 'execution') {"));
    const body = branch.slice(0, branch.indexOf("\n    }"));
    assert.match(body, /'executionScopeOffset' => \$offset/, "the execution payload reports its offset");
    assert.match(body, /'executionScopeLimit' => EXECUTION_SCOPE_PAGE_LIMIT/, "the execution payload reports its page width");
    assert.match(API, /\$executionOffset = max\(0, \(int\) \(\$_GET\['offset'\] \?\? 0\)\)/,
      "the request handler reads the offset");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("execution scope: custom live portfolios resolve their own saved filter", () => {
  const scopeConfig = /function execution_scope_strategy_config\([\s\S]*?\n\}/.exec(API);
  assert.ok(scopeConfig);
  assert.match(scopeConfig[0], /\^live-custom-\(\[a-z\]\[a-zA-Z0-9\]\{1,30\}\)\$/,
    "a custom live mode must be recognised as a portfolio scope");
  assert.match(scopeConfig[0], /\$config\['livePortfolios'\]\[\$id\]/,
    "the candidates endpoint must use the custom live portfolio's saved rules, not the unfiltered catalogue");
  const candidateReasons = /function portfolioCandidateFilterReasons\([\s\S]*?\n\}/.exec(APP);
  assert.ok(candidateReasons);
  assert.match(candidateReasons[0], /maximumProbability != null && selectedProbability > maximumProbability/,
    "the browser must also explain and reject candidates above a portfolio's maximum probability");
});

// Reported missing later, alongside its paper-bot and live-executor twins: the general
// (non-fixed-entry) branch of this preview lost both its resolution-day ceiling and its
// "missing resolution date" reason. Neither is the "has this market ended" question --
// that is answered by portfolioEvaluationStatus/evaluationResolvedByMarket, already
// checked earlier in this same function via displayStatus -- so both stay independent of
// the market-status fix.
test("candidate reasons: the general branch still caps a portfolio's resolution ceiling", () => {
  const reasons = extractFunction(APP, "portfolioCandidateFilterReasons");
  assert.match(reasons, /const maxHours = resolutionHoursForMode\(normalizedMode\);/);
  // Counted to the market's own resolution date. The catalogue's endDate is the KICKOFF
  // for a sports fixture, so the stored day count is time to the start of the match.
  assert.match(reasons, /const hours = candidateHoursToResolution\(item\);/);
  assert.match(reasons, /if \(!Number\.isFinite\(hours\)\) \{\s*\n\s*reasons\.push\("missing resolution date"\);\s*\n\s*\} else if \(horizonApplies\(liveEventMode, eventIsRunning\) && hours > maxHours\) \{/);
  // The horizon and "has it started" are separate questions, so an un-started row is
  // refused on its own reason rather than being folded into the ceiling.
  assert.match(reasons, /liveEventMode === "only" && !eventIsRunning/);
  // And the fixed-entry (5050) branch keeps its own, symmetric checks.
  const branch = /if \(isFixedEntryMode\(mode\)\) \{[\s\S]*?return reasons;\n  \}/.exec(reasons)[0];
  assert.match(branch, /horizonApplies\(liveEventMode, eventIsRunning\)/);
  assert.match(branch, /liveEventMode === "only" && !eventIsRunning/);

  // The reader has to be able to see which rule bit: the ceiling and the in-play setting
  // give different sentences.
  const hoursHelper = extractFunction(APP, "candidateHoursToResolution");
  assert.match(hoursHelper, /Date\.parse\(item\?\.resolutionEndDate \|\| ""\)/);
});

test("scraped opportunities: the spread that keeps a market out of scope is on screen", () => {
  const css = readFileSync(new URL("../assets/app.css", import.meta.url), "utf8");
  const api = readFileSync(new URL("../api.php", import.meta.url), "utf8");

  // Measured on "2nd Half Spread: VfB Stuttgart (-1.5)": 78.0% probability inside the
  // portfolio's 0.72-0.82 band, $22,347.98 volume against a 20,000 minimum, 2.17 days
  // against a 7-day ceiling, not an Over/Under, soccer tags not excluded -- and a book of
  // 0.13 / 0.31. api.php's execution_scope_matches_observation refused it on that one
  // gate, correctly: an 18-point spread has no counterparty at 78%. Nothing on screen
  // said so, which is why it read as a missed opportunity.
  assert.match(APP, /function scrapedSpreadCell\(item = \{\}\)/);
  assert.match(APP, /scrapedSortableHeader\("spread", "Spread"\)/);
  assert.match(APP, /<td data-label="Spread">\$\{scrapedSpreadCell\(item\)\}<\/td>/);

  // The ceiling shown must be the ceiling enforced, or the column explains the wrong rule.
  const phpCeiling = /const MAX_TRADABLE_SPREAD = ([\d.]+);/.exec(api);
  assert.ok(phpCeiling, "api.php must state the tradable ceiling");
  const uiCeiling = /const SCRAPED_MAX_TRADABLE_SPREAD = ([\d.]+);/.exec(APP);
  assert.ok(uiCeiling, "the UI must state the ceiling it compares against");
  assert.equal(uiCeiling[1], phpCeiling[1], "the displayed ceiling must be the enforced one");

  // Derived from the book when the row has no stored spread, so an older row is not shown
  // as unknown while the gate reads it from bestBid/bestAsk.
  const cell = APP.slice(APP.indexOf("function scrapedObservationSpread"), APP.indexOf("function scrapedVolumeCell"));
  assert.match(cell, /numericOrNull\(item\.bestBid\)/);
  assert.match(cell, /numericOrNull\(item\.bestAsk\)/);
  // An unrecorded spread is admitted by the gate, so it must not be flagged as untradable
  // and must not sort as the tightest book.
  assert.match(cell, /A row with no spread is admitted rather than refused/);
  assert.match(APP, /if \(key === "spread"\) return scrapedObservationSpread\(item\) \?\? Infinity;/);
  assert.match(css, /\.negative\b/, "the untradable marker needs its colour to exist");
});

// Reported: a live position lost its whole stake with no stop loss. Measured on
// production, 2 of 12 open positions were absent from the RPi exit worker's policy
// payload -- because that payload was built by walking each portfolio's execution RUN LOG
// and collecting the tokens of runs that submitted an order. The run log is bounded and
// compacted, so a position stops being watched once its run scrolls out, while it is still
// open and still holding money.
test("live stop loss: an open position is watched even when its run has left the log", () => {
  const directory = mkdtempSync(join(tmpdir(), "stop-loss-policy-"));
  try {
    const cut = API.indexOf("\ntry {");
    const definitions = join(directory, "definitions.php");
    mkdirSync(join(directory, "data"), { recursive: true });
    writeFileSync(definitions, API.slice(0, cut) + "\n");

    // A live portfolio with a 1.75 cap, an execution run log that remembers ONE of two
    // open positions, and an account holding both.
    writeFileSync(join(directory, "data", "portfolio-config.json"), JSON.stringify({
      live: { displayName: "Live", stopLossRiskMultiplier: 1.75, minProbability: 0.5 },
    }));
    writeFileSync(join(directory, "data", "live-execution-state.json"), JSON.stringify({
      generatedAt: "2026-09-02T10:00:00Z",
      action: "SUBMITTED",
      // The shape live_execution_record_token_ids actually reads: one `selected`
      // candidate per record, not a list of attempts.
      selected: { tokenId: "remembered-token" },
      runLog: [],
    }));
    writeFileSync(join(directory, "data", "live-state.json"), JSON.stringify({
      positions: [
        { tokenId: "remembered-token", question: "Still in the run log" },
        { tokenId: "forgotten-token", question: "Its run scrolled out of the log" },
      ],
    }));

    const payload = JSON.parse(execFileSync("php", ["-r",
      `chdir('${directory}'); require '${definitions}';`
      + ` echo json_encode(live_stop_loss_policy_payload());`,
    ], { encoding: "utf8", cwd: directory }));

    const covered = new Map((payload.policies || []).map((policy) => [policy.tokenId, policy]));
    assert.ok(covered.has("remembered-token"), "a token its run still names stays watched");
    assert.ok(covered.has("forgotten-token"),
      "an open position must be watched even when no retained run names it");
    // The multiplier has to be the configured one, or the worker would exit at a floor
    // the operator never set.
    assert.equal(covered.get("forgotten-token").stopLossRiskMultiplier, 1.75);
    assert.equal(covered.get("forgotten-token").source, "open-position",
      "and it must say where the coverage came from");
    // Attribution still wins: a token its own run claimed keeps that run's stamp.
    assert.equal(covered.get("remembered-token").source ?? "", "",
      "a run-attributed token is not relabelled as an account fallback");

    assert.equal(payload.openPositions, 2);
    assert.equal(payload.positionsWithoutRunLogAttribution, 1);
    assert.equal(payload.positionsAdoptedFromAccount, 1);
    assert.equal(payload.positionsLeftUnwatched, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live stop loss: with no default policy an unattributed position is reported, not invented", () => {
  const directory = mkdtempSync(join(tmpdir(), "stop-loss-nodefault-"));
  try {
    const cut = API.indexOf("\ntry {");
    const definitions = join(directory, "definitions.php");
    mkdirSync(join(directory, "data"), { recursive: true });
    writeFileSync(definitions, API.slice(0, cut) + "\n");

    // The main live portfolio has no stop loss. Applying one anyway would exit a position
    // at a cap the operator never set, so the position stays unwatched -- and the payload
    // says so rather than leaving the gap silent.
    writeFileSync(join(directory, "data", "portfolio-config.json"), JSON.stringify({
      live: { displayName: "Live", stopLossRiskMultiplier: 0 },
    }));
    writeFileSync(join(directory, "data", "live-state.json"), JSON.stringify({
      positions: [{ tokenId: "unwatched-token", question: "No policy covers this" }],
    }));

    const payload = JSON.parse(execFileSync("php", ["-r",
      `chdir('${directory}'); require '${definitions}';`
      + ` echo json_encode(live_stop_loss_policy_payload());`,
    ], { encoding: "utf8", cwd: directory }));

    assert.deepEqual(payload.policies, []);
    assert.equal(payload.defaultPolicy, null);
    assert.equal(payload.positionsWithoutRunLogAttribution, 1);
    assert.equal(payload.positionsAdoptedFromAccount, 0);
    assert.equal(payload.positionsLeftUnwatched, 1,
      "an uncovered position must be counted, so the gap is visible");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Reported: a live portfolio that HAS a stop loss configured is switched off, and its open
// positions must not be closed by that stop until it is switched back on. Two separate
// things had to be true for the switch to mean that, and neither was:
//
//   * the policy ignored automationEnabled entirely, so a switched-off portfolio kept a
//     live stop;
//   * omitting the token would not have been enough anyway, because the worker applies
//     defaultPolicy to every position NOT named in `policies` -- so the position would have
//     been sold under the main Live portfolio's cap instead of its own portfolio's.
// Reported on "Will Wrexham AFC win on 2026-09-05?": priced at 100% for the outcome held,
// its portfolio switched off, and "in the policy payload now: no". Switching a portfolio off
// stops it OPENING positions -- it does not abandon the money already committed, and this
// used to drop every position it held out of the worker's watch list entirely.
//
// The paper side has always drawn the line here: refreshTrades marks and manages every
// portfolio's open positions on every pass, and only the entry path consults the switch.
test("live stop loss: a switched-off portfolio keeps managing what it already holds", () => {
  const directory = mkdtempSync(join(tmpdir(), "stop-loss-automation-off-"));
  try {
    const cut = API.indexOf("\ntry {");
    const definitions = join(directory, "definitions.php");
    mkdirSync(join(directory, "data"), { recursive: true });
    writeFileSync(definitions, API.slice(0, cut) + "\n");

    // Live is on and protected. The custom portfolio has a stop loss and a reversal
    // configured too, but its automation is off -- and it is the one holding
    // `sleeping-token`.
    writeFileSync(join(directory, "data", "portfolio-config.json"), JSON.stringify({
      live: { displayName: "Live", stopLossRiskMultiplier: 1.75, automationEnabled: true },
      livePortfolios: {
        live2: {
          displayName: "Live 2",
          stopLossRiskMultiplier: 1.75,
          reverseOnStopLoss: true,
          settlementCloseBid: 0.99,
          automationEnabled: false,
        },
      },
    }));
    writeFileSync(join(directory, "data", "live-execution-state.json"), JSON.stringify({
      generatedAt: "2026-09-02T10:00:00Z", action: "SUBMITTED",
      selected: { tokenId: "live-token" }, runLog: [],
    }));
    writeFileSync(join(directory, "data", "live-live2-execution-state.json"), JSON.stringify({
      generatedAt: "2026-09-02T11:00:00Z", action: "SUBMITTED",
      selected: { tokenId: "sleeping-token" }, runLog: [],
    }));
    writeFileSync(join(directory, "data", "live-state.json"), JSON.stringify({
      positions: [
        { tokenId: "live-token", question: "Held by the portfolio that is running" },
        { tokenId: "sleeping-token", question: "Held by the portfolio that is switched off" },
      ],
    }));

    const payload = JSON.parse(execFileSync("php", ["-r",
      `chdir('${directory}'); require '${definitions}';`
      + ` echo json_encode(live_stop_loss_policy_payload());`,
    ], { encoding: "utf8", cwd: directory }));

    const covered = new Map((payload.policies || []).map((policy) => [policy.tokenId, policy]));
    assert.ok(covered.has("live-token"), "the running portfolio keeps its stop");
    assert.ok(covered.has("sleeping-token"),
      "a switched-off portfolio still protects the position it is holding");
    const sleeping = covered.get("sleeping-token");
    assert.equal(sleeping.portfolioId, "live-custom-live2");
    assert.equal(sleeping.stopLossRiskMultiplier, 1.75, "with its own cap, not somebody else's");
    assert.equal(sleeping.settlementCloseBid, 0.99, "and its own certainty close");
    assert.equal(sleeping.automationEnabled, false);
    // Including the reversal. "Off" stops the portfolio evaluating and opening positions
    // of its own; it does not stand down over what it already holds, and the reversal is
    // part of how the stop closes such a position rather than a new idea of its own.
    assert.equal(sleeping.reverseOnStopLoss, true,
      "a switched-off portfolio's stop may still take the opposite side");
    // The running portfolio's reversal is untouched by any of this.
    assert.equal(covered.get("live-token").automationEnabled, true);

    // Nothing is excluded for being switched off any more.
    const excluded = new Map((payload.excluded || []).map((row) => [row.tokenId, row]));
    assert.ok(!excluded.has("sleeping-token"));
    assert.equal(payload.positionsExcludedByOwner, 0);
    // It must not be re-counted as unattributed and adopted by the fallback, which is the
    // path that would have applied Live's cap to another portfolio's position.
    assert.equal(payload.positionsWithoutRunLogAttribution, 0);
    assert.equal(payload.positionsAdoptedFromAccount, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Reported: the "counter-strike-2" portfolio never opens a position. Its one candidate,
// measured on production, read p=0.805 and bestBid=0.19 on the same row -- 1 - 0.81, the
// other side of the same book -- because the row selects the favourite outcome while
// bestBid/bestAsk were copied from the market-level quote, which describes token 0.
//
// The equal-risk gate then measured the selected side's stop floor against the wrong
// side's bid and refused every run. So the mirror matters, and its direction matters more:
// a bid mirrors the ASK. Getting that backwards produces numbers that look plausible and
// are wrong by the spread, which no eye would catch on a dashboard.
test("catalogue row: the quote belongs to the outcome the row selected", async () => {
  const { selectedOutcomeQuote } = await import("../tools/paper-trading-bot.mjs");
  const market = { bestBid: 0.19, bestAsk: 0.20 };

  // Token 0 is what Gamma's quote already describes, so it is copied through untouched.
  assert.deepEqual(selectedOutcomeQuote(market, 0, 2), { bestBid: 0.19, bestAsk: 0.20 });

  // Token 1 is the other side of the same book. Its bid is 1 - the stored ASK.
  const mirrored = selectedOutcomeQuote(market, 1, 2);
  assert.deepEqual(mirrored, { bestBid: 0.80, bestAsk: 0.81 });
  assert.ok(mirrored.bestBid < mirrored.bestAsk, "the mirror must not invert the spread");
  assert.equal(Number((mirrored.bestAsk - mirrored.bestBid).toFixed(4)), 0.01,
    "and must preserve its width");

  // The reported row: a favourite at 80.5% must not carry the 19% bid that blocked it.
  assert.ok(mirrored.bestBid > 0.5,
    "a bid on the favourite side reads as the favourite, not as its complement");

  // Only a two-token book has a complement to mirror. Anything else is left alone rather
  // than guessed at -- a wrong quote is worse than the one already stored.
  assert.deepEqual(selectedOutcomeQuote(market, 1, 3), { bestBid: 0.19, bestAsk: 0.20 });
  // A missing side stays missing; 1 - null is not a price.
  assert.deepEqual(selectedOutcomeQuote({ bestBid: 0.19 }, 1, 2), { bestBid: null, bestAsk: 0.81 });
});

// Reported as critical: "Underway Live" has no working stop loss. Caused by the commit
// that introduced PENDING_MATCH -- ownership is decided by the run record's action, that
// list was not updated, and an in-play portfolio opens almost entirely through queued
// fill-and-kill orders. Every position it opened stopped having an owner, fell out of the
// policy payload, and went unwatched.
//
// The asymmetry is the whole point, and it is why the mistake was easy to make: a queued
// order is NOT a position, which is why the run log must not call it one -- but it IS this
// portfolio's order, which is all ownership asks. A position that does not exist yet needs
// no stop; one that appears later needs its OWN portfolio's, and this record is the only
// thing that says whose it is.
test("live stop loss: a position opened by a queued order is still its portfolio's", () => {
  const directory = mkdtempSync(join(tmpdir(), "stop-loss-pending-match-"));
  try {
    const cut = API.indexOf("\ntry {");
    const definitions = join(directory, "definitions.php");
    mkdirSync(join(directory, "data"), { recursive: true });
    writeFileSync(definitions, API.slice(0, cut) + "\n");

    writeFileSync(join(directory, "data", "portfolio-config.json"), JSON.stringify({
      live: { displayName: "Live", stopLossRiskMultiplier: 1.75, automationEnabled: true },
      livePortfolios: {
        underway: {
          displayName: "Underway Live",
          stopLossRiskMultiplier: 2.5,
          automationEnabled: true,
          useLimitOrders: false,
        },
      },
    }));
    writeFileSync(join(directory, "data", "live-execution-state.json"), JSON.stringify({
      generatedAt: "2026-09-06T10:00:00Z", action: "SUBMITTED",
      selected: { tokenId: "live-token" }, runLog: [],
    }));
    // The shape the in-play portfolio actually writes: the exchange took a fill-and-kill
    // order, answered "delayed", and the match filled a few minutes later.
    writeFileSync(join(directory, "data", "live-underway-execution-state.json"), JSON.stringify({
      generatedAt: "2026-09-06T11:00:00Z", action: "PENDING_MATCH",
      selected: { tokenId: "queued-token" }, runLog: [],
    }));
    writeFileSync(join(directory, "data", "live-state.json"), JSON.stringify({
      positions: [
        { tokenId: "live-token", question: "Opened by an order that matched at once" },
        { tokenId: "queued-token", question: "Opened by an order whose match was queued" },
      ],
    }));

    const payload = JSON.parse(execFileSync("php", ["-r",
      `chdir('${directory}'); require '${definitions}';`
      + ` echo json_encode(live_stop_loss_policy_payload());`,
    ], { encoding: "utf8", cwd: directory }));

    const covered = new Map((payload.policies || []).map((policy) => [policy.tokenId, policy]));
    assert.ok(covered.has("queued-token"),
      "a position opened through a queued match is watched like any other");
    const queued = covered.get("queued-token");
    assert.equal(queued.portfolioId, "live-custom-underway");
    // Under its OWN cap. Falling through to the fallback would have protected it at the
    // main Live portfolio's 1.75 instead of the 2.5 this portfolio chose, which is a
    // different trade being managed under somebody else's risk.
    assert.equal(queued.stopLossRiskMultiplier, 2.5);

    assert.equal(payload.positionsWithoutRunLogAttribution, 0,
      "and it is not counted as unattributed");
    assert.equal(payload.positionsAdoptedFromAccount, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The structural half of the fault above: two lists, in two languages, that have to agree
// about which actions mean "this portfolio sent an order". They drifted once and cost a
// live portfolio its stop loss, so the agreement is asserted rather than remembered.
test("live stop loss: every action the executor writes for an accepted order confers ownership", () => {
  const owning = API.slice(API.indexOf("LIVE_EXECUTION_SUBMITTED_ACTIONS"));
  const list = owning.slice(0, owning.indexOf("]"));

  // Every action the executor can write once successfulOrderResponse said the exchange
  // took the order. Read off the submission site rather than restated from memory.
  for (const action of ["SUBMITTED", "CANCELED_AND_SUBMITTED", "PENDING_MATCH"]) {
    assert.ok(EXECUTOR.includes(`"${action}"`),
      `the executor still writes ${action}; if it stopped, this test is the thing to update`);
    assert.ok(list.includes(`'${action}'`),
      `${action} means this portfolio sent an order, so it must confer ownership of the position`);
  }
});

// The entry guard exists so the same position is not opened twice at one moment. It used
// to answer that by remembering for ninety days that somebody had once submitted an order,
// which is a different question and a worse one: an order that was killed bought nothing
// and blocked its outcome for three months, while an order that filled was already covered
// by the executor's own held/resting checks, so the memory added nothing either way.
//
// It now asks the account. The one piece of timekeeping left is causal rather than clocked
// -- has the account been read SINCE this claim was made -- which is what separates "the
// order produced nothing" from "the order is still in flight".
test("live entry guard: the account decides, not the clock", () => {
  const directory = mkdtempSync(join(tmpdir(), "entry-guard-"));
  // A real Polymarket token id: the guard requires one, and a short stand-in is refused
  // before any of this logic is reached.
  const TOKEN = "11122233344455566677788899900011122233";
  const claim = (liveState, claims, tokenId = TOKEN) => {
    mkdirSync(join(directory, "data"), { recursive: true });
    writeFileSync(join(directory, "data", "live-state.json"), JSON.stringify(liveState));
    writeFileSync(join(directory, "data", "live-entry-claims.json"), JSON.stringify({ claims }));
    const cut = API.indexOf("\ntry {");
    const definitions = join(directory, "definitions.php");
    writeFileSync(definitions, API.slice(0, cut) + "\n");
    const payload = Buffer.from(JSON.stringify({
      operation: "claim", tokenId, side: "BUY", portfolioId: "underway",
      claimId: "abcdefghijklmnop0123",
    })).toString("base64");
    return JSON.parse(execFileSync("php", ["-r",
      `chdir('${directory}'); require '${definitions}';`
      + ` echo json_encode(live_entry_claim_request(json_decode(base64_decode('${payload}'), true)));`,
    ], { encoding: "utf8", cwd: directory }));
  };
  try {
    const observed = { generatedAt: "2026-09-06T12:00:00Z" };
    const madeAt = { tokenId: TOKEN, side: "BUY", portfolioId: "x", claimId: "y", status: "claimed" };

    // Nothing held, nothing claimed: the ordinary case, and it must not be blocked.
    assert.equal(claim({ ...observed, positions: [] }, {}).claimed, true);

    // The duplicate the guard is FOR, and it is decided by the account alone -- no claim
    // is on file here at all, and it is still refused.
    const held = claim({ ...observed, positions: [{ tokenId: TOKEN }] }, {});
    assert.equal(held.claimed, false);
    assert.match(held.reason, /already holds this outcome/);

    // A resting BUY is not a position yet but is already this outcome's order.
    const resting = claim({ ...observed, positions: [], openOrders: [{ tokenId: TOKEN, side: "BUY" }] }, {});
    assert.equal(resting.claimed, false);
    assert.match(resting.reason, /already resting/);

    // A resting SELL is an exit. It must not block a buy.
    assert.equal(claim({ ...observed, positions: [], openOrders: [{ tokenId: TOKEN, side: "SELL" }] }, {}).claimed,
      true, "a resting exit is not a second entry");

    // In flight: a claim was made and the account has NOT been read since. This really
    // would be the second order for one outcome.
    const inFlight = claim(
      { generatedAt: "2026-09-06T12:00:00Z", positions: [] },
      { [`BUY:${TOKEN}`]: { ...madeAt, claimedAt: "2026-09-06T12:00:30Z" } },
    );
    assert.equal(inFlight.claimed, false);
    assert.match(inFlight.reason, /in flight/);

    // The case that used to cost three months: the account HAS been read since the claim
    // and shows nothing behind it, so whatever was submitted did not become anything. A
    // killed fill-and-kill leaves exactly this, and the outcome is free again.
    const producedNothing = claim(
      { generatedAt: "2026-09-06T12:05:00Z", positions: [] },
      { [`BUY:${TOKEN}`]: { ...madeAt, claimedAt: "2026-09-06T12:00:30Z" } },
    );
    assert.equal(producedNothing.claimed, true,
      "a claim the account has since looked past no longer blocks its outcome");

    // An account that has never spoken cannot clear a claim -- absent evidence is not
    // evidence of absence, and this is the direction that risks a double position.
    assert.equal(claim({ positions: [] }, { [`BUY:${TOKEN}`]: { ...madeAt, claimedAt: "2026-09-06T12:00:30Z" } }).claimed,
      false, "with no observation time, the in-flight claim stands");

    // The retention sweep is housekeeping, not the guard, and must not be read as one.
    assert.ok(/Housekeeping so this file cannot grow without limit[\s\S]{0,400}NOT the guard/.test(API));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Asked for: when a stop takes the opposite side, the closed row of the position it sold
// should say so, behind an "i". That row is the only place the reader is looking when the
// question comes up -- the reversal is a separate position, opened seconds later under a
// different outcome, and nothing on it says where it came from.
//
// Paper and live store the fact differently and mean the same thing, so one reader serves
// both. Asserting that here is the point of the test: a live-only note could only ever be
// checked with real money.
test("closed trades: a stopped position explains the reversal it produced", () => {
  const note = new Function("trade", `
    ${extractFunction(APP, "numericOrNull")}
    ${extractFunction(APP, "percent")}
    ${extractFunction(APP, "escapeHtml")}
    ${extractFunction(APP, "stopLossReversalNote")}
    return stopLossReversalNote(trade);
  `);

  // A position with no reversal says nothing at all -- the note must not appear on every
  // stopped row and mean nothing.
  assert.equal(note({ status: "STOP_LOSS" }), "");

  // Paper: written onto the stopped trade itself.
  const paper = note({
    status: "STOP_LOSS",
    stopLossReversalStatus: "OPENED",
    stopLossReversalOutcome: "No",
    stopLossReversalShares: 6.25,
    stopLossReversalPrice: 0.32,
  });
  assert.match(paper, /Reversed/);
  assert.match(paper, /class="info-button"/, "reached through an i, not printed inline");
  assert.match(paper, /role="tooltip"/);
  assert.match(paper, /&quot;No&quot;/, "names the side that was bought");
  assert.match(paper, /6\.25 shares at 32/, "and what was paid for it");
  assert.match(paper, /closed and its result is final/,
    "and says the reversal's outcome is counted on its own row, not this one");

  // Live: the same fact arriving on the position from the exit record.
  const live = note({
    exitReason: "stop",
    exitReversal: { status: "OPENED", outcome: "Yes", shares: 5, price: 0.4 },
  });
  assert.match(live, /Reversed/);
  assert.match(live, /&quot;Yes&quot;/);
  assert.match(live, /5\.00 shares at 40/);

  // A reversal that did not happen is the case worth reading, so it carries the reason and
  // is marked rather than left looking like a success.
  const failed = note({
    exitReason: "stop",
    exitReversal: { status: "SKIPPED", outcome: "Yes", reason: "the market is no longer accepting orders" },
  });
  assert.match(failed, /Not reversed/);
  assert.match(failed, /order-chip warning/);
  assert.match(failed, /no longer accepting orders/);
  assert.match(failed, /protective exit itself completed/,
    "and does not imply the position went unprotected");

  const pending = note({ exitReason: "stop", exitReversal: { status: "PENDING", outcome: "Yes" } });
  assert.match(pending, /Reversal pending/);
  assert.match(pending, /retried on the next pass/);
});

// The paper half of the rule above, and it has to answer identically -- paper is where a
// setting gets tried before real money touches it, so a rule that holds only on live can
// only be learned on the live wallet.
//
// The rule itself, stated by the owner after I had implemented a narrower one: switching a
// portfolio off stops it EVALUATING and OPENING new positions and orders. Everything that
// manages what it already holds keeps running -- stop loss, certainty close, and the
// reversal alike, on every portfolio.
test("paper stop loss: a switched-off portfolio still stops, closes and reverses", () => {
  const allowed = new Function("strategy", `
    ${extractFunction(BOT, "stopLossReversalAllowed")}
    return stopLossReversalAllowed(strategy);
  `);

  assert.equal(allowed({ reverseOnStopLoss: true, automationEnabled: true }), true,
    "a running portfolio with the reversal configured reverses");
  assert.equal(allowed({ reverseOnStopLoss: true, automationEnabled: false }), true,
    "and so does a switched-off one: off is about opening new positions, not about"
    + " abandoning the stop on positions it already holds");
  assert.equal(allowed({ reverseOnStopLoss: false, automationEnabled: true }), false,
    "only the portfolio's own setting decides, and a portfolio that never asked for the"
    + " reversal does not get one");
  assert.equal(allowed({ reverseOnStopLoss: false, automationEnabled: false }), false);

  // The switch that "off" really controls is on the entry path, which is the run log's
  // work. Asserted here so the two rules stay in their own lanes.
  assert.ok(BOT.includes("if (strategy?.automationEnabled === false) return false;"),
    "strategyMatchesExecutionTrigger is where automation stops a portfolio");

  // The gate has to sit on the path refreshTrades actually takes, not only in a helper
  // nothing calls -- a rule stated once and applied nowhere reads as settled and is not.
  assert.ok(BOT.includes("if (!stopLossReversalAllowed(strategy)) return funding.trades;"),
    "refreshTrades asks before reversing");
  assert.ok(/buildStopLossReversalTrade\(sourceTrade, strategy\) \{\s*\n\s*if \(!stopLossReversalAllowed\(strategy\)/
    .test(BOT), "and so does the builder, for whichever entry point reaches it");
});

// Reported: a live portfolio that has a stop loss configured is switched off, and turning
// it back on must not quietly sell the positions it has been holding. The dashboard now
// says which ones would go and asks first -- and for that warning to be worth anything, the
// stop price it names has to be the price the RPi worker will actually use.
//
// So this is not a fixture comparison. It imports the worker's own equalRiskExitPlan and
// compares it against the UI's mirror over a spread of positions, which is the only way a
// copied solve stays honest: a drifting copy would keep passing its own expectations while
// telling the operator a comfortable story about somebody else's money.
test("stop loss warning: the UI solves for the same stop price the exit worker does", async () => {
  const worker = await import("../tools/rpi-live-exit-worker.mjs");
  const ui = new Function(`
    ${extractFunction(APP, "numericOrNull")}
    ${extractFunction(APP, "normalizeStopLossRiskMultiplier")}
    ${extractFunction(APP, "stopLossFeeUsdc")}
    ${extractFunction(APP, "stopLossNetExitValue")}
    ${extractFunction(APP, "equalRiskStopPrice")}
    return { equalRiskStopPrice };
  `)();

  const positions = [
    { shares: 6.11111, totalCostUsdc: 5, netGainIfWinUsdc: 1.11111 },
    { shares: 13.32, totalCostUsdc: 9.92, netGainIfWinUsdc: 3.4 },
    { shares: 5.4, totalCostUsdc: 5, netGainIfWinUsdc: 0.4, feeRate: 0.02, feesEnabled: true },
    { shares: 20, totalCostUsdc: 4, netGainIfWinUsdc: 16 },
    { shares: 6.5, totalCostUsdc: 5, netGainIfWinUsdc: 1.5, feeRate: 0.02, feesEnabled: false },
  ];
  for (const multiplier of [0.5, 1, 1.75, 3]) {
    for (const position of positions) {
      const plan = worker.equalRiskExitPlan({ ...position, stopLossRiskMultiplier: multiplier });
      const mirrored = ui.equalRiskStopPrice(position, multiplier);
      if (!plan.protectable) {
        assert.equal(mirrored, null,
          `the UI must not offer a stop the worker considers unprotectable (x${multiplier})`);
        continue;
      }
      assert.ok(Math.abs(mirrored - plan.stopPrice) < 0.000002,
        `x${multiplier} on ${position.shares} shares: UI ${mirrored} vs worker ${plan.stopPrice}`);
    }
  }

  // A multiplier of zero is "no stop loss", which has no price at all rather than a
  // price of zero -- the same distinction the worker draws.
  assert.equal(ui.equalRiskStopPrice(positions[0], 0), null);
});

test("stop loss warning: enabling a portfolio names the positions its stop would close", () => {
  const decide = new Function("state", "window", `
    ${extractFunction(APP, "numericOrNull")}
    ${extractFunction(APP, "normalizeStopLossRiskMultiplier")}
    ${extractFunction(APP, "stopLossRiskMultiplier")}
    ${extractFunction(APP, "stopLossFeeUsdc")}
    ${extractFunction(APP, "stopLossNetExitValue")}
    ${extractFunction(APP, "equalRiskStopPrice")}
    ${extractFunction(APP, "positionsAStopWouldCloseNow")}
    const portfolioConfigForMode = () => state.config;
    const openPositionsForMode = () => state.positions;
    return positionsAStopWouldCloseNow("live-custom-live2");
  `);

  const result = decide({
    config: { stopLossRiskMultiplier: 1.75 },
    positions: [
      // Bought at 0.82, now bid 0.03: far below its stop, so it goes immediately.
      { question: "Iberian Soul", outcome: "Iberian Soul", shares: 6.5, totalCostUsdc: 5, netGainIfWinUsdc: 1.5, bestBid: 0.03 },
      // Comfortably above its stop.
      { question: "Celtic", outcome: "Yes", shares: 6.5, totalCostUsdc: 5, netGainIfWinUsdc: 1.5, bestBid: 0.9 },
      // Nothing bid at all: reported apart, because unknown is not the same as safe.
      { question: "WSG Tirol", outcome: "No", shares: 6.3, totalCostUsdc: 4.99, netGainIfWinUsdc: 1.31, bestBid: null },
    ],
  }, {});

  assert.equal(result.multiplier, 1.75);
  assert.deepEqual(result.closing.map((row) => row.question), ["Iberian Soul"]);
  assert.deepEqual(result.unknown.map((row) => row.question), ["WSG Tirol"]);
  assert.ok(result.closing[0].stopPrice > 0.03, "the position is below the stop, which is why it closes");

  // With no stop loss configured there is nothing to warn about, whatever the prices are.
  const off = new Function("state", `
    ${extractFunction(APP, "numericOrNull")}
    ${extractFunction(APP, "normalizeStopLossRiskMultiplier")}
    ${extractFunction(APP, "stopLossRiskMultiplier")}
    ${extractFunction(APP, "stopLossFeeUsdc")}
    ${extractFunction(APP, "stopLossNetExitValue")}
    ${extractFunction(APP, "equalRiskStopPrice")}
    ${extractFunction(APP, "positionsAStopWouldCloseNow")}
    const portfolioConfigForMode = () => state.config;
    const openPositionsForMode = () => state.positions;
    return positionsAStopWouldCloseNow("live");
  `)({ config: { stopLossRiskMultiplier: 0 }, positions: [{ shares: 6.5, totalCostUsdc: 5, netGainIfWinUsdc: 1.5, bestBid: 0.01 }] });
  assert.deepEqual(off, { multiplier: 0, closing: [], unknown: [] });
});

// The confirmation must be on the way ON only, and must actually gate the write: a dialog
// whose answer is ignored is worse than none, because it reads as protection.
test("stop loss warning: the confirmation gates the switch and only on the way on", () => {
  const handler = APP.slice(APP.indexOf('const toggle = event.target?.closest?.("[data-automation-toggle]");'));
  const body = handler.slice(0, handler.indexOf("\n});"));
  assert.match(body, /if \(value && !confirmAutomationEnable\(state\.mode\)\) return;/,
    "declining must stop the change, and switching off must not ask");
  assert.ok(body.indexOf("confirmAutomationEnable") < body.indexOf("updatePortfolioConfigForMode"),
    "the question has to be asked before the setting is written");
  // Paper portfolios are asked too. They are where a setting is meant to be tried before
  // real money touches it, and a warning that only exists on the live wallet can only be
  // learned there -- which is the opposite of what paper is for.
  const confirmEnable = extractFunction(APP, "confirmAutomationEnable");
  assert.doesNotMatch(confirmEnable, /isLivePortfolioMode/,
    "the warning must not be live-only: paper is where this gets rehearsed");
  const confirmChange = extractFunction(APP, "confirmStopLossChange");
  assert.doesNotMatch(confirmChange, /isLivePortfolioMode/);
  // And the positions it reads come from whichever portfolio is open.
  const openFor = extractFunction(APP, "openPositionsForMode");
  assert.match(openFor, /if \(isLivePortfolioMode\(mode\)\) return livePositions\(state\.liveState, mode\);/);
  assert.match(openFor, /paperPortfolioTrades\(portfolioState\)\.filter\(\(trade\) => !isClosedTrade\(trade\)\)/);
  // A paper row records its bid as lastLiveBid, a live row as bestBid. Reading only the
  // live spelling would make every paper position look unquoted.
  assert.match(APP, /position\.bestBid \?\? position\.lastLiveBid \?\? position\.currentPrice/);
});

// Reported: unfilled limit orders, and the Resolved accuracy tile with them, showed rows
// belonging to other live portfolios. The live portfolios share one Polymarket wallet, so
// the account -- budget, cash, which markets are held -- is genuinely common, but what each
// portfolio ORDERED is its own, and that is the whole point of the per-portfolio view.
//
// The cause was that attribution was a two-way split: 5050, or everything else. With a
// third live portfolio, "everything else" is two portfolios, and each of them saw the
// other's positions, resting orders, unfilled orders and closed trades as its own.
test("live attribution: every live portfolio only shows what its own log ordered", () => {
  const sandbox = new Function("state", `
    const CUSTOM_PAPER_STRATEGY_ID = ${/^[a-z][a-zA-Z0-9]{1,30}$/.toString()};
    const draftedCustomLivePortfolioId = () => null;
    ${extractFunction(APP, "normalizeMode")}
    ${extractFunction(APP, "customLivePortfolioIdFromMode")}
    ${extractFunction(APP, "isFixedEntryMode")}
    ${extractFunction(APP, "memoizedByIdentity")}
    ${extractFunction(APP, "allLiveModes")}
    ${extractFunction(APP, "liveOrdersByToken")}
    ${extractFunction(APP, "newestLiveOrder")}
    ${extractFunction(APP, "liveTokenOwnerMode")}
    ${extractFunction(APP, "belongsToLivePortfolio")}
    ${/const FIXED_ENTRY_PRICE_TOLERANCE = [\d.]+;/.exec(APP)[0]}
    // Not under test: the price heuristics that let 5050 recognize an unlogged bid of its
    // own. Stubbed to a fixed answer so the ownership decision is what is measured.
    const isFilledPortfolioRow = (row) => Boolean(row?.filled);
    const boughtAtFixedEntryPrice = (row) => Boolean(row?.looksLike5050);
    const restsAtFixedEntryPrice = (row) => Boolean(row?.looksLike5050);
    return (row, mode) => belongsToLivePortfolio(row, mode);
  `);

  const belongs = sandbox({
    portfolioConfig: { livePortfolios: { live2: { displayName: "Live 2" } } },
    liveExecutionByMode: {
      live: { generatedAt: "2026-09-02T10:00:00Z", attempts: [{ action: "SUBMITTED", tokenId: "live-token", orderPrice: 0.8 }] },
      "live-custom-live2": { generatedAt: "2026-09-02T11:00:00Z", attempts: [{ action: "SUBMITTED", tokenId: "live2-token", orderPrice: 0.7 }] },
    },
    live5050ExecutionState: { generatedAt: "2026-09-02T09:00:00Z", attempts: [{ action: "SUBMITTED", tokenId: "fixed-token", orderPrice: 0.5 }] },
  });

  // Each logged token belongs to exactly one portfolio, and to no other.
  for (const [tokenId, owner] of [
    ["live-token", "live"],
    ["live2-token", "live-custom-live2"],
    ["fixed-token", "live-5050"],
  ]) {
    for (const mode of ["live", "live-5050", "live-custom-live2"]) {
      assert.equal(belongs({ tokenId }, mode), mode === owner,
        `${tokenId} must appear under ${owner} and nowhere else, but ${mode} disagreed`);
    }
  }

  // A token no log names still has to appear somewhere, or a row would be invisible on
  // every tab. It stays with the base Live portfolio -- a custom live portfolio prices its
  // bids exactly as Live does, so nothing about the row could justify claiming it.
  assert.equal(belongs({ tokenId: "unlogged-token" }, "live"), true);
  assert.equal(belongs({ tokenId: "unlogged-token" }, "live-custom-live2"), false);
  assert.equal(belongs({ tokenId: "unlogged-token" }, "live-5050"), false);

  // 5050 is the exception: it rests every bid at its configured entry price, far from the
  // market by construction, so it can still recognize its own before its log publishes.
  assert.equal(belongs({ tokenId: "unlogged-5050", looksLike5050: true }, "live-5050"), true);
  assert.equal(belongs({ tokenId: "unlogged-5050", looksLike5050: true }, "live"), false);

  // A rejected order claims nothing: the portfolio never got the position.
  const rejected = sandbox({
    portfolioConfig: { livePortfolios: { live2: {} } },
    liveExecutionByMode: {
      "live-custom-live2": { generatedAt: "2026-09-02T11:00:00Z", attempts: [{ action: "REJECTED", tokenId: "refused-token", orderPrice: 0.6 }] },
    },
  });
  assert.equal(rejected({ tokenId: "refused-token" }, "live-custom-live2"), false);
  assert.equal(rejected({ tokenId: "refused-token" }, "live"), true,
    "an unclaimed token stays visible on the base Live tab rather than vanishing");

  // Traded by one portfolio after another closed out of it: the newest order owns it,
  // matching how api.php attributes the stop-loss policy.
  const retraded = sandbox({
    portfolioConfig: { livePortfolios: { live2: {} } },
    liveExecutionByMode: {
      live: { generatedAt: "2026-09-01T10:00:00Z", attempts: [{ action: "SUBMITTED", tokenId: "shared-token", orderPrice: 0.65 }] },
      "live-custom-live2": { generatedAt: "2026-09-02T10:00:00Z", attempts: [{ action: "SUBMITTED", tokenId: "shared-token", orderPrice: 0.65 }] },
    },
  });
  assert.equal(retraded({ tokenId: "shared-token" }, "live-custom-live2"), true);
  assert.equal(retraded({ tokenId: "shared-token" }, "live"), false);
});

// Reported: the UI reacts slowly and stutters. Several of these lookups rebuilt a whole
// index on every call, and every one of them is called once per table row -- quadratic, and
// invisible in the code, because each call site reads like a lookup. Measured offline at
// production sizes by tools/dashboard-render-benchmark.mjs: one 150-row pass cost 72 ms
// before and 1.1 ms after.
//
// The risk that buys is a cache that answers about state it no longer reflects, which would
// be a far worse bug than the slowness. So the invalidation is what is pinned here: the key
// is the IDENTITY of the state each index reads, and the loader replaces those objects
// wholesale.
test("dashboard indexes are cached, and rebuild when the state behind them is replaced", () => {
  const sandbox = new Function("state", `
    const CUSTOM_PAPER_STRATEGY_ID = ${/^[a-z][a-zA-Z0-9]{1,30}$/.toString()};
    const draftedCustomLivePortfolioId = () => null;
    ${extractFunction(APP, "memoizedByIdentity")}
    ${extractFunction(APP, "normalizeMode")}
    ${extractFunction(APP, "customLivePortfolioIdFromMode")}
    ${extractFunction(APP, "allLiveModes")}
    ${extractFunction(APP, "liveOrdersByToken")}
    ${extractFunction(APP, "scrapedObservationIsError")}
    ${extractFunction(APP, "scrapedMarketObservations")}
    ${extractFunction(APP, "earliestIndexedMatch")}
    ${extractFunction(APP, "sourceMarketTags")}
    ${extractFunction(APP, "liveMarketMetadataIndex")}
    ${extractFunction(APP, "liveMarketIdentifiers")}
    ${extractFunction(APP, "liveMarketMetadataForTrade")}
    ${extractFunction(APP, "liveMarketTagsForTrade")}
    return { liveOrdersByToken, liveMarketMetadataForTrade, liveMarketTagsForTrade };
  `);

  const live = { generatedAt: "2026-09-02T10:00:00Z", attempts: [{ action: "SUBMITTED", tokenId: "t1", orderPrice: 0.8 }] };
  const state = {
    portfolioConfig: { livePortfolios: {} },
    liveExecutionByMode: { live },
    live5050ExecutionState: null,
    scrapedMarketStateLoaded: true,
    scrapedMarketObservations: [{ tokenId: "t1", question: "from the catalogue", polymarketTags: ["sports", "mlb"] }],
    botState: { evaluations: [] },
    liveExecutionState: { selected: { tokenId: "t2", question: "from the run" }, attempts: [], runLog: [] },
  };
  const app = sandbox(state);

  // Cached: a second call is the same object, not an equal one built again.
  assert.equal(app.liveOrdersByToken(), app.liveOrdersByToken());

  // The loader fills state.liveExecutionByMode IN PLACE -- state.liveExecutionByMode[mode] =
  // payload -- so keying on that container's identity would be a key that never changes.
  // Replacing one mode's payload, exactly as a load does, has to be visible.
  state.liveExecutionByMode.live = {
    generatedAt: "2026-09-02T12:00:00Z",
    attempts: [{ action: "SUBMITTED", tokenId: "t9", orderPrice: 0.4 }],
  };
  assert.deepEqual([...app.liveOrdersByToken().keys()], ["t9"],
    "a payload loaded into the same container has to invalidate the index built from it");

  // A newly created live portfolio adds a mode, which changes what there is to index even
  // though every payload already in hand is untouched.
  state.portfolioConfig = { livePortfolios: { live2: { displayName: "Live 2" } } };
  state.liveExecutionByMode["live-custom-live2"] = {
    generatedAt: "2026-09-02T13:00:00Z",
    attempts: [{ action: "SUBMITTED", tokenId: "t5", orderPrice: 0.55 }],
  };
  assert.deepEqual([...app.liveOrdersByToken().keys()].sort(), ["t5", "t9"]);

  // The metadata index answers exactly as the linear scan it replaces did: the running
  // portfolio's own log outranks the scraped catalogue for the same token.
  assert.equal(app.liveMarketMetadataForTrade({ tokenId: "t1" })?.question, "from the catalogue");
  assert.equal(app.liveMarketMetadataForTrade({ tokenId: "t2" })?.question, "from the run");
  state.liveExecutionState = { selected: { tokenId: "t1", question: "the run knows it now" }, attempts: [], runLog: [] };
  assert.equal(app.liveMarketMetadataForTrade({ tokenId: "t1" })?.question, "the run knows it now",
    "the execution log outranks the catalogue, and a replaced log has to be read");
  assert.equal(app.liveMarketMetadataForTrade({ tokenId: "nothing-knows-this" }), null);

  // And tags come from a separate lookup for exactly this reason: t1 is now named by an
  // execution-log attempt, which has no tags, while the catalogue entry for the same token
  // has them. Reading tags off whichever source won the name is how a tagged market showed
  // "no tags recorded".
  assert.deepEqual(app.liveMarketTagsForTrade({ tokenId: "t1" }), ["sports", "mlb"]);
  assert.deepEqual(app.liveMarketTagsForTrade({ tokenId: "t2" }), [],
    "a market nothing has tags for stays empty rather than borrowing another market's");
});

// Attribution can only see a log that was loaded. With just the open tab's log in hand,
// every other portfolio's rows read as unowned -- and unowned falls to the base Live tab,
// which is the mechanism behind the reported leak. So the loader has to fetch them all.
test("live attribution: the dashboard loads every live portfolio's execution log", () => {
  const loader = APP.slice(APP.indexOf("const attributionModes = allLiveModes()"));
  const body = loader.slice(0, loader.indexOf("loadDispatchFailures("));
  assert.match(body, /\.\.\.attributionModes\.map\(\(mode\) => fetchJson\(liveExecutionStateFile\(mode\)\)\)/);
  assert.match(body, /if \(result\?\.status === "fulfilled"\) state\.liveExecutionByMode\[mode\] = result\.value;/,
    "a portfolio that has never run has no file, and that miss must not clear a log in hand");
  // The Resolved accuracy tile is fed the attributed closed trades, so separating the
  // portfolios separates the tile too. Pinned, because a future refactor that hands it the
  // unfiltered list would silently restore the mixed statistic.
  const attributedAt = APP.indexOf("const closedTrades = liveClosedTrades(liveState).map(decorateLiveTradeForTable);");
  assert.ok(attributedAt > 0, "the live renderer must build its closed rows from the attributed set");
  // Within the same function: the tile is fed that variable, not the account's whole list.
  const renderer = APP.slice(attributedAt, APP.indexOf("\nfunction ", attributedAt));
  assert.match(renderer, /renderClosedAccuracy\(closedTrades\);/,
    "Resolved accuracy must count this portfolio's own resolved positions, not the account's");
});

// Asked for: in the dashboard overview, a live portfolio that is switched ON comes first,
// and ROI orders them within that. A portfolio that is off still holds real positions and
// is still listed, but it is not what the operator is watching.
test("overview order: switched-on live portfolios come first, then by ROI", () => {
  const order = new Function("state", `
    const CUSTOM_PAPER_STRATEGY_ID = ${/^[a-z][a-zA-Z0-9]{1,30}$/.toString()};
    ${extractFunction(APP, "automationIsEnabled")}
    ${extractFunction(APP, "byActiveThenRoiDescending")}
    const portfolioConfigForMode = (mode) => state.configs[mode] || {};
    const portfolioRealizedRoiForMode = (mode) => state.roi[mode] ?? null;
    return byActiveThenRoiDescending(state.modes);
  `);

  const modes = ["live", "live-5050", "live-custom-live2", "live-custom-live3"];
  assert.deepEqual(order({
    modes,
    configs: {
      live: { automationEnabled: false },
      "live-5050": { automationEnabled: true },
      "live-custom-live2": { automationEnabled: true },
      "live-custom-live3": { automationEnabled: false },
    },
    roi: {
      live: { roi: 9 },
      "live-5050": { roi: 0.2 },
      "live-custom-live2": { roi: 1.4 },
      "live-custom-live3": { roi: 4 },
    },
  }), ["live-custom-live2", "live-5050", "live", "live-custom-live3"],
  "the two running portfolios come first in ROI order, and the two switched-off ones follow in ROI order");

  // Absent means on, matching automationIsEnabled and the server's own default, so a
  // portfolio saved before the switch existed is not demoted.
  assert.deepEqual(order({
    modes: ["live", "live-5050"],
    configs: { live: {}, "live-5050": { automationEnabled: false } },
    roi: { live: { roi: 0.1 }, "live-5050": { roi: 5 } },
  }), ["live", "live-5050"]);

  // An unknown ROI sorts last within its group rather than jumping to the top, and equal
  // portfolios keep the incoming order so the table does not shuffle between renders.
  assert.deepEqual(order({
    modes: ["live", "live-5050", "live-custom-live2"],
    configs: {},
    roi: { "live-5050": { roi: 0.5 } },
  }), ["live-5050", "live", "live-custom-live2"]);

  assert.match(APP, /return \[\.\.\.byActiveThenRoiDescending\(liveModes\), \.\.\.byEquityDescending\(paperModes\)\];/,
    "the live group is ordered this way and the paper group keeps its equity order");
  // The column and the ordering must read the same number, or the table is sorted by one
  // value while showing another.
  assert.match(APP, /roi: portfolioRealizedRoiForMode\(mode\),/);
});

// Asked for: the same separation in Settings -> Portfolio trade analysis. That report
// already reads liveClosedTrades(state.liveState, mode), so it inherits the attribution --
// but attribution can only read a log that was loaded, and this page loaded the account
// snapshot alone. Opening Settings directly would therefore have handed every live row to
// the base Live portfolio and reported the others as having traded nothing.
test("trade analysis: the settings report loads the logs its attribution depends on", () => {
  const loader = APP.slice(APP.indexOf("async function loadLiveStateForOptimisation()"));
  const body = loader.slice(0, loader.indexOf("\n}\n"));
  assert.match(body, /const modes = allLiveModes\(\)\.map\(normalizeMode\);/);
  assert.match(body, /modes\.map\(\(mode\) => fetchJson\(liveExecutionStateFile\(mode\)\)\.catch\(\(\) => null\)\)/);
  assert.match(body, /if \(!executions\[index\]\) continue;/,
    "a portfolio that has never run has no file, and that must not clear a log in hand");
  // The old guard returned as soon as the account snapshot existed, which would skip the
  // logs forever once any other path had loaded the snapshot.
  assert.match(body, /if \(\(state\.liveState && haveExecutionLogs\)/,
    "having the snapshot is no longer reason enough to skip loading the logs");

  // And the report itself must keep asking per portfolio rather than for the account.
  const report = APP.slice(APP.indexOf("function portfolioTradeAnalysisPortfolios()"));
  assert.match(report.slice(0, 4000), /liveClosedTrades\(state\.liveState, mode\)\.map\(decorateLiveTradeForTable\)/,
    "each live card reads its own portfolio's closed trades");
});

// Reported as several unrelated changes disappearing at once -- the tags icon gone, the
// amber chips red again, "more changes from the last 24 hours" lost. None of it had been
// reverted: the published app.js was measured containing code pushed minutes earlier. The
// hosting sent no Cache-Control header at all, so a browser could reuse a stored
// index.html, and that page keeps asking for the PREVIOUS ?v=<commit> asset URL, which it
// also holds. One stale page reverts the whole dashboard.
test("deploy: the page revalidates, and its versioned assets stay cacheable", async () => {
  const { readFile } = await import("node:fs/promises");
  const [htaccess, workflow] = await Promise.all([
    readFile(new URL("../.htaccess", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-deploy.yml", import.meta.url), "utf8"),
  ]);

  // Guarded, so a host without mod_headers keeps serving the site instead of erroring.
  assert.match(htaccess, /<IfModule mod_headers\.c>/);
  const headers = htaccess.slice(htaccess.indexOf("<IfModule mod_headers.c>"));
  assert.match(headers, /<FilesMatch "\\\.\(\?:html\|php\)\$">[\s\S]*?Header set Cache-Control "no-cache, must-revalidate"/,
    "the page and the API must be re-checked on every visit");
  assert.match(headers, /<FilesMatch "\\\.\(\?:js\|css\)\$">[\s\S]*?Header set Cache-Control "public, max-age=/,
    "the assets stay cacheable: their URL already changes when their content does");

  // Cacheable assets are only safe while the URL carries the deploy, so the two halves of
  // this fix have to stay together.
  assert.match(workflow, /Stamp asset cache-busting versions/);
  assert.match(workflow, /ASSET_VERSION: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /refusing to deploy an unstamped page/,
    "a page with no version on its assets must fail the deploy, not ship");

  // And the file that carries the rules has to actually be uploaded.
  assert.match(workflow, /"index\.html", "api\.php", "storage\.php", "config\.php", "\.htaccess"/);
});

// The behavioural half of the test above, which is the half that was missing. Reported:
// "stary problem se vratil, po refreshi stranky mam aktivni conservative portfolio
// namisto nejvykonejsiho live portfolia."
//
// The rule was asserted only by grepping app.js, so it kept passing while the behaviour
// was broken. Driving it shows the deadlock: the preselection waited for state.liveState,
// and nothing loads the live state until a live portfolio is already SELECTED --
// loadDashboardState dispatches on the current mode, storedMode() defaults to
// paper-conservative, so the paper branch ran, renderLiveState never fired, and the
// condition could never become true. It was gated on the thing it existed to cause.
test("dashboard: a page opening on a paper tab still reaches the top live portfolio", () => {
  const harness = new Function("state", "calls", `
    ${/const BUILT_IN_PAPER_STRATEGY_IDS = [^;]+;/.exec(APP)[0]}
    ${/const CUSTOM_PAPER_STRATEGY_ID = [^;]+;/.exec(APP)[0]}
    ${/const LIVE_MODES = [^;]+;/.exec(APP)[0]}
    const readCachedPortfolioConfig = () => null;
    const saveMode = (mode) => calls.push(["saveMode", mode]);
    const storedRunLogFilter = () => ["ALL"];
    const loadDashboardState = () => calls.push(["loadDashboardState", state.mode]);
    const portfolioEquityUsdc = (mode) => (state.equity || {})[mode] ?? null;
    const portfolioRealizedRoiForMode = (mode) => {
      const value = (state.roi || {})[mode];
      return value == null ? null : { roi: value };
    };
    ${extractFunction(APP, "normalizeMode")}
    ${extractFunction(APP, "customLivePortfolioIdFromMode")}
    ${extractFunction(APP, "isLivePortfolioMode")}
    ${extractFunction(APP, "automationIsEnabled")}
    ${extractFunction(APP, "portfolioIsArchived")}
    ${extractFunction(APP, "paperStrategyIds")}
    ${extractFunction(APP, "byActiveThenRoiDescending")}
    ${extractFunction(APP, "byEquityDescending")}
    ${extractFunction(APP, "dashboardModes")}
    ${extractFunction(APP, "preselectTopPortfolio")}
    function portfolioConfigForMode(mode) {
      const config = state.portfolioConfig || {};
      const customId = customLivePortfolioIdFromMode(normalizeMode(mode));
      if (customId) return (config.livePortfolios || {})[customId] || {};
      if (normalizeMode(mode) === "live-5050") return config.live5050 || {};
      if (normalizeMode(mode) === "live") return config.live || {};
      return (config.paper || {})[String(mode).replace(/^paper-/, "")] || {};
    }
    return { preselectTopPortfolio, dashboardModes };
  `);

  // The account as measured: the plain Live portfolio with automation off, 5050 archived,
  // and three custom live portfolios of which two are automated.
  const portfolioConfig = {
    live: { automationEnabled: false },
    live5050: { archived: true },
    livePortfolios: {
      live2: { automationEnabled: false },
      ewportfolio: { automationEnabled: true },
      esports: { automationEnabled: true },
    },
    paper: { conservative: {}, highReward: {}, moreProbable: {}, equal: {} },
  };
  const fresh = () => ({
    // What storedMode() returns on a first visit, and what the reader was left looking at.
    mode: "paper-conservative",
    portfolioPreselectDone: false,
    portfolioConfig: null,
    liveState: null,
    equity: { "paper-conservative": 5000, "paper-highReward": 100 },
    roi: {},
  });

  // Pass 1, from loadDashboardState's syncModeUi: nothing has loaded, so nothing is decided
  // and nothing is committed.
  const first = fresh();
  const firstCalls = [];
  harness(first, firstCalls).preselectTopPortfolio();
  assert.equal(first.portfolioPreselectDone, false, "an undecidable pass must not commit");
  assert.deepEqual(firstCalls, []);

  // Pass 2, after the config arrives and before any live state exists. This is the pass the
  // deadlock swallowed. The config alone settles that the live group leads, so the mode has
  // to move off the paper tab here -- and the flag must stay clear, because ordering WITHIN
  // the live group still needs the ROI.
  const second = fresh();
  const secondCalls = [];
  second.portfolioConfig = portfolioConfig;
  harness(second, secondCalls).preselectTopPortfolio();
  assert.ok(second.mode.startsWith("live"),
    `a page with live portfolios must not stay on ${second.mode} once the config is known`);
  assert.equal(second.portfolioPreselectDone, false,
    "the provisional pick must leave the flag clear so the ordering can still be refined");
  assert.ok(secondCalls.some(([name]) => name === "loadDashboardState"),
    "and it must start the load that fetches the live state it is waiting for");

  // Pass 3, once that load has delivered the live state: the ROI now orders the live group
  // and the choice is committed.
  const third = { ...second, liveState: { positions: [], closedTrades: [] } };
  third.roi = { "live-custom-esports": 4.2, "live-custom-ewportfolio": 0.9 };
  const thirdCalls = [];
  harness(third, thirdCalls).preselectTopPortfolio();
  assert.equal(third.mode, "live-custom-esports", "the highest-ROI automated live portfolio wins");
  assert.equal(third.portfolioPreselectDone, true, "and that decision is final for the page load");

  // A reader's deliberate choice is still never overridden.
  const clicked = { ...fresh(), portfolioConfig, portfolioPreselectDone: true, mode: "paper-equal" };
  const clickedCalls = [];
  harness(clicked, clickedCalls).preselectTopPortfolio();
  assert.equal(clicked.mode, "paper-equal");
  assert.deepEqual(clickedCalls, []);

  // A dashboard with no live portfolios at all must not be dragged to a live tab.
  const paperOnly = fresh();
  paperOnly.portfolioConfig = {
    live: { archived: true }, live5050: { archived: true }, livePortfolios: {},
    paper: { conservative: {} },
  };
  const paperCalls = [];
  const paperApi = harness(paperOnly, paperCalls);
  const [topPaper] = paperApi.dashboardModes();
  paperApi.preselectTopPortfolio();
  assert.ok(!paperOnly.mode.startsWith("live-"),
    `a config with no live portfolios must not select ${paperOnly.mode}`);
  assert.ok(String(topPaper).startsWith("paper-") || topPaper === "live",
    "and the overview's own top row is what it follows");
});

// Asked for: a position whose outcome is already decided still waits hours for Polymarket
// to resolve it, with the stake locked the whole time. Selling one tick below certainty
// pays about a cent a share to get that capital back now.
test("close at certainty: the threshold is stored per portfolio, and off is the default", () => {
  const saved = normalizeConfig({
    paper: {
      early: { displayName: "Early", settlementCloseBid: 0.99 },
      finer: { displayName: "Finer", settlementCloseBid: 0.999 },
      waits: { displayName: "Waits" },
      off: { displayName: "Off", settlementCloseBid: 0 },
      // Nonsense is off, never a default: a portfolio must not start selling early because
      // a bad value was posted.
      junk: { displayName: "Junk", settlementCloseBid: "later" },
      // Below the band this is not a settlement shortcut, it is just selling.
      tooLow: { displayName: "Too low", settlementCloseBid: 0.2 },
      // And 1.0 would never trigger, because a resolved market is no longer quoted.
      tooHigh: { displayName: "Too high", settlementCloseBid: 1 },
    },
  });
  assert.equal(saved.paper.early.settlementCloseBid, 0.99);
  assert.equal(saved.paper.finer.settlementCloseBid, 0.999);
  assert.equal(saved.paper.waits.settlementCloseBid, 0, "a portfolio that never set it waits for resolution");
  assert.equal(saved.paper.off.settlementCloseBid, 0);
  assert.equal(saved.paper.junk.settlementCloseBid, 0);
  assert.equal(saved.paper.tooLow.settlementCloseBid, 0.5);
  assert.equal(saved.paper.tooHigh.settlementCloseBid, 0.999);

  // Re-saving must not drift, or every save of an unrelated field would move the threshold.
  const round = normalizeConfig({ paper: { early: saved.paper.early } });
  assert.equal(round.paper.early.settlementCloseBid, 0.99);

  // The form control, and the value it saves.
  assert.match(HTML, /<span>Close at certainty<\/span>\s*\n\s*<input type="number" min="0" max="99\.9" step="0\.1" value="0" data-settlement-close-bid>/);
  assert.match(APP, /els\.settlementCloseBid\?\.addEventListener\("input", \(\) => \{/);
  assert.match(APP, /updatePortfolioConfigForMode\(state\.mode, \{ settlementCloseBid: value \}\);/);

  // The live worker only ever watches what the policy payload names, so a portfolio with
  // no stop loss but this setting on has to reach it -- otherwise the setting does nothing
  // at all for exactly the portfolios most likely to use it.
  assert.match(API, /if \(\$multiplier <= 0 && \$settlementCloseBid <= 0\) \{\s*\n\s*return null;/);
  assert.match(API, /'settlementCloseBid' => \$settlementCloseBid,/);
  // And the worker must not read a stop out of a policy that exists only for this.
  assert.match(API, /'stopLossEnabled' => \$multiplier > 0,/);
});

// Reported after it happened: a 2 typed into a field that means percent is a 0.02x stop,
// 0.02x puts the floor above the entry price, and four positions in four unrelated markets
// were sold within one second of the save -- at entry, for no reason visible anywhere. The
// control said nothing beforehand and the closed rows said nothing afterwards.
test("stop loss form: a change that would sell open positions is named and confirmed first", () => {
  // Typing must not save. "200" passes through 2 on its way in, and every debounced save in
  // that sequence is a live instruction to the exit worker.
  assert.match(APP, /els\.stopLossRiskMultiplier\?\.addEventListener\("input", \(\) => \{/);
  assert.match(APP, /els\.stopLossRiskMultiplier\?\.addEventListener\("change", \(\) => \{/);
  const input = extractFunction(APP, "stopLossMultiplierUpdates");
  assert.match(input, /stopLossEnabled: multiplier > 0/);
  // The input handler previews and updates a draft; it must not reach the save path.
  const inputHandler = /els\.stopLossRiskMultiplier\?\.addEventListener\("input"[\s\S]*?\n\}\);/.exec(APP)[0];
  assert.doesNotMatch(inputHandler, /savePortfolioConfigSoon\(\)/,
    "a keystroke must not be persisted: half a number is a different stop loss");
  assert.doesNotMatch(inputHandler, /updatePortfolioConfigForMode/);
  const changeHandler = /els\.stopLossRiskMultiplier\?\.addEventListener\("change"[\s\S]*?\n\}\);/.exec(APP)[0];
  assert.match(changeHandler, /if \(!confirmStopLossChange\(state\.mode, multiplier\)\) \{/);
  assert.match(changeHandler, /savePortfolioConfigSoon\(\);/);
  // Declining has to put the saved value back, or the field shows a setting that is not in
  // force.
  assert.match(changeHandler, /syncPortfolioParameterControls\(\);\s*\n\s*return;/);

  // The plan calculation has to be able to answer for a PROPOSED multiplier, or the
  // question can only be asked after the save.
  const which = extractFunction(APP, "positionsAStopWouldCloseNow");
  assert.match(which, /function positionsAStopWouldCloseNow\(mode = state\.mode, multiplierOverride = null\)/);
  assert.match(which, /multiplierOverride == null/);
  // A floor at or above the entry is its own category: not "the market moved against this
  // position" but a setting that cannot do what it says.
  assert.match(which, /aboveEntry: entryPrice != null && stopPrice >= entryPrice/);

  const confirm = extractFunction(APP, "confirmStopLossChange");
  // Only what the change itself closes. Burying the new ones among positions already below
  // their stop is how a confirmation stops being read.
  assert.match(confirm, /const already = new Set\(before\.closing\.map\(\(row\) => row\.key\)\);/);
  assert.match(confirm, /if \(!newlyClosing\.length\) return true;/);
  assert.match(confirm, /would be sold as soon as this saves/);
  // And it says what the field's units are, because that is the mistake it exists to catch.
  assert.match(confirm, /This field is a PERCENTAGE of the net potential win/);
});

// Reported: the closed-positions list shows no record that a stop loss ever fired. It could
// not -- the exit worker recorded every fill in its own state file on the Pi, which nothing
// publishes, and the account sync that produces those rows learns only from Polymarket,
// where a protective sell and any other sell are the same event.
test("closed positions: a live row says why it was sold, not just that it is gone", () => {
  // The worker reports the reason at the moment it knows it.
  const worker = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  assert.match(worker, /async function recordLiveExit\(plan, \{ reason, response, bestBidPrice, bestAskPrice \}\)/);
  assert.match(worker, /await recordLiveExit\(plan, \{/);
  // Best effort: a position that is already sold must not be un-sold because the annotation
  // could not be delivered.
  assert.match(worker, /\} catch \{\s*\n\s*\/\/ Swallowed on purpose\. The position is already sold/);

  // The endpoint that receives it, behind the same key every other write uses.
  assert.match(API, /if \(\$action === 'live-exit-record'\) \{/);
  assert.match(API, /require_trading_trigger_key\(\);\s*\n\s*respond\(live_exit_record_request\(request_payload\(\)\)\);/);
  // Keyed by token, so a retried exit updates its record instead of adding a second one.
  assert.match(API, /\$records\[\$tokenId\] = \$record;/);

  // And it is attached to the position when the live state is served.
  assert.match(API, /if \(\$target === 'live'\) \{\s*\n\s*\$payload = live_state_with_exit_reasons\(\$payload\);/);
  const attach = /function live_state_with_exit_reasons\(array \$payload\): array[\s\S]*?\n\}/.exec(API)[0];
  assert.match(attach, /\$positions\[\$index\]\['exitReason'\]/);
  // Annotation only. A recorded exit that has not settled yet must not make a position look
  // closed before the account says it is.
  assert.match(attach, /Annotation only/);
  assert.doesNotMatch(attach, /\['status'\] =/);

  // The dashboard shows it.
  assert.match(APP, /if \(trade\.exitReason === "stop"\) \{/);
  assert.match(APP, /Protective exit\$\{at != null \? ` &middot; sold at \$\{percent\(at\)\}` : ""\}/);
  assert.match(APP, /if \(trade\.exitReason === "settlement"\) \{/);
});

// Asked for: the candidate list should be re-judged as the very last step of an execution,
// and must not be shown until every candidate has its new verdict -- so what appears is
// what the run decided, not the list it started from.
//
// Reported as the thing that made this necessary: a freshly refreshed shortlist showing 23
// READY candidates, an execution started against it, and a run log saying none of them
// passed. Both were true; the list was simply the one the run was in the middle of
// replacing.
test("candidate shortlist: an execution's verdicts arrive before the list does", () => {
  // The gate itself. While a run is judging this portfolio, the tab shows that rather than
  // the verdicts being replaced.
  assert.match(APP, /if \(state\.candidatesAwaitingExecution === mode\) \{/,
    "the candidate renderer refuses to draw a list the running execution is replacing");
  assert.match(APP, /awaiting execution verdicts/);

  // Set when the run starts, so the old rows stop being presented the moment they are
  // known to be stale.
  assert.match(APP, /state\.candidatesAwaitingExecution = target;\s*\n\s*renderPortfolioCandidates\(\);/,
    "and it is set as the execution begins, not after it ends");

  // The refresh is the LAST step, after the execution result has been waited for. Order is
  // the whole request: refreshing before the run would show the list it started from.
  const flow = APP.slice(APP.indexOf("const result = await waitForExecutionResult("));
  const rejudgedAt = flow.indexOf("Candidate shortlist re-judged");
  const dashboardAt = flow.indexOf("Dashboard refreshed");
  assert.ok(rejudgedAt > 0 && dashboardAt > rejudgedAt,
    "the shortlist is re-read after the execution result, as its final step");

  // Cleared on every path. A run that never started is not one whose verdicts are coming,
  // and a tab waiting for them for ever is worse than a stale list.
  assert.match(APP, /state\.executionBusy = null;[\s\S]{0,300}?state\.candidatesAwaitingExecution = null;/,
    "the waiting state is cleared even when the execution failed");

  // And the post-execution refresh must not be silently dropped by the busy guard, or the
  // tab would wait for a list that never arrives.
  assert.match(APP, /if \(!options\.force\) return;/,
    "the forced refresh waits its turn rather than returning");
  assert.match(APP, /refreshPortfolioCandidates\(\{ quiet: true, force: true \}\)/);
});

// Asked for: "Refresh shortlist" should not just re-read the database, it should fetch the
// prices fresh from Polymarket. It did the former while the status line claimed the latter
// -- "refreshed with current market quotes" over rows from a scrape that could be hours
// old. On an in-play market that gap is the difference between a tradable row and a
// finished one.
test("refresh shortlist: the quote comes from Polymarket, and says so when it does not", () => {
  const side = new Function("levels", "pick", `
    ${extractFunction(APP, "shortlistBookSide")}
    return shortlistBookSide(levels, pick);
  `);

  assert.equal(side([{ price: "0.72" }, { price: "0.69" }], Math.max), 0.72);
  assert.equal(side([{ price: "0.75" }, { price: "0.80" }], Math.min), 0.75);
  // An empty side is unknown, not free. Reading it as zero is what once had a stop selling
  // into a vacuum, and the same mistake here would price an untradable row as a bargain.
  assert.equal(side([], Math.max), null);
  assert.equal(side(undefined, Math.min), null);
  assert.equal(side([{ price: "0" }], Math.max), null, "a quoted zero is the same vacuum");

  // One request for every token, not one per token.
  assert.match(APP, /await fetch\("https:\/\/clob\.polymarket\.com\/books", \{/,
    "the shortlist is re-quoted from the CLOB's batched books endpoint");
  assert.match(APP, /body: JSON\.stringify\(tokens\.map\(\(token\) => \(\{ token_id: token \}\)\)\)/);

  // Re-quoted BEFORE the observations are stored, so the tradability gate and the rendered
  // row both read the book as it is now rather than as it was scraped.
  const flow = APP.slice(APP.indexOf("async function refreshPortfolioCandidates("));
  const quoteAt = flow.indexOf("refreshShortlistQuotesFromPolymarket(scrapedState?.marketObservations)");
  const storeAt = flow.indexOf('storeScrapedMarketState(scrapedState, "execution")');
  assert.ok(quoteAt > 0 && storeAt > quoteAt, "the fresh quote lands before the row is stored");

  // A market that has stopped quoting must stop reading as tradable rather than keep the
  // last price it had -- which is what let finished fixtures sit in the list looking ready.
  assert.match(APP, /row\.bestBid = bid;\s*\n\s*row\.bestAsk = ask;/,
    "both sides are written even when empty, rather than only when a price came back");

  // And the claim is never made without the substance: a failed quote says the prices are
  // stored, in the status line and in the summary.
  assert.match(APP, /prices are as last scraped/);
  assert.match(APP, /stored prices, Polymarket quotes unavailable/);
});

// Reported twice. The second time with the fresh quote demonstrably working -- the summary
// read "16 READY / 1 ALREADY HELD / QUOTED 06. 09. 2026 07:47" -- and the execution still
// skipped. So the quote was arriving and nothing was reading it.
//
// Two links were missing, one after the other, and either alone would have kept the row.
test("a re-quoted market that stopped quoting stops reading as READY", () => {
  // 1. The merge dropped it. copyIfPresent only copies a value that is not null, which is
  // right for a partial observation that simply lacks a field -- and wrong for a freshly
  // read book reporting NO ask, which is the market saying nothing is offered. The stale
  // ask survived, so the row kept the price it had when it was still trading.
  // The economics recomputed after the copy are not what is under test, so they are
  // stubbed to NaN -- every one of them then falls back to the row's stored value and the
  // quote fields are what remains to assert on.
  const merge = new Function("evaluations", "observations", `
    const nan = () => NaN;
    const evaluationTotalCost = nan, evaluationShares = nan, gainIfWin = nan;
    const marketExpectedValueFromQuote = nan, expectedValue = nan, daysToResolution = nan;
    const annualizeReturn = nan;
    ${extractFunction(APP, "mergeCurrentMarketEconomics")}
    return mergeCurrentMarketEconomics(evaluations, observations);
  `);
  const [merged] = merge(
    [{ tokenId: "1", bestBid: 0.72, bestAsk: 0.73, spread: 0.01 }],
    [{ tokenId: "1", bestBid: null, bestAsk: null, spread: null, quotedAt: "2026-09-06T07:47:00Z" }],
  );
  assert.equal(merged.bestAsk, null, "a freshly quoted empty book must clear the stale ask");
  assert.equal(merged.bestBid, null);
  assert.equal(merged.quotedAt, "2026-09-06T07:47:00Z", "and the row must carry when it was quoted");

  // A row that was NOT re-quoted keeps the conservative copy, so this cannot blank a stored
  // observation that merely lacks the field.
  const [untouched] = merge(
    [{ tokenId: "1", bestBid: 0.72, bestAsk: 0.73 }],
    [{ tokenId: "1", bestBid: null, bestAsk: null }],
  );
  assert.equal(untouched.bestAsk, 0.73, "no quotedAt means no fresh reading to trust");

  // 2. Nothing asked. The precheck had four states -- excluded, held, risk-blocked, else
  // READY -- so tradability was never part of the verdict at all.
  assert.match(APP, /reasons\.push\("Polymarket is no longer quoting this market"\);/);
  assert.match(APP, /reasons\.push\("nothing is offered on this outcome, so there is nothing to buy"\);/,
    "a buy needs somebody offering; a bid alone is what the outcome could be SOLD at");
  assert.match(APP, /if \(item\.quotedAt\) \{\s*\n\s*const freshAsk/,
    "and it is asked only of rows that were actually re-quoted");
});

// Asked for: replace the overview's "ROI p.a." column with a plain ROI -- realized P/L over
// the amount actually invested.
//
// The two answer different questions and the annualized one is the easier to misread: it
// divides by elapsed time, so a portfolio a few hours old reported hundreds of percent on a
// couple of dollars, while one running for months looked worse for identical trading.
test("overview ROI: realized P/L over what the closed trades cost", () => {
  const roiOf = new Function("state", "mode", `
    const isLivePortfolioMode = () => true;
    // The per-portfolio P/L is fed in, so what is under test is the arithmetic on top of
    // it rather than the attribution below it -- which has its own tests.
    const liveOwnPortfolioPnl = () => state.own;
    ${extractFunction(APP, "portfolioRealizedRoiForMode")}
    return portfolioRealizedRoiForMode(mode);
  `);

  // 12.50 back on 100.00 that completed a round trip.
  const won = roiOf({ own: { realized: 12.5, investedClosed: 100, closedCount: 4 } }, "live");
  assert.equal(Number(won.roi.toFixed(6)), 0.125);
  assert.equal(won.invested, 100);
  assert.equal(won.closedCount, 4);

  // Losses are a return too, and must keep their sign.
  const lost = roiOf({ own: { realized: -7.5, investedClosed: 50, closedCount: 2 } }, "live");
  assert.equal(Number(lost.roi.toFixed(6)), -0.15);

  // Nothing has come back yet. Absent, not zero -- zero would sort a portfolio that has
  // never closed a trade above a losing one that has.
  assert.equal(roiOf({ own: { realized: 0, investedClosed: 0, closedCount: 0 } }, "live"), null);
  assert.equal(roiOf({ own: { realized: 5, investedClosed: 0, closedCount: 1 } }, "live"), null,
    "a return on nothing is not a percentage");
  assert.equal(roiOf({ own: null }, "live"), null);

  // The denominator is the CLOSED trades' cost, not `stake`, which spans open positions and
  // would charge a finished result against money still working.
  assert.match(APP, /const investedClosed = closedTrades\s*\n\s*\.reduce\(/);
  assert.match(APP, /invested = own\.investedClosed;/);

  // On the paper side an unfilled limit order never bought anything, so it is neither
  // profit nor capital spent -- counting its reserved notional would dilute the return of
  // every portfolio that rests bids.
  assert.match(APP, /const filled = trades\.filter\(\(trade\) => !isUnfilledLimitOrder\(trade\)\);/);

  // The column and the ordering read one number, or the table is sorted by one value while
  // showing another. The old annualized helper is gone rather than left to be picked up.
  assert.match(APP, /const roi = portfolioRealizedRoiForMode\(mode\);\s*\n\s*return roi && Number\.isFinite\(roi\.roi\)/);
  assert.doesNotMatch(APP, /overviewAnnualizedRoi|portfolioAnnualizedRoiForMode/);
  assert.match(APP, /<th title="Realized P\/L as a share of what the closed trades cost[^"]*">ROI<\/th>/);
});

// Reported three times running: the shortlist shows candidates the execution then refuses.
// The quote gate took it from sixteen to seven; these are the seven.
//
// Measured rather than guessed, after guessing wrong once. The executor's own verdict on
// the two rows from the report -- via its own prepareLiveCandidatePool, not an imitation --
// was "volume below live minimum" for both, and twelve of its sixteen rejections across
// that catalogue were the same gate. Their spreads were 3 and 4 points, well inside the
// limit, so the spread rule would have passed them.
test("shortlist volume gate: the same figure and the same floor the run uses", () => {
  const volumeOf = new Function("item", `
    ${extractFunction(APP, "candidateVolumeUsdc")}
    return candidateVolumeUsdc(item);
  `);

  // The first POSITIVE of four fields, in order -- not the first present one. Both reported
  // rows carried a tiny volumeUsdc beside a large liquidity, so which field is read is the
  // entire verdict.
  assert.equal(volumeOf({ volumeUsdc: 3.92, liquidity: 33999.79 }), 3.92);
  assert.equal(volumeOf({ volumeUsdc: 26.74, liquidity: 25555.14 }), 26.74);
  assert.equal(volumeOf({ volumeUsdc: 0, volume24hr: 250, liquidity: 9 }), 250,
    "a zero is skipped rather than returned, or every unscored row would read as zero volume");
  assert.equal(volumeOf({ volumeUsdc: null, volume24hr: null, firstVolume24hr: 40 }), 40);
  assert.equal(volumeOf({}), 0);

  // It has to stay a port. The executor builds the run's verdict from its own copy, and a
  // drift between them is exactly this bug.
  const executor = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const fields = /\[item\.volumeUsdc, item\.volume24hr, item\.firstVolume24hr, item\.liquidity\]/;
  assert.match(executor, fields, "the executor still reads these four in this order");
  assert.match(APP, fields, "and so does the browser");

  // The floor is 100 by DEFAULT, not only when a portfolio names one. The endpoint that
  // serves this shortlist applies no such default, which is how rows reach the screen that
  // the run refuses on sight.
  assert.match(APP, /const DEFAULT_MIN_VOLUME_USDC = 100;/);
  assert.match(APP, /minimumVolume != null && minimumVolume > 0 \? minimumVolume : DEFAULT_MIN_VOLUME_USDC/,
    "a portfolio's own minimum wins, and absence means the run's default rather than none");
  assert.match(executor, /envNumber\("PAPER_MIN_VOLUME_24H", 100\)/,
    "which is the executor's last fallback; if that changes, this default has to follow");
});

// Asked for: "I don't actually know what percentage it sold at." Nothing on the closed row
// said. The chip read "Protective exit" and the price column showed the fill, but the level
// the stop was SET at, the bid it found, and the gap between them were nowhere -- which is
// exactly what is needed to judge whether a stop fired too early or too late.
test("closed trades: a protective exit shows the level, the bid and the gap", () => {
  const note = new Function("trade", `
    ${extractFunction(APP, "numericOrNull")}
    ${extractFunction(APP, "percent")}
    ${extractFunction(APP, "probability")}
    ${extractFunction(APP, "escapeHtml")}
    ${extractFunction(APP, "stopExecutionNote")}
    return stopExecutionNote(trade);
  `);

  // A live row: the level and the bid arrive from the exit record.
  const live = note({ entryPrice: 0.72, exitStopPrice: 0.2575, exitBestBid: 0.015, exitPrice: 0.015 });
  assert.match(live, /class="info-button"/, "reached through an i, not printed inline");
  assert.match(live, /Bought at 72/);
  assert.match(live, /stop was set at 25\.8/);
  assert.match(live, /best bid was 1\.5/);
  assert.match(live, /sold at 1\.5/);
  assert.match(live, /below the level, so the loss is that much larger/,
    "the gap between the level and the fill is the number that judges the stop");

  // A paper row records the same facts on itself under different names.
  const paper = note({ entryPrice: 0.95, stopPrice: 0.8625, observedBidAtStop: 0.86, currentPrice: 0.8625 });
  assert.match(paper, /Bought at 95/);
  assert.match(paper, /stop was set at 86\.3/);
  assert.match(paper, /at or above the level, so the stop capped the loss where it was meant to/);

  // Why the two ends of a portfolio's range behave differently, which is the thing that
  // looked inconsistent: the same setting gives a 95c entry 8.8 points of room and a 72c
  // entry 46.3.
  assert.match(paper, /gave it 8\.7/);
  assert.match(live, /gave it 46\.3/);

  // A row with none of it says nothing rather than an empty tooltip.
  assert.equal(note({ entryPrice: 0.72 }), "");
});
