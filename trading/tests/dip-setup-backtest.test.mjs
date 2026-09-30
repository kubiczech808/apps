// Runs offline: the setup backtest's own functions, executed against fabricated cache rows.
// No network, no secrets.

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import {
  dipRuleOf,
  findPortfolio,
  gridCells,
  nearHalf,
  parseBands,
  portfolioRows,
  printGrid,
  probability,
  ruleVersion,
  setupEntry,
  setupStats,
  setupTrades,
  slugPrefix,
  unsimulatedRows,
  wilson,
} from "../tools/dip-setup-backtest.mjs";

// A cached market as dip-history-backtest.mjs writes it: first in-play touch at or below each
// level, each with its own price, time, fee and P/L at a $5 stake.
function market({ question = "Sinner vs Alcaraz", slug = "atp-sinner-alcaraz-2026-09-20", outcome = "Sinner",
  opening = 0.8, touches = {}, won = true, simulated = true } = {}) {
  const entries = {};
  for (const [level, [price, at]] of Object.entries(touches)) {
    entries[level] = {
      enteredAt: at,
      entryPrice: price,
      feeUsdc: 0,
      pnlUsdc: won ? 5 / price - 5 : -5,
      outcome: won ? "WIN" : "LOSS",
    };
  }
  return { question, slug, outcome, openingPrice: opening, openingInBand: simulated, resolvedAt: "2026-09-20T20:00:00Z", entries };
}

const RULE = { openMin: 0.7, openMax: 0.99, buyMin: 0.45, buyMax: 0.56, excludedShapes: [] };

test("probability: a setting stored as a fraction or typed as a percentage reads the same", () => {
  assert.equal(probability(0.7), 0.7);
  assert.equal(probability(70), 0.7);
  assert.equal(probability("56"), 0.56);
  assert.equal(probability(null), null);
});

test("findPortfolio: the name the user typed finds the live portfolio, spacing aside", () => {
  const rows = portfolioRows({
    livePortfolios: { dip704060live: { displayName: "dip 70+ -> 45-56 live" } },
    paper: { dip704060: { displayName: "dip 70+ -> 45-56" } },
  });
  assert.equal(findPortfolio(rows, "dip 70+ ->45-56 live")?.id, "live-custom-dip704060live");
  assert.equal(findPortfolio(rows, "dip 70+ -> 45-56")?.id, "paper-dip704060", "the exact paper name is not the live one");
  assert.equal(findPortfolio(rows, "dip704060live")?.id, "live-custom-dip704060live", "and an id works too");
  assert.equal(findPortfolio(rows, "nothing like it"), null);
});

test("dipRuleOf: the live watch's rule, with the legacy over-under switch folded into the shapes", () => {
  const rule = dipRuleOf({
    dipEntryOpenMin: 0.7, dipEntryOpenMax: 0.99, dipEntryBuyMin: 0.45, dipEntryBuyMax: 0.56,
    excludedMarketShapes: ["exact-score", "NOT-A-SHAPE"], excludeOverUnderMarkets: true,
    includeOnlyMarketTags: ["Tennis"], stakeUsdc: 10,
  });
  assert.deepEqual(rule.excludedShapes, ["exact-score", "over-under"], "unknown ids dropped, legacy switch kept");
  assert.equal(rule.buyMax, 0.56);
  assert.deepEqual(rule.includeOnlyTags, ["tennis"]);
  assert.equal(rule.stakeUsdc, 10);
  assert.equal(dipRuleOf({ minProbability: 0.3, maxProbability: 0.56 }).buyMin, 0.3,
    "an older row without dip fields reads its band from the probability fields, as the watch does");
});

test("setupEntry: the earliest recorded touch inside the band is the trade", () => {
  // The price reached 0.52 at 21:00 (first touch at or below 0.6 AND 0.55), then 0.48 at 22:00.
  const row = market({ touches: {
    0.6: [0.52, "2026-09-20T21:00:00Z"], 0.55: [0.52, "2026-09-20T21:00:00Z"], 0.5: [0.48, "2026-09-20T22:00:00Z"],
    0.45: [0.40, "2026-09-20T23:00:00Z"], 0.4: [0.40, "2026-09-20T23:00:00Z"],
  } });
  const entry = setupEntry(row, [0.45, 0.56]);
  assert.equal(entry.entryPrice, 0.52);
  assert.equal(entry.enteredAt, "2026-09-20T21:00:00Z");
});

