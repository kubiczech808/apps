// Runs offline: the browser's own chart builder is lifted out of app.js and EXECUTED, and
// api.php's published field list is read. No network, no secrets.
//
// Reported after every paper portfolio was rebased to 100 USDC: "i graf by se mel u tech
// paper portfolii vynulovat."
//
// The tiles above the chart already switch to their *SinceAdjustment* figures the moment
// capitalAdjustmentAt is set -- that was fixed when the overview ROI was. The curve did not,
// so a line climbing out of an old balance sat directly beneath a headline that had been
// restarted an hour earlier, and the two disagreed by the whole of the account's history.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} must be findable in app.js`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} must be a complete function`);
  return source.slice(start, end + 2);
}

// The real builder, with the handful of helpers it leans on supplied so the lifted copy
// behaves as it does in the page.
const buildHistory = new Function(`
  ${extractFunction(APP, "equityHistoryFromDailySamples")}
  ${extractFunction(APP, "portfolioEquityHistory")}
  const numericOrNull = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  const chartTimestamp = (value) => {
    if (value == null || value === "") return null;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const isClosedTrade = (trade) => ["WON", "LOST", "CLOSED", "STOP_LOSS"].includes(String(trade.status || ""));
  const tradeClosedAt = (trade) => trade.resolvedAt || trade.closedAt || trade.date;
  const equityChartScale = () => "day";
  const equityChartBucket = (timestamp) => {
    const date = new Date(timestamp);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12);
  };
  return portfolioEquityHistory;
`)();

const RESET_AT = "2026-09-17T17:33:00.000Z";

const trade = (id, resolvedAt, pnl) => ({
  id, status: pnl >= 0 ? "WON" : "LOST", openedAt: resolvedAt, resolvedAt, realizedPnlUsdc: pnl,
});

// A long profitable history, then a reset, then two days of the restarted portfolio.
const TRADES = [
  ...Array.from({ length: 6 }, (_, index) =>
    trade(`old${index}`, `2026-09-0${index + 1}T18:00:00.000Z`, 12)),
  trade("new1", "2026-09-18T12:00:00.000Z", 4),
  trade("new2", "2026-09-19T12:00:00.000Z", -6),
];

test("a reset portfolio's chart starts at the reset, at the balance it was given", () => {
  const history = buildHistory(TRADES, 98, 0, "2026-09-19T20:00:00.000Z", null, null, null, RESET_AT, 100);
  assert.ok(history, "the chart must be drawn");

  assert.equal(history.openingEquity, 100, "it opens at the 100 USDC it was rebased to");
  assert.equal(history.points[0].value, 100);
  assert.equal(history.points[0].timestamp, Date.parse(RESET_AT),
    "and at the moment of the reset, not a day before the first old settlement");

  // Nothing from before the reset may appear. +72 of old profit across six trades would
  // show up as an opening far above 100 and a curve four times as long.
  const values = history.points.map((point) => point.value);
  assert.ok(Math.max(...values) <= 104.001, `no point may carry the old history: ${values.join(", ")}`);
  assert.ok(Math.min(...values) >= 97.999);
  assert.equal(history.points.at(-1).value, 98, "and it ends on the balance the tile shows");
});

test("without a reset the chart is exactly what it was", () => {
  // Every portfolio that was never rebased has to read as before, or this would silently
  // redraw all of them.
  const history = buildHistory(TRADES, 170, 0, "2026-09-19T20:00:00.000Z", null, null, null, null, null);
  assert.ok(history);
  // One day before the first settlement, clamped to the first trade -- and here the clamp
  // is what binds, because the first trade and the first settlement are the same moment.
  assert.equal(history.points[0].timestamp, Date.parse("2026-09-01T18:00:00.000Z"),
    "it still opens where it always did");
  assert.equal(history.openingEquity, 170 - 70, "and still back-calculates its baseline");
  assert.equal(history.points.at(-1).value, 170);
});

test("a reset portfolio is charted from its recorded balance, however little of it is visible", () => {
  // Written this way because two baits did NOT fail on the first version, and both were the
  // fixture's fault rather than the code's: it held the portfolio's whole history and every
  // settlement since the reset, so the age gate passed anyway and the back-calculation
  // happened to land on 100 as well. Neither path was actually being tested.
  //
  // The real shape is this one. The published trade list is capped, so a restarted
  // portfolio's list holds only some of what has settled since -- and then both things break
  // at once: the age gate measures the restart and blanks the chart for three days, and the
  // opening point is inferred from a ledger that cannot explain the balance.
  const visible = [trade("new1", "2026-09-18T19:00:00.000Z", 3)];
  const history = buildHistory(visible, 108, 0, "2026-09-18T20:00:00.000Z", null, null, null, RESET_AT, 100);
  assert.ok(history, "a portfolio reset yesterday must still be charted");
  assert.equal(history.openingEquity, 100,
    "the balance the reset recorded, not 108 minus the one settlement the list can see");
  assert.equal(history.points[0].value, 100);
  assert.equal(history.points.at(-1).value, 108);
  // Two points is what the renderer needs; the curve appears as soon as the restarted
  // portfolio has a second day, rather than three days after the reset.
  assert.ok(history.points.length >= 2);

  // But a genuinely new portfolio, with no reset, is still withheld until it has three days.
  const brandNew = [trade("only", "2026-09-17T19:00:00.000Z", 3)];
  assert.equal(buildHistory(brandNew, 103, 0, "2026-09-17T20:00:00.000Z", null, null, null, null, null), null);
});

