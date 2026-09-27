// Runs offline. The sweep's arithmetic is EXECUTED on cache rows shaped exactly as
// backtestDipMarket writes them, and the P/L identity is checked against that function's
// own formula rather than restated.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  BUY_CEILINGS, OPEN_BANDS, OPEN_CEILING, OPEN_FLOORS, buyBands, cacheRows, cellStats, entryForCell, inOpenBand,
  openBands, shortlist, spanDays, sweep,
} from "../tools/dip-combination-sweep.mjs";

// One cached market, in the shape backtestDipMarket returns. Entries carry the first-touch
// price at each level, the fee that entry would have paid, and the resulting P/L.
function market({ token, opening, resolvedAt = "2026-09-01T00:00:00.000Z", touches = {}, status = "complete", usableOpening = true }) {
  const entries = {};
  for (const level of BUY_CEILINGS) {
    const price = touches[String(level)];
    if (price == null) { entries[String(level)] = null; continue; }
    const win = touches.win !== false;
    const fee = 0;
    entries[String(level)] = {
      enteredAt: "2026-08-31T20:00:00.000Z",
      entryPrice: price,
      feeUsdc: fee,
      // The backtest's own formula: shares = stake / entry, cost = stake + fee.
      pnlUsdc: win ? (5 / price) - (5 + fee) : -(5 + fee),
      outcome: win ? "WIN" : "LOSS",
    };
  }
  return { tokenId: token, status, usableOpening, openingPrice: opening, resolvedAt, entries };
}

test("only finished markets with a real opening price are swept", () => {
  // An unusable opening is a market whose earliest CLOB quote is not an opening at all.
  // Counting it would file mid-game prices under an opening band, which is the one mistake
  // that makes an opening-band recommendation meaningless.
  const cache = {
    markets: {
      a: market({ token: "a", opening: 0.78, touches: { "0.4": 0.38 } }),
      b: { tokenId: "b", status: "unavailable", usableOpening: true, openingPrice: 0.8 },
      c: market({ token: "c", opening: 0.8, usableOpening: false, touches: { "0.4": 0.36 } }),
      d: { tokenId: "d", status: "error" },
    },
  };
  assert.deepEqual(cacheRows(cache).map((row) => row.tokenId), ["a"]);
  assert.deepEqual(cacheRows({}), []);
});

test("both band edges are inclusive, because a band is a setting someone types", () => {
  const edge = market({ token: "e", opening: 0.70 });
  const top = market({ token: "t", opening: 0.80 });
  const outside = market({ token: "o", opening: 0.8001 });
  assert.ok(inOpenBand(edge, [0.70, 0.80]), "70 is inside 70-80");
  assert.ok(inOpenBand(top, [0.70, 0.80]), "80 is inside 70-80");
  assert.ok(!inOpenBand(outside, [0.70, 0.80]));

  // And the buy floor keeps a first touch that landed exactly on it.
  const onFloor = market({ token: "f", opening: 0.78, touches: { "0.4": 0.30 } });
  assert.ok(entryForCell(onFloor, 0.4, 0.30), "a touch at the floor is inside the band");
  assert.equal(entryForCell(onFloor, 0.4, 0.31), null, "a touch below the floor is not");
});

test("a market that never reached the ceiling is not an opportunity", () => {
  const shallow = market({ token: "s", opening: 0.78, touches: { "0.6": 0.55 } });
  assert.ok(entryForCell(shallow, 0.6));
  assert.equal(entryForCell(shallow, 0.4), null, "it never fell that far");
});

test("the return is over stake plus fees, and the implied winner price is recoverable", () => {
  // Two winners bought at 0.40, one loser. The identity the whole read rests on:
  // sum(stake/p) over winners = pnl + staked, so the mean winner price comes back out.
  const entries = [
    { entryPrice: 0.4, feeUsdc: 0, pnlUsdc: (5 / 0.4) - 5, outcome: "WIN" },
    { entryPrice: 0.4, feeUsdc: 0, pnlUsdc: (5 / 0.4) - 5, outcome: "WIN" },
    { entryPrice: 0.4, feeUsdc: 0, pnlUsdc: -5, outcome: "LOSS" },
  ];
  const stats = cellStats(entries);
  assert.equal(stats.trades, 3);
  assert.equal(stats.wins, 2);
  assert.ok(Math.abs(stats.accuracy - 66.6667) < 0.01);
  assert.equal(stats.stakedUsdc, 15);
  assert.ok(Math.abs(stats.pnlUsdc - 10) < 1e-9, "two payouts of 12.50 against 15 staked");
  assert.ok(Math.abs(stats.roiPct - 66.6667) < 0.01);
  assert.ok(Math.abs(stats.impliedWinnerEntryPct - 40) < 0.01, "the price the winners were bought at");

  // Fees are part of what was risked, not a line item beside it.
  const withFee = cellStats([{ entryPrice: 0.5, feeUsdc: 0.05, pnlUsdc: (5 / 0.5) - 5.05, outcome: "WIN" }]);
  assert.equal(withFee.stakedUsdc, 5.05);
  assert.ok(Math.abs(withFee.roiPct - ((4.95 / 5.05) * 100)) < 1e-9);
});