test("setupEntry: a first touch above the ceiling defers to the next one inside the band", () => {
  // 0.58 is at or below 0.6 but above 0.56 -- the live worker would not have bought it.
  const row = market({ touches: {
    0.6: [0.58, "2026-09-20T21:00:00Z"], 0.55: [0.54, "2026-09-20T22:00:00Z"], 0.5: [0.49, "2026-09-20T23:00:00Z"],
  } });
  assert.equal(setupEntry(row, [0.45, 0.56]).entryPrice, 0.54);
});

test("setupEntry: a market that gapped straight through the floor is no trade", () => {
  const row = market({ touches: { 0.6: [0.4, "2026-09-20T21:00:00Z"], 0.55: [0.4, "2026-09-20T21:00:00Z"],
    0.5: [0.4, "2026-09-20T21:00:00Z"], 0.45: [0.4, "2026-09-20T21:00:00Z"] } });
  assert.equal(setupEntry(row, [0.45, 0.56]), null);
});

test("setupEntry: both edges of the band are inclusive", () => {
  assert.equal(setupEntry(market({ touches: { 0.6: [0.56, "2026-09-20T21:00:00Z"] } }), [0.45, 0.56]).entryPrice, 0.56);
  assert.equal(setupEntry(market({ touches: { 0.45: [0.45, "2026-09-20T21:00:00Z"] } }), [0.45, 0.56]).entryPrice, 0.45);
});

test("setupTrades: the opening band and the excluded shapes are the portfolio's own", () => {
  const touch = { 0.55: [0.5, "2026-09-20T21:00:00Z"] };
  const rows = [
    market({ touches: touch }),
    market({ opening: 0.65, touches: touch }),
    market({ question: "Exact Score: Maranhao AC MA 3 - 2 Brusque FC SC?", slug: "bra3-mar-bru-2026-08-09-exact-score-3-2",
      outcome: "No", touches: touch }),
    market({ question: "Games Total: O/U 22.5", slug: "atp-sinner-alcaraz-2026-09-20-total-games-22pt5", outcome: "Over",
      touches: touch }),
    market({ question: "Set 1 Winner: Sinner vs Alcaraz", touches: touch }),
  ];
  const all = setupTrades(rows, RULE);
  assert.equal(all.length, 4, "only the 65% opening is outside a 70+ band");
  assert.deepEqual(all.map((trade) => trade.shape).sort(), ["exact-score", "in-event-leg", "outright", "over-under"],
    "classified by the bot's own marketShape()");

  const excluding = setupTrades(rows, { ...RULE, excludedShapes: ["exact-score", "over-under", "in-event-leg"] });
  assert.deepEqual(excluding.map((trade) => trade.shape), ["outright"]);
});

test("setupStats: a stake other than the cache's $5 scales P/L, and edge is win% minus price", () => {
  const trades = setupTrades([
    market({ touches: { 0.55: [0.5, "2026-09-20T21:00:00Z"] }, won: true }),
    market({ touches: { 0.55: [0.5, "2026-09-20T21:00:00Z"] }, won: false }),
  ], RULE);
  const atFive = setupStats(trades, 5);
  assert.equal(atFive.trades, 2);
  assert.equal(atFive.winPct, 50);
  assert.equal(atFive.meanPricePct, 50);
  assert.equal(atFive.edgePoints, 0, "a coin bought at 50c that wins half the time has no edge");
  assert.equal(atFive.pnlUsdc, 0);
  const atTen = setupStats(trades.slice(0, 1), 10);
  assert.equal(atTen.pnlUsdc, 10, "a $10 win at 50c returns $10 profit, twice the cache's $5");
  assert.equal(atTen.stakedUsdc, 10);
});

test("nearHalf: the empty-book cluster is 0.495-0.51, and nothing either side of it", () => {
  for (const price of [0.495, 0.5, 0.5005, 0.5055, 0.509, 0.51]) assert.equal(nearHalf(price), true, String(price));
  for (const price of [0.494, 0.511, 0.45, 0.56, null]) assert.equal(nearHalf(price), false, String(price));
});

test("wilson: forty trades pin a win rate only to a range", () => {
  const [low, high] = wilson(30, 40);
  assert.ok(low > 0.59 && low < 0.61, `low ${low}`);
  assert.ok(high > 0.85 && high < 0.87, `high ${high}`);
  assert.deepEqual(wilson(0, 0), [0, 0]);
});

test("slugPrefix: the league or game at the front of the slug", () => {
  assert.equal(slugPrefix({ slug: "atp-sinner-alcaraz-2026-09-20" }), "atp");
  assert.equal(slugPrefix({ slug: "", eventSlug: "wta-swiatek-gauff-2026-09-20" }), "wta");
  assert.equal(slugPrefix({}), "(no slug)");
});

