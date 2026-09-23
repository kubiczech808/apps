import assert from "node:assert/strict";
import test from "node:test";

import { backtestDipMarket, clobHistoryWindows } from "../tools/dip-history-backtest.mjs";

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
  assert.equal(result.maxDrawdownPct, 46.667);
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
  assert.equal(result.openingSource, "earliest available CLOB quote before event start");
  assert.equal(result.entries["0.4"].outcome, "WIN");
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
