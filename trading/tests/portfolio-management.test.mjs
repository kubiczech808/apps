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
const APP = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../assets/app.css", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const BOT = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
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
  // A created portfolio does not start trading the moment it is saved.
  assert.equal(created.automationEnabled, false);
  assert.equal(created.archived, false);
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
  assert.equal(created.length, 12, "every created portfolio becomes a strategy the bot runs each pass");
  // And the shipped ones are never displaced by the cap.
  assert.equal(Object.keys(config.paper).length, 16);
});

// Asked for explicitly: archiving hides a portfolio and deactivates it, without losing
// anything, and restoring is only clearing the flag.
test("archiving: the flag round-trips on paper and is refused on live", () => {
  const config = normalizeConfig({
    paper: { equal: { archived: true }, conservative: { archived: false } },
    live: { archived: true },
    live5050: { archived: true },
  });
  assert.equal(config.paper.equal.archived, true);
  assert.equal(config.paper.conservative.archived, false);
  // A live portfolio holds real positions and open orders; hiding those from the
  // dashboard would hide real exposure.
  assert.equal(config.live.archived, false);
  assert.equal(config.live5050.archived, false);
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
  const build = new Function("process", "MAX_FRACTION", "DEFAULT_MAX_RESOLUTION_DAYS", "PAPER_STRATEGIES",
    "normalizeExecutionTrigger", "console", `
    ${extractFunction(BOT, "customPaperStrategies")}
    return customPaperStrategies;
  `)(
    { env: {} },
    0.05,
    7,
    { conservative: { id: "conservative" } },
    (value) => (value === "after_scrape" ? "after_scrape" : "cron"),
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
  assert.equal(strategies.esports.marketType, "binary");
  assert.equal(strategies.esports.automationEnabled, true);
  assert.equal(strategies.esports.allowRotation, true);
  assert.deepEqual([...strategies.esports.includeOnlyMarketTags], ["league-of-legends"]);
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
    ${extractFunction(APP, "dashboardModes")}
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
    ["paper-conservative", "paper-highReward", "paper-moreProbable", "paper-esports", "live", "live-5050"],
    "archived portfolios leave the dashboard and created ones join it");
  assert.deepEqual(api.paperStrategyIds({ includeArchived: true }),
    ["conservative", "highReward", "moreProbable", "equal", "esports"]);
  assert.equal(api.portfolioIsArchived("paper-equal"), true);
  assert.equal(api.portfolioIsArchived("paper-esports"), false);
  // A created portfolio's mode is real; a stale bookmark to a deleted one is not.
  assert.equal(api.normalizeMode("paper-esports"), "paper-esports");
  assert.equal(api.normalizeMode("paper-deleted"), "paper-conservative");
  assert.equal(api.normalizeMode("live-5050"), "live-5050");
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

test("dashboard: a created portfolio's settings are its own", () => {
  const run = new Function("state", `
    ${/const BUILT_IN_PAPER_STRATEGY_IDS = \[[^\]]*\];/.exec(APP)[0]}
    ${/const CUSTOM_PAPER_STRATEGY_ID = [^\n]+/.exec(APP)[0]}
    ${/const LIVE_MODES = new Set\(\[[^\]]*\]\);/.exec(APP)[0]}
    ${extractFunction(APP, "normalizeMode")}
    ${extractFunction(APP, "isFixedEntryMode")}
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
  // and start trading immediately, neither of which this portfolio asked for.
  assert.equal(api.portfolioConfigForMode("paper-esports").minProbability, 0.5);
  assert.equal(api.portfolioConfigForMode("paper-esports").automationEnabled, false);
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
  const run = new Function(`
    ${extractFunction(APP, "normalizePortfolioName")}
    ${extractFunction(APP, "portfolioPrefillFromDataset")}
    return portfolioPrefillFromDataset;
  `)();

  // A tag row measured one tag at one probability, so the created portfolio trades that.
  assert.deepEqual(run({ prefillName: "league-of-legends", prefillProbability: "0.7", prefillTag: "league-of-legends" }), {
    displayName: "league-of-legends",
    minProbability: 0.7,
    includeOnlyMarketTags: ["league-of-legends"],
  });
  // A parameter row measured a probability, a market type and a resolution ceiling.
  assert.deepEqual(run({ prefillName: "75% Yes/No 3d", prefillProbability: "0.75", prefillDays: "3", prefillMarketType: "binary" }), {
    displayName: "75% Yes/No 3d",
    minProbability: 0.75,
    maxResolutionDays: 3,
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
test("archiving: a direct control sits next to the edit icon, for paper only", () => {
  const card = extractFunction(APP, "renderPortfolioRulesCard");
  assert.match(card, /archiveStrategyId \? `[\s\S]*?data-portfolio-archive-direct="\$\{escapeHtml\(archiveStrategyId\)\}"[\s\S]*?` : ""/,
    "the button only renders when a strategy id is actually passed in");

  assert.match(APP, /renderPortfolioRulesCard\(portfolioState\.label \|\| "Paper portfolio", portfolioRuleRows\(\{ \.\.\.portfolioState, \.\.\.portfolio \}\), portfolioState\.id\)/,
    "the paper card passes its own strategy id");
  assert.match(APP, /renderPortfolioRulesCard\(isFixedEntryMode\(\) \? "5050 portfolio" : "Live portfolio", livePortfolioRuleRows\(\)\)/,
    "the live card passes none, so live portfolios get no archive control -- they hold real positions");

  const handler = /const directArchiveButton = event\.target\.closest\("\[data-portfolio-archive-direct\]"\);[\s\S]*?\n  \}/.exec(APP);
  assert.ok(handler, "the direct archive control is wired");
  assert.match(handler[0], /if \(!window\.confirm\([\s\S]*?\)\) \{\n      return;\n    \}/,
    "the same confirmation gates it as the modal's own archive button");
  assert.match(handler[0], /setPortfolioArchived\(strategyId, true\)/);
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
  assert.match(APP, /: `Paper \$\{portfolioNameForMode\(paperModeFromStrategyId\(options\.paperStrategyId\)\)\} action:/,
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
    ${extractFunction(APP, "isLiveMode")}
    ${extractFunction(APP, "paperStrategyIdFromMode")}
    ${extractFunction(APP, "selectedPaperPortfolio")}
    ${extractFunction(APP, "paperPortfolioList")}
    ${extractFunction(APP, "normalizePortfolioName")}
    ${extractFunction(APP, "portfolioRunLogHistoryState")}
    ${extractFunction(APP, "isCadenceWaitRun")}
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
  assert.match(overview, /<th>Portfolio<\/th><th>Equity<\/th><th>Risk \/ free<\/th>/);
  assert.match(overview, /equity: portfolio \? Number\(portfolio\.equityUsdc\) : null/);
  assert.match(overview, /risk: portfolio \? Number\(portfolio\.openRiskUsdc\) : null/);
  assert.match(overview, /free: portfolio \? Number\(portfolio\.freeCapitalUsdc\) : null/);
  // Both live tabs trade one wallet, so their capital is one row rather than the same
  // equity printed twice.
  assert.match(overview, /name: "Live account \(Live \+ 5050\)"/);
  // It must show every listed portfolio, so it is built from the same list as the tabs.
  assert.match(overview, /paperStrategyIds\(\)\.map/);
  // And a number that is not loaded reads as absent rather than as zero.
  assert.match(overview, /Number\.isFinite\(value\) \? money\(value\) : "-"/);
});

test("dashboard: the overview and the archived list render on the first load", () => {
  // Both the paper and the live render paths call syncModeUi, including on the first
  // load. Hanging these off the dashboard rerender instead left both panels empty until
  // something else on the page changed.
  const sync = extractFunction(APP, "syncModeUi");
  assert.match(sync, /renderPortfolioOverview\(\);/);
  assert.match(sync, /renderArchivedPortfolios\(\);/);
  assert.match(sync, /if \(live\) loadPortfolioOverview\(\);/,
    "the paper numbers are only fetched when the open tab does not already carry them");
  for (const path of ["renderBotState", "renderLiveState"]) {
    assert.match(extractFunction(APP, path), /syncModeUi\(\);/, `${path} must reach it`);
  }
});

test("dashboard: a live portfolio's tab is marked, not merely named", () => {
  assert.match(APP, /button\.classList\.toggle\("mode-button-live", LIVE_MODES\.has\(buttonMode\)\);/);
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
      conservative: { stopLossEnabled: true },
      highReward: {},
      equal: { stopLossEnabled: false },
    },
  });
  assert.equal(config.paper.conservative.stopLossEnabled, true, "any portfolio can turn it on");
  assert.equal(config.paper.highReward.stopLossEnabled, false, "off unless explicitly enabled");
  assert.equal(config.paper.moreProbable.stopLossEnabled, false);
  assert.equal(config.paper.equal.stopLossEnabled, false, "and Equal can turn it off too");
});

