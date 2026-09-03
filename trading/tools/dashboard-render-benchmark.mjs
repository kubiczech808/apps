// Offline benchmark for the dashboard's per-row work. No network, no credentials, no
// production data: it builds a state the size of the real one and times the functions the
// render path calls once per table row.
//
// Reported: the UI feels slow and stutters. The tables are a few hundred rows, which is
// nothing to render -- but several of the helpers behind them rebuild a whole index, or
// copy a whole catalogue, on EVERY row. That is invisible in the code (each call looks
// like a lookup) and quadratic in practice, so it needs measuring rather than reading.
//
// Run: node tools/dashboard-render-benchmark.mjs
import { readFile } from "node:fs/promises";

const APP = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

// Same extraction the tests use: pull a function out of app.js by name, balanced braces.
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} was not found`);
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

// The sizes production actually reaches: the scraped catalogue is served capped at 1200,
// each live portfolio keeps a bounded run log, and the closed ledger passed 120 rows today.
const SCRAPED = Number(process.env.BENCH_SCRAPED || 1200);
const RUN_LOG = Number(process.env.BENCH_RUN_LOG || 120);
const ATTEMPTS = Number(process.env.BENCH_ATTEMPTS || 3);
const ROWS = Number(process.env.BENCH_ROWS || 150);
const REPEATS = Number(process.env.BENCH_REPEATS || 5);

const token = (index) => `token-${index}`;

function buildState() {
  const observations = Array.from({ length: SCRAPED }, (unused, index) => ({
    tokenId: token(index),
    conditionId: `condition-${index}`,
    question: `Scraped market ${index}`,
    slug: `market-${index}`,
    polymarketTags: ["sports"],
    marketPrice: 0.7,
  }));
  const runLog = Array.from({ length: RUN_LOG }, (unused, run) => ({
    generatedAt: `2026-09-0${(run % 9) + 1}T10:00:00Z`,
    selected: { tokenId: token(run) },
    revalidationUpdates: [],
    attempts: Array.from({ length: ATTEMPTS }, (ignored, attempt) => ({
      action: "SUBMITTED",
      tokenId: token((run * ATTEMPTS + attempt) % SCRAPED),
      orderPrice: 0.7,
    })),
  }));
  const executionState = { generatedAt: "2026-09-02T10:00:00Z", attempts: runLog[0].attempts, runLog };
  return {
    mode: "live",
    portfolioConfig: { live: {}, live5050: {}, livePortfolios: { live2: {}, live3: {} } },
    botState: { evaluations: [], marketObservations: observations },
    scrapedMarketStateLoaded: false,
    liveExecutionState: executionState,
    liveExecutionByMode: {
      live: executionState,
      "live-custom-live2": executionState,
      "live-custom-live3": executionState,
    },
    live5050ExecutionState: executionState,
    liveState: { positions: [], closedTrades: [] },
  };
}

// The rows a live table renders: a filled position carries an entry price, a resting order
// carries an order price. Both go through attribution once each.
const rows = Array.from({ length: ROWS }, (unused, index) => (index % 2
  ? { tokenId: token(index), entryPrice: 0.7, shares: 6, question: `Row ${index}` }
  : { tokenId: token(index), price: 0.7, question: `Row ${index}` }));

const sandbox = new Function("state", `
  const CUSTOM_PAPER_STRATEGY_ID = /^[a-z][a-zA-Z0-9]{1,30}$/;
  const BUILT_IN_PAPER_STRATEGY_IDS = [];
  const draftedCustomLivePortfolioId = () => null;
  ${/const FIXED_ENTRY_PRICE_TOLERANCE = [\d.]+;/.exec(APP)[0]}
  ${extractFunction(APP, "memoizedByIdentity")}
  ${extractFunction(APP, "earliestIndexedMatch")}
  ${extractFunction(APP, "liveMarketMetadataIndex")}
  ${extractFunction(APP, "normalizeMode")}
  ${extractFunction(APP, "customLivePortfolioIdFromMode")}
  ${extractFunction(APP, "isFixedEntryMode")}
  ${extractFunction(APP, "isLivePortfolioMode")}
  ${extractFunction(APP, "scrapedObservationIsError")}
  ${extractFunction(APP, "scrapedMarketObservations")}
  ${extractFunction(APP, "isClosedTrade")}
  ${extractFunction(APP, "isFilledPortfolioRow")}
  ${extractFunction(APP, "fixedEntryPriceSignatures")}
  ${extractFunction(APP, "matchesFixedEntryPrice")}
  ${extractFunction(APP, "restsAtFixedEntryPrice")}
  ${extractFunction(APP, "fixedEntryOrderPricesByToken")}
  ${extractFunction(APP, "boughtAtFixedEntryPrice")}
  ${extractFunction(APP, "allLiveModes")}
  ${extractFunction(APP, "liveOrdersByToken")}
  ${extractFunction(APP, "newestLiveOrder")}
  ${extractFunction(APP, "liveTokenOwnerMode")}
  ${extractFunction(APP, "belongsToLivePortfolio")}
  ${extractFunction(APP, "liveMarketMetadataForTrade")}
  const normalizeFixedEntryPrice = (value) => Number(value);
  const portfolioConfigForMode = () => ({ fixedEntryPrice: 0.5 });
  // Every memo hangs its cache off the function object, so dropping them reproduces the
  // pre-memo behaviour exactly -- the same code, forced to rebuild on the next call.
  const memoized = [scrapedMarketObservations, fixedEntryOrderPricesByToken, liveOrdersByToken, liveMarketMetadataIndex];
  const clearMemos = () => { for (const fn of memoized) delete fn.memo; };
  return { belongsToLivePortfolio, liveMarketMetadataForTrade, liveOrdersByToken, scrapedMarketObservations, clearMemos };
