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

test("dashboard: the tab row survives being rebuilt", () => {
  // Portfolios are created, renamed, archived and restored, so handlers bound to the
  // buttons themselves would stop working after the first of those.
  assert.match(APP, /const button = event\.target\.closest\("\[data-mode-toggle\]"\);/,
    "mode switching must be delegated");
  assert.ok(!/els\.modeButtons\.forEach\(\(button\) => \{\s*\n\s*button\.addEventListener/.test(APP),
    "no handler may be bound to a button that gets replaced");
  assert.match(APP, /els\.modeButtons = els\.modeSwitch\.querySelectorAll\("\[data-mode-toggle\]"\);/);
});

test("mobile: the portfolio tabs stay on one row and scroll sideways", () => {
  const mobile = /@media \(max-width: 680px\) \{[\s\S]*?\n\}/.exec(CSS);
  assert.ok(mobile, "the mobile breakpoint exists");
  const modeSwitch = /\.mode-switch \{[^}]*\}/.exec(mobile[0]);
  assert.ok(modeSwitch, "the tab row is styled for mobile");
  // A wrapping grid grew downwards as portfolios were created until the tabs pushed the
  // dashboard off the screen.
  assert.match(modeSwitch[0], /flex-wrap: nowrap;/);
  assert.match(modeSwitch[0], /overflow-x: auto;/);
  assert.ok(!/grid-template-columns/.test(modeSwitch[0]), "it must not wrap into rows again");
  const modeButton = /\n  \.mode-button \{[^}]*\}/.exec(mobile[0]);
  assert.match(modeButton[0], /flex: 0 0 auto;/, "tabs keep their size rather than being squeezed");
  assert.match(modeButton[0], /white-space: nowrap;/);
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
