import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { backtestDipMarket, clobHistoryWindows, historyRequests, needsSimulation, reportFromCache } from "../tools/dip-history-backtest.mjs";
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

// ---------------------------------------------------------------------------------------
// The opening band is simulated from 60%, so a grid can ask about 65-99 and 60-99, while the
// published report keeps describing the 70+ rule the dashboard labels it as.

const opensAt = (price, { final = 1, token = "12345678901234567890" } = {}) => {
  const row = resolvedMarket({ tokenId: token, finalOutcomePrice: final });
  return [row, backtestDipMarket(row, [
    { t: epoch("2026-09-01T10:20:00Z"), p: price },
    { t: epoch("2026-09-01T12:20:00Z"), p: 0.52 },
    { t: epoch("2026-09-01T13:40:00Z"), p: 0.9 },
  ])];
};

test("DIP backtest simulates a 65% opening, and still refuses one below 60%", () => {
  const [, sixtyFive] = opensAt(0.65);
  assert.equal(sixtyFive.openingInBand, true);
  assert.equal(sixtyFive.entries["0.55"].entryPrice, 0.52, "a 65-99 band can now be read out of the cache");
  const [, fiftyFive] = opensAt(0.55);
  assert.equal(fiftyFive.openingInBand, false);
  assert.equal(fiftyFive.entries["0.55"], null);
});

test("needsSimulation: only rows the narrower band refused are re-run when it widens", () => {
  const [row, now] = opensAt(0.65);
  // The same market as the 70% floor stored it: complete, usable opening, no entries.
  const underOldFloor = { ...now, openingInBand: false, entries: Object.fromEntries(Object.keys(now.entries).map((level) => [level, null])) };
  assert.equal(needsSimulation(row, underOldFloor), true, "a 65% opening simulated under 70+ is stale");
  assert.equal(needsSimulation(row, now), false, "once simulated under 60+ it is done");
  const [lowRow, low] = opensAt(0.55);
  assert.equal(needsSimulation(lowRow, low), false, "below the band there is nothing to re-run");
  const [highRow, high] = opensAt(0.8);
  assert.equal(needsSimulation(highRow, high), false, "a 70+ row's entries cannot change, so it is not re-fetched");
  assert.equal(needsSimulation(row, undefined), true, "a new market");
  assert.equal(needsSimulation(row, { ...now, status: "error" }), true, "a failed attempt");
  assert.equal(needsSimulation({ ...row, resolvedAt: "2026-09-02T14:00:00Z" }, now), true, "a changed source row");
});

test("the published report still describes the 70+ opening rule", () => {
  const [rowLow, low] = opensAt(0.65, { token: "11111111111111111111" });
  const [rowHigh, high] = opensAt(0.8, { token: "22222222222222222222" });
  const cache = { markets: { [low.tokenId]: low, [high.tokenId]: high } };
  const report = reportFromCache([rowLow, rowHigh], cache, 2);
  assert.equal(report.coverage.openingBandMarkets, 1, "the 65% opening is simulated, not reported");
  assert.equal(report.entries.find((entry) => entry.entryProbability === 55).trades, 1);
  assert.equal(report.openingRule.probabilityMin, 70);
  assert.equal(report.openingRule.simulatedProbabilityMin, 60);
  assert.equal(report.coverage.pendingMarkets, 0);
});

// The whole batch, as the workflow runs it, against a local stand-in for the application's
// source feed and for CLOB. A cache stored under the 70% floor holds a 65% opening with no
// entries and an 80% opening that is finished. The run must re-fetch the first and only it.
test("end to end: a batch re-simulates the rows the 70% floor refused, and leaves finished rows alone", async () => {
  const [staleRow, fresh] = opensAt(0.65, { token: "11111111111111111111" });
  const [doneRow, done] = opensAt(0.8, { token: "22222222222222222222" });
  const stale = { ...fresh, openingInBand: false, entries: Object.fromEntries(Object.keys(fresh.entries).map((level) => [level, null])) };
  const directory = mkdtempSync(join(tmpdir(), "dip-backtest-"));
  const cachePath = join(directory, "cache.json");
  const reportPath = join(directory, "report.json");
  writeFileSync(cachePath, JSON.stringify({ version: 7, tag: "tennis", markets: { [stale.tokenId]: stale, [done.tokenId]: done } }));
  const requested = new Set();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://local");
    let body = {};
    if (url.searchParams.get("action") === "dip-backtest-source") {
      body = { ok: true, markets: [staleRow, doneRow] };
    } else if (url.pathname.endsWith("/prices-history")) {
      requested.add(url.searchParams.get("market"));
      body = { history: [
        { t: epoch("2026-09-01T10:20:00Z"), p: 0.65 },
        { t: epoch("2026-09-01T12:20:00Z"), p: 0.52 },
        { t: epoch("2026-09-01T13:40:00Z"), p: 0.9 },
      ] };
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const host = `http://127.0.0.1:${server.address().port}`;
    const tool = fileURLToPath(new URL("../tools/dip-history-backtest.mjs", import.meta.url));
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [tool], { env: {
        PATH: process.env.PATH, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1",
        DIP_BACKTEST_APP_HOST: host, POLYMARKET_CLOB_API: host, DIP_BACKTEST_TAG: "tennis",
        DIP_BACKTEST_CACHE_PATH: cachePath, DIP_BACKTEST_REPORT_PATH: reportPath,
      } });
      let text = "";
      child.stdout.on("data", (chunk) => { text += chunk; });
      child.stderr.on("data", (chunk) => { text += chunk; });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(text) : reject(new Error(`exit ${code}: ${text}`))));
    });
    assert.match(output, /Processed 1\/1/, "one market in the batch");
    assert.deepEqual([...requested], [stale.tokenId], "only the refused 65% opening is fetched again");
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(cache.markets[stale.tokenId].openingInBand, true);
    assert.equal(cache.markets[stale.tokenId].entries["0.55"].entryPrice, 0.52);
    assert.deepEqual(cache.markets[done.tokenId], done, "the finished row is untouched");
    assert.match(output, /2\/2 cached, 0 pending/);
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
