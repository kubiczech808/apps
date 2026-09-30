import assert from "node:assert/strict";
import test from "node:test";

import { backtestDipMarket, clobHistoryWindows, historyRequests } from "../tools/dip-history-backtest.mjs";
import { nextDipBacktestDispatch } from "../tools/queue-dip-backtest-batch.mjs";

const createdAt = "2026-09-01T10:00:00Z";
const eventStartAt = "2026-09-01T12:00:00Z";
const resolvedAt = "2026-09-01T14:00:00Z";
const epoch = (value) => Math.floor(Date.parse(value) / 1000);

function resolvedMarket(overrides = {}) {
  return {
    tokenId: "12345678901234567890",
    question: "Map 1 winner?",
    outcome: "Team A",
    marketCreatedAt: createdAt,
    eventStartTime: eventStartAt,
    resolvedAt,
    finalOutcomePrice: 1,
    feesEnabled: true,
    firstFeeRate: 0.05,
    ...overrides,
  };
}

test("DIP backtest accepts only a 70% opening captured near market creation", () => {
  const result = backtestDipMarket(resolvedMarket(), [
    { t: epoch("2026-09-01T10:20:00Z"), p: 0.75 },
    { t: epoch("2026-09-01T12:20:00Z"), p: 0.4 },
    { t: epoch("2026-09-01T13:40:00Z"), p: 0.9 },
  ]);
  assert.equal(result.verifiedOpening, true);
  assert.equal(result.openingInBand, true);
  assert.equal(result.maxInPlayDrawdownPct, 46.667);
  assert.equal(result.lowestInPlayPrice, 0.4);
  assert.equal(result.entries["0.4"].entryPrice, 0.4);
  assert.equal(result.entries["0.4"].outcome, "WIN");
  assert.equal(result.entries["0.4"].pnlUsdc, 7.35,
    "winning $5 stake uses the actual crossing price and the persisted taker fee");
});

test("DIP backtest does not mistake a later 70% quote for the original opening", () => {
  const result = backtestDipMarket(resolvedMarket(), [
    { t: epoch("2026-09-01T10:20:00Z"), p: 0.5 },
    { t: epoch("2026-09-01T11:20:00Z"), p: 0.8 },
    { t: epoch("2026-09-01T12:20:00Z"), p: 0.35 },
  ]);
  assert.equal(result.verifiedOpening, true);
  assert.equal(result.openingInBand, false);
  assert.equal(result.entries["0.4"], null,
    "a favourite that reached 70% only later is not a 70% opening candidate");
});

test("DIP backtest refuses a late first CLOB point even when it reads 70%", () => {
  const result = backtestDipMarket(resolvedMarket(), [
    { t: epoch("2026-09-01T11:45:00Z"), p: 0.8 },
    { t: epoch("2026-09-01T12:20:00Z"), p: 0.4 },
  ]);
  assert.equal(result.verifiedOpening, false);
  assert.equal(result.openingInBand, false);
});

test("DIP backtest uses the earliest pre-start CLOB quote when the archive lacks creation time", () => {
  const result = backtestDipMarket(resolvedMarket({ marketCreatedAt: "" }), [
    { t: epoch("2026-09-01T10:20:00Z"), p: 0.8 },
    { t: epoch("2026-09-01T12:20:00Z"), p: 0.4 },
  ]);
  assert.equal(result.verifiedOpening, false, "creation time was not available to verify");
  assert.equal(result.usableOpening, true, "the first available quote is still before kickoff");
  assert.equal(result.earliestPreStartOpening, true);
  assert.equal(result.openingInBand, true);
  assert.equal(result.openingSource, "earliest available CLOB quote in the 14-day pre-start window");
  assert.equal(result.entries["0.4"].outcome, "WIN");
});

test("DIP backtest does not count a pre-start fall as an executable in-play entry", () => {
  const result = backtestDipMarket(resolvedMarket(), [
    { t: epoch("2026-09-01T10:20:00Z"), p: 0.8 },
    { t: epoch("2026-09-01T11:30:00Z"), p: 0.4 },
    { t: epoch("2026-09-01T12:20:00Z"), p: 0.7 },
  ]);
  assert.equal(result.lowestInPlayPrice, 0.7);
  assert.equal(result.maxInPlayDrawdownPct, 12.5);
  assert.equal(result.entries["0.6"], null,
    "a price reached before kickoff cannot be reported as a DIP portfolio fill");
});

test("DIP backtest computes a full loss including the entry fee", () => {
  const result = backtestDipMarket(resolvedMarket({ finalOutcomePrice: 0 }), [
    { t: epoch("2026-09-01T10:15:00Z"), p: 0.8 },
    { t: epoch("2026-09-01T12:05:00Z"), p: 0.5 },
  ]);
  assert.equal(result.entries["0.5"].pnlUsdc, -5.125);
  assert.equal(result.entries["0.5"].outcome, "LOSS");
});

