// Runs offline: the setup backtest's own functions, executed against fabricated cache rows.
// No network, no secrets.

import assert from "node:assert/strict";
import test from "node:test";
import {
  dipRuleOf,
  findPortfolio,
  nearHalf,
  portfolioRows,
  probability,
  ruleVersion,
  setupEntry,
  setupStats,
  setupTrades,
  slugPrefix,
  wilson,
} from "../tools/dip-setup-backtest.mjs";

// A cached market as dip-history-backtest.mjs writes it: first in-play touch at or below each
// level, each with its own price, time, fee and P/L at a $5 stake.
function market({ question = "Sinner vs Alcaraz", slug = "atp-sinner-alcaraz-2026-09-20", outcome = "Sinner",
  opening = 0.8, touches = {}, won = true } = {}) {
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
  return { question, slug, outcome, openingPrice: opening, resolvedAt: "2026-09-20T20:00:00Z", entries };
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