test("stop loss: an untouched config keeps every portfolio's established behavior", () => {
  const config = normalizeConfig({});
  for (const id of ["conservative", "highReward", "moreProbable"]) {
    assert.equal(config.paper[id].stopLossEnabled, false, `${id} never had this on`);
  }
  assert.equal(config.paper.equal.stopLossEnabled, true, "Equal shipped with it on");
});

test("stop loss: a created portfolio starts with it off, like every other new switch", () => {
  const config = normalizeConfig({ paper: { esports: { displayName: "Esports 60" } } });
  assert.equal(config.paper.esports.stopLossEnabled, false);
});

test("stop loss: the bot reads a per-portfolio switch, not a constant on Equal alone", () => {
  // The four shipped strategies each read their own env var, mirroring exactly how
  // rotation is already wired -- and there is no longer a bare `equalRiskProtection:
  // true` sitting outside that pattern for Equal specifically.
  for (const [prefix, fallback] of [
    ["PAPER_CONSERVATIVE", "false"],
    ["PAPER_HIGH_REWARD", "false"],
    ["PAPER_MORE_PROBABLE", "false"],
    ["PAPER_EQUAL", "true"],
  ]) {
    assert.match(BOT, new RegExp(`equalRiskProtection: envBool\\("${prefix}_STOP_LOSS_ENABLED", ${fallback}\\)`));
  }
  assert.equal((BOT.match(/equalRiskProtection: true,/g) || []).length, 0,
    "no strategy may hardcode this outside the per-portfolio switch");

  const build = new Function("process", "MAX_FRACTION", "DEFAULT_MAX_RESOLUTION_DAYS", "PAPER_STRATEGIES",
    "normalizeExecutionTrigger", "console", `
    ${extractFunction(BOT, "customPaperStrategies")}
    return customPaperStrategies;
  `)({ env: {} }, 0.05, 7, { conservative: { id: "conservative" } },
    (value) => (value === "after_scrape" ? "after_scrape" : "cron"), console);
  const strategies = build(JSON.stringify({
    esports: { displayName: "Esports 60", stopLossEnabled: true },
    dota: { displayName: "Dota" },
  }));
  assert.equal(strategies.esports.equalRiskProtection, true);
  assert.equal(strategies.dota.equalRiskProtection, false);
});