test("ruleVersion: the backtest rule a cached row was simulated under", () => {
  assert.equal(ruleVersion({ fingerprint: JSON.stringify([7, "123", 1]) }), 7);
  assert.equal(ruleVersion({ fingerprint: JSON.stringify([6, "123", 1]) }), 6);
  assert.equal(ruleVersion({ fingerprint: "not json" }), null);
  assert.equal(ruleVersion({}), null);
});

// ---------------------------------------------------------------------------------------
// The grid: opening band x buy band, each cell the portfolio's own rule with two bands swapped.

const T1 = "2026-09-20T21:00:00Z";
const T2 = "2026-09-20T21:30:00Z";
const LIVE_RULE = { openMin: 0.7, openMax: 0.999, buyMin: 0.45, buyMax: 0.56, excludedShapes: ["other", "spread"] };
const cellOf = (cells, open, buy) => cells.find((cell) => cell.open[0] === open[0] && cell.open[1] === open[1]
  && cell.buy[0] === buy[0] && cell.buy[1] === buy[1]);
const openings = (cell) => cell.trades.map((trade) => trade.row.openingPrice).sort();

function gridRows() {
  return [
    market({ opening: 0.8, touches: { 0.55: [0.53, T1] } }),
    market({ opening: 0.66, touches: { 0.55: [0.52, T1] } }),
    // Touched 0.58 first (at or below 0.6), then 0.55 half an hour later.
    market({ opening: 0.95, touches: { 0.6: [0.58, T1], 0.55: [0.55, T2] } }),
    market({ opening: 0.75, question: "Spread: Sinner (-1.5)", touches: { 0.55: [0.5, T1] } }),
  ];
}

test("gridCells: the cell with the portfolio's own bands IS the single-rule report", () => {
  const rows = gridRows();
  const cells = gridCells(rows, LIVE_RULE);
  const current = cells.filter((cell) => cell.current);
  assert.equal(current.length, 1, "exactly one cell is the current setting, its 99.9% ceiling read as the cache's 99%");
  assert.deepEqual(current[0].open, [0.7, 0.99]);
  assert.deepEqual(current[0].buy, [0.45, 0.56]);
  const single = setupTrades(rows, { ...LIVE_RULE, openMax: 0.99 });
  assert.deepEqual(openings(current[0]), single.map((trade) => trade.row.openingPrice).sort());
  assert.deepEqual(current[0].trades.map((trade) => trade.entry.entryPrice).sort(), single.map((trade) => trade.entry.entryPrice).sort());
});

test("gridCells: each opening band admits exactly the markets that opened inside it", () => {
  const cells = gridCells(gridRows(), LIVE_RULE);
  const buy = [0.45, 0.56];
  assert.deepEqual(openings(cellOf(cells, [0.6, 0.99], buy)), [0.66, 0.8, 0.95]);
  assert.deepEqual(openings(cellOf(cells, [0.65, 0.99], buy)), [0.66, 0.8, 0.95]);
  assert.deepEqual(openings(cellOf(cells, [0.7, 0.99], buy)), [0.8, 0.95], "a 66% opening is not a 70+ market");
  assert.deepEqual(openings(cellOf(cells, [0.85, 0.99], buy)), [0.95]);
  assert.deepEqual(openings(cellOf(cells, [0.65, 0.9], buy)), [0.66, 0.8], "a 95% opening is above a 90% ceiling");
});

test("gridCells: each buy band buys the first touch inside it, and the portfolio's excluded shapes stay out of every cell", () => {
  const cells = gridCells(gridRows(), LIVE_RULE);
  const favourite = (cell) => cell.trades.find((trade) => trade.row.openingPrice === 0.95);
  assert.equal(favourite(cellOf(cells, [0.7, 0.99], [0.55, 0.6])).entry.entryPrice, 0.58, "55-60 buys the 0.58 touch");
  assert.equal(favourite(cellOf(cells, [0.7, 0.99], [0.45, 0.56])).entry.entryPrice, 0.55, "45-56 waits for 0.55");
  assert.equal(favourite(cellOf(cells, [0.7, 0.99], [0.4, 0.5])), undefined, "it never reached 50");
  for (const cell of cells) {
    assert.ok(!cell.trades.some((trade) => trade.shape === "spread"), `no spread in ${cell.open}/${cell.buy}`);
  }
  const everyTrade = cells.flatMap((cell) => cell.trades);
  assert.ok(everyTrade.length > 0);
});