`);

function time(label, run) {
  const samples = [];
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const started = process.hrtime.bigint();
    run();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((left, right) => left - right);
  const median = samples[Math.floor(samples.length / 2)];
  console.log(`   ${label.padEnd(46)} ${median.toFixed(1).padStart(8)} ms   (min ${samples[0].toFixed(1)}, max ${samples[samples.length - 1].toFixed(1)})`);
  return median;
}

console.log(`Dashboard per-row benchmark`);
console.log(`scraped catalogue ${SCRAPED}   run log ${RUN_LOG} runs x ${ATTEMPTS} attempts`
  + `   table rows ${ROWS}   repeats ${REPEATS}`);
console.log(`Offline: no network, no production data.\n`);

const state = buildState();
const app = sandbox(state);

// The memo caches on the function object, so clearing it before every row reproduces exactly
// what the code did before -- a full index rebuild per lookup -- and leaving it alone
// measures what it does now. Same functions, same data, one run: a before and after that
// cannot drift apart.
console.log(`== one full pass over the rows, as a render does`);
const attributionBefore = time("attribution, rebuilding per row (before)", () => {
  for (const row of rows) {
    app.clearMemos();
    app.belongsToLivePortfolio(row, "live");
  }
});
const attributionAfter = time("attribution, index kept (after)", () => {
  app.clearMemos();
  for (const row of rows) app.belongsToLivePortfolio(row, "live");
});
const metadataBefore = time("metadata, rebuilding per row (before)", () => {
  for (const row of rows) {
    app.clearMemos();
    app.liveMarketMetadataForTrade(row);
  }
});
const metadataAfter = time("metadata, index kept (after)", () => {
  app.clearMemos();
  for (const row of rows) app.liveMarketMetadataForTrade(row);
});

const before = attributionBefore + metadataBefore;
const after = attributionAfter + metadataAfter;

console.log(`\n== what that means`);
console.log(`   one pass over ${ROWS} rows: ${before.toFixed(1)} ms before, ${after.toFixed(1)} ms after`
  + `   (${(before / Math.max(after, 0.0001)).toFixed(0)}x)`);
console.log(`   A render draws several tables, so multiply by the number of tables. Every figure`);
console.log(`   is one pass, and the dashboard re-renders on each state change -- a sync, a`);
console.log(`   refresh, a tab click -- so this is per interaction.`);
if (before > 100) {
  console.log(`\n   -> ${before.toFixed(0)} ms of per-row work blocks the main thread: nothing`);
  console.log(`      scrolls or clicks while it runs, which is the reported stutter.`);
}

// A cache that answers a question about state it no longer reflects is worse than a slow one.
// Replacing a payload the way the loader does has to change the answer.
const probe = { tokenId: token(7), entryPrice: 0.7, shares: 6 };
const staleCheck = app.liveMarketMetadataForTrade(probe);
state.liveExecutionState = {
  generatedAt: "2026-09-02T11:00:00Z",
  selected: { tokenId: token(7), question: "Replaced payload" },
  attempts: [],
  runLog: [],
};
const freshCheck = app.liveMarketMetadataForTrade(probe);
console.log(`\n== invalidation`);
console.log(`   before the payload was replaced: ${staleCheck?.question}`);
console.log(`   after:                          ${freshCheck?.question}`);
if (freshCheck?.question !== "Replaced payload") {
  console.log(`   FAILED: the index did not rebuild when its state was replaced.`);
  process.exitCode = 1;
}