test("stop loss: the workflow passes it through with Equal's established default", () => {
  assert.match(WORKFLOW,
    /emit\(f"\{prefix\}_STOP_LOSS_ENABLED", str\(bool\(row\.get\("stopLossEnabled", strategy == "equal"\)\)\)\.lower\(\)\)/);
});

test("stop loss: the parameter modal offers it for every paper portfolio and hides it for live", () => {
  assert.match(HTML, /data-stop-loss-enabled/);
  assert.match(HTML, /data-paper-only-row/);
  const sync = extractFunction(APP, "syncPortfolioParameterControls");
  assert.match(sync, /const stopLossEnabled = stopLossIsEnabled\(config\);/);
  assert.match(sync, /els\.stopLossEnabled\.checked = stopLossEnabled;/);
  assert.match(sync,
    /els\.paperOnlyRows\?\.forEach\(\(row\) => row\.toggleAttribute\("hidden", LIVE_MODES\.has\(normalizeMode\(mode\)\)\)\);/,
    "hidden specifically for live modes, not merely for one hardcoded mode");
  assert.match(APP, /els\.stopLossEnabled\?\.addEventListener\("change"/);
  // Off by default: unlike rotation (on unless explicitly false), most portfolios have
  // never had this behavior, so an absent value must not read as enabled.
  assert.match(APP, /function stopLossIsEnabled\(config = \{\}\) \{\n  return config\.stopLossEnabled === true;\n\}/);
});

test("stop loss: the rules card shows it for every paper portfolio, not only Equal", () => {
  const rows = extractFunction(APP, "portfolioRuleRows");
  assert.ok(!/if \(portfolio\.id === "equal"\)/.test(rows),
    "the row must not be conditional on which portfolio this is");
  assert.match(rows, /rows\.push\(\["Stop loss", stopLossIsEnabled\(config\)/);
});