test("unsimulatedRows: markets that opened in the band but were never simulated there are counted, not read as no-dip", () => {
  const rows = [
    market({ opening: 0.62, simulated: false }),
    market({ opening: 0.68, simulated: false }),
    market({ opening: 0.8 }),
  ];
  assert.equal(unsimulatedRows(rows, [0.6, 0.99]), 2);
  assert.equal(unsimulatedRows(rows, [0.65, 0.99]), 1);
  assert.equal(unsimulatedRows(rows, [0.7, 0.99]), 0);
});

test("parseBands: percentages or fractions, junk and reversed bands dropped, nothing valid keeps the default", () => {
  assert.deepEqual(parseBands("60-99, 0.65-0.9, junk, 70-60", []), [[0.6, 0.99], [0.65, 0.9]]);
  assert.deepEqual(parseBands("", [[0.7, 0.99]]), [[0.7, 0.99]]);
  assert.deepEqual(parseBands("nope", [[0.7, 0.99]]), [[0.7, 0.99]]);
});

test("printGrid: the table marks the current cell, warns about unsimulated markets, and ranks by P/L", () => {
  const rows = [...gridRows(), market({ opening: 0.63, simulated: false })];
  const lines = [];
  const original = console.log;
  console.log = (...parts) => lines.push(parts.join(" "));
  let result;
  try {
    result = printGrid("tennis", rows, LIVE_RULE, { minTrades: 1 });
  } finally {
    console.log = original;
  }
  const text = lines.join("\n");
  // Five opened at 60%+, the excluded spread among them: the count is of markets, before any rule.
  assert.match(text, /opening 60-99%\s+5 market\(s\) opened in this band\s+!! 1 of them NOT simulated/);
  assert.doesNotMatch(text, /opening 70-99%[^\n]*NOT simulated/, "a 70+ band has nothing missing");
  assert.match(text, /45-56% \*/, "the current buy band is starred");
  assert.match(text, /<- current/, "and found again in the ranking");
  const pnls = result.ranked.map(({ clean }) => clean.pnlUsdc);
  assert.deepEqual(pnls, [...pnls].sort((left, right) => right - left), "ranked by P/L, best first");
});

// The whole tool as the workflow runs it, against a local stand-in for the host: the grid has
// to be switched on by DIP_SETUP_GRID and has to end the output with the summary.
async function runTool(env, cache) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://local");
    let body = null;
    if (url.searchParams.get("action") === "portfolio-config") {
      body = { config: { livePortfolios: { dip704060live: {
        displayName: "dip 70+ -> 45-56 live", dipEntryEnabled: true, dipEntryOpenMin: 0.7, dipEntryOpenMax: 0.999,
        dipEntryBuyMin: 0.45, dipEntryBuyMax: 0.56, excludedMarketShapes: ["other", "spread"], stakeUsdc: 5,
      } } } };
    } else if (url.pathname.endsWith("/data/dip-backtest-tennis-cache.json")) {
      body = cache;
    }
    response.statusCode = body ? 200 : 404;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const tool = fileURLToPath(new URL("../tools/dip-setup-backtest.mjs", import.meta.url));
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [tool], { env: {
        PATH: process.env.PATH, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1",
        TRADING_HOST: `http://127.0.0.1:${server.address().port}`, DIP_SETUP_TAGS: "tennis", ...env,
      } });
      let text = "";
      child.stdout.on("data", (chunk) => { text += chunk; });
      child.stderr.on("data", (chunk) => { text += chunk; });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(text) : reject(new Error(`exit ${code}: ${text}`))));
    });
  } finally {
    server.close();
  }
}

test("end to end: DIP_SETUP_GRID prints every opening band and closes with the current-vs-best summary", async () => {
  const markets = {};
  gridRows().forEach((row, index) => {
    markets[`tok${index}`] = { ...row, status: "complete", usableOpening: true, fingerprint: JSON.stringify([7, `tok${index}`]) };
  });
  const cache = { markets };
  const plain = await runTool({}, cache);
  assert.doesNotMatch(plain, /grid summary/, "without the switch, the output is the single-rule report only");
  const output = await runTool({ DIP_SETUP_GRID: "true", DIP_SETUP_GRID_MIN_TRADES: "1" }, cache);
  for (const band of ["60-99%", "65-99%", "70-99%", "75-99%", "80-99%", "85-99%", "65-90%", "70-90%"]) {
    assert.match(output, new RegExp(`opening ${band}`), `a table for ${band}`);
  }
  const summary = output.slice(output.lastIndexOf("=== grid summary"));
  assert.match(summary, /tennis\s+70-99% 45-56%\s+2\s/, "the current setting and its two trades");
  assert.match(summary, /\|\s+\d\d-\d\d% \d\d-\d\d%\s+\d+/, "beside the best cell");
});