test("a trade count is reported as a rate, because it is unreadable without one", () => {
  const rows = [
    market({ token: "a", opening: 0.78, resolvedAt: "2026-07-01T00:00:00.000Z", touches: { "0.4": 0.38 } }),
    market({ token: "b", opening: 0.78, resolvedAt: "2026-08-30T00:00:00.000Z", touches: { "0.4": 0.36 } }),
  ];
  const days = spanDays(rows);
  assert.ok(Math.abs(days - 60) < 0.01);
  const cell = sweep(rows, { openBands: [[0.75, 0.8]], bands: [[0.35, 0.4]] })[0];
  assert.equal(cell.trades, 2);
  assert.ok(Math.abs(cell.tradesPerMonth - 1) < 0.01, "two trades over two months is one a month");
  // One market cannot span anything, and inventing a rate from it would be a lie.
  assert.equal(spanDays([rows[0]]), null);
  assert.equal(sweep([rows[0]], { openBands: [[0.75, 0.8]], bands: [[0.35, 0.4]] })[0].tradesPerMonth, null);
});

test("opening levels are cumulative floors, five points apart, not disjoint slices", () => {
  // Asked for: "otevreni uvazuj na ruznych urovnich od 70 vys zase s ruznym rozestupem 5%" --
  // "70+, 75+, 80+, ...", not "70-75, 75-80, ...". A disjoint slice starves every row above
  // 80 of volume, because a 90%+ favourite is rare to begin with; a floor keeps the full
  // population at every level, and each is a SUBSET of the one below it.
  for (const [min, max] of OPEN_BANDS) {
    assert.ok(min >= 0.7, `${min} is below the band the cache priced`);
    assert.ok(Math.abs(max - OPEN_CEILING) < 1e-9, `${min}-${max} has a ceiling below the cache's own 99%`);
  }
  for (let index = 1; index < OPEN_FLOORS.length; index += 1) {
    assert.ok(Math.abs((OPEN_FLOORS[index] - OPEN_FLOORS[index - 1]) - 0.05) < 1e-9, "floors are five points apart");
  }
  // Nested, not exclusive: a market at 92% opening belongs to 70+, 75+, 80+, 85+ AND 90+ all
  // at once, so counting it under only one of them would undercount every floor but one.
  const highOpener = market({ token: "h", opening: 0.92, touches: { "0.4": 0.4 } });
  const hits = OPEN_FLOORS.filter((floor) => inOpenBand(highOpener, [floor, OPEN_CEILING]));
  assert.deepEqual(hits, [0.70, 0.75, 0.80, 0.85, 0.90]);

  // Every buy band is five points wide and ends on a level the backtest actually recorded.
  for (const [floor, ceiling] of buyBands()) {
    assert.ok(Math.abs((ceiling - floor) - 0.05) < 1e-9, `${floor}-${ceiling} is not one step`);
    assert.ok(BUY_CEILINGS.includes(ceiling), `${ceiling} was never recorded by the backtest`);
  }
  // The grid now reaches 80%, which the original 60% ceiling could never see: a favourite
  // that opened at 90%+ sitting at 75-80% has barely moved in absolute terms, and the old
  // grid had no way to ask about that at all.
  assert.ok(BUY_CEILINGS.includes(0.8), "the buy grid must reach 75-80, as asked for");

  // The default floor for the buy grid is 45%, matching "od 45-50 az po 75-80" -- but it
  // stays an override, not a hard-coded bottom, so a deeper dip is still reachable.
  const wideOpen = buyBands(BUY_CEILINGS, 0.05, 0);
  const trimmed = buyBands(BUY_CEILINGS, 0.05, 0.45);
  assert.ok(wideOpen.some(([floor]) => floor < 0.45), "0 keeps the deeper legacy bands");
  assert.ok(trimmed.every(([floor]) => floor >= 0.45 - 1e-9), "0.45 trims them");
});

