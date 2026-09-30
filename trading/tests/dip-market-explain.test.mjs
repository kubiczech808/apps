// Runs offline: the explain tool's own functions and the REAL dip backtest function, fed
// fabricated price paths. No network, no secrets.

import assert from "node:assert/strict";
import test from "node:test";
import { backtestDipMarket } from "../tools/dip-history-backtest.mjs";
import { bandVisits, eventStartOf, minuteRuleEntry, parseList } from "../tools/dip-market-explain.mjs";
import { setupEntry } from "../tools/dip-setup-backtest.mjs";

const START = Date.parse("2026-09-29T10:00:00Z") / 1000;
const BAND = { buyMin: 0.45, buyMax: 0.56 };

// A price path as [minutes after start, price]; before the start it sits at the opening.
function minutePath(steps, opening = 0.75) {
  const points = [];
  for (let minute = -14 * 24 * 60; minute < 0; minute += 60) points.push({ t: START + minute * 60, p: opening });
  for (const [minute, p] of steps) points.push({ t: START + minute * 60, p });
  return points.sort((left, right) => left.t - right.t);
}

// What CLOB hands back at fidelity=60: one point per hour, on the hour.
function hourly(points) {
  return points.filter((point) => (point.t - START) % 3600 === 0);
}

function row(finalOutcomePrice) {
  return {
    tokenId: "123456789012", question: "Tabilo vs Paul", outcome: "Paul", slug: "atp-tabilo-paul-2026-09-29",
    eventStartTime: new Date(START * 1000).toISOString(), marketCreatedAt: null,
    resolvedAt: new Date((START + 4 * 3600) * 1000).toISOString(), finalOutcomePrice,
  };
}

// Every minute from 0 to 240, interpolated between the given anchors.
function interpolate(anchors) {
  const steps = [];
  for (let index = 0; index < anchors.length - 1; index += 1) {
    const [m0, p0] = anchors[index];
    const [m1, p1] = anchors[index + 1];
    for (let minute = m0; minute < m1; minute += 1) steps.push([minute, p0 + ((p1 - p0) * (minute - m0)) / (m1 - m0)]);
  }
  const [lastMinute, lastPrice] = anchors[anchors.length - 1];
  steps.push([lastMinute, lastPrice]);
  return steps;
}

test("the bias: a losing favourite falls through the band between hourly points, and only the hourly view misses it", () => {
  // 0.75 at the start, still 0.70 at 60', then a collapse inside the second hour: through the
  // 45-56 band between 70' and 90', and already 0.30 at the 120' hourly point.
  const path = minutePath(interpolate([[0, 0.75], [60, 0.70], [70, 0.60], [90, 0.40], [120, 0.30], [240, 0.02]]));
  const replay = backtestDipMarket(row(0), hourly(path));
  assert.equal(replay.status, "complete");
  assert.equal(replay.openingInBand, true);
  assert.equal(setupEntry(replay, [BAND.buyMin, BAND.buyMax]), null,
    "hourly: the first in-play point below the band ceiling is 0.30, below the floor -- no trade, no loss counted");

  const entry = minuteRuleEntry(path, { startSec: START, ...BAND });
  assert.ok(entry, "minute: the live rule sees the price cross the band and buys");
  assert.ok(entry.p <= 0.56 && entry.p >= 0.55, `on the way down, at the top of the band: ${entry.p}`);
});

test("the other half of the bias: a recovering favourite sits in the band long enough for an hour to land on it", () => {
  const path = minutePath(interpolate([[0, 0.75], [40, 0.52], [80, 0.50], [130, 0.62], [240, 0.98]]));
  const replay = backtestDipMarket(row(1), hourly(path));
  const hourlyEntry = setupEntry(replay, [BAND.buyMin, BAND.buyMax]);
  assert.ok(hourlyEntry, "hourly: the 60' point lands inside the band");
  assert.equal(hourlyEntry.outcome, "WIN");
  assert.ok(minuteRuleEntry(path, { startSec: START, ...BAND }), "and the minute rule buys it too");
});

test("bandVisits: how long the price sat inside the band, and its lowest in-play point", () => {
  const path = minutePath(interpolate([[0, 0.75], [60, 0.70], [70, 0.60], [90, 0.40], [120, 0.30]]));
  const visits = bandVisits(path, { startSec: START, ...BAND });
  assert.ok(visits.insideCount >= 10 && visits.insideCount <= 12, `about eleven minutes inside: ${visits.insideCount}`);
  assert.equal(Math.round(visits.lowest.p * 100), 30);
  assert.ok(visits.firstInside.t > START + 70 * 60);
});

test("minuteRuleEntry: pre-start prices and settled prices never count as a dip", () => {
  const points = [
    { t: START - 600, p: 0.5 },
    { t: START + 60, p: 0.8 },
    { t: START + 120, p: 0.999 },
  ];
  assert.equal(minuteRuleEntry(points, { startSec: START, ...BAND }), null);
});

test("eventStartOf: the kickoff and the field it came from", () => {
  assert.deepEqual(eventStartOf({ gameStartTime: "2026-09-29T10:00:00Z" }, {}), { at: START, field: "market.gameStartTime" });
  assert.deepEqual(eventStartOf({}, { startTime: "2026-09-29T10:00:00Z" }), { at: START, field: "event.startTime" });
  assert.deepEqual(eventStartOf({}, {}), { at: null, field: null });
  // The market's own kickoff outranks the event's: an event's startTime can be the start of
  // a whole day's schedule, and taking it would move every match's in-play window.
  assert.deepEqual(
    eventStartOf({ gameStartTime: "2026-09-29T10:00:00Z" }, { startTime: "2026-09-29T02:00:00Z" }),
    { at: START, field: "market.gameStartTime" },
  );
});

test("parseList: Gamma's JSON-string arrays and plain arrays alike", () => {
  assert.deepEqual(parseList('["Yes","No"]'), ["Yes", "No"]);
  assert.deepEqual(parseList(["a"]), ["a"]);
  assert.deepEqual(parseList("not json"), []);
});