test("a recorded daily series is bounded by the reset too", () => {
  // The measured path is preferred over the reconstruction whenever it exists, so bounding
  // only the reconstruction would leave exactly the portfolios that have one unfixed.
  const daily = [
    { day: "2026-09-10", samples: 4, realizedSum: 600, realizedMin: 148, realizedMax: 152 },
    { day: "2026-09-12", samples: 4, realizedSum: 640, realizedMin: 158, realizedMax: 162 },
    { day: "2026-09-18", samples: 4, realizedSum: 408, realizedMin: 101, realizedMax: 103 },
    { day: "2026-09-19", samples: 4, realizedSum: 392, realizedMin: 97, realizedMax: 99 },
  ];
  const history = buildHistory(TRADES, 98, 0, "2026-09-19T20:00:00.000Z", null, null, daily, RESET_AT, 100);
  assert.equal(history.source, "account-daily");
  assert.equal(history.points.length, 2, "only the days since the reset");
  assert.deepEqual(history.points.map((point) => point.value), [102, 98]);

  // And unbounded it is the whole series, so the filter is what did the work.
  const whole = buildHistory(TRADES, 98, 0, "2026-09-19T20:00:00.000Z", null, null, daily, null, null);
  assert.equal(whole.points.length, 4);
});

test("the boundary and the balance both reach the browser", () => {
  // The chart cannot bound anything the API does not publish. capitalAdjustmentAt was
  // already sent; the balance it was rebased to was not, and without it the opening point
  // falls back to a back-calculation that drifts as soon as anything settles.
  assert.match(API, /'capitalAdjustmentAt',/);
  assert.match(API, /'capitalAdjustmentEquityUsdc',/);
  assert.match(APP, /since: capitalAdjustmentAt,/);
  assert.match(APP, /sinceEquity: portfolio\.capitalAdjustmentEquityUsdc \?\? portfolioState\.capitalAdjustmentEquityUsdc \?\? null,/);
});

// The same boundary, applied to the LIST rather than to the statistic.
//
// Reported: "stale vidim stare closed trades naparovane na paper portfolia, kde jsme si
// rekli, ze udelame restart na startovnich 100 USD. data zachovej pro souhrne statistiky,
// ale oddel je od portfolii."
//
// The accuracy stat had already stopped counting them and the overview ROI had already
// stopped summing them. The list still showed them, so a portfolio restarted an hour ago
// read as a hundred trades deep -- the last screen still describing the old account.
test("closed trades from before the reset leave the portfolio's list", () => {
  const source = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  const start = source.indexOf("  const closedSinceReset = capitalAdjustmentAt");
  assert.ok(start > 0, "the bounded set must exist");

  // Bounded on resolvedAt OR closedAt: a position sold by the certainty close or a stop has
  // a closedAt and no resolvedAt, and dropping those would hide this pass's own trades.
  const block = source.slice(start, start + 600);
  assert.match(block, /Date\.parse\(trade\.resolvedAt \|\| trade\.closedAt \|\| ""\)/);
  assert.match(block, /resolvedTime >= Date\.parse\(capitalAdjustmentAt\)/);

  // The list and the summary both read the bounded set -- one without the other is a count
  // that disagrees with the rows underneath it.
  assert.match(source, /renderTradeRows\(closedSinceReset, "Zatim zadne ukoncene paper obchody\."/);
  assert.match(source, /const closedPnl = closedSinceReset\.reduce\(/);

  // And the earlier trades are NAMED rather than silently missing. They are still in the
  // state, which is the condition the reset was asked for on.
  assert.match(source, /before the reset, kept for statistics/);
  assert.match(source, /const closedBeforeReset = closedTrades\.length - closedSinceReset\.length;/);

  // A portfolio that was never reset still lists everything: capitalAdjustmentAt absent
  // means the unbounded set, not an empty one.
  assert.match(source, /const closedSinceReset = capitalAdjustmentAt\n\s+\? closedTrades\.filter/);
  assert.match(source, /\n\s+: closedTrades;\n\s+const closedBeforeReset/);
});