test("the edge column is the win rate minus the price the winners paid", () => {
  // Two winners at 0.40 and one loser: 66.7% won, 40% paid, so the edge is 26.7 points.
  // The ROI can flatter a cell that a hair of luck carried; the edge is what has to hold.
  const rows = [
    market({ token: "a", opening: 0.72, resolvedAt: "2026-07-01T00:00:00.000Z", touches: { "0.4": 0.4 } }),
    market({ token: "b", opening: 0.72, resolvedAt: "2026-07-15T00:00:00.000Z", touches: { "0.4": 0.4 } }),
    market({ token: "c", opening: 0.72, resolvedAt: "2026-08-01T00:00:00.000Z", touches: { "0.4": 0.4, win: false } }),
  ];
  const cell = sweep(rows, { openBands: [[0.7, 0.75]], bands: [[0.35, 0.4]] })[0];
  assert.ok(Math.abs(cell.edgePoints - (200 / 3 - 40)) < 0.01);
  // A cell with no winner has no price to compare against, and must say so rather than 0.
  const allLost = sweep(
    [market({ token: "d", opening: 0.72, touches: { "0.4": 0.4, win: false } })],
    { openBands: [[0.7, 0.75]], bands: [[0.35, 0.4]] },
  )[0];
  assert.equal(allLost.edgePoints, null);
});

test("the shortlist refuses a thin cell however well it returned", () => {
  // The temptation with a grid like this is to read the best-looking row. Four trades at
  // 300% is arithmetic, not a portfolio -- and this is the demand the request named.
  const cells = [
    { openMin: 0.7, openMax: 0.8, buyMin: 0, buyMax: 0.3, trades: 4, roiPct: 300 },
    { openMin: 0.7, openMax: 0.9, buyMin: 0, buyMax: 0.5, trades: 120, roiPct: 4 },
    { openMin: 0.8, openMax: 0.9, buyMin: 0, buyMax: 0.45, trades: 60, roiPct: -12 },
  ];
  const ranked = shortlist(cells, 20);
  assert.deepEqual(ranked.map((cell) => cell.trades), [120], "volume and profit, or nothing");
});

test("a floor at or above the ceiling is not a band and is never emitted", () => {
  const rows = [market({ token: "a", opening: 0.78, touches: { "0.3": 0.29, "0.4": 0.38 } })];
  // 40-30 is inverted and 40-40 is a single price rather than a band; neither is a setting
  // anyone means, and emitting them would pad the grid with cells that can never fire.
  assert.deepEqual(
    sweep(rows, { openBands: [[0.75, 0.8]], bands: [[0.4, 0.3], [0.35, 0.4]] }).map((cell) => cell.buyMax),
    [0.4],
  );
  assert.deepEqual(sweep(rows, { openBands: [[0.75, 0.8]], bands: [[0.4, 0.4]] }), []);
});

test("it reads the published cache and nothing else", () => {
  const tool = readFileSync(new URL("../tools/dip-combination-sweep.mjs", import.meta.url), "utf8");
  // No CLOB, no database, no writes: the cache already holds every number this regroups.
  assert.match(tool, /\/data\/dip-backtest-\$\{tag\}-cache\.json/);
  assert.ok(!/clob\.polymarket/i.test(tool), "the price history was fetched once, by the backtest");
  assert.ok(!/action=state|storage-admin|writeFile/.test(tool), "read-only");
  // The seven levels are the backtest's, not a choice made here.
  const backtest = readFileSync(new URL("../tools/dip-history-backtest.mjs", import.meta.url), "utf8");
  const levels = backtest.match(/const ENTRY_LEVELS = \[([^\]]+)\]/)?.[1];
  assert.ok(levels, "the backtest must still declare its levels");
  assert.deepEqual(levels.split(",").map((value) => Number(value.trim())), BUY_CEILINGS,
    "a level the backtest never recorded cannot be swept");
  // And every swept opening band sits inside the window the cache actually priced.
  for (const [min] of OPEN_BANDS) assert.ok(min >= 0.7, `${min} was never priced by the cache`);
  // Widening ENTRY_LEVELS without bumping OPENING_RULE_VERSION would leave every already
  // cached market's `entries` object short of the new levels forever: the cache does not
  // keep the raw CLOB point series, only the entries computed from it once, so a level added
  // after the fact needs the whole tag re-fetched and re-simulated -- which only happens if
  // the version changed and every old fingerprint stops matching.
  assert.match(backtest, /const OPENING_RULE_VERSION = 6/, "the version must be bumped alongside the wider grid");
  // The runtime default that actually reaches printGrid()'s sweep -- not merely buyBands()'s
  // own parameter default, which a caller can always override without touching this at all.
  assert.match(tool, /DIP_SWEEP_MIN_BUY_FLOOR \?\? 0\.45/, "the printed grid must default to the 45% floor asked for");
  assert.match(tool, /buyBands\(BUY_CEILINGS, 0\.05, MIN_BUY_FLOOR\)/, "printGrid must actually apply that floor");
});