test("historical CLOB requests are split into API-accepted 14-day windows", () => {
  const start = epoch("2026-01-01T00:00:00Z");
  const end = epoch("2026-02-15T00:00:00Z");
  const windows = clobHistoryWindows(start, end);
  assert.equal(windows.length, 4);
  assert.equal(windows[0].start, start);
  assert.equal(windows.at(-1).end, end);
  assert.ok(windows.every((window) => window.end - window.start <= 14 * 86400));
  assert.deepEqual(windows.slice(1).map((window, index) => window.start), windows.slice(0, -1).map((window) => window.end),
    "adjacent requests meet exactly, with no omitted interval");
});

test("the next historical batch is queued only while the archive still has work", () => {
  assert.deepEqual(nextDipBacktestDispatch(
    { tag: "esports", coverage: { pendingMarkets: 14257 } },
    { ref: "main", tag: "esports", maxMarkets: 600 },
  ), {
    ref: "main",
    inputs: { tag: "esports", max_markets: "600" },
  });
  assert.equal(nextDipBacktestDispatch({ coverage: { pendingMarkets: 0 } }, { ref: "main" }), null);
});

// The in-play window at one point a minute. Everything before this read ONE point per hour
// (CLOB's fidelity is in minutes), which is biased rather than coarse: a losing favourite
// falls through the buy band between two hourly points and is first seen below the floor.
test("history requests: coarse for the opening, minute points for the in-play window", () => {
  const requests = historyRequests(resolvedMarket({ marketCreatedAt: null }));
  const inPlay = requests.filter((request) => request.fidelity === 1);
  assert.equal(inPlay.length, 1, "exactly one minute-level request");
  assert.equal(inPlay[0].start, epoch(eventStartAt), "starting at the kickoff");
  assert.equal(inPlay[0].end, epoch(resolvedAt), "and ending at resolution when that comes first");
  const coarse = requests.filter((request) => request.fidelity !== 1);
  assert.ok(coarse.length >= 1 && coarse.every((request) => request.fidelity === 60),
    "the 14-day pre-start window stays hourly -- only the opening quote is taken from it");
  assert.equal(coarse[0].start, epoch(eventStartAt) - 14 * 86400);
});

test("history requests: the minute window is capped, and absent without a kickoff", () => {
  const long = historyRequests(resolvedMarket({ resolvedAt: "2026-09-04T12:00:00Z" }));
  const inPlay = long.find((request) => request.fidelity === 1);
  assert.equal(inPlay.end - inPlay.start, 12 * 3600, "twelve hours, not the whole multi-day event");
  const noStart = historyRequests(resolvedMarket({ eventStartTime: null }));
  assert.ok(noStart.every((request) => request.fidelity !== 1), "no kickoff, no in-play window");
});

test("with the minute window, a collapse through the band inside one hour is counted", () => {
  // The Tabilo-Paul shape: 0.72 before the start, through 0.56-0.45 between 04:39 and 04:55,
  // 0.405 at the 05:00 hourly point, a loss.
  const start = epoch("2026-09-30T04:30:00Z");
  const row = resolvedMarket({
    marketCreatedAt: null, eventStartTime: "2026-09-30T04:30:00Z", resolvedAt: "2026-09-30T06:18:51Z",
    finalOutcomePrice: 0, firstFeeRate: 0,
  });
  const hourly = [
    { t: start - 40 * 3600, p: 0.72 },
    { t: start + 30 * 60, p: 0.405 },
    { t: start + 90 * 60, p: 0.15 },
  ];
  const minutes = [];
  for (let minute = 0; minute <= 60; minute += 1) {
    minutes.push({ t: start + minute * 60, p: Number((0.725 - minute * 0.01).toFixed(3)) });
  }
  const hourlyOnly = backtestDipMarket(row, hourly);
  assert.equal(hourlyOnly.entries["0.55"]?.entryPrice, 0.405,
    "hourly alone: the first touch at or below 0.55 is already below the 0.45 floor");
  const withMinutes = backtestDipMarket(row, [...hourly, ...minutes]);
  assert.equal(withMinutes.entries["0.55"].entryPrice, 0.545, "minute points catch it inside the band");
  assert.equal(withMinutes.entries["0.55"].outcome, "LOSS", "and the loss is counted");
  // Every row simulated on hourly in-play points must stop matching its fingerprint, or the
  // biased version-6 results stay in the cache for ever.
  assert.ok(JSON.parse(withMinutes.fingerprint)[0] >= 7, "the rule version moved past the hourly rows");
});
